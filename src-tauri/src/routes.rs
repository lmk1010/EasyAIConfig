use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::codex::{
    cancel_codex_app_install_task, cancel_openclaw_install_task, cancel_opencode_install_task,
    check_setup_environment, cleanup_system_storage, codex_npm_action, delete_claudecode_provider,
    export_codex_session, fork_codex_session, get_codex_app_install_task, get_codex_app_state,
    get_codex_release_info, get_codex_session_detail, get_codex_usage_metrics,
    get_openclaw_dashboard_url, get_openclaw_install_task, get_opencode_install_task,
    get_system_storage_state, get_tool_updates_info, install_codex_app, install_openclaw_remote,
    install_opencode, kill_openclaw_port_occupants, launch_claude_desktop, launch_claudecode,
    launch_codex, launch_gemini, launch_hermes, launch_openclaw, launch_opencode,
    list_codex_session_homes, list_codex_sessions, list_tools, load_claudecode_state,
    load_openclaw_state, load_opencode_state, login_claudecode, login_codex, login_opencode,
    migrate_codex_sessions, model_eval_claudecode_provider, onboard_openclaw, open_codex_app,
    open_url_in_browser, reinstall_opencode, remove_opencode_auth, repair_openclaw_dashboard_auth,
    resume_codex_session, run_openclaw_install_script, save_claudecode_config,
    save_claudecode_raw_config, save_openclaw_config, save_opencode_config,
    save_opencode_raw_config, start_codex_app_install_task, start_openclaw_install_task,
    start_opencode_install_task, stop_openclaw_gateway, uninstall_openclaw, uninstall_opencode,
    update_opencode,
};
use crate::config::{
    delete_codex_provider, get_provider_secret, list_backups, load_state,
    model_eval_saved_provider, pick_directory, read_config_file, restore_backup, save_config,
    save_raw_config, save_settings, set_default_model, test_saved_provider, use_oauth_config,
    write_config_file,
};

use crate::app_settings::{load_app_settings, save_app_settings};
use crate::claudecode_oauth_profiles::{
    create_claudecode_oauth_profile, delete_claudecode_oauth_profile,
    list_claudecode_oauth_profiles, rename_claudecode_oauth_profile,
    switch_claudecode_oauth_profile,
};
use crate::codex_oauth_usage::query_codex_oauth_usage;
use crate::network::{
    get_network_latency, get_network_status, list_network_ip_history, refresh_network_status,
};
use crate::oauth_profiles::{
    create_oauth_profile, delete_oauth_profile, list_oauth_profiles, rename_oauth_profile,
    save_current_oauth_profile, switch_oauth_profile,
};
use crate::processes::{kill_process, list_processes};
use crate::provider::detect_provider;
use crate::provider_remote_usage::{
    delete_provider_remote_usage_credential, get_provider_remote_usage_credential,
    query_saved_provider_remote_usage, save_provider_remote_usage_credential,
};
use crate::provider_remote_usage_cache::{
    list_provider_remote_usage_cache, save_provider_remote_usage_cache,
};
use crate::provider_router::{
    apply_provider_router_client_config, clear_provider_router_logs, load_gemini_state,
    load_hermes_state, preview_router_response_rectifier, probe_provider_router,
    query_provider_router_logs, query_provider_router_status, start_provider_router,
    stop_provider_router,
};
use crate::shell_integration::{
    disable_shell_integration, enable_shell_integration, shell_integration_status,
};
use crate::terminal::{
    terminal_close, terminal_create, terminal_list, terminal_read, terminal_resize, terminal_write,
};
use crate::updater::{get_app_update_info, get_app_update_progress, install_app_update};
use crate::usage_stats::{claudecode_local_usage, codex_session_stats};
use crate::{
    app_home, default_codex_home, expand_home_path, fail, home_dir, ok, openclaw_home,
    opencode_config_home, opencode_data_home, CLAUDE_CODE_PACKAGE, CODEBUDDY_CODE_PACKAGE,
    GEMINI_CLI_PACKAGE, OPENAI_CODEX_PACKAGE, OPENCLAW_PACKAGE, OPENCODE_PACKAGE,
    QWEN_CODE_PACKAGE,
};

const NPM_REGISTRY_CN: &str = "https://registry.npmmirror.com";

fn read_safe_npm_version(body: &Value) -> Result<String, String> {
    let version = body
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let safe = !version.is_empty()
        && version.len() <= 128
        && version
            .chars()
            .next()
            .map(|ch| ch.is_ascii_alphanumeric())
            .unwrap_or(false)
        && version
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '+' | '-'));
    if !safe {
        return Err("目标版本格式无效".to_string());
    }
    Ok(version.to_string())
}

fn npm_install_package_version(
    package_name: &str,
    body: &Value,
    use_cn_registry: bool,
) -> Result<Value, String> {
    let version = read_safe_npm_version(body)?;
    let package_spec = format!("{}@{}", package_name, version);
    if use_cn_registry {
        let args = [
            "install",
            "-g",
            package_spec.as_str(),
            "--registry",
            NPM_REGISTRY_CN,
        ];
        codex_npm_action(&args)
    } else {
        let args = ["install", "-g", package_spec.as_str()];
        codex_npm_action(&args)
    }
}

fn npm_install_package_latest(
    package_name: &str,
    use_cn_registry: bool,
    force: bool,
) -> Result<Value, String> {
    let package_spec = format!("{}@latest", package_name);
    let mut args = vec!["install", "-g", package_spec.as_str()];
    if force {
        args.push("--force");
    }
    if use_cn_registry {
        args.push("--registry");
        args.push(NPM_REGISTRY_CN);
    }
    codex_npm_action(&args)
}

