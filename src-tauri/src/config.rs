struct ScopePaths {
  scope: String,
  root_path: PathBuf,
  config_path: PathBuf,
  env_path: PathBuf,
}

fn summarize_codex_login(auth_json: &Value) -> Value {
  let api_key = auth_json.get("OPENAI_API_KEY").and_then(Value::as_str).unwrap_or("").trim();
  let tokens = auth_json.get("tokens").and_then(Value::as_object);
  let access_token = tokens.and_then(|item| item.get("access_token")).and_then(Value::as_str).unwrap_or("").trim();
  let account_id = tokens.and_then(|item| item.get("account_id")).and_then(Value::as_str).unwrap_or("").trim();

  if !access_token.is_empty() {
    return json!({
      "loggedIn": true,
      "method": "chatgpt",
      "email": "",
      "plan": "",
      "accountId": account_id,
    });
  }

  if !api_key.is_empty() {
    return json!({
      "loggedIn": true,
      "method": "api_key",
      "email": "",
      "plan": "",
      "accountId": "",
    });
  }

  json!({
    "loggedIn": false,
    "method": "",
    "email": "",
    "plan": "",
    "accountId": "",
  })
}

fn scope_paths(scope: &str, project_path: &str, codex_home: &Path) -> Result<ScopePaths, String> {
  if scope == "project" {
    if project_path.trim().is_empty() {
      return Err("Project path is required for project scope".to_string());
    }
    let root_path = PathBuf::from(project_path.trim());
    return Ok(ScopePaths {
      scope: "project".to_string(),
      root_path: root_path.clone(),
      config_path: root_path.join(".codex").join("config.toml"),
      env_path: codex_home.join(".env"),
    });
  }

  Ok(ScopePaths {
    scope: "global".to_string(),
    root_path: codex_home.to_path_buf(),
    config_path: codex_home.join("config.toml"),
    env_path: codex_home.join(".env"),
  })
}


fn create_backup(paths: &ScopePaths) -> Result<String, String> {
  let target_dir = backups_root()?.join(format!("{}-{}", timestamp(), paths.scope));
  ensure_dir(&target_dir)?;
  write_text(&target_dir.join("config.toml.bak"), &read_text(&paths.config_path)?)?;
  write_text(&target_dir.join(".env.bak"), &read_text(&paths.env_path)?)?;
  Ok(target_dir.to_string_lossy().to_string())
}


pub(crate) fn load_state(query: &Value) -> Result<Value, String> {
  let query_object = parse_json_object(query);
  let scope = get_string(&query_object, "scope");
  let project_path = get_string(&query_object, "projectPath");
  let codex_home = {
    let input = get_string(&query_object, "codexHome");
    if input.is_empty() { default_codex_home()? } else { PathBuf::from(input) }
  };
  ensure_dir(&codex_home)?;

  let paths = scope_paths(if scope.is_empty() { "global" } else { &scope }, &project_path, &codex_home)?;
  let config_content = read_text(&paths.config_path)?;
  let env_content = read_text(&paths.env_path)?;
  let auth_content = read_text(&codex_home.join("auth.json"))?;
  let auth_json = serde_json::from_str::<Value>(&auth_content).unwrap_or_else(|_| json!({}));
  let login = summarize_codex_login(&auth_json);
  let config = parse_toml_config(&config_content)?;
  let env = parse_env(&env_content);
  let flat_auth = flatten_auth_json(&auth_json);
  let providers = summarize_providers(&config, &env, &flat_auth);
  let active_provider = providers
    .iter()
    .find(|provider| provider.get("isActive").and_then(Value::as_bool).unwrap_or(false))
    .cloned()
    .unwrap_or(Value::Null);
  let config_object = parse_json_object(&config);
  let codex_binary = find_codex_binary();
  let provider_base_url = active_provider.get("baseUrl").and_then(Value::as_str).unwrap_or_default();
  let env_key = active_provider
    .get("resolvedKeyName")
    .and_then(Value::as_str)
    .filter(|text| !text.is_empty())
    .or_else(|| active_provider.get("envKey").and_then(Value::as_str))
    .unwrap_or_default();

  Ok(json!({
    "appHome": app_home()?.to_string_lossy().to_string(),
    "codexHome": codex_home.to_string_lossy().to_string(),
    "codexBinary": codex_binary,
    "scope": paths.scope,
    "rootPath": paths.root_path.to_string_lossy().to_string(),
    "projectPath": if scope == "project" { paths.root_path.to_string_lossy().to_string() } else { String::new() },
    "configPath": paths.config_path.to_string_lossy().to_string(),
    "envPath": paths.env_path.to_string_lossy().to_string(),
    "configExists": !config_content.trim().is_empty(),
    "envExists": !env_content.trim().is_empty(),
    "configToml": config_content,
    "authJsonRaw": auth_content,
    "config": config,
    "providers": providers,
    "activeProvider": active_provider,
    "login": login,
    "summary": {
      "model": get_string(&config_object, "model"),
      "modelProvider": get_string(&config_object, "model_provider"),
      "providerBaseUrl": provider_base_url,
      "envKey": env_key,
      "approvalPolicy": get_string(&config_object, "approval_policy"),
      "sandboxMode": get_string(&config_object, "sandbox_mode"),
      "reasoningEffort": get_string(&config_object, "model_reasoning_effort"),
      "providerCount": providers.len(),
    },
    "launch": {
      "cwd": if paths.scope == "project" {
        paths.root_path.to_string_lossy().to_string()
      } else {
        home_dir()?.to_string_lossy().to_string()
      },
      "ready": codex_binary.get("installed").and_then(Value::as_bool).unwrap_or(false),
    }
  }))
}

