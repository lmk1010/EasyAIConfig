// Codex OAuth profile manager.
//
// Layout:
//   ~/.codex-config-ui/codex-oauth-profiles/
//     profiles.json              — index { active, profiles: [{id, name, plan, ...}] }
//     <id>/                      — this directory IS CODEX_HOME for the profile
//       auth.json                — OAuth tokens for this account
//       .env / config.toml / sessions / history.jsonl / ... managed by Codex
//
// Switching only updates which profile/home the UI points to. We no longer
// copy auth.json back into ~/.codex; each profile keeps its own isolated
// CODEX_HOME so auth, sessions, history and config stay separated.

use chrono::Utc;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::provider::get_string;
use crate::{
  app_home, default_codex_home, ensure_dir, parse_env, parse_json_object, read_text,
  stringify_env, write_secret, write_text,
};

const PROFILES_DIRNAME: &str = "codex-oauth-profiles";
const PROFILES_INDEX: &str = "profiles.json";
const AUTH_FILENAME: &str = "auth.json";
const SWITCH_BACKUP_KEEP: usize = 5;

fn profiles_root() -> Result<PathBuf, String> {
  Ok(app_home()?.join(PROFILES_DIRNAME))
}

fn profiles_index_path() -> Result<PathBuf, String> {
  Ok(profiles_root()?.join(PROFILES_INDEX))
}

fn profile_dir(id: &str) -> Result<PathBuf, String> {
  if id.trim().is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
    return Err("非法的 profile id".to_string());
  }
  Ok(profiles_root()?.join(id))
}

fn profile_auth_path(id: &str) -> Result<PathBuf, String> {
  Ok(profile_dir(id)?.join(AUTH_FILENAME))
}

fn auth_path_for_codex_home(codex_home: &Path) -> PathBuf {
  codex_home.join(AUTH_FILENAME)
}

fn read_profiles_index() -> Result<Value, String> {
  let path = profiles_index_path()?;
  let text = read_text(&path)?;
  if text.trim().is_empty() {
    return Ok(json!({ "version": 1, "active": "", "profiles": [] }));
  }
  let parsed: Value = serde_json::from_str(&text)
    .map_err(|e| format!("profiles.json 解析失败: {}", e))?;
  Ok(parsed)
}

fn write_profiles_index(index: &Value) -> Result<(), String> {
  let path = profiles_index_path()?;
  ensure_dir(&profiles_root()?)?;
  let text = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
  write_text(&path, &text)
}

// ---- JWT payload decode (no signature verification — local display only) ----

fn b64url_decode(input: &str) -> Option<Vec<u8>> {
  // RFC 4648 base64url, tolerant to missing padding.
  let mut padded = input.replace('-', "+").replace('_', "/");
  let missing = (4 - (padded.len() % 4)) % 4;
  padded.extend(std::iter::repeat('=').take(missing));

  const ALPHABET: &[u8] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let mut lut = [0xffu8; 256];
  for (i, &b) in ALPHABET.iter().enumerate() {
    lut[b as usize] = i as u8;
  }

  let bytes = padded.as_bytes();
  let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
  let mut buf: u32 = 0;
  let mut bits = 0u32;
  for &c in bytes {
    if c == b'=' {
      break;
    }
    let v = lut[c as usize];
    if v == 0xff {
      return None;
    }
    buf = (buf << 6) | v as u32;
    bits += 6;
    if bits >= 8 {
      bits -= 8;
      out.push(((buf >> bits) & 0xff) as u8);
    }
  }
  Some(out)
}

fn decode_jwt_payload(token: &str) -> Option<Value> {
  let trimmed = token.trim();
  if trimmed.is_empty() {
    return None;
  }
  let mid = trimmed.split('.').nth(1)?;
  let bytes = b64url_decode(mid)?;
  let text = std::str::from_utf8(&bytes).ok()?;
  serde_json::from_str::<Value>(text).ok()
}

fn get_str(obj: &Map<String, Value>, key: &str) -> String {
  obj.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string()
}