fn npm_uninstall_package(package_name: &str) -> Result<Value, String> {
    codex_npm_action(&["uninstall", "-g", package_name])
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn increment_count(map: &mut Map<String, Value>, key: &str) {
    if key.trim().is_empty() {
        return;
    }
    let next = map.get(key).and_then(Value::as_u64).unwrap_or(0) + 1;
    map.insert(key.to_string(), json!(next));
}

fn asset_provider_catalog_from_state(state: &Value) -> Value {
    let providers = state
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut protocols = Map::new();
    let mut presets = Vec::new();

    for provider in &providers {
        let key = provider
            .get("key")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let name = provider.get("name").and_then(Value::as_str).unwrap_or(key);
        let base_url = provider
            .get("baseUrl")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let env_key = provider
            .get("envKey")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .or_else(|| provider.get("resolvedKeyName").and_then(Value::as_str))
            .unwrap_or_default();
        let wire_api = provider
            .get("wireApi")
            .and_then(Value::as_str)
            .unwrap_or("responses");
        increment_count(&mut protocols, wire_api);
        presets.push(json!({
          "id": key,
          "name": name,
          "region": "local",
          "protocols": [wire_api],
          "baseUrls": if base_url.is_empty() { json!([]) } else { json!([base_url]) },
          "envKey": env_key,
          "tools": ["codex"],
          "tags": ["local", "codex", wire_api],
          "docsUrl": "",
          "notes": "Imported from local Codex config by the Tauri desktop asset fallback.",
          "capabilities": {
            "streaming": true,
            "toolCalls": false,
            "nativeResponses": wire_api == "responses",
            "openAiCompatible": wire_api != "anthropic",
            "anthropicCompatible": wire_api == "anthropic",
            "geminiCompatible": wire_api == "gemini",
          },
        }));
    }

    json!({
      "schema": "easyaiconfig.provider-catalog.v1",
      "exportedAt": now_iso(),
      "summary": {
        "revision": "tauri-local-fallback",
        "count": providers.len(),
        "regions": { "local": providers.len() },
        "protocols": protocols,
        "tools": {
          "codex": providers.len(),
          "claudecode": 0,
          "claude-desktop": 0,
          "gemini": 0,
          "opencode": 0,
          "openclaw": 0,
          "hermes": 0,
        },
      },
      "presets": presets,
    })
}

fn fallback_home_dir() -> PathBuf {
    home_dir().unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn query_path(query: &Value, key: &str) -> Option<PathBuf> {
    query
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| expand_home_path(value).unwrap_or_else(|| PathBuf::from(value)))
}

fn codex_home_from_query(query: &Value) -> PathBuf {
    query_path(query, "codexHome").unwrap_or_else(|| {
        default_codex_home().unwrap_or_else(|_| fallback_home_dir().join(".codex"))
    })
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn path_exists(path: &Path) -> bool {
    fs::metadata(path).is_ok()
}

fn read_optional_text(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn sha256_hex(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn first_markdown_title(text: &str) -> String {
    text.lines()
        .find_map(|line| line.trim().strip_prefix("# ").map(str::trim))
        .unwrap_or_default()
        .to_string()
}

fn compact_preview(text: &str, max_len: usize) -> String {
    let normalized = text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if normalized.len() <= max_len {
        normalized
    } else {
        format!(
            "{}...",
            normalized
                .chars()
                .take(max_len.saturating_sub(3))
                .collect::<String>()
                .trim()
        )
    }
}

fn system_time_ms(value: SystemTime) -> u64 {
    value
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn file_modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map(system_time_ms)
        .unwrap_or(0)
}

fn ms_to_iso(ms: u64) -> String {
    if ms == 0 {
        return String::new();
    }
    chrono::DateTime::<chrono::Utc>::from(UNIX_EPOCH + std::time::Duration::from_millis(ms))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn strip_json_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;
    let mut quote = '\0';
    let mut escaped = false;
    while let Some(ch) = chars.next() {
        if in_string {
            out.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == quote {
                in_string = false;
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            in_string = true;
            quote = ch;
            out.push(ch);
            continue;
        }
        if ch == '/' && chars.peek() == Some(&'/') {
            for next in chars.by_ref() {
                if next == '\n' {
                    out.push('\n');
                    break;
                }
            }
            continue;
        }
        if ch == '/' && chars.peek() == Some(&'*') {
            chars.next();
            let mut previous = '\0';
            for next in chars.by_ref() {
                if previous == '*' && next == '/' {
                    break;
                }
                previous = next;
            }
            continue;
        }
        out.push(ch);
    }
    out
}

fn parse_json_like(raw: &str, label: &str) -> Result<Value, String> {
    if raw.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str::<Value>(&strip_json_comments(raw))
        .map_err(|error| format!("{label} parse failed: {error}"))
}

fn value_string(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn value_bool(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(item)) => *item,
        Some(Value::Number(item)) => item.as_i64().unwrap_or(0) != 0,
        Some(Value::String(item)) => matches!(
            item.trim().to_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        _ => false,
    }
}

fn normalize_args(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| {
                if let Some(text) = item.as_str() {
                    Some(text.to_string())
                } else if item.is_null() {
                    None
                } else {
                    Some(item.to_string())
                }
            })
            .collect(),
        Some(Value::String(text)) if !text.trim().is_empty() => vec![text.trim().to_string()],
        _ => Vec::new(),
    }
}

fn env_keys(value: Option<&Value>) -> Vec<String> {
    let mut keys = value
        .and_then(Value::as_object)
        .map(|object| object.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    keys.sort();
    keys
}

fn normalize_mcp_servers(value: Option<&Value>, tool: &str, field: &str) -> Vec<Value> {
    let Some(object) = value.and_then(Value::as_object) else {
        return Vec::new();
    };
    object
    .iter()
    .map(|(id, raw)| {
      let entry = raw.as_object();
      let command = value_string(entry.and_then(|item| item.get("command")).or_else(|| entry.and_then(|item| item.get("cmd"))));
      let url = value_string(entry.and_then(|item| item.get("url")));
      let transport = value_string(entry.and_then(|item| item.get("transport")).or_else(|| entry.and_then(|item| item.get("type"))));
      json!({
        "id": id,
        "tool": tool,
        "field": field,
        "command": command,
        "args": normalize_args(entry.and_then(|item| item.get("args"))),
        "envKeys": env_keys(entry.and_then(|item| item.get("env"))),
        "transport": if transport.is_empty() { if url.is_empty() { "stdio" } else { "http" } } else { transport.as_str() },
        "url": url,
        "disabled": value_bool(entry.and_then(|item| item.get("disabled"))),
      })
    })
    .collect()
}

fn mcp_source_result(
    tool: &str,
    label: &str,
    source_path: &Path,
    exists: bool,
    parse_error: String,
    read_error: String,
    servers: Vec<Value>,
) -> Value {
    json!({
      "tool": tool,
      "label": label,
      "sourcePath": path_string(source_path),
      "exists": exists,
      "parseError": parse_error,
      "readError": read_error,
      "count": servers.len(),
      "servers": servers,
    })
}

fn read_codex_mcp_source(codex_home: &Path) -> Value {
    let source_path = codex_home.join("config.toml");
    let exists = path_exists(&source_path);
    let raw = match read_optional_text(&source_path) {
        Ok(Some(text)) => text,
        Ok(None) => {
            return mcp_source_result(
                "codex",
                "Codex config.toml",
                &source_path,
                false,
                String::new(),
                String::new(),
                vec![],
            )
        }
        Err(error) => {
            return mcp_source_result(
                "codex",
                "Codex config.toml",
                &source_path,
                exists,
                String::new(),
                error,
                vec![],
            )
        }
    };
    match raw.parse::<toml::Value>() {
        Ok(parsed) => {
            let parsed_json = serde_json::to_value(parsed).unwrap_or_else(|_| json!({}));
            let servers = normalize_mcp_servers(
                parsed_json
                    .get("mcp_servers")
                    .or_else(|| parsed_json.get("mcpServers")),
                "codex",
                if parsed_json.get("mcp_servers").is_some() {
                    "mcp_servers"
                } else {
                    "mcpServers"
                },
            );
            mcp_source_result(
                "codex",
                "Codex config.toml",
                &source_path,
                true,
                String::new(),
                String::new(),
                servers,
            )
        }
        Err(error) => mcp_source_result(
            "codex",
            "Codex config.toml",
            &source_path,
            true,
            format!("Codex config.toml parse failed: {error}"),
            String::new(),
            vec![],
        ),
    }
}

fn read_json_mcp_source(tool: &str, label: &str, source_path: PathBuf, field: &str) -> Value {
    let exists = path_exists(&source_path);
    let raw = match read_optional_text(&source_path) {
        Ok(Some(text)) => text,
        Ok(None) => {
            return mcp_source_result(
                tool,
                label,
                &source_path,
                false,
                String::new(),
                String::new(),
                vec![],
            )
        }
        Err(error) => {
            return mcp_source_result(
                tool,
                label,
                &source_path,
                exists,
                String::new(),
                error,
                vec![],
            )
        }
    };
    match parse_json_like(&raw, label) {
        Ok(parsed) => {
            let servers = normalize_mcp_servers(parsed.get(field), tool, field);
            mcp_source_result(
                tool,
                label,
                &source_path,
                true,
                String::new(),
                String::new(),
                servers,
            )
        }
        Err(error) => mcp_source_result(
            tool,
            label,
            &source_path,
            true,
            error,
            String::new(),
            vec![],
        ),
    }
}

fn claude_desktop_config_path() -> PathBuf {
    let home = fallback_home_dir();
    if cfg!(target_os = "macos") {
        return home
            .join("Library")
            .join("Application Support")
            .join("Claude")
            .join("claude_desktop_config.json");
    }
    if cfg!(target_os = "windows") {
        let base = std::env::var("APPDATA")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"));
        return base.join("Claude").join("claude_desktop_config.json");
    }
    std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"))
        .join("Claude")
        .join("claude_desktop_config.json")
}

fn mcp_inventory(query: &Value) -> Value {
    let codex_home = codex_home_from_query(query);
    let claude_home = fallback_home_dir().join(".claude");
    let open_code_config = opencode_config_home()
        .unwrap_or_else(|_| fallback_home_dir().join(".config").join("opencode"))
        .join("opencode.json");
    let sources = vec![
        read_codex_mcp_source(&codex_home),
        read_json_mcp_source(
            "claudecode",
            "Claude Code settings.json",
            claude_home.join("settings.json"),
            "mcpServers",
        ),
        read_json_mcp_source(
            "claude-desktop",
            "Claude Desktop config",
            claude_desktop_config_path(),
            "mcpServers",
        ),
        read_json_mcp_source(
            "opencode",
            "OpenCode opencode.json",
            open_code_config,
            "mcp",
        ),
    ];
    let mut servers = Vec::new();
    let mut tools = Map::new();
    for source in &sources {
        let count = source.get("count").and_then(Value::as_u64).unwrap_or(0);
        if let Some(tool) = source.get("tool").and_then(Value::as_str) {
            tools.insert(tool.to_string(), json!(count));
        }
        if let Some(source_servers) = source.get("servers").and_then(Value::as_array) {
            for server in source_servers {
                let mut item = server.clone();
                if let Some(object) = item.as_object_mut() {
                    object.insert(
                        "sourcePath".to_string(),
                        source.get("sourcePath").cloned().unwrap_or(Value::Null),
                    );
                    object.insert(
                        "sourceLabel".to_string(),
                        source.get("label").cloned().unwrap_or(Value::Null),
                    );
                }
                servers.push(item);
            }
        }
    }
    json!({
      "schema": "easyaiconfig.mcp-inventory.v1",
      "generatedAt": now_iso(),
      "summary": {
        "sources": sources.len(),
        "existingSources": sources.iter().filter(|source| source.get("exists").and_then(Value::as_bool).unwrap_or(false)).count(),
        "parseErrors": sources.iter().filter(|source| !source.get("parseError").and_then(Value::as_str).unwrap_or("").is_empty()).count(),
        "readErrors": sources.iter().filter(|source| !source.get("readError").and_then(Value::as_str).unwrap_or("").is_empty()).count(),
        "servers": servers.len(),
        "tools": tools,
      },
      "sources": sources,
      "servers": servers,
    })
}

fn prompt_file_summary(id: &str, tool: &str, scope: &str, source_path: PathBuf) -> Value {
    match read_optional_text(&source_path) {
        Ok(Some(raw)) => json!({
          "promptId": id,
          "tool": tool,
          "scope": scope,
          "sourcePath": path_string(&source_path),
          "exists": true,
          "bytes": raw.as_bytes().len(),
          "lineCount": if raw.is_empty() { 0 } else { raw.lines().count() },
          "sha256": sha256_hex(&raw),
          "title": first_markdown_title(&raw),
          "preview": compact_preview(&raw, 240),
        }),
        Ok(None) => json!({
          "promptId": id,
          "tool": tool,
          "scope": scope,
          "sourcePath": path_string(&source_path),
          "exists": false,
          "bytes": 0,
          "lineCount": 0,
          "sha256": "",
          "title": "",
          "preview": "",
        }),
        Err(error) => json!({
          "promptId": id,
          "tool": tool,
          "scope": scope,
          "sourcePath": path_string(&source_path),
          "exists": false,
          "readError": error,
          "bytes": 0,
          "lineCount": 0,
          "sha256": "",
          "title": "",
          "preview": "",
        }),
    }
}

fn prompt_inventory(query: &Value) -> Value {
    let codex_home = codex_home_from_query(query);
    let home = fallback_home_dir();
    let project_path = query_path(query, "projectPath");
    let specs = [
        (
            "codex-agents",
            "codex",
            "AGENTS.md",
            codex_home.join("AGENTS.md"),
        ),
        (
            "claude-code",
            "claudecode",
            "CLAUDE.md",
            home.join(".claude").join("CLAUDE.md"),
        ),
        (
            "gemini",
            "gemini",
            "GEMINI.md",
            home.join(".gemini").join("GEMINI.md"),
        ),
    ];
    let mut files = Vec::new();
    for (id, tool, file_name, global_path) in specs {
        files.push(prompt_file_summary(id, tool, "global", global_path));
        if let Some(project) = &project_path {
            files.push(prompt_file_summary(
                id,
                tool,
                "project",
                project.join(file_name),
            ));
        }
    }
    let existing = files
        .iter()
        .filter(|file| file.get("exists").and_then(Value::as_bool).unwrap_or(false))
        .count();
    let read_errors = files
        .iter()
        .filter(|file| file.get("readError").is_some())
        .count();
    let mut tools = Map::new();
    for tool in ["codex", "claudecode", "gemini"] {
        tools.insert(
            tool.to_string(),
            json!(files
                .iter()
                .filter(|file| file.get("tool").and_then(Value::as_str) == Some(tool))
                .filter(|file| file.get("exists").and_then(Value::as_bool).unwrap_or(false))
                .count()),
        );
    }
    json!({
      "schema": "easyaiconfig.prompt-inventory.v1",
      "generatedAt": now_iso(),
      "projectPath": project_path.as_ref().map(|path| path_string(path)).unwrap_or_default(),
      "files": files,
      "prompts": [],
      "summary": {
        "files": files.len(),
        "existing": existing,
        "readErrors": read_errors,
        "projectFiles": files.iter().filter(|file| file.get("scope").and_then(Value::as_str) == Some("project") && file.get("exists").and_then(Value::as_bool).unwrap_or(false)).count(),
        "globalFiles": files.iter().filter(|file| file.get("scope").and_then(Value::as_str) == Some("global") && file.get("exists").and_then(Value::as_bool).unwrap_or(false)).count(),
        "tools": tools,
      },
    })
}

fn first_paragraph(markdown: &str) -> String {
    let mut buffer = Vec::new();
    for line in markdown.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed == "---" {
            if !buffer.is_empty() {
                break;
            }
            continue;
        }
        buffer.push(trimmed);
        if buffer.join(" ").len() > 240 {
            break;
        }
    }
    compact_preview(&buffer.join(" "), 240)
}

fn find_skill_doc(skill_path: &Path) -> (PathBuf, String) {
    for file_name in ["SKILL.md", "skill.md", "README.md", "readme.md"] {
        let doc_path = skill_path.join(file_name);
        if let Ok(Some(raw)) = read_optional_text(&doc_path) {
            return (doc_path, raw);
        }
    }
    (PathBuf::new(), String::new())
}

fn skill_source(id: &str, tool: &str, label: &str, root_path: PathBuf) -> Value {
    let mut skills = Vec::new();
    let entries = match fs::read_dir(&root_path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return json!({
              "id": id,
              "tool": tool,
              "label": label,
              "rootPath": path_string(&root_path),
              "exists": false,
              "count": 0,
              "skills": [],
            });
        }
        Err(error) => {
            return json!({
              "id": id,
              "tool": tool,
              "label": label,
              "rootPath": path_string(&root_path),
              "exists": false,
              "readError": error.to_string(),
              "count": 0,
              "skills": [],
            });
        }
    };
    for entry in entries.filter_map(Result::ok).take(500) {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let skill_path = entry.path();
        let (doc_path, raw) = find_skill_doc(&skill_path);
        skills.push(json!({
      "id": format!("{id}:{name}"),
      "name": name,
      "tool": tool,
      "sourceId": id,
      "sourceLabel": label,
      "rootPath": path_string(&root_path),
      "skillPath": path_string(&skill_path),
      "docPath": if doc_path.as_os_str().is_empty() { String::new() } else { path_string(&doc_path) },
      "hasDoc": !raw.is_empty(),
      "title": if raw.is_empty() { entry.file_name().to_string_lossy().to_string() } else { first_markdown_title(&raw) },
      "description": first_paragraph(&raw),
      "bytes": raw.as_bytes().len(),
      "sha256": if raw.is_empty() { String::new() } else { sha256_hex(&raw) },
    }));
    }
    json!({
      "id": id,
      "tool": tool,
      "label": label,
      "rootPath": path_string(&root_path),
      "exists": true,
      "count": skills.len(),
      "skills": skills,
    })
}

fn skill_inventory(query: &Value) -> Value {
    let codex_home = codex_home_from_query(query);
    let home = fallback_home_dir();
    let easyai_home = app_home().unwrap_or_else(|_| home.join(".codex-config-ui"));
    let sources = vec![
        skill_source(
            "codex-user",
            "codex",
            "Codex user skills",
            codex_home.join("skills"),
        ),
        skill_source(
            "claude-user",
            "claudecode",
            "Claude user skills",
            home.join(".claude").join("skills"),
        ),
        skill_source(
            "easyai-user",
            "easyai",
            "EasyAIConfig user skills",
            easyai_home.join("skills"),
        ),
    ];
    let skills = sources
        .iter()
        .flat_map(|source| {
            source
                .get("skills")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .collect::<Vec<_>>();
    let mut tools = Map::new();
    for source in &sources {
        if let Some(tool) = source.get("tool").and_then(Value::as_str) {
            tools.insert(
                tool.to_string(),
                source.get("count").cloned().unwrap_or(json!(0)),
            );
        }
    }
    json!({
      "schema": "easyaiconfig.skill-inventory.v1",
      "generatedAt": now_iso(),
      "sources": sources,
      "skills": skills,
      "summary": {
        "sources": sources.len(),
        "existingSources": sources.iter().filter(|source| source.get("exists").and_then(Value::as_bool).unwrap_or(false)).count(),
        "skills": skills.len(),
        "documented": skills.iter().filter(|skill| skill.get("hasDoc").and_then(Value::as_bool).unwrap_or(false)).count(),
        "readErrors": sources.iter().filter(|source| source.get("readError").is_some()).count(),
        "tools": tools,
      },
    })
}

fn collect_files(root: &Path, extensions: &[&str], max_files: usize) -> Vec<PathBuf> {
    fn walk(
        out: &mut Vec<PathBuf>,
        dir: &Path,
        extensions: &[&str],
        max_files: usize,
        depth: usize,
    ) {
        if out.len() >= max_files || depth > 8 {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            if out.len() >= max_files {
                break;
            }
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                walk(out, &path, extensions, max_files, depth + 1);
            } else if file_type.is_file() {
                let lower = path
                    .extension()
                    .and_then(|value| value.to_str())
                    .map(|value| format!(".{}", value.to_lowercase()))
                    .unwrap_or_default();
                if extensions.iter().any(|ext| *ext == lower) {
                    out.push(path);
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(&mut out, root, extensions, max_files, 0);
    out.sort_by_key(|path| std::cmp::Reverse(file_modified_ms(path)));
    out
}

fn parse_timestamp_ms(value: Option<&Value>, fallback: u64) -> u64 {
    match value {
        Some(Value::Number(number)) => {
            let raw = number.as_u64().unwrap_or(0);
            if raw > 1_000_000_000_000 {
                raw
            } else if raw > 0 {
                raw * 1000
            } else {
                fallback
            }
        }
        Some(Value::String(text)) => chrono::DateTime::parse_from_rfc3339(text)
            .map(|dt| dt.timestamp_millis().max(0) as u64)
            .unwrap_or(fallback),
        _ => fallback,
    }
}

fn session_text_from_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .or_else(|| item.get("text").and_then(Value::as_str).map(str::to_string))
                    .or_else(|| {
                        item.get("content")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
            })
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

fn session_preview(record: &Value) -> String {
    let message = record.get("message").unwrap_or(record);
    compact_preview(
        &[
            value_string(record.get("title")),
            session_text_from_value(message.get("content")),
            session_text_from_value(record.get("content")),
            value_string(record.get("text")),
            value_string(record.get("prompt")),
        ]
        .into_iter()
        .find(|item| !item.trim().is_empty())
        .unwrap_or_default(),
        96,
    )
}

fn parse_session_file(file_path: &Path, tool: &str, provider: &str, label: &str) -> Option<Value> {
    let modified_ms = file_modified_ms(file_path);
    let raw = fs::read_to_string(file_path).ok()?;
    let mut first_object: Option<Value> = None;
    let mut last_object: Option<Value> = None;
    let trimmed = raw.trim();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
            if let Some(array) = parsed.as_array() {
                first_object = array.iter().find(|item| item.is_object()).cloned();
                last_object = array.iter().rev().find(|item| item.is_object()).cloned();
            } else if parsed.is_object() {
                first_object = Some(parsed.clone());
                last_object = Some(parsed);
            }
        }
    }
    if last_object.is_none() {
        for line in raw
            .lines()
            .filter(|line| !line.trim().is_empty())
            .take(2000)
        {
            if let Ok(parsed) = serde_json::from_str::<Value>(line) {
                if parsed.is_object() {
                    if first_object.is_none() {
                        first_object = Some(parsed.clone());
                    }
                    last_object = Some(parsed);
                }
            }
        }
    }
    let object = last_object.or(first_object).unwrap_or_else(|| json!({}));
    let file_stem = file_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("session")
        .to_string();
    let session_id = [
        value_string(object.get("sessionId")),
        value_string(object.get("session_id")),
        value_string(object.get("id")),
        value_string(object.get("conversationId")),
        file_stem.clone(),
    ]
    .into_iter()
    .find(|value| !value.is_empty())
    .unwrap_or(file_stem);
    let cwd = [
        value_string(object.get("cwd")),
        value_string(object.get("projectPath")),
        value_string(object.get("directory")),
    ]
    .into_iter()
    .find(|value| !value.is_empty())
    .unwrap_or_default();
    let updated_ms = parse_timestamp_ms(
        object
            .get("timestamp")
            .or_else(|| object.get("updatedAt"))
            .or_else(|| object.get("createdAt"))
            .or_else(|| object.get("time")),
        modified_ms,
    );
    let model = [
        value_string(object.get("model")),
        value_string(object.get("model_id")),
        value_string(object.get("modelId")),
    ]
    .into_iter()
    .find(|value| !value.is_empty())
    .unwrap_or_else(|| "unknown".to_string());
    let provider = if provider == "unknown" {
        if model.to_lowercase().contains("claude") {
            "anthropic".to_string()
        } else if model.to_lowercase().contains("gemini") {
            "google-gemini".to_string()
        } else if model.to_lowercase().contains("gpt") || model.to_lowercase().contains("o3") {
            "openai".to_string()
        } else {
            "unknown".to_string()
        }
    } else {
        provider.to_string()
    };
    let project_key = Path::new(&cwd)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown")
        .to_string();
    let title = {
        let preview = session_preview(&object);
        if preview.is_empty() {
            session_id.clone()
        } else {
            preview
        }
    };
    Some(json!({
      "id": format!("{tool}:{session_id}"),
      "sessionId": session_id,
      "tool": tool,
      "title": title,
      "provider": provider,
      "model": model,
      "projectPath": cwd,
      "projectKey": project_key,
      "cwd": cwd,
      "updatedAt": ms_to_iso(updated_ms),
      "updatedAtMs": updated_ms,
      "sourcePath": path_string(file_path),
      "sourceLabel": label,
      "actions": { "resume": tool == "codex", "fork": tool == "codex", "delete": false },
    }))
}

fn session_source(
    tool: &str,
    label: &str,
    roots: Vec<PathBuf>,
    provider: &str,
    limit: usize,
) -> Value {
    let mut items = Vec::new();
    let mut existing = false;
    for root in &roots {
        if !path_exists(root) {
            continue;
        }
        existing = true;
        for file in collect_files(root, &[".jsonl", ".json"], limit.saturating_mul(3).max(20)) {
            if items.len() >= limit {
                break;
            }
            if let Some(item) = parse_session_file(&file, tool, provider, label) {
                items.push(item);
            }
        }
    }
    items.sort_by_key(|item| {
        std::cmp::Reverse(item.get("updatedAtMs").and_then(Value::as_u64).unwrap_or(0))
    });
    json!({
      "tool": tool,
      "label": label,
      "sourcePath": roots.iter().map(|path| path_string(path)).collect::<Vec<_>>().join(if cfg!(target_os = "windows") { ";" } else { ":" }),
      "exists": existing,
      "readError": "",
      "count": items.len(),
      "capabilities": { "browse": true, "search": true, "resume": tool == "codex", "fork": tool == "codex", "delete": false },
      "items": items,
    })
}

fn session_matches(item: &Value, query: &str, cwd: &str) -> bool {
    if !cwd.trim().is_empty() {
        let item_cwd = item.get("cwd").and_then(Value::as_str).unwrap_or("");
        if !item_cwd.starts_with(cwd) {
            return false;
        }
    }
    if query.trim().is_empty() {
        return true;
    }
    let needle = query.to_lowercase();
    [
        "id",
        "sessionId",
        "tool",
        "title",
        "provider",
        "model",
        "cwd",
        "projectKey",
        "projectPath",
        "sourcePath",
    ]
    .iter()
    .any(|key| {
        item.get(*key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase()
            .contains(&needle)
    })
}

fn group_sessions(items: &[Value]) -> Vec<Value> {
    let mut providers: BTreeMap<String, BTreeMap<String, (u64, u64, String, Map<String, Value>)>> =
        BTreeMap::new();
    for item in items {
        let provider = value_string(item.get("provider")).if_empty("unknown");
        let project_key = value_string(item.get("projectKey")).if_empty("unknown");
        let project_path = value_string(item.get("projectPath"));
        let updated = item.get("updatedAtMs").and_then(Value::as_u64).unwrap_or(0);
        let tool = value_string(item.get("tool"));
        let project = providers
            .entry(provider)
            .or_default()
            .entry(project_key)
            .or_insert_with(|| (0, 0, project_path, Map::new()));
        project.0 += 1;
        project.1 = project.1.max(updated);
        if !tool.is_empty() {
            let next = project.3.get(&tool).and_then(Value::as_u64).unwrap_or(0) + 1;
            project.3.insert(tool, json!(next));
        }
    }
    providers
        .into_iter()
        .map(|(provider, projects)| {
            let project_values = projects
                .into_iter()
                .map(|(project_key, (count, latest_ms, project_path, tools))| {
                    json!({
                      "projectKey": project_key,
                      "projectPath": project_path,
                      "count": count,
                      "latestAt": ms_to_iso(latest_ms),
                      "tools": tools,
                    })
                })
                .collect::<Vec<_>>();
            let count = project_values
                .iter()
                .map(|project| project.get("count").and_then(Value::as_u64).unwrap_or(0))
                .sum::<u64>();
            let latest_ms = project_values
                .iter()
                .filter_map(|project| {
                    chrono::DateTime::parse_from_rfc3339(
                        project
                            .get("latestAt")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                    )
                    .ok()
                })
                .map(|dt| dt.timestamp_millis().max(0) as u64)
                .max()
                .unwrap_or(0);
            json!({
              "provider": provider,
              "count": count,
              "latestAt": ms_to_iso(latest_ms),
              "projects": project_values,
            })
        })
        .collect()
}

trait IfEmpty {
    fn if_empty(self, fallback: &str) -> String;
}

impl IfEmpty for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

fn session_inventory(query: &Value) -> Value {
    let limit = query
        .get("limit")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<usize>().ok())
        .or_else(|| {
            query
                .get("limit")
                .and_then(Value::as_u64)
                .map(|value| value as usize)
        })
        .unwrap_or(100)
        .clamp(1, 500);
    let codex_home = codex_home_from_query(query);
    let home = fallback_home_dir();
    let opencode_data =
        opencode_data_home().unwrap_or_else(|_| home.join(".local").join("share").join("opencode"));
    let openclaw = openclaw_home().unwrap_or_else(|_| home.join(".openclaw"));
    let sources = vec![
        session_source(
            "codex",
            "Codex sessions",
            vec![codex_home.join("sessions")],
            "unknown",
            limit,
        ),
        session_source(
            "claudecode",
            "Claude Code projects",
            vec![home.join(".claude").join("projects")],
            "anthropic",
            limit,
        ),
        session_source(
            "opencode",
            "OpenCode sessions",
            vec![
                opencode_data.join("sessions"),
                opencode_data.join("history"),
            ],
            "unknown",
            limit,
        ),
        session_source(
            "gemini",
            "Gemini CLI sessions",
            vec![
                home.join(".gemini").join("sessions"),
                home.join(".gemini").join("history"),
            ],
            "google-gemini",
            limit,
        ),
        session_source(
            "openclaw",
            "OpenClaw sessions",
            vec![openclaw.join("sessions"), openclaw.join("history")],
            "unknown",
            limit,
        ),
        session_source(
            "hermes",
            "Hermes Agent sessions",
            vec![
                home.join(".hermes").join("sessions"),
                home.join(".hermes").join("history"),
            ],
            "unknown",
            limit,
        ),
    ];
    let query_text = value_string(query.get("query"));
    let cwd = query_path(query, "cwd")
        .map(|path| path_string(&path))
        .unwrap_or_default();
    let mut all_items = sources
        .iter()
        .flat_map(|source| {
            source
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .filter(|item| session_matches(item, &query_text, &cwd))
        .collect::<Vec<_>>();
    all_items.sort_by_key(|item| {
        std::cmp::Reverse(item.get("updatedAtMs").and_then(Value::as_u64).unwrap_or(0))
    });
    let items = all_items.iter().take(limit).cloned().collect::<Vec<_>>();
    let mut tools = Map::new();
    for source in &sources {
        if let Some(tool) = source.get("tool").and_then(Value::as_str) {
            tools.insert(
                tool.to_string(),
                source.get("count").cloned().unwrap_or(json!(0)),
            );
        }
    }
    json!({
        "schema": "easyaiconfig.session-inventory.v1",
        "generatedAt": now_iso(),
        "filters": { "query": query_text, "cwd": cwd },
        "sources": sources,
        "items": items,
        "groups": group_sessions(&all_items),
        "summary": {
          "sources": sources.len(),
          "existingSources": sources.iter().filter(|source| source.get("exists").and_then(Value::as_bool).unwrap_or(false)).count(),
          "readErrors": sources.iter().filter(|source| !source.get("readError").and_then(Value::as_str).unwrap_or("").is_empty()).count(),
          "sessions": all_items.len(),
          "returned": items.len(),
          "tools": tools,
        },
    })
}

fn normalize_session_tool(tool: &str) -> String {
    match tool.trim().to_lowercase().as_str() {
        "claude" | "claude-code" | "claude_code" => "claudecode".to_string(),
        "gemini-cli" | "geminicli" => "gemini".to_string(),
        "open-claw" | "open_claw" => "openclaw".to_string(),
        other => other.to_string(),
    }
}

fn absolute_path(path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn path_inside(child: &Path, parent: &Path) -> bool {
    child == parent || child.starts_with(parent)
}

fn canonical_or_absolute(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| absolute_path(path.to_path_buf()))
}

fn session_root_candidates(input: &Value, tool: &str) -> Vec<PathBuf> {
    let normalized = normalize_session_tool(tool);
    let home = fallback_home_dir();
    let codex_home = codex_home_from_query(input);
    let claude_home = query_path(input, "claudeHome").unwrap_or_else(|| home.join(".claude"));
    let gemini_home = query_path(input, "geminiHome").unwrap_or_else(|| home.join(".gemini"));
    let openclaw_home_path = query_path(input, "openClawHome")
        .or_else(|| query_path(input, "openclawHome"))
        .or_else(|| openclaw_home().ok())
        .unwrap_or_else(|| home.join(".openclaw"));
    let hermes_home = query_path(input, "hermesHome").unwrap_or_else(|| home.join(".hermes"));
    let mut roots = Vec::new();
    if normalized.is_empty() || normalized == "codex" {
        roots.push(codex_home.join("sessions"));
    }
    if normalized.is_empty() || normalized == "claudecode" {
        roots.push(claude_home.join("projects"));
    }
    if normalized.is_empty() || normalized == "gemini" {
        roots.push(gemini_home.join("sessions"));
        roots.push(gemini_home.join("history"));
    }
    if normalized.is_empty() || normalized == "openclaw" {
        roots.push(openclaw_home_path.join("sessions"));
        roots.push(openclaw_home_path.join("history"));
    }
    if normalized.is_empty() || normalized == "hermes" {
        roots.push(hermes_home.join("sessions"));
        roots.push(hermes_home.join("history"));
    }
    roots
        .into_iter()
        .map(|path| canonical_or_absolute(&path))
        .collect()
}

fn session_trash_root(input: &Value) -> PathBuf {
    query_path(input, "trashRoot").unwrap_or_else(|| {
        app_home()
            .unwrap_or_else(|_| fallback_home_dir().join(".codex-config-ui"))
            .join("session-trash")
    })
}

fn session_trash_index_path(root: &Path) -> PathBuf {
    root.join("index.json")
}

fn sha256_file(path: &Path) -> Result<(usize, String), String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok((bytes.len(), format!("{:x}", hasher.finalize())))
}

fn read_session_trash_entries(root: &Path) -> Result<Vec<Value>, String> {
    let index_path = session_trash_index_path(root);
    let raw = match read_optional_text(&index_path)? {
        Some(text) => text,
        None => return Ok(Vec::new()),
    };
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let parsed = serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string())?;
    Ok(parsed
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

fn write_session_trash_entries(root: &Path, entries: &[Value]) -> Result<Value, String> {
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let payload = json!({
      "schema": "easyaiconfig.session-trash.v1",
      "updatedAt": now_iso(),
      "entries": entries,
    });
    let text = serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?;
    fs::write(session_trash_index_path(root), format!("{text}\n"))
        .map_err(|error| error.to_string())?;
    Ok(payload)
}

fn validate_session_archive_target(
    body: &Value,
) -> Result<(String, PathBuf, fs::Metadata), String> {
    let tool = normalize_session_tool(body.get("tool").and_then(Value::as_str).unwrap_or(""));
    if !["codex", "claudecode", "gemini", "openclaw", "hermes"].contains(&tool.as_str()) {
        return Err(
      "Session archive only supports file-based Codex, Claude Code, Gemini, OpenClaw, and Hermes sessions"
        .to_string(),
    );
    }
    let raw_source = body
        .get("sourcePath")
        .or_else(|| body.get("filePath"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if raw_source.is_empty() {
        return Err("sourcePath is required".to_string());
    }
    let source_path = expand_home_path(raw_source).unwrap_or_else(|| PathBuf::from(raw_source));
    let canonical_source =
        fs::canonicalize(&source_path).map_err(|_| "Session file does not exist".to_string())?;
    let extension = canonical_source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    if extension != "jsonl" && extension != "json" {
        return Err("Session archive only supports .jsonl or .json files".to_string());
    }
    let roots = session_root_candidates(body, &tool);
    if !roots
        .iter()
        .any(|root| path_inside(&canonical_source, root))
    {
        return Err("Session file is outside known session roots".to_string());
    }
    let metadata = fs::metadata(&canonical_source).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Session file does not exist".to_string());
    }
    Ok((tool, canonical_source, metadata))
}

fn list_session_trash(query: &Value) -> Value {
    let root = absolute_path(session_trash_root(query));
    let index_path = session_trash_index_path(&root);
    let mut read_error = String::new();
    let entries = match read_session_trash_entries(&root) {
        Ok(entries) => entries,
        Err(error) => {
            read_error = error;
            Vec::new()
        }
    };
    let materialized = entries
        .into_iter()
        .map(|entry| {
            let exists = entry
                .get("archivePath")
                .and_then(Value::as_str)
                .map(|path| path_exists(&PathBuf::from(path)))
                .unwrap_or(false);
            let mut next = entry;
            if let Some(object) = next.as_object_mut() {
                object.insert("exists".to_string(), json!(exists));
            }
            next
        })
        .collect::<Vec<_>>();
    json!({
      "schema": "easyaiconfig.session-trash.v1",
      "generatedAt": now_iso(),
      "root": path_string(&root),
      "indexPath": path_string(&index_path),
      "readError": read_error,
      "entries": materialized,
      "summary": {
        "entries": materialized.len(),
        "restorable": materialized.iter().filter(|entry| entry.get("exists").and_then(Value::as_bool).unwrap_or(false) && entry.get("restoredAt").and_then(Value::as_str).unwrap_or("").is_empty()).count(),
        "restored": materialized.iter().filter(|entry| !entry.get("restoredAt").and_then(Value::as_str).unwrap_or("").is_empty()).count(),
        "missingArchives": materialized.iter().filter(|entry| !entry.get("exists").and_then(Value::as_bool).unwrap_or(false)).count(),
      },
    })
}

fn archive_session(body: &Value) -> Result<Value, String> {
    let dry_run = body.get("dryRun").and_then(Value::as_bool).unwrap_or(true);
    let (tool, source_path, metadata) = validate_session_archive_target(body)?;
    let root = absolute_path(session_trash_root(body));
    let archive_id = body
        .get("archiveId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!(
                "{}-{}",
                system_time_ms(SystemTime::now()),
                sha256_hex(&format!("{}{}", path_string(&source_path), now_iso()))
                    .chars()
                    .take(12)
                    .collect::<String>()
            )
        });
    let archive_dir = root.join("files").join(&archive_id);
    let archive_path = archive_dir.join(
        source_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("session.jsonl"),
    );
    let (bytes, sha256) = sha256_file(&source_path)?;
    let session_id = body
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            source_path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("session")
                .to_string()
        });
    let entry = json!({
      "id": archive_id,
      "tool": tool,
      "sessionId": session_id,
      "title": body.get("title").and_then(Value::as_str).unwrap_or(""),
      "sourceLabel": body.get("sourceLabel").and_then(Value::as_str).unwrap_or(""),
      "originalPath": path_string(&source_path),
      "archivePath": path_string(&archive_path),
      "archivedAt": now_iso(),
      "reason": body.get("reason").and_then(Value::as_str).unwrap_or(""),
      "bytes": bytes,
      "sha256": sha256,
      "mtimeMs": system_time_ms(metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH)),
    });
    let operation = json!({
      "action": "archive-session",
      "dryRun": dry_run,
      "previewOnly": dry_run,
      "tool": entry.get("tool").cloned().unwrap_or(json!("")),
      "sessionId": entry.get("sessionId").cloned().unwrap_or(json!("")),
      "sourcePath": path_string(&source_path),
      "archivePath": path_string(&archive_path),
      "bytes": bytes,
      "sha256": sha256,
    });
    if !dry_run {
        let mut entries = read_session_trash_entries(&root)?;
        fs::create_dir_all(&archive_dir).map_err(|error| error.to_string())?;
        fs::copy(&source_path, &archive_path).map_err(|error| error.to_string())?;
        fs::remove_file(&source_path).map_err(|error| error.to_string())?;
        entries.push(entry.clone());
        write_session_trash_entries(&root, &entries)?;
    }
    Ok(json!({
      "schema": "easyaiconfig.session-archive.v1",
      "dryRun": dry_run,
      "changed": !dry_run,
      "trashRoot": path_string(&root),
      "entry": entry,
      "operations": [operation],
      "summary": {
        "archived": if dry_run { 0 } else { 1 },
        "previewed": if dry_run { 1 } else { 0 },
        "bytes": bytes,
      },
    }))
}

fn restore_session(body: &Value) -> Result<Value, String> {
    let dry_run = body.get("dryRun").and_then(Value::as_bool).unwrap_or(true);
    let archive_id = body
        .get("archiveId")
        .or_else(|| body.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if archive_id.is_empty() {
        return Err("archiveId is required".to_string());
    }
    let root = absolute_path(session_trash_root(body));
    let canonical_root = canonical_or_absolute(&root);
    let mut entries = read_session_trash_entries(&root)?;
    let Some(index) = entries
        .iter()
        .position(|entry| entry.get("id").and_then(Value::as_str) == Some(archive_id))
    else {
        return Err("Archived session not found".to_string());
    };
    let entry = entries[index].clone();
    let archive_path_raw = entry
        .get("archivePath")
        .and_then(Value::as_str)
        .unwrap_or("");
    let archive_path = fs::canonicalize(archive_path_raw)
        .map_err(|_| "Archived session file is missing".to_string())?;
    if !path_inside(&archive_path, &canonical_root) {
        return Err("Archived session path is outside trash root".to_string());
    }
    let raw_target = body
        .get("targetPath")
        .and_then(Value::as_str)
        .or_else(|| entry.get("originalPath").and_then(Value::as_str))
        .unwrap_or("")
        .trim();
    if raw_target.is_empty() {
        return Err("Restore target path is required".to_string());
    }
    let target_path =
        absolute_path(expand_home_path(raw_target).unwrap_or_else(|| PathBuf::from(raw_target)));
    let tool = normalize_session_tool(
        body.get("tool")
            .and_then(Value::as_str)
            .or_else(|| entry.get("tool").and_then(Value::as_str))
            .unwrap_or(""),
    );
    let roots = session_root_candidates(body, &tool);
    let target_parent = target_path
        .parent()
        .map(canonical_or_absolute)
        .unwrap_or_else(|| target_path.clone());
    if !roots
        .iter()
        .any(|root| path_inside(&target_parent, root) || path_inside(&target_path, root))
    {
        return Err("Restore target is outside known session roots".to_string());
    }
    let overwrite = body
        .get("overwrite")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if path_exists(&target_path) && !overwrite {
        return Ok(json!({
          "schema": "easyaiconfig.session-restore.v1",
          "dryRun": dry_run,
          "changed": false,
          "trashRoot": path_string(&root),
          "entry": entry,
          "operations": [{
            "action": "restore-session",
            "status": "conflict",
            "reason": "target_exists",
            "archivePath": path_string(&archive_path),
            "targetPath": path_string(&target_path),
          }],
          "summary": { "restored": 0, "conflicts": 1, "previewed": 0 },
        }));
    }
    if !dry_run {
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::copy(&archive_path, &target_path).map_err(|error| error.to_string())?;
        if let Some(object) = entries[index].as_object_mut() {
            object.insert("restoredAt".to_string(), json!(now_iso()));
            object.insert("restoredPath".to_string(), json!(path_string(&target_path)));
        }
        write_session_trash_entries(&root, &entries)?;
    }
    Ok(json!({
      "schema": "easyaiconfig.session-restore.v1",
      "dryRun": dry_run,
      "changed": !dry_run,
      "trashRoot": path_string(&root),
      "entry": if dry_run { entry } else { entries[index].clone() },
      "operations": [{
        "action": "restore-session",
        "status": if dry_run { "preview" } else { "restored" },
        "archivePath": path_string(&archive_path),
        "targetPath": path_string(&target_path),
        "overwrite": overwrite,
      }],
      "summary": {
        "restored": if dry_run { 0 } else { 1 },
        "conflicts": 0,
        "previewed": if dry_run { 1 } else { 0 },
      },
    }))
}

fn usage_inventory(query: &Value) -> Value {
    let limit = query
        .get("limit")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<u64>().ok())
        .or_else(|| query.get("limit").and_then(Value::as_u64))
        .unwrap_or(100)
        .clamp(1, 500);
    let status =
        query_provider_router_status(&json!({ "limit": limit })).unwrap_or_else(|_| json!({}));
    let logs = status
        .get("logs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let total_tokens = status
        .get("totalTokens")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| {
            logs.iter()
                .map(|item| item.get("totalTokens").and_then(Value::as_u64).unwrap_or(0))
                .sum()
        });
    let requests = status
        .get("requests")
        .and_then(Value::as_u64)
        .unwrap_or(logs.len() as u64);
    let custom_prices_path = app_home()
        .unwrap_or_else(|_| fallback_home_dir().join(".codex-config-ui"))
        .join("custom-prices.json");
    let custom_prices = read_optional_text(&custom_prices_path)
    .ok()
    .flatten()
    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    .map(|parsed| json!({
      "schema": parsed.get("schema").and_then(Value::as_str).unwrap_or("easyaiconfig.custom-prices.v1"),
      "priceBookPath": path_string(&custom_prices_path),
      "models": parsed.get("models").and_then(Value::as_array).map(|items| items.len()).unwrap_or(0),
      "updatedAt": parsed.get("updatedAt").and_then(Value::as_str).unwrap_or(""),
    }));
    json!({
      "schema": "easyaiconfig.usage-inventory.v1",
      "generatedAt": now_iso(),
      "days": query.get("days").cloned().unwrap_or(json!(30)),
      "sources": [{
        "tool": "provider-router",
        "ok": true,
        "sourcePath": "provider_router_logs.db",
        "totals": {
          "input": status.get("inputTokens").and_then(Value::as_u64).unwrap_or(0),
          "cachedInput": status.get("cachedInputTokens").and_then(Value::as_u64).unwrap_or(0),
          "output": status.get("outputTokens").and_then(Value::as_u64).unwrap_or(0),
          "reasoning": 0,
          "cacheRead": 0,
          "cacheCreation": 0,
          "total": total_tokens,
          "cost": 0,
          "officialCost": 0,
          "requests": requests,
        },
        "requestLogs": logs,
      }],
      "totals": {
        "input": status.get("inputTokens").and_then(Value::as_u64).unwrap_or(0),
        "cachedInput": status.get("cachedInputTokens").and_then(Value::as_u64).unwrap_or(0),
        "output": status.get("outputTokens").and_then(Value::as_u64).unwrap_or(0),
        "reasoning": 0,
        "cacheRead": 0,
        "cacheCreation": 0,
        "total": total_tokens,
        "cost": 0,
        "officialCost": 0,
        "requests": requests,
      },
      "daily": [],
      "providers": status.get("providers").cloned().unwrap_or_else(|| json!([])),
      "models": [],
      "requestLogs": logs,
      "customPrices": custom_prices,
      "summary": {
        "totalTokens": total_tokens,
        "requests": requests,
        "totalCost": 0,
        "cost": 0,
        "officialCost": 0,
        "requestLogs": logs.len(),
        "customPrices": custom_prices.as_ref().and_then(|value| value.get("models")).and_then(Value::as_u64).unwrap_or(0),
        "readErrors": 0,
      },
    })
}

fn asset_bundle_from_catalog(provider_catalog: Value, include_local: bool, query: &Value) -> Value {
    let mut assets = Map::new();
    assets.insert("providerCatalog".to_string(), provider_catalog);
    if include_local {
        assets.insert("mcpInventory".to_string(), mcp_inventory(query));
        assets.insert("promptInventory".to_string(), prompt_inventory(query));
        assets.insert("skillInventory".to_string(), skill_inventory(query));
        assets.insert("sessionInventory".to_string(), session_inventory(query));
    }
    json!({
      "schema": "easyaiconfig.asset-bundle.v1",
      "app": "EasyAIConfig",
      "version": 1,
      "exportedAt": now_iso(),
      "assets": assets,
    })
}

fn query_bool(query: &Value, key: &str) -> bool {
    match query.get(key) {
        Some(Value::Bool(value)) => *value,
        Some(Value::String(value)) => {
            matches!(value.trim().to_lowercase().as_str(), "1" | "true" | "yes")
        }
        Some(Value::Number(value)) => value.as_i64().unwrap_or(0) != 0,
        _ => false,
    }
}

fn asset_index(query: &Value) -> Result<Value, String> {
    let state = load_state(query)?;
    Ok(json!({
      "schema": "easyaiconfig.asset-index.v1",
      "generatedAt": now_iso(),
      "providerCatalog": asset_provider_catalog_from_state(&state),
      "mcpInventory": mcp_inventory(query),
      "promptInventory": prompt_inventory(query),
      "skillInventory": skill_inventory(query),
      "sessionInventory": session_inventory(query),
      "usageInventory": if query_bool(query, "usage") { usage_inventory(query) } else { Value::Null },
    }))
}

fn asset_export(query: &Value) -> Result<Value, String> {
    let state = load_state(query)?;
    Ok(asset_bundle_from_catalog(
        asset_provider_catalog_from_state(&state),
        query_bool(query, "local"),
        query,
    ))
}

fn b64url_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    let mut index = 0;
    while index < bytes.len() {
        let b0 = bytes[index] as u32;
        let b1 = bytes.get(index + 1).copied().unwrap_or(0) as u32;
        let b2 = bytes.get(index + 2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3f) as usize] as char);
        if index + 1 < bytes.len() {
            out.push(TABLE[((triple >> 6) & 0x3f) as usize] as char);
        }
        if index + 2 < bytes.len() {
            out.push(TABLE[(triple & 0x3f) as usize] as char);
        }
        index += 3;
    }
    out
}

