use chrono::Utc;
use semver::Version;
use serde_json::{json, Map, Value};
use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use toml::map::Map as TomlMap;
use toml::Value as TomlValue;

const APP_HOME_DIRNAME: &str = ".codex-config-ui";
const BACKUPS_DIRNAME: &str = "backups";
pub(crate) const OPENAI_CODEX_PACKAGE: &str = "@openai/codex";
pub(crate) const CLAUDE_CODE_PACKAGE: &str = "@anthropic-ai/claude-code";
pub(crate) const OPENCODE_PACKAGE: &str = "opencode-ai";
pub(crate) const OPENCLAW_PACKAGE: &str = "openclaw";

pub(crate) fn openclaw_home() -> Result<PathBuf, String> {
  Ok(home_dir()?.join(".openclaw"))
}

pub(crate) fn opencode_config_home() -> Result<PathBuf, String> {
  let home = home_dir()?;
  if cfg!(target_os = "windows") {
    let base = std::env::var("APPDATA")
      .ok()
      .filter(|value| !value.trim().is_empty())
      .map(PathBuf::from)
      .unwrap_or_else(|| home.join("AppData").join("Roaming"));
    return Ok(base.join("opencode"));
  }
  let base = std::env::var("XDG_CONFIG_HOME")
    .ok()
    .filter(|value| !value.trim().is_empty())
    .map(PathBuf::from)
    .unwrap_or_else(|| home.join(".config"));
  Ok(base.join("opencode"))
}

pub(crate) fn opencode_data_home() -> Result<PathBuf, String> {
  let home = home_dir()?;
  if cfg!(target_os = "windows") {
    let base = std::env::var("APPDATA")
      .ok()
      .filter(|value| !value.trim().is_empty())
      .map(PathBuf::from)
      .unwrap_or_else(|| home.join("AppData").join("Roaming"));
    return Ok(base.join("opencode"));
  }
  let base = std::env::var("XDG_DATA_HOME")
    .ok()
    .filter(|value| !value.trim().is_empty())
    .map(PathBuf::from)
    .unwrap_or_else(|| home.join(".local").join("share"));
  Ok(base.join("opencode"))
}

pub(crate) fn ok(data: Value) -> Value {
  json!({ "ok": true, "data": data })
}

pub(crate) fn fail(message: impl Into<String>) -> Value {
  json!({ "ok": false, "error": message.into() })
}

pub(crate) fn home_dir() -> Result<PathBuf, String> {
  dirs::home_dir().ok_or_else(|| "无法获取用户主目录".to_string())
}

pub(crate) fn default_codex_home() -> Result<PathBuf, String> {
  let env_home = std::env::var("CODEX_HOME").unwrap_or_default();
  if !env_home.trim().is_empty() {
    return Ok(PathBuf::from(env_home.trim()));
  }
  Ok(home_dir()?.join(".codex"))
}

pub(crate) fn claude_code_home() -> Result<PathBuf, String> {
  Ok(home_dir()?.join(".claude"))
}

pub(crate) fn app_home() -> Result<PathBuf, String> {
  Ok(home_dir()?.join(APP_HOME_DIRNAME))
}

pub(crate) fn backups_root() -> Result<PathBuf, String> {
  Ok(app_home()?.join(BACKUPS_DIRNAME))
}

pub(crate) fn timestamp() -> String {
  Utc::now().to_rfc3339().replace(':', "-").replace('.', "-")
}

pub(crate) fn npm_command() -> &'static str {
  if cfg!(target_os = "windows") {
    "npm.cmd"
  } else {
    "npm"
  }
}

pub(crate) fn ensure_dir(path: &Path) -> Result<(), String> {
  fs::create_dir_all(path).map_err(|error| error.to_string())
}

pub(crate) fn read_text(path: &Path) -> Result<String, String> {
  match fs::read_to_string(path) {
    Ok(text) => Ok(text),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
    Err(error) => Err(error.to_string()),
  }
}

pub(crate) fn write_text(path: &Path, content: &str) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    ensure_dir(parent)?;
  }
  fs::write(path, content).map_err(|error| error.to_string())
}

pub(crate) fn parse_env(content: &str) -> BTreeMap<String, String> {
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

pub(crate) fn stringify_env(entries: &BTreeMap<String, String>) -> String {
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

pub(crate) fn parse_json_object(value: &Value) -> Map<String, Value> {
  value.as_object().cloned().unwrap_or_default()
}

pub(crate) fn toml_to_json(value: &TomlValue) -> Value {
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

pub(crate) fn json_to_toml(value: &Value) -> Result<TomlValue, String> {
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

pub(crate) fn parse_toml_config(content: &str) -> Result<Value, String> {
  if content.trim().is_empty() {
    return Ok(Value::Object(Map::new()));
  }
  let parsed = content.parse::<TomlValue>().map_err(|error| error.to_string())?;
  Ok(toml_to_json(&parsed))
}

pub(crate) fn stringify_toml_config(config: &Value) -> Result<String, String> {
  let toml_value = json_to_toml(config)?;
  toml::to_string_pretty(&toml_value).map_err(|error| error.to_string())
}

pub(crate) fn apply_patch(target: &mut Value, patch: &Value) {
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

pub(crate) fn normalize_settings_patch(patch: &Value) -> Value {
  let mut normalized = patch.clone();
  if let Some(object) = normalized.as_object_mut() {
    match object.get("compact_prompt") {
      Some(Value::Bool(false)) => {
        object.insert("compact_prompt".to_string(), Value::String("false".to_string()));
      }
      Some(Value::Bool(true)) => {
        object.insert("compact_prompt".to_string(), Value::Null);
      }
      _ => {}
    }
  }
  normalized
}

pub(crate) fn extract_version(text: &str) -> Option<String> {
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

pub(crate) fn compare_versions(left: &str, right: &str) -> Ordering {
  let left_version = extract_version(left).and_then(|value| Version::parse(&value).ok());
  let right_version = extract_version(right).and_then(|value| Version::parse(&value).ok());
  match (left_version, right_version) {
    (Some(left), Some(right)) => left.cmp(&right),
    (Some(_), None) => Ordering::Greater,
    (None, Some(_)) => Ordering::Less,
    (None, None) => Ordering::Equal,
  }
}


mod config;
mod provider;
mod updater;
mod codex;
mod oauth_profiles;
mod claudecode_oauth_profiles;
mod network;
mod processes;
mod usage_stats;
mod app_settings;
mod routes;

use routes::backend_request;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .invoke_handler(tauri::generate_handler![backend_request])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
