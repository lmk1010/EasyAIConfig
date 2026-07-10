use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use toml::Value as TomlValue;

use crate::provider::get_string;
use crate::{app_home, default_codex_home, ensure_dir, parse_json_object, read_text, timestamp, write_text};

fn normalized_model_id(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn safe_provider_name(value: &str) -> String {
    let mut output = String::new();
    let mut last_dash = false;
    for ch in value.trim().to_ascii_lowercase().chars() {
        let allowed = ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-');
        if allowed {
            output.push(ch);
            last_dash = false;
        } else if !last_dash && !output.is_empty() {
            output.push('-');
            last_dash = true;
        }
        if output.len() >= 80 {
            break;
        }
    }
    let cleaned = output.trim_matches('-').to_string();
    if cleaned.is_empty() { "provider".to_string() } else { cleaned }
}

fn default_reasoning_levels() -> Value {
    Value::Array(["low", "medium", "high"].into_iter().map(|effort| {
        json!({ "effort": effort, "description": effort })
    }).collect())
}

fn default_model_entry(slug: &str) -> Value {
    json!({
      "slug": slug,
      "display_name": slug,
      "description": format!("{} model", slug),
      "default_reasoning_level": "medium",
      "supported_reasoning_levels": default_reasoning_levels(),
      "shell_type": "shell_command",
      "visibility": "list",
      "supported_in_api": true,
      "priority": 0,
      "additional_speed_tiers": [],
      "service_tiers": [],
      "availability_nux": null,
      "upgrade": null,
      "base_instructions": "You are Codex, an AI coding assistant.",
      "supports_reasoning_summaries": false,
      "default_reasoning_summary": "auto",
      "support_verbosity": false,
      "default_verbosity": null,
      "apply_patch_tool_type": null,
      "web_search_tool_type": "text",
      "truncation_policy": { "mode": "bytes", "limit": 10000 },
      "supports_parallel_tool_calls": false,
      "supports_image_detail_original": false,
      "context_window": 272000,
      "effective_context_window_percent": 95,
      "experimental_supported_tools": [],
      "input_modalities": ["text", "image"],
      "supports_search_tool": false,
      "use_responses_lite": false
    })
}

fn select_template(models: &[Value], slug: &str) -> Option<Value> {
    let normalized = normalized_model_id(slug);
    let preferred: &[&str] = if normalized.starts_with("gpt-5.6") {
        &["gpt-5.5", "gpt-5.4", "gpt-5"]
    } else if normalized.starts_with("gpt-") {
        &["gpt-5.5", "gpt-5.4", "gpt-5"]
    } else {
        &[]
    };
    for prefix in preferred {
        if let Some(found) = models.iter().find(|item| {
            item.get("slug").and_then(Value::as_str)
                .map(normalized_model_id)
                .map(|value| value.starts_with(prefix))
                .unwrap_or(false)
        }) {
            return Some(found.clone());
        }
    }
    models.iter().find(|item| item.get("slug").and_then(Value::as_str).is_some()).cloned()
}

fn model_entry(models: &[Value], slug: &str) -> Value {
    let mut entry = select_template(models, slug).unwrap_or_else(|| default_model_entry(slug));
    if let Some(object) = entry.as_object_mut() {
        object.insert("slug".to_string(), json!(slug));
        object.insert("display_name".to_string(), json!(slug));
        object.insert("description".to_string(), json!(format!("{} model", slug)));
        object.insert("visibility".to_string(), json!("list"));
        object.insert("supported_in_api".to_string(), json!(true));
        object.insert("availability_nux".to_string(), Value::Null);
        object.insert("upgrade".to_string(), Value::Null);
    }
    entry
}

fn read_json(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&text).ok().filter(Value::is_object)
}

fn resolve_catalog_path(codex_home: &Path, configured: &str) -> Option<PathBuf> {
    let trimmed = configured.trim();
    if trimmed.is_empty() { return None; }
    if trimmed == "~" { return dirs::home_dir(); }
    if let Some(rest) = trimmed.strip_prefix("~/").or_else(|| trimmed.strip_prefix("~\\")) {
        return dirs::home_dir().map(|home| home.join(rest));
    }
    let path = PathBuf::from(trimmed);
    Some(if path.is_absolute() { path } else { codex_home.join(path) })
}

