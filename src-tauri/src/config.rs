use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use toml::Value as TomlValue;

use crate::codex::find_codex_binary_with_options;
use crate::provider::{
  detect_saved_provider, find_provider_entry_by_base_url, flatten_auth_json, get_string,
  infer_env_key, infer_provider_label, infer_provider_seed, normalize_base_url,
  reveal_provider_api_key, slugify_provider_key, summarize_providers,
};
use crate::provider_eval::run_model_authenticity_eval;
use crate::{
  app_home, apply_patch, backups_root, default_codex_home, ensure_dir, ensure_secret_dir,
  expand_home_path, home_dir, normalize_settings_patch, parse_env, parse_json_object,
  parse_toml_config, read_text, stringify_env, stringify_toml_config, timestamp, write_secret,
};

struct ScopePaths {
  scope: String,
  root_path: PathBuf,
  config_path: PathBuf,
  env_path: PathBuf,
  auth_path: PathBuf,
}

const PROJECT_IGNORED_CODEX_CONFIG_KEYS: &[&str] = &[
  "openai_base_url",
  "chatgpt_base_url",
  "apps_mcp_product_sku",
  "model_provider",
  "model_providers",
  "notify",
  "profile",
  "profiles",
  "experimental_realtime_ws_base_url",
  "otel",
];

const LOCAL_ROUTER_NO_PROXY_ITEMS: &[&str] = &["127.0.0.1", "localhost", "::1"];

fn is_loopback_base_url(base_url: &str) -> bool {
  let value = base_url.trim().to_ascii_lowercase();
  value.starts_with("http://127.")
    || value.starts_with("http://localhost")
    || value.starts_with("http://[::1]")
    || value.starts_with("https://127.")
    || value.starts_with("https://localhost")
    || value.starts_with("https://[::1]")
}

fn append_no_proxy_items(current: &str) -> String {
  let mut items = current
    .split(',')
    .map(|item| item.trim().to_string())
    .filter(|item| !item.is_empty())
    .collect::<Vec<_>>();
  for item in LOCAL_ROUTER_NO_PROXY_ITEMS {
    if !items.iter().any(|existing| existing.eq_ignore_ascii_case(item)) {
      items.push((*item).to_string());
    }
  }
  items.join(",")
}

fn ensure_local_router_no_proxy(env: &mut BTreeMap<String, String>) -> bool {
  let mut changed = false;
  for key in ["NO_PROXY", "no_proxy"] {
    let next = append_no_proxy_items(env.get(key).map(String::as_str).unwrap_or_default());
    if env.get(key).map(String::as_str) != Some(next.as_str()) {
      env.insert(key.to_string(), next);
      changed = true;
    }
  }
  changed
}

fn normalize_settings_patch_for_scope(patch: &Value, scope: &str) -> Value {
  let mut normalized = normalize_settings_patch(patch);
  if scope != "project" {
    return normalized;
  }

  if let Some(object) = normalized.as_object_mut() {
    for key in PROJECT_IGNORED_CODEX_CONFIG_KEYS {
      let should_remove = object.get(*key).map(|value| !value.is_null()).unwrap_or(false);
      if should_remove {
        object.remove(*key);
      }
    }
  }
  normalized
}

