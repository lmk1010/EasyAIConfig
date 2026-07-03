// Provider 远程额度/余额查询结果缓存。
//
// 这里只保存展示用的查询结果、错误和时间戳，不保存账号密码、API key、
// OAuth token 或面板 access token。用于应用重启后继续显示上次刷新出的
// 额度/余额，避免前端 localStorage 存业务缓存。

use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::PathBuf;

use crate::provider::get_string;
use crate::{app_home, ensure_dir, parse_json_object};

const REMOTE_USAGE_CACHE_RETENTION_MS: i64 = 30 * 24 * 3600 * 1000;
const REMOTE_USAGE_CACHE_MAX_ROWS: i64 = 120;

fn db_path() -> Result<PathBuf, String> {
  let dir = app_home()?.join("cache");
  ensure_dir(&dir)?;
  Ok(dir.join("provider_remote_usage_cache.db"))
}

fn open_db() -> Result<Connection, String> {
  let path = db_path()?;
  let connection = Connection::open(&path).map_err(|error| error.to_string())?;
  connection
    .execute(
      "CREATE TABLE IF NOT EXISTS provider_remote_usage_cache (
        cache_key TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        result_json TEXT,
        error_text TEXT NOT NULL DEFAULT '',
        fetched_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )",
      [],
    )
    .map_err(|error| error.to_string())?;
  connection
    .execute(
      "CREATE INDEX IF NOT EXISTS idx_provider_remote_usage_cache_updated
       ON provider_remote_usage_cache(updated_at_ms DESC)",
      [],
    )
    .map_err(|error| error.to_string())?;
  Ok(connection)
}

fn now_ms() -> i64 {
  chrono::Utc::now().timestamp_millis()
}

fn normalize_cache_key(tool: &str, provider_key: &str, input_key: &str) -> String {
  let trimmed = input_key.trim();
  if !trimmed.is_empty() {
    return trimmed.to_string();
  }
  format!("{}:{}", tool.trim().to_lowercase(), provider_key.trim())
}

fn split_cache_key(cache_key: &str) -> (String, String) {
  let mut parts = cache_key.splitn(2, ':');
  let tool = parts.next().unwrap_or("codex").trim();
  let provider_key = parts.next().unwrap_or_default().trim();
  (
    if tool.is_empty() { "codex".to_string() } else { tool.to_lowercase() },
    provider_key.to_string(),
  )
}

fn prune_cache(connection: &Connection, now: i64) {
  let cutoff = now - REMOTE_USAGE_CACHE_RETENTION_MS;
  let _ = connection.execute(
    "DELETE FROM provider_remote_usage_cache WHERE updated_at_ms < ?1",
    params![cutoff],
  );
  let _ = connection.execute(
    "DELETE FROM provider_remote_usage_cache
     WHERE cache_key NOT IN (
       SELECT cache_key FROM provider_remote_usage_cache
       ORDER BY updated_at_ms DESC
       LIMIT ?1
     )",
    params![REMOTE_USAGE_CACHE_MAX_ROWS],
  );
}