pub(crate) fn get_provider_secret(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let provider_key = get_string(&object, "providerKey");
  if provider_key.trim().is_empty() {
    return Err("providerKey is required".to_string());
  }

  let codex_home = {
    let input = get_string(&object, "codexHome");
    if input.is_empty() { default_codex_home()? } else { PathBuf::from(input) }
  };
  let scope = get_string(&object, "scope");
  let project_path = get_string(&object, "projectPath");
  let paths = scope_paths(if scope.is_empty() { "global" } else { &scope }, &project_path, &codex_home)?;
  let config_content = read_text(&paths.config_path)?;
  let env_content = read_text(&paths.env_path)?;
  let auth_content = read_text(&codex_home.join("auth.json"))?;
  let auth_json = serde_json::from_str::<Value>(&auth_content).unwrap_or_else(|_| json!({}));
  let config = parse_toml_config(&config_content)?;
  let env = parse_env(&env_content);
  let flat_auth = flatten_auth_json(&auth_json);
  reveal_provider_api_key(&config, &env, &flat_auth, &provider_key)
}

pub(crate) async fn test_saved_provider(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let provider_key = get_string(&object, "providerKey");
  if provider_key.trim().is_empty() {
    return Err("providerKey is required".to_string());
  }

  let codex_home = {
    let input = get_string(&object, "codexHome");
    if input.is_empty() { default_codex_home()? } else { PathBuf::from(input) }
  };
  let scope = get_string(&object, "scope");
  let project_path = get_string(&object, "projectPath");
  let timeout_ms = object.get("timeoutMs").and_then(Value::as_u64).unwrap_or(6000);
  let paths = scope_paths(if scope.is_empty() { "global" } else { &scope }, &project_path, &codex_home)?;
  let config_content = read_text(&paths.config_path)?;
  let env_content = read_text(&paths.env_path)?;
  let auth_content = read_text(&codex_home.join("auth.json"))?;
  let auth_json = serde_json::from_str::<Value>(&auth_content).unwrap_or_else(|_| json!({}));
  let config = parse_toml_config(&config_content)?;
  let env = parse_env(&env_content);
  let flat_auth = flatten_auth_json(&auth_json);
  detect_saved_provider(&config, &env, &flat_auth, &provider_key, timeout_ms).await
}

pub(crate) fn pick_directory(app: tauri::AppHandle, body: &Value) -> Result<Value, String> {
  use tauri_plugin_dialog::DialogExt;

  let object = parse_json_object(body);
  let title = get_string(&object, "title");
  let initial_path = get_string(&object, "initialPath");

  let mut dialog = app.dialog().file();
  if !title.trim().is_empty() {
    dialog = dialog.set_title(&title);
  }
  if !initial_path.trim().is_empty() {
    dialog = dialog.set_directory(initial_path);
  }

  let Some(selected) = dialog.blocking_pick_folder() else {
    return Ok(json!({ "selected": false }));
  };

  let path = selected
    .into_path()
    .map_err(|error| error.to_string())?
    .to_string_lossy()
    .to_string();

  Ok(json!({
    "selected": true,
    "path": path,
  }))
}