fn b64url_value(ch: char) -> Option<u8> {
    match ch {
        'A'..='Z' => Some((ch as u8) - b'A'),
        'a'..='z' => Some((ch as u8) - b'a' + 26),
        '0'..='9' => Some((ch as u8) - b'0' + 52),
        '-' | '+' => Some(62),
        '_' | '/' => Some(63),
        _ => None,
    }
}

fn b64url_decode(input: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for ch in input.trim().chars() {
        if ch == '=' {
            break;
        }
        let value = b64url_value(ch)
            .ok_or_else(|| "Deep Link payload 不是有效 base64url".to_string())?
            as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

fn asset_deep_link_build(body: &Value) -> Result<Value, String> {
    let payload = match body.get("payload") {
        Some(value) if !value.is_null() => value.clone(),
        _ => {
            let state = load_state(&json!({}))?;
            asset_bundle_from_catalog(asset_provider_catalog_from_state(&state), false, &json!({}))
        }
    };
    let bytes = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
    Ok(json!({ "url": format!("easyai://import?payload={}", b64url_encode(&bytes)) }))
}

fn query_param(params: &BTreeMap<String, String>, names: &[&str]) -> String {
    for name in names {
        if let Some(value) = params.get(*name) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

fn query_json_object(
    params: &BTreeMap<String, String>,
    names: &[&str],
) -> Option<Map<String, Value>> {
    let raw = query_param(params, names);
    if raw.is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(&raw).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

fn parse_query_string_list(value: &str) -> Vec<Value> {
    let raw = value.trim();
    if raw.is_empty() {
        return Vec::new();
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
        if let Some(items) = parsed.as_array() {
            return items
                .iter()
                .filter_map(|item| item.as_str().map(str::trim))
                .filter(|item| !item.is_empty())
                .map(|item| Value::String(item.to_string()))
                .collect();
        }
        if let Some(item) = parsed.as_str() {
            return parse_query_string_list(item);
        }
    }
    let parts: Vec<String> = if raw.contains(',') || raw.contains('\n') {
        raw.split(|ch| ch == ',' || ch == '\n')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect()
    } else {
        raw.split_whitespace()
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect()
    };
    parts.into_iter().map(Value::String).collect()
}

fn parse_query_object(value: &str) -> Option<Map<String, Value>> {
    let raw = value.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(raw) {
        return Some(map);
    }
    let mut map = Map::new();
    for part in raw.split(|ch| ch == ',' || ch == '\n') {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some((key, value)) = trimmed.split_once('=') {
            let key = key.trim();
            if !key.is_empty() {
                map.insert(key.to_string(), Value::String(value.trim().to_string()));
            }
        }
    }
    if map.is_empty() {
        None
    } else {
        Some(map)
    }
}

fn query_param_bool(params: &BTreeMap<String, String>, names: &[&str]) -> Option<bool> {
    match query_param(params, names).to_lowercase().as_str() {
        "1" | "true" | "yes" | "on" | "enabled" => Some(true),
        "0" | "false" | "no" | "off" | "disabled" => Some(false),
        _ => None,
    }
}

fn insert_string_if_present(map: &mut Map<String, Value>, key: &str, value: String) {
    if !value.trim().is_empty() {
        map.insert(key.to_string(), Value::String(value.trim().to_string()));
    }
}

fn insert_array_if_present(map: &mut Map<String, Value>, key: &str, value: Vec<Value>) {
    if !value.is_empty() {
        map.insert(key.to_string(), Value::Array(value));
    }
}

fn insert_object_if_present(
    map: &mut Map<String, Value>,
    key: &str,
    value: Option<Map<String, Value>>,
) {
    if let Some(value) = value {
        if !value.is_empty() {
            map.insert(key.to_string(), Value::Object(value));
        }
    }
}

fn insert_bool_if_present(map: &mut Map<String, Value>, key: &str, value: Option<bool>) {
    if let Some(value) = value {
        map.insert(key.to_string(), Value::Bool(value));
    }
}

fn normalize_ccswitch_v1_resource(value: &str) -> String {
    let normalized = value
        .trim()
        .to_lowercase()
        .replace('_', "-")
        .replace(' ', "-");
    match normalized.as_str() {
        "provider" | "providers" | "model-provider" | "model-providers" => "provider".to_string(),
        "mcp" | "mcp-server" | "mcp-servers" | "server" | "servers" => "mcp".to_string(),
        "prompt" | "prompts" | "instruction" | "instructions" => "prompt".to_string(),
        "skill" | "skills" => "skill".to_string(),
        _ => normalized,
    }
}

fn is_ccswitch_v1_import_url(parsed: &url::Url) -> bool {
    if parsed.scheme() != "ccswitch" {
        return false;
    }
    let params: BTreeMap<String, String> = parsed
        .query_pairs()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
    if query_param(&params, &["resource", "type", "kind"]).is_empty() {
        return false;
    }
    let host = parsed.host_str().unwrap_or_default().to_lowercase();
    let path = parsed.path().trim_matches('/').to_lowercase();
    (host == "v1" && path == "import") || host == "import" || path == "v1/import"
}

fn ccswitch_provider_from_params(params: &BTreeMap<String, String>) -> Value {
    let mut item =
        query_json_object(params, &["provider", "item", "asset", "config"]).unwrap_or_default();
    insert_string_if_present(
        &mut item,
        "id",
        query_param(params, &["id", "key", "providerKey", "name"]),
    );
    insert_string_if_present(
        &mut item,
        "key",
        query_param(params, &["key", "providerKey"]),
    );
    insert_string_if_present(
        &mut item,
        "name",
        query_param(params, &["name", "label", "title"]),
    );
    insert_string_if_present(
        &mut item,
        "baseUrl",
        query_param(
            params,
            &["baseUrl", "base_url", "baseURL", "url", "endpoint"],
        ),
    );
    insert_string_if_present(&mut item, "endpoint", query_param(params, &["endpoint"]));
    insert_string_if_present(
        &mut item,
        "envKey",
        query_param(params, &["envKey", "env_key", "apiKeyEnv", "api_key_env"]),
    );
    insert_string_if_present(
        &mut item,
        "apiKeyEnv",
        query_param(params, &["apiKeyEnv", "api_key_env", "envKey", "env_key"]),
    );
    insert_string_if_present(
        &mut item,
        "apiKey",
        query_param(params, &["apiKey", "api_key"]),
    );
    insert_string_if_present(
        &mut item,
        "wireApi",
        query_param(params, &["wireApi", "wire_api", "api", "protocol"]),
    );
    insert_array_if_present(
        &mut item,
        "protocols",
        parse_query_string_list(&query_param(params, &["protocols", "protocolList"])),
    );
    insert_string_if_present(
        &mut item,
        "homepage",
        query_param(params, &["homepage", "homePage", "docsUrl", "docs_url"]),
    );
    insert_string_if_present(
        &mut item,
        "model",
        query_param(params, &["model", "defaultModel", "default_model"]),
    );
    insert_array_if_present(
        &mut item,
        "models",
        parse_query_string_list(&query_param(params, &["models"])),
    );
    insert_object_if_present(
        &mut item,
        "config",
        parse_query_object(&query_param(params, &["config"])),
    );
    insert_string_if_present(
        &mut item,
        "configFormat",
        query_param(params, &["configFormat", "config_format"]),
    );
    insert_string_if_present(
        &mut item,
        "configUrl",
        query_param(params, &["configUrl", "config_url"]),
    );
    insert_string_if_present(
        &mut item,
        "usageScript",
        query_param(params, &["usageScript", "usage_script"]),
    );
    insert_array_if_present(
        &mut item,
        "tools",
        parse_query_string_list(&query_param(
            params,
            &["tools", "tool", "targetTools", "targets", "clients"],
        )),
    );
    Value::Object(item)
}

fn ccswitch_mcp_from_params(params: &BTreeMap<String, String>) -> Value {
    let mut item = query_json_object(params, &["server", "mcp", "item", "asset", "config"])
        .unwrap_or_default();
    insert_string_if_present(
        &mut item,
        "id",
        query_param(params, &["id", "serverId", "server_id", "name"]),
    );
    insert_string_if_present(&mut item, "name", query_param(params, &["name", "label"]));
    insert_string_if_present(
        &mut item,
        "command",
        query_param(params, &["command", "cmd"]),
    );
    insert_array_if_present(
        &mut item,
        "args",
        parse_query_string_list(&query_param(params, &["args", "arguments", "argv"])),
    );
    insert_object_if_present(
        &mut item,
        "env",
        parse_query_object(&query_param(params, &["env", "environment"])),
    );
    insert_string_if_present(
        &mut item,
        "transport",
        query_param(params, &["transport", "type"]),
    );
    insert_string_if_present(&mut item, "url", query_param(params, &["url", "endpoint"]));
    insert_array_if_present(
        &mut item,
        "apps",
        parse_query_string_list(&query_param(params, &["apps", "app", "clients"])),
    );
    insert_object_if_present(
        &mut item,
        "config",
        parse_query_object(&query_param(params, &["config"])),
    );
    insert_bool_if_present(&mut item, "enabled", query_param_bool(params, &["enabled"]));
    insert_array_if_present(
        &mut item,
        "tools",
        parse_query_string_list(&query_param(
            params,
            &["tools", "tool", "targetTools", "targets", "clients"],
        )),
    );
    Value::Object(item)
}

fn ccswitch_prompt_from_params(params: &BTreeMap<String, String>) -> Value {
    let mut item =
        query_json_object(params, &["promptAsset", "item", "asset", "config"]).unwrap_or_default();
    insert_string_if_present(
        &mut item,
        "id",
        query_param(
            params,
            &[
                "id",
                "promptId",
                "prompt_id",
                "tool",
                "fileName",
                "filename",
                "name",
            ],
        ),
    );
    insert_string_if_present(
        &mut item,
        "promptId",
        query_param(params, &["promptId", "prompt_id"]),
    );
    insert_string_if_present(
        &mut item,
        "tool",
        query_param(params, &["tool", "targetTool"]),
    );
    insert_string_if_present(
        &mut item,
        "fileName",
        query_param(params, &["fileName", "filename", "path"]),
    );
    insert_string_if_present(&mut item, "scope", query_param(params, &["scope"]));
    insert_string_if_present(&mut item, "title", query_param(params, &["title", "name"]));
    insert_string_if_present(
        &mut item,
        "description",
        query_param(params, &["description", "desc"]),
    );
    insert_string_if_present(
        &mut item,
        "content",
        query_param(params, &["content", "text", "body", "prompt", "markdown"]),
    );
    insert_bool_if_present(&mut item, "enabled", query_param_bool(params, &["enabled"]));
    insert_array_if_present(
        &mut item,
        "tools",
        parse_query_string_list(&query_param(
            params,
            &["tools", "tool", "targetTools", "targets", "clients"],
        )),
    );
    Value::Object(item)
}

fn ccswitch_skill_from_params(params: &BTreeMap<String, String>) -> Value {
    let mut item =
        query_json_object(params, &["skillAsset", "item", "asset", "config"]).unwrap_or_default();
    insert_string_if_present(
        &mut item,
        "id",
        query_param(params, &["id", "slug", "name", "title"]),
    );
    insert_string_if_present(
        &mut item,
        "name",
        query_param(params, &["name", "slug", "id"]),
    );
    insert_string_if_present(&mut item, "title", query_param(params, &["title", "name"]));
    insert_string_if_present(
        &mut item,
        "content",
        query_param(
            params,
            &["content", "text", "markdown", "skillMd", "skillMD"],
        ),
    );
    insert_string_if_present(
        &mut item,
        "skillMd",
        query_param(params, &["skillMd", "skillMD"]),
    );
    insert_string_if_present(
        &mut item,
        "installMode",
        query_param(params, &["installMode", "install_mode", "mode"]),
    );
    insert_string_if_present(
        &mut item,
        "repositoryUrl",
        query_param(
            params,
            &["repositoryUrl", "repoUrl", "repo", "github", "repository"],
        ),
    );
    insert_string_if_present(
        &mut item,
        "repoUrl",
        query_param(params, &["repoUrl", "repo", "repositoryUrl"]),
    );
    insert_string_if_present(
        &mut item,
        "repository",
        query_param(params, &["repository", "repo", "repositoryUrl"]),
    );
    insert_string_if_present(
        &mut item,
        "directory",
        query_param(params, &["directory", "dir", "subdirectory", "subdir"]),
    );
    insert_string_if_present(&mut item, "branch", query_param(params, &["branch", "ref"]));
    insert_string_if_present(
        &mut item,
        "zipUrl",
        query_param(params, &["zipUrl", "archiveUrl"]),
    );
    insert_string_if_present(&mut item, "url", query_param(params, &["url"]));
    insert_array_if_present(
        &mut item,
        "tools",
        parse_query_string_list(&query_param(
            params,
            &["tools", "tool", "targetTools", "targets", "clients"],
        )),
    );
    Value::Object(item)
}

fn asset_bundle_from_ccswitch_v1_url(parsed: &url::Url) -> Result<Value, String> {
    let params: BTreeMap<String, String> = parsed
        .query_pairs()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
    let resource =
        normalize_ccswitch_v1_resource(&query_param(&params, &["resource", "type", "kind"]));
    let mut assets = Map::new();
    match resource.as_str() {
        "provider" => {
            assets.insert(
                "providers".to_string(),
                Value::Array(vec![ccswitch_provider_from_params(&params)]),
            );
        }
        "mcp" => {
            assets.insert(
                "mcpServers".to_string(),
                Value::Array(vec![ccswitch_mcp_from_params(&params)]),
            );
        }
        "prompt" => {
            assets.insert(
                "prompts".to_string(),
                Value::Array(vec![ccswitch_prompt_from_params(&params)]),
            );
        }
        "skill" => {
            assets.insert(
                "skills".to_string(),
                Value::Array(vec![ccswitch_skill_from_params(&params)]),
            );
        }
        _ => return Err("Unsupported cc-switch V1 Deep Link resource".to_string()),
    }
    Ok(json!({
      "schema": "easyaiconfig.asset-bundle.v1",
      "app": "cc-switch",
      "source": "ccswitch-deeplink-v1",
      "version": 1,
      "importedAt": chrono::Utc::now().to_rfc3339(),
      "assets": Value::Object(assets),
    }))
}

fn parse_asset_import_payload(input: &Value) -> Result<Value, String> {
    if let Some(payload) = input.get("payload") {
        if payload.is_object() {
            return Ok(payload.clone());
        }
    }
    let raw = input
        .get("url")
        .and_then(Value::as_str)
        .or_else(|| input.get("text").and_then(Value::as_str))
        .unwrap_or_default()
        .trim();
    if raw.is_empty() {
        return Err("Import payload is required".to_string());
    }
    if raw.starts_with("easyai://")
        || raw.starts_with("easyaiconfig://")
        || raw.starts_with("ccswitch://")
    {
        let parsed =
            url::Url::parse(raw).map_err(|error| format!("Deep Link 解析失败：{error}"))?;
        if is_ccswitch_v1_import_url(&parsed) {
            return asset_bundle_from_ccswitch_v1_url(&parsed);
        }
        for (key, value) in parsed.query_pairs() {
            if key == "payload" {
                let decoded = b64url_decode(&value)?;
                return serde_json::from_slice::<Value>(&decoded)
                    .map_err(|error| format!("Deep Link payload JSON 解析失败：{error}"));
            }
            if key == "data" {
                return serde_json::from_str::<Value>(&value)
                    .map_err(|error| format!("Deep Link data JSON 解析失败：{error}"));
            }
        }
        return Err("Deep Link is missing payload".to_string());
    }
    serde_json::from_str::<Value>(raw).map_err(|error| format!("Import JSON 解析失败：{error}"))
}

fn count_array(value: Option<&Value>) -> usize {
    value
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0)
}

fn count_array_or_object(value: Option<&Value>) -> usize {
    if let Some(array) = value.and_then(Value::as_array) {
        return array.len();
    }
    value
        .and_then(Value::as_object)
        .map(|items| items.len())
        .unwrap_or(0)
}

fn asset_import_preview(body: &Value) -> Result<Value, String> {
    let payload = parse_asset_import_payload(body)?;
    let assets = payload
        .get("assets")
        .filter(|value| value.is_object())
        .unwrap_or(&payload);
    let provider_catalog = assets
        .get("providerCatalog")
        .or_else(|| payload.get("providerCatalog"));
    let providers = assets
        .get("providers")
        .or_else(|| payload.get("providers"))
        .or_else(|| provider_catalog.and_then(|catalog| catalog.get("presets")));
    let mcp_servers = assets
        .get("mcpServers")
        .or_else(|| payload.get("mcpServers"));
    let prompts = assets.get("prompts").or_else(|| payload.get("prompts"));
    let skills = assets.get("skills").or_else(|| payload.get("skills"));
    let sessions = assets.get("sessions").or_else(|| payload.get("sessions"));

    Ok(json!({
      "schema": payload.get("schema").and_then(Value::as_str).unwrap_or("unknown"),
      "app": payload
        .get("app")
        .and_then(Value::as_str)
        .or_else(|| payload.get("source").and_then(Value::as_str))
        .unwrap_or_default(),
      "version": payload.get("version").cloned().unwrap_or(Value::String(String::new())),
      "counts": {
        "providers": count_array(providers),
        "mcpServers": count_array_or_object(mcp_servers),
        "prompts": count_array(prompts),
        "skills": count_array(skills),
        "sessions": count_array(sessions),
      },
      "warnings": ["Tauri desktop asset import write-back is not enabled yet; this endpoint currently previews payloads and returns no-write plans."],
      "payload": payload,
    }))
}

fn asset_import_apply(body: &Value) -> Result<Value, String> {
    let preview = asset_import_preview(body)?;
    let counts = preview.get("counts").cloned().unwrap_or_else(|| json!({}));
    let target_tool = body
        .get("targetTool")
        .and_then(Value::as_str)
        .unwrap_or("all");
    let dry_run = body.get("dryRun").and_then(Value::as_bool).unwrap_or(true);
    Ok(json!({
      "schema": "easyaiconfig.asset-import-apply.v2",
      "dryRun": dry_run,
      "targetTool": target_tool,
      "source": {
        "schema": preview.get("schema").cloned().unwrap_or(Value::String("unknown".to_string())),
        "app": preview.get("app").cloned().unwrap_or(Value::String(String::new())),
        "version": preview.get("version").cloned().unwrap_or(Value::String(String::new())),
      },
      "counts": counts,
      "summary": {
        "totalProviders": preview.get("counts").and_then(|value| value.get("providers")).and_then(Value::as_u64).unwrap_or(0),
        "totalMcpServers": preview.get("counts").and_then(|value| value.get("mcpServers")).and_then(Value::as_u64).unwrap_or(0),
        "totalPrompts": preview.get("counts").and_then(|value| value.get("prompts")).and_then(Value::as_u64).unwrap_or(0),
        "totalSkills": preview.get("counts").and_then(|value| value.get("skills")).and_then(Value::as_u64).unwrap_or(0),
        "created": 0,
        "updated": 0,
        "appended": 0,
        "unchanged": 0,
        "conflicts": 0,
        "stale": 0,
        "skipped": 0,
        "changed": false,
        "written": false,
      },
      "results": {},
      "operations": [{
        "category": "desktop",
        "action": if dry_run { "preview" } else { "write-blocked" },
        "status": "skipped",
        "message": "Tauri desktop asset import write-back is not enabled yet; no local config was changed.",
      }],
      "backupPaths": { "providers": null, "mcp": null, "prompts": null, "skills": null },
      "backupPath": null,
      "paths": {},
    }))
}

fn server_fingerprint(server: &Value) -> String {
    json!({
      "command": server.get("command").cloned().unwrap_or(json!("")),
      "args": server.get("args").cloned().unwrap_or_else(|| json!([])),
      "envKeys": server.get("envKeys").cloned().unwrap_or_else(|| json!([])),
      "transport": server.get("transport").cloned().unwrap_or(json!("")),
      "url": server.get("url").cloned().unwrap_or(json!("")),
      "disabled": server.get("disabled").cloned().unwrap_or(json!(false)),
    })
    .to_string()
}

fn public_mcp_server(server: &Value) -> Value {
    json!({
      "id": server.get("id").cloned().unwrap_or(json!("")),
      "tool": server.get("tool").cloned().unwrap_or(json!("")),
      "field": server.get("field").cloned().unwrap_or(json!("")),
      "sourcePath": server.get("sourcePath").cloned().unwrap_or(json!("")),
      "sourceLabel": server.get("sourceLabel").cloned().unwrap_or(json!("")),
      "command": server.get("command").cloned().unwrap_or(json!("")),
      "transport": server.get("transport").cloned().unwrap_or(json!("")),
      "url": server.get("url").cloned().unwrap_or(json!("")),
      "envKeys": server.get("envKeys").cloned().unwrap_or_else(|| json!([])),
      "disabled": server.get("disabled").cloned().unwrap_or(json!(false)),
    })
}

fn mcp_target_field(tool: &str) -> &'static str {
    match tool {
        "codex" => "mcp_servers",
        "opencode" => "mcp",
        _ => "mcpServers",
    }
}

fn mcp_sync_plan(query: &Value) -> Value {
    let inventory = mcp_inventory(query);
    let servers = inventory
        .get("servers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let target_sources = inventory
        .get("sources")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|source| {
            source
                .get("parseError")
                .and_then(Value::as_str)
                .unwrap_or("")
                .is_empty()
                && source
                    .get("readError")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .is_empty()
        })
        .collect::<Vec<_>>();
    let mut by_id: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for server in servers {
        let id = value_string(server.get("id"));
        if id.is_empty() {
            continue;
        }
        by_id.entry(id).or_default().push(server);
    }
    let mut operations = Vec::new();
    let mut conflicts = Vec::new();
    for (server_id, variants) in &by_id {
        let mut fingerprints: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for server in variants {
            fingerprints
                .entry(server_fingerprint(server))
                .or_default()
                .push(public_mcp_server(server));
        }
        if fingerprints.len() > 1 {
            conflicts.push(json!({
              "serverId": server_id,
              "variants": fingerprints.into_iter().map(|(fingerprint, sources)| json!({
                "fingerprint": fingerprint,
                "sources": sources,
              })).collect::<Vec<_>>(),
            }));
            continue;
        }
        let Some(source_server) = variants.first() else {
            continue;
        };
        let present_tools = variants
            .iter()
            .filter_map(|server| {
                server
                    .get("tool")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect::<Vec<_>>();
        for target in &target_sources {
            let target_tool = value_string(target.get("tool"));
            if target_tool.is_empty() || present_tools.iter().any(|tool| tool == &target_tool) {
                continue;
            }
            operations.push(json!({
              "type": "copy-mcp-server",
              "serverId": server_id,
              "from": public_mcp_server(source_server),
              "to": {
                "tool": target_tool,
                "field": mcp_target_field(target.get("tool").and_then(Value::as_str).unwrap_or("")),
                "sourcePath": target.get("sourcePath").cloned().unwrap_or(json!("")),
                "sourceLabel": target.get("label").cloned().unwrap_or(json!("")),
                "exists": target.get("exists").cloned().unwrap_or(json!(false)),
                "requiresCreate": !target.get("exists").and_then(Value::as_bool).unwrap_or(false),
              },
              "previewOnly": true,
            }));
        }
    }
    json!({
      "schema": "easyaiconfig.mcp-sync-plan.v1",
      "generatedAt": now_iso(),
      "inventory": inventory,
      "operations": operations,
      "conflicts": conflicts,
      "summary": {
        "servers": by_id.len(),
        "operations": operations.len(),
        "conflicts": conflicts.len(),
        "targets": target_sources.len(),
        "skippedSources": inventory.get("sources").and_then(Value::as_array).map(|sources| sources.len().saturating_sub(target_sources.len())).unwrap_or(0),
      },
    })
}

fn sync_targets_config_path() -> PathBuf {
    app_home()
        .unwrap_or_else(|_| fallback_home_dir().join(".codex-config-ui"))
        .join("sync-targets.json")
}

fn sync_empty_manifest() -> Value {
    json!({
      "schema": "easyaiconfig.sync-manifest.v1",
      "updatedAt": "",
      "latestSnapshotId": "",
      "snapshots": [],
    })
}

fn normalize_sync_target(target: &Value, index: usize) -> Value {
    let id = value_string(target.get("id"));
    let mut url_value = value_string(target.get("url"));
    let mut username = value_string(target.get("username"));
    let mut password = value_string(target.get("password"));
    if !url_value.is_empty() {
        if let Ok(mut parsed) = url::Url::parse(&url_value) {
            if username.is_empty() {
                username = parsed.username().to_string();
            }
            if password.is_empty() {
                password = parsed.password().unwrap_or("").to_string();
            }
            let _ = parsed.set_username("");
            let _ = parsed.set_password(None);
            parsed.set_query(None);
            parsed.set_fragment(None);
            url_value = parsed.to_string().trim_end_matches('/').to_string();
        }
    }
    json!({
      "id": if id.is_empty() { format!("custom-{}", index + 1) } else { id },
      "type": value_string(target.get("type")).if_empty("directory"),
      "label": value_string(target.get("label")).if_empty(&format!("Custom {}", index + 1)),
      "path": value_string(target.get("path")),
      "url": url_value,
      "username": username,
      "password": password,
      "token": value_string(target.get("token"))
        .if_empty(&value_string(target.get("accessToken")))
        .if_empty(&value_string(target.get("bearerToken"))),
      "headers": target.get("headers").cloned().unwrap_or_else(|| json!({})),
      "enabled": !matches!(target.get("enabled"), Some(Value::Bool(false))),
      "mode": value_string(target.get("mode")).if_empty("bundle-export"),
    })
}

fn configured_sync_targets(config_path: &Path) -> (Vec<Value>, String) {
    let raw = match read_optional_text(config_path) {
        Ok(Some(text)) => text,
        Ok(None) => return (Vec::new(), String::new()),
        Err(error) => return (Vec::new(), error),
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(parsed) => {
            let targets = parsed
                .get("targets")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .iter()
                .enumerate()
                .map(|(index, target)| normalize_sync_target(target, index))
                .collect::<Vec<_>>();
            (targets, String::new())
        }
        Err(error) => (Vec::new(), format!("Sync targets parse failed: {error}")),
    }
}

fn built_in_sync_targets() -> Vec<Value> {
    let home = fallback_home_dir();
    let mut targets = vec![
        json!({
          "id": "icloud",
          "type": "icloud",
          "label": "iCloud Drive",
          "path": path_string(&home.join("Library").join("Mobile Documents").join("com~apple~CloudDocs").join("EasyAIConfig")),
          "url": "",
          "enabled": cfg!(target_os = "macos"),
          "mode": "bundle-export",
          "detected": true,
        }),
        json!({
          "id": "dropbox",
          "type": "dropbox",
          "label": "Dropbox",
          "path": path_string(&home.join("Dropbox").join("EasyAIConfig")),
          "url": "",
          "enabled": true,
          "mode": "bundle-export",
          "detected": true,
        }),
    ];
    if let Ok(env_dir) = std::env::var("EASYAICONFIG_SYNC_DIR") {
        if !env_dir.trim().is_empty() {
            targets.push(json!({
              "id": "env-sync-dir",
              "type": "directory",
              "label": "EASYAICONFIG_SYNC_DIR",
              "path": env_dir.trim(),
              "url": "",
              "enabled": true,
              "mode": "bundle-export",
              "detected": true,
            }));
        }
    }
    if let Ok(entries) = fs::read_dir(&home) {
        for (index, entry) in entries
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
                    && entry
                        .file_name()
                        .to_string_lossy()
                        .to_lowercase()
                        .starts_with("onedrive")
            })
            .enumerate()
        {
            targets.push(json!({
        "id": if index == 0 { "onedrive".to_string() } else { format!("onedrive-{}", index + 1) },
        "type": "onedrive",
        "label": entry.file_name().to_string_lossy().to_string(),
        "path": path_string(&entry.path().join("EasyAIConfig")),
        "url": "",
        "enabled": true,
        "mode": "bundle-export",
        "detected": true,
      }));
        }
    }
    if cfg!(target_os = "macos") {
        if let Ok(entries) = fs::read_dir("/Volumes") {
            for (index, entry) in entries
                .filter_map(Result::ok)
                .filter(|entry| {
                    let name = entry.file_name().to_string_lossy().to_string();
                    entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
                        && !["Macintosh HD", "Preboot", "Recovery"].contains(&name.as_str())
                })
                .enumerate()
            {
                targets.push(json!({
          "id": if index == 0 { "nas-volume".to_string() } else { format!("nas-volume-{}", index + 1) },
          "type": "nas",
          "label": format!("NAS / Volume: {}", entry.file_name().to_string_lossy()),
          "path": path_string(&entry.path().join("EasyAIConfig")),
          "url": "",
          "enabled": true,
          "mode": "bundle-export",
          "detected": true,
        }));
            }
        }
    }
    targets
}

fn public_sync_target(target: &Value) -> Value {
    let mut object = target.as_object().cloned().unwrap_or_default();
    let username = value_string(target.get("username"));
    let password = value_string(target.get("password"));
    let token = value_string(target.get("token"));
    let headers = target
        .get("headers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let has_custom_auth_header = headers
        .keys()
        .any(|key| key.eq_ignore_ascii_case("authorization"));
    object.remove("password");
    object.remove("token");
    object.remove("headers");
    object.insert("auth".to_string(), json!({
      "type": if !token.is_empty() { "bearer" } else if !username.is_empty() || !password.is_empty() { "basic" } else if has_custom_auth_header { "custom" } else { "none" },
      "username": username,
      "hasPassword": !password.is_empty(),
      "hasToken": !token.is_empty(),
      "headerCount": headers.len(),
    }));
    Value::Object(object)
}

fn materialize_sync_target(target: &Value, include_secrets: bool) -> Value {
    let target_type = value_string(target.get("type")).if_empty("directory");
    let path = value_string(target.get("path"));
    let url = value_string(target.get("url"));
    let enabled = target
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let webdav = target_type == "webdav";
    let path_buf = PathBuf::from(&path);
    let exists = if webdav {
        !url.is_empty()
    } else {
        !path.is_empty() && path_exists(&path_buf)
    };
    let writable = if webdav {
        !url.is_empty()
    } else {
        fs::metadata(&path_buf)
            .map(|metadata| !metadata.permissions().readonly())
            .unwrap_or(false)
    };
    let materialized = json!({
      "id": value_string(target.get("id")),
      "type": target_type,
      "label": value_string(target.get("label")),
      "path": path,
      "url": url,
      "username": value_string(target.get("username")),
      "password": value_string(target.get("password")),
      "token": value_string(target.get("token")),
      "headers": target.get("headers").cloned().unwrap_or_else(|| json!({})),
      "enabled": enabled,
      "configured": !target.get("detected").and_then(Value::as_bool).unwrap_or(false),
      "detected": target.get("detected").and_then(Value::as_bool).unwrap_or(false),
      "mode": value_string(target.get("mode")).if_empty("bundle-export"),
      "exists": exists,
      "writable": writable,
      "ready": enabled && exists && writable,
    });
    if include_secrets {
        materialized
    } else {
        public_sync_target(&materialized)
    }
}

fn list_sync_targets_with_secrets(include_secrets: bool) -> Value {
    let config_path = sync_targets_config_path();
    let (configured, parse_error) = configured_sync_targets(&config_path);
    let mut by_id = BTreeMap::new();
    for target in built_in_sync_targets()
        .into_iter()
        .chain(configured.into_iter())
    {
        let id = value_string(target.get("id"));
        if !id.is_empty() {
            by_id.insert(id, target);
        }
    }
    let targets = by_id
        .values()
        .map(|target| materialize_sync_target(target, include_secrets))
        .collect::<Vec<_>>();
    let mut by_type = Map::new();
    for target in &targets {
        let target_type = value_string(target.get("type"));
        if !target_type.is_empty() {
            let next = by_type
                .get(&target_type)
                .and_then(Value::as_u64)
                .unwrap_or(0)
                + 1;
            by_type.insert(target_type, json!(next));
        }
    }
    json!({
      "schema": "easyaiconfig.sync-targets.v1",
      "generatedAt": now_iso(),
      "configPath": path_string(&config_path),
      "parseError": parse_error,
      "targets": targets,
      "summary": {
        "targets": targets.len(),
        "ready": targets.iter().filter(|target| target.get("ready").and_then(Value::as_bool).unwrap_or(false)).count(),
        "configured": targets.iter().filter(|target| target.get("configured").and_then(Value::as_bool).unwrap_or(false)).count(),
        "detected": targets.iter().filter(|target| target.get("detected").and_then(Value::as_bool).unwrap_or(false)).count(),
        "byType": by_type,
      },
    })
}

fn list_sync_targets() -> Value {
    list_sync_targets_with_secrets(false)
}

fn save_sync_targets(body: &Value) -> Result<Value, String> {
    let config_path = sync_targets_config_path();
    let targets = body
        .get("targets")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(index, target)| normalize_sync_target(target, index))
        .filter(|target| {
            !value_string(target.get("id")).is_empty()
                && (!value_string(target.get("path")).is_empty()
                    || !value_string(target.get("url")).is_empty())
        })
        .collect::<Vec<_>>();
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let payload = json!({
      "schema": "easyaiconfig.sync-targets.v1",
      "updatedAt": now_iso(),
      "targets": targets,
    });
    let text = serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?;
    fs::write(&config_path, format!("{text}\n")).map_err(|error| error.to_string())?;
    Ok(json!({
      "schema": "easyaiconfig.sync-targets.v1",
      "updatedAt": payload.get("updatedAt").cloned().unwrap_or(json!("")),
      "configPath": path_string(&config_path),
      "targets": payload
        .get("targets")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(public_sync_target).collect::<Vec<_>>())
        .unwrap_or_default(),
    }))
}

fn sync_manifest_path(root: &Path) -> PathBuf {
    root.join("manifest.json")
}

fn sync_snapshots_root(root: &Path) -> PathBuf {
    root.join("snapshots")
}

fn sync_bundle_counts(bundle: &Value) -> Value {
    let assets = bundle.get("assets").unwrap_or(bundle);
    let provider_presets = assets
        .get("providerCatalog")
        .and_then(|catalog| catalog.get("presets"))
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0);
    json!({
      "providerPresets": provider_presets,
      "mcpServers": assets.get("mcpInventory").and_then(|value| value.get("summary")).and_then(|value| value.get("servers")).and_then(Value::as_u64).unwrap_or(0),
      "prompts": assets.get("promptInventory").and_then(|value| value.get("summary")).and_then(|value| value.get("files")).and_then(Value::as_u64).unwrap_or(0),
      "skills": assets.get("skillInventory").and_then(|value| value.get("summary")).and_then(|value| value.get("skills")).and_then(Value::as_u64).unwrap_or(0),
      "sessions": assets.get("sessionInventory").and_then(|value| value.get("summary")).and_then(|value| value.get("sessions")).and_then(Value::as_u64).unwrap_or(0),
    })
}

fn read_sync_manifest_at(root: &Path) -> Result<Value, String> {
    let manifest_path = sync_manifest_path(root);
    let raw = match read_optional_text(&manifest_path)? {
        Some(text) => text,
        None => return Ok(sync_empty_manifest()),
    };
    if raw.trim().is_empty() {
        return Ok(sync_empty_manifest());
    }
    let parsed = serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string())?;
    Ok(json!({
      "schema": parsed.get("schema").and_then(Value::as_str).unwrap_or("easyaiconfig.sync-manifest.v1"),
      "updatedAt": parsed.get("updatedAt").and_then(Value::as_str).unwrap_or(""),
      "latestSnapshotId": parsed.get("latestSnapshotId").and_then(Value::as_str).unwrap_or(""),
      "snapshots": parsed.get("snapshots").and_then(Value::as_array).cloned().unwrap_or_default(),
    }))
}

