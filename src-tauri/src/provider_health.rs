// Provider 探测历史持久化。
//
// 每次 detect_provider / test_saved_provider 完成后落一条 ProbeRecord，
// 前端用来画 sparkline、算 24h uptime、列最近 N 次的 latency 时间轴。
//
// 存储：~/.codex-config-ui/cache/health.db
//   表 provider_probe_log：(provider_key, codex_home, base_url, probed_at_ms,
//                          success, latency_ms, status_code, error_text)
//   索引：按 (provider_key, codex_home, probed_at_ms DESC) 加速查询
//
// 滚动策略：每次 record 时顺手删 30 天以前的旧条目，避免无限增长。

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::PathBuf;

use crate::provider::{get_string, get_string_any};
use crate::{app_home, ensure_dir, parse_json_object};

const PROBE_RETENTION_MS: i64 = 30 * 24 * 3600 * 1000; // 30 天

fn health_db_path() -> Result<PathBuf, String> {
  let dir = app_home()?.join("cache");
  ensure_dir(&dir)?;
  Ok(dir.join("health.db"))
}

fn open_db() -> Result<Connection, String> {
  let path = health_db_path()?;
  let connection = Connection::open(&path).map_err(|error| error.to_string())?;
  connection
    .execute(
      "CREATE TABLE IF NOT EXISTS provider_probe_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_key TEXT NOT NULL,
        codex_home TEXT NOT NULL,
        base_url TEXT,
        probed_at_ms INTEGER NOT NULL,
        success INTEGER NOT NULL,
        latency_ms INTEGER,
        status_code INTEGER,
        error_text TEXT
      )",
      [],
    )
    .map_err(|error| error.to_string())?;
  connection
    .execute(
      "CREATE INDEX IF NOT EXISTS idx_probe_log_provider \
       ON provider_probe_log(provider_key, codex_home, probed_at_ms DESC)",
      [],
    )
    .map_err(|error| error.to_string())?;
  Ok(connection)
}

fn now_ms() -> i64 {
  chrono::Utc::now().timestamp_millis()
}

/// 写一条探测记录。把过期记录顺手清掉。
/// `error_text` 留 None 表示成功；非空说明探测失败。
pub(crate) fn record_probe(
  provider_key: &str,
  codex_home: &str,
  base_url: Option<&str>,
  success: bool,
  latency_ms: Option<u64>,
  status_code: Option<u16>,
  error_text: Option<&str>,
) {
  // 任何一步出错都 swallow —— 探测历史不该影响主流程。
  let Ok(connection) = open_db() else { return; };
  let cutoff = now_ms() - PROBE_RETENTION_MS;
  let _ = connection.execute(
    "DELETE FROM provider_probe_log WHERE probed_at_ms < ?1",
    params![cutoff],
  );
  let _ = connection.execute(
    "INSERT INTO provider_probe_log
      (provider_key, codex_home, base_url, probed_at_ms, success, latency_ms, status_code, error_text)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    params![
      provider_key,
      codex_home,
      base_url,
      now_ms(),
      if success { 1 } else { 0 },
      latency_ms.map(|v| v as i64),
      status_code.map(|v| v as i64),
      error_text,
    ],
  );
}

/// GET /api/provider/probe-history?providerKey=...&codexHome=...&limit=120
/// 返回 { rows: [{ probedAt, success, latencyMs, statusCode, error }], ... }
pub(crate) fn get_probe_history(query: &Value) -> Result<Value, String> {
  let object = parse_json_object(query);
  let provider_key = get_string(&object, "providerKey");
  if provider_key.trim().is_empty() {
    return Err("providerKey is required".to_string());
  }
  let codex_home = get_string(&object, "codexHome");
  let limit: i64 = get_string(&object, "limit")
    .parse::<i64>()
    .unwrap_or(120)
    .clamp(1, 720);

  let connection = open_db()?;
  let mut stmt = connection
    .prepare(
      "SELECT probed_at_ms, success, latency_ms, status_code, error_text \
       FROM provider_probe_log \
       WHERE provider_key = ?1 AND codex_home = ?2 \
       ORDER BY probed_at_ms DESC \
       LIMIT ?3",
    )
    .map_err(|error| error.to_string())?;
  let rows = stmt
    .query_map(params![provider_key, codex_home, limit], |row| {
      Ok(json!({
        "probedAt": row.get::<_, i64>(0)?,
        "success": row.get::<_, i64>(1)? != 0,
        "latencyMs": row.get::<_, Option<i64>>(2)?,
        "statusCode": row.get::<_, Option<i64>>(3)?,
        "error": row.get::<_, Option<String>>(4)?,
      }))
    })
    .map_err(|error| error.to_string())?
    .filter_map(|result| result.ok())
    .collect::<Vec<_>>();
  Ok(json!({
    "providerKey": provider_key,
    "codexHome": codex_home,
    "rows": rows,
  }))
}

