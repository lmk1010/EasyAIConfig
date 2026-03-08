use chrono::Utc;
use reqwest::Client;
use reqwest::header::{
  HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE,
  PRAGMA, USER_AGENT,
};
use semver::Version;
use serde_json::{json, Map, Value};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use toml::map::Map as TomlMap;
use toml::Value as TomlValue;
use tauri_plugin_updater::UpdaterExt;
use url::Url;

const APP_HOME_DIRNAME: &str = ".codex-config-ui";
const BACKUPS_DIRNAME: &str = "backups";
const OPENAI_CODEX_PACKAGE: &str = "@openai/codex";

fn ok(data: Value) -> Value {
  json!({ "ok": true, "data": data })
}

fn fail(message: impl Into<String>) -> Value {
  json!({ "ok": false, "error": message.into() })
}

fn home_dir() -> Result<PathBuf, String> {
  dirs::home_dir().ok_or_else(|| "无法获取用户主目录".to_string())
}

fn default_codex_home() -> Result<PathBuf, String> {
  let env_home = std::env::var("CODEX_HOME").unwrap_or_default();
  if !env_home.trim().is_empty() {
    return Ok(PathBuf::from(env_home.trim()));
  }
  Ok(home_dir()?.join(".codex"))
}

fn app_home() -> Result<PathBuf, String> {
  Ok(home_dir()?.join(APP_HOME_DIRNAME))
}

fn backups_root() -> Result<PathBuf, String> {
  Ok(app_home()?.join(BACKUPS_DIRNAME))
}

fn timestamp() -> String {
  Utc::now().to_rfc3339().replace(':', "-").replace('.', "-")
}

fn npm_command() -> &'static str {
  if cfg!(target_os = "windows") {
    "npm.cmd"
  } else {
    "npm"
  }
}

fn ensure_dir(path: &Path) -> Result<(), String> {
  fs::create_dir_all(path).map_err(|error| error.to_string())
}

fn read_text(path: &Path) -> Result<String, String> {
  match fs::read_to_string(path) {
    Ok(text) => Ok(text),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
    Err(error) => Err(error.to_string()),
  }
}

fn write_text(path: &Path, content: &str) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    ensure_dir(parent)?;
  }
  fs::write(path, content).map_err(|error| error.to_string())
}

fn parse_env(content: &str) -> BTreeMap<String, String> {
  let mut entries = BTreeMap::new();
  for line in content.lines() {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
      continue;
    }
    if let Some((key, value)) = trimmed.split_once('=') {
      let clean = value.trim().trim_matches('"').trim_matches('\'').to_string();
      entries.insert(key.trim().to_string(), clean);
    }
  }
  entries
}

fn stringify_env(entries: &BTreeMap<String, String>) -> String {
  let mut lines = Vec::new();
  for (key, value) in entries {
    if key.to_uppercase().starts_with("CODEX_") {
      continue;
    }
    lines.push(format!("{key}={value}"));
  }
  if lines.is_empty() {
    String::new()
  } else {
    format!("{}\n", lines.join("\n"))
  }
}

fn parse_json_object(value: &Value) -> Map<String, Value> {
  value.as_object().cloned().unwrap_or_default()
}

fn toml_to_json(value: &TomlValue) -> Value {
  match value {
    TomlValue::String(v) => Value::String(v.clone()),
    TomlValue::Integer(v) => json!(*v),
    TomlValue::Float(v) => json!(*v),
    TomlValue::Boolean(v) => json!(*v),
    TomlValue::Datetime(v) => Value::String(v.to_string()),
    TomlValue::Array(items) => Value::Array(items.iter().map(toml_to_json).collect()),
    TomlValue::Table(table) => {
      let mut object = Map::new();
      for (key, item) in table {
        object.insert(key.clone(), toml_to_json(item));
      }
      Value::Object(object)
    }
  }
}

fn json_to_toml(value: &Value) -> Result<TomlValue, String> {
  match value {
    Value::Null => Err("配置中不允许存在 null".to_string()),
    Value::Bool(v) => Ok(TomlValue::Boolean(*v)),
    Value::Number(v) => {
      if let Some(int) = v.as_i64() {
        Ok(TomlValue::Integer(int))
      } else if let Some(float) = v.as_f64() {
        Ok(TomlValue::Float(float))
      } else {
        Err("无法转换数字配置".to_string())
      }
    }
    Value::String(v) => Ok(TomlValue::String(v.clone())),
    Value::Array(items) => {
      let mut array = Vec::new();
      for item in items {
        array.push(json_to_toml(item)?);
      }
      Ok(TomlValue::Array(array))
    }
    Value::Object(object) => {
      let mut table = TomlMap::new();
      for (key, item) in object {
        table.insert(key.clone(), json_to_toml(item)?);
      }
      Ok(TomlValue::Table(table))
    }
  }
}

fn parse_toml_config(content: &str) -> Result<Value, String> {
  if content.trim().is_empty() {
    return Ok(Value::Object(Map::new()));
  }
  let parsed = content.parse::<TomlValue>().map_err(|error| error.to_string())?;
  Ok(toml_to_json(&parsed))
}

fn stringify_toml_config(config: &Value) -> Result<String, String> {
  let toml_value = json_to_toml(config)?;
  toml::to_string_pretty(&toml_value).map_err(|error| error.to_string())
}