// Best-effort plan / account / email extraction from OAuth auth.json.
// Walks the id_token payload looking at the likely claim paths used by
// OpenAI's ChatGPT-to-Codex OAuth flow, plus fallbacks.
fn extract_oauth_meta(auth_json: &Value) -> Value {
  let tokens = auth_json.get("tokens").and_then(Value::as_object);
  let tokens = match tokens {
    Some(t) => t,
    None => {
      return json!({
        "hasTokens": false,
        "accountId": "",
        "plan": "",
        "email": "",
        "sub": "",
      });
    }
  };

  let access_token = get_str(tokens, "access_token");
  if access_token.is_empty() {
    return json!({
      "hasTokens": false,
      "accountId": "",
      "plan": "",
      "email": "",
      "sub": "",
    });
  }

  let mut account_id = get_str(tokens, "account_id");
  let mut plan = String::new();
  let mut email = String::new();
  let mut sub = String::new();

  let id_token = get_str(tokens, "id_token");
  if let Some(payload) = decode_jwt_payload(&id_token) {
    if let Some(obj) = payload.as_object() {
      if sub.is_empty() {
        sub = get_str(obj, "sub");
      }
      if email.is_empty() {
        email = get_str(obj, "email");
      }

      // Canonical path used by OpenAI id_tokens.
      if let Some(auth_ns) = obj.get("https://api.openai.com/auth").and_then(Value::as_object) {
        if plan.is_empty() {
          plan = get_str(auth_ns, "chatgpt_plan_type");
        }
        if account_id.is_empty() {
          account_id = get_str(auth_ns, "chatgpt_account_id");
        }
      }

      // Fallback: scan top-level for any plan-ish field.
      if plan.is_empty() {
        for (k, v) in obj.iter() {
          if !v.is_string() {
            continue;
          }
          let lk = k.to_ascii_lowercase();
          if lk.contains("plan") || lk.contains("subscription") {
            plan = v.as_str().unwrap_or("").trim().to_string();
            if !plan.is_empty() {
              break;
            }
          }
        }
      }
    }
  }

  json!({
    "hasTokens": true,
    "accountId": account_id,
    "plan": plan,
    "email": email,
    "sub": sub,
  })
}

fn oauth_meta_for_codex_home(codex_home: &Path) -> Result<Value, String> {
  let auth_path = auth_path_for_codex_home(codex_home);
  let text = read_text(&auth_path)?;
  if text.trim().is_empty() {
    return Ok(json!({
      "hasTokens": false,
      "accountId": "",
      "plan": "",
      "email": "",
      "sub": "",
    }));
  }
  let auth: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
  Ok(extract_oauth_meta(&auth))
}

fn resolve_requested_codex_home(object: &Map<String, Value>) -> Result<PathBuf, String> {
  let input = get_string(object, "codexHome");
  if input.is_empty() {
    default_codex_home()
  } else {
    Ok(PathBuf::from(input))
  }
}

fn detect_profile_id_by_account(index: &Value, live_account_id: &str) -> String {
  if live_account_id.is_empty() {
    return String::new();
  }
  let Some(arr) = index.get("profiles").and_then(Value::as_array) else {
    return String::new();
  };
  for p in arr {
    if p.get("accountId").and_then(Value::as_str).unwrap_or("") == live_account_id {
      return p.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    }
  }
  String::new()
}

fn detect_profile_id_by_home(index: &Value, codex_home: &Path) -> String {
  let Some(arr) = index.get("profiles").and_then(Value::as_array) else {
    return String::new();
  };
  for p in arr {
    let id = p.get("id").and_then(Value::as_str).unwrap_or("");
    if id.is_empty() {
      continue;
    }
    if let Ok(dir) = profile_dir(id) {
      if dir == codex_home {
        return id.to_string();
      }
    }
  }
  String::new()
}

fn default_profile_name(requested_name: &str, meta: &Value, id: &str) -> String {
  if !requested_name.trim().is_empty() {
    return requested_name.trim().to_string();
  }
  let email = meta.get("email").and_then(Value::as_str).unwrap_or("").trim();
  if !email.is_empty() {
    return email.to_string();
  }
  let plan = meta.get("plan").and_then(Value::as_str).unwrap_or("").trim();
  if !plan.is_empty() {
    return format!("OAuth ({})", plan);
  }
  format!("Codex 账号 #{}", &id[..8.min(id.len())])
}