fn write_sync_manifest_at(
    root: &Path,
    latest_snapshot_id: &str,
    snapshots: Vec<Value>,
) -> Result<Value, String> {
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let payload = json!({
      "schema": "easyaiconfig.sync-manifest.v1",
      "updatedAt": now_iso(),
      "latestSnapshotId": latest_snapshot_id,
      "snapshots": snapshots,
    });
    let text = serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?;
    fs::write(sync_manifest_path(root), format!("{text}\n")).map_err(|error| error.to_string())?;
    Ok(payload)
}

fn resolve_sync_target(input: &Value) -> Result<Value, String> {
    let direct_path =
        value_string(input.get("targetPath")).if_empty(&value_string(input.get("path")));
    if !direct_path.is_empty() {
        let path = absolute_path(
            expand_home_path(&direct_path).unwrap_or_else(|| PathBuf::from(&direct_path)),
        );
        let exists = path_exists(&path);
        let writable = fs::metadata(&path)
            .map(|metadata| !metadata.permissions().readonly())
            .unwrap_or(false);
        return Ok(json!({
          "id": value_string(input.get("targetId")).if_empty("direct-directory"),
          "type": "directory",
          "label": value_string(input.get("label")).if_empty("Direct Directory"),
          "path": path_string(&path),
          "url": "",
          "enabled": true,
          "configured": false,
          "detected": false,
          "mode": "bundle-export",
          "exists": exists,
          "writable": writable,
          "ready": exists && writable,
        }));
    }
    let direct_url = value_string(input.get("targetUrl")).if_empty(&value_string(input.get("url")));
    if !direct_url.is_empty() {
        let target = normalize_sync_target(
            &json!({
              "id": value_string(input.get("targetId")).if_empty("direct-webdav"),
              "type": value_string(input.get("type")).if_empty("webdav"),
              "label": value_string(input.get("label")).if_empty("Direct WebDAV"),
              "url": direct_url,
              "username": value_string(input.get("username")),
              "password": value_string(input.get("password")),
              "token": value_string(input.get("token")),
              "headers": input.get("headers").cloned().unwrap_or_else(|| json!({})),
            }),
            0,
        );
        return Ok(materialize_sync_target(&target, true));
    }
    let target_id = value_string(input.get("targetId")).if_empty(&value_string(input.get("id")));
    if target_id.is_empty() {
        return Err("targetId or targetPath is required".to_string());
    }
    let inventory = list_sync_targets_with_secrets(true);
    inventory
        .get("targets")
        .and_then(Value::as_array)
        .and_then(|targets| {
            targets
                .iter()
                .find(|target| value_string(target.get("id")) == target_id)
                .cloned()
        })
        .ok_or_else(|| format!("Sync target not found: {target_id}"))
}