fn apply_patch(target: &mut Value, patch: &Value) {
  if !patch.is_object() {
    *target = patch.clone();
    return;
  }

  if !target.is_object() {
    *target = Value::Object(Map::new());
  }

  let target_object = target.as_object_mut().expect("object");
  let patch_object = patch.as_object().expect("object");

  for (key, value) in patch_object {
    if value.is_null() {
      target_object.remove(key);
      continue;
    }

    if value.is_array() || !value.is_object() {
      target_object.insert(key.clone(), value.clone());
      continue;
    }

    let child = target_object
      .entry(key.clone())
      .or_insert_with(|| Value::Object(Map::new()));
    apply_patch(child, value);
  }
}

#[derive(Clone)]
struct ScopePaths {
  scope: String,
  root_path: PathBuf,
  config_path: PathBuf,
  env_path: PathBuf,
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

fn normalize_base_url(base_url: &str) -> Result<String, String> {
  let raw = base_url.trim();
  if raw.is_empty() {
    return Err("Base URL is required".to_string());
  }

  let with_scheme = if raw.contains("://") {
    raw.to_string()
  } else {
    let lower = raw.to_lowercase();
    if lower.starts_with("localhost") || lower.starts_with("127.0.0.1") || lower.starts_with("0.0.0.0") {
      format!("http://{raw}")
    } else {
      format!("https://{raw}")
    }
  };

  let mut url = Url::parse(&with_scheme).map_err(|error| error.to_string())?;
  let trimmed = url.path().trim_end_matches('/');
  let next_path = if trimmed.is_empty() {
    "/v1".to_string()
  } else if trimmed.ends_with("/v1") {
    trimmed.to_string()
  } else {
    format!("{trimmed}/v1")
  };
  url.set_path(&next_path);
  Ok(url.to_string().trim_end_matches('/').to_string())
}

fn slugify_provider_key(value: &str) -> String {
  let mut slug = String::new();
  let mut previous_dash = false;

  for ch in value.trim().to_lowercase().replace("http://", "").replace("https://", "").chars() {
    if ch.is_ascii_alphanumeric() {
      slug.push(ch);
      previous_dash = false;
    } else if !previous_dash {
      slug.push('-');
      previous_dash = true;
    }
  }

  let slug = slug.trim_matches('-').to_string();
  if slug.is_empty() {
    return "custom".to_string();
  }
  if slug.chars().next().is_some_and(|ch| ch.is_ascii_digit()) {
    format!("provider-{slug}")
  } else {
    slug
  }
}

fn infer_provider_seed(base_url: &str) -> String {
  let url = match Url::parse(base_url) {
    Ok(url) => url,
    Err(_) => return "custom".to_string(),
  };
  let hostname = url.host_str().unwrap_or_default().trim_start_matches("www.");
  let ignored = ["api", "openai", "codex", "gateway", "chat", "www", "dapi"];
  for part in hostname.split('.') {
    let clean = part.trim().to_lowercase();
    if clean.is_empty() || ignored.contains(&clean.as_str()) || !clean.chars().any(|ch| ch.is_ascii_alphabetic()) {
      continue;
    }
    return clean;
  }
  hostname.split('.').next().unwrap_or("custom").to_string()
}

fn infer_provider_label(base_url: &str, provider_key: &str) -> String {
  let seed = infer_provider_seed(base_url);
  let source = if seed.is_empty() { provider_key } else { &seed };
  source
    .split(['-', '_', ' '])
    .filter(|part| !part.is_empty())
    .map(|part| {
      let mut chars = part.chars();
      match chars.next() {
        Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
        None => String::new(),
      }
    })
    .collect::<Vec<_>>()
    .join(" ")
}

fn infer_env_key(provider_key: &str) -> String {
  format!(
    "{}_API_KEY",
    slugify_provider_key(provider_key).replace('-', "_").to_uppercase()
  )
}

fn normalize_token(value: &str) -> String {
  value
    .to_lowercase()
    .replace("http://", "")
    .replace("https://", "")
    .chars()
    .filter(|ch| ch.is_ascii_alphanumeric())
    .collect()
}

fn score_key_candidate(candidate_key: &str, provider: &ProviderMeta) -> i32 {
  let candidate = normalize_token(candidate_key)
    .trim_end_matches("apikey")
    .trim_end_matches("oaikey")
    .trim_end_matches("key")
    .trim_end_matches("token")
    .to_string();

  let targets = vec![provider.key.as_str(), provider.name.as_str(), provider.base_url.as_str()]
    .into_iter()
    .map(normalize_token)
    .filter(|item| !item.is_empty())
    .collect::<Vec<_>>();

  let mut score = 0;
  for target in targets {
    if target == candidate {
      score += 120;
    }
    if target.contains(&candidate) {
      score += 60;
    }
    if candidate.contains(&target) {
      score += 30;
    }
    let prefix_len = target.len().min(candidate.len()).min(8);
    if prefix_len >= 4 && target[..prefix_len] == candidate[..prefix_len] {
      score += (prefix_len as i32) * 5;
    }
  }

  if candidate == "openai" && !provider.base_url.to_lowercase().contains("openai") {
    score -= 60;
  }

  score
}

fn candidate_env_keys(provider: &ProviderMeta) -> Vec<String> {
  let mut keys = HashSet::new();
  let seeds = vec![
    provider.key.clone(),
    provider.name.clone(),
    Url::parse(&provider.base_url)
      .ok()
      .and_then(|url| url.host_str().map(|host| host.to_string()))
      .unwrap_or_default(),
  ];

  for seed in seeds {
    let normalized = seed
      .chars()
      .map(|ch| if ch.is_ascii_alphanumeric() { ch.to_ascii_uppercase() } else { '_' })
      .collect::<String>()
      .trim_matches('_')
      .to_string();
    if normalized.is_empty() {
      continue;
    }
    keys.insert(format!("{normalized}_API_KEY"));
    keys.insert(format!("{normalized}_OAI_KEY"));
    keys.insert(format!("{normalized}_KEY"));
  }

  keys.into_iter().collect()
}

#[derive(Clone)]
struct ProviderMeta {
  key: String,
  name: String,
  base_url: String,
  env_key: String,
  wire_api: String,
  inline_bearer_token: String,
  is_active: bool,
}

#[derive(Clone)]
struct ProviderSecret {
  key: Option<String>,
  value: String,
  source: Option<String>,
  score: i32,
}

fn flatten_auth_json(auth_json: &Value) -> BTreeMap<String, String> {
  let mut flat = BTreeMap::new();
  if let Some(object) = auth_json.as_object() {
    for (key, value) in object {
      if let Some(text) = value.as_str() {
        flat.insert(key.clone(), text.to_string());
      }
    }
  }
  flat
}

fn resolve_provider_secret(
  provider: &ProviderMeta,
  env_file: &BTreeMap<String, String>,
  auth_json: &BTreeMap<String, String>,
) -> ProviderSecret {
  let runtime_env = std::env::vars().collect::<BTreeMap<_, _>>();
  let explicit_keys = if provider.env_key.trim().is_empty() {
    Vec::new()
  } else {
    vec![provider.env_key.clone()]
  };

  let mut discovered_keys = env_file
    .keys()
    .chain(runtime_env.keys())
    .chain(auth_json.keys())
    .filter(|key| {
      let lower = key.to_lowercase();
      lower.ends_with("key") || lower.ends_with("token")
    })
    .cloned()
    .collect::<Vec<_>>();

  let mut candidate_keys = explicit_keys.clone();
  candidate_keys.extend(candidate_env_keys(provider));
  candidate_keys.append(&mut discovered_keys);
  candidate_keys.sort();
  candidate_keys.dedup();

  let mut candidates = Vec::new();
  for key in candidate_keys {
    let dynamic_score = score_key_candidate(&key, provider);
    if let Some(value) = env_file.get(&key) {
      candidates.push(ProviderSecret {
        key: Some(key.clone()),
        value: value.clone(),
        source: Some(".env".to_string()),
        score: if explicit_keys.contains(&key) { 1000 } else { dynamic_score + 100 },
      });
    }
    if let Some(value) = runtime_env.get(&key) {
      candidates.push(ProviderSecret {
        key: Some(key.clone()),
        value: value.clone(),
        source: Some("system-env".to_string()),
        score: if explicit_keys.contains(&key) { 950 } else { dynamic_score + 90 },
      });
    }
    if let Some(value) = auth_json.get(&key) {
      candidates.push(ProviderSecret {
        key: Some(key.clone()),
        value: value.clone(),
        source: Some("auth.json".to_string()),
        score: if explicit_keys.contains(&key) { 900 } else { dynamic_score + 80 },
      });
    }
  }

  if !provider.inline_bearer_token.trim().is_empty() {
    candidates.push(ProviderSecret {
      key: None,
      value: provider.inline_bearer_token.clone(),
      source: Some("config.toml".to_string()),
      score: 850,
    });
  }

  candidates.sort_by(|left, right| right.score.cmp(&left.score));
  candidates.into_iter().next().unwrap_or(ProviderSecret {
    key: explicit_keys.first().cloned(),
    value: String::new(),
    source: None,
    score: 0,
  })
}

fn get_string(object: &Map<String, Value>, key: &str) -> String {
  object
    .get(key)
    .and_then(Value::as_str)
    .unwrap_or_default()
    .to_string()
}

fn get_string_any(object: &Map<String, Value>, keys: &[&str]) -> String {
  for key in keys {
    let value = get_string(object, key);
    if !value.is_empty() {
      return value;
    }
  }
  String::new()
}

fn summarize_providers(
  config: &Value,
  env_file: &BTreeMap<String, String>,
  auth_json: &BTreeMap<String, String>,
) -> Vec<Value> {
  let config_object = parse_json_object(config);
  let active_provider_key = get_string(&config_object, "model_provider");
  let provider_map = config_object
    .get("model_providers")
    .and_then(Value::as_object)
    .cloned()
    .unwrap_or_default();

  let mut providers = provider_map
    .into_iter()
    .map(|(key, provider)| {
      let provider_object = provider.as_object().cloned().unwrap_or_default();
      let base = ProviderMeta {
        key: key.clone(),
        name: { let name = get_string(&provider_object, "name"); if name.is_empty() { key.clone() } else { name } },
        base_url: get_string(&provider_object, "base_url"),
        env_key: get_string_any(&provider_object, &["env_key", "temp_env_key"]),
        wire_api: {
          let wire = get_string(&provider_object, "wire_api");
          if wire.is_empty() { "responses".to_string() } else { wire }
        },
        inline_bearer_token: get_string(&provider_object, "experimental_bearer_token"),
        is_active: active_provider_key == key,
      };
      let secret = resolve_provider_secret(&base, env_file, auth_json);
      json!({
        "key": base.key,
        "name": base.name,
        "baseUrl": base.base_url,
        "envKey": base.env_key,
        "wireApi": base.wire_api,
        "inlineBearerToken": base.inline_bearer_token,
        "isActive": base.is_active,
        "hasApiKey": !secret.value.is_empty(),
        "keySource": secret.source,
        "envValue": secret.value,
        "resolvedKeyName": secret.key,
      })
    })
    .collect::<Vec<_>>();

  providers.sort_by(|left, right| {
    let left_active = left.get("isActive").and_then(Value::as_bool).unwrap_or(false);
    let right_active = right.get("isActive").and_then(Value::as_bool).unwrap_or(false);
    if left_active != right_active {
      return if left_active { Ordering::Less } else { Ordering::Greater };
    }
    let left_key = left.get("key").and_then(Value::as_str).unwrap_or_default();
    let right_key = right.get("key").and_then(Value::as_str).unwrap_or_default();
    left_key.cmp(right_key)
  });

  providers
}

fn create_backup(paths: &ScopePaths) -> Result<String, String> {
  let target_dir = backups_root()?.join(format!("{}-{}", timestamp(), paths.scope));
  ensure_dir(&target_dir)?;
  write_text(&target_dir.join("config.toml.bak"), &read_text(&paths.config_path)?)?;
  write_text(&target_dir.join(".env.bak"), &read_text(&paths.env_path)?)?;
  Ok(target_dir.to_string_lossy().to_string())
}

fn extract_version(text: &str) -> Option<String> {
  let chars = text.chars().collect::<Vec<_>>();
  for index in 0..chars.len() {
    if !chars[index].is_ascii_digit() {
      continue;
    }
    let mut end = index;
    while end < chars.len()
      && (chars[end].is_ascii_alphanumeric() || chars[end] == '.' || chars[end] == '-')
    {
      end += 1;
    }
    let candidate = chars[index..end].iter().collect::<String>();
    if Version::parse(&candidate).is_ok() {
      return Some(candidate);
    }
  }
  None
}

fn compare_versions(left: &str, right: &str) -> Ordering {
  let left_version = extract_version(left).and_then(|value| Version::parse(&value).ok());
  let right_version = extract_version(right).and_then(|value| Version::parse(&value).ok());
  match (left_version, right_version) {
    (Some(left), Some(right)) => left.cmp(&right),
    (Some(_), None) => Ordering::Greater,
    (None, Some(_)) => Ordering::Less,
    (None, None) => Ordering::Equal,
  }
}

fn run_command(command: &str, args: &[&str], cwd: Option<&Path>) -> Result<Value, String> {
  let mut cmd = Command::new(command);
  cmd.args(args);
  if let Some(dir) = cwd {
    cmd.current_dir(dir);
  }
  let output = cmd.output().map_err(|error| error.to_string())?;
  let stdout = String::from_utf8_lossy(&output.stdout).to_string();
  let stderr = String::from_utf8_lossy(&output.stderr).to_string();
  Ok(json!({
    "ok": output.status.success(),
    "code": output.status.code(),
    "stdout": stdout,
    "stderr": stderr,
  }))
}

fn command_exists(command: &str) -> Option<String> {
  which::which(command).ok().map(|path| path.to_string_lossy().to_string())
}

fn codex_candidates() -> Vec<String> {
  let mut paths = which::which_all("codex")
    .map(|items| items.map(|item| item.to_string_lossy().to_string()).collect::<Vec<_>>())
    .unwrap_or_default();

  if cfg!(not(target_os = "windows")) {
    paths.push("/Users/Open Source Contributor/.npm-global/bin/codex".to_string());
    paths.push("/usr/local/bin/codex".to_string());
    paths.push("/opt/homebrew/bin/codex".to_string());
  }

  paths.sort();
  paths.dedup();
  paths
}

fn find_codex_binary() -> Value {
  let mut candidates = codex_candidates()
    .into_iter()
    .filter_map(|candidate_path| {
      let output = Command::new(&candidate_path).arg("--version").output().ok()?;
      if !output.status.success() {
        return None;
      }
      let version_output = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
      )
      .trim()
      .to_string();
      Some(json!({
        "path": candidate_path,
        "installed": true,
        "version": version_output,
      }))
    })
    .collect::<Vec<_>>();