/// GET /api/provider/probe-summary?providerKey=...&codexHome=...&windowHours=24
/// 返回 { uptimePct, total, success, failure, avgLatencyMs, p95LatencyMs, lastAt }
pub(crate) fn get_probe_summary(query: &Value) -> Result<Value, String> {
  let object = parse_json_object(query);
  let provider_key = get_string(&object, "providerKey");
  if provider_key.trim().is_empty() {
    return Err("providerKey is required".to_string());
  }
  let codex_home = get_string(&object, "codexHome");
  let window_hours: i64 = get_string_any(&object, &["windowHours", "hours"])
    .parse::<i64>()
    .unwrap_or(24)
    .clamp(1, 720);
  let since = now_ms() - window_hours * 3600 * 1000;

  let connection = open_db()?;
  let mut stmt = connection
    .prepare(
      "SELECT success, latency_ms, probed_at_ms FROM provider_probe_log \
       WHERE provider_key = ?1 AND codex_home = ?2 AND probed_at_ms >= ?3 \
       ORDER BY probed_at_ms DESC",
    )
    .map_err(|error| error.to_string())?;
  let mut total = 0i64;
  let mut success_count = 0i64;
  let mut latencies: Vec<i64> = Vec::new();
  let mut last_at: Option<i64> = None;
  let mut iter = stmt
    .query_map(params![provider_key, codex_home, since], |row| {
      Ok((
        row.get::<_, i64>(0)?,
        row.get::<_, Option<i64>>(1)?,
        row.get::<_, i64>(2)?,
      ))
    })
    .map_err(|error| error.to_string())?;
  while let Some(Ok((succ, lat, ts))) = iter.next() {
    total += 1;
    if succ != 0 {
      success_count += 1;
    }
    if let Some(latency) = lat {
      if latency >= 0 {
        latencies.push(latency);
      }
    }
    if last_at.is_none() {
      last_at = Some(ts);
    }
  }
  // 全部时段 fallback：取最近一次（窗口外也展示）
  if last_at.is_none() {
    let probed_at_ms: Option<i64> = connection
      .query_row(
        "SELECT probed_at_ms FROM provider_probe_log \
         WHERE provider_key = ?1 AND codex_home = ?2 \
         ORDER BY probed_at_ms DESC LIMIT 1",
        params![provider_key, codex_home],
        |row| row.get(0),
      )
      .optional()
      .map_err(|error| error.to_string())?;
    last_at = probed_at_ms;
  }
  latencies.sort_unstable();
  let avg_latency = if latencies.is_empty() {
    Value::Null
  } else {
    let sum: i64 = latencies.iter().sum();
    Value::from(sum / latencies.len() as i64)
  };
  let p95_latency = if latencies.is_empty() {
    Value::Null
  } else {
    let idx = ((latencies.len() as f64) * 0.95).ceil() as usize;
    let idx = idx.saturating_sub(1).min(latencies.len() - 1);
    Value::from(latencies[idx])
  };
  let uptime_pct = if total == 0 {
    Value::Null
  } else {
    Value::from(((success_count as f64) / (total as f64) * 100.0).round() as i64)
  };
  Ok(json!({
    "providerKey": provider_key,
    "codexHome": codex_home,
    "windowHours": window_hours,
    "total": total,
    "success": success_count,
    "failure": total - success_count,
    "uptimePct": uptime_pct,
    "avgLatencyMs": avg_latency,
    "p95LatencyMs": p95_latency,
    "lastAt": last_at,
  }))
}
