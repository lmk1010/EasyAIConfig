// Per-project Provider 绑定（P0 #3） — Tauri Rust 镜像。
//
// 读写同一份 ~/.codex-config-ui/project-bindings.json，和 src/lib/project-bindings.js
// 保持 wire-compatible。这样 Tauri 桌面端和 npm Express 用户切到对方环境也能
// 看到同一组绑定（用户可能开两个 UI）。
//
// 结构 + 深度匹配语义见 src/lib/project-bindings.js 顶部注释。

use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::provider::get_string;
use crate::{app_home, ensure_dir, parse_json_object, read_text, write_secret};

const BINDINGS_FILE: &str = "project-bindings.json";
const SUPPORTED_TOOLS: &[&str] = &["codex", "claudecode", "opencode"];

fn bindings_path() -> Result<PathBuf, String> {
  Ok(app_home()?.join(BINDINGS_FILE))
}

fn normalize_cwd(cwd: &str) -> Option<String> {
  let trimmed = cwd.trim();
  if trimmed.is_empty() { return None; }
  let path = Path::new(trimmed);
  if !path.is_absolute() { return None; }
  // canonicalize 会失败如果路径不存在，所以用 PathBuf::from 然后 strip 尾斜杠
  let mut s = path.to_string_lossy().to_string();
  while s.ends_with('/') && s.len() > 1 { s.pop(); }
  Some(s)
}

fn normalize_tool(tool: &str) -> Result<String, String> {
  let t = tool.trim().to_ascii_lowercase();
  if !SUPPORTED_TOOLS.contains(&t.as_str()) {
    return Err(format!("tool must be one of {}", SUPPORTED_TOOLS.join(" / ")));
  }
  Ok(t)
}

fn read_state() -> Result<Value, String> {
  let path = bindings_path()?;
  let text = read_text(&path).unwrap_or_default();
  if text.trim().is_empty() {
    return Ok(json!({ "version": 1, "bindings": {} }));
  }
  let parsed: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({ "version": 1, "bindings": {} }));
  Ok(parsed)
}

fn write_state(state: &Value) -> Result<(), String> {
  let path = bindings_path()?;
  ensure_dir(&app_home()?)?;
  let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
  write_secret(&path, &text)
}

// 深度匹配：精确 cwd → 父目录 → 祖父目录 ... 直到根。最深匹配胜出。
fn deepest_match<'a>(bindings: &'a Map<String, Value>, cwd: &str) -> Option<(String, &'a Value)> {
  if let Some(entry) = bindings.get(cwd) { return Some((cwd.to_string(), entry)); }
  let mut current = PathBuf::from(cwd);
  while let Some(parent) = current.parent() {
    if parent == current { break; }
    let parent_str = parent.to_string_lossy().to_string();
    if let Some(entry) = bindings.get(&parent_str) {
      return Some((parent_str, entry));
    }
    current = parent.to_path_buf();
  }
  None
}

fn epoch_secs() -> i64 {
  SystemTime::now().duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs() as i64).unwrap_or(0)
}

// ─── Public route handlers ──────────────────────────────────────────────

pub(crate) fn get_project_binding(query: &Value) -> Result<Value, String> {
  let object = parse_json_object(query);
  let cwd = get_string(&object, "cwd");
  let tool = get_string(&object, "tool");
  let Some(normalized_cwd) = normalize_cwd(&cwd) else {
    return Ok(json!({ "binding": null }));
  };
  let normalized_tool = normalize_tool(&tool)?;

  let state = read_state()?;
  let bindings = state.get("bindings").and_then(Value::as_object).cloned().unwrap_or_default();
  let Some((matched_dir, entry)) = deepest_match(&bindings, &normalized_cwd) else {
    return Ok(json!({ "binding": null }));
  };
  let Some(tool_entry) = entry.get(&normalized_tool).and_then(Value::as_object) else {
    return Ok(json!({ "binding": null }));
  };
  let provider_key = tool_entry.get("providerKey").and_then(Value::as_str).unwrap_or("");
  if provider_key.is_empty() { return Ok(json!({ "binding": null })); }
  Ok(json!({ "binding": {
    "providerKey": provider_key,
    "savedAt": tool_entry.get("savedAt").and_then(Value::as_i64).unwrap_or(0),
    "matchedDir": matched_dir,
    "isExactMatch": matched_dir == normalized_cwd,
  } }))
}