fn scope_paths_json(paths: &ScopePaths) -> Value {
  json!({
    "scope": paths.scope.clone(),
    "rootPath": paths.root_path.to_string_lossy().to_string(),
    "configPath": paths.config_path.to_string_lossy().to_string(),
    "envPath": paths.env_path.to_string_lossy().to_string(),
    "authPath": paths.auth_path.to_string_lossy().to_string(),
  })
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

fn allowed_path_roots() -> Vec<PathBuf> {
  let mut roots = vec![home_dir().unwrap_or_else(|_| PathBuf::from(".")), std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")), PathBuf::from("/tmp"), PathBuf::from("/var/tmp")];
  if cfg!(target_os = "windows") {
    if let Ok(value) = std::env::var("TEMP") {
      if !value.trim().is_empty() {
        roots.push(PathBuf::from(value));
      }
    }
    if let Ok(value) = std::env::var("TMP") {
      if !value.trim().is_empty() {
        roots.push(PathBuf::from(value));
      }
    }
  }
  roots
}

fn assert_allowed_path(input: &Path, param_name: &str) -> Result<PathBuf, String> {
  let normalized = input.to_path_buf();
  let allowed = allowed_path_roots();
  if allowed.iter().any(|root| normalized == *root || normalized.starts_with(root)) {
    return Ok(normalized);
  }
  Err(format!("Invalid {}: path traversal detected", param_name))
}

fn resolve_backup_dir(backup_name: &str) -> Result<PathBuf, String> {
  let trimmed = backup_name.trim();
  if trimmed.is_empty() {
    return Err("Backup name is required".to_string());
  }
  let candidate = Path::new(trimmed);
  if candidate.components().count() != 1 {
    return Err("Invalid backup name".to_string());
  }
  Ok(backups_root()?.join(trimmed))
}

fn scope_paths(scope: &str, project_path: &str, codex_home: &Path) -> Result<ScopePaths, String> {
  let codex_home = assert_allowed_path(codex_home, "codexHome")?;
  if scope == "project" {
    if project_path.trim().is_empty() {
      return Err("Project path is required for project scope".to_string());
    }
    // 支持用户传入 `~/Projects/foo` 这种带 ~ 的项目路径。
    let expanded_project_path = expand_home_path(project_path)
      .ok_or_else(|| "Project path is required for project scope".to_string())?;
    let root_path = assert_allowed_path(expanded_project_path.as_path(), "projectPath")?;
    return Ok(ScopePaths {
      scope: "project".to_string(),
      root_path: root_path.clone(),
      config_path: root_path.join(".codex").join("config.toml"),
      env_path: codex_home.join(".env"),
      auth_path: codex_home.join("auth.json"),
    });
  }

  Ok(ScopePaths {
    scope: "global".to_string(),
    root_path: codex_home.clone(),
    config_path: codex_home.join("config.toml"),
    env_path: codex_home.join(".env"),
    auth_path: codex_home.join("auth.json"),
  })
}

fn create_backup(paths: &ScopePaths) -> Result<String, String> {
  // 备份目录与 .env.bak / auth.json.bak / config.toml.bak 都可能含 API key / OAuth token，
  // 必须把目录设 0700、文件设 0600，否则共享机上其他用户能 `cat` 到。
  let backups_root_path = backups_root()?;
  ensure_secret_dir(&backups_root_path)?;
  let target_dir = backups_root_path.join(format!("{}-{}", timestamp(), paths.scope));
  ensure_secret_dir(&target_dir)?;
  write_secret(&target_dir.join("config.toml.bak"), &read_text(&paths.config_path)?)?;
  write_secret(&target_dir.join(".env.bak"), &read_text(&paths.env_path)?)?;
  if paths.auth_path.is_file() {
    write_secret(&target_dir.join("auth.json.bak"), &read_text(&paths.auth_path)?)?;
  }
  Ok(target_dir.to_string_lossy().to_string())
}

fn launch_platform_id() -> &'static str {
  if cfg!(target_os = "windows") {
    "win32"
  } else if cfg!(target_os = "macos") {
    "darwin"
  } else {
    "linux"
  }
}

#[cfg(target_os = "macos")]
fn macos_application_roots() -> Vec<PathBuf> {
  let mut roots = vec![
    PathBuf::from("/Applications"),
    PathBuf::from("/Applications/Utilities"),
    PathBuf::from("/System/Applications"),
    PathBuf::from("/System/Applications/Utilities"),
  ];
  if let Ok(home) = home_dir() {
    roots.push(home.join("Applications"));
  }
  roots
}

#[cfg(target_os = "macos")]
fn find_macos_application(app_names: &[&str]) -> Option<(String, String)> {
  for name in app_names {
    let app_name = name.trim().trim_end_matches(".app");
    if app_name.is_empty() {
      continue;
    }
    for root in macos_application_roots() {
      let candidate = root.join(format!("{}.app", app_name));
      if candidate.exists() {
        return Some((app_name.to_string(), candidate.to_string_lossy().to_string()));
      }
    }
  }
  None
}

fn command_exists_for_launch(command: &str) -> Option<String> {
  let trimmed = command.trim();
  if trimmed.is_empty() {
    return None;
  }
  if trimmed.contains('/') {
    let path = Path::new(trimmed);
    return path.exists().then(|| trimmed.to_string());
  }
  let mut paths: Vec<PathBuf> = env::var_os("PATH")
    .map(|value| env::split_paths(&value).collect())
    .unwrap_or_default();
  paths.extend([
    PathBuf::from("/opt/homebrew/bin"),
    PathBuf::from("/usr/local/bin"),
    PathBuf::from("/usr/bin"),
    PathBuf::from("/bin"),
  ]);
  for dir in paths {
    let candidate = dir.join(trimmed);
    if candidate.exists() {
      return Some(candidate.to_string_lossy().to_string());
    }
  }
  None
}

#[cfg(target_os = "macos")]
fn first_macos_command_or_bundle(command_names: &[&str], app: &Option<(String, String)>, executable_names: &[&str]) -> String {
  for command in command_names {
    if let Some(found) = command_exists_for_launch(command) {
      return found;
    }
  }
  if let Some((_, app_path)) = app {
    for executable in executable_names {
      let candidate = Path::new(app_path).join("Contents").join("MacOS").join(executable);
      if candidate.exists() {
        return candidate.to_string_lossy().to_string();
      }
    }
  }
  String::new()
}

#[cfg(target_os = "macos")]
fn macos_app_profile(id: &str, label: &str, app_names: &[&str]) -> Value {
  let app = find_macos_application(app_names);
  let (app_name, app_path) = app.clone().unwrap_or_else(|| (app_names.first().copied().unwrap_or(label).to_string(), String::new()));
  json!({
    "id": id,
    "label": label,
    "available": app.is_some(),
    "command": app_name,
    "appName": app_name,
    "appPath": app_path,
    "launchMode": "type-command",
  })
}

fn launch_terminal_profiles() -> Value {
  if cfg!(target_os = "windows") {
    return json!([
      { "id": "auto", "label": "应用内终端（推荐）" }
    ]);
  }
  if cfg!(target_os = "macos") {
    #[cfg(target_os = "macos")]
    {
      let terminal_app = find_macos_application(&["Terminal"]);
      let iterm_app = find_macos_application(&["iTerm", "iTerm2"]);
      let wezterm_app = find_macos_application(&["WezTerm"]);
      let ghostty_app = find_macos_application(&["Ghostty"]);
      let alacritty_app = find_macos_application(&["Alacritty"]);
      let kitty_app = find_macos_application(&["kitty"]);
      let wezterm = first_macos_command_or_bundle(&["wezterm"], &wezterm_app, &["wezterm"]);
      let ghostty = first_macos_command_or_bundle(&["ghostty"], &ghostty_app, &["ghostty"]);
      let alacritty = first_macos_command_or_bundle(&["alacritty"], &alacritty_app, &["alacritty"]);
      let kitty = first_macos_command_or_bundle(&["kitty"], &kitty_app, &["kitty"]);
      let mut profiles = vec![
        json!({ "id": "auto", "label": "自动选择（推荐）", "available": true }),
        json!({
          "id": "terminal",
          "label": "Terminal.app",
          "available": terminal_app.is_some(),
          "command": "Terminal",
          "appName": "Terminal",
          "appPath": terminal_app.as_ref().map(|(_, p)| p.clone()).unwrap_or_default(),
          "launchMode": "applescript",
        }),
        json!({
          "id": "iterm",
          "label": if iterm_app.as_ref().map(|(n, _)| n.as_str()) == Some("iTerm2") { "iTerm2" } else { "iTerm" },
          "available": iterm_app.is_some(),
          "command": "iTerm",
          "appName": iterm_app.as_ref().map(|(n, _)| n.clone()).unwrap_or_else(|| "iTerm".to_string()),
          "appPath": iterm_app.as_ref().map(|(_, p)| p.clone()).unwrap_or_default(),
          "launchMode": "applescript",
        }),
        macos_app_profile("termius", "Termius", &["Termius"]),
        macos_app_profile("terminus", "Terminus", &["Terminus"]),
        macos_app_profile("tabby", "Tabby / Terminus", &["Tabby"]),
        macos_app_profile("warp", "Warp", &["Warp"]),
        macos_app_profile("hyper", "Hyper", &["Hyper"]),
        json!({ "id": "wezterm", "label": "WezTerm", "available": !wezterm.is_empty(), "command": wezterm, "appName": "WezTerm", "appPath": wezterm_app.as_ref().map(|(_, p)| p.clone()).unwrap_or_default(), "launchMode": "cli" }),
        json!({ "id": "ghostty", "label": "Ghostty", "available": !ghostty.is_empty(), "command": ghostty, "appName": "Ghostty", "appPath": ghostty_app.as_ref().map(|(_, p)| p.clone()).unwrap_or_default(), "launchMode": "cli" }),
        json!({ "id": "alacritty", "label": "Alacritty", "available": !alacritty.is_empty(), "command": alacritty, "appName": "Alacritty", "appPath": alacritty_app.as_ref().map(|(_, p)| p.clone()).unwrap_or_default(), "launchMode": "cli" }),
        json!({ "id": "kitty", "label": "kitty", "available": !kitty.is_empty(), "command": kitty, "appName": "kitty", "appPath": kitty_app.as_ref().map(|(_, p)| p.clone()).unwrap_or_default(), "launchMode": "cli" }),
      ];
      profiles.retain(|profile| profile.get("id").and_then(Value::as_str) == Some("auto")
        || profile.get("available").and_then(Value::as_bool).unwrap_or(false));
      return Value::Array(profiles);
    }
  }
  if cfg!(target_os = "linux") {
    let specs = [
      ("x-terminal-emulator", "系统默认终端", "x-terminal-emulator"),
      ("gnome-terminal", "GNOME Terminal", "gnome-terminal"),
      ("konsole", "Konsole", "konsole"),
      ("wezterm", "WezTerm", "wezterm"),
      ("alacritty", "Alacritty", "alacritty"),
      ("kitty", "kitty", "kitty"),
      ("tilix", "Tilix", "tilix"),
      ("xfce4-terminal", "Xfce Terminal", "xfce4-terminal"),
      ("lxterminal", "LXTerminal", "lxterminal"),
      ("xterm", "xterm", "xterm"),
    ];
    let mut profiles = vec![json!({ "id": "auto", "label": "自动选择（推荐）", "available": true })];
    for (id, label, command) in specs {
      if let Some(found) = command_exists_for_launch(command) {
        profiles.push(json!({
          "id": id,
          "label": label,
          "available": true,
          "command": found,
          "launchMode": "cli",
        }));
      }
    }
    return Value::Array(profiles);
  }
  json!([])
}


pub(crate) fn load_state(query: &Value) -> Result<Value, String> {
  let query_object = parse_json_object(query);
  let scope = get_string(&query_object, "scope");
  let project_path = get_string(&query_object, "projectPath");
  let codex_home = {
    let input = get_string(&query_object, "codexHome");
    expand_home_path(&input).map_or_else(default_codex_home, Ok)?
  };
  ensure_dir(&codex_home)?;

  let paths = scope_paths(if scope.is_empty() { "global" } else { &scope }, &project_path, &codex_home)?;
  let config_content = read_text(&paths.config_path)?;
  let env_content = read_text(&paths.env_path)?;
  let auth_content = read_text(&paths.auth_path)?;
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
  let codex_binary = find_codex_binary_with_options(cfg!(target_os = "windows"));
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
    "authPath": paths.auth_path.to_string_lossy().to_string(),
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
      "platform": launch_platform_id(),
      "terminalProfiles": launch_terminal_profiles(),
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
    expand_home_path(&input).map_or_else(default_codex_home, Ok)?
  };
  let scope = get_string(&object, "scope");
  let project_path = get_string(&object, "projectPath");
  let paths = scope_paths(if scope.is_empty() { "global" } else { &scope }, &project_path, &codex_home)?;
  let config_content = read_text(&paths.config_path)?;
  let env_content = read_text(&paths.env_path)?;
  let auth_content = read_text(&paths.auth_path)?;
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
    expand_home_path(&input).map_or_else(default_codex_home, Ok)?
  };
  let scope = get_string(&object, "scope");
  let project_path = get_string(&object, "projectPath");
  let timeout_ms = object.get("timeoutMs").and_then(Value::as_u64).unwrap_or(6000);
  let paths = scope_paths(if scope.is_empty() { "global" } else { &scope }, &project_path, &codex_home)?;
  let config_content = read_text(&paths.config_path)?;
  let env_content = read_text(&paths.env_path)?;
  let auth_content = read_text(&paths.auth_path)?;
  let auth_json = serde_json::from_str::<Value>(&auth_content).unwrap_or_else(|_| json!({}));
  let config = parse_toml_config(&config_content)?;
  let env = parse_env(&env_content);
  let flat_auth = flatten_auth_json(&auth_json);
  detect_saved_provider(
    &config,
    &env,
    &flat_auth,
    &provider_key,
    timeout_ms,
    &codex_home.to_string_lossy(),
  ).await
}