fn assert_directory_sync_target(target: &Value) -> Result<PathBuf, String> {
    if !target
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err("Sync target is disabled".to_string());
    }
    let target_path = value_string(target.get("path"));
    if target_path.is_empty() {
        return Err("Sync target path is required".to_string());
    }
    Ok(PathBuf::from(target_path))
}

fn assert_webdav_sync_target(target: &Value) -> Result<String, String> {
    if !target
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err("Sync target is disabled".to_string());
    }
    let url = value_string(target.get("url"));
    if url.is_empty() {
        return Err("WebDAV target URL is required".to_string());
    }
    Ok(url)
}

fn webdav_base_url(target: &Value) -> Result<String, String> {
    let raw = assert_webdav_sync_target(target)?;
    let mut parsed =
        url::Url::parse(&raw).map_err(|error| format!("WebDAV URL parse failed: {error}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("WebDAV URL must use http or https".to_string());
    }
    let _ = parsed.set_username("");
    let _ = parsed.set_password(None);
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(format!("{}/", parsed.to_string().trim_end_matches('/')))
}

fn webdav_url(target: &Value, segments: &[&str]) -> Result<String, String> {
    let mut url = webdav_base_url(target)?.trim_end_matches('/').to_string();
    for segment in segments {
        let clean = segment.trim_matches('/');
        if !clean.is_empty() {
            url.push('/');
            url.push_str(clean);
        }
    }
    Ok(url)
}

fn webdav_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| error.to_string())
}