fn refresh_profile_runtime_meta(profile: &mut Value) -> Result<bool, String> {
  let Some(obj) = profile.as_object_mut() else {
    return Ok(false);
  };
  let id = obj.get("id").and_then(Value::as_str).unwrap_or("").trim().to_string();
  if id.is_empty() {
    return Ok(false);
  }
  let dir = profile_dir(&id)?;
  let meta = oauth_meta_for_codex_home(&dir)?;
  let has_tokens = meta.get("hasTokens").and_then(Value::as_bool).unwrap_or(false);
  let mut changed = false;

  let codex_home = dir.to_string_lossy().to_string();
  if obj.get("codexHome").and_then(Value::as_str).unwrap_or("") != codex_home {
    obj.insert("codexHome".to_string(), json!(codex_home));
    changed = true;
  }
  if obj.get("hasTokens").and_then(Value::as_bool).unwrap_or(false) != has_tokens {
    obj.insert("hasTokens".to_string(), json!(has_tokens));
    changed = true;
  }

  if has_tokens {
    for key in ["accountId", "plan", "email", "sub"] {
      let next = meta.get(key).and_then(Value::as_str).unwrap_or("").to_string();
      if obj.get(key).and_then(Value::as_str).unwrap_or("") != next {
        obj.insert(key.to_string(), json!(next));
        changed = true;
      }
    }
  }

  Ok(changed)
}

fn refresh_profiles_runtime_meta(index: &mut Value) -> Result<Vec<Value>, String> {
  let Some(arr) = index.get_mut("profiles").and_then(Value::as_array_mut) else {
    return Ok(Vec::new());
  };

  let mut changed = false;
  for profile in arr.iter_mut() {
    changed |= refresh_profile_runtime_meta(profile)?;
  }

  let profiles = arr.clone();
  if changed {
    write_profiles_index(index)?;
  }
  Ok(profiles)
}

fn is_env_style_key(key: &str) -> bool {
  let trimmed = key.trim();
  !trimmed.is_empty()
    && trimmed
      .bytes()
      .next()
      .map(|byte| byte == b'_' || byte.is_ascii_uppercase())
      .unwrap_or(false)
    && trimmed
      .bytes()
      .all(|byte| byte == b'_' || byte.is_ascii_uppercase() || byte.is_ascii_digit())
}

fn should_preserve_auth_entry(key: &str) -> bool {
  if !is_env_style_key(key) {
    return false;
  }
  let upper = key.trim().to_ascii_uppercase();
  upper.contains("KEY")
    || upper.contains("TOKEN")
    || upper.contains("SECRET")
    || upper.contains("BASE_URL")
    || upper.ends_with("_URL")
    || upper.ends_with("_ENDPOINT")
}

pub(crate) fn migrate_auth_json_env_to_codex_env(codex_home: &Path, auth_raw: &str) -> Result<Vec<String>, String> {
  if auth_raw.trim().is_empty() {
    return Ok(Vec::new());
  }

  let auth_json: Value = serde_json::from_str(auth_raw).unwrap_or_else(|_| json!({}));
  let Some(auth_object) = auth_json.as_object() else {
    return Ok(Vec::new());
  };

  let env_path = codex_home.join(".env");
  let env_raw = read_text(&env_path)?;
  let mut env = parse_env(&env_raw);
  let mut migrated = Vec::new();

  for (key, value) in auth_object {
    let Some(text) = value.as_str() else {
      continue;
    };
    let clean = text.trim();
    if clean.is_empty() || !should_preserve_auth_entry(key) {
      continue;
    }

    let existing = env.get(key).map(|item| item.trim()).unwrap_or("");
    if !existing.is_empty() {
      continue;
    }

    env.insert(key.clone(), clean.to_string());
    migrated.push(key.clone());
  }

  if !migrated.is_empty() {
    write_text(&env_path, &stringify_env(&env))?;
  }

  Ok(migrated)
}

// ---- Switch-time safety backup ----

pub(crate) fn write_switch_backup(live_auth_raw: &str) -> Result<PathBuf, String> {
  let dir = profiles_root()?.join("_switch_backups");
  ensure_dir(&dir)?;
  let ts = Utc::now().format("%Y%m%dT%H%M%S").to_string();
  let path = dir.join(format!("auth-{}.json", ts));
  write_secret(&path, live_auth_raw)?;
  prune_old_backups(&dir)?;
  Ok(path)
}

fn prune_old_backups(dir: &Path) -> Result<(), String> {
  let mut entries: Vec<_> = fs::read_dir(dir)
    .map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .filter(|e| {
      e.path().extension().and_then(|s| s.to_str()) == Some("json")
        && e.path()
          .file_name()
          .and_then(|s| s.to_str())
          .map(|n| n.starts_with("auth-"))
          .unwrap_or(false)
    })
    .collect();
  entries.sort_by_key(|e| e.file_name());
  let remove_count = entries.len().saturating_sub(SWITCH_BACKUP_KEEP);
  for entry in entries.into_iter().take(remove_count) {
    let _ = fs::remove_file(entry.path());
  }
  Ok(())
}

