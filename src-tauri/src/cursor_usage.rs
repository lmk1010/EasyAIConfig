// Cursor 本地用量解析。纯本地、只读，不联网。
//
// Cursor（基于 Electron/VS Code）把聊天/Composer 会话、模型、消息、以及本地
// 记录的花费都写在 SQLite 数据库 `state.vscdb` 里：
//
//   macOS:   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
//   Linux:   ~/.config/Cursor/User/globalStorage/state.vscdb
//   Windows: %APPDATA%\Cursor\User\globalStorage\state.vscdb
//
// 两张 KV 表：
//   ItemTable    (key TEXT, value BLOB) —— 账号信息、旧版 aiService 记录、3.0+ 会话索引
//   cursorDiskKV (key TEXT, value BLOB) —— 会话主体，key 形如 composerData:<id> / bubbleId:<id>:<bid>
//
// 我们只读 `composerData:*`（每个会话一行，含时间戳/模型/消息数/usageData.costInCents），
// 以及 ItemTable 里的 cursorAuth 账号字段。**不**扫描 bubbleId（量太大、
// 局部 token 估算会误导用户，和 Claude 本地用量口径保持一致）。
//
// GET /api/cursor/local-usage  —— 可选 query: ?stateDbPath=<自定义 state.vscdb 路径>

use chrono::{DateTime, Utc};
use rusqlite::types::ValueRef;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::{app_home, ensure_dir, expand_home_path, parse_json_object};

// ── 持久化缓存（SQLite，仿照 Codex/Claude 的 cache/metrics.db 做法）──
// 落盘到 ~/.codex-config-ui/cache/cursor_usage.db，重启后仍在；数据库指纹未变则秒回，
// 不重扫 2GB。刻意不用前端 localStorage 存业务缓存，和其他工具保持一致。
fn cache_db_path() -> Result<PathBuf, String> {
    let dir = app_home()?.join("cache");
    ensure_dir(&dir)?;
    Ok(dir.join("cursor_usage.db"))
}

fn open_cache_db() -> Result<Connection, String> {
    let conn = Connection::open(cache_db_path()?).map_err(|error| error.to_string())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS cursor_usage_cache (
          cache_key TEXT PRIMARY KEY,
          fingerprint INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL
        )",
        [],
    )
    .map_err(|error| error.to_string())?;
    Ok(conn)
}

