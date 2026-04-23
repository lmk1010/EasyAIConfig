// Persistent, app-wide preferences.
//
// Stored as plain JSON on disk at ~/.codex-config-ui/app-settings.json.
// NOT localStorage — browser storage can be cleared by the user accidentally
// (devtools, new profile, storage quota eviction), which would silently
// disable safety settings like the IP firewall gate. Anything that affects
// user safety or survives reinstalls lives here.
//
// Schema intentionally kept as a plain JSON object and patch-style updated
// so adding new keys later doesn't need a migration.

use serde_json::{json, Map, Value};
use std::path::PathBuf;

use crate::{app_home, ensure_dir, parse_json_object, read_text, write_text};

const SETTINGS_FILE: &str = "app-settings.json";

fn settings_path() -> Result<PathBuf, String> {
  Ok(app_home()?.join(SETTINGS_FILE))
}

fn default_settings() -> Value {
  json!({
    "version": 1,
    // When true, launching Codex / Claude Code from this app will refuse to
    // proceed if the current IP is verdict=block. Default off — user opts in.
    "ipGateBlock": false,
    // Mirror flag for the Shell 集成 (Claude Code account follower) feature.
    // Source of truth is still the presence of our marker block inside the
    // shell rc files — this flag just lets the UI render instantly without
    // scanning three files. Set by shell_integration::{enable,disable}.
    "claudeShellIntegrationEnabled": false,
  })
}

fn read_settings_raw() -> Result<Value, String> {
  let path = settings_path()?;
  let text = read_text(&path)?;
  if text.trim().is_empty() {
    return Ok(default_settings());
  }
  let parsed: Value = serde_json::from_str(&text)
    .map_err(|e| format!("app-settings.json 解析失败: {}", e))?;
  // Merge with defaults so missing keys get filled in on read, not write.
  let mut merged = default_settings();
  if let (Some(dst), Some(src)) = (merged.as_object_mut(), parsed.as_object()) {
    for (k, v) in src {
      dst.insert(k.clone(), v.clone());
    }
  }
  Ok(merged)
}

fn write_settings_raw(value: &Value) -> Result<(), String> {
  ensure_dir(&app_home()?)?;
  let path = settings_path()?;
  let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
  write_text(&path, &text)
}

// Public helper: read a specific setting. Used by shell_integration to
// surface the last-known "enabled" flag without rescanning rc files, and
// reserved for future server-side gate enforcement (ipGateBlock).
pub(crate) fn get_bool(key: &str, default_value: bool) -> bool {
  read_settings_raw()
    .ok()
    .and_then(|v| v.get(key).and_then(Value::as_bool))
    .unwrap_or(default_value)
}

// ---- Public routes ----

pub(crate) fn load_app_settings(_query: &Value) -> Result<Value, String> {
  read_settings_raw()
}

// Patch-style write: only keys present in the request body are touched.
// Returns the fully merged state after write.
pub(crate) fn save_app_settings(body: &Value) -> Result<Value, String> {
  let patch: Map<String, Value> = parse_json_object(body);
  if patch.is_empty() {
    return Err("没有要保存的字段".to_string());
  }
  let mut current = read_settings_raw()?;
  if let Some(obj) = current.as_object_mut() {
    for (k, v) in patch.iter() {
      // Skip the schema-version field; we own it.
      if k == "version" { continue; }
      obj.insert(k.clone(), v.clone());
    }
  }
  write_settings_raw(&current)?;
  Ok(current)
}