fn webdav_request(
    target: &Value,
    method: &str,
    url: &str,
    body: Option<String>,
    content_type: Option<&str>,
    ok_statuses: &[u16],
) -> Result<reqwest::blocking::Response, String> {
    let client = webdav_client()?;
    let method =
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|error| error.to_string())?;
    let mut request = client.request(method, url);
    let token = value_string(target.get("token"));
    let username = value_string(target.get("username"));
    let password = value_string(target.get("password"));
    if !token.is_empty() {
        request = request.bearer_auth(token);
    } else if !username.is_empty() || !password.is_empty() {
        request = request.basic_auth(username, Some(password));
    }
    if let Some(headers) = target.get("headers").and_then(Value::as_object) {
        for (key, value) in headers {
            let header_value = value
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| value.to_string());
            if !key.trim().is_empty() {
                request = request.header(key.as_str(), header_value);
            }
        }
    }
    if let Some(content_type) = content_type {
        request = request.header(reqwest::header::CONTENT_TYPE, content_type);
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    let response = request.send().map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    if !response.status().is_success() && !ok_statuses.contains(&status) {
        let detail = response.text().unwrap_or_default();
        return Err(format!(
            "WebDAV request failed: HTTP {}{}",
            status,
            if detail.trim().is_empty() {
                String::new()
            } else {
                format!(" {}", detail.chars().take(160).collect::<String>())
            }
        ));
    }
    Ok(response)
}

fn ensure_webdav_collection(target: &Value, segments: &[&str]) -> Result<(), String> {
    let url = webdav_url(target, segments)?;
    webdav_request(target, "MKCOL", &url, None, None, &[200, 201, 204, 405])?;
    Ok(())
}

fn read_webdav_manifest_at(target: &Value) -> Result<Value, String> {
    let url = webdav_url(target, &["manifest.json"])?;
    let response = webdav_request(target, "GET", &url, None, None, &[404])?;
    if response.status().as_u16() == 404 {
        return Ok(sync_empty_manifest());
    }
    let raw = response.text().map_err(|error| error.to_string())?;
    if raw.trim().is_empty() {
        return Ok(sync_empty_manifest());
    }
    let parsed = serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string())?;
    Ok(json!({
      "schema": parsed.get("schema").and_then(Value::as_str).unwrap_or("easyaiconfig.sync-manifest.v1"),
      "updatedAt": parsed.get("updatedAt").and_then(Value::as_str).unwrap_or(""),
      "latestSnapshotId": parsed.get("latestSnapshotId").and_then(Value::as_str).unwrap_or(""),
      "snapshots": parsed.get("snapshots").and_then(Value::as_array).cloned().unwrap_or_default(),
    }))
}

fn write_webdav_manifest_at(
    target: &Value,
    latest_snapshot_id: &str,
    snapshots: Vec<Value>,
) -> Result<Value, String> {
    ensure_webdav_collection(target, &[])?;
    let payload = json!({
      "schema": "easyaiconfig.sync-manifest.v1",
      "updatedAt": now_iso(),
      "latestSnapshotId": latest_snapshot_id,
      "snapshots": snapshots,
    });
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?
    );
    let url = webdav_url(target, &["manifest.json"])?;
    webdav_request(
        target,
        "PUT",
        &url,
        Some(text),
        Some("application/json"),
        &[200, 201, 204],
    )?;
    Ok(payload)
}

fn list_sync_snapshots(input: &Value) -> Result<Value, String> {
    if value_string(input.get("targetId")).is_empty()
        && value_string(input.get("id")).is_empty()
        && value_string(input.get("targetPath")).is_empty()
        && value_string(input.get("path")).is_empty()
    {
        let inventory = list_sync_targets_with_secrets(true);
        let mut targets_out = Vec::new();
        if let Some(targets) = inventory.get("targets").and_then(Value::as_array) {
            for target in targets {
                let target_type = value_string(target.get("type"));
                let target_path = value_string(target.get("path"));
                if target_type == "webdav" {
                    let (manifest, read_error) = match read_webdav_manifest_at(target) {
                        Ok(manifest) => (manifest, String::new()),
                        Err(error) => (sync_empty_manifest(), error),
                    };
                    let latest_pushed_at = manifest
                        .get("snapshots")
                        .and_then(Value::as_array)
                        .and_then(|items| items.first())
                        .and_then(|entry| entry.get("pushedAt"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    targets_out.push(json!({
                      "target": public_sync_target(target),
                      "manifest": manifest,
                      "readError": read_error,
                      "summary": {
                        "snapshots": manifest.get("snapshots").and_then(Value::as_array).map(|items| items.len()).unwrap_or(0),
                        "latestSnapshotId": value_string(manifest.get("latestSnapshotId")),
                        "latestPushedAt": latest_pushed_at,
                      },
                    }));
                    continue;
                }
                if target_path.is_empty() {
                    targets_out.push(json!({
                      "target": public_sync_target(target),
                      "manifest": Value::Null,
                      "readError": "",
                      "summary": { "snapshots": 0, "latestSnapshotId": "", "latestPushedAt": "" },
                    }));
                    continue;
                }
                let root = PathBuf::from(target_path);
                let manifest = read_sync_manifest_at(&root).unwrap_or_else(|error| {
                    json!({
                      "schema": "easyaiconfig.sync-manifest.v1",
                      "updatedAt": "",
                      "latestSnapshotId": "",
                      "snapshots": [],
                      "readError": error,
                    })
                });
                let latest_pushed_at = manifest
                    .get("snapshots")
                    .and_then(Value::as_array)
                    .and_then(|items| items.first())
                    .and_then(|entry| entry.get("pushedAt"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                targets_out.push(json!({
                  "target": public_sync_target(target),
                  "manifest": manifest,
                  "readError": "",
                  "summary": {
                    "snapshots": manifest.get("snapshots").and_then(Value::as_array).map(|items| items.len()).unwrap_or(0),
                    "latestSnapshotId": value_string(manifest.get("latestSnapshotId")),
                    "latestPushedAt": latest_pushed_at,
                  },
                }));
            }
        }
        let snapshots_total: usize = targets_out
            .iter()
            .map(|item| {
                item.get("summary")
                    .and_then(|summary| summary.get("snapshots"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize
            })
            .sum();
        return Ok(json!({
          "schema": "easyaiconfig.sync-snapshots.v1",
          "generatedAt": now_iso(),
          "targets": targets_out,
          "summary": {
            "targets": targets_out.len(),
            "snapshots": snapshots_total,
            "readable": targets_out.iter().filter(|item| !item.get("manifest").unwrap_or(&Value::Null).is_null()).count(),
          },
        }));
    }
    let target = resolve_sync_target(input)?;
    let manifest = if value_string(target.get("type")) == "webdav" {
        read_webdav_manifest_at(&target)?
    } else {
        let root = assert_directory_sync_target(&target)?;
        read_sync_manifest_at(&root)?
    };
    let snapshots = manifest
        .get("snapshots")
        .cloned()
        .unwrap_or_else(|| json!([]));
    Ok(json!({
      "schema": "easyaiconfig.sync-snapshots.v1",
      "generatedAt": now_iso(),
      "target": public_sync_target(&target),
      "manifest": manifest,
      "snapshots": snapshots,
      "summary": {
        "snapshots": snapshots.as_array().map(|items| items.len()).unwrap_or(0),
        "latestSnapshotId": value_string(manifest.get("latestSnapshotId")),
        "latestPushedAt": manifest.get("snapshots").and_then(Value::as_array).and_then(|items| items.first()).and_then(|entry| entry.get("pushedAt")).and_then(Value::as_str).unwrap_or(""),
      },
    }))
}

fn sync_snapshot_id(body: &Value, bundle: &Value) -> String {
    let explicit = value_string(body.get("snapshotId"))
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_lowercase();
    if !explicit.is_empty() {
        return explicit.chars().take(96).collect();
    }
    let digest = sha256_hex(&format!(
        "{}{}{}",
        now_iso(),
        bundle,
        system_time_ms(SystemTime::now())
    ));
    format!(
        "{}-{}",
        system_time_ms(SystemTime::now()),
        digest.chars().take(12).collect::<String>()
    )
}

fn push_sync_snapshot(body: &Value) -> Result<Value, String> {
    let dry_run = body.get("dryRun").and_then(Value::as_bool).unwrap_or(true);
    let bundle = match body.get("bundle") {
        Some(value) if value.is_object() => value.clone(),
        _ => asset_export(body)?,
    };
    if bundle.get("schema").and_then(Value::as_str) != Some("easyaiconfig.asset-bundle.v1") {
        return Err("Only easyaiconfig.asset-bundle.v1 can be synced".to_string());
    }
    let target = resolve_sync_target(body)?;
    let snapshot_id = sync_snapshot_id(body, &bundle);
    let file_name = format!("{snapshot_id}.json");
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(&bundle).map_err(|error| error.to_string())?
    );
    if value_string(target.get("type")) == "webdav" {
        assert_webdav_sync_target(&target)?;
        let snapshot_url = webdav_url(&target, &["snapshots", &file_name])?;
        let manifest_url = webdav_url(&target, &["manifest.json"])?;
        let entry = json!({
          "id": snapshot_id,
          "fileName": file_name,
          "url": snapshot_url,
          "label": value_string(body.get("label")),
          "pushedAt": now_iso(),
          "bundleSchema": "easyaiconfig.asset-bundle.v1",
          "app": bundle.get("app").and_then(Value::as_str).unwrap_or("EasyAIConfig"),
          "version": bundle.get("version").cloned().unwrap_or(json!(1)),
          "exportedAt": bundle.get("exportedAt").and_then(Value::as_str).unwrap_or(""),
          "bytes": text.as_bytes().len(),
          "sha256": sha256_hex(&text),
          "counts": sync_bundle_counts(&bundle),
        });
        if !dry_run {
            ensure_webdav_collection(&target, &[])?;
            ensure_webdav_collection(&target, &["snapshots"])?;
            webdav_request(
                &target,
                "PUT",
                &snapshot_url,
                Some(text.clone()),
                Some("application/json"),
                &[200, 201, 204],
            )?;
            let manifest = read_webdav_manifest_at(&target)?;
            let mut snapshots = vec![entry.clone()];
            if let Some(existing) = manifest.get("snapshots").and_then(Value::as_array) {
                for item in existing {
                    if value_string(item.get("id")) != snapshot_id {
                        snapshots.push(item.clone());
                    }
                    if snapshots.len() >= 50 {
                        break;
                    }
                }
            }
            write_webdav_manifest_at(&target, &snapshot_id, snapshots)?;
        }
        return Ok(json!({
          "schema": "easyaiconfig.sync-push.v1",
          "dryRun": dry_run,
          "changed": !dry_run,
          "target": public_sync_target(&target),
          "entry": entry,
          "operations": [{
            "action": "push-sync-snapshot",
            "dryRun": dry_run,
            "targetUrl": value_string(target.get("url")),
            "snapshotUrl": snapshot_url,
            "manifestUrl": manifest_url,
            "willCreateTargetDirectory": false,
          }],
          "summary": {
            "pushed": if dry_run { 0 } else { 1 },
            "previewed": if dry_run { 1 } else { 0 },
            "bytes": text.as_bytes().len(),
          },
        }));
    }

    let root = assert_directory_sync_target(&target)?;
    let exists = path_exists(&root);
    let parent = root
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| root.clone());
    if !exists && !path_exists(&parent) {
        return Err("Sync target parent directory does not exist".to_string());
    }
    let snapshot_path = sync_snapshots_root(&root).join(&file_name);
    let entry = json!({
      "id": snapshot_id,
      "fileName": file_name,
      "path": path_string(&snapshot_path),
      "label": value_string(body.get("label")),
      "pushedAt": now_iso(),
      "bundleSchema": "easyaiconfig.asset-bundle.v1",
      "app": bundle.get("app").and_then(Value::as_str).unwrap_or("EasyAIConfig"),
      "version": bundle.get("version").cloned().unwrap_or(json!(1)),
      "exportedAt": bundle.get("exportedAt").and_then(Value::as_str).unwrap_or(""),
      "bytes": text.as_bytes().len(),
      "sha256": sha256_hex(&text),
      "counts": sync_bundle_counts(&bundle),
    });
    if !dry_run {
        fs::create_dir_all(sync_snapshots_root(&root)).map_err(|error| error.to_string())?;
        fs::write(&snapshot_path, &text).map_err(|error| error.to_string())?;
        let manifest = read_sync_manifest_at(&root)?;
        let mut snapshots = vec![entry.clone()];
        if let Some(existing) = manifest.get("snapshots").and_then(Value::as_array) {
            for item in existing {
                if value_string(item.get("id")) != snapshot_id {
                    snapshots.push(item.clone());
                }
                if snapshots.len() >= 50 {
                    break;
                }
            }
        }
        write_sync_manifest_at(&root, &snapshot_id, snapshots)?;
    }
    Ok(json!({
      "schema": "easyaiconfig.sync-push.v1",
      "dryRun": dry_run,
      "changed": !dry_run,
      "target": public_sync_target(&target),
      "entry": entry,
      "operations": [{
        "action": "push-sync-snapshot",
        "dryRun": dry_run,
        "targetPath": path_string(&root),
        "snapshotPath": path_string(&snapshot_path),
        "manifestPath": path_string(&sync_manifest_path(&root)),
        "willCreateTargetDirectory": !exists,
      }],
      "summary": {
        "pushed": if dry_run { 0 } else { 1 },
        "previewed": if dry_run { 1 } else { 0 },
        "bytes": text.as_bytes().len(),
      },
    }))
}

fn read_sync_snapshot(body: &Value) -> Result<Value, String> {
    let target = resolve_sync_target(body)?;
    let manifest = if value_string(target.get("type")) == "webdav" {
        read_webdav_manifest_at(&target)?
    } else {
        let root = assert_directory_sync_target(&target)?;
        read_sync_manifest_at(&root)?
    };
    let requested_id = value_string(body.get("snapshotId"))
        .if_empty(&value_string(body.get("id")))
        .if_empty(&value_string(manifest.get("latestSnapshotId")));
    if requested_id.is_empty() {
        return Err("snapshotId is required".to_string());
    }
    let entry = manifest
        .get("snapshots")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|entry| value_string(entry.get("id")) == requested_id)
                .cloned()
        })
        .ok_or_else(|| format!("Sync snapshot not found: {requested_id}"))?;
    if value_string(target.get("type")) == "webdav" {
        let fallback_file_name =
            value_string(entry.get("fileName")).if_empty(&format!("{requested_id}.json"));
        let fallback_snapshot_url = webdav_url(&target, &["snapshots", &fallback_file_name])?;
        let snapshot_url = value_string(entry.get("url")).if_empty(&fallback_snapshot_url);
        let root_url = webdav_base_url(&target)?;
        if !snapshot_url.starts_with(&root_url) {
            return Err("Sync snapshot URL is outside target root".to_string());
        }
        let raw = webdav_request(&target, "GET", &snapshot_url, None, None, &[])?
            .text()
            .map_err(|error| error.to_string())?;
        let digest = sha256_hex(&raw);
        let expected = value_string(entry.get("sha256"));
        if !expected.is_empty() && expected != digest {
            return Err("Sync snapshot checksum mismatch".to_string());
        }
        let bundle = serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string())?;
        return Ok(json!({
          "schema": "easyaiconfig.sync-pull.v1",
          "generatedAt": now_iso(),
          "target": public_sync_target(&target),
          "entry": {
            "id": value_string(entry.get("id")),
            "fileName": value_string(entry.get("fileName")),
            "url": snapshot_url,
            "label": value_string(entry.get("label")),
            "pushedAt": value_string(entry.get("pushedAt")),
            "bundleSchema": value_string(entry.get("bundleSchema")),
            "app": value_string(entry.get("app")),
            "version": entry.get("version").cloned().unwrap_or(json!(1)),
            "exportedAt": value_string(entry.get("exportedAt")),
            "bytes": raw.as_bytes().len(),
            "sha256": digest,
            "counts": sync_bundle_counts(&bundle),
            "exists": true,
          },
          "bundle": bundle,
          "summary": {
            "bytes": raw.as_bytes().len(),
            "counts": sync_bundle_counts(&bundle),
          },
        }));
    }

    let root = assert_directory_sync_target(&target)?;
    let snapshot_path = if !value_string(entry.get("path")).is_empty() {
        PathBuf::from(value_string(entry.get("path")))
    } else {
        sync_snapshots_root(&root)
            .join(value_string(entry.get("fileName")).if_empty(&format!("{requested_id}.json")))
    };
    let snapshot_abs = canonical_or_absolute(&snapshot_path);
    let root_abs = canonical_or_absolute(&root);
    if !path_inside(&snapshot_abs, &root_abs) {
        return Err("Sync snapshot path is outside target root".to_string());
    }
    let raw = fs::read_to_string(&snapshot_abs).map_err(|error| error.to_string())?;
    let digest = sha256_hex(&raw);
    let expected = value_string(entry.get("sha256"));
    if !expected.is_empty() && expected != digest {
        return Err("Sync snapshot checksum mismatch".to_string());
    }
    let bundle = serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string())?;
    Ok(json!({
      "schema": "easyaiconfig.sync-pull.v1",
      "generatedAt": now_iso(),
      "target": public_sync_target(&target),
      "entry": {
        "id": value_string(entry.get("id")),
        "fileName": value_string(entry.get("fileName")),
        "path": path_string(&snapshot_abs),
        "label": value_string(entry.get("label")),
        "pushedAt": value_string(entry.get("pushedAt")),
        "bundleSchema": value_string(entry.get("bundleSchema")),
        "app": value_string(entry.get("app")),
        "version": entry.get("version").cloned().unwrap_or(json!(1)),
        "exportedAt": value_string(entry.get("exportedAt")),
        "bytes": raw.as_bytes().len(),
        "sha256": digest,
        "counts": sync_bundle_counts(&bundle),
        "exists": true,
      },
      "bundle": bundle,
      "summary": {
        "bytes": raw.as_bytes().len(),
        "counts": sync_bundle_counts(&bundle),
      },
    }))
}