fn read_cached_usage(key: &str, fingerprint: u64) -> Option<Value> {
    let conn = open_cache_db().ok()?;
    let payload: Option<String> = conn
        .query_row(
            "SELECT payload_json FROM cursor_usage_cache WHERE cache_key = ?1 AND fingerprint = ?2",
            params![key, fingerprint as i64],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();
    payload.and_then(|text| serde_json::from_str::<Value>(&text).ok())
}

fn write_cached_usage(key: &str, fingerprint: u64, payload: &Value) {
    let Ok(conn) = open_cache_db() else {
        return;
    };
    let Ok(text) = serde_json::to_string(payload) else {
        return;
    };
    let _ = conn.execute(
        "INSERT INTO cursor_usage_cache (cache_key, fingerprint, payload_json, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(cache_key) DO UPDATE SET
           fingerprint = excluded.fingerprint,
           payload_json = excluded.payload_json,
           updated_at_ms = excluded.updated_at_ms",
        params![
            key,
            fingerprint as i64,
            text,
            chrono::Utc::now().timestamp_millis()
        ],
    );
}

/// 数据库指纹 = .vscdb / -wal / -shm 三个文件里最新的 mtime（秒）。
/// Cursor 用 WAL 写入，主库 mtime 常不变，必须一起看 -wal 才能感知新数据。
fn db_fingerprint(db_path: &Path) -> u64 {
    let mut newest = 0u64;
    for suffix in ["", "-wal", "-shm"] {
        let path = if suffix.is_empty() {
            db_path.to_path_buf()
        } else {
            PathBuf::from(format!("{}{}", db_path.to_string_lossy(), suffix))
        };
        if let Ok(meta) = std::fs::metadata(&path) {
            if let Ok(modified) = meta.modified() {
                if let Ok(dur) = modified.duration_since(std::time::UNIX_EPOCH) {
                    newest = newest.max(dur.as_secs());
                }
            }
        }
    }
    newest
}

// 单次刷新最多解析多少个会话行，避免重度用户（上万个会话）拖慢刷新。
const MAX_COMPOSERS: u64 = 8000;

fn clean_string(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// 默认全局 state.vscdb 路径。`dirs::config_dir()` 在三大平台上恰好落在
/// Cursor 的配置根目录（macOS=Application Support、Linux=.config、Windows=%APPDATA%）。
fn default_cursor_global_db() -> Result<PathBuf, String> {
    let base = dirs::config_dir().ok_or_else(|| "无法定位系统配置目录".to_string())?;
    Ok(base
        .join("Cursor")
        .join("User")
        .join("globalStorage")
        .join("state.vscdb"))
}

fn resolve_db_path(object: &serde_json::Map<String, Value>) -> Result<PathBuf, String> {
    let override_path = clean_string(object.get("stateDbPath"));
    if !override_path.is_empty() {
        return Ok(expand_home_path(&override_path).unwrap_or_else(|| PathBuf::from(&override_path)));
    }
    default_cursor_global_db()
}

/// 直接以只读方式打开。Cursor 运行中时 WAL/-shm 存在且可读，只读连接可用。
fn open_direct(path: &Path) -> Option<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
        .ok()?;
    Some(conn)
}

/// 只读打开失败时（少见的 WAL 权限场景）的兜底：把 .vscdb(+-wal/-shm) 复制到临时目录再读。
/// 绝不触碰 Cursor 原始数据库。
fn copy_to_temp(path: &Path) -> Result<(PathBuf, Connection), String> {
    let dir = std::env::temp_dir().join(format!("easyaiconfig-cursor-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let dest = dir.join("state.vscdb");
    std::fs::copy(path, &dest).map_err(|error| format!("复制 Cursor 数据库失败: {error}"))?;
    for suffix in ["-wal", "-shm"] {
        let src = PathBuf::from(format!("{}{}", path.to_string_lossy(), suffix));
        if src.exists() {
            let _ = std::fs::copy(&src, dir.join(format!("state.vscdb{suffix}")));
        }
    }
    let conn = Connection::open(&dest).map_err(|error| error.to_string())?;
    Ok((dir, conn))
}

fn with_connection<T>(
    path: &Path,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    if let Some(conn) = open_direct(path) {
        return f(&conn);
    }
    let (dir, conn) = copy_to_temp(path)?;
    let result = f(&conn);
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
    result
}

/// 值列声明为 BLOB，但 Cursor（VS Code storage）实际多以 TEXT 写入，
/// 因此按 Text/Blob 两种情况取原始字节，避免类型不匹配读不到值。
fn value_ref_to_string(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Text(bytes) | ValueRef::Blob(bytes) => {
            String::from_utf8_lossy(bytes).to_string()
        }
        _ => String::new(),
    }
}

fn read_kv_string(conn: &Connection, table: &str, key: &str) -> Option<String> {
    // table 是内部固定常量（ItemTable/cursorDiskKV），非用户输入，无注入风险。
    let sql = format!("SELECT value FROM {table} WHERE key = ?1");
    conn.query_row(&sql, [key], |row| {
        Ok(value_ref_to_string(row.get_ref(0)?))
    })
    .optional()
    .ok()
    .flatten()
    .map(|text| text.trim().to_string())
    .filter(|text| !text.is_empty())
}

/// cursorAuth 里的值是 JSON 字符串（常见带引号，例如 "\"pro\""）。去壳成裸串。
fn json_unquote(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Ok(Value::String(text)) = serde_json::from_str::<Value>(trimmed) {
        return text.trim().to_string();
    }
    trimmed.trim_matches('"').trim().to_string()
}

fn number(value: &Value, key: &str) -> Option<f64> {
    let item = value.get(key)?;
    if let Some(number) = item.as_f64() {
        return Some(number);
    }
    if let Some(number) = item.as_i64() {
        return Some(number as f64);
    }
    item.as_str()
        .and_then(|text| text.trim().replace(',', "").parse::<f64>().ok())
}

/// ms 时间戳（Cursor 存的是毫秒 epoch）转 RFC3339。0/异常返回空串。
fn ms_to_iso(ms: f64) -> String {
    if !ms.is_finite() || ms <= 0.0 {
        return String::new();
    }
    let secs = (ms / 1000.0).floor() as i64;
    DateTime::from_timestamp(secs, 0)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_default()
}

/// 累加单个会话的 usageData.costInCents（可能按模型分组，也可能是 default）。
fn composer_cost_cents(composer: &Value) -> Option<f64> {
    let usage = composer.get("usageData")?.as_object()?;
    let mut total = 0.0;
    let mut seen = false;
    for entry in usage.values() {
        if let Some(cents) = number(entry, "costInCents") {
            total += cents;
            seen = true;
        }
    }
    if seen {
        Some(total)
    } else {
        None
    }
}

fn composer_message_count(composer: &Value) -> u64 {
    if let Some(headers) = composer
        .get("fullConversationHeadersOnly")
        .and_then(Value::as_array)
    {
        return headers.len() as u64;
    }
    composer
        .get("conversation")
        .and_then(Value::as_array)
        .map(|items| items.len() as u64)
        .unwrap_or(0)
}

#[derive(Default)]
struct Aggregate {
    scanned: u64,
    truncated: bool,
    sessions: u64,
    today: u64,
    week: u64,
    messages: u64,
    cost_cents: f64,
    cost_recorded: bool,
    latest_ms: f64,
    context_tokens_total: f64,
    context_tokens_recorded: bool,
    models: HashMap<String, u64>,
    model_tokens: HashMap<String, f64>,
    modes: HashMap<String, u64>,
    recent: Vec<Value>,
    sessions_info: Vec<SessionInfo>,
}

/// 单个会话的估算所需信息。
struct SessionInfo {
    composer_id: String,
    model: String,
    date: String, // YYYY-MM-DD（按最近活动）
    context_tokens: f64,
    assistant_turns: u64, // 模型请求次数≈assistant bubble 数
}

/// 模型分布：会话数 + Cursor 本地记录的上下文 token（contextTokensUsed 之和）。
fn model_distribution(
    models: &HashMap<String, u64>,
    tokens: &HashMap<String, f64>,
    limit: usize,
) -> Vec<Value> {
    let mut pairs: Vec<(&String, &u64)> = models.iter().collect();
    pairs.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
    pairs
        .into_iter()
        .take(limit)
        .map(|(name, count)| {
            json!({
              "model": name,
              "count": count,
              "contextTokens": tokens.get(name).copied().unwrap_or(0.0),
            })
        })
        .collect()
}

fn top_distribution(map: &HashMap<String, u64>, field: &str, limit: usize) -> Vec<Value> {
    let mut pairs: Vec<(&String, &u64)> = map.iter().collect();
    pairs.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
    pairs
        .into_iter()
        .take(limit)
        .map(|(name, count)| json!({ field: name, "count": count }))
        .collect()
}

fn parse_composers(conn: &Connection, agg: &mut Aggregate) {
    let mut stmt =
        match conn.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'") {
            Ok(stmt) => stmt,
            // 旧版本可能没有 cursorDiskKV 表：视为无会话数据。
            Err(_) => return,
        };
    let rows = match stmt.query_map([], |row| {
        let key: String = row.get(0)?;
        let value = value_ref_to_string(row.get_ref(1)?);
        Ok((key, value))
    }) {
        Ok(rows) => rows,
        Err(_) => return,
    };

    let now_ms = Utc::now().timestamp_millis() as f64;
    let day_ago = now_ms - 24.0 * 3600.0 * 1000.0;
    let week_ago = now_ms - 7.0 * 24.0 * 3600.0 * 1000.0;

    for row in rows {
        let Ok((key, value)) = row else { continue };
        agg.scanned += 1;
        if agg.scanned > MAX_COMPOSERS {
            agg.truncated = true;
            break;
        }
        let Ok(composer) = serde_json::from_str::<Value>(&value) else {
            continue;
        };
        if !composer.is_object() {
            continue;
        }

        agg.sessions += 1;

        let created_ms = number(&composer, "createdAt").unwrap_or(0.0);
        let updated_ms = number(&composer, "lastUpdatedAt")
            .filter(|value| *value > 0.0)
            .unwrap_or(created_ms);
        let activity_ms = updated_ms.max(created_ms);
        if activity_ms > agg.latest_ms {
            agg.latest_ms = activity_ms;
        }
        if activity_ms >= day_ago {
            agg.today += 1;
        }
        if activity_ms >= week_ago {
            agg.week += 1;
        }

        let messages = composer_message_count(&composer);
        agg.messages += messages;

        let cost_cents = composer_cost_cents(&composer);
        if let Some(cents) = cost_cents {
            agg.cost_cents += cents;
            agg.cost_recorded = true;
        }

        let model = clean_string(
            composer
                .get("modelConfig")
                .and_then(|config| config.get("modelName")),
        );
        if !model.is_empty() {
            *agg.models.entry(model.clone()).or_insert(0) += 1;
        }

        // Cursor 本地唯一的真实 token 数：contextTokensUsed（该会话最近一轮的上下文
        // token 大小，Cursor 自己算的）。注意：这不是"累计计费 token"——每一轮都会把
        // 增长的上下文重新发送，服务端真实计费更高，以 cursor.com 为准。
        let ctx_tokens = number(&composer, "contextTokensUsed")
            .or_else(|| {
                composer
                    .get("promptTokenBreakdown")
                    .and_then(|breakdown| number(breakdown, "totalUsedTokens"))
            })
            .unwrap_or(0.0);
        if ctx_tokens > 0.0 {
            agg.context_tokens_total += ctx_tokens;
            agg.context_tokens_recorded = true;
            if !model.is_empty() {
                *agg.model_tokens.entry(model.clone()).or_insert(0.0) += ctx_tokens;
            }
        }
        let mode = {
            let unified = clean_string(composer.get("unifiedMode"));
            if unified.is_empty() {
                clean_string(composer.get("forceMode"))
            } else {
                unified
            }
        };
        if !mode.is_empty() {
            *agg.modes.entry(mode.clone()).or_insert(0) += 1;
        }

        let composer_id = clean_string(composer.get("composerId"));
        let composer_id = if composer_id.is_empty() {
            key.strip_prefix("composerData:").unwrap_or("").to_string()
        } else {
            composer_id
        };
        let name = clean_string(composer.get("name"));

        // 估算所需：assistant 轮数（type==2）+ 活动日期。
        let assistant_turns = composer
            .get("fullConversationHeadersOnly")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter(|h| h.get("type").and_then(Value::as_i64) == Some(2))
                    .count() as u64
            })
            .unwrap_or(0);
        let date = if activity_ms > 0.0 {
            DateTime::from_timestamp((activity_ms / 1000.0).floor() as i64, 0)
                .map(|dt| dt.format("%Y-%m-%d").to_string())
                .unwrap_or_default()
        } else {
            String::new()
        };
        agg.sessions_info.push(SessionInfo {
            composer_id: composer_id.clone(),
            model: model.clone(),
            date,
            context_tokens: ctx_tokens,
            assistant_turns,
        });

        agg.recent.push(json!({
          "composerId": composer_id,
          "name": name,
          "mode": mode,
          "model": model,
          "messageCount": messages,
          "contextTokens": ctx_tokens,
          "costUsd": cost_cents.map(|cents| cents.round() / 100.0),
          "createdAt": ms_to_iso(created_ms),
          "lastActiveAt": ms_to_iso(activity_ms),
          "status": clean_string(composer.get("status")),
          "_sortKey": activity_ms,
        }));
    }
}