pub(crate) fn save_config(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let codex_home = {
    let input = get_string(&object, "codexHome");
    if input.is_empty() { default_codex_home()? } else { PathBuf::from(input) }
  };
  let scope = get_string(&object, "scope");
  let project_path = get_string(&object, "projectPath");
  let paths = scope_paths(if scope.is_empty() { "global" } else { &scope }, &project_path, &codex_home)?;
  let config_content = read_text(&paths.config_path)?;
  let env_content = read_text(&paths.env_path)?;
  let mut config = parse_toml_config(&config_content)?;
  let original_config = config.clone();
  let mut env = parse_env(&env_content);
  let original_env = env.clone();
  let base_url = normalize_base_url(&get_string(&object, "baseUrl"))?;
  let api_key = get_string(&object, "apiKey");
  let provider_key = slugify_provider_key(&{
    let input = get_string(&object, "providerKey");
    if input.is_empty() { infer_provider_seed(&base_url) } else { input }
  });
  let model = get_string(&object, "model");
  let approval_policy = get_string(&object, "approvalPolicy");
  let sandbox_mode = get_string(&object, "sandboxMode");
  let reasoning_effort = get_string(&object, "reasoningEffort");

  if !config.is_object() {
    config = json!({});
  }
  let config_object = config.as_object_mut().expect("config object");
  let current_provider = config_object
    .get("model_providers")
    .and_then(Value::as_object)
    .and_then(|providers| providers.get(&provider_key))
    .and_then(Value::as_object)
    .cloned()
    .unwrap_or_default();

  let provider_label = {
    let input = get_string(&object, "providerLabel");
    if !input.is_empty() {
      input
    } else if let Some(name) = current_provider.get("name").and_then(Value::as_str) {
      name.to_string()
    } else {
      infer_provider_label(&base_url, &provider_key)
    }
  };
  let env_key = {
    let input = get_string(&object, "envKey");
    if !input.is_empty() {
      input
    } else if let Some(name) = current_provider.get("env_key").and_then(Value::as_str) {
      name.to_string()
    } else {
      infer_env_key(&provider_key)
    }
  };

  config_object.insert("model_provider".to_string(), json!(provider_key));
  if !model.is_empty() {
    config_object.insert("model".to_string(), json!(model));
  }
  if !approval_policy.is_empty() {
    config_object.insert("approval_policy".to_string(), json!(approval_policy));
  }
  if !sandbox_mode.is_empty() {
    config_object.insert("sandbox_mode".to_string(), json!(sandbox_mode));
  }
  if !reasoning_effort.is_empty() {
    config_object.insert("model_reasoning_effort".to_string(), json!(reasoning_effort));
  }

  let providers = config_object.entry("model_providers".to_string()).or_insert_with(|| json!({}));
  if !providers.is_object() {
    *providers = json!({});
  }
  let providers_object = providers.as_object_mut().expect("providers object");
  let mut next_provider = current_provider.clone();
  next_provider.insert("name".to_string(), json!(provider_label));
  next_provider.insert("base_url".to_string(), json!(base_url));
  next_provider.insert("env_key".to_string(), json!(env_key.clone()));
  if !next_provider.contains_key("wire_api") {
    next_provider.insert("wire_api".to_string(), json!("responses"));
  }
  providers_object.insert(provider_key.clone(), Value::Object(next_provider));

  if !api_key.trim().is_empty() && !env_key.trim().is_empty() {
    env.insert(env_key.clone(), api_key.trim().to_string());
  }

  let config_changed = config != original_config;
  let env_changed = env != original_env;
  let needs_write = config_changed || env_changed;
  let backup_path = if needs_write {
    Some(create_backup(&paths)?)
  } else {
    None
  };
  if config_changed {
    write_text(&paths.config_path, &stringify_toml_config(&config)?)?;
  }
  if env_changed {
    write_text(&paths.env_path, &stringify_env(&env))?;
  }

  Ok(json!({
    "saved": true,
    "backupPath": backup_path,
    "paths": {
      "scope": paths.scope,
      "rootPath": paths.root_path.to_string_lossy().to_string(),
      "configPath": paths.config_path.to_string_lossy().to_string(),
      "envPath": paths.env_path.to_string_lossy().to_string(),
    },
    "activeProvider": provider_key,
    "changed": {
      "config": config_changed,
      "env": env_changed,
    },
  }))
}

pub(crate) fn save_settings(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let codex_home = {
    let input = get_string(&object, "codexHome");
    if input.is_empty() { default_codex_home()? } else { PathBuf::from(input) }
  };
  let scope = get_string(&object, "scope");
  let project_path = get_string(&object, "projectPath");
  let paths = scope_paths(if scope.is_empty() { "global" } else { &scope }, &project_path, &codex_home)?;
  let config_content = read_text(&paths.config_path)?;
  let mut config = parse_toml_config(&config_content)?;
  let original_config = config.clone();
  let normalized_settings = normalize_settings_patch(object.get("settings").unwrap_or(&json!({})));
  apply_patch(&mut config, &normalized_settings);

  let changed = config != original_config;
  let backup_path = if changed {
    Some(create_backup(&paths)?)
  } else {
    None
  };
  if changed {
    write_text(&paths.config_path, &stringify_toml_config(&config)?)?;
  }

  Ok(json!({
    "saved": true,
    "backupPath": backup_path,
    "paths": {
      "scope": paths.scope,
      "rootPath": paths.root_path.to_string_lossy().to_string(),
      "configPath": paths.config_path.to_string_lossy().to_string(),
      "envPath": paths.env_path.to_string_lossy().to_string(),
    },
    "changed": changed,
  }))
}