pub(crate) fn list_provider_remote_usage_cache(query: &Value) -> Result<Value, String> {
  let object = parse_json_object(query);
  let tool_filter = get_string(&object, "tool").trim().to_lowercase();
  let limit = object
    .get("limit")
    .and_then(Value::as_i64)
    .unwrap_or(REMOTE_USAGE_CACHE_MAX_ROWS)
    .clamp(1, 500);

  let connection = open_db()?;
  prune_cache(&connection, now_ms());

  let mut rows = Vec::new();
  if tool_filter.is_empty() {
    let mut stmt = connection
      .prepare(
        "SELECT cache_key, tool, provider_key, result_json, error_text, fetched_at_ms
         FROM provider_remote_usage_cache
         ORDER BY updated_at_ms DESC
         LIMIT ?1",
      )
      .map_err(|error| error.to_string())?;
    let mapped = stmt
      .query_map(params![limit], |row| {
        Ok((
          row.get::<_, String>(0)?,
          row.get::<_, String>(1)?,
          row.get::<_, String>(2)?,
          row.get::<_, Option<String>>(3)?,
          row.get::<_, String>(4)?,
          row.get::<_, i64>(5)?,
        ))
      })
      .map_err(|error| error.to_string())?;
    for row in mapped.flatten() {
      rows.push(row);
    }
  } else {
    let mut stmt = connection
      .prepare(
        "SELECT cache_key, tool, provider_key, result_json, error_text, fetched_at_ms
         FROM provider_remote_usage_cache
         WHERE tool = ?1
         ORDER BY updated_at_ms DESC
         LIMIT ?2",
      )
      .map_err(|error| error.to_string())?;
    let mapped = stmt
      .query_map(params![tool_filter, limit], |row| {
        Ok((
          row.get::<_, String>(0)?,
          row.get::<_, String>(1)?,
          row.get::<_, String>(2)?,
          row.get::<_, Option<String>>(3)?,
          row.get::<_, String>(4)?,
          row.get::<_, i64>(5)?,
        ))
      })
      .map_err(|error| error.to_string())?;
    for row in mapped.flatten() {
      rows.push(row);
    }
  }

  let mut entries = serde_json::Map::new();
  let mut row_values = Vec::new();
  for (cache_key, tool, provider_key, result_json, error_text, fetched_at_ms) in rows {
    let result = result_json
      .as_deref()
      .and_then(|text| serde_json::from_str::<Value>(text).ok())
      .unwrap_or(Value::Null);
    let entry = json!({
      "tool": tool,
      "providerKey": provider_key,
      "result": result,
      "error": error_text,
      "fetchedAt": fetched_at_ms,
    });
    entries.insert(cache_key.clone(), entry.clone());
    row_values.push(json!({
      "cacheKey": cache_key,
      "tool": entry.get("tool").cloned().unwrap_or(Value::Null),
      "providerKey": entry.get("providerKey").cloned().unwrap_or(Value::Null),
      "result": entry.get("result").cloned().unwrap_or(Value::Null),
      "error": entry.get("error").cloned().unwrap_or(Value::Null),
      "fetchedAt": entry.get("fetchedAt").cloned().unwrap_or(Value::Null),
    }));
  }

  Ok(json!({ "entries": entries, "rows": row_values }))
}

pub(crate) fn save_provider_remote_usage_cache(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let input_key = get_string(&object, "cacheKey");
  let mut tool = get_string(&object, "tool").trim().to_lowercase();
  let mut provider_key = get_string(&object, "providerKey");
  if tool.is_empty() || provider_key.trim().is_empty() {
    let (parsed_tool, parsed_provider_key) = split_cache_key(&input_key);
    if tool.is_empty() {
      tool = parsed_tool;
    }
    if provider_key.trim().is_empty() {
      provider_key = parsed_provider_key;
    }
  }
  if tool.is_empty() {
    tool = "codex".to_string();
  }
  if provider_key.trim().is_empty() {
    return Err("providerKey is required".to_string());
  }
  let cache_key = normalize_cache_key(&tool, &provider_key, &input_key);
  let fetched_at = object
    .get("fetchedAt")
    .and_then(Value::as_i64)
    .filter(|value| *value > 0)
    .unwrap_or_else(now_ms);
  let error_text = get_string(&object, "error").chars().take(500).collect::<String>();
  let result_json = match body.get("result") {
    Some(Value::Null) | None => None,
    Some(value) => Some(serde_json::to_string(value).map_err(|error| error.to_string())?),
  };
  let now = now_ms();
  let connection = open_db()?;
  connection
    .execute(
      "INSERT INTO provider_remote_usage_cache
        (cache_key, tool, provider_key, result_json, error_text, fetched_at_ms, updated_at_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(cache_key) DO UPDATE SET
        tool = excluded.tool,
        provider_key = excluded.provider_key,
        result_json = excluded.result_json,
        error_text = excluded.error_text,
        fetched_at_ms = excluded.fetched_at_ms,
        updated_at_ms = excluded.updated_at_ms",
      params![cache_key, tool, provider_key, result_json, error_text, fetched_at, now],
    )
    .map_err(|error| error.to_string())?;
  prune_cache(&connection, now);
  Ok(json!({ "saved": true }))
}