fn update_catalog_setting(config_text: &str, catalog_path: &Path) -> String {
    let value = serde_json::to_string(&catalog_path.to_string_lossy().to_string()).unwrap_or_else(|_| "\"\"".to_string());
    let replacement = format!("model_catalog_json = {}", value);
    let mut lines = config_text.lines()
        .filter(|line| !(line.trim_start().starts_with("model_catalog_json") && line.contains('=')))
        .map(str::to_string)
        .collect::<Vec<_>>();
    let table_index = lines.iter().position(|line| line.trim_start().starts_with('['));
    if let Some(index) = table_index { lines.insert(index, replacement); } else { lines.push(replacement); }
    format!("{}\n", lines.join("\n"))
}

fn backup_if_present(source: &Path, target: &Path) -> Result<(), String> {
    if source.exists() {
        fs::copy(source, target).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn sync_model_catalog(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let codex_home_raw = get_string(&object, "codexHome");
    let codex_home = if codex_home_raw.trim().is_empty() { default_codex_home()? } else { PathBuf::from(codex_home_raw.trim()) };
    let home = dirs::home_dir().ok_or_else(|| "无法获取用户主目录".to_string())?;
    if !codex_home.starts_with(&home) {
        return Err("codexHome 必须位于当前用户目录中".to_string());
    }
    let provider_key = get_string(&object, "providerKey");
    let mut requested = Vec::new();
    let mut requested_seen = HashSet::new();
    for value in body.get("models").and_then(Value::as_array).cloned().unwrap_or_default() {
        let Some(model) = value.as_str().map(str::trim).filter(|model| !model.is_empty()) else { continue; };
        let normalized = normalized_model_id(model);
        if requested_seen.insert(normalized) { requested.push(model.to_string()); }
    }
    if requested.is_empty() { return Err("没有可同步的模型".to_string()); }

    ensure_dir(&codex_home)?;
    let config_path = codex_home.join("config.toml");
    let config_text = read_text(&config_path)?;
    let configured_catalog = config_text.parse::<TomlValue>().ok()
        .and_then(|value| value.get("model_catalog_json").and_then(TomlValue::as_str).map(str::to_string))
        .unwrap_or_default();
    let existing_catalog_path = resolve_catalog_path(&codex_home, &configured_catalog);
    let existing_catalog = existing_catalog_path.as_deref().and_then(read_json);
    let cache_catalog = read_json(&codex_home.join("models_cache.json"));
    let mut catalog = existing_catalog.or(cache_catalog).unwrap_or_else(|| json!({ "models": [] }));
    if !catalog.is_object() { catalog = json!({ "models": [] }); }
    let object = catalog.as_object_mut().unwrap();
    let raw_models = object.remove("models").and_then(|value| value.as_array().cloned()).unwrap_or_default();
    let mut models = Vec::new();
    let mut seen = HashSet::new();
    for item in raw_models {
        let Some(slug) = item.get("slug").and_then(Value::as_str) else { continue; };
        if seen.insert(normalized_model_id(slug)) { models.push(item); }
    }
    let mut added_count = 0_u64;
    for model in &requested {
        if seen.insert(normalized_model_id(model)) {
            models.push(model_entry(&models, model));
            added_count += 1;
        }
    }
    let total_count = models.len();
    object.insert("models".to_string(), Value::Array(models));

    let catalog_dir = codex_home.join("model-catalogs");
    ensure_dir(&catalog_dir)?;
    let target_path = catalog_dir.join(format!("model-catalog.{}.json", safe_provider_name(&provider_key)));
    let backup_dir = app_home()?.join("backups").join(format!("model-catalog-{}", timestamp()));
    ensure_dir(&backup_dir)?;
    backup_if_present(&config_path, &backup_dir.join("config.toml"))?;
    backup_if_present(&target_path, &backup_dir.join(target_path.file_name().unwrap_or_default()))?;

    let catalog_text = format!("{}\n", serde_json::to_string_pretty(&catalog).map_err(|error| error.to_string())?);
    write_text(&target_path, &catalog_text)?;
    write_text(&config_path, &update_catalog_setting(&config_text, &target_path))?;

    Ok(json!({ "ok": true, "data": {
        "catalogPath": target_path.to_string_lossy(),
        "configPath": config_path.to_string_lossy(),
        "backupPath": backup_dir.to_string_lossy(),
        "addedCount": added_count,
        "totalCount": total_count,
        "syncedModels": requested,
        "restartRequired": true
    }}))
}