// ---- Public routes ----

pub(crate) fn list_oauth_profiles(_query: &Value) -> Result<Value, String> {
  let query_object = parse_json_object(_query);
  let current_codex_home = resolve_requested_codex_home(&query_object)?;

  let mut index = read_profiles_index()?;
  let profiles = refresh_profiles_runtime_meta(&mut index)?;
  let live_meta = oauth_meta_for_codex_home(&current_codex_home).unwrap_or_else(|_| {
    json!({ "hasTokens": false, "accountId": "", "plan": "", "email": "", "sub": "" })
  });
  let live_account = live_meta
    .get("accountId")
    .and_then(Value::as_str)
    .unwrap_or("")
    .to_string();

  let active_id = {
    let by_home = detect_profile_id_by_home(&index, &current_codex_home);
    if !by_home.is_empty() {
      by_home
    } else {
      detect_profile_id_by_account(&index, &live_account)
    }
  };

  Ok(json!({
    "active": active_id,
    "profiles": profiles,
    "live": live_meta,
    "liveHasUnsavedTokens": live_meta.get("hasTokens").and_then(Value::as_bool).unwrap_or(false) && active_id.is_empty(),
  }))
}

pub(crate) fn save_current_oauth_profile(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let requested_name = get_string(&object, "name");

  let source_codex_home = resolve_requested_codex_home(&object)?;
  let live_path = auth_path_for_codex_home(&source_codex_home);
  let live_raw = read_text(&live_path)?;
  if live_raw.trim().is_empty() {
    return Err("当前 CODEX_HOME/auth.json 为空，先运行 codex login".to_string());
  }
  let live_json: Value = serde_json::from_str(&live_raw)
    .map_err(|e| format!("CODEX_HOME/auth.json 解析失败: {}", e))?;
  let meta = extract_oauth_meta(&live_json);
  if !meta.get("hasTokens").and_then(Value::as_bool).unwrap_or(false) {
    return Err("当前 auth.json 没有 OAuth tokens（只有 API Key），请先运行 codex login".to_string());
  }

  let mut index = read_profiles_index()?;
  let account_id = meta.get("accountId").and_then(Value::as_str).unwrap_or("").to_string();
  let plan = meta.get("plan").and_then(Value::as_str).unwrap_or("").to_string();
  let email = meta.get("email").and_then(Value::as_str).unwrap_or("").to_string();
  let sub = meta.get("sub").and_then(Value::as_str).unwrap_or("").to_string();

  let existing_id = {
    let by_home = detect_profile_id_by_home(&index, &source_codex_home);
    if !by_home.is_empty() {
      by_home
    } else if !account_id.is_empty() {
      detect_profile_id_by_account(&index, &account_id)
    } else {
      String::new()
    }
  };

  let now = Utc::now().timestamp();
  let id = if existing_id.is_empty() {
    format!("prof_{}", Uuid::new_v4().simple())
  } else {
    existing_id.clone()
  };
  let target_codex_home = profile_dir(&id)?;
  ensure_dir(&target_codex_home)?;

  let archive = profile_auth_path(&id)?;
  if source_codex_home != target_codex_home || read_text(&archive).unwrap_or_default() != live_raw {
    write_secret(&archive, &live_raw)?;
  }

  let name = default_profile_name(&requested_name, &meta, &id);

  if let Some(arr) = index.get_mut("profiles").and_then(Value::as_array_mut) {
    let mut updated = false;
    for p in arr.iter_mut() {
      if p.get("id").and_then(Value::as_str).unwrap_or("") == id {
        if let Some(obj) = p.as_object_mut() {
          obj.insert("name".to_string(), json!(name));
          obj.insert("accountId".to_string(), json!(account_id));
          obj.insert("plan".to_string(), json!(plan));
          obj.insert("email".to_string(), json!(email));
          obj.insert("sub".to_string(), json!(sub));
          obj.insert("codexHome".to_string(), json!(target_codex_home.to_string_lossy().to_string()));
          obj.insert("hasTokens".to_string(), json!(true));
          obj.insert("updatedAt".to_string(), json!(now));
        }
        updated = true;
        break;
      }
    }
    if !updated {
      arr.push(json!({
        "id": id,
        "name": name,
        "accountId": account_id,
        "plan": plan,
        "email": email,
        "sub": sub,
        "codexHome": target_codex_home.to_string_lossy().to_string(),
        "hasTokens": true,
        "createdAt": now,
        "updatedAt": now,
      }));
    }
  } else if let Some(obj) = index.as_object_mut() {
    obj.insert(
      "profiles".to_string(),
      json!([{
        "id": id,
        "name": name,
        "accountId": account_id,
        "plan": plan,
        "email": email,
        "sub": sub,
        "codexHome": target_codex_home.to_string_lossy().to_string(),
        "hasTokens": true,
        "createdAt": now,
        "updatedAt": now,
      }]),
    );
  }

  if let Some(obj) = index.as_object_mut() {
    obj.insert("active".to_string(), json!(id));
  }
  write_profiles_index(&index)?;

  Ok(json!({
    "id": id,
    "updated": !existing_id.is_empty(),
    "codexHome": target_codex_home.to_string_lossy().to_string()
  }))
}