pub(crate) async fn model_eval_saved_provider(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let provider_key = get_string(&object, "providerKey");
  if provider_key.trim().is_empty() {
    return Err("providerKey is required".to_string());
  }

  let codex_home = {
    let input = get_string(&object, "codexHome");
    expand_home_path(&input).map_or_else(default_codex_home, Ok)?
  };
  let scope = get_string(&object, "scope");
  let project_path = get_string(&object, "projectPath");
  let timeout_ms = object.get("timeoutMs").and_then(Value::as_u64).unwrap_or(30000);
  let profile = get_string(&object, "profile");
  let paths = scope_paths(if scope.is_empty() { "global" } else { &scope }, &project_path, &codex_home)?;
  let config_content = read_text(&paths.config_path)?;
  let env_content = read_text(&paths.env_path)?;
  let auth_content = read_text(&paths.auth_path)?;
  let auth_json = serde_json::from_str::<Value>(&auth_content).unwrap_or_else(|_| json!({}));
  let config = parse_toml_config(&config_content)?;
  let env = parse_env(&env_content);
  let flat_auth = flatten_auth_json(&auth_json);
  let secret = reveal_provider_api_key(&config, &env, &flat_auth, &provider_key)?;
  let model = {
    let explicit = get_string(&object, "model");
    if !explicit.trim().is_empty() {
      explicit
    } else {
      config.get("model").and_then(Value::as_str).unwrap_or_default().to_string()
    }
  };

  run_model_authenticity_eval(
    secret.get("baseUrl").and_then(Value::as_str).unwrap_or_default(),
    secret.get("apiKey").and_then(Value::as_str).unwrap_or_default(),
    "",
    &model,
    secret.get("providerKey").and_then(Value::as_str).unwrap_or(&provider_key),
    secret.get("providerName").and_then(Value::as_str).unwrap_or(&provider_key),
    if profile.trim().is_empty() { "quick" } else { &profile },
    timeout_ms,
    secret.get("wireApi").and_then(Value::as_str).unwrap_or("responses"),
  )
  .await
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

// Delete a Codex provider (model_providers entry + any matching api-key env
// var + auth.json secret). If the deleted provider was active, re-point
// model_provider at whichever one remains; if none, clear it. All writes go
// through the same TOML / .env / auth.json paths as save_config so file
// formatting stays consistent.
pub(crate) fn delete_codex_provider(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let provider_key = get_string(&object, "providerKey");
  if provider_key.trim().is_empty() {
    return Err("providerKey is required".to_string());
  }

  let codex_home = {
    let input = get_string(&object, "codexHome");
    expand_home_path(&input).map_or_else(default_codex_home, Ok)?
  };
  let scope = get_string(&object, "scope");
  let project_path = get_string(&object, "projectPath");
  let paths = scope_paths(if scope.is_empty() { "global" } else { &scope }, &project_path, &codex_home)?;

  let config_content = read_text(&paths.config_path)?;
  let env_content = read_text(&paths.env_path)?;
  let auth_path = paths.auth_path.clone();
  let auth_content = read_text(&auth_path)?;

  let mut config = parse_toml_config(&config_content)?;
  let mut env = parse_env(&env_content);
  let mut auth_json: Value = if auth_content.trim().is_empty() {
    json!({})
  } else {
    serde_json::from_str(&auth_content).unwrap_or_else(|_| json!({}))
  };

  // Capture env_key for this provider before we delete it so we know which
  // .env var and which auth.json entry to strip.
  let env_key = config
    .get("model_providers")
    .and_then(Value::as_object)
    .and_then(|providers| providers.get(&provider_key))
    .and_then(Value::as_object)
    .and_then(|item| item.get("env_key"))
    .and_then(Value::as_str)
    .map(|s| s.trim().to_string())
    .unwrap_or_default();

  // Remove provider from model_providers.
  let mut removed = false;
  if let Some(obj) = config.as_object_mut() {
    if let Some(providers) = obj.get_mut("model_providers").and_then(Value::as_object_mut) {
      removed = providers.remove(&provider_key).is_some();
      if providers.is_empty() {
        obj.remove("model_providers");
      }
    }
    // Strip matching model_profiles entries too.
    if let Some(profiles) = obj.get_mut("model_profiles").and_then(Value::as_object_mut) {
      profiles.retain(|_, v| {
        v.get("model_provider").and_then(Value::as_str) != Some(provider_key.as_str())
      });
      let empty = profiles.is_empty();
      if empty {
        obj.remove("model_profiles");
      }
    }
    // If this was the active provider, pick the first remaining one or clear.
    let was_active = obj.get("model_provider").and_then(Value::as_str) == Some(provider_key.as_str());
    if was_active {
      let next_key = obj
        .get("model_providers")
        .and_then(Value::as_object)
        .and_then(|providers| providers.keys().next().cloned())
        .unwrap_or_default();
      if next_key.is_empty() {
        obj.remove("model_provider");
      } else {
        obj.insert("model_provider".to_string(), json!(next_key));
      }
    }
  }

  if !removed {
    // Provider wasn't in config.toml — still sweep auth.json / .env below in
    // case stale secrets linger, then report what we found.
  }

  // Strip the env-var version of the key (legacy storage path).
  if !env_key.is_empty() {
    env.remove(&env_key);
  }

  // Strip the auth.json entry — Codex stores per-provider keys at the top
  // level of auth.json keyed by env_key (not by provider_key).
  if let Some(auth_obj) = auth_json.as_object_mut() {
    if !env_key.is_empty() {
      auth_obj.remove(&env_key);
    }
  }

  // Persist.
  let new_toml = stringify_toml_config(&config)?;
  let new_env = stringify_env(&env);
  let new_auth = if auth_json
    .as_object()
    .map(|obj| obj.is_empty())
    .unwrap_or(false)
  {
    String::new()
  } else {
    serde_json::to_string_pretty(&auth_json).unwrap_or_default()
  };

  // config.toml + .env + auth.json 都可能直接含 API key / OAuth token，
  // 用 write_secret 把权限设成 0600，防止共享机其他用户读取
  write_secret(&paths.config_path, &new_toml)?;
  write_secret(&paths.env_path, &new_env)?;
  if new_auth.is_empty() {
    // leave auth.json alone when it'd be literally empty — Codex's login
    // status flow reads this file and treats "missing" and "{}" differently
    // on some branches. Only rewrite when we actually had content.
    if !auth_content.trim().is_empty() {
      write_secret(&auth_path, "{}")?;
    }
  } else {
    write_secret(&auth_path, &new_auth)?;
  }

  Ok(json!({
    "ok": true,
    "removed": removed,
    "providerKey": provider_key,
  }))
}


pub(crate) fn use_oauth_config(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let codex_home = {
    let input = get_string(&object, "codexHome");
    expand_home_path(&input).map_or_else(default_codex_home, Ok)?
  };
  let scope = get_string(&object, "scope");
  let project_path = get_string(&object, "projectPath");
  let paths = scope_paths(if scope.is_empty() { "global" } else { &scope }, &project_path, &codex_home)?;

  let config_content = read_text(&paths.config_path)?;
  let mut config = parse_toml_config(&config_content)?;
  let original_config = config.clone();

  if let Some(obj) = config.as_object_mut() {
    obj.remove("model_provider");
  }

  let config_changed = config != original_config;
  let backup_path = if config_changed {
    Some(create_backup(&paths)?)
  } else {
    None
  };
  if config_changed {
    write_secret(&paths.config_path, &stringify_toml_config(&config)?)?;
  }

  Ok(json!({
    "saved": true,
    "backupPath": backup_path,
    "paths": scope_paths_json(&paths),
    "activeProvider": "",
    "changed": {
      "config": config_changed,
      "env": false,
    },
  }))
}

pub(crate) fn save_config(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let codex_home = {
    let input = get_string(&object, "codexHome");
    expand_home_path(&input).map_or_else(default_codex_home, Ok)?
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

  // 通过 base_url 找已有 provider —— 用户改 URL / 重命名 providerKey 后，
  // 同一个 provider 不应该在 TOML 里残留旧条目。这里在还没把 config 借为
  // mut 之前先拷出 matched，避免与下面 mut 借用冲突。
  let matched_entry = find_provider_entry_by_base_url(&config, &base_url);

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
    .or_else(|| matched_entry.as_ref().map(|(_, item)| item.clone()))
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

  // 是否在保存时同时把 model_provider 切到这条新 provider。默认 false：
  // 前端拿到 needsActivation:true 后弹"确认切换"，确认后才再发一次带
  // activate:true 的请求，避免误触。
  let activate = object.get("activate").and_then(Value::as_bool).unwrap_or(false);
  let previous_active_provider = config_object
    .get("model_provider")
    .and_then(Value::as_str)
    .unwrap_or("")
    .trim()
    .to_string();
  if activate {
    config_object.insert("model_provider".to_string(), json!(provider_key));
  }
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

  // 收集要从 .env 清掉的旧 env_key（与 Node 端逻辑保持一致）。
  let mut obsolete_env_keys: Vec<String> = Vec::new();
  let mut hints: Vec<Value> = Vec::new();
  if let Some((matched_key, matched_provider)) = matched_entry.as_ref() {
    if matched_key != &provider_key {
      let old_env_key = matched_provider
        .get("env_key")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
      if !old_env_key.is_empty() && old_env_key != env_key {
        obsolete_env_keys.push(old_env_key);
      }
      providers_object.remove(matched_key);
      hints.push(json!({
        "code": "provider_key_replaced",
        "message": format!("已替换旧 provider「{}」为「{}」（同一 Base URL）", matched_key, provider_key),
      }));
    }
  }
  let prev_env_key_for_key = current_provider
    .get("env_key")
    .and_then(Value::as_str)
    .unwrap_or("")
    .trim()
    .to_string();
  if !prev_env_key_for_key.is_empty() && prev_env_key_for_key != env_key {
    obsolete_env_keys.push(prev_env_key_for_key);
  }

  if !api_key.trim().is_empty() && !env_key.trim().is_empty() {
    env.insert(env_key.clone(), api_key.trim().to_string());
  }
  if is_loopback_base_url(&base_url) && ensure_local_router_no_proxy(&mut env) {
    hints.push(json!({
      "code": "local_router_no_proxy_added",
      "message": "已为本地网关写入 NO_PROXY/no_proxy，避免 Codex 请求被系统代理截走",
      "detail": { "items": LOCAL_ROUTER_NO_PROXY_ITEMS },
    }));
  }

  let mut removed_env_keys: Vec<String> = Vec::new();
  for old_key in obsolete_env_keys.iter() {
    if old_key.is_empty() || old_key == &env_key { continue; }
    if env.contains_key(old_key.as_str()) {
      env.remove(old_key.as_str());
      removed_env_keys.push(old_key.clone());
    }
  }
  if !removed_env_keys.is_empty() {
    hints.push(json!({
      "code": "env_keys_cleaned",
      "message": format!("已清理失效的 .env 变量：{}", removed_env_keys.join(", ")),
      "detail": { "keys": removed_env_keys },
    }));
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
    write_secret(&paths.config_path, &stringify_toml_config(&config)?)?;
  }
  if env_changed {
    write_secret(&paths.env_path, &stringify_env(&env))?;
  }

  Ok(json!({
    "saved": true,
    "backupPath": backup_path,
    "paths": scope_paths_json(&paths),
    "activated": activate,
    "activeProvider": if activate { provider_key.clone() } else { previous_active_provider.clone() },
    "savedProviderKey": provider_key.clone(),
    "previousActiveProvider": previous_active_provider.clone(),
    "needsActivation": !activate && previous_active_provider != provider_key,
    "baseUrl": base_url,
    "envKey": env_key,
    "hints": hints,
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
    expand_home_path(&input).map_or_else(default_codex_home, Ok)?
  };
  let scope = get_string(&object, "scope");
  let project_path = get_string(&object, "projectPath");
  let paths = scope_paths(if scope.is_empty() { "global" } else { &scope }, &project_path, &codex_home)?;
  let config_content = read_text(&paths.config_path)?;
  let mut config = parse_toml_config(&config_content)?;
  let original_config = config.clone();
  let normalized_settings = normalize_settings_patch_for_scope(
    object.get("settings").unwrap_or(&json!({})),
    &paths.scope,
  );
  apply_patch(&mut config, &normalized_settings);

  let changed = config != original_config;
  let backup_path = if changed {
    Some(create_backup(&paths)?)
  } else {
    None
  };
  if changed {
    write_secret(&paths.config_path, &stringify_toml_config(&config)?)?;
  }

  Ok(json!({
    "saved": true,
    "backupPath": backup_path,
    "paths": scope_paths_json(&paths),
    "changed": changed,
  }))
}

pub(crate) fn save_raw_config(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let codex_home = {
    let input = get_string(&object, "codexHome");
    expand_home_path(&input).map_or_else(default_codex_home, Ok)?
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

  let auth_json_raw = get_string(&object, "authJson");
  let mut auth_changed = false;
  if !auth_json_raw.trim().is_empty() {
    serde_json::from_str::<Value>(&auth_json_raw).map_err(|e| format!("auth.json 解析失败：{e}"))?;
    let current_auth = read_text(&paths.auth_path)?;
    if current_auth != auth_json_raw {
      auth_changed = true;
    }
  }

  let backup_path = if changed || auth_changed {
    Some(create_backup(&paths)?)
  } else {
    None
  };
  if changed {
    write_secret(&paths.config_path, &config_toml)?;
  }
  if auth_changed {
    write_secret(&paths.auth_path, &auth_json_raw)?;
  }

  Ok(json!({
    "saved": true,
    "backupPath": backup_path,
    "paths": scope_paths_json(&paths),
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
  let codex_home = {
    let input = get_string(&object, "codexHome");
    expand_home_path(&input).map_or_else(default_codex_home, Ok)?
  };
  let scope = get_string(&object, "scope");
  let project_path = get_string(&object, "projectPath");
  let paths = scope_paths(if scope.is_empty() { "global" } else { &scope }, &project_path, &codex_home)?;
  let backup_dir = resolve_backup_dir(&backup_name)?;
  if !backup_dir.is_dir() {
    return Err("Backup does not exist".to_string());
  }

  let config_backup = backup_dir.join("config.toml.bak");
  let env_backup = backup_dir.join(".env.bak");
  let auth_backup = backup_dir.join("auth.json.bak");
  if !config_backup.is_file() {
    return Err("Backup config.toml.bak is missing".to_string());
  }
  if !env_backup.is_file() {
    return Err("Backup .env.bak is missing".to_string());
  }

  let config_content = fs::read_to_string(&config_backup).map_err(|error| error.to_string())?;
  let env_content = fs::read_to_string(&env_backup).map_err(|error| error.to_string())?;
  write_secret(&paths.config_path, &config_content)?;
  write_secret(&paths.env_path, &env_content)?;
  if auth_backup.is_file() {
    let auth_content = fs::read_to_string(&auth_backup).map_err(|error| error.to_string())?;
    write_secret(&paths.auth_path, &auth_content)?;
  }
  Ok(json!({
    "restored": true,
    "paths": scope_paths_json(&paths)
  }))
}

pub(crate) fn read_config_file(query: &Value) -> Result<Value, String> {
  let object = parse_json_object(query);
  let file_path_str = get_string(&object, "filePath");
  if file_path_str.trim().is_empty() {
    return Err("filePath is required".to_string());
  }

  let file_path = assert_allowed_path(Path::new(&file_path_str), "filePath")?;
  let content = read_text(&file_path)?;
  let exists = !content.is_empty() || file_path.is_file();

  Ok(json!({
    "filePath": file_path.to_string_lossy().to_string(),
    "exists": exists,
    "content": content,
  }))
}

/// POST /api/config/set-default-model
/// 单独改 codex config.toml 里的 `model` 字段，不动其它任何东西。
/// body: { codexHome?, scope?, projectPath?, model }
pub(crate) fn set_default_model(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let model = get_string(&object, "model");
  if model.trim().is_empty() {
    return Err("model 不能为空".to_string());
  }
  let codex_home = {
    let input = get_string(&object, "codexHome");
    expand_home_path(&input).map_or_else(default_codex_home, Ok)?
  };
  let scope = get_string(&object, "scope");
  let project_path = get_string(&object, "projectPath");
  let paths = scope_paths(if scope.is_empty() { "global" } else { &scope }, &project_path, &codex_home)?;
  let config_content = read_text(&paths.config_path)?;
  let mut config = parse_toml_config(&config_content)?;
  if !config.is_object() { config = json!({}); }
  config.as_object_mut().unwrap().insert("model".to_string(), json!(model));
  let new_content = stringify_toml_config(&config)?;
  if new_content != config_content {
    write_secret(&paths.config_path, &new_content)?;
  }
  Ok(json!({ "ok": true, "model": model }))
}

pub(crate) fn write_config_file(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let file_path_str = get_string(&object, "filePath");
  if file_path_str.trim().is_empty() {
    return Err("filePath is required".to_string());
  }
  let content = get_string(&object, "content");

  let file_path = assert_allowed_path(Path::new(&file_path_str), "filePath")?;
  if let Some(parent) = file_path.parent() {
    ensure_dir(&parent.to_path_buf())?;
  }

  let previous = read_text(&file_path)?;
  let changed = previous != content;
  if changed {
    // 写入路径已被 assert_allowed_path 限制到 ~/.codex/.claude/.openclaw 等
    // 配置目录，里面可能含 key / token —— 一律 0600
    write_secret(&file_path, &content)?;
  }

  Ok(json!({
    "saved": true,
    "filePath": file_path.to_string_lossy().to_string(),
    "changed": changed,
  }))
}