  candidates.sort_by(|left, right| {
    let left_version = left.get("version").and_then(Value::as_str).unwrap_or_default();
    let right_version = right.get("version").and_then(Value::as_str).unwrap_or_default();
    compare_versions(right_version, left_version)
  });

  let selected = candidates.first().cloned();
  json!({
    "installed": selected.is_some(),
    "version": selected.as_ref().and_then(|item| item.get("version")).cloned().unwrap_or(Value::Null),
    "path": selected
      .as_ref()
      .and_then(|item| item.get("path").and_then(Value::as_str).map(|text| text.to_string()))
      .or_else(|| command_exists("codex"))
      .unwrap_or_default(),
    "candidates": candidates,
    "installCommand": format!("{} install -g {}", npm_command(), OPENAI_CODEX_PACKAGE),
  })
}

fn codex_npm_action(args: &[&str]) -> Result<Value, String> {
  let result = run_command(npm_command(), args, None)?;
  Ok(json!({
    "ok": result.get("ok").and_then(Value::as_bool).unwrap_or(false),
    "code": result.get("code").cloned().unwrap_or(Value::Null),
    "stdout": result.get("stdout").cloned().unwrap_or(Value::String(String::new())),
    "stderr": result.get("stderr").cloned().unwrap_or(Value::String(String::new())),
    "command": format!("{} {}", npm_command(), args.join(" ")),
  }))
}

