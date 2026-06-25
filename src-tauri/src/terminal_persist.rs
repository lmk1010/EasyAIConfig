// 终端会话元数据持久化（SQLite）
//
// 跟 provider_health.rs 一个套路。每次 spawn / close 落 ~/.codex-config-ui/cache/terminals.db。
// 应用启动时前端拉这张表 + Rust 当前活的 sessions 合并：还活着的去 ghost 标，没活的展示为
// "已退出" 卡片，给用户一键重启。
//
// 表结构 terminal_sessions_meta:
//   session_id TEXT PRIMARY KEY
//   tool TEXT NOT NULL
//   title TEXT
//   command TEXT
//   cwd TEXT
//   program TEXT
//   args_json TEXT  (JSON 数组)
//   env_json TEXT   (JSON 对象)
//   created_at_ms INTEGER NOT NULL
//   updated_at_ms INTEGER NOT NULL

use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::PathBuf;

use crate::{app_home, ensure_dir, parse_json_object, provider::get_string};

fn db_path() -> Result<PathBuf, String> {
  let dir = app_home()?.join("cache");
  ensure_dir(&dir)?;
  Ok(dir.join("terminals.db"))
}

fn open_db() -> Result<Connection, String> {
  let path = db_path()?;
  let connection = Connection::open(&path).map_err(|error| error.to_string())?;
  connection
    .execute(
      "CREATE TABLE IF NOT EXISTS terminal_sessions_meta (
        session_id TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        title TEXT,
        command TEXT,
        cwd TEXT,
        program TEXT,
        args_json TEXT,
        env_json TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )",
      [],
    )
    .map_err(|error| error.to_string())?;
  Ok(connection)
}

fn now_ms() -> i64 {
  chrono::Utc::now().timestamp_millis()
}

/// POST /api/terminal/persist
/// body: { sessionId, tool, title, command, cwd, program, args:[], env:{} }
pub(crate) fn persist_session(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let session_id = get_string(&object, "sessionId");
  if session_id.trim().is_empty() { return Err("sessionId 不能为空".to_string()); }
  let tool = get_string(&object, "tool");
  let title = get_string(&object, "title");
  let command = get_string(&object, "command");
  let cwd = get_string(&object, "cwd");
  let program = get_string(&object, "program");
  let args_json = body.get("args").map(|v| v.to_string()).unwrap_or_else(|| "[]".to_string());
  let env_json = body.get("env").map(|v| v.to_string()).unwrap_or_else(|| "{}".to_string());

  let connection = open_db()?;
  let now = now_ms();
  // UPSERT
  connection
    .execute(
      "INSERT INTO terminal_sessions_meta
         (session_id, tool, title, command, cwd, program, args_json, env_json, created_at_ms, updated_at_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
       ON CONFLICT(session_id) DO UPDATE SET
         tool = excluded.tool,
         title = excluded.title,
         command = excluded.command,
         cwd = excluded.cwd,
         program = excluded.program,
         args_json = excluded.args_json,
         env_json = excluded.env_json,
         updated_at_ms = excluded.updated_at_ms",
      params![session_id, tool, title, command, cwd, program, args_json, env_json, now],
    )
    .map_err(|error| error.to_string())?;
  Ok(json!({ "ok": true }))
}

/// GET /api/terminal/persisted
/// 返回所有持久化的 session 元数据（按 updated_at desc）
pub(crate) fn list_persisted(_query: &Value) -> Result<Value, String> {
  let connection = open_db()?;
  let mut stmt = connection
    .prepare(
      "SELECT session_id, tool, title, command, cwd, program, args_json, env_json, created_at_ms, updated_at_ms
       FROM terminal_sessions_meta
       ORDER BY updated_at_ms DESC
       LIMIT 50",
    )
    .map_err(|error| error.to_string())?;
  let rows = stmt
    .query_map([], |row| {
      let args_str: String = row.get(6).unwrap_or_default();
      let env_str: String = row.get(7).unwrap_or_default();
      let args: Value = serde_json::from_str(&args_str).unwrap_or(json!([]));
      let env: Value = serde_json::from_str(&env_str).unwrap_or(json!({}));
      Ok(json!({
        "sessionId": row.get::<_, String>(0).unwrap_or_default(),
        "tool": row.get::<_, String>(1).unwrap_or_default(),
        "title": row.get::<_, String>(2).unwrap_or_default(),
        "command": row.get::<_, String>(3).unwrap_or_default(),
        "cwd": row.get::<_, String>(4).unwrap_or_default(),
        "program": row.get::<_, String>(5).unwrap_or_default(),
        "args": args,
        "env": env,
        "createdAtMs": row.get::<_, i64>(8).unwrap_or(0),
        "updatedAtMs": row.get::<_, i64>(9).unwrap_or(0),
      }))
    })
    .map_err(|error| error.to_string())?;
  let mut list = Vec::new();
  for row in rows {
    if let Ok(value) = row { list.push(value); }
  }
  Ok(json!({ "ok": true, "rows": list }))
}

/// POST /api/terminal/forget   body: { sessionId }
pub(crate) fn forget_session(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let session_id = get_string(&object, "sessionId");
  if session_id.trim().is_empty() { return Err("sessionId 不能为空".to_string()); }
  let connection = open_db()?;
  connection
    .execute("DELETE FROM terminal_sessions_meta WHERE session_id = ?1", params![session_id])
    .map_err(|error| error.to_string())?;
  Ok(json!({ "ok": true }))
}