/// 3.0+ 中心索引（ItemTable → composer.composerHeaders）里的会话列表，
/// 老会话在没被重新打开前不进 cursorDiskKV，用它兜底补齐会话数/时间。
fn parse_headers_fallback(conn: &Connection, agg: &mut Aggregate) {
    if agg.sessions > 0 {
        return;
    }
    let Some(raw) = read_kv_string(conn, "ItemTable", "composer.composerHeaders") else {
        return;
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return;
    };
    let Some(list) = parsed
        .get("allComposers")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
    else {
        return;
    };

    let now_ms = Utc::now().timestamp_millis() as f64;
    let day_ago = now_ms - 24.0 * 3600.0 * 1000.0;
    let week_ago = now_ms - 7.0 * 24.0 * 3600.0 * 1000.0;

    for composer in list {
        agg.sessions += 1;
        let created_ms = number(composer, "createdAt").unwrap_or(0.0);
        let updated_ms = number(composer, "lastUpdatedAt")
            .filter(|value| *value > 0.0)
            .unwrap_or(created_ms);
        let activity_ms = updated_ms.max(created_ms);
        if activity_ms > agg.latest_ms {
            agg.latest_ms = activity_ms;
        }
        if activity_ms >= day_ago {
            agg.today += 1;
        }
        if activity_ms >= week_ago {
            agg.week += 1;
        }
        let mode = clean_string(composer.get("unifiedMode"));
        if !mode.is_empty() {
            *agg.modes.entry(mode.clone()).or_insert(0) += 1;
        }
        agg.recent.push(json!({
          "composerId": clean_string(composer.get("composerId")),
          "name": clean_string(composer.get("name")),
          "mode": mode,
          "model": "",
          "messageCount": 0,
          "costUsd": Value::Null,
          "createdAt": ms_to_iso(created_ms),
          "lastActiveAt": ms_to_iso(activity_ms),
          "status": "",
          "_sortKey": activity_ms,
        }));
    }
}