pub(crate) fn create_oauth_profile(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let requested_name = get_string(&object, "name");
  let id = format!("prof_{}", Uuid::new_v4().simple());
  let dir = profile_dir(&id)?;
  ensure_dir(&dir)?;

  let now = Utc::now().timestamp();
  let name = default_profile_name(&requested_name, &json!({}), &id);

  let mut index = read_profiles_index()?;
  if let Some(arr) = index.get_mut("profiles").and_then(Value::as_array_mut) {
    arr.push(json!({
      "id": id,
      "name": name,
      "codexHome": dir.to_string_lossy().to_string(),
      "hasTokens": false,
      "createdAt": now,
      "updatedAt": now,
    }));
  } else if let Some(obj) = index.as_object_mut() {
    obj.insert(
      "profiles".to_string(),
      json!([{
        "id": id,
        "name": name,
        "codexHome": dir.to_string_lossy().to_string(),
        "hasTokens": false,
        "createdAt": now,
        "updatedAt": now,
      }]),
    );
  }
  write_profiles_index(&index)?;

  Ok(json!({
    "id": id,
    "name": name,
    "codexHome": dir.to_string_lossy().to_string(),
  }))
}

pub(crate) fn switch_oauth_profile(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let id = get_string(&object, "id");
  if id.is_empty() {
    return Err("id is required".to_string());
  }

  let target_codex_home = profile_dir(&id)?;
  if !target_codex_home.exists() {
    return Err("目标 profile 目录不存在".to_string());
  }

  // Update active pointer.
  let mut index = read_profiles_index()?;
  if let Some(obj) = index.as_object_mut() {
    obj.insert("active".to_string(), json!(id));
  }
  write_profiles_index(&index)?;

  Ok(json!({
    "id": id,
    "codexHome": target_codex_home.to_string_lossy().to_string()
  }))
}

pub(crate) fn rename_oauth_profile(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let id = get_string(&object, "id");
  let name = get_string(&object, "name");
  if id.is_empty() {
    return Err("id is required".to_string());
  }
  if name.is_empty() {
    return Err("name is required".to_string());
  }

  let mut index = read_profiles_index()?;
  let mut touched = false;
  let now = Utc::now().timestamp();
  if let Some(arr) = index.get_mut("profiles").and_then(Value::as_array_mut) {
    for p in arr.iter_mut() {
      if p.get("id").and_then(Value::as_str).unwrap_or("") == id {
        if let Some(obj) = p.as_object_mut() {
          obj.insert("name".to_string(), json!(name));
          obj.insert("updatedAt".to_string(), json!(now));
        }
        touched = true;
        break;
      }
    }
  }
  if !touched {
    return Err("未找到该 profile".to_string());
  }
  write_profiles_index(&index)?;
  Ok(json!({ "id": id, "name": name }))
}

pub(crate) fn delete_oauth_profile(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let id = get_string(&object, "id");
  if id.is_empty() {
    return Err("id is required".to_string());
  }

  let mut index = read_profiles_index()?;
  let mut removed = false;
  if let Some(arr) = index.get_mut("profiles").and_then(Value::as_array_mut) {
    let before = arr.len();
    arr.retain(|p| p.get("id").and_then(Value::as_str).unwrap_or("") != id);
    removed = arr.len() != before;
  }
  if !removed {
    return Err("未找到该 profile".to_string());
  }

  if let Some(obj) = index.as_object_mut() {
    let active = obj.get("active").and_then(Value::as_str).unwrap_or("").to_string();
    if active == id {
      obj.insert("active".to_string(), json!(""));
    }
  }
  write_profiles_index(&index)?;

  let dir = profile_dir(&id)?;
  if dir.exists() {
    let _ = fs::remove_dir_all(&dir);
  }

  Ok(json!({ "id": id }))
}
