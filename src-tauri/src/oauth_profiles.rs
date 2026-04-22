// Codex OAuth profile manager — local file shuffle only.
//
// Layout:
//   ~/.codex-config-ui/codex-oauth-profiles/
//     profiles.json              — index { active, profiles: [{id, name, plan, ...}] }
//     <id>/auth.json             — archived copy of a ~/.codex/auth.json
//     <id>/last-token-preview    — (future) not used yet
//
// The active profile's archived auth.json is kept in sync whenever we detect
// the live ~/.codex/auth.json has been refreshed (e.g. silent OAuth refresh),
// so switching back never loses a fresh refresh_token.
//
// No token is sent over the network. No HTTP calls to OpenAI are made by this
// module. Switching is a pure `cp archive/auth.json ~/.codex/auth.json`.

use chrono::Utc;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::provider::get_string;
use crate::{
  app_home, default_codex_home, ensure_dir, parse_env, parse_json_object, read_text,
  stringify_env, write_text,
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

// Public helper so frontend doesn't have to reparse.
fn meta_for_live_codex_auth() -> Result<Value, String> {
  let codex_home = default_codex_home()?;
  let auth_path = codex_home.join("auth.json");
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

// ---- Active profile tracking ----

// Determine which saved profile matches the live ~/.codex/auth.json.
// Matching is by account_id (stable across token refreshes).
fn detect_active_profile_id(index: &Value, live_account_id: &str) -> String {
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

// If the live auth.json belongs to a known profile, refresh its archive copy
// so we don't lose a just-refreshed refresh_token on the next switch.
fn sync_live_to_active_archive(live_auth_raw: &str, active_id: &str) -> Result<(), String> {
  if active_id.is_empty() || live_auth_raw.trim().is_empty() {
    return Ok(());
  }
  let archive = profile_auth_path(active_id)?;
  // Only overwrite if content actually differs.
  let existing = read_text(&archive).unwrap_or_default();
  if existing == live_auth_raw {
    return Ok(());
  }
  write_text(&archive, live_auth_raw)
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
  write_text(&path, live_auth_raw)?;
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
  let mut index = read_profiles_index()?;
  let live_meta = meta_for_live_codex_auth().unwrap_or_else(|_| {
    json!({ "hasTokens": false, "accountId": "", "plan": "", "email": "", "sub": "" })
  });
  let live_raw = {
    let codex_home = default_codex_home()?;
    read_text(&codex_home.join("auth.json")).unwrap_or_default()
  };
  let live_account = live_meta
    .get("accountId")
    .and_then(Value::as_str)
    .unwrap_or("")
    .to_string();

  let active_id = detect_active_profile_id(&index, &live_account);

  // Silent sync: if live auth matches a profile, keep that archive up-to-date.
  let _ = sync_live_to_active_archive(&live_raw, &active_id);

  if let Some(obj) = index.as_object_mut() {
    obj.insert("active".to_string(), json!(active_id));
  }
  write_profiles_index(&index)?;

  let profiles = index
    .get("profiles")
    .cloned()
    .unwrap_or_else(|| json!([]));

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

  let codex_home = default_codex_home()?;
  let live_path = codex_home.join("auth.json");
  let live_raw = read_text(&live_path)?;
  if live_raw.trim().is_empty() {
    return Err("当前 ~/.codex/auth.json 为空，先运行 codex login".to_string());
  }
  let live_json: Value = serde_json::from_str(&live_raw)
    .map_err(|e| format!("~/.codex/auth.json 解析失败: {}", e))?;
  let meta = extract_oauth_meta(&live_json);
  if !meta.get("hasTokens").and_then(Value::as_bool).unwrap_or(false) {
    return Err("当前 auth.json 没有 OAuth tokens（只有 API Key），请先运行 codex login".to_string());
  }

  let mut index = read_profiles_index()?;
  let account_id = meta.get("accountId").and_then(Value::as_str).unwrap_or("").to_string();
  let plan = meta.get("plan").and_then(Value::as_str).unwrap_or("").to_string();
  let email = meta.get("email").and_then(Value::as_str).unwrap_or("").to_string();
  let sub = meta.get("sub").and_then(Value::as_str).unwrap_or("").to_string();

  // If an existing profile matches this account_id, update it in place.
  let existing_id = if !account_id.is_empty() {
    detect_active_profile_id(&index, &account_id)
  } else {
    String::new()
  };

  let now = Utc::now().timestamp();
  let id = if existing_id.is_empty() {
    format!("prof_{}", Uuid::new_v4().simple())
  } else {
    existing_id.clone()
  };

  // Write archive.
  let archive = profile_auth_path(&id)?;
  write_text(&archive, &live_raw)?;

  // Upsert into index.
  let default_name = if !email.is_empty() {
    email.clone()
  } else if !plan.is_empty() {
    format!("OAuth ({})", plan)
  } else {
    "OAuth 账号".to_string()
  };
  let name = if requested_name.is_empty() { default_name } else { requested_name };

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
        "createdAt": now,
        "updatedAt": now,
      }]),
    );
  }

  if let Some(obj) = index.as_object_mut() {
    obj.insert("active".to_string(), json!(id));
  }
  write_profiles_index(&index)?;

  Ok(json!({ "id": id, "updated": !existing_id.is_empty() }))
}

pub(crate) fn switch_oauth_profile(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let id = get_string(&object, "id");
  if id.is_empty() {
    return Err("id is required".to_string());
  }

  let archive = profile_auth_path(&id)?;
  if !archive.exists() {
    return Err("目标 profile 的 auth.json 不存在".to_string());
  }
  let archive_raw = read_text(&archive)?;
  if archive_raw.trim().is_empty() {
    return Err("目标 profile 的 auth.json 为空".to_string());
  }

  let codex_home = default_codex_home()?;
  ensure_dir(&codex_home)?;
  let live_path = codex_home.join("auth.json");
  let live_raw = read_text(&live_path).unwrap_or_default();

  // Before overwriting: if live is a known profile, sync its archive; always
  // drop a timestamped backup too.
  if !live_raw.trim().is_empty() {
    migrate_auth_json_env_to_codex_env(&codex_home, &live_raw)?;
    let live_json: Value = serde_json::from_str(&live_raw).unwrap_or_else(|_| json!({}));
    let live_meta = extract_oauth_meta(&live_json);
    let live_account = live_meta.get("accountId").and_then(Value::as_str).unwrap_or("").to_string();
    let index = read_profiles_index()?;
    let active_before = detect_active_profile_id(&index, &live_account);
    let _ = sync_live_to_active_archive(&live_raw, &active_before);
    let _ = write_switch_backup(&live_raw);
  }

  migrate_auth_json_env_to_codex_env(&codex_home, &archive_raw)?;
  write_text(&live_path, &archive_raw)?;

  // Update active pointer.
  let mut index = read_profiles_index()?;
  if let Some(obj) = index.as_object_mut() {
    obj.insert("active".to_string(), json!(id));
  }
  write_profiles_index(&index)?;

  Ok(json!({ "id": id, "authPath": live_path.to_string_lossy().to_string() }))
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