/// Cursor 唯一的「真·本地用量」：`aiCodeTracking.dailyStats.v*.<date>`，
/// 记录每天 Tab / Composer 建议与采纳的代码行数（不含 token/花费——那些只在服务端）。
fn read_code_tracking(conn: &Connection) -> Value {
    let mut stmt = match conn
        .prepare("SELECT key, value FROM ItemTable WHERE key LIKE 'aiCodeTracking.dailyStats%'")
    {
        Ok(stmt) => stmt,
        Err(_) => return Value::Null,
    };
    let rows = match stmt.query_map([], |row| {
        let key: String = row.get(0)?;
        let value = value_ref_to_string(row.get_ref(1)?);
        Ok((key, value))
    }) {
        Ok(rows) => rows,
        Err(_) => return Value::Null,
    };

    let mut daily: Vec<Value> = Vec::new();
    let mut tab_accepted = 0.0;
    let mut tab_suggested = 0.0;
    let mut composer_accepted = 0.0;
    let mut composer_suggested = 0.0;

    for row in rows {
        let Ok((_key, value)) = row else { continue };
        let Ok(day) = serde_json::from_str::<Value>(&value) else {
            continue;
        };
        let date = clean_string(day.get("date"));
        if date.is_empty() {
            continue;
        }
        let ta = number(&day, "tabAcceptedLines").unwrap_or(0.0);
        let ts = number(&day, "tabSuggestedLines").unwrap_or(0.0);
        let ca = number(&day, "composerAcceptedLines").unwrap_or(0.0);
        let cs = number(&day, "composerSuggestedLines").unwrap_or(0.0);
        tab_accepted += ta;
        tab_suggested += ts;
        composer_accepted += ca;
        composer_suggested += cs;
        daily.push(json!({
          "date": date,
          "tabAcceptedLines": ta,
          "tabSuggestedLines": ts,
          "composerAcceptedLines": ca,
          "composerSuggestedLines": cs,
          "acceptedLines": ta + ca,
          "suggestedLines": ts + cs,
        }));
    }

    if daily.is_empty() {
        return Value::Null;
    }
    daily.sort_by(|a, b| {
        clean_string(a.get("date")).cmp(&clean_string(b.get("date")))
    });

    json!({
      "daily": daily,
      "totals": {
        "tabAcceptedLines": tab_accepted,
        "tabSuggestedLines": tab_suggested,
        "composerAcceptedLines": composer_accepted,
        "composerSuggestedLines": composer_suggested,
        "acceptedLines": tab_accepted + composer_accepted,
        "suggestedLines": tab_suggested + composer_suggested,
      },
    })
}