pub(crate) fn save_raw_config(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let codex_home = {
    let input = get_string(&object, "codexHome");
    if input.is_empty() { default_codex_home()? } else { PathBuf::from(input) }
  };
  let scope = get_string(&object, "scope");
  let project_path = get_string(&object, "projectPath");
  let paths = scope_paths(if scope.is_empty() { "global" } else { &scope }, &project_path, &codex_home)?;
  let config_toml = get_string(&object, "configToml");
  if config_toml.trim().is_empty() {
    return Err("config.toml 内容不能为空".to_string());
  }

  config_toml.parse::<TomlValue>().map_err(|error| format!("TOML 解析失败：{error}"))?;
  let current_content = read_text(&paths.config_path)?;
  let changed = current_content != config_toml;
  let backup_path = if changed {
    Some(create_backup(&paths)?)
  } else {
    None
  };
  if changed {
    write_text(&paths.config_path, &config_toml)?;
  }

  // Also save auth.json if provided
  let auth_json_raw = get_string(&object, "authJson");
  let mut auth_changed = false;
  if !auth_json_raw.trim().is_empty() {
    // Validate JSON
    serde_json::from_str::<Value>(&auth_json_raw).map_err(|e| format!("auth.json 解析失败：{e}"))?;
    let auth_path = codex_home.join("auth.json");
    let current_auth = read_text(&auth_path)?;
    if current_auth != auth_json_raw {
      write_text(&auth_path, &auth_json_raw)?;
      auth_changed = true;
    }
  }

  Ok(json!({
    "saved": true,
    "backupPath": backup_path,
    "paths": {
      "scope": paths.scope,
      "rootPath": paths.root_path.to_string_lossy().to_string(),
      "configPath": paths.config_path.to_string_lossy().to_string(),
      "envPath": paths.env_path.to_string_lossy().to_string(),
    },
    "changed": changed || auth_changed,
  }))
}

pub(crate) fn list_backups() -> Result<Value, String> {
  let root = backups_root()?;
  ensure_dir(&root)?;
  let mut items = fs::read_dir(root)
    .map_err(|error| error.to_string())?
    .filter_map(|entry| entry.ok())
    .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
    .map(|entry| {
      let path = entry.path();
      json!({
        "name": entry.file_name().to_string_lossy().to_string(),
        "path": path.to_string_lossy().to_string(),
      })
    })
    .collect::<Vec<_>>();
  items.sort_by(|left, right| {
    let left_name = left.get("name").and_then(Value::as_str).unwrap_or_default();
    let right_name = right.get("name").and_then(Value::as_str).unwrap_or_default();
    right_name.cmp(left_name)
  });
  Ok(Value::Array(items))
}

pub(crate) fn restore_backup(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let backup_name = get_string(&object, "backupName");
  if backup_name.trim().is_empty() {
    return Err("Backup name is required".to_string());
  }
  let codex_home = {
    let input = get_string(&object, "codexHome");
    if input.is_empty() { default_codex_home()? } else { PathBuf::from(input) }
  };
  let scope = get_string(&object, "scope");
  let project_path = get_string(&object, "projectPath");
  let paths = scope_paths(if scope.is_empty() { "global" } else { &scope }, &project_path, &codex_home)?;
  let backup_dir = backups_root()?.join(backup_name);
  write_text(&paths.config_path, &read_text(&backup_dir.join("config.toml.bak"))?)?;
  write_text(&paths.env_path, &read_text(&backup_dir.join(".env.bak"))?)?;
  Ok(json!({
    "restored": true,
    "paths": {
      "scope": paths.scope,
      "rootPath": paths.root_path.to_string_lossy().to_string(),
      "configPath": paths.config_path.to_string_lossy().to_string(),
      "envPath": paths.env_path.to_string_lossy().to_string(),
    }
  }))
}

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use toml::Value as TomlValue;

use crate::codex::find_codex_binary;
use crate::provider::{
  detect_saved_provider, flatten_auth_json, get_string, infer_env_key, infer_provider_label,
  infer_provider_seed, normalize_base_url, reveal_provider_api_key, slugify_provider_key,
  summarize_providers,
};
use crate::{
  app_home, apply_patch, backups_root, default_codex_home, ensure_dir, home_dir,
  normalize_settings_patch, parse_env, parse_json_object, parse_toml_config, read_text,
  stringify_env, stringify_toml_config, timestamp, write_text,
};