fn escape_applescript(text: &str) -> String {
  text.replace('\\', "\\\\").replace('"', "\\\"")
}

fn launch_terminal_command(cwd: &Path) -> Result<String, String> {
  let codex_binary = find_codex_binary();
  let codex_path = codex_binary
    .get("path")
    .and_then(Value::as_str)
    .filter(|path| !path.is_empty())
    .unwrap_or("codex");
  let cwd_text = cwd.to_string_lossy().to_string();

  if cfg!(target_os = "macos") {
    let script = [
      "tell application \"Terminal\"",
      "activate",
      &format!(
        "do script \"cd {} && {}\"",
        escape_applescript(&cwd_text),
        escape_applescript(codex_path)
      ),
      "end tell",
    ]
    .join("\n");

    let output = Command::new("osascript")
      .arg("-e")
      .arg(script)
      .output()
      .map_err(|error| error.to_string())?;
    if !output.status.success() {
      return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    return Ok("Codex 已在 Terminal 中启动".to_string());
  }

  if cfg!(target_os = "windows") {
    Command::new("cmd.exe")
      .args([
        "/c",
        "start",
        "",
        "cmd",
        "/k",
        &format!("cd /d \"{}\" && \"{}\"", cwd_text, codex_path),
      ])
      .spawn()
      .map_err(|error| error.to_string())?;
    return Ok("Codex 已在新命令窗口中启动".to_string());
  }

  let terminals = vec![
    ("x-terminal-emulator", vec!["-e".to_string(), format!("bash -lc \"cd '{}' && '{}'\"", cwd_text, codex_path)]),
    ("gnome-terminal", vec!["--".to_string(), "bash".to_string(), "-lc".to_string(), format!("cd '{}' && '{}'", cwd_text, codex_path)]),
    ("konsole", vec!["-e".to_string(), "bash".to_string(), "-lc".to_string(), format!("cd '{}' && '{}'", cwd_text, codex_path)]),
  ];

  for (command, args) in terminals {
    if command_exists(command).is_none() {
      continue;
    }
    Command::new(command)
      .args(args)
      .spawn()
      .map_err(|error| error.to_string())?;
    return Ok("Codex 已在新终端中启动".to_string());
  }

  Err("没有找到可用终端，请先手动运行 codex".to_string())
}

fn parse_model_version(model_id: &str) -> Option<(i32, i32)> {
  let lower = model_id.to_lowercase();
  let marker = lower.find("gpt-")? + 4;
  let suffix = &lower[marker..];
  let mut parts = suffix.split(['.', '-']);
  let major = parts.next()?.parse::<i32>().ok()?;
  let minor = parts.next().and_then(|part| part.parse::<i32>().ok()).unwrap_or(0);
  Some((major, minor))
}

fn compare_models(left: &str, right: &str) -> Ordering {
  let left_version = parse_model_version(left);
  let right_version = parse_model_version(right);
  match (left_version, right_version) {
    (Some((lm, ln)), Some((rm, rn))) => {
      if lm != rm {
        return rm.cmp(&lm);
      }
      if ln != rn {
        return rn.cmp(&ln);
      }
      let left_codex = left.to_lowercase().contains("codex");
      let right_codex = right.to_lowercase().contains("codex");
      if left_codex != right_codex {
        return left_codex.cmp(&right_codex);
      }
      left.cmp(right)
    }
    (Some(_), None) => Ordering::Less,
    (None, Some(_)) => Ordering::Greater,
    (None, None) => left.cmp(right),
  }
}

fn summarize_models(model_ids: Vec<String>) -> Value {
  let mut unique = model_ids.into_iter().filter(|id| !id.is_empty()).collect::<Vec<_>>();
  unique.sort_by(|left, right| compare_models(left, right));
  unique.dedup();
  let gpt_models = unique
    .iter()
    .filter(|id| id.to_lowercase().contains("gpt"))
    .cloned()
    .collect::<Vec<_>>();
  json!({
    "models": unique,
    "supportsGpt": !gpt_models.is_empty(),
    "recommendedModel": gpt_models.first().cloned().or_else(|| unique.first().cloned()),
  })
}

async fn detect_provider(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let normalized_base_url = normalize_base_url(&get_string(&object, "baseUrl"))?;
  let api_key = get_string(&object, "apiKey");
  let timeout_ms = object.get("timeoutMs").and_then(Value::as_u64).unwrap_or(15000);

  let mut headers = HeaderMap::new();
  headers.insert(ACCEPT, HeaderValue::from_static("application/json, text/plain, */*"));
  headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
  headers.insert(USER_AGENT, HeaderValue::from_static("Mozilla/5.0 EasyAIConfig/0.1"));
  headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("zh-CN,zh;q=0.9,en;q=0.8"));
  headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
  headers.insert(PRAGMA, HeaderValue::from_static("no-cache"));
  headers.insert(
    AUTHORIZATION,
    HeaderValue::from_str(&format!("Bearer {}", api_key.trim())).map_err(|error| error.to_string())?,
  );

  let client = Client::builder()
    .timeout(Duration::from_millis(timeout_ms))
    .build()
    .map_err(|error| error.to_string())?;
  let response = client
    .get(format!("{normalized_base_url}/models"))
    .headers(headers)
    .send()
    .await
    .map_err(|error| {
      if error.is_timeout() {
        "检测超时：该接口 15 秒内没有返回模型列表，请检查 Base URL、Key 或服务端兼容性".to_string()
      } else {
        error.to_string()
      }
    })?;

  let status = response.status();
  let text = response.text().await.map_err(|error| error.to_string())?;
  let payload = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);

  if !status.is_success() {
    let message = payload
      .pointer("/error/message")
      .and_then(Value::as_str)
      .or_else(|| payload.get("message").and_then(Value::as_str))
      .map(|text| text.to_string())
      .unwrap_or_else(|| if text.is_empty() { format!("HTTP {status}") } else { text.clone() });
    return Err(format!("检测失败：{message}"));
  }

  let model_ids = payload
    .get("data")
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default()
    .into_iter()
    .filter_map(|item| item.get("id").and_then(Value::as_str).map(|text| text.to_string()))
    .collect::<Vec<_>>();

  let summary = summarize_models(model_ids);
  Ok(json!({
    "baseUrl": normalized_base_url,
    "status": "ok",
    "models": summary.get("models").cloned().unwrap_or_else(|| json!([])),
    "supportsGpt": summary.get("supportsGpt").cloned().unwrap_or_else(|| json!(false)),
    "recommendedModel": summary.get("recommendedModel").cloned().unwrap_or(Value::Null),
    "raw": payload,
  }))
}