/// 极老版本（pre-v0.43）把每次生成记在 ItemTable → aiService.generations 数组里。
fn count_ai_generations(conn: &Connection) -> u64 {
    let Some(raw) = read_kv_string(conn, "ItemTable", "aiService.generations") else {
        return 0;
    };
    serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|value| value.as_array().map(|items| items.len() as u64))
        .unwrap_or(0)
}

/// 扫描 assistant bubble 的内容字符数（按 composerId 汇总），用于估算输出 token。
/// value 声明 BLOB 实为 TEXT，length() 返回字符数。json_extract 只取 type，不回传大文本。
fn scan_assistant_chars(conn: &Connection) -> HashMap<String, f64> {
    let mut map: HashMap<String, f64> = HashMap::new();
    let mut stmt = match conn.prepare(
        "SELECT key, json_extract(value,'$.type'), length(value) FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'",
    ) {
        Ok(stmt) => stmt,
        Err(_) => return map,
    };
    let rows = stmt.query_map([], |row| {
        let key: String = row.get(0)?;
        let typ: Option<i64> = row.get(1).ok();
        let len: i64 = row.get(2).unwrap_or(0);
        Ok((key, typ, len))
    });
    if let Ok(rows) = rows {
        for row in rows.flatten() {
            let (key, typ, len) = row;
            if typ != Some(2) {
                continue;
            }
            let rest = key.strip_prefix("bubbleId:").unwrap_or("");
            let cid = rest.split(':').next().unwrap_or("");
            if cid.is_empty() {
                continue;
            }
            *map.entry(cid.to_string()).or_insert(0.0) += len.max(0) as f64;
        }
    }
    map
}

/// 每百万 token 的粗略定价（USD）：(输入, 缓存读取, 输出)。仅用于本地估算量级。
fn model_prices(model: &str) -> (f64, f64, f64) {
    let m = model.to_lowercase();
    let (input, output) = if m.contains("opus") {
        (15.0, 75.0)
    } else if m.contains("haiku") {
        (0.8, 4.0)
    } else if m.contains("sonnet") || m.contains("fable") {
        (3.0, 15.0)
    } else if m.contains("grok") {
        (3.0, 15.0)
    } else if m.contains("gpt-5") || m.contains("gpt5") || m.contains("sol") || m.contains("terra") {
        (1.25, 10.0)
    } else if m.contains("gpt-4") || m.contains("gpt4") {
        (2.5, 10.0)
    } else if m.contains("gemini") {
        (1.25, 5.0)
    } else if m.contains("composer") {
        (1.0, 3.0)
    } else {
        (3.0, 15.0)
    };
    (input, input * 0.1, output) // 缓存读取按输入价 10% 估算
}

const EST_CHARS_PER_TOKEN: f64 = 4.0;

