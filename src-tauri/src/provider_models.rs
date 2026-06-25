// 每个 provider 的"可用模型"清单持久化（单 provider 可挂多个 model 的 catalog）
//
// 用户在 provider 编辑对话框里勾选「此 provider 支持的模型」，落到这里。
// 跟 codex TOML 的 `model_providers.<key>` 不冲突 — TOML 那边只存 baseUrl/envKey
// (model 单值是 codex 自己的 default)，这里是 sidecar，纯 UI 元数据。
//
// 存储：~/.codex-config-ui/cache/provider_models.db
// 表 provider_models: (provider_key, codex_home, model_id, added_at_ms)
//   PRIMARY KEY (provider_key, codex_home, model_id)
//
// 端点：
//   GET  /api/provider/saved-models?providerKey=&codexHome=  → { ok, models: [...] }
//   POST /api/provider/saved-models                          → { ok }
//        body: { providerKey, codexHome, models: [...] }     // 整覆盖（delete + insert）

use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::PathBuf;

use crate::provider::get_string;
use crate::{app_home, ensure_dir, parse_json_object};

fn db_path() -> Result<PathBuf, String> {
  let dir = app_home()?.join("cache");
  ensure_dir(&dir)?;
  Ok(dir.join("provider_models.db"))
}

fn open_db() -> Result<Connection, String> {
  let path = db_path()?;
  let connection = Connection::open(&path).map_err(|error| error.to_string())?;
  connection
    .execute(
      "CREATE TABLE IF NOT EXISTS provider_models (
        provider_key TEXT NOT NULL,
        codex_home TEXT NOT NULL,
        model_id TEXT NOT NULL,
        added_at_ms INTEGER NOT NULL,
        PRIMARY KEY (provider_key, codex_home, model_id)
      )",
      [],
    )
    .map_err(|error| error.to_string())?;
  Ok(connection)
}

fn now_ms() -> i64 {
  chrono::Utc::now().timestamp_millis()
}

/// GET /api/provider/saved-models
pub(crate) fn list_saved_models(query: &Value) -> Result<Value, String> {
  let object = parse_json_object(query);
  let provider_key = get_string(&object, "providerKey");
  let codex_home = get_string(&object, "codexHome");
  if provider_key.trim().is_empty() {
    return Err("providerKey 不能为空".to_string());
  }
  let connection = open_db()?;
  let mut stmt = connection
    .prepare(
      "SELECT model_id, added_at_ms FROM provider_models
       WHERE provider_key = ?1 AND codex_home = ?2
       ORDER BY added_at_ms ASC",
    )
    .map_err(|error| error.to_string())?;
  let rows = stmt
    .query_map(params![provider_key, codex_home], |row| {
      Ok((row.get::<_, String>(0).unwrap_or_default(), row.get::<_, i64>(1).unwrap_or(0)))
    })
    .map_err(|error| error.to_string())?;
  let mut models = Vec::new();
  for row in rows {
    if let Ok((id, _at)) = row { models.push(id); }
  }
  Ok(json!({ "ok": true, "models": models }))
}

/// POST /api/provider/saved-models
/// 整覆盖：先 delete 同 provider+codexHome 的所有行，再 insert 新 list。
pub(crate) fn save_provider_models(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let provider_key = get_string(&object, "providerKey");
  let codex_home = get_string(&object, "codexHome");
  if provider_key.trim().is_empty() {
    return Err("providerKey 不能为空".to_string());
  }
  let models = body
    .get("models")
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default()
    .into_iter()
    .filter_map(|item| item.as_str().map(|text| text.to_string()))
    .filter(|model| !model.trim().is_empty())
    .collect::<Vec<_>>();
  let mut connection = open_db()?;
  let tx = connection.transaction().map_err(|error| error.to_string())?;
  tx.execute(
    "DELETE FROM provider_models WHERE provider_key = ?1 AND codex_home = ?2",
    params![provider_key, codex_home],
  )
  .map_err(|error| error.to_string())?;
  let now = now_ms();
  for model in &models {
    let _ = tx.execute(
      "INSERT OR IGNORE INTO provider_models (provider_key, codex_home, model_id, added_at_ms)
       VALUES (?1, ?2, ?3, ?4)",
      params![provider_key, codex_home, model, now],
    );
  }
  tx.commit().map_err(|error| error.to_string())?;
  Ok(json!({ "ok": true, "count": models.len() }))
}