fn load_state(query: &Value) -> Result<Value, String> {
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
    "authJson": auth_json,
    "configToml": config_content,
    "config": config,
    "env": env,
    "providers": providers,
    "activeProvider": active_provider,
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

fn save_config(body: &Value) -> Result<Value, String> {
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
  let mut env = parse_env(&env_content);
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
  providers_object.insert(provider_key.clone(), json!({
    "name": provider_label,
    "base_url": base_url,
    "env_key": env_key,
    "wire_api": "responses",
  }));

  if !api_key.trim().is_empty() && !env_key.trim().is_empty() {
    env.insert(env_key.clone(), api_key.trim().to_string());
  }

  let backup_path = create_backup(&paths)?;
  write_text(&paths.config_path, &stringify_toml_config(&config)?)?;
  write_text(&paths.env_path, &stringify_env(&env))?;

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
  }))
}

fn save_settings(body: &Value) -> Result<Value, String> {
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
  apply_patch(&mut config, object.get("settings").unwrap_or(&json!({})));

  let backup_path = create_backup(&paths)?;
  write_text(&paths.config_path, &stringify_toml_config(&config)?)?;

  Ok(json!({
    "saved": true,
    "backupPath": backup_path,
    "paths": {
      "scope": paths.scope,
      "rootPath": paths.root_path.to_string_lossy().to_string(),
      "configPath": paths.config_path.to_string_lossy().to_string(),
      "envPath": paths.env_path.to_string_lossy().to_string(),
    }
  }))
}