/// 本地估算：把「每一轮重新发送的上下文」按三角求和累计，拆成 输入(首次)/缓存读取(重发)/输出，
/// 再按粗略定价估算费用。绝非官网账单，仅数量级参考。
fn compute_estimate(sessions: &[SessionInfo], assistant_chars: &HashMap<String, f64>) -> Value {
    #[derive(Default, Clone)]
    struct Bucket {
        input: f64,
        cache_read: f64,
        output: f64,
        cost: f64,
        requests: f64,
        sessions: f64,
    }
    impl Bucket {
        fn add(&mut self, input: f64, cache: f64, output: f64, cost: f64, requests: f64) {
            self.input += input;
            self.cache_read += cache;
            self.output += output;
            self.cost += cost;
            self.requests += requests;
            self.sessions += 1.0;
        }
    }

    let mut total = Bucket::default();
    let mut by_model: HashMap<String, Bucket> = HashMap::new();
    let mut by_day: HashMap<String, Bucket> = HashMap::new();
    let mut session_rows: Vec<Value> = Vec::new();

    for info in sessions {
        let ctx = info.context_tokens.max(0.0);
        let turns = info.assistant_turns as f64;
        if ctx <= 0.0 && turns <= 0.0 {
            continue;
        }
        // 上下文从 ~0 增长到 ctx，第 k 次请求读取 ~ctx*k/turns，累计 ≈ ctx*(turns+1)/2。
        let cumulative_input = if turns > 0.0 {
            ctx * (turns + 1.0) / 2.0
        } else {
            ctx
        };
        let fresh_input = ctx; // 每个上下文 token 只“首次”计一次输入
        let cache_read = (cumulative_input - fresh_input).max(0.0); // 其余为重发（缓存读取）
        let output = assistant_chars.get(&info.composer_id).copied().unwrap_or(0.0)
            / EST_CHARS_PER_TOKEN;
        let model = if info.model.is_empty() {
            "unknown".to_string()
        } else {
            info.model.clone()
        };
        let (p_in, p_cache, p_out) = model_prices(&model);
        let cost = fresh_input / 1_000_000.0 * p_in
            + cache_read / 1_000_000.0 * p_cache
            + output / 1_000_000.0 * p_out;
        let requests = turns.max(1.0);

        total.add(fresh_input, cache_read, output, cost, requests);
        by_model
            .entry(model.clone())
            .or_default()
            .add(fresh_input, cache_read, output, cost, requests);
        if !info.date.is_empty() {
            by_day
                .entry(info.date.clone())
                .or_default()
                .add(fresh_input, cache_read, output, cost, requests);
        }
        session_rows.push(json!({
          "date": info.date,
          "model": model,
          "input": fresh_input,
          "cacheRead": cache_read,
          "output": output,
          "total": fresh_input + cache_read + output,
          "costUsd": (cost * 100.0).round() / 100.0,
          "requests": requests,
        }));
    }

    let bucket_json = |b: &Bucket, extra: Vec<(&str, Value)>| -> Value {
        let mut map = serde_json::Map::new();
        map.insert("input".into(), json!(b.input.round()));
        map.insert("cacheRead".into(), json!(b.cache_read.round()));
        map.insert("output".into(), json!(b.output.round()));
        map.insert(
            "total".into(),
            json!((b.input + b.cache_read + b.output).round()),
        );
        map.insert("costUsd".into(), json!((b.cost * 100.0).round() / 100.0));
        map.insert("requests".into(), json!(b.requests.round()));
        map.insert("sessions".into(), json!(b.sessions.round()));
        for (k, v) in extra {
            map.insert(k.into(), v);
        }
        Value::Object(map)
    };

    let mut models: Vec<Value> = by_model
        .iter()
        .map(|(model, b)| bucket_json(b, vec![("model", json!(model))]))
        .collect();
    models.sort_by(|a, b| {
        let ta = a.get("total").and_then(Value::as_f64).unwrap_or(0.0);
        let tb = b.get("total").and_then(Value::as_f64).unwrap_or(0.0);
        tb.partial_cmp(&ta).unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut daily: Vec<Value> = by_day
        .iter()
        .map(|(date, b)| bucket_json(b, vec![("date", json!(date))]))
        .collect();
    daily.sort_by(|a, b| {
        clean_string(a.get("date")).cmp(&clean_string(b.get("date")))
    });

    json!({
      "method": "本地估算：按“每轮重发上下文”三角累计（输入=首次发送、缓存读取=重发部分、输出=assistant 内容≈字符/4），费用按各模型粗略公开定价估算。非官网账单，仅数量级参考。",
      "charsPerToken": EST_CHARS_PER_TOKEN,
      "totals": bucket_json(&total, vec![]),
      "models": models,
      "daily": daily,
      "sessions": session_rows,
    })
}

fn build_usage(conn: &Connection, db_path: &Path) -> Result<Value, String> {
    let email = read_kv_string(conn, "ItemTable", "cursorAuth/cachedEmail")
        .map(|raw| json_unquote(&raw))
        .unwrap_or_default();
    let plan = read_kv_string(conn, "ItemTable", "cursorAuth/stripeMembershipType")
        .map(|raw| json_unquote(&raw))
        .unwrap_or_default();
    let subscription_status = read_kv_string(conn, "ItemTable", "cursorAuth/stripeSubscriptionStatus")
        .map(|raw| json_unquote(&raw))
        .unwrap_or_default();

    let mut agg = Aggregate::default();
    parse_composers(conn, &mut agg);
    parse_headers_fallback(conn, &mut agg);
    let generations = count_ai_generations(conn);
    let code_tracking = read_code_tracking(conn);
    let assistant_chars = scan_assistant_chars(conn);
    let estimate = compute_estimate(&agg.sessions_info, &assistant_chars);

    agg.recent.sort_by(|a, b| {
        let left = a.get("_sortKey").and_then(Value::as_f64).unwrap_or(0.0);
        let right = b.get("_sortKey").and_then(Value::as_f64).unwrap_or(0.0);
        right
            .partial_cmp(&left)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let recent: Vec<Value> = agg
        .recent
        .iter()
        .take(6)
        .map(|item| {
            let mut clone = item.clone();
            if let Some(object) = clone.as_object_mut() {
                object.remove("_sortKey");
            }
            clone
        })
        .collect();

    let cost_usd = if agg.cost_recorded {
        json!(agg.cost_cents.round() / 100.0)
    } else {
        Value::Null
    };

    let has_data = agg.sessions > 0
        || generations > 0
        || !email.is_empty()
        || !plan.is_empty()
        || !code_tracking.is_null();
    let status = if has_data { "ok" } else { "empty" };
    let message = if has_data {
        "已读取 Cursor 本地会话/用量。"
    } else {
        "已找到 Cursor 数据库，但未解析到会话或用量记录。可能尚未登录或未使用过 AI 会话。"
    };

    Ok(json!({
      "supported": true,
      "status": status,
      "providerType": "cursor-local",
      "message": message,
      "dbPath": db_path.to_string_lossy().to_string(),
      "source": "Cursor globalStorage/state.vscdb",
      "account": {
        "email": email,
        "plan": plan,
        "subscriptionStatus": subscription_status,
      },
      "totals": {
        "sessions": agg.sessions,
        "today": agg.today,
        "week": agg.week,
        "messages": agg.messages,
        "contextTokens": agg.context_tokens_total,
        "contextTokensRecorded": agg.context_tokens_recorded,
        "costUsd": cost_usd,
        "costRecorded": agg.cost_recorded,
        "generations": generations,
      },
      "modelDistribution": model_distribution(&agg.models, &agg.model_tokens, 8),
      "modeDistribution": top_distribution(&agg.modes, "mode", 6),
      "codeTracking": code_tracking,
      "estimate": estimate,
      "recent": recent,
      "latestActivityAt": ms_to_iso(agg.latest_ms),
      "truncated": agg.truncated,
      "generatedAt": Utc::now().to_rfc3339(),
      "note": "本地读取 Cursor state.vscdb（只读、未联网）。花费为 Cursor 本地记录，可能与官网账单存在差异；跨机使用不计入。",
    }))
}

fn not_found_json(db_path: &Path) -> Value {
    json!({
      "supported": false,
      "status": "not_found",
      "providerType": "cursor-local",
      "message": "未找到 Cursor 本地数据库（state.vscdb）。请确认已安装并至少启动过一次 Cursor。",
      "dbPath": db_path.to_string_lossy().to_string(),
      "source": "Cursor globalStorage/state.vscdb",
      "account": { "email": "", "plan": "" },
      "totals": {
        "sessions": 0, "today": 0, "week": 0, "messages": 0,
        "contextTokens": 0, "contextTokensRecorded": false,
        "costUsd": Value::Null, "costRecorded": false, "generations": 0,
      },
      "modelDistribution": [],
      "modeDistribution": [],
      "codeTracking": Value::Null,
      "estimate": Value::Null,
      "recent": [],
      "latestActivityAt": "",
      "truncated": false,
      "generatedAt": Utc::now().to_rfc3339(),
    })
}

pub(crate) fn query_cursor_local_usage(query: &Value) -> Result<Value, String> {
    let object = parse_json_object(query);
    let db_path = resolve_db_path(&object)?;
    if !db_path.exists() {
        return Ok(not_found_json(&db_path));
    }

    let force = object.get("force").and_then(Value::as_bool).unwrap_or(false)
        || clean_string(object.get("force")) == "1";
    let key = db_path.to_string_lossy().to_string();
    let fingerprint = db_fingerprint(&db_path);

    // 指纹未变 && 非强制 → 直接命中持久化缓存，避免重扫 2GB（重启后依旧命中）。
    if !force && fingerprint > 0 {
        if let Some(mut cached) = read_cached_usage(&key, fingerprint) {
            if let Some(map) = cached.as_object_mut() {
                map.insert("cacheHit".to_string(), json!(true));
            }
            return Ok(cached);
        }
    }

    let result = with_connection(&db_path, |conn| build_usage(conn, &db_path))?;
    if fingerprint > 0 {
        write_cached_usage(&key, fingerprint, &result);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_db(path: &Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB);
             CREATE TABLE cursorDiskKV (key TEXT UNIQUE, value BLOB);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ItemTable (key, value) VALUES ('cursorAuth/cachedEmail', ?1)",
            ["\"dev@example.com\""],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ItemTable (key, value) VALUES ('cursorAuth/stripeMembershipType', ?1)",
            ["\"pro\""],
        )
        .unwrap();
        let now_ms = Utc::now().timestamp_millis();
        let composer = json!({
          "composerId": "abc-123",
          "name": "Fix routing bug",
          "createdAt": now_ms,
          "lastUpdatedAt": now_ms,
          "status": "completed",
          "unifiedMode": "agent",
          "contextTokensUsed": 12345,
          "modelConfig": { "modelName": "composer-1" },
          "fullConversationHeadersOnly": [
            { "bubbleId": "b1", "type": 1 },
            { "bubbleId": "b2", "type": 2 },
            { "bubbleId": "b3", "type": 1 }
          ],
          "usageData": { "default": { "costInCents": 8, "amount": 2 } }
        });
        conn.execute(
            "INSERT INTO cursorDiskKV (key, value) VALUES ('composerData:abc-123', ?1)",
            [composer.to_string()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ItemTable (key, value) VALUES ('aiCodeTracking.dailyStats.v1.5.2026-07-20', ?1)",
            [json!({
              "date": "2026-07-20",
              "tabSuggestedLines": 10,
              "tabAcceptedLines": 4,
              "composerSuggestedLines": 200,
              "composerAcceptedLines": 150
            })
            .to_string()],
        )
        .unwrap();
    }

    #[test]
    fn parses_local_cursor_usage() {
        let dir = std::env::temp_dir().join(format!("cursor-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("state.vscdb");
        seed_db(&db);

        let result = query_cursor_local_usage(&json!({ "stateDbPath": db.to_string_lossy() }))
            .expect("usage");
        assert_eq!(result["status"], "ok");
        assert_eq!(result["account"]["email"], "dev@example.com");
        assert_eq!(result["account"]["plan"], "pro");
        assert_eq!(result["totals"]["sessions"], 1);
        assert_eq!(result["totals"]["messages"], 3);
        assert_eq!(result["totals"]["contextTokens"], json!(12345.0));
        assert_eq!(result["totals"]["contextTokensRecorded"], true);
        assert_eq!(result["modelDistribution"][0]["contextTokens"], json!(12345.0));
        assert_eq!(result["totals"]["costRecorded"], true);
        assert_eq!(result["totals"]["costUsd"], json!(0.08));
        assert_eq!(result["totals"]["today"], 1);
        let recent = result["recent"].as_array().unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0]["name"], "Fix routing bug");
        assert_eq!(recent[0]["model"], "composer-1");

        assert_eq!(result["estimate"]["totals"]["input"], json!(12345.0));
        assert_eq!(result["estimate"]["totals"]["cacheRead"], json!(0.0));
        assert_eq!(result["estimate"]["totals"]["total"], json!(12345.0));
        assert_eq!(result["estimate"]["models"][0]["model"], "composer-1");

        assert_eq!(result["codeTracking"]["totals"]["acceptedLines"], json!(154.0));
        assert_eq!(result["codeTracking"]["totals"]["suggestedLines"], json!(210.0));
        let daily = result["codeTracking"]["daily"].as_array().unwrap();
        assert_eq!(daily.len(), 1);
        assert_eq!(daily[0]["date"], "2026-07-20");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_db_reports_not_found() {
        let missing = std::env::temp_dir().join("definitely-missing-cursor-db.vscdb");
        let result =
            query_cursor_local_usage(&json!({ "stateDbPath": missing.to_string_lossy() })).unwrap();
        assert_eq!(result["status"], "not_found");
        assert_eq!(result["supported"], false);
    }
}