fn pull_sync_snapshot(body: &Value) -> Result<Value, String> {
    let dry_run = body.get("dryRun").and_then(Value::as_bool).unwrap_or(true);
    let snapshot = read_sync_snapshot(body)?;
    let bundle = snapshot.get("bundle").cloned().unwrap_or_else(|| json!({}));
    let import_result = asset_import_apply(&json!({
      "payload": bundle,
      "dryRun": dry_run,
      "targetTool": body.get("targetTool").and_then(Value::as_str).unwrap_or("all"),
      "includeCatalogPresets": body.get("includeCatalogPresets").and_then(Value::as_bool).unwrap_or(true),
    }))?;
    Ok(json!({
      "schema": "easyaiconfig.sync-pull-apply.v1",
      "dryRun": dry_run,
      "changed": false,
      "target": snapshot.get("target").cloned().unwrap_or_else(|| json!({})),
      "entry": snapshot.get("entry").cloned().unwrap_or_else(|| json!({})),
      "importResult": import_result,
      "summary": {
        "pulled": 1,
        "bytes": snapshot.get("summary").and_then(|summary| summary.get("bytes")).and_then(Value::as_u64).unwrap_or(0),
        "changed": false,
        "written": false,
        "conflicts": 0,
      },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_routes_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "easyaiconfig-routes-{name}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&dir).expect("create temp routes dir");
        dir
    }

    #[test]
    fn tauri_asset_mcp_inventory_reads_codex_toml_without_env_values() {
        let codex_home = temp_routes_dir("mcp");
        fs::write(
            codex_home.join("config.toml"),
            r#"
[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem"]

[mcp_servers.filesystem.env]
SECRET_TOKEN = "do-not-expose"
"#,
        )
        .expect("write test config.toml");

        let inventory = mcp_inventory(&json!({ "codexHome": path_string(&codex_home) }));
        assert_eq!(
            inventory.get("schema").and_then(Value::as_str),
            Some("easyaiconfig.mcp-inventory.v1")
        );
        assert!(
            inventory
                .get("summary")
                .and_then(|value| value.get("servers"))
                .and_then(Value::as_u64)
                .unwrap_or(0)
                >= 1
        );
        assert_eq!(
            inventory
                .get("summary")
                .and_then(|value| value.get("parseErrors"))
                .and_then(Value::as_u64),
            Some(0)
        );
        assert_eq!(
            inventory
                .get("summary")
                .and_then(|value| value.get("readErrors"))
                .and_then(Value::as_u64),
            Some(0)
        );
        let servers = inventory
            .get("servers")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let filesystem = servers
            .iter()
            .find(|server| server.get("id").and_then(Value::as_str) == Some("filesystem"))
            .expect("filesystem MCP server");
        assert_eq!(
            filesystem.get("command").and_then(Value::as_str),
            Some("npx")
        );
        assert_eq!(
            filesystem
                .get("envKeys")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_str),
            Some("SECRET_TOKEN")
        );
        assert!(!filesystem.to_string().contains("do-not-expose"));

        let _ = fs::remove_dir_all(codex_home);
    }

    #[test]
    fn tauri_asset_inventory_reads_prompts_skills_and_sessions() {
        let codex_home = temp_routes_dir("assets");
        let project = codex_home.join("project");
        let skill_dir = codex_home.join("skills").join("reviewer");
        let session_dir = codex_home.join("sessions");
        fs::create_dir_all(&project).expect("create project");
        fs::create_dir_all(&skill_dir).expect("create skill dir");
        fs::create_dir_all(&session_dir).expect("create session dir");
        fs::write(
            project.join("AGENTS.md"),
            "# Project Agents\n\nUse local rules.\n",
        )
        .expect("write prompt");
        fs::write(
            skill_dir.join("SKILL.md"),
            "# Reviewer\n\nReview code changes.\n",
        )
        .expect("write skill");
        fs::write(
      session_dir.join("session.jsonl"),
      r#"{"timestamp":"2026-07-05T10:00:00Z","sessionId":"s1","cwd":"/tmp/project","model":"gpt-5","message":{"role":"user","content":"hello"}}"#,
    )
    .expect("write session");
        let query = json!({
          "codexHome": path_string(&codex_home),
          "projectPath": path_string(&project),
          "limit": 10,
        });

        let prompts = prompt_inventory(&query);
        assert!(
            prompts
                .get("summary")
                .and_then(|value| value.get("projectFiles"))
                .and_then(Value::as_u64)
                .unwrap_or(0)
                >= 1
        );
        let skills = skill_inventory(&query);
        assert!(skills
            .get("skills")
            .and_then(Value::as_array)
            .unwrap_or(&Vec::new())
            .iter()
            .any(|skill| skill.get("name").and_then(Value::as_str) == Some("reviewer")));
        let sessions = session_inventory(&query);
        assert!(sessions
            .get("items")
            .and_then(Value::as_array)
            .unwrap_or(&Vec::new())
            .iter()
            .any(|session| session.get("sessionId").and_then(Value::as_str) == Some("s1")));

        let _ = fs::remove_dir_all(codex_home);
    }

    #[test]
    fn tauri_asset_import_preview_accepts_ccswitch_v1_query_links() {
        let provider = asset_import_preview(&json!({
          "url": "ccswitch://v1/import?resource=provider&id=openrouter-custom&name=OpenRouter%20Custom&baseUrl=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&envKey=OPENROUTER_API_KEY&apiKey=sk-from-deeplink&wireApi=chat&protocols=openai-chat%2Cresponses&homepage=https%3A%2F%2Fopenrouter.ai&model=openai%2Fgpt-5&models=openai%2Fgpt-5%2Canthropic%2Fclaude-sonnet-4&config=%7B%22retry%22%3A2%7D&configFormat=json&configUrl=https%3A%2F%2Fexample.com%2Fopenrouter.json&usageScript=openrouter-usage.js&tools=codex%2Copencode",
        }))
        .expect("provider preview");
        assert_eq!(
            provider.get("schema").and_then(Value::as_str),
            Some("easyaiconfig.asset-bundle.v1")
        );
        assert_eq!(
            provider.get("app").and_then(Value::as_str),
            Some("cc-switch")
        );
        assert_eq!(
            provider
                .get("payload")
                .and_then(|value| value.get("source"))
                .and_then(Value::as_str),
            Some("ccswitch-deeplink-v1")
        );
        assert_eq!(
            provider
                .get("counts")
                .and_then(|value| value.get("providers"))
                .and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            provider
                .get("payload")
                .and_then(|value| value.get("assets"))
                .and_then(|value| value.get("providers"))
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|item| item.get("baseUrl"))
                .and_then(Value::as_str),
            Some("https://openrouter.ai/api/v1")
        );
        assert_eq!(
            provider
                .get("payload")
                .and_then(|value| value.get("assets"))
                .and_then(|value| value.get("providers"))
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|item| item.get("config"))
                .and_then(|config| config.get("retry"))
                .and_then(Value::as_u64),
            Some(2)
        );
        assert_eq!(
            provider
                .get("payload")
                .and_then(|value| value.get("assets"))
                .and_then(|value| value.get("providers"))
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|item| item.get("apiKey"))
                .and_then(Value::as_str),
            Some("sk-from-deeplink")
        );

        let mcp = asset_import_preview(&json!({
          "url": "ccswitch://v1/import?resource=mcp&id=filesystem&command=npx&args=%5B%22-y%22%2C%22%40modelcontextprotocol%2Fserver-filesystem%22%5D&env=%7B%22ROOT_DIR%22%3A%22%2Ftmp%2Fproject%22%7D&apps=codex%2Cclaude-desktop&config=%7B%22roots%22%3A%5B%22%2Ftmp%2Fproject%22%5D%7D&enabled=false&tools=codex%2Cclaudecode",
        }))
        .expect("mcp preview");
        assert_eq!(
            mcp.get("counts")
                .and_then(|value| value.get("mcpServers"))
                .and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            mcp.get("payload")
                .and_then(|value| value.get("assets"))
                .and_then(|value| value.get("mcpServers"))
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|item| item.get("enabled"))
                .and_then(Value::as_bool),
            Some(false)
        );

        let prompt = asset_import_preview(&json!({
          "url": "ccswitch://v1/import?resource=prompt&tool=codex&fileName=AGENTS.md&scope=project&description=Project%20agent%20rules&enabled=true&content=%23%20Agents%0AUse%20repo%20rules.",
        }))
        .expect("prompt preview");
        assert_eq!(
            prompt
                .get("counts")
                .and_then(|value| value.get("prompts"))
                .and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            prompt
                .get("payload")
                .and_then(|value| value.get("assets"))
                .and_then(|value| value.get("prompts"))
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|item| item.get("enabled"))
                .and_then(Value::as_bool),
            Some(true)
        );

        let skill = asset_import_preview(&json!({
          "url": "ccswitch://v1/import?resource=skill&name=reviewer&skillMd=%23%20Reviewer%0AReview%20code%20changes.&repo=https%3A%2F%2Fgithub.com%2Fexample%2Fagent-skills&directory=reviewer&branch=main&installMode=copy&tools=codex",
        }))
        .expect("skill preview");
        assert_eq!(
            skill
                .get("counts")
                .and_then(|value| value.get("skills"))
                .and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            skill
                .get("payload")
                .and_then(|value| value.get("assets"))
                .and_then(|value| value.get("skills"))
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|item| item.get("branch"))
                .and_then(Value::as_str),
            Some("main")
        );
    }

    #[test]
    fn tauri_session_archive_moves_to_trash_and_restores() {
        let root = temp_routes_dir("session-archive");
        let gemini_home = root.join("gemini");
        let session_dir = gemini_home.join("sessions");
        let trash_root = root.join("trash");
        fs::create_dir_all(&session_dir).expect("create gemini session dir");
        let session_path = session_dir.join("gemini-restore.jsonl");
        fs::write(
            &session_path,
            r#"{"timestamp":"2026-07-05T12:00:00Z","cwd":"/tmp/project","model":"gemini-2.5-pro","role":"user","content":"restore this"}"#,
        )
        .expect("write gemini session");

        let preview = archive_session(&json!({
          "tool": "gemini",
          "sourcePath": path_string(&session_path),
          "sessionId": "gemini-restore",
          "geminiHome": path_string(&gemini_home),
          "trashRoot": path_string(&trash_root),
        }))
        .expect("preview session archive");
        assert_eq!(preview.get("dryRun").and_then(Value::as_bool), Some(true));
        assert!(path_exists(&session_path));

        let archived = archive_session(&json!({
          "tool": "gemini",
          "sourcePath": path_string(&session_path),
          "sessionId": "gemini-restore",
          "geminiHome": path_string(&gemini_home),
          "trashRoot": path_string(&trash_root),
          "dryRun": false,
        }))
        .expect("archive session");
        assert_eq!(
            archived
                .get("summary")
                .and_then(|value| value.get("archived"))
                .and_then(Value::as_u64),
            Some(1)
        );
        assert!(!path_exists(&session_path));
        assert!(!archived.to_string().contains("restore this"));
        let archive_id = archived
            .get("entry")
            .and_then(|value| value.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        assert!(!archive_id.is_empty());

        let trash = list_session_trash(&json!({ "trashRoot": path_string(&trash_root) }));
        assert_eq!(
            trash
                .get("summary")
                .and_then(|value| value.get("restorable"))
                .and_then(Value::as_u64),
            Some(1)
        );

        let restored = restore_session(&json!({
          "archiveId": archive_id,
          "geminiHome": path_string(&gemini_home),
          "trashRoot": path_string(&trash_root),
          "dryRun": false,
        }))
        .expect("restore session");
        assert_eq!(
            restored
                .get("summary")
                .and_then(|value| value.get("restored"))
                .and_then(Value::as_u64),
            Some(1)
        );
        assert!(path_exists(&session_path));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tauri_sync_snapshot_push_list_and_pull_preview() {
        let root = temp_routes_dir("sync-snapshot");
        let sync_dir = root.join("EasyAIConfig");
        fs::create_dir_all(&sync_dir).expect("create sync dir");
        let bundle = json!({
          "schema": "easyaiconfig.asset-bundle.v1",
          "app": "EasyAIConfig",
          "version": 1,
          "exportedAt": "2026-07-05T00:00:00Z",
          "assets": {
            "providerCatalog": {
              "schema": "easyaiconfig.provider-catalog.v1",
              "presets": [{ "id": "demo", "name": "Demo" }],
            },
          },
        });

        let preview = push_sync_snapshot(&json!({
          "targetPath": path_string(&sync_dir),
          "snapshotId": "demo-sync",
          "bundle": bundle,
        }))
        .expect("preview sync push");
        assert_eq!(preview.get("dryRun").and_then(Value::as_bool), Some(true));
        assert!(!path_exists(&sync_dir.join("manifest.json")));

        let pushed = push_sync_snapshot(&json!({
          "targetPath": path_string(&sync_dir),
          "snapshotId": "demo-sync",
          "bundle": bundle,
          "dryRun": false,
        }))
        .expect("push sync snapshot");
        assert_eq!(
            pushed
                .get("summary")
                .and_then(|value| value.get("pushed"))
                .and_then(Value::as_u64),
            Some(1)
        );
        assert!(path_exists(&sync_dir.join("manifest.json")));

        let listed = list_sync_snapshots(&json!({ "targetPath": path_string(&sync_dir) }))
            .expect("list sync snapshots");
        assert_eq!(
            listed
                .get("summary")
                .and_then(|value| value.get("latestSnapshotId"))
                .and_then(Value::as_str),
            Some("demo-sync")
        );

        let pulled = pull_sync_snapshot(&json!({
          "targetPath": path_string(&sync_dir),
          "snapshotId": "demo-sync",
        }))
        .expect("pull sync snapshot preview");
        assert_eq!(
            pulled
                .get("importResult")
                .and_then(|value| value.get("summary"))
                .and_then(|value| value.get("totalProviders"))
                .and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(pulled.get("changed").and_then(Value::as_bool), Some(false));

        let _ = fs::remove_dir_all(root);
    }
}

async fn dispatch(
    app: tauri::AppHandle,
    path: &str,
    method: &str,
    query: &Value,
    body: &Value,
) -> Result<Value, String> {
    match (path, method) {
        ("/api/setup/check", "GET") => check_setup_environment(query),
        ("/api/state", "GET") => load_state(query),
        ("/api/path/pick-directory", "POST") => pick_directory(app, body),
        ("/api/provider/test", "POST") => detect_provider(body).await,
        ("/api/provider/secret", "POST") => get_provider_secret(body),
        ("/api/provider/test-saved", "POST") => test_saved_provider(body).await,
        ("/api/provider/remote-usage", "POST") => query_saved_provider_remote_usage(body).await,
        ("/api/provider/remote-usage/cache", "GET") => list_provider_remote_usage_cache(query),
        ("/api/provider/remote-usage/cache", "POST") => save_provider_remote_usage_cache(body),
        ("/api/provider/remote-usage/credential", "GET") => {
            get_provider_remote_usage_credential(query)
        }
        ("/api/provider/remote-usage/credential", "POST") => {
            save_provider_remote_usage_credential(body)
        }
        ("/api/provider/remote-usage/credential", "DELETE") => {
            delete_provider_remote_usage_credential(body)
        }
        ("/api/provider-router/status", "GET") => query_provider_router_status(query),
        ("/api/provider-router/logs", "GET") => query_provider_router_logs(query),
        ("/api/provider-router/logs/clear", "POST") => clear_provider_router_logs(body),
        ("/api/provider-router/start", "POST") => start_provider_router(body),
        ("/api/provider-router/probe", "POST") => probe_provider_router(body),
        ("/api/provider-router/stop", "POST") => stop_provider_router(body),
        ("/api/provider-router/apply-client", "POST") => apply_provider_router_client_config(body),
        ("/api/local-routing/response-rectifier/preview", "POST") => {
            preview_router_response_rectifier(body)
        }
        ("/api/gemini/state", "GET") => load_gemini_state(query),
        ("/api/hermes/state", "GET") => load_hermes_state(query),
        ("/api/hermes/launch", "POST") => launch_hermes(body),
        ("/api/gemini/launch", "POST") => launch_gemini(body),
        ("/api/gemini/install", "POST") => {
            npm_install_package_latest(GEMINI_CLI_PACKAGE, false, false)
        }
        ("/api/gemini/reinstall", "POST") => {
            npm_install_package_latest(GEMINI_CLI_PACKAGE, false, true)
        }
        ("/api/gemini/update", "POST") => {
            npm_install_package_latest(GEMINI_CLI_PACKAGE, false, false)
        }
        ("/api/gemini/update-domestic", "POST") => {
            npm_install_package_latest(GEMINI_CLI_PACKAGE, true, false)
        }
        ("/api/gemini/install-version", "POST") => {
            npm_install_package_version(GEMINI_CLI_PACKAGE, body, false)
        }
        ("/api/gemini/install-version-domestic", "POST") => {
            npm_install_package_version(GEMINI_CLI_PACKAGE, body, true)
        }
        ("/api/gemini/uninstall", "POST") => npm_uninstall_package(GEMINI_CLI_PACKAGE),
        ("/api/qwen-code/install", "POST") => {
            npm_install_package_latest(QWEN_CODE_PACKAGE, false, false)
        }
        ("/api/qwen-code/reinstall", "POST") => {
            npm_install_package_latest(QWEN_CODE_PACKAGE, false, true)
        }
        ("/api/qwen-code/update", "POST") => {
            npm_install_package_latest(QWEN_CODE_PACKAGE, false, false)
        }
        ("/api/qwen-code/update-domestic", "POST") => {
            npm_install_package_latest(QWEN_CODE_PACKAGE, true, false)
        }
        ("/api/qwen-code/install-version", "POST") => {
            npm_install_package_version(QWEN_CODE_PACKAGE, body, false)
        }
        ("/api/qwen-code/install-version-domestic", "POST") => {
            npm_install_package_version(QWEN_CODE_PACKAGE, body, true)
        }
        ("/api/qwen-code/uninstall", "POST") => npm_uninstall_package(QWEN_CODE_PACKAGE),
        ("/api/codebuddy-code/install", "POST") => {
            npm_install_package_latest(CODEBUDDY_CODE_PACKAGE, false, false)
        }
        ("/api/codebuddy-code/reinstall", "POST") => {
            npm_install_package_latest(CODEBUDDY_CODE_PACKAGE, false, true)
        }
        ("/api/codebuddy-code/update", "POST") => {
            npm_install_package_latest(CODEBUDDY_CODE_PACKAGE, false, false)
        }
        ("/api/codebuddy-code/update-domestic", "POST") => {
            npm_install_package_latest(CODEBUDDY_CODE_PACKAGE, true, false)
        }
        ("/api/codebuddy-code/install-version", "POST") => {
            npm_install_package_version(CODEBUDDY_CODE_PACKAGE, body, false)
        }
        ("/api/codebuddy-code/install-version-domestic", "POST") => {
            npm_install_package_version(CODEBUDDY_CODE_PACKAGE, body, true)
        }
        ("/api/codebuddy-code/uninstall", "POST") => npm_uninstall_package(CODEBUDDY_CODE_PACKAGE),
        ("/api/assets/index", "GET") => asset_index(query),
        ("/api/assets/export", "GET") => asset_export(query),
        ("/api/assets/import/preview", "GET") => asset_import_preview(query),
        ("/api/assets/import/preview", "POST") => asset_import_preview(body),
        ("/api/assets/import/apply", "POST") => asset_import_apply(body),
        ("/api/assets/deep-link/build", "POST") => asset_deep_link_build(body),
        ("/api/mcp/sync-plan", "GET") => Ok(mcp_sync_plan(query)),
        ("/api/sync/targets", "GET") => Ok(list_sync_targets()),
        ("/api/sync/targets", "POST") => save_sync_targets(body),
        ("/api/sync/snapshots", "GET") => list_sync_snapshots(query),
        ("/api/sync/push", "POST") => push_sync_snapshot(body),
        ("/api/sync/pull", "POST") => pull_sync_snapshot(body),
        ("/api/sessions/inventory", "GET") => Ok(session_inventory(query)),
        ("/api/sessions/trash", "GET") => Ok(list_session_trash(query)),
        ("/api/sessions/archive", "POST") => archive_session(body),
        ("/api/sessions/restore", "POST") => restore_session(body),
        ("/api/provider/model-eval", "POST") => {
            let tool = body
                .get("tool")
                .and_then(Value::as_str)
                .unwrap_or("codex")
                .trim()
                .to_lowercase();
            if tool == "claudecode" {
                model_eval_claudecode_provider(body).await
            } else {
                model_eval_saved_provider(body).await
            }
        }
        ("/api/config/read-file", "GET") => read_config_file(query),
        ("/api/config/write-file", "POST") => write_config_file(body),
        ("/api/config/save", "POST") => save_config(body),
        ("/api/config/set-default-model", "POST") => set_default_model(body),
        ("/api/config/delete-provider", "POST") => delete_codex_provider(body),
        ("/api/config/use-oauth", "POST") => use_oauth_config(body),
        ("/api/config/raw-save", "POST") => save_raw_config(body),
        ("/api/config/settings-save", "POST") => save_settings(body),

        ("/api/tools", "GET") => list_tools(),
        ("/api/tools/updates", "GET") => {
            tokio::task::spawn_blocking(move || get_tool_updates_info())
                .await
                .map_err(|e| format!("spawn_blocking error: {}", e))?
        }
        ("/api/codex/install", "POST") => {
            codex_npm_action(&["install", "-g", OPENAI_CODEX_PACKAGE])
        }
        ("/api/codex/release", "GET") => get_codex_release_info(),
        ("/api/codex/reinstall", "POST") => {
            codex_npm_action(&["install", "-g", OPENAI_CODEX_PACKAGE, "--force"])
        }
        ("/api/codex/update", "POST") => {
            codex_npm_action(&["install", "-g", &format!("{}@latest", OPENAI_CODEX_PACKAGE)])
        }
        ("/api/codex/update-domestic", "POST") => codex_npm_action(&[
            "install",
            "-g",
            &format!("{}@latest", OPENAI_CODEX_PACKAGE),
            "--registry",
            NPM_REGISTRY_CN,
        ]),
        ("/api/codex/install-version", "POST") => {
            npm_install_package_version(OPENAI_CODEX_PACKAGE, body, false)
        }
        ("/api/codex/install-version-domestic", "POST") => {
            npm_install_package_version(OPENAI_CODEX_PACKAGE, body, true)
        }
        ("/api/codex/uninstall", "POST") => {
            codex_npm_action(&["uninstall", "-g", OPENAI_CODEX_PACKAGE])
        }
        ("/api/codex/launch", "POST") => launch_codex(body),
        ("/api/codex/login", "POST") => login_codex(body),
        ("/api/codex/oauth/profiles", "GET") => list_oauth_profiles(query),
        ("/api/codex/oauth/profiles/create", "POST") => create_oauth_profile(body),
        ("/api/codex/oauth/profiles/save-current", "POST") => save_current_oauth_profile(body),
        ("/api/codex/oauth/profiles/switch", "POST") => switch_oauth_profile(body),
        ("/api/codex/oauth/profiles/rename", "POST") => rename_oauth_profile(body),
        ("/api/codex/oauth/profiles/delete", "POST") => delete_oauth_profile(body),
        ("/api/codex/oauth/usage", "POST") => query_codex_oauth_usage(body).await,
        ("/api/provider/probe-history", "GET") => crate::provider_health::get_probe_history(query),
        ("/api/provider/probe-summary", "GET") => crate::provider_health::get_probe_summary(query),
        ("/api/tray/refresh", "POST") => crate::tray::refresh_menu(&app, body),
        ("/api/terminal/token-snapshot", "GET") => crate::terminal::terminal_token_snapshot(query),
        ("/api/terminal/persisted", "GET") => crate::terminal_persist::list_persisted(query),
        ("/api/terminal/persist", "POST") => crate::terminal_persist::persist_session(body),
        ("/api/terminal/forget", "POST") => crate::terminal_persist::forget_session(body),
        ("/api/provider/saved-models", "GET") => crate::provider_models::list_saved_models(query),
        ("/api/provider/saved-models", "POST") => {
            crate::provider_models::save_provider_models(body)
        }
        ("/api/codex/sessions", "GET") => list_codex_sessions(query),
        ("/api/codex/session-detail", "GET") => get_codex_session_detail(query),
        ("/api/codex/resume", "POST") => resume_codex_session(body),
        ("/api/codex/fork", "POST") => fork_codex_session(body),
        ("/api/codex/session-export", "POST") => export_codex_session(body),
        ("/api/codex/session-homes", "GET") => list_codex_session_homes(query),
        ("/api/codex/sessions/migrate", "POST") => migrate_codex_sessions(body),
        ("/api/dashboard/codex-usage", "GET") => get_codex_usage_metrics(query),
        ("/api/codex-app/state", "GET") => get_codex_app_state(),
        ("/api/codex-app/install/start", "POST") => start_codex_app_install_task(body),
        ("/api/codex-app/install/status", "GET") => get_codex_app_install_task(query),
        ("/api/codex-app/install/cancel", "POST") => cancel_codex_app_install_task(body),
        ("/api/codex-app/install", "POST") => install_codex_app(body),
        ("/api/codex-app/open", "POST") => open_codex_app(body),
        ("/api/claudecode/state", "GET") => load_claudecode_state(query),
        ("/api/claudecode/config-save", "POST") => save_claudecode_config(body),
        ("/api/claudecode/raw-save", "POST") => save_claudecode_raw_config(body),
        ("/api/claudecode/provider-delete", "POST") => delete_claudecode_provider(body),
        ("/api/claudecode/install", "POST") => {
            codex_npm_action(&["install", "-g", CLAUDE_CODE_PACKAGE])
        }
        ("/api/claudecode/reinstall", "POST") => {
            codex_npm_action(&["install", "-g", CLAUDE_CODE_PACKAGE, "--force"])
        }
        ("/api/claudecode/update", "POST") => {
            codex_npm_action(&["install", "-g", &format!("{}@latest", CLAUDE_CODE_PACKAGE)])
        }
        ("/api/claudecode/update-domestic", "POST") => codex_npm_action(&[
            "install",
            "-g",
            &format!("{}@latest", CLAUDE_CODE_PACKAGE),
            "--registry",
            NPM_REGISTRY_CN,
        ]),
        ("/api/claudecode/install-version", "POST") => {
            npm_install_package_version(CLAUDE_CODE_PACKAGE, body, false)
        }
        ("/api/claudecode/install-version-domestic", "POST") => {
            npm_install_package_version(CLAUDE_CODE_PACKAGE, body, true)
        }
        ("/api/claudecode/uninstall", "POST") => {
            codex_npm_action(&["uninstall", "-g", CLAUDE_CODE_PACKAGE])
        }
        ("/api/claudecode/launch", "POST") => launch_claudecode(body),
        ("/api/claude-desktop/launch", "POST") => launch_claude_desktop(body),
        ("/api/claudecode/login", "POST") => login_claudecode(body),
        ("/api/claudecode/oauth/profiles", "GET") => list_claudecode_oauth_profiles(query),
        ("/api/claudecode/oauth/profiles/create", "POST") => create_claudecode_oauth_profile(body),
        ("/api/claudecode/oauth/profiles/switch", "POST") => switch_claudecode_oauth_profile(body),
        ("/api/claudecode/oauth/profiles/rename", "POST") => rename_claudecode_oauth_profile(body),
        ("/api/claudecode/oauth/profiles/delete", "POST") => delete_claudecode_oauth_profile(body),
        ("/api/opencode/state", "GET") => load_opencode_state(query),
        ("/api/opencode/config-save", "POST") => save_opencode_config(body),
        ("/api/opencode/raw-save", "POST") => save_opencode_raw_config(body),
        ("/api/opencode/install/start", "POST") => start_opencode_install_task(body),
        ("/api/opencode/install/status", "GET") => get_opencode_install_task(query),
        ("/api/opencode/install/cancel", "POST") => cancel_opencode_install_task(body),
        ("/api/opencode/install", "POST") => install_opencode(body),
        ("/api/opencode/reinstall", "POST") => reinstall_opencode(body),
        ("/api/opencode/update", "POST") => update_opencode(body),
        ("/api/opencode/install-version", "POST") => {
            npm_install_package_version(OPENCODE_PACKAGE, body, false)
        }
        ("/api/opencode/install-version-domestic", "POST") => {
            npm_install_package_version(OPENCODE_PACKAGE, body, true)
        }
        ("/api/opencode/uninstall", "POST") => uninstall_opencode(body),
        ("/api/opencode/launch", "POST") => launch_opencode(body),
        ("/api/opencode/login", "POST") => login_opencode(body),
        ("/api/opencode/auth-remove", "POST") => remove_opencode_auth(body),
        // OpenClaw — wrapped in spawn_blocking because load_openclaw_state uses reqwest::blocking
        // which deadlocks inside Tokio async runtime
        ("/api/openclaw/state", "GET") => {
            tokio::task::spawn_blocking(move || load_openclaw_state())
                .await
                .map_err(|e| format!("spawn_blocking error: {}", e))?
        }
        ("/api/openclaw/config-save", "POST") => save_openclaw_config(body),
        ("/api/openclaw/dashboard-url", "POST") => get_openclaw_dashboard_url(body),
        ("/api/openclaw/repair-dashboard-auth", "POST") => repair_openclaw_dashboard_auth(body),
        ("/api/openclaw/install", "POST") => run_openclaw_install_script(body),
        ("/api/openclaw/install/start", "POST") => start_openclaw_install_task(body),
        ("/api/openclaw/install/status", "GET") => get_openclaw_install_task(query),
        ("/api/openclaw/install/cancel", "POST") => cancel_openclaw_install_task(body),
        ("/api/openclaw/install/remote", "POST") => install_openclaw_remote(body),
        ("/api/openclaw/update", "POST") => {
            codex_npm_action(&["install", "-g", &format!("{}@latest", OPENCLAW_PACKAGE)])
        }
        ("/api/openclaw/update-domestic", "POST") => codex_npm_action(&[
            "install",
            "-g",
            &format!("{}@latest", OPENCLAW_PACKAGE),
            "--registry",
            NPM_REGISTRY_CN,
        ]),
        ("/api/openclaw/install-version", "POST") => {
            npm_install_package_version(OPENCLAW_PACKAGE, body, false)
        }
        ("/api/openclaw/install-version-domestic", "POST") => {
            npm_install_package_version(OPENCLAW_PACKAGE, body, true)
        }
        ("/api/openclaw/reinstall", "POST") => {
            codex_npm_action(&["install", "-g", OPENCLAW_PACKAGE, "--force"])
        }
        ("/api/openclaw/uninstall", "POST") => uninstall_openclaw(body),
        ("/api/openclaw/launch", "POST") => {
            let body_clone = body.clone();
            tokio::task::spawn_blocking(move || launch_openclaw(&body_clone))
                .await
                .map_err(|e| format!("spawn_blocking error: {}", e))?
        }
        ("/api/openclaw/onboard", "POST") => onboard_openclaw(body),
        ("/api/openclaw/stop", "POST") => stop_openclaw_gateway(),
        ("/api/openclaw/port-kill", "POST") => kill_openclaw_port_occupants(body),
        ("/api/system/storage", "GET") => get_system_storage_state(),
        ("/api/system/cleanup", "POST") => cleanup_system_storage(body),
        ("/api/open-url", "POST") => open_url_in_browser(body),
        ("/api/backups", "GET") => list_backups(),
        ("/api/backups/restore", "POST") => restore_backup(body),
        // Network probes do synchronous blocking HTTP via reqwest::blocking. If
        // we called them directly from this async dispatch they'd risk nesting
        // tokio runtimes and deadlocking (which would look like a timeout to the
        // user — exactly the "无法获取 IP" report). spawn_blocking moves them to
        // a worker thread so the main reactor stays live.
        ("/api/network/status", "GET") => {
            let q = query.clone();
            tokio::task::spawn_blocking(move || get_network_status(&q))
                .await
                .map_err(|e| format!("spawn_blocking: {}", e))?
        }
        ("/api/network/check", "POST") => {
            let b = body.clone();
            tokio::task::spawn_blocking(move || refresh_network_status(&b))
                .await
                .map_err(|e| format!("spawn_blocking: {}", e))?
        }
        ("/api/network/latency", "GET") => {
            let q = query.clone();
            tokio::task::spawn_blocking(move || get_network_latency(&q))
                .await
                .map_err(|e| format!("spawn_blocking: {}", e))?
        }
        ("/api/network/ip-history", "GET") => list_network_ip_history(query),
        ("/api/app-settings", "GET") => load_app_settings(query),
        ("/api/app-settings", "POST") => save_app_settings(body),
        ("/api/terminal/create", "POST") => terminal_create(body),
        ("/api/terminal/list", "GET") => terminal_list(query),
        ("/api/terminal/read", "GET") => terminal_read(query),
        ("/api/terminal/write", "POST") => terminal_write(body),
        ("/api/terminal/resize", "POST") => terminal_resize(body),
        ("/api/terminal/close", "POST") => terminal_close(body),
        ("/api/shell-integration/status", "GET") => shell_integration_status(query),
        ("/api/shell-integration/enable", "POST") => enable_shell_integration(body),
        ("/api/shell-integration/disable", "POST") => disable_shell_integration(body),
        ("/api/system/processes", "GET") => list_processes(query),
        ("/api/system/process-kill", "POST") => kill_process(body),
        ("/api/codex/session-stats", "GET") => codex_session_stats(query),
        ("/api/claudecode/local-usage", "GET") => claudecode_local_usage(query),
        ("/api/app/update", "GET") => get_app_update_info(app).await,
        ("/api/app/update", "POST") => install_app_update(app).await,
        ("/api/app/update/progress", "GET") => get_app_update_progress(),

        // ─── Per-project Provider binding (P0 #3 ⭐) ─────────────────
        ("/api/project-binding", "GET") => crate::project_bindings::get_project_binding(query),
        ("/api/project-binding", "POST") => crate::project_bindings::set_project_binding(body),
        ("/api/project-binding", "DELETE") => crate::project_bindings::remove_project_binding(body),
        ("/api/project-bindings", "GET") => crate::project_bindings::list_project_bindings(query),
        ("/api/project-binding/summary", "GET") => {
            crate::project_bindings::summarize_binding_for_cwd(query)
        }

        _ => Err(format!("Unsupported request: {method} {path}")),
    }
}

#[tauri::command]
pub(crate) async fn backend_request(
    app: tauri::AppHandle,
    path: String,
    method: Option<String>,
    query: Option<Value>,
    body: Option<Value>,
) -> Value {
    let query_value = query.unwrap_or_else(|| json!({}));
    let body_value = body.unwrap_or_else(|| json!({}));
    match dispatch(
        app,
        &path,
        method.as_deref().unwrap_or("GET"),
        &query_value,
        &body_value,
    )
    .await
    {
        Ok(data) => ok(data),
        Err(error) => fail(error),
    }
}