fn save_raw_config(body: &Value) -> Result<Value, String> {
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

  let parsed = config_toml.parse::<TomlValue>().map_err(|error| format!("TOML 解析失败：{error}"))?;
  let backup_path = create_backup(&paths)?;
  write_text(&paths.config_path, &toml::to_string_pretty(&parsed).map_err(|error| error.to_string())?)?;

  Ok(json!({
    "saved": true,
    "backupPath": backup_path,
    "paths": {
      "scope": paths.scope,
      "rootPath": paths.root_path.to_string_lossy().to_string(),
      "configPath": paths.config_path.to_string_lossy().to_string(),
      "envPath": paths.env_path.to_string_lossy().to_string(),
    }
  }))
}

fn list_backups() -> Result<Value, String> {
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

fn restore_backup(body: &Value) -> Result<Value, String> {
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


fn updater_runtime_var(name: &str, compile_time: Option<&'static str>) -> String {
  std::env::var(name)
    .ok()
    .filter(|value| !value.trim().is_empty())
    .or_else(|| compile_time.map(|value| value.to_string()).filter(|value| !value.trim().is_empty()))
    .unwrap_or_default()
}

fn updater_repository() -> String {
  let from_env = updater_runtime_var("EASYAICONFIG_GITHUB_REPOSITORY", option_env!("EASYAICONFIG_GITHUB_REPOSITORY"));
  if !from_env.is_empty() {
    return from_env;
  }
  // Fallback: infer from the endpoint in tauri.conf.json
  "lmk1010/EasyAIConfig".to_string()
}

fn updater_public_key() -> String {
  let from_env = updater_runtime_var("EASYAICONFIG_UPDATER_PUBLIC_KEY", option_env!("EASYAICONFIG_UPDATER_PUBLIC_KEY"));
  if !from_env.is_empty() {
    return from_env;
  }
  // Fallback: use the pubkey from tauri.conf.json plugins.updater.pubkey
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEZEQkRGQjdGOTdBQkI0ClJXUzBxNWQvKzczOUFEbDFSZ1VRTWxIaitBZ3pMU21EekJud0NCRkw1MWIzbXZ6UWtnUUszaUZFCg==".to_string()
}

fn updater_endpoint() -> String {
  let explicit = updater_runtime_var("EASYAICONFIG_UPDATER_ENDPOINT", option_env!("EASYAICONFIG_UPDATER_ENDPOINT"));
  if !explicit.is_empty() {
    return explicit;
  }
  let repository = updater_repository();
  if repository.is_empty() {
    String::new()
  } else {
    format!("https://github.com/{repository}/releases/latest/download/latest.json")
  }
}

fn updater_config_state(app: &tauri::AppHandle) -> Value {
  let endpoint = updater_endpoint();
  let repository = updater_repository();
  let current_version = app.package_info().version.to_string();
  let public_key_configured = !updater_public_key().is_empty();
  let enabled = public_key_configured && !endpoint.is_empty();
  json!({
    "enabled": enabled,
    "configured": enabled,
    "publicKeyConfigured": public_key_configured,
    "repository": repository,
    "endpoint": endpoint,
    "currentVersion": current_version,
  })
}

fn build_updater(app: &tauri::AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
  let endpoint = updater_endpoint();
  let pubkey = updater_public_key();
  if endpoint.is_empty() || pubkey.is_empty() {
    return Err("自动更新尚未配置：请先在 GitHub Actions Secrets 中设置签名公钥与发布端点。".to_string());
  }

  let endpoint_url = Url::parse(&endpoint).map_err(|error| error.to_string())?;
  let updater = app
    .updater_builder()
    .pubkey(pubkey)
    .endpoints(vec![endpoint_url])
    .map_err(|error| error.to_string())?
    .timeout(Duration::from_secs(20))
    .build()
    .map_err(|error| error.to_string())?;

  Ok(updater)
}

async fn get_app_update_info(app: tauri::AppHandle) -> Result<Value, String> {
  let base = updater_config_state(&app);
  if !base.get("enabled").and_then(Value::as_bool).unwrap_or(false) {
    return Ok(json!({
      "enabled": false,
      "configured": false,
      "available": false,
      "currentVersion": base.get("currentVersion").cloned().unwrap_or(Value::Null),
      "endpoint": base.get("endpoint").cloned().unwrap_or(Value::Null),
      "repository": base.get("repository").cloned().unwrap_or(Value::Null),
      "publicKeyConfigured": base.get("publicKeyConfigured").cloned().unwrap_or(Value::Bool(false)),
    }));
  }

  let updater = build_updater(&app)?;
  let current_version = app.package_info().version.to_string();
  let endpoint = updater_endpoint();
  let repository = updater_repository();

  if let Some(update) = updater.check().await.map_err(|error| error.to_string())? {
    return Ok(json!({
      "enabled": true,
      "configured": true,
      "available": true,
      "currentVersion": current_version,
      "version": update.version,
      "body": update.body,
      "date": update.date.map(|value| value.to_string()),
      "target": update.target,
      "downloadUrl": update.download_url.to_string(),
      "endpoint": endpoint,
      "repository": repository,
      "rawJson": update.raw_json,
    }));
  }

  Ok(json!({
    "enabled": true,
    "configured": true,
    "available": false,
    "currentVersion": current_version,
    "endpoint": endpoint,
    "repository": repository,
  }))
}

async fn install_app_update(app: tauri::AppHandle) -> Result<Value, String> {
  let updater = build_updater(&app)?;
  let maybe_update = updater.check().await.map_err(|error| error.to_string())?;
  let Some(update) = maybe_update else {
    return Ok(json!({ "installed": false, "available": false }));
  };

  let version = update.version.clone();
  update
    .download_and_install(|_, _| {}, || {})
    .await
    .map_err(|error| error.to_string())?;

  let handle = app.clone();
  std::thread::spawn(move || {
    std::thread::sleep(Duration::from_millis(800));
    handle.request_restart();
  });

  Ok(json!({
    "installed": true,
    "available": true,
    "version": version,
    "restarting": true,
  }))
}

fn get_codex_release_info() -> Result<Value, String> {
  let result = codex_npm_action(&["view", OPENAI_CODEX_PACKAGE, "dist-tags", "--json"])?;
  if !result.get("ok").and_then(Value::as_bool).unwrap_or(false) {
    let message = result
      .get("stderr")
      .and_then(Value::as_str)
      .filter(|text| !text.trim().is_empty())
      .or_else(|| result.get("stdout").and_then(Value::as_str))
      .unwrap_or("获取版本信息失败")
      .trim()
      .to_string();
    return Err(message);
  }

  let tags = serde_json::from_str::<Value>(result.get("stdout").and_then(Value::as_str).unwrap_or("{}"))
    .unwrap_or_else(|_| json!({}));
  let current = find_codex_binary();
  let current_version = current
    .get("version")
    .and_then(Value::as_str)
    .and_then(extract_version);
  let latest_stable = tags.get("latest").and_then(Value::as_str).map(|text| text.to_string());
  let latest_alpha = tags.get("alpha").and_then(Value::as_str).map(|text| text.to_string());

  let has_stable_update = match (&current_version, &latest_stable) {
    (Some(current), Some(latest)) => compare_versions(latest, current) == Ordering::Greater,
    _ => false,
  };
  let has_alpha_update = match (&current_version, &latest_alpha) {
    (Some(current), Some(latest)) => compare_versions(latest, current) == Ordering::Greater,
    _ => false,
  };

  Ok(json!({
    "currentVersion": current_version,
    "latestStable": latest_stable,
    "latestAlpha": latest_alpha,
    "hasStableUpdate": has_stable_update,
    "hasAlphaUpdate": has_alpha_update,
    "isInstalled": current.get("installed").and_then(Value::as_bool).unwrap_or(false),
  }))
}

fn launch_codex(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let cwd = {
    let input = get_string(&object, "cwd");
    if input.is_empty() { home_dir()? } else { PathBuf::from(input) }
  };
  let codex_binary = find_codex_binary();
  if !codex_binary.get("installed").and_then(Value::as_bool).unwrap_or(false) {
    return Err("Codex 尚未安装，请先点击安装".to_string());
  }
  let message = launch_terminal_command(&cwd)?;
  Ok(json!({ "ok": true, "cwd": cwd.to_string_lossy().to_string(), "message": message }))
}

fn check_setup_environment(query: &Value) -> Result<Value, String> {
  let query_object = parse_json_object(query);
  let codex_home = {
    let input = get_string(&query_object, "codexHome");
    if input.is_empty() { default_codex_home()? } else { PathBuf::from(input) }
  };

  // 1. Check Node.js
  let node_output = Command::new("node").arg("--version").output();
  let (node_installed, node_version, node_major) = match node_output {
    Ok(output) if output.status.success() => {
      let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
      let major = version
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
      (true, Some(version), major)
    }
    _ => (false, None, 0),
  };

  // 2. Check npm
  let npm_output = Command::new(npm_command()).arg("--version").output();
  let (npm_installed, npm_version) = match npm_output {
    Ok(output) if output.status.success() => {
      let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
      (true, Some(version))
    }
    _ => (false, None),
  };

  // 3. Check codex binary
  let codex_binary = find_codex_binary();
  let codex_installed = codex_binary.get("installed").and_then(Value::as_bool).unwrap_or(false);

  // 4. Check config files
  let global_config_path = codex_home.join("config.toml");
  let global_env_path = codex_home.join(".env");
  let config_content = read_text(&global_config_path)?;
  let env_content = read_text(&global_env_path)?;
  let config_exists = !config_content.trim().is_empty();
  let env_exists = !env_content.trim().is_empty();

  // 5. Check if there are any providers configured
  let (has_providers, has_active_provider) = if config_exists {
    match parse_toml_config(&config_content) {
      Ok(config) => {
        let providers = config
          .get("model_providers")
          .and_then(Value::as_object)
          .map(|p| !p.is_empty())
          .unwrap_or(false);
        let active = config
          .get("model_provider")
          .and_then(Value::as_str)
          .map(|s| !s.is_empty())
          .unwrap_or(false);
        (providers, active)
      }
      Err(_) => (false, false),
    }
  } else {
    (false, false)
  };

  let needs_setup = !codex_installed || !config_exists || !has_providers;

  Ok(json!({
    "node": {
      "installed": node_installed,
      "version": node_version,
      "major": node_major,
      "sufficient": node_major >= 18,
    },
    "npm": {
      "installed": npm_installed,
      "version": npm_version,
    },
    "codex": {
      "installed": codex_installed,
      "version": codex_binary.get("version").cloned().unwrap_or(Value::Null),
      "path": codex_binary.get("path").cloned().unwrap_or(Value::Null),
    },
    "config": {
      "exists": config_exists,
      "envExists": env_exists,
      "hasProviders": has_providers,
      "hasActiveProvider": has_active_provider,
      "configPath": global_config_path.to_string_lossy().to_string(),
      "envPath": global_env_path.to_string_lossy().to_string(),
    },
    "needsSetup": needs_setup,
    "codexHome": codex_home.to_string_lossy().to_string(),
  }))
}

async fn dispatch(app: tauri::AppHandle, path: &str, method: &str, query: &Value, body: &Value) -> Result<Value, String> {
  match (path, method) {
    ("/api/setup/check", "GET") => check_setup_environment(query),
    ("/api/state", "GET") => load_state(query),
    ("/api/provider/test", "POST") => detect_provider(body).await,
    ("/api/config/save", "POST") => save_config(body),
    ("/api/config/raw-save", "POST") => save_raw_config(body),
    ("/api/config/settings-save", "POST") => save_settings(body),
    ("/api/codex/install", "POST") => codex_npm_action(&["install", "-g", OPENAI_CODEX_PACKAGE]),
    ("/api/codex/release", "GET") => get_codex_release_info(),
    ("/api/codex/reinstall", "POST") => codex_npm_action(&["install", "-g", OPENAI_CODEX_PACKAGE, "--force"]),
    ("/api/codex/update", "POST") => codex_npm_action(&["install", "-g", &format!("{}@latest", OPENAI_CODEX_PACKAGE)]),
    ("/api/codex/uninstall", "POST") => codex_npm_action(&["uninstall", "-g", OPENAI_CODEX_PACKAGE]),
    ("/api/codex/launch", "POST") => launch_codex(body),
    ("/api/backups", "GET") => list_backups(),
    ("/api/backups/restore", "POST") => restore_backup(body),
    ("/api/app/update", "GET") => get_app_update_info(app).await,
    ("/api/app/update", "POST") => install_app_update(app).await,
    _ => Err(format!("Unsupported request: {method} {path}")),
  }
}

#[tauri::command]
async fn backend_request(app: tauri::AppHandle, path: String, method: Option<String>, query: Option<Value>, body: Option<Value>) -> Value {
  let query_value = query.unwrap_or_else(|| json!({}));
  let body_value = body.unwrap_or_else(|| json!({}));
  match dispatch(app, &path, method.as_deref().unwrap_or("GET"), &query_value, &body_value).await {
    Ok(data) => ok(data),
    Err(error) => fail(error),
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .invoke_handler(tauri::generate_handler![backend_request])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