pub(crate) fn set_project_binding(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let cwd = get_string(&object, "cwd");
  let tool = get_string(&object, "tool");
  let provider_key = get_string(&object, "providerKey");
  let Some(normalized_cwd) = normalize_cwd(&cwd) else {
    return Err("cwd must be an absolute path".to_string());
  };
  let normalized_tool = normalize_tool(&tool)?;
  if provider_key.trim().is_empty() {
    return Err("providerKey is required".to_string());
  }

  let mut state = read_state()?;
  let bindings = state
    .as_object_mut()
    .and_then(|obj| obj.entry("bindings").or_insert(json!({})).as_object_mut())
    .ok_or("failed to mutate bindings".to_string())?;

  let entry = bindings.entry(normalized_cwd.clone())
    .or_insert(json!({}))
    .as_object_mut()
    .ok_or("entry is not an object".to_string())?;
  entry.insert(normalized_tool.clone(), json!({
    "providerKey": provider_key.trim(),
    "savedAt": epoch_secs(),
  }));

  write_state(&state)?;
  Ok(json!({
    "cwd": normalized_cwd,
    "tool": normalized_tool,
    "providerKey": provider_key.trim(),
  }))
}

pub(crate) fn remove_project_binding(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let cwd = get_string(&object, "cwd");
  let tool = get_string(&object, "tool");
  let Some(normalized_cwd) = normalize_cwd(&cwd) else {
    return Err("cwd must be an absolute path".to_string());
  };

  let mut state = read_state()?;
  let bindings = state
    .as_object_mut()
    .and_then(|obj| obj.entry("bindings").or_insert(json!({})).as_object_mut())
    .ok_or("failed to mutate bindings".to_string())?;

  if tool.trim().is_empty() {
    let existed = bindings.remove(&normalized_cwd).is_some();
    write_state(&state)?;
    return Ok(json!({ "cwd": normalized_cwd, "removed": existed }));
  }

  let normalized_tool = normalize_tool(&tool)?;
  let Some(entry) = bindings.get_mut(&normalized_cwd).and_then(Value::as_object_mut) else {
    return Ok(json!({ "cwd": normalized_cwd, "tool": normalized_tool, "removed": false }));
  };
  let removed = entry.remove(&normalized_tool).is_some();
  if entry.is_empty() {
    bindings.remove(&normalized_cwd);
  }
  write_state(&state)?;
  Ok(json!({ "cwd": normalized_cwd, "tool": normalized_tool, "removed": removed }))
}

pub(crate) fn list_project_bindings(_query: &Value) -> Result<Value, String> {
  let state = read_state()?;
  let bindings = state.get("bindings").and_then(Value::as_object).cloned().unwrap_or_default();
  let items: Vec<Value> = bindings.iter().map(|(cwd, tools)| json!({ "cwd": cwd, "tools": tools })).collect();
  Ok(json!({ "bindings": items }))
}

pub(crate) fn summarize_binding_for_cwd(query: &Value) -> Result<Value, String> {
  let object = parse_json_object(query);
  let cwd = get_string(&object, "cwd");
  let Some(normalized_cwd) = normalize_cwd(&cwd) else {
    return Ok(json!({ "matchedDir": null, "isExactMatch": false, "tools": {} }));
  };
  let state = read_state()?;
  let bindings = state.get("bindings").and_then(Value::as_object).cloned().unwrap_or_default();
  let Some((matched_dir, entry)) = deepest_match(&bindings, &normalized_cwd) else {
    return Ok(json!({ "matchedDir": null, "isExactMatch": false, "tools": {} }));
  };
  Ok(json!({
    "matchedDir": matched_dir,
    "isExactMatch": matched_dir == normalized_cwd,
    "tools": entry,
  }))
}
