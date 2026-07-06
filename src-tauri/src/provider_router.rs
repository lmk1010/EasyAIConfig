use reqwest::blocking::Client;
use reqwest::header::{HeaderName, HeaderValue, ACCEPT_ENCODING, CONTENT_TYPE};
use reqwest::Method;
use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, VecDeque};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use url::Url;

use crate::codex::{
    load_claudecode_state, load_openclaw_state, load_opencode_state, save_claudecode_raw_config,
    save_openclaw_config, save_opencode_config,
};
use crate::config::{get_provider_secret, save_config};
use crate::provider::normalize_base_url;
use crate::{
    app_home, default_codex_home, ensure_dir, expand_home_path, home_dir, parse_env,
    parse_json_object, read_text, stringify_env, write_secret,
};

const DEFAULT_ROUTER_PORT: u16 = 18791;
const ROUTER_CLIENT_PROVIDER_KEY: &str = "easyai-router";
const LOCAL_ROUTER_NO_PROXY_ITEMS: &[&str] = &["127.0.0.1", "localhost", "::1"];
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;
const MAX_ROUTER_LOG_ROWS: i64 = 10_000;
const ROUTER_STATUS_LOG_LIMIT: i64 = 500;
const ROUTER_LOG_RETENTION_DAYS: i64 = 30;
const ROUTER_LOG_RETENTION_MS: i64 = ROUTER_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const ROUTER_LOG_DEFAULT_PAGE_SIZE: i64 = 50;
const ROUTER_LOG_MAX_PAGE_SIZE: i64 = 200;
const DEFAULT_ROUTER_UPSTREAM_TIMEOUT_MS: u64 = 600_000;
const MAX_ROUTER_UPSTREAM_TIMEOUT_MS: u64 = 1_800_000;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD: u64 = 3;
const DEFAULT_CIRCUIT_RECOVERY_WAIT_MS: u64 = 30_000;
const DEFAULT_CIRCUIT_SUCCESS_THRESHOLD: u64 = 2;
const DEFAULT_CIRCUIT_ERROR_RATE_THRESHOLD: f64 = 0.6;
const DEFAULT_CIRCUIT_MIN_REQUESTS: u64 = 5;
const CIRCUIT_WINDOW_LIMIT: usize = 20;

#[derive(Clone)]
struct RouterProviderConfig {
    tool: String,
    key: String,
    name: String,
    base_url: String,
    protocol: String,
    api_key: String,
    auth_token: String,
    weight: u32,
    balance_remaining: Option<f64>,
    balance_total: Option<f64>,
    balance_percent: Option<f64>,
    balance_unit: String,
    balance_status: String,
    balance_fetched_at: u64,
}

#[derive(Clone)]
struct RouterConfig {
    scope: String,
    project_path: String,
    codex_home: String,
    tool: String,
    providers: Vec<RouterProviderConfig>,
    timeout_ms: u64,
    route_strategy: String,
    round_robin: bool,
    balance_guard_enabled: bool,
    balance_min_percent: f64,
    balance_min_amount: f64,
    circuit_breaker_enabled: bool,
    circuit_failure_threshold: u64,
    circuit_recovery_wait_ms: u64,
    circuit_success_threshold: u64,
    circuit_error_rate_threshold: f64,
    circuit_min_requests: u64,
    started_at: String,
    port_fallback: bool,
}

#[derive(Default, Clone)]
struct ProviderStats {
    requests: u64,
    successes: u64,
    failures: u64,
    last_status: u16,
    last_error: String,
    circuit_state: String,
    circuit_opened_at_ms: i64,
    circuit_open_until_ms: i64,
    circuit_consecutive_failures: u64,
    circuit_consecutive_successes: u64,
    circuit_window: VecDeque<bool>,
}

#[derive(Clone)]
struct RouterLogEntry {
    at_ms: i64,
    at: String,
    tool: String,
    method: String,
    target: String,
    provider_key: String,
    status_code: u16,
    success: bool,
    retry: bool,
    latency_ms: u64,
    request_bytes: u64,
    response_bytes: u64,
    cached_input_tokens: u64,
    input_tokens: u64,
    output_tokens: u64,
    total_tokens: u64,
    source_protocol: String,
    target_protocol: String,
    request_converted: bool,
    response_converted: bool,
    error_normalized: bool,
    error: String,
}

#[derive(Default, Clone, Copy)]
struct RouterUsageSummary {
    input_tokens: u64,
    output_tokens: u64,
    cached_input_tokens: u64,
    total_tokens: u64,
}

impl RouterUsageSummary {
    fn has_any(self) -> bool {
        self.input_tokens > 0
            || self.output_tokens > 0
            || self.cached_input_tokens > 0
            || self.total_tokens > 0
    }
}

#[derive(Default)]
struct RouterStats {
    requests: u64,
    forwarded: u64,
    failed: u64,
    next_index: usize,
    proxy_ready: bool,
    last_probe_ok: bool,
    last_probe_status: u16,
    last_probe_error: String,
    last_probe_at: String,
    last_probe_latency_ms: u64,
    last_provider: String,
    last_status: u16,
    last_error: String,
    providers: BTreeMap<String, ProviderStats>,
    logs: VecDeque<RouterLogEntry>,
}

struct RouterRuntime {
    config: Arc<RouterConfig>,
    running: Arc<AtomicBool>,
    stats: Arc<Mutex<RouterStats>>,
    port: u16,
    base_url: String,
    handle: Option<thread::JoinHandle<()>>,
}

struct LocalRequest {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

struct ProxyResponse {
    status_code: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

#[derive(Default, Clone)]
struct RouterTransformMeta {
    source_protocol: String,
    target_protocol: String,
    request_converted: bool,
    response_converted: bool,
    error_normalized: bool,
}

struct ForwardOutcome {
    response: ProxyResponse,
    transform: RouterTransformMeta,
}

#[derive(Clone)]
struct RouterLogQuery {
    raw_query: String,
    query_like: String,
    provider: String,
    tool: String,
    status: String,
    from_ms: i64,
    to_ms: i64,
    page: i64,
    page_size: i64,
    offset: i64,
}

#[derive(Clone, Copy)]
struct RouterLogClearFilter {
    all: bool,
    before_ms: i64,
    from_ms: i64,
    to_ms: i64,
}

static ROUTER: OnceLock<Mutex<Option<RouterRuntime>>> = OnceLock::new();

fn router_slot() -> &'static Mutex<Option<RouterRuntime>> {
    ROUTER.get_or_init(|| Mutex::new(None))
}

fn clamp_u64(value: u64, min: u64, max: u64) -> u64 {
    value.max(min).min(max)
}

fn now_epoch_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn router_log_retention_cutoff_ms(now_ms: i64) -> i64 {
    now_ms.saturating_sub(ROUTER_LOG_RETENTION_MS)
}

fn value_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(|item| {
        item.as_i64().or_else(|| {
            item.as_u64()
                .and_then(|raw| i64::try_from(raw).ok())
                .or_else(|| item.as_str().and_then(|raw| raw.trim().parse::<i64>().ok()))
        })
    })
}

fn value_f64(value: Option<&Value>) -> Option<f64> {
    value.and_then(|item| {
        item.as_f64()
            .or_else(|| item.as_str().and_then(|raw| raw.trim().parse::<f64>().ok()))
    })
}

fn value_epoch_ms(value: Option<&Value>) -> Option<i64> {
    value.and_then(|item| {
        value_i64(Some(item)).or_else(|| {
            item.as_str().and_then(|raw| {
                chrono::DateTime::parse_from_rfc3339(raw.trim())
                    .ok()
                    .map(|date| date.timestamp_millis())
            })
        })
    })
}

fn value_string(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn parse_router_log_query(query: &Value) -> RouterLogQuery {
    let object = parse_json_object(query);
    let raw_query = value_string(object.get("query").or_else(|| object.get("q")));
    let query_like = if raw_query.trim().is_empty() {
        String::new()
    } else {
        format!("%{}%", raw_query.trim().to_ascii_lowercase())
    };
    let provider = {
        let raw = value_string(object.get("provider").or_else(|| object.get("providerKey")));
        if raw.is_empty() {
            "all".to_string()
        } else {
            raw
        }
    };
    let raw_tool = value_string(object.get("tool"));
    let tool = if raw_tool.is_empty() || raw_tool.eq_ignore_ascii_case("all") {
        "all".to_string()
    } else {
        normalize_router_tool(&raw_tool)
    };
    let raw_status = value_string(object.get("status")).to_ascii_lowercase();
    let status = match raw_status.as_str() {
        "success" | "failed" | "retry" => raw_status,
        _ => "all".to_string(),
    };
    let mut from_ms = value_epoch_ms(object.get("fromMs").or_else(|| object.get("from")))
        .unwrap_or(0)
        .max(0);
    let mut to_ms = value_epoch_ms(object.get("toMs").or_else(|| object.get("to")))
        .unwrap_or(0)
        .max(0);
    if from_ms > 0 && to_ms > 0 && from_ms > to_ms {
        std::mem::swap(&mut from_ms, &mut to_ms);
    }
    let page_size_source = object
        .get("pageSize")
        .or_else(|| object.get("page_size"))
        .or_else(|| object.get("limit"));
    let page_size = value_i64(page_size_source)
        .unwrap_or(ROUTER_LOG_DEFAULT_PAGE_SIZE)
        .clamp(1, ROUTER_LOG_MAX_PAGE_SIZE);
    let page = value_i64(object.get("page")).unwrap_or(1).max(1);
    let offset = page.saturating_sub(1).saturating_mul(page_size);
    RouterLogQuery {
        raw_query,
        query_like,
        provider,
        tool,
        status,
        from_ms,
        to_ms,
        page,
        page_size,
        offset,
    }
}

fn parse_router_log_clear_filter(body: &Value) -> RouterLogClearFilter {
    let object = parse_json_object(body);
    let mode = value_string(object.get("mode")).to_ascii_lowercase();
    let all = object.get("all").and_then(Value::as_bool).unwrap_or(false) || mode == "all";
    let older_than_days = value_f64(
        object
            .get("olderThanDays")
            .or_else(|| object.get("older_than_days")),
    )
    .unwrap_or(0.0);
    let before_from_days = if older_than_days > 0.0 {
        let delta_ms = (older_than_days * 24.0 * 60.0 * 60.0 * 1000.0).round() as i64;
        Some(now_epoch_ms().saturating_sub(delta_ms))
    } else {
        None
    };
    let mut before_ms = value_epoch_ms(object.get("beforeMs").or_else(|| object.get("before")))
        .or(before_from_days)
        .unwrap_or(0)
        .max(0);
    let mut from_ms = value_epoch_ms(object.get("fromMs").or_else(|| object.get("from")))
        .unwrap_or(0)
        .max(0);
    let mut to_ms = value_epoch_ms(object.get("toMs").or_else(|| object.get("to")))
        .unwrap_or(0)
        .max(0);
    if from_ms > 0 && to_ms > 0 && from_ms > to_ms {
        std::mem::swap(&mut from_ms, &mut to_ms);
    }
    if all {
        before_ms = 0;
        from_ms = 0;
        to_ms = 0;
    }
    RouterLogClearFilter {
        all,
        before_ms,
        from_ms,
        to_ms,
    }
}

fn router_log_entry_matches_clear(entry: &RouterLogEntry, filter: RouterLogClearFilter) -> bool {
    if filter.all {
        return true;
    }
    if filter.before_ms > 0 && entry.at_ms <= filter.before_ms {
        return true;
    }
    let has_range = filter.from_ms > 0 || filter.to_ms > 0;
    has_range
        && (filter.from_ms <= 0 || entry.at_ms >= filter.from_ms)
        && (filter.to_ms <= 0 || entry.at_ms <= filter.to_ms)
}

fn normalize_router_tool(value: &str) -> String {
    match value.trim().to_ascii_lowercase().replace('_', "-").as_str() {
        "claude" | "claudecode" | "claude-code" => "claudecode".to_string(),
        "claude-desktop" | "claudedesktop" => "claude-desktop".to_string(),
        "gemini" | "gemini-cli" | "google-gemini" => "gemini".to_string(),
        "open-code" | "opencode" => "opencode".to_string(),
        "open-claw" | "openclaw" => "openclaw".to_string(),
        "hermes" | "hermes-agent" => "hermes".to_string(),
        _ => "codex".to_string(),
    }
}

fn is_anthropic_router_tool(value: &str) -> bool {
    matches!(
        normalize_router_tool(value).as_str(),
        "claudecode" | "claude-desktop"
    )
}

fn normalize_router_protocol(value: &str) -> String {
    match value.trim().to_ascii_lowercase().replace('_', "-").as_str() {
        "responses" | "response" | "openai-responses" => "openai-responses".to_string(),
        "chat" | "openai" | "openai-chat" | "openai-completions" | "chat-completions"
        | "chat-completion" | "completions" => "openai-chat".to_string(),
        "anthropic" | "anthropic-messages" | "messages" => "anthropic".to_string(),
        "gemini" | "google-gemini" => "gemini".to_string(),
        _ => String::new(),
    }
}

fn default_router_protocol_for_tool(tool: &str) -> &'static str {
    let normalized = normalize_router_tool(tool);
    if is_anthropic_router_tool(&normalized) {
        return "anthropic";
    }
    if normalized == "gemini" {
        return "gemini";
    }
    "openai-responses"
}

fn router_protocol_or_default(value: &str, tool: &str) -> String {
    let normalized = normalize_router_protocol(value);
    if normalized.is_empty() {
        default_router_protocol_for_tool(tool).to_string()
    } else {
        normalized
    }
}

fn normalize_route_strategy(value: &str, round_robin: bool) -> String {
    match value.trim().to_ascii_lowercase().replace('-', "_").as_str() {
        "priority" | "primary" | "fixed" => "priority".to_string(),
        "round_robin" | "roundrobin" | "rr" => "round_robin".to_string(),
        "weighted" | "weight" | "weighted_round_robin" => "weighted".to_string(),
        "balance" | "balance_first" | "balance_aware" => "balance".to_string(),
        "auto" | "smart" | "" => {
            if round_robin {
                "auto".to_string()
            } else {
                "priority".to_string()
            }
        }
        _ => "auto".to_string(),
    }
}

fn json_f64(object: &Map<String, Value>, key: &str) -> Option<f64> {
    object
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn json_u64(object: &Map<String, Value>, key: &str) -> Option<u64> {
    object.get(key).and_then(Value::as_u64)
}

fn clamp_f64(value: f64, min: f64, max: f64) -> f64 {
    if !value.is_finite() {
        return min;
    }
    value.max(min).min(max)
}

fn provider_route_key(target: &RouterProviderConfig) -> String {
    format!(
        "{}:{}",
        normalize_router_tool(&target.tool),
        target.key.trim()
    )
}

fn provider_key_json(target: &RouterProviderConfig) -> Value {
    json!({
      "tool": normalize_router_tool(&target.tool),
      "providerKey": target.key,
      "routeKey": provider_route_key(target),
      "name": target.name,
      "baseUrl": target.base_url,
      "protocol": router_protocol_or_default(&target.protocol, &target.tool),
      "weight": target.weight,
      "balanceRemaining": target.balance_remaining,
      "balanceTotal": target.balance_total,
      "balancePercent": target.balance_percent,
      "balanceUnit": target.balance_unit,
      "balanceStatus": target.balance_status,
      "balanceFetchedAt": target.balance_fetched_at,
    })
}

fn router_log_db_path() -> Result<PathBuf, String> {
    let dir = app_home()?.join("cache");
    ensure_dir(&dir)?;
    Ok(dir.join("provider_router_logs.db"))
}

fn open_router_log_db() -> Result<Connection, String> {
    let path = router_log_db_path()?;
    let connection = Connection::open(&path).map_err(|error| error.to_string())?;
    connection
        .execute(
            "CREATE TABLE IF NOT EXISTS provider_router_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at_ms INTEGER NOT NULL,
        at TEXT NOT NULL,
        tool TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        method TEXT NOT NULL,
        target TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        success INTEGER NOT NULL,
        retry INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        request_bytes INTEGER NOT NULL DEFAULT 0,
        response_bytes INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        source_protocol TEXT NOT NULL DEFAULT '',
        target_protocol TEXT NOT NULL DEFAULT '',
        request_converted INTEGER NOT NULL DEFAULT 0,
        response_converted INTEGER NOT NULL DEFAULT 0,
        error_normalized INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT ''
      )",
            [],
        )
        .map_err(|error| error.to_string())?;
    ensure_router_log_column(
        &connection,
        "source_protocol",
        "ALTER TABLE provider_router_logs ADD COLUMN source_protocol TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_router_log_column(
        &connection,
        "target_protocol",
        "ALTER TABLE provider_router_logs ADD COLUMN target_protocol TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_router_log_column(
        &connection,
        "request_converted",
        "ALTER TABLE provider_router_logs ADD COLUMN request_converted INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_router_log_column(
        &connection,
        "response_converted",
        "ALTER TABLE provider_router_logs ADD COLUMN response_converted INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_router_log_column(
        &connection,
        "error_normalized",
        "ALTER TABLE provider_router_logs ADD COLUMN error_normalized INTEGER NOT NULL DEFAULT 0",
    )?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_provider_router_logs_at
       ON provider_router_logs(at_ms DESC, id DESC)",
            [],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_provider_router_logs_provider
       ON provider_router_logs(provider_key, id DESC)",
            [],
        )
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

fn ensure_router_log_column(
    connection: &Connection,
    column: &str,
    alter_sql: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare("PRAGMA table_info(provider_router_logs)")
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    if columns.iter().any(|existing| existing == column) {
        return Ok(());
    }
    connection
        .execute(alter_sql, [])
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn prune_router_logs(connection: &Connection) {
    let cutoff_ms = router_log_retention_cutoff_ms(now_epoch_ms());
    let _ = connection.execute(
        "DELETE FROM provider_router_logs WHERE at_ms < ?1",
        params![cutoff_ms],
    );
    let _ = connection.execute(
        "DELETE FROM provider_router_logs
     WHERE id NOT IN (
       SELECT id FROM provider_router_logs
       ORDER BY id DESC
       LIMIT ?1
     )",
        params![MAX_ROUTER_LOG_ROWS],
    );
}

fn router_log_entry_json(item: &RouterLogEntry) -> Value {
    json!({
      "at": item.at,
      "atMs": item.at_ms,
      "tool": item.tool,
      "method": item.method,
      "target": item.target,
      "providerKey": item.provider_key,
      "status": if item.status_code == 0 { Value::Null } else { json!(item.status_code) },
      "success": item.success,
      "retry": item.retry,
      "latencyMs": item.latency_ms,
      "requestBytes": item.request_bytes,
      "responseBytes": item.response_bytes,
      "cachedInputTokens": item.cached_input_tokens,
      "inputTokens": item.input_tokens,
      "outputTokens": item.output_tokens,
      "totalTokens": item.total_tokens,
      "sourceProtocol": item.source_protocol,
      "targetProtocol": item.target_protocol,
      "requestConverted": item.request_converted,
      "responseConverted": item.response_converted,
      "errorNormalized": item.error_normalized,
      "rectified": {
        "sourceProtocol": item.source_protocol,
        "targetProtocol": item.target_protocol,
        "request": item.request_converted,
        "response": item.response_converted,
        "error": item.error_normalized,
      },
      "error": item.error,
    })
}

fn router_log_entry_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RouterLogEntry> {
    Ok(RouterLogEntry {
        at_ms: row.get::<_, i64>(0)?,
        at: row.get::<_, String>(1)?,
        tool: row.get::<_, String>(2)?,
        provider_key: row.get::<_, String>(3)?,
        method: row.get::<_, String>(4)?,
        target: row.get::<_, String>(5)?,
        status_code: row.get::<_, i64>(6)?.clamp(0, u16::MAX as i64) as u16,
        success: row.get::<_, i64>(7)? == 1,
        retry: row.get::<_, i64>(8)? == 1,
        latency_ms: row.get::<_, i64>(9)?.max(0) as u64,
        request_bytes: row.get::<_, i64>(10)?.max(0) as u64,
        response_bytes: row.get::<_, i64>(11)?.max(0) as u64,
        cached_input_tokens: row.get::<_, i64>(12)?.max(0) as u64,
        input_tokens: row.get::<_, i64>(13)?.max(0) as u64,
        output_tokens: row.get::<_, i64>(14)?.max(0) as u64,
        total_tokens: row.get::<_, i64>(15)?.max(0) as u64,
        source_protocol: row.get::<_, String>(16)?,
        target_protocol: row.get::<_, String>(17)?,
        request_converted: row.get::<_, i64>(18)? == 1,
        response_converted: row.get::<_, i64>(19)? == 1,
        error_normalized: row.get::<_, i64>(20)? == 1,
        error: row.get::<_, String>(21)?,
    })
}

fn empty_router_stats_json() -> Value {
    json!({
      "requests": 0,
      "forwarded": 0,
      "failed": 0,
      "requestBytes": 0,
      "responseBytes": 0,
      "cachedInputTokens": 0,
      "inputTokens": 0,
      "outputTokens": 0,
      "totalTokens": 0,
      "circuit": {
        "enabled": false,
        "open": 0,
        "halfOpen": 0,
        "closed": 0,
      },
      "providers": [],
      "logs": [],
      "maxRows": MAX_ROUTER_LOG_ROWS,
      "retentionDays": ROUTER_LOG_RETENTION_DAYS,
    })
}

fn provider_health_from_stats(item: &ProviderStats, circuit_state: &str) -> &'static str {
    match circuit_state {
        "open" => "circuit-open",
        "half-open" => "probing",
        "disabled" => "disabled",
        _ if item.requests == 0 => "unknown",
        _ if item.circuit_consecutive_failures > 0 && is_retry_status(item.last_status) => {
            "unhealthy"
        }
        _ if item.failures > 0 && item.successes == 0 => "degraded",
        _ if item.successes > 0 => "healthy",
        _ => "unknown",
    }
}

fn provider_stats_item_json(key: &str, item: &ProviderStats, circuit_enabled: bool) -> Value {
    let circuit_state = if circuit_enabled {
        effective_provider_circuit_state(item).to_string()
    } else {
        "disabled".to_string()
    };
    let recent_requests = provider_circuit_window_requests(item) as u64;
    let recent_failures = provider_circuit_window_failures(item) as u64;
    let error_rate = provider_circuit_error_rate(item);
    json!({
        "providerKey": key,
        "tool": key.split_once(':').map_or("", |(tool, _)| tool),
        "requests": item.requests,
        "successes": item.successes,
        "failures": item.failures,
        "lastStatus": item.last_status,
        "lastError": item.last_error,
    "health": provider_health_from_stats(item, &circuit_state),
    "circuitState": circuit_state.as_str(),
    "circuitOpenUntilMs": if item.circuit_open_until_ms > 0 { json!(item.circuit_open_until_ms) } else { Value::Null },
    "circuitOpenedAtMs": if item.circuit_opened_at_ms > 0 { json!(item.circuit_opened_at_ms) } else { Value::Null },
    "circuitConsecutiveFailures": item.circuit_consecutive_failures,
    "circuitConsecutiveSuccesses": item.circuit_consecutive_successes,
    "circuitRecentRequests": recent_requests,
    "circuitRecentFailures": recent_failures,
    "circuitErrorRate": error_rate,
    "circuit": {
      "state": circuit_state.as_str(),
      "openUntilMs": if item.circuit_open_until_ms > 0 { json!(item.circuit_open_until_ms) } else { Value::Null },
      "openedAtMs": if item.circuit_opened_at_ms > 0 { json!(item.circuit_opened_at_ms) } else { Value::Null },
      "consecutiveFailures": item.circuit_consecutive_failures,
      "consecutiveSuccesses": item.circuit_consecutive_successes,
      "recentRequests": recent_requests,
      "recentFailures": recent_failures,
      "errorRate": error_rate,
    },
        "requestBytes": 0,
        "responseBytes": 0,
        "cachedInputTokens": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "totalTokens": 0,
      })
}

fn runtime_provider_stats_values(
    stats: &RouterStats,
    config: &RouterConfig,
) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    for target in &config.providers {
        let key = provider_route_key(target);
        let default_item = ProviderStats::default();
        let item = stats.providers.get(&key).unwrap_or(&default_item);
        out.insert(
            key.clone(),
            provider_stats_item_json(&key, item, config.circuit_breaker_enabled),
        );
    }
    for (key, item) in &stats.providers {
        out.entry(key.clone())
            .or_insert_with(|| provider_stats_item_json(key, item, config.circuit_breaker_enabled));
    }
    out
}

fn circuit_summary_json(
    provider_stats: &BTreeMap<String, Value>,
    config: Option<&RouterConfig>,
) -> Value {
    let mut open = 0_u64;
    let mut half_open = 0_u64;
    let mut closed = 0_u64;
    for item in provider_stats.values() {
        match item
            .get("circuitState")
            .and_then(Value::as_str)
            .unwrap_or("closed")
        {
            "open" => open += 1,
            "half-open" => half_open += 1,
            "closed" => closed += 1,
            _ => {}
        }
    }
    if let Some(config) = config {
        json!({
          "enabled": config.circuit_breaker_enabled,
          "open": open,
          "halfOpen": half_open,
          "closed": closed,
          "failureThreshold": config.circuit_failure_threshold,
          "recoveryWaitMs": config.circuit_recovery_wait_ms,
          "successThreshold": config.circuit_success_threshold,
          "errorRateThreshold": config.circuit_error_rate_threshold,
          "minRequests": config.circuit_min_requests,
          "windowLimit": CIRCUIT_WINDOW_LIMIT,
        })
    } else {
        json!({
          "enabled": true,
          "open": open,
          "halfOpen": half_open,
          "closed": closed,
          "windowLimit": CIRCUIT_WINDOW_LIMIT,
        })
    }
}

fn merge_runtime_provider_state(target: &mut Map<String, Value>, runtime: &Map<String, Value>) {
    for key in [
        "health",
        "circuitState",
        "circuitOpenUntilMs",
        "circuitOpenedAtMs",
        "circuitConsecutiveFailures",
        "circuitConsecutiveSuccesses",
        "circuitRecentRequests",
        "circuitRecentFailures",
        "circuitErrorRate",
        "circuit",
    ] {
        if let Some(value) = runtime.get(key) {
            target.insert(key.to_string(), value.clone());
        }
    }
}

fn enrich_runtime_stats_json(
    mut stats_json: Value,
    stats: &RouterStats,
    config: &RouterConfig,
) -> Value {
    let mut runtime_stats = runtime_provider_stats_values(stats, config);
    if let Some(providers) = stats_json
        .get_mut("providers")
        .and_then(Value::as_array_mut)
    {
        for provider in providers.iter_mut() {
            let Some(object) = provider.as_object_mut() else {
                continue;
            };
            let Some(key) = object
                .get("providerKey")
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                continue;
            };
            if let Some(runtime) = runtime_stats
                .remove(&key)
                .and_then(|value| value.as_object().cloned())
            {
                merge_runtime_provider_state(object, &runtime);
            }
        }
        providers.extend(runtime_stats.into_values());
    } else if let Some(object) = stats_json.as_object_mut() {
        object.insert(
            "providers".to_string(),
            Value::Array(runtime_stats.values().cloned().collect()),
        );
    }
    if let Some(object) = stats_json.as_object_mut() {
        let summary_map = runtime_provider_stats_values(stats, config);
        object.insert(
            "circuit".to_string(),
            circuit_summary_json(&summary_map, Some(config)),
        );
    }
    stats_json
}

fn persist_router_log(entry: &RouterLogEntry) -> Result<(), String> {
    let connection = open_router_log_db()?;
    connection
    .execute(
      "INSERT INTO provider_router_logs
        (at_ms, at, tool, provider_key, method, target, status_code, success, retry, latency_ms,
         request_bytes, response_bytes, cached_input_tokens, input_tokens, output_tokens, total_tokens,
         source_protocol, target_protocol, request_converted, response_converted, error_normalized, error)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
      params![
        entry.at_ms,
        &entry.at,
        &entry.tool,
        &entry.provider_key,
        &entry.method,
        &entry.target,
        entry.status_code as i64,
        if entry.success { 1_i64 } else { 0_i64 },
        if entry.retry { 1_i64 } else { 0_i64 },
        entry.latency_ms as i64,
        entry.request_bytes as i64,
        entry.response_bytes as i64,
        entry.cached_input_tokens as i64,
        entry.input_tokens as i64,
        entry.output_tokens as i64,
        entry.total_tokens as i64,
        &entry.source_protocol,
        &entry.target_protocol,
        if entry.request_converted { 1_i64 } else { 0_i64 },
        if entry.response_converted { 1_i64 } else { 0_i64 },
        if entry.error_normalized { 1_i64 } else { 0_i64 },
        &entry.error,
      ],
    )
    .map_err(|error| error.to_string())?;
    prune_router_logs(&connection);
    Ok(())
}

fn load_persisted_router_stats(limit: i64) -> Value {
    match try_load_persisted_router_stats(limit) {
        Ok(value) => value,
        Err(_) => empty_router_stats_json(),
    }
}

fn try_load_persisted_router_stats(limit: i64) -> Result<Value, String> {
    let connection = open_router_log_db()?;
    prune_router_logs(&connection);
    let limit = limit.clamp(1, MAX_ROUTER_LOG_ROWS);

    let mut totals_stmt = connection
        .prepare(
            "SELECT
        COUNT(*),
        COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0),
        COALESCE(SUM(request_bytes), 0),
        COALESCE(SUM(response_bytes), 0),
        COALESCE(SUM(cached_input_tokens), 0),
        COALESCE(SUM(input_tokens), 0),
        COALESCE(SUM(output_tokens), 0),
        COALESCE(SUM(total_tokens), 0)
       FROM provider_router_logs",
        )
        .map_err(|error| error.to_string())?;
    let totals = totals_stmt
        .query_row([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })
        .map_err(|error| error.to_string())?;

    let mut provider_stmt = connection
    .prepare(
      "SELECT
        provider_key,
        COALESCE(MAX(tool), ''),
        COUNT(*),
        COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0),
        COALESCE(SUM(request_bytes), 0),
        COALESCE(SUM(response_bytes), 0),
        COALESCE(SUM(cached_input_tokens), 0),
        COALESCE(SUM(input_tokens), 0),
        COALESCE(SUM(output_tokens), 0),
        COALESCE(SUM(total_tokens), 0),
        COALESCE((SELECT status_code FROM provider_router_logs latest WHERE latest.provider_key = logs.provider_key ORDER BY latest.id DESC LIMIT 1), 0),
        COALESCE((SELECT error FROM provider_router_logs latest WHERE latest.provider_key = logs.provider_key ORDER BY latest.id DESC LIMIT 1), '')
       FROM provider_router_logs logs
       GROUP BY provider_key
       ORDER BY MAX(id) DESC
       LIMIT 200",
    )
    .map_err(|error| error.to_string())?;
    let mapped_providers = provider_stmt
        .query_map([], |row| {
            Ok(json!({
              "providerKey": row.get::<_, String>(0)?,
              "tool": row.get::<_, String>(1)?,
              "requests": row.get::<_, i64>(2)?,
              "successes": row.get::<_, i64>(3)?,
              "failures": row.get::<_, i64>(4)?,
              "requestBytes": row.get::<_, i64>(5)?,
              "responseBytes": row.get::<_, i64>(6)?,
              "cachedInputTokens": row.get::<_, i64>(7)?,
              "inputTokens": row.get::<_, i64>(8)?,
              "outputTokens": row.get::<_, i64>(9)?,
              "totalTokens": row.get::<_, i64>(10)?,
              "lastStatus": row.get::<_, i64>(11)?,
              "lastError": row.get::<_, String>(12)?,
            }))
        })
        .map_err(|error| error.to_string())?;
    let providers = mapped_providers.filter_map(Result::ok).collect::<Vec<_>>();

    let mut log_stmt = connection
    .prepare(
      "SELECT
        at_ms, at, tool, provider_key, method, target, status_code, success, retry, latency_ms,
        request_bytes, response_bytes, cached_input_tokens, input_tokens, output_tokens, total_tokens,
        source_protocol, target_protocol, request_converted, response_converted, error_normalized, error
       FROM provider_router_logs
       ORDER BY id DESC
       LIMIT ?1",
    )
    .map_err(|error| error.to_string())?;
    let mapped_logs = log_stmt
        .query_map(params![limit], |row| {
            let entry = router_log_entry_from_row(row)?;
            Ok(router_log_entry_json(&entry))
        })
        .map_err(|error| error.to_string())?;
    let logs = mapped_logs.filter_map(Result::ok).collect::<Vec<_>>();

    Ok(json!({
      "requests": totals.0,
      "forwarded": totals.1,
      "failed": totals.2,
      "requestBytes": totals.3,
      "responseBytes": totals.4,
      "cachedInputTokens": totals.5,
      "inputTokens": totals.6,
      "outputTokens": totals.7,
      "totalTokens": totals.8,
      "maxRows": MAX_ROUTER_LOG_ROWS,
      "retentionDays": ROUTER_LOG_RETENTION_DAYS,
      "circuit": {
        "enabled": false,
        "open": 0,
        "halfOpen": 0,
        "closed": 0,
      },
      "providers": providers,
      "logs": logs,
    }))
}

fn router_log_filter_sql() -> &'static str {
    "WHERE
       (?1 = '' OR lower(
         at || ' ' || tool || ' ' || provider_key || ' ' || method || ' ' || target || ' ' ||
         status_code || ' ' || error || ' ' || source_protocol || ' ' || target_protocol
       ) LIKE ?1)
       AND (?2 = 'all' OR provider_key = ?2)
       AND (?3 = 'all' OR tool = ?3 OR provider_key LIKE (?3 || ':%'))
       AND (
         ?4 = 'all'
         OR (?4 = 'success' AND success = 1 AND retry = 0)
         OR (?4 = 'failed' AND success = 0 AND retry = 0)
         OR (?4 = 'retry' AND retry = 1)
       )
       AND (?5 <= 0 OR at_ms >= ?5)
       AND (?6 <= 0 OR at_ms <= ?6)"
}

fn try_query_router_logs(query: &Value) -> Result<Value, String> {
    let connection = open_router_log_db()?;
    prune_router_logs(&connection);
    let mut filter = parse_router_log_query(query);
    let where_sql = router_log_filter_sql();
    let total_sql = format!("SELECT COUNT(*) FROM provider_router_logs {where_sql}");
    let total = connection
        .prepare(&total_sql)
        .map_err(|error| error.to_string())?
        .query_row(
            params![
                &filter.query_like,
                &filter.provider,
                &filter.tool,
                &filter.status,
                filter.from_ms,
                filter.to_ms,
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?
        .max(0);
    let page_count = if total == 0 {
        0
    } else {
        (total + filter.page_size - 1) / filter.page_size
    };
    if page_count > 0 && filter.page > page_count {
        filter.page = page_count;
        filter.offset = filter
            .page
            .saturating_sub(1)
            .saturating_mul(filter.page_size);
    }

    let logs_sql = format!(
        "SELECT
          at_ms, at, tool, provider_key, method, target, status_code, success, retry, latency_ms,
          request_bytes, response_bytes, cached_input_tokens, input_tokens, output_tokens, total_tokens,
          source_protocol, target_protocol, request_converted, response_converted, error_normalized, error
         FROM provider_router_logs
         {where_sql}
         ORDER BY at_ms DESC, id DESC
         LIMIT ?7 OFFSET ?8"
    );
    let mut log_stmt = connection
        .prepare(&logs_sql)
        .map_err(|error| error.to_string())?;
    let mapped_logs = log_stmt
        .query_map(
            params![
                &filter.query_like,
                &filter.provider,
                &filter.tool,
                &filter.status,
                filter.from_ms,
                filter.to_ms,
                filter.page_size,
                filter.offset,
            ],
            |row| {
                let entry = router_log_entry_from_row(row)?;
                Ok(router_log_entry_json(&entry))
            },
        )
        .map_err(|error| error.to_string())?;
    let logs = mapped_logs.filter_map(Result::ok).collect::<Vec<_>>();

    let mut provider_stmt = connection
        .prepare(
            "SELECT provider_key, COALESCE(MAX(tool), ''), COUNT(*), MAX(id)
             FROM provider_router_logs
             GROUP BY provider_key
             ORDER BY MAX(id) DESC
             LIMIT 500",
        )
        .map_err(|error| error.to_string())?;
    let mapped_providers = provider_stmt
        .query_map([], |row| {
            Ok(json!({
              "providerKey": row.get::<_, String>(0)?,
              "tool": row.get::<_, String>(1)?,
              "requests": row.get::<_, i64>(2)?,
            }))
        })
        .map_err(|error| error.to_string())?;
    let providers = mapped_providers.filter_map(Result::ok).collect::<Vec<_>>();

    Ok(json!({
      "schema": "easyaiconfig.provider-router-logs.v1",
      "logs": logs,
      "providers": providers,
      "filters": {
        "query": filter.raw_query,
        "provider": filter.provider,
        "tool": filter.tool,
        "status": filter.status,
        "fromMs": filter.from_ms,
        "toMs": filter.to_ms,
      },
      "pagination": {
        "page": filter.page,
        "pageSize": filter.page_size,
        "pageCount": page_count,
        "total": total,
        "offset": filter.offset,
        "hasPrev": filter.page > 1 && page_count > 0,
        "hasNext": page_count > 0 && filter.page < page_count,
      },
      "retention": {
        "days": ROUTER_LOG_RETENTION_DAYS,
        "maxRows": MAX_ROUTER_LOG_ROWS,
      },
    }))
}

fn clear_runtime_router_logs(filter: RouterLogClearFilter) {
    let guard = router_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(runtime) = guard.as_ref() else {
        return;
    };
    let mut stats = runtime
        .stats
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    stats
        .logs
        .retain(|entry| !router_log_entry_matches_clear(entry, filter));
}

fn try_clear_router_logs(body: &Value) -> Result<Value, String> {
    let filter = parse_router_log_clear_filter(body);
    if !filter.all && filter.before_ms <= 0 && filter.from_ms <= 0 && filter.to_ms <= 0 {
        return Err("请选择要清理的日志时间范围".to_string());
    }
    let connection = open_router_log_db()?;
    let deleted = if filter.all {
        connection
            .execute("DELETE FROM provider_router_logs", [])
            .map_err(|error| error.to_string())?
    } else if filter.before_ms > 0 {
        connection
            .execute(
                "DELETE FROM provider_router_logs WHERE at_ms <= ?1",
                params![filter.before_ms],
            )
            .map_err(|error| error.to_string())?
    } else {
        connection
            .execute(
                "DELETE FROM provider_router_logs
                 WHERE (?1 <= 0 OR at_ms >= ?1)
                   AND (?2 <= 0 OR at_ms <= ?2)",
                params![filter.from_ms, filter.to_ms],
            )
            .map_err(|error| error.to_string())?
    };
    prune_router_logs(&connection);
    clear_runtime_router_logs(filter);
    Ok(json!({
      "schema": "easyaiconfig.provider-router-log-clear.v1",
      "deleted": deleted as i64,
      "retention": {
        "days": ROUTER_LOG_RETENTION_DAYS,
        "maxRows": MAX_ROUTER_LOG_ROWS,
      },
    }))
}

fn is_router_loopback_endpoint(value: &str) -> bool {
    let raw = value.trim();
    if raw.is_empty() {
        return false;
    }
    let candidate = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    };
    let Ok(url) = Url::parse(&candidate) else {
        return false;
    };
    let host = url
        .host_str()
        .unwrap_or_default()
        .trim_matches(&['[', ']'][..])
        .to_ascii_lowercase();
    let port = url.port_or_known_default().unwrap_or(0);
    port == DEFAULT_ROUTER_PORT && (host == "127.0.0.1" || host == "localhost" || host == "::1")
}

fn is_router_self_target(target: &RouterProviderConfig) -> bool {
    let key = target.key.trim().to_ascii_lowercase();
    let name = target.name.trim().to_ascii_lowercase();
    let route_key = provider_route_key(target).to_ascii_lowercase();
    key == ROUTER_CLIENT_PROVIDER_KEY
        || [
            "codex",
            "claudecode",
            "claude-desktop",
            "gemini",
            "opencode",
            "openclaw",
            "hermes",
        ]
        .iter()
        .any(|tool| route_key == format!("{tool}:{ROUTER_CLIENT_PROVIDER_KEY}"))
        || name == "easyaiconfig router"
        || is_router_loopback_endpoint(&target.base_url)
}

fn append_no_proxy_items(current: &str) -> String {
    let mut items = current
        .split(',')
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>();
    for item in LOCAL_ROUTER_NO_PROXY_ITEMS {
        if !items
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(item))
        {
            items.push((*item).to_string());
        }
    }
    items.join(",")
}

fn ensure_codex_router_no_proxy(codex_home: &str) -> Result<bool, String> {
    let codex_home = expand_home_path(codex_home).map_or_else(default_codex_home, Ok)?;
    let env_path = codex_home.join(".env");
    let env_content = read_text(&env_path)?;
    let mut env = parse_env(&env_content);
    let original = env.clone();
    for key in ["NO_PROXY", "no_proxy"] {
        let next = append_no_proxy_items(env.get(key).map(String::as_str).unwrap_or_default());
        if env.get(key).map(String::as_str) != Some(next.as_str()) {
            env.insert(key.to_string(), next);
        }
    }
    if env == original {
        return Ok(false);
    }
    write_secret(&env_path, &stringify_env(&env))?;
    Ok(true)
}

fn router_body_string(object: &Map<String, Value>, key: &str) -> String {
    object
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn router_client_no_proxy(value: &str) -> String {
    append_no_proxy_items(value)
}

fn router_client_model_id(value: &str) -> String {
    let parts = value
        .split('/')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>();
    if parts.len() <= 1 {
        return value.trim().to_string();
    }
    let tail = parts[1..].join("/");
    if tail.trim().is_empty() {
        parts.first().copied().unwrap_or_default().to_string()
    } else {
        tail
    }
}

fn ensure_json_object(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = json!({});
    }
    value.as_object_mut().expect("json object")
}

fn ensure_child_object<'a>(
    object: &'a mut Map<String, Value>,
    key: &str,
) -> &'a mut Map<String, Value> {
    let entry = object.entry(key.to_string()).or_insert_with(|| json!({}));
    if !entry.is_object() {
        *entry = json!({});
    }
    entry.as_object_mut().expect("child json object")
}

fn router_client_profile(
    tool: &str,
    endpoint: &str,
    api_key: &str,
    no_proxy: &str,
    model: &str,
) -> Value {
    let env = if is_anthropic_router_tool(tool) {
        json!({
          "NO_PROXY": no_proxy,
          "no_proxy": no_proxy,
          "ANTHROPIC_BASE_URL": endpoint,
          "ANTHROPIC_API_KEY": api_key,
        })
    } else {
        json!({
          "NO_PROXY": no_proxy,
          "no_proxy": no_proxy,
          "OPENAI_BASE_URL": endpoint,
          "OPENAI_API_KEY": api_key,
        })
    };
    json!({
      "providerKey": ROUTER_CLIENT_PROVIDER_KEY,
      "name": "EasyAIConfig Router",
      "tool": tool,
      "baseUrl": endpoint,
      "apiKey": api_key,
      "model": model,
      "env": env,
      "updatedAt": chrono::Utc::now().to_rfc3339(),
    })
}

fn merge_router_client_namespace(config: &mut Value, profile: Value) {
    let config_object = ensure_json_object(config);
    let easy = ensure_child_object(config_object, "easyaiconfig");
    easy.insert("router".to_string(), profile);
    easy.insert(
        "activeProvider".to_string(),
        json!(ROUTER_CLIENT_PROVIDER_KEY),
    );
}

fn read_json_object_path(path: &PathBuf) -> Result<Value, String> {
    let raw = read_text(path)?;
    if raw.trim().is_empty() {
        return Ok(json!({}));
    }
    let value = serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string())?;
    if value.is_object() {
        Ok(value)
    } else {
        Ok(json!({}))
    }
}

fn router_namespaced_config_path(tool: &str) -> Result<PathBuf, String> {
    let home = home_dir()?;
    match normalize_router_tool(tool).as_str() {
        "claude-desktop" => {
            let root = if cfg!(target_os = "macos") {
                home.join("Library")
                    .join("Application Support")
                    .join("Claude")
            } else if cfg!(target_os = "windows") {
                std::env::var("APPDATA")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join("AppData").join("Roaming"))
                    .join("Claude")
            } else {
                std::env::var("XDG_CONFIG_HOME")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".config"))
                    .join("Claude")
            };
            Ok(root.join("claude_desktop_config.json"))
        }
        "gemini" => Ok(home.join(".gemini").join("settings.json")),
        "hermes" => Ok(home.join(".hermes").join("config.json")),
        _ => Err(format!("Unsupported namespaced router client: {tool}")),
    }
}

fn apply_claudecode_router_client(
    endpoint: &str,
    api_key: &str,
    no_proxy: &str,
    model: &str,
) -> Result<Value, String> {
    let state = load_claudecode_state(&json!({ "cacheOnly": "true" }))?;
    let mut settings = state.get("settings").cloned().unwrap_or_else(|| json!({}));
    let settings_object = ensure_json_object(&mut settings);
    let env = ensure_child_object(settings_object, "env");
    env.insert("NO_PROXY".to_string(), json!(no_proxy));
    env.insert("no_proxy".to_string(), json!(no_proxy));
    env.insert("ANTHROPIC_BASE_URL".to_string(), json!(endpoint));
    env.insert("ANTHROPIC_API_KEY".to_string(), json!(api_key));
    env.remove("ANTHROPIC_AUTH_TOKEN");
    if !model.trim().is_empty() {
        settings_object.insert("model".to_string(), json!(model));
    }

    let easy = ensure_child_object(settings_object, "easyaiconfig");
    let providers = ensure_child_object(easy, "providers");
    providers.insert(
        ROUTER_CLIENT_PROVIDER_KEY.to_string(),
        json!({
          "name": "EasyAIConfig Router",
          "baseUrl": endpoint,
          "apiKey": api_key,
          "authToken": "",
          "model": model,
          "updatedAt": chrono::Utc::now().to_rfc3339(),
        }),
    );
    easy.insert(
        "activeProvider".to_string(),
        json!(ROUTER_CLIENT_PROVIDER_KEY),
    );
    let raw = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    let saved = save_claudecode_raw_config(&json!({ "settingsJson": raw }))?;
    Ok(json!({
      "saved": true,
      "tool": "claudecode",
      "configPath": saved.get("settingsPath").cloned().unwrap_or(Value::Null),
      "settingsPath": saved.get("settingsPath").cloned().unwrap_or(Value::Null),
    }))
}

fn apply_opencode_router_client(
    object: &Map<String, Value>,
    endpoint: &str,
    api_key: &str,
    no_proxy: &str,
    model: &str,
) -> Result<Value, String> {
    let state = load_opencode_state(&Value::Object(object.clone()))?;
    let mut config = state.get("config").cloned().unwrap_or_else(|| json!({}));
    let model_id = router_client_model_id(model);
    let config_object = ensure_json_object(&mut config);
    config_object
        .entry("$schema".to_string())
        .or_insert_with(|| json!("https://opencode.ai/config.json"));
    let provider_map = ensure_child_object(config_object, "provider");
    let provider = ensure_child_object(provider_map, ROUTER_CLIENT_PROVIDER_KEY);
    provider.insert("name".to_string(), json!("EasyAIConfig Router"));
    let options = ensure_child_object(provider, "options");
    options.insert("baseURL".to_string(), json!(endpoint));
    options.insert("apiKey".to_string(), json!(api_key));
    if !model_id.trim().is_empty() {
        let models = ensure_child_object(provider, "models");
        models.entry(model_id.clone()).or_insert_with(|| json!({}));
        config_object.insert(
            "model".to_string(),
            json!(format!("{}/{}", ROUTER_CLIENT_PROVIDER_KEY, model_id)),
        );
    }
    let profile = router_client_profile("opencode", endpoint, api_key, no_proxy, &model_id);
    merge_router_client_namespace(&mut config, profile);
    let raw = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    let saved = save_opencode_config(&json!({
      "scope": router_body_string(object, "scope"),
      "projectPath": router_body_string(object, "projectPath"),
      "configJson": raw,
    }))?;
    Ok(json!({
      "saved": true,
      "tool": "opencode",
      "scope": saved.get("scope").cloned().unwrap_or(Value::Null),
      "configPath": saved.get("configPath").cloned().unwrap_or(Value::Null),
    }))
}

fn apply_openclaw_router_client(
    endpoint: &str,
    api_key: &str,
    no_proxy: &str,
    model: &str,
) -> Result<Value, String> {
    let state = load_openclaw_state()?;
    let mut config = state.get("config").cloned().unwrap_or_else(|| json!({}));
    let model_id = {
        let value = router_client_model_id(model);
        if value.trim().is_empty() {
            "gpt-5.5".to_string()
        } else {
            value
        }
    };
    let config_object = ensure_json_object(&mut config);
    let env = ensure_child_object(config_object, "env");
    env.insert("EASYAI_ROUTER_API_KEY".to_string(), json!(api_key));
    let agents = ensure_child_object(config_object, "agents");
    let defaults = ensure_child_object(agents, "defaults");
    let model_defaults = ensure_child_object(defaults, "model");
    model_defaults.insert(
        "primary".to_string(),
        json!(format!("{}/{}", ROUTER_CLIENT_PROVIDER_KEY, model_id)),
    );
    let models = ensure_child_object(config_object, "models");
    models
        .entry("mode".to_string())
        .or_insert_with(|| json!("merge"));
    let providers = ensure_child_object(models, "providers");
    providers.insert(
        ROUTER_CLIENT_PROVIDER_KEY.to_string(),
        json!({
          "baseUrl": endpoint,
          "api": "openai-completions",
          "apiKey": "$EASYAI_ROUTER_API_KEY",
          "models": [{
            "id": model_id,
            "name": model_id,
            "api": "openai-completions",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 200000,
            "maxTokens": 8192
          }],
        }),
    );
    let profile = router_client_profile("openclaw", endpoint, api_key, no_proxy, &model_id);
    merge_router_client_namespace(&mut config, profile);
    let raw = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    let saved = save_openclaw_config(&json!({ "configJson": raw }))?;
    Ok(json!({
      "saved": true,
      "tool": "openclaw",
      "configPath": saved.get("configPath").cloned().unwrap_or(Value::Null),
    }))
}

fn apply_namespaced_router_client(
    tool: &str,
    endpoint: &str,
    api_key: &str,
    no_proxy: &str,
    model: &str,
) -> Result<Value, String> {
    let path = router_namespaced_config_path(tool)?;
    let mut config = read_json_object_path(&path)?;
    let profile = router_client_profile(tool, endpoint, api_key, no_proxy, model);
    merge_router_client_namespace(&mut config, profile);
    let raw = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    write_secret(&path, &format!("{raw}\n"))?;
    Ok(json!({
      "saved": true,
      "tool": tool,
      "configPath": path.to_string_lossy().to_string(),
    }))
}

fn yaml_quoted_scalar(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn hermes_router_model_id(model: &str) -> String {
    let model_id = router_client_model_id(model);
    if model_id.trim().is_empty() {
        "gpt-5.5".to_string()
    } else {
        model_id
    }
}

fn render_hermes_router_model_block(endpoint: &str, api_key: &str, model: &str) -> String {
    let model_id = hermes_router_model_id(model);
    format!(
        "model:\n  provider: \"custom\"\n  default: {}\n  base_url: {}\n  api_key: {}\n",
        yaml_quoted_scalar(&model_id),
        yaml_quoted_scalar(endpoint),
        yaml_quoted_scalar(api_key)
    )
}

fn unquote_yaml_scalar(value: &str) -> String {
    let text = value.trim();
    if text.is_empty() {
        return String::new();
    }
    if text.len() >= 2
        && ((text.starts_with('"') && text.ends_with('"'))
            || (text.starts_with('\'') && text.ends_with('\'')))
    {
        if text.starts_with('"') {
            return serde_json::from_str::<String>(text)
                .unwrap_or_else(|_| text[1..text.len() - 1].to_string());
        }
        return text[1..text.len() - 1].to_string();
    }
    text.to_string()
}

fn read_top_level_yaml_object_block(raw: &str, key: &str) -> BTreeMap<String, String> {
    let normalized = raw.replace("\r\n", "\n");
    let lines = normalized
        .split('\n')
        .map(|line| line.to_string())
        .collect::<Vec<_>>();
    let marker = format!("{key}:");
    let Some(start) = lines.iter().position(|line| {
        !line.starts_with(' ') && !line.starts_with('\t') && line.trim_end().starts_with(&marker)
    }) else {
        return BTreeMap::new();
    };

    let mut out = BTreeMap::new();
    let inline = lines[start]
        .trim_end()
        .strip_prefix(&marker)
        .unwrap_or("")
        .trim();
    if !inline.is_empty() {
        out.insert("value".to_string(), unquote_yaml_scalar(inline));
    }

    for line in lines.iter().skip(start + 1) {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        if !line.starts_with(' ') && !line.starts_with('\t') {
            break;
        }
        let trimmed = line.trim();
        if let Some((raw_key, raw_value)) = trimmed.split_once(':') {
            let field_key = raw_key.trim();
            if field_key.is_empty()
                || !field_key
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
            {
                continue;
            }
            out.insert(field_key.to_string(), unquote_yaml_scalar(raw_value));
        }
    }
    out
}

fn mask_router_secret(value: &str) -> String {
    let text = value.trim();
    if text.is_empty() {
        return String::new();
    }
    let chars = text.chars().collect::<Vec<_>>();
    if chars.len() <= 8 {
        let prefix = chars.iter().take(2).collect::<String>();
        let suffix = chars.last().copied().unwrap_or('*');
        return format!("{prefix}***{suffix}");
    }
    let prefix = chars.iter().take(4).collect::<String>();
    let suffix = chars
        .iter()
        .rev()
        .take(4)
        .copied()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    format!("{prefix}***{suffix}")
}

pub(crate) fn load_hermes_state(_query: &Value) -> Result<Value, String> {
    let home = home_dir()?.join(".hermes");
    let config_path = home.join("config.yaml");
    let env_path = home.join(".env");
    let index_path = home.join("config.json");
    let raw_yaml = read_text(&config_path)?;
    let raw_env = read_text(&env_path)?;
    let index = read_json_object_path(&index_path)?;
    let env = parse_env(&raw_env);
    let model_block = read_top_level_yaml_object_block(&raw_yaml, "model");
    let router_profile = index
        .pointer("/easyaiconfig/router")
        .cloned()
        .unwrap_or(Value::Null);
    let profile_model = router_profile
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let profile_base_url = router_profile
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let profile_api_key = router_profile
        .get("apiKey")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let native_api_key = model_block.get("api_key").cloned().unwrap_or_default();
    let env_api_key = env
        .get("EASYAI_ROUTER_API_KEY")
        .or_else(|| env.get("OPENAI_API_KEY"))
        .cloned()
        .unwrap_or_default();
    let model = model_block
        .get("default")
        .cloned()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(profile_model);
    let base_url = model_block
        .get("base_url")
        .cloned()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| env.get("OPENAI_BASE_URL").cloned())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(profile_base_url);
    let secret_for_mask = if !native_api_key.trim().is_empty() {
        native_api_key.clone()
    } else if !env_api_key.trim().is_empty() {
        env_api_key.clone()
    } else {
        profile_api_key.clone()
    };
    let has_api_key = !native_api_key.trim().is_empty()
        || !env_api_key.trim().is_empty()
        || !profile_api_key.is_empty();
    let no_proxy = env
        .get("NO_PROXY")
        .or_else(|| env.get("no_proxy"))
        .cloned()
        .or_else(|| {
            router_profile
                .pointer("/env/NO_PROXY")
                .and_then(Value::as_str)
                .map(|value| value.to_string())
        })
        .unwrap_or_default();
    let index_exists = index
        .as_object()
        .map(|object| !object.is_empty())
        .unwrap_or(false);
    let active_provider_key = router_profile
        .get("providerKey")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            if model_block.get("provider").is_some() {
                "custom"
            } else {
                ""
            }
        })
        .to_string();

    Ok(json!({
      "toolId": "hermes",
      "configHome": home.to_string_lossy().to_string(),
      "configPath": config_path.to_string_lossy().to_string(),
      "envPath": env_path.to_string_lossy().to_string(),
      "indexPath": index_path.to_string_lossy().to_string(),
      "configExists": !raw_yaml.trim().is_empty(),
      "envExists": !raw_env.trim().is_empty(),
      "indexExists": index_exists,
      "configYaml": raw_yaml,
      "model": model.clone(),
      "baseUrl": base_url.clone(),
      "activeProviderKey": active_provider_key,
      "nativeProvider": {
        "provider": model_block.get("provider").cloned().unwrap_or_default(),
        "model": model.clone(),
        "baseUrl": base_url.clone(),
        "hasApiKey": has_api_key,
        "maskedApiKey": mask_router_secret(&secret_for_mask),
        "configPath": config_path.to_string_lossy().to_string(),
        "envPath": env_path.to_string_lossy().to_string(),
      },
      "env": {
        "hasEasyAiRouterKey": env.contains_key("EASYAI_ROUTER_API_KEY"),
        "hasOpenAiKey": env.contains_key("OPENAI_API_KEY"),
        "openAiBaseUrl": env.get("OPENAI_BASE_URL").cloned().unwrap_or_default(),
        "noProxy": no_proxy,
      },
      "routerProfile": router_profile,
    }))
}

pub(crate) fn load_gemini_state(_query: &Value) -> Result<Value, String> {
    let home = home_dir()?.join(".gemini");
    let config_path = home.join("settings.json");
    let raw = read_text(&config_path)?;
    let settings = read_json_object_path(&config_path)?;
    let router_profile = settings
        .pointer("/easyaiconfig/router")
        .cloned()
        .unwrap_or(Value::Null);
    let model = router_profile
        .get("model")
        .and_then(Value::as_str)
        .or_else(|| settings.get("model").and_then(Value::as_str))
        .unwrap_or("")
        .trim()
        .to_string();
    let base_url = router_profile
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let api_key = router_profile
        .get("apiKey")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let active_provider_key = router_profile
        .get("providerKey")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();

    Ok(json!({
      "toolId": "gemini",
      "configHome": home.to_string_lossy().to_string(),
      "configPath": config_path.to_string_lossy().to_string(),
      "configExists": !raw.trim().is_empty(),
      "settings": settings,
      "model": model.clone(),
      "baseUrl": base_url.clone(),
      "activeProviderKey": active_provider_key.clone(),
      "routerProfile": router_profile,
      "safeProfile": {
        "provider": active_provider_key,
        "model": model,
        "baseUrl": base_url,
        "hasApiKey": !api_key.is_empty(),
        "maskedApiKey": mask_router_secret(&api_key),
        "configPath": config_path.to_string_lossy().to_string(),
      },
    }))
}

fn upsert_top_level_yaml_block(raw: &str, key: &str, block: &str) -> String {
    let normalized = raw.replace("\r\n", "\n");
    let clean_block = block.trim_end_matches('\n');
    if normalized.trim().is_empty() {
        return format!("{clean_block}\n");
    }

    let lines = normalized
        .split('\n')
        .map(|line| line.to_string())
        .collect::<Vec<_>>();
    let marker = format!("{key}:");
    let start = lines.iter().position(|line| {
        !line.starts_with(' ') && !line.starts_with('\t') && line.trim_end().starts_with(&marker)
    });

    let Some(start) = start else {
        return format!("{}\n\n{clean_block}\n", normalized.trim_end_matches('\n'));
    };

    let mut end = start + 1;
    while end < lines.len() {
        let line = &lines[end];
        if line.trim().is_empty()
            || line.starts_with(' ')
            || line.starts_with('\t')
            || line.trim_start().starts_with('#')
        {
            end += 1;
            continue;
        }
        break;
    }

    let mut out = Vec::new();
    out.extend(lines[..start].iter().cloned());
    out.extend(clean_block.split('\n').map(|line| line.to_string()));
    out.extend(lines[end..].iter().cloned());
    format!("{}\n", out.join("\n").trim_end_matches('\n'))
}

fn apply_hermes_router_client(
    endpoint: &str,
    api_key: &str,
    no_proxy: &str,
    model: &str,
) -> Result<Value, String> {
    let home = home_dir()?.join(".hermes");
    let config_path = home.join("config.yaml");
    let env_path = home.join(".env");
    let index_path = home.join("config.json");
    let model_id = hermes_router_model_id(model);

    let raw_yaml = read_text(&config_path)?;
    let next_yaml = upsert_top_level_yaml_block(
        &raw_yaml,
        "model",
        &render_hermes_router_model_block(endpoint, api_key, &model_id),
    );
    write_secret(&config_path, &next_yaml)?;

    let env_raw = read_text(&env_path)?;
    let mut env = parse_env(&env_raw);
    env.insert("EASYAI_ROUTER_API_KEY".to_string(), api_key.to_string());
    env.insert("OPENAI_API_KEY".to_string(), api_key.to_string());
    env.insert("OPENAI_BASE_URL".to_string(), endpoint.to_string());
    env.insert("NO_PROXY".to_string(), no_proxy.to_string());
    env.insert("no_proxy".to_string(), no_proxy.to_string());
    write_secret(&env_path, &stringify_env(&env))?;

    let mut index = read_json_object_path(&index_path)?;
    let mut profile = router_client_profile("hermes", endpoint, api_key, no_proxy, &model_id);
    if let Some(profile_object) = profile.as_object_mut() {
        profile_object.insert(
            "nativeProvider".to_string(),
            json!({
              "configPath": config_path.to_string_lossy().to_string(),
              "envPath": env_path.to_string_lossy().to_string(),
              "provider": "custom",
              "model": model_id,
            }),
        );
    }
    merge_router_client_namespace(&mut index, profile);
    let raw_index = serde_json::to_string_pretty(&index).map_err(|error| error.to_string())?;
    write_secret(&index_path, &format!("{raw_index}\n"))?;

    Ok(json!({
      "saved": true,
      "tool": "hermes",
      "configPath": config_path.to_string_lossy().to_string(),
      "envPath": env_path.to_string_lossy().to_string(),
      "indexPath": index_path.to_string_lossy().to_string(),
      "nativeProvider": true,
    }))
}

pub(crate) fn apply_provider_router_client_config(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let tool = normalize_router_tool(
        object
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or("codex"),
    );
    let endpoint_raw = {
        let endpoint = router_body_string(&object, "endpoint");
        if endpoint.is_empty() {
            let base_url = router_body_string(&object, "baseUrl");
            if base_url.is_empty() {
                "http://127.0.0.1:18791/v1".to_string()
            } else {
                base_url
            }
        } else {
            endpoint
        }
    };
    let endpoint = normalize_base_url(&endpoint_raw)?;
    let api_key = {
        let value = router_body_string(&object, "apiKey");
        if value.is_empty() {
            ROUTER_CLIENT_PROVIDER_KEY.to_string()
        } else {
            value
        }
    };
    let no_proxy = router_client_no_proxy(&router_body_string(&object, "noProxy"));
    let model = router_body_string(&object, "model");

    match tool.as_str() {
        "codex" => {
            let mut payload = Map::new();
            payload.insert(
                "scope".to_string(),
                json!(router_body_string(&object, "scope")),
            );
            payload.insert(
                "projectPath".to_string(),
                json!(router_body_string(&object, "projectPath")),
            );
            payload.insert(
                "codexHome".to_string(),
                json!(router_body_string(&object, "codexHome")),
            );
            payload.insert("providerKey".to_string(), json!(ROUTER_CLIENT_PROVIDER_KEY));
            payload.insert("providerLabel".to_string(), json!("EasyAIConfig Router"));
            payload.insert("baseUrl".to_string(), json!(endpoint));
            payload.insert("apiKey".to_string(), json!(api_key));
            payload.insert("envKey".to_string(), json!("EASYAI_ROUTER_API_KEY"));
            payload.insert("model".to_string(), json!(model));
            payload.insert("activate".to_string(), json!(true));
            let mut saved = save_config(&Value::Object(payload))?;
            let saved_object = ensure_json_object(&mut saved);
            saved_object.insert("tool".to_string(), json!("codex"));
            Ok(saved)
        }
        "claudecode" => apply_claudecode_router_client(&endpoint, &api_key, &no_proxy, &model),
        "opencode" => apply_opencode_router_client(&object, &endpoint, &api_key, &no_proxy, &model),
        "openclaw" => apply_openclaw_router_client(&endpoint, &api_key, &no_proxy, &model),
        "hermes" => apply_hermes_router_client(&endpoint, &api_key, &no_proxy, &model),
        "claude-desktop" | "gemini" => {
            apply_namespaced_router_client(&tool, &endpoint, &api_key, &no_proxy, &model)
        }
        _ => Err(format!("Unsupported router client tool: {tool}")),
    }
}

fn dedupe_provider_targets(
    raw: Vec<RouterProviderConfig>,
    primary: &str,
) -> Vec<RouterProviderConfig> {
    let mut out: Vec<RouterProviderConfig> = Vec::new();
    let primary = primary.trim().to_string();
    if !primary.is_empty() {
        if let Some(index) = raw
            .iter()
            .position(|item| item.key == primary || provider_route_key(item) == primary)
        {
            out.push(raw[index].clone());
        }
    }
    for target in raw {
        let clean = target.key.trim();
        if clean.is_empty()
            || out
                .iter()
                .any(|item| provider_route_key(item) == provider_route_key(&target))
        {
            continue;
        }
        out.push(target);
    }
    out
}

fn provider_targets_from_body(object: &Map<String, Value>) -> Vec<RouterProviderConfig> {
    let default_tool = normalize_router_tool(
        object
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or("codex"),
    );
    let mut targets = Vec::new();

    if let Some(items) = object.get("providerTargets").and_then(Value::as_array) {
        for item in items {
            let item_object = item.as_object().cloned().unwrap_or_default();
            let key = item_object
                .get("providerKey")
                .or_else(|| item_object.get("key"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            if key.is_empty() {
                continue;
            }
            targets.push(RouterProviderConfig {
                tool: normalize_router_tool(
                    item_object
                        .get("tool")
                        .and_then(Value::as_str)
                        .unwrap_or(&default_tool),
                ),
                key,
                name: item_object
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
                base_url: item_object
                    .get("baseUrl")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
                protocol: router_protocol_or_default(
                    item_object
                        .get("protocol")
                        .or_else(|| item_object.get("wireApi"))
                        .or_else(|| item_object.get("wire_api"))
                        .or_else(|| item_object.get("api"))
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    item_object
                        .get("tool")
                        .and_then(Value::as_str)
                        .unwrap_or(&default_tool),
                ),
                api_key: item_object
                    .get("apiKey")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
                auth_token: item_object
                    .get("authToken")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
                weight: json_u64(&item_object, "weight")
                    .unwrap_or(1)
                    .max(1)
                    .min(100) as u32,
                balance_remaining: json_f64(&item_object, "balanceRemaining"),
                balance_total: json_f64(&item_object, "balanceTotal"),
                balance_percent: json_f64(&item_object, "balancePercent")
                    .map(|value| clamp_f64(value, 0.0, 100.0)),
                balance_unit: item_object
                    .get("balanceUnit")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
                balance_status: item_object
                    .get("balanceStatus")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .trim()
                    .to_ascii_lowercase(),
                balance_fetched_at: json_u64(&item_object, "balanceFetchedAt").unwrap_or(0),
            });
        }
    }

    if let Some(items) = object.get("providerKeys").and_then(Value::as_array) {
        for item in items {
            if let Some(key) = item.as_str() {
                targets.push(RouterProviderConfig {
                    tool: default_tool.clone(),
                    key: key.trim().to_string(),
                    name: String::new(),
                    base_url: String::new(),
                    protocol: router_protocol_or_default("", &default_tool),
                    api_key: String::new(),
                    auth_token: String::new(),
                    weight: 1,
                    balance_remaining: None,
                    balance_total: None,
                    balance_percent: None,
                    balance_unit: String::new(),
                    balance_status: "unknown".to_string(),
                    balance_fetched_at: 0,
                });
            }
        }
    }
    if let Some(key) = object.get("providerKey").and_then(Value::as_str) {
        targets.push(RouterProviderConfig {
            tool: default_tool.clone(),
            key: key.trim().to_string(),
            name: String::new(),
            base_url: String::new(),
            protocol: router_protocol_or_default("", &default_tool),
            api_key: String::new(),
            auth_token: String::new(),
            weight: 1,
            balance_remaining: None,
            balance_total: None,
            balance_percent: None,
            balance_unit: String::new(),
            balance_status: "unknown".to_string(),
            balance_fetched_at: 0,
        });
    }
    let primary = object
        .get("primaryProviderKey")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let targets = targets
        .into_iter()
        .filter(|target| !is_router_self_target(target))
        .collect::<Vec<_>>();
    dedupe_provider_targets(targets, primary)
}

fn runtime_status_json(runtime: &RouterRuntime, log_limit: i64) -> Value {
    let mut stats = runtime
        .stats
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if runtime.config.circuit_breaker_enabled {
        let now_ms = now_epoch_ms();
        for target in &runtime.config.providers {
            let route_key = provider_route_key(target);
            let item = stats.providers.entry(route_key).or_default();
            refresh_provider_circuit(&runtime.config, item, now_ms);
        }
    }
    let proxy_ready = stats.proxy_ready || stats.forwarded > 0;
    let persisted_stats = enrich_runtime_stats_json(
        load_persisted_router_stats(log_limit),
        &stats,
        &runtime.config,
    );
    let stats_json = persisted_stats;
    json!({
      "running": runtime.running.load(Ordering::SeqCst),
      "baseUrl": runtime.base_url,
      "openaiBaseUrl": runtime.base_url,
      "originUrl": format!("http://127.0.0.1:{}", runtime.port),
      "anthropicBaseUrl": format!("http://127.0.0.1:{}", runtime.port),
      "port": runtime.port,
      "startedAt": runtime.config.started_at,
      "scope": runtime.config.scope,
      "projectPath": runtime.config.project_path,
      "codexHome": runtime.config.codex_home,
      "tool": runtime.config.tool,
      "providerKeys": runtime.config.providers.iter().map(provider_route_key).collect::<Vec<_>>(),
      "providerTargets": runtime.config.providers.iter().map(provider_key_json).collect::<Vec<_>>(),
      "routeStrategy": runtime.config.route_strategy,
      "roundRobin": runtime.config.round_robin,
      "balanceGuardEnabled": runtime.config.balance_guard_enabled,
      "balanceMinPercent": runtime.config.balance_min_percent,
      "balanceMinAmount": runtime.config.balance_min_amount,
      "circuitBreakerEnabled": runtime.config.circuit_breaker_enabled,
      "circuitFailureThreshold": runtime.config.circuit_failure_threshold,
      "circuitRecoveryWaitMs": runtime.config.circuit_recovery_wait_ms,
      "circuitSuccessThreshold": runtime.config.circuit_success_threshold,
      "circuitErrorRateThreshold": runtime.config.circuit_error_rate_threshold,
      "circuitMinRequests": runtime.config.circuit_min_requests,
      "portFallback": runtime.config.port_fallback,
      "proxyReady": proxy_ready,
      "probe": {
        "ok": stats.last_probe_ok,
        "status": if stats.last_probe_status == 0 { Value::Null } else { json!(stats.last_probe_status) },
        "error": stats.last_probe_error,
        "checkedAt": if stats.last_probe_at.is_empty() { Value::Null } else { json!(stats.last_probe_at) },
        "latencyMs": if stats.last_probe_latency_ms == 0 { Value::Null } else { json!(stats.last_probe_latency_ms) },
      },
      "stats": stats_json,
    })
}

fn stopped_status_json(log_limit: i64) -> Value {
    let stats = load_persisted_router_stats(log_limit);
    json!({
      "running": false,
      "baseUrl": Value::Null,
      "openaiBaseUrl": Value::Null,
      "originUrl": Value::Null,
      "anthropicBaseUrl": Value::Null,
      "port": Value::Null,
      "tool": Value::Null,
      "providerKeys": [],
      "providerTargets": [],
      "routeStrategy": "auto",
      "balanceGuardEnabled": true,
      "balanceMinPercent": 5.0,
      "balanceMinAmount": 0.0,
      "circuitBreakerEnabled": true,
      "circuitFailureThreshold": DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
      "circuitRecoveryWaitMs": DEFAULT_CIRCUIT_RECOVERY_WAIT_MS,
      "circuitSuccessThreshold": DEFAULT_CIRCUIT_SUCCESS_THRESHOLD,
      "circuitErrorRateThreshold": DEFAULT_CIRCUIT_ERROR_RATE_THRESHOLD,
      "circuitMinRequests": DEFAULT_CIRCUIT_MIN_REQUESTS,
      "proxyReady": false,
      "probe": {
        "ok": false,
        "status": Value::Null,
        "error": "",
        "checkedAt": Value::Null,
        "latencyMs": Value::Null,
      },
      "stats": stats,
    })
}

fn router_status_log_limit(query: &Value) -> i64 {
    let object = parse_json_object(query);
    object
        .get("limit")
        .and_then(|value| {
            value.as_i64().or_else(|| {
                value
                    .as_str()
                    .and_then(|raw| raw.trim().parse::<i64>().ok())
            })
        })
        .unwrap_or(ROUTER_STATUS_LOG_LIMIT)
        .clamp(1, MAX_ROUTER_LOG_ROWS)
}

fn stop_router_runtime() -> Value {
    let runtime = {
        let mut guard = router_slot()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.take()
    };
    if let Some(mut runtime) = runtime {
        runtime.running.store(false, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", runtime.port));
        if let Some(handle) = runtime.handle.take() {
            let _ = handle.join();
        }
    }
    stopped_status_json(ROUTER_STATUS_LOG_LIMIT)
}

fn reason_phrase(status_code: u16) -> &'static str {
    match status_code {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        413 => "Payload Too Large",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "OK",
    }
}

fn write_response(stream: &mut TcpStream, status_code: u16, content_type: &str, body: &[u8]) {
    let headers = format!(
    "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: authorization,content-type,openai-beta,x-api-key,anthropic-version,anthropic-beta\r\nAccess-Control-Allow-Methods: GET,POST,OPTIONS\r\n\r\n",
    status_code,
    reason_phrase(status_code),
    content_type,
    body.len()
  );
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn write_json(stream: &mut TcpStream, status_code: u16, value: Value) {
    let body =
        serde_json::to_vec(&value).unwrap_or_else(|_| b"{\"error\":\"encode failed\"}".to_vec());
    write_response(
        stream,
        status_code,
        "application/json; charset=utf-8",
        &body,
    );
}

fn router_probe_payload(tool: &str, model: &str) -> (&'static str, Value) {
    let normalized_tool = normalize_router_tool(tool);
    let model = model.trim();
    if is_anthropic_router_tool(&normalized_tool) {
        (
            "/v1/messages",
            json!({
              "model": if model.is_empty() { "claude-sonnet-4-20250514" } else { model },
              "max_tokens": 1,
              "messages": [{ "role": "user", "content": "ping" }],
            }),
        )
    } else {
        (
            "/v1/responses",
            json!({
              "model": if model.is_empty() { "gpt-5.5" } else { model },
              "input": "ping",
              "max_output_tokens": 1,
              "stream": false,
            }),
        )
    }
}

fn parse_http_status(response: &[u8]) -> u16 {
    let text = String::from_utf8_lossy(response);
    let status_line = text.lines().next().unwrap_or_default();
    status_line
        .split_whitespace()
        .nth(1)
        .and_then(|part| part.parse::<u16>().ok())
        .unwrap_or(0)
}

fn http_body_text(response: &[u8]) -> String {
    if let Some(index) = response.windows(4).position(|window| window == b"\r\n\r\n") {
        return String::from_utf8_lossy(&response[index + 4..]).to_string();
    }
    String::new()
}

fn summarize_probe_error(status_code: u16, body_text: &str) -> String {
    if body_text.trim().is_empty() {
        return if status_code == 0 {
            "本地网关没有返回 HTTP 状态".to_string()
        } else {
            format!("HTTP {status_code}")
        };
    }
    if let Ok(payload) = serde_json::from_str::<Value>(body_text) {
        if let Some(message) = payload.pointer("/error/message").and_then(Value::as_str) {
            return message.to_string();
        }
        if let Some(detail) = payload.get("detail").and_then(Value::as_str) {
            return detail.to_string();
        }
        if let Some(error) = payload.get("error").and_then(Value::as_str) {
            return error.to_string();
        }
    }
    body_text.chars().take(500).collect()
}

fn send_local_router_probe(
    port: u16,
    tool: &str,
    model: &str,
    timeout_ms: u64,
) -> Result<u16, String> {
    let timeout = Duration::from_millis(clamp_u64(timeout_ms, 5000, 120000));
    let (path, body_value) = router_probe_payload(tool, model);
    let body = serde_json::to_vec(&body_value).map_err(|error| error.to_string())?;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream =
        TcpStream::connect_timeout(&addr, timeout).map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    let request_head = format!(
    "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer easyai-router\r\nContent-Type: application/json\r\nAccept: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
    body.len()
  );
    stream
        .write_all(request_head.as_bytes())
        .map_err(|error| error.to_string())?;
    stream.write_all(&body).map_err(|error| error.to_string())?;
    stream.flush().map_err(|error| error.to_string())?;

    let mut response = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                response.extend_from_slice(&buffer[..read]);
                if response.len() > 2 * 1024 * 1024 {
                    return Err("probe response too large".to_string());
                }
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let status_code = parse_http_status(&response);
    if (200..300).contains(&status_code) {
        Ok(status_code)
    } else {
        Err(summarize_probe_error(
            status_code,
            &http_body_text(&response),
        ))
    }
}

fn record_router_probe(
    stats: &Arc<Mutex<RouterStats>>,
    ok: bool,
    status_code: u16,
    error: &str,
    latency_ms: u64,
) {
    let mut guard = stats
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.last_probe_ok = ok;
    guard.last_probe_status = status_code;
    guard.last_probe_error = error.to_string();
    guard.last_probe_at = chrono::Utc::now().to_rfc3339();
    guard.last_probe_latency_ms = latency_ms;
    if ok {
        guard.proxy_ready = true;
    }
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn read_local_request(stream: &mut TcpStream) -> Result<LocalRequest, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|error| error.to_string())?;
    let mut buffer = Vec::new();
    let mut temp = [0_u8; 8192];
    let header_end = loop {
        let read = stream.read(&mut temp).map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("connection closed before request headers".to_string());
        }
        buffer.extend_from_slice(&temp[..read]);
        if buffer.len() > MAX_HEADER_BYTES {
            return Err("request headers too large".to_string());
        }
        if let Some(index) = find_header_end(&buffer) {
            break index + 4;
        }
    };

    let header_text =
        std::str::from_utf8(&buffer[..header_end]).map_err(|error| error.to_string())?;
    let mut lines = header_text.split("\r\n").filter(|line| !line.is_empty());
    let request_line = lines
        .next()
        .ok_or_else(|| "missing request line".to_string())?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();
    if method.is_empty() || target.is_empty() {
        return Err("invalid request line".to_string());
    }

    let mut headers = Vec::new();
    let mut content_length = 0_usize;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            let clean_name = name.trim().to_string();
            let clean_value = value.trim().to_string();
            if clean_name.eq_ignore_ascii_case("content-length") {
                content_length = clean_value.parse::<usize>().unwrap_or(0);
            }
            headers.push((clean_name, clean_value));
        }
    }
    if content_length > MAX_BODY_BYTES {
        return Err("request body too large".to_string());
    }

    while buffer.len() < header_end + content_length {
        let read = stream.read(&mut temp).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&temp[..read]);
        if buffer.len() > header_end + MAX_BODY_BYTES {
            return Err("request body too large".to_string());
        }
    }
    let end = (header_end + content_length).min(buffer.len());
    Ok(LocalRequest {
        method,
        target,
        headers,
        body: buffer[header_end..end].to_vec(),
    })
}

fn path_query_from_target(target: &str) -> String {
    if let Ok(url) = Url::parse(target) {
        let mut out = url.path().to_string();
        if let Some(query) = url.query() {
            out.push('?');
            out.push_str(query);
        }
        return out;
    }
    if target.trim().is_empty() {
        "/".to_string()
    } else {
        target.to_string()
    }
}

fn build_upstream_url(base_url: &str, target: &str) -> Result<String, String> {
    let base = normalize_base_url(base_url).or_else(|_| {
        Url::parse(base_url.trim())
            .map(|url| url.to_string().trim_end_matches('/').to_string())
            .map_err(|error| error.to_string())
    })?;
    let parsed_base = Url::parse(&base).map_err(|error| error.to_string())?;
    let path_query = path_query_from_target(target);
    let (raw_path, query) = path_query
        .split_once('?')
        .map_or((path_query.as_str(), ""), |(path, query)| (path, query));
    let path = if raw_path.starts_with('/') {
        raw_path.to_string()
    } else {
        format!("/{raw_path}")
    };
    let base_path = parsed_base.path().trim_end_matches('/').to_lowercase();
    let duplicate_version_prefix = ["/v1", "/v1beta", "/v1alpha"]
        .iter()
        .find(|prefix| {
            (base_path == **prefix || base_path.ends_with(*prefix))
                && (path == **prefix
                    || path.starts_with(&format!("{}/", prefix.trim_end_matches('/'))))
        })
        .copied();
    let forwarded_path = if let Some(prefix) = duplicate_version_prefix {
        let stripped = &path[prefix.len()..];
        if stripped.is_empty() {
            "/".to_string()
        } else {
            stripped.to_string()
        }
    } else {
        path
    };
    let mut out = format!("{}{}", base.trim_end_matches('/'), forwarded_path);
    if !query.is_empty() {
        out.push('?');
        out.push_str(query);
    }
    Ok(out)
}

fn endpoint_path_for_protocol(protocol: &str) -> Option<&'static str> {
    match normalize_router_protocol(protocol).as_str() {
        "openai-responses" => Some("/v1/responses"),
        "openai-chat" => Some("/v1/chat/completions"),
        "anthropic" => Some("/v1/messages"),
        _ => None,
    }
}

fn gemini_model_id_from_body(value: &Value) -> String {
    let raw = value
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("gemini-2.5-flash")
        .trim();
    let model_id = router_client_model_id(raw);
    let model_id = model_id.trim().trim_start_matches("models/").trim();
    if model_id.is_empty() {
        "gemini-2.5-flash".to_string()
    } else {
        model_id.to_string()
    }
}

fn gemini_target_for_body(original_target: &str, body: &Value) -> String {
    let model_id = gemini_model_id_from_body(body);
    let stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let action = if stream {
        "streamGenerateContent"
    } else {
        "generateContent"
    };
    let mut target = format!("/v1beta/models/{model_id}:{action}");
    let path_query = path_query_from_target(original_target);
    let mut query_items = path_query
        .split_once('?')
        .map(|(_, query)| query.trim().to_string())
        .filter(|query| !query.is_empty())
        .unwrap_or_default();
    if stream && !query_items.split('&').any(|item| item == "alt=sse") {
        if !query_items.is_empty() {
            query_items.push('&');
        }
        query_items.push_str("alt=sse");
    }
    if !query_items.is_empty() {
        target.push('?');
        target.push_str(&query_items);
    }
    target
}

fn infer_router_protocol_from_target(target: &str, fallback: &str) -> String {
    let path = path_query_from_target(target);
    let path_only = path.split_once('?').map_or(path.as_str(), |(path, _)| path);
    let lower = path_only.trim_end_matches('/').to_ascii_lowercase();
    if lower == "/responses" || lower == "/v1/responses" || lower.ends_with("/responses") {
        return "openai-responses".to_string();
    }
    if lower == "/chat/completions"
        || lower == "/v1/chat/completions"
        || lower.ends_with("/chat/completions")
    {
        return "openai-chat".to_string();
    }
    if lower == "/messages" || lower == "/v1/messages" || lower.ends_with("/messages") {
        return "anthropic".to_string();
    }
    if lower.contains(":generatecontent") || lower.contains(":streamgeneratecontent") {
        return "gemini".to_string();
    }
    let normalized = normalize_router_protocol(fallback);
    if normalized.is_empty() {
        "openai-responses".to_string()
    } else {
        normalized
    }
}

fn replace_request_target_protocol(target: &str, target_protocol: &str) -> String {
    let Some(path) = endpoint_path_for_protocol(target_protocol) else {
        return target.to_string();
    };
    let path_query = path_query_from_target(target);
    let query = path_query
        .split_once('?')
        .map(|(_, query)| query)
        .filter(|query| !query.is_empty());
    match query {
        Some(query) => format!("{path}?{query}"),
        None => path.to_string(),
    }
}

fn replace_request_target_protocol_for_body(
    target: &str,
    target_protocol: &str,
    body: &Value,
) -> String {
    if normalize_router_protocol(target_protocol) == "gemini" {
        return gemini_target_for_body(target, body);
    }
    replace_request_target_protocol(target, target_protocol)
}

fn text_from_router_content(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(text_from_router_content)
            .filter(|text| !text.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(object) => {
            for key in ["text", "input_text", "output_text", "content"] {
                if let Some(nested) = object.get(key) {
                    let text = text_from_router_content(nested);
                    if !text.trim().is_empty() {
                        return text;
                    }
                }
            }
            value.to_string()
        }
        Value::Null => String::new(),
        _ => value.to_string(),
    }
}

fn messages_from_responses_input(object: &Map<String, Value>) -> Vec<Value> {
    let mut messages = Vec::new();
    if let Some(instructions) = object.get("instructions") {
        let content = text_from_router_content(instructions);
        if !content.trim().is_empty() {
            messages.push(json!({ "role": "system", "content": content }));
        }
    }
    match object.get("input") {
        Some(Value::String(text)) => messages.push(json!({ "role": "user", "content": text })),
        Some(Value::Array(items)) => {
            for item in items {
                match item {
                    Value::String(text) => {
                        messages.push(json!({ "role": "user", "content": text }))
                    }
                    Value::Object(input_object) => {
                        let role = input_object
                            .get("role")
                            .and_then(Value::as_str)
                            .unwrap_or("user")
                            .trim();
                        let content = input_object
                            .get("content")
                            .or_else(|| input_object.get("text"))
                            .or_else(|| input_object.get("input"))
                            .map(text_from_router_content)
                            .unwrap_or_default();
                        if !content.trim().is_empty() {
                            messages.push(
                json!({ "role": if role.is_empty() { "user" } else { role }, "content": content }),
              );
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    messages
}

fn responses_to_chat_body(value: Value) -> Value {
    let Value::Object(mut object) = value else {
        return value;
    };
    let messages = messages_from_responses_input(&object);
    if !messages.is_empty() {
        object.insert("messages".to_string(), Value::Array(messages));
    }
    if object.contains_key("max_output_tokens") && !object.contains_key("max_tokens") {
        if let Some(value) = object.get("max_output_tokens").cloned() {
            object.insert("max_tokens".to_string(), value);
        }
    }
    object.remove("input");
    object.remove("instructions");
    object.remove("max_output_tokens");
    Value::Object(object)
}

fn chat_to_responses_body(value: Value) -> Value {
    let Value::Object(mut object) = value else {
        return value;
    };
    let mut system = Vec::new();
    let mut input = Vec::new();
    if let Some(Value::Array(messages)) = object.get("messages") {
        for message in messages {
            let Some(message_object) = message.as_object() else {
                continue;
            };
            let role = message_object
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("user")
                .trim();
            let role = if role.is_empty() { "user" } else { role };
            let content = message_object
                .get("content")
                .map(text_from_router_content)
                .unwrap_or_default();
            if role == "system" {
                if !content.trim().is_empty() {
                    system.push(content);
                }
            } else if !content.trim().is_empty() {
                input.push(json!({ "role": role, "content": content }));
            }
        }
    }
    if !system.is_empty() {
        object.insert(
            "instructions".to_string(),
            Value::String(system.join("\n\n")),
        );
    }
    if !input.is_empty() {
        object.insert("input".to_string(), Value::Array(input));
    }
    if object.contains_key("max_tokens") && !object.contains_key("max_output_tokens") {
        if let Some(value) = object.get("max_tokens").cloned() {
            object.insert("max_output_tokens".to_string(), value);
        }
    }
    object.remove("messages");
    object.remove("max_tokens");
    Value::Object(object)
}

fn chat_to_anthropic_body(value: Value) -> Value {
    let Value::Object(mut object) = value else {
        return value;
    };
    let mut system = Vec::new();
    let mut anthropic_messages = Vec::new();
    if let Some(Value::Array(messages)) = object.get("messages") {
        for message in messages {
            let Some(message_object) = message.as_object() else {
                continue;
            };
            let role = message_object
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("user")
                .trim();
            let content = message_object
                .get("content")
                .map(text_from_router_content)
                .unwrap_or_default();
            if role == "system" {
                if !content.trim().is_empty() {
                    system.push(content);
                }
            } else if !content.trim().is_empty() {
                anthropic_messages.push(json!({
                  "role": if role == "assistant" { "assistant" } else { "user" },
                  "content": content,
                }));
            }
        }
    }
    object.insert("messages".to_string(), Value::Array(anthropic_messages));
    if !system.is_empty() {
        object.insert("system".to_string(), Value::String(system.join("\n\n")));
    }
    if object.contains_key("max_output_tokens") && !object.contains_key("max_tokens") {
        if let Some(value) = object.get("max_output_tokens").cloned() {
            object.insert("max_tokens".to_string(), value);
        }
    }
    if object.contains_key("max_completion_tokens") && !object.contains_key("max_tokens") {
        if let Some(value) = object.get("max_completion_tokens").cloned() {
            object.insert("max_tokens".to_string(), value);
        }
    }
    if object.contains_key("stop") && !object.contains_key("stop_sequences") {
        if let Some(value) = object.get("stop").cloned() {
            object.insert("stop_sequences".to_string(), value);
        }
    }
    object.remove("max_output_tokens");
    object.remove("max_completion_tokens");
    object.remove("stop");
    Value::Object(object)
}

fn anthropic_to_chat_body(value: Value) -> Value {
    let Value::Object(mut object) = value else {
        return value;
    };
    let mut messages = Vec::new();
    if let Some(system) = object.get("system") {
        let content = text_from_router_content(system);
        if !content.trim().is_empty() {
            messages.push(json!({ "role": "system", "content": content }));
        }
    }
    if let Some(Value::Array(items)) = object.get("messages") {
        for message in items {
            let Some(message_object) = message.as_object() else {
                continue;
            };
            let role = message_object
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("user")
                .trim();
            let content = message_object
                .get("content")
                .map(text_from_router_content)
                .unwrap_or_default();
            if !content.trim().is_empty() {
                messages.push(json!({
                  "role": if role == "assistant" { "assistant" } else { "user" },
                  "content": content,
                }));
            }
        }
    }
    object.insert("messages".to_string(), Value::Array(messages));
    if object.contains_key("stop_sequences") && !object.contains_key("stop") {
        if let Some(value) = object.get("stop_sequences").cloned() {
            object.insert("stop".to_string(), value);
        }
    }
    object.remove("system");
    object.remove("stop_sequences");
    Value::Object(object)
}

fn gemini_part_from_text(text: String) -> Option<Value> {
    if text.trim().is_empty() {
        None
    } else {
        Some(json!({ "text": text }))
    }
}

fn openai_tools_to_gemini_tools(value: &Value) -> Option<Value> {
    let Value::Array(tools) = value else {
        return None;
    };
    let mut declarations = Vec::new();
    for tool in tools {
        let Some(tool_object) = tool.as_object() else {
            continue;
        };
        let tool_type = tool_object
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if tool_type != "function" {
            continue;
        }
        let Some(function) = tool_object.get("function").and_then(Value::as_object) else {
            continue;
        };
        let name = function
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if name.is_empty() {
            continue;
        }
        let mut declaration = Map::new();
        declaration.insert("name".to_string(), Value::String(name.to_string()));
        if let Some(description) = function.get("description").and_then(Value::as_str) {
            if !description.trim().is_empty() {
                declaration.insert(
                    "description".to_string(),
                    Value::String(description.to_string()),
                );
            }
        }
        if let Some(parameters) = function.get("parameters").cloned() {
            declaration.insert("parameters".to_string(), parameters);
        }
        declarations.push(Value::Object(declaration));
    }
    if declarations.is_empty() {
        None
    } else {
        Some(json!([{ "functionDeclarations": declarations }]))
    }
}

fn upsert_gemini_generation_config(object: &mut Map<String, Value>) {
    let mut generation_config = object
        .get("generationConfig")
        .cloned()
        .or_else(|| object.get("generation_config").cloned())
        .unwrap_or_else(|| json!({}));
    let config = ensure_json_object(&mut generation_config);

    for (source, target) in [
        ("max_tokens", "maxOutputTokens"),
        ("max_completion_tokens", "maxOutputTokens"),
        ("max_output_tokens", "maxOutputTokens"),
        ("temperature", "temperature"),
        ("top_p", "topP"),
        ("top_k", "topK"),
    ] {
        if !config.contains_key(target) {
            if let Some(value) = object.get(source).cloned() {
                config.insert(target.to_string(), value);
            }
        }
    }
    if !config.contains_key("stopSequences") {
        if let Some(value) = object.get("stop").cloned() {
            config.insert("stopSequences".to_string(), value);
        } else if let Some(value) = object.get("stop_sequences").cloned() {
            config.insert("stopSequences".to_string(), value);
        }
    }
    if !config.contains_key("responseMimeType") {
        let wants_json = object
            .get("response_format")
            .and_then(Value::as_object)
            .and_then(|format| format.get("type"))
            .and_then(Value::as_str)
            .map(|value| value == "json_object")
            .unwrap_or(false);
        if wants_json {
            config.insert(
                "responseMimeType".to_string(),
                Value::String("application/json".to_string()),
            );
        }
    }
    if !config.is_empty() {
        object.insert("generationConfig".to_string(), generation_config);
    }
}

fn chat_to_gemini_body(value: Value) -> Value {
    let Value::Object(mut object) = value else {
        return value;
    };
    let mut system_parts = Vec::new();
    let mut contents = Vec::new();
    if let Some(Value::Array(messages)) = object.get("messages") {
        for message in messages {
            let Some(message_object) = message.as_object() else {
                continue;
            };
            let role = message_object
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("user")
                .trim();
            let text = message_object
                .get("content")
                .map(text_from_router_content)
                .unwrap_or_default();
            if role == "system" {
                if let Some(part) = gemini_part_from_text(text) {
                    system_parts.push(part);
                }
                continue;
            }
            if let Some(part) = gemini_part_from_text(text) {
                contents.push(json!({
                  "role": if role == "assistant" || role == "model" { "model" } else { "user" },
                  "parts": [part],
                }));
            }
        }
    }
    if !contents.is_empty() {
        object.insert("contents".to_string(), Value::Array(contents));
    }
    if !system_parts.is_empty() {
        object.insert(
            "systemInstruction".to_string(),
            json!({ "parts": system_parts }),
        );
    }
    if let Some(tools) = object.get("tools").and_then(openai_tools_to_gemini_tools) {
        object.insert("tools".to_string(), tools);
    }
    upsert_gemini_generation_config(&mut object);

    for key in [
        "messages",
        "model",
        "max_tokens",
        "max_completion_tokens",
        "max_output_tokens",
        "temperature",
        "top_p",
        "top_k",
        "stop",
        "stop_sequences",
        "response_format",
        "stream",
        "tool_choice",
    ] {
        object.remove(key);
    }
    Value::Object(object)
}

fn rectify_router_body(value: Value, source_protocol: &str, target_protocol: &str) -> Value {
    if source_protocol == target_protocol {
        return value;
    }
    match (source_protocol, target_protocol) {
        ("openai-responses", "openai-chat") => responses_to_chat_body(value),
        ("openai-chat", "openai-responses") => chat_to_responses_body(value),
        ("openai-chat", "anthropic") => chat_to_anthropic_body(value),
        ("anthropic", "openai-chat") => anthropic_to_chat_body(value),
        ("openai-responses", "anthropic") => chat_to_anthropic_body(responses_to_chat_body(value)),
        ("anthropic", "openai-responses") => chat_to_responses_body(anthropic_to_chat_body(value)),
        ("openai-chat", "gemini") => chat_to_gemini_body(value),
        ("openai-responses", "gemini") => chat_to_gemini_body(responses_to_chat_body(value)),
        ("anthropic", "gemini") => chat_to_gemini_body(anthropic_to_chat_body(value)),
        _ => value,
    }
}

fn can_rectify_router_protocol_pair(source_protocol: &str, target_protocol: &str) -> bool {
    source_protocol == target_protocol
        || matches!(
            (source_protocol, target_protocol),
            ("openai-responses", "openai-chat")
                | ("openai-chat", "openai-responses")
                | ("openai-chat", "anthropic")
                | ("anthropic", "openai-chat")
                | ("openai-responses", "anthropic")
                | ("anthropic", "openai-responses")
                | ("openai-chat", "gemini")
                | ("openai-responses", "gemini")
                | ("anthropic", "gemini")
        )
}

fn rectify_router_request(
    req: &LocalRequest,
    source_protocol: &str,
    target_protocol: &str,
) -> LocalRequest {
    let source_protocol = normalize_router_protocol(source_protocol);
    let target_protocol = normalize_router_protocol(target_protocol);
    if source_protocol.is_empty()
        || target_protocol.is_empty()
        || source_protocol == target_protocol
        || !can_rectify_router_protocol_pair(&source_protocol, &target_protocol)
        || req.body.is_empty()
    {
        return LocalRequest {
            method: req.method.clone(),
            target: req.target.clone(),
            headers: req.headers.clone(),
            body: req.body.clone(),
        };
    }
    let Ok(body_value) = serde_json::from_slice::<Value>(&req.body) else {
        return LocalRequest {
            method: req.method.clone(),
            target: req.target.clone(),
            headers: req.headers.clone(),
            body: req.body.clone(),
        };
    };
    let rectified = rectify_router_body(body_value.clone(), &source_protocol, &target_protocol);
    let target_after_rectify =
        replace_request_target_protocol_for_body(&req.target, &target_protocol, &body_value);
    let changed = rectified != body_value || target_after_rectify != req.target;
    if !changed {
        return LocalRequest {
            method: req.method.clone(),
            target: req.target.clone(),
            headers: req.headers.clone(),
            body: req.body.clone(),
        };
    }
    LocalRequest {
        method: req.method.clone(),
        target: target_after_rectify,
        headers: req.headers.clone(),
        body: serde_json::to_vec(&rectified).unwrap_or_else(|_| req.body.clone()),
    }
}

fn gemini_model_id_from_target(target: &str) -> String {
    let path = path_query_from_target(target);
    let Some((_, after_models)) = path.split_once("/models/") else {
        return "gemini".to_string();
    };
    let model = after_models
        .split_once(':')
        .map(|(model, _)| model)
        .unwrap_or(after_models)
        .trim();
    if model.is_empty() {
        "gemini".to_string()
    } else {
        model.to_string()
    }
}

fn gemini_finish_reason_for_openai(value: &str) -> &'static str {
    match value.trim().to_ascii_uppercase().as_str() {
        "MAX_TOKENS" => "length",
        "SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII" => "content_filter",
        _ => "stop",
    }
}

fn gemini_finish_reason_for_anthropic(value: &str) -> &'static str {
    match value.trim().to_ascii_uppercase().as_str() {
        "MAX_TOKENS" => "max_tokens",
        "STOP" => "end_turn",
        _ => "end_turn",
    }
}

fn gemini_candidate_parts(candidate: &Value) -> Vec<Value> {
    candidate
        .pointer("/content/parts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn gemini_text_from_parts(parts: &[Value]) -> String {
    parts
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .filter(|text| !text.trim().is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n")
}

fn gemini_function_calls_from_parts(parts: &[Value]) -> Vec<(String, Value)> {
    let mut calls = Vec::new();
    for part in parts {
        let Some(call) = part.get("functionCall").and_then(Value::as_object) else {
            continue;
        };
        let name = call
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if name.is_empty() {
            continue;
        }
        let args = call.get("args").cloned().unwrap_or_else(|| json!({}));
        calls.push((name.to_string(), args));
    }
    calls
}

fn gemini_usage_metadata(value: &Value) -> Option<&Map<String, Value>> {
    value.get("usageMetadata").and_then(Value::as_object)
}

fn gemini_usage_for_openai(value: &Value, responses_api: bool) -> Option<Value> {
    let usage = gemini_usage_metadata(value)?;
    let input_tokens = usage_u64(usage, "promptTokenCount");
    let output_tokens = usage_u64(usage, "candidatesTokenCount");
    let cached_tokens = usage_u64(usage, "cachedContentTokenCount");
    let total_tokens =
        usage_u64(usage, "totalTokenCount").max(input_tokens.saturating_add(output_tokens));
    if responses_api {
        let mut out = Map::new();
        out.insert("input_tokens".to_string(), json!(input_tokens));
        out.insert("output_tokens".to_string(), json!(output_tokens));
        out.insert("total_tokens".to_string(), json!(total_tokens));
        if cached_tokens > 0 {
            out.insert(
                "input_tokens_details".to_string(),
                json!({ "cached_tokens": cached_tokens }),
            );
        }
        Some(Value::Object(out))
    } else {
        let mut out = Map::new();
        out.insert("prompt_tokens".to_string(), json!(input_tokens));
        out.insert("completion_tokens".to_string(), json!(output_tokens));
        out.insert("total_tokens".to_string(), json!(total_tokens));
        if cached_tokens > 0 {
            out.insert(
                "prompt_tokens_details".to_string(),
                json!({ "cached_tokens": cached_tokens }),
            );
        }
        Some(Value::Object(out))
    }
}

fn gemini_usage_for_anthropic(value: &Value) -> Option<Value> {
    let usage = gemini_usage_metadata(value)?;
    let input_tokens = usage_u64(usage, "promptTokenCount");
    let output_tokens = usage_u64(usage, "candidatesTokenCount");
    let cached_tokens = usage_u64(usage, "cachedContentTokenCount");
    let mut out = Map::new();
    out.insert("input_tokens".to_string(), json!(input_tokens));
    out.insert("output_tokens".to_string(), json!(output_tokens));
    if cached_tokens > 0 {
        out.insert("cache_read_input_tokens".to_string(), json!(cached_tokens));
    }
    Some(Value::Object(out))
}

fn gemini_response_to_chat(value: Value, model: &str) -> Value {
    let candidates = value
        .get("candidates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let choices = candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| {
            let parts = gemini_candidate_parts(candidate);
            let text = gemini_text_from_parts(&parts);
            let function_calls = gemini_function_calls_from_parts(&parts);
            let mut message = Map::new();
            message.insert("role".to_string(), Value::String("assistant".to_string()));
            if text.trim().is_empty() && !function_calls.is_empty() {
                message.insert("content".to_string(), Value::Null);
            } else {
                message.insert("content".to_string(), Value::String(text));
            }
            if !function_calls.is_empty() {
                let tool_calls = function_calls
                    .iter()
                    .enumerate()
                    .map(|(call_index, (name, args))| {
                        json!({
                          "id": format!("call_{call_index}"),
                          "type": "function",
                          "function": {
                            "name": name,
                            "arguments": serde_json::to_string(args).unwrap_or_else(|_| "{}".to_string())
                          }
                        })
                    })
                    .collect::<Vec<_>>();
                message.insert("tool_calls".to_string(), Value::Array(tool_calls));
            }
            let finish_reason = candidate
                .get("finishReason")
                .and_then(Value::as_str)
                .map(gemini_finish_reason_for_openai)
                .unwrap_or("stop");
            json!({
              "index": index,
              "message": Value::Object(message),
              "finish_reason": finish_reason,
            })
        })
        .collect::<Vec<_>>();
    let mut out = Map::new();
    out.insert(
        "id".to_string(),
        Value::String(format!("chatcmpl-easyaiconfig-{}", now_epoch_ms())),
    );
    out.insert(
        "object".to_string(),
        Value::String("chat.completion".to_string()),
    );
    out.insert("created".to_string(), json!(chrono::Utc::now().timestamp()));
    out.insert("model".to_string(), Value::String(model.to_string()));
    out.insert("choices".to_string(), Value::Array(choices));
    if let Some(usage) = gemini_usage_for_openai(&value, false) {
        out.insert("usage".to_string(), usage);
    }
    Value::Object(out)
}

fn gemini_response_to_responses(value: Value, model: &str) -> Value {
    let candidates = value
        .get("candidates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut output = Vec::new();
    let mut output_text = Vec::new();
    for (index, candidate) in candidates.iter().enumerate() {
        let parts = gemini_candidate_parts(candidate);
        let text = gemini_text_from_parts(&parts);
        if !text.trim().is_empty() {
            output_text.push(text.clone());
            output.push(json!({
              "id": format!("msg_{index}"),
              "type": "message",
              "status": "completed",
              "role": "assistant",
              "content": [
                {
                  "type": "output_text",
                  "text": text,
                  "annotations": []
                }
              ]
            }));
        }
        for (call_index, (name, args)) in gemini_function_calls_from_parts(&parts)
            .into_iter()
            .enumerate()
        {
            output.push(json!({
              "id": format!("fc_{index}_{call_index}"),
              "type": "function_call",
              "call_id": format!("call_{index}_{call_index}"),
              "name": name,
              "arguments": serde_json::to_string(&args).unwrap_or_else(|_| "{}".to_string()),
              "status": "completed"
            }));
        }
    }
    let mut out = Map::new();
    out.insert(
        "id".to_string(),
        Value::String(format!("resp_easyaiconfig_{}", now_epoch_ms())),
    );
    out.insert("object".to_string(), Value::String("response".to_string()));
    out.insert(
        "created_at".to_string(),
        json!(chrono::Utc::now().timestamp()),
    );
    out.insert("status".to_string(), Value::String("completed".to_string()));
    out.insert("model".to_string(), Value::String(model.to_string()));
    out.insert("output".to_string(), Value::Array(output));
    out.insert(
        "output_text".to_string(),
        Value::String(output_text.join("\n")),
    );
    if let Some(usage) = gemini_usage_for_openai(&value, true) {
        out.insert("usage".to_string(), usage);
    }
    Value::Object(out)
}

fn gemini_response_to_anthropic(value: Value, model: &str) -> Value {
    let candidates = value
        .get("candidates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let first = candidates.first().cloned().unwrap_or_else(|| json!({}));
    let parts = gemini_candidate_parts(&first);
    let text = gemini_text_from_parts(&parts);
    let mut content = Vec::new();
    if !text.trim().is_empty() {
        content.push(json!({ "type": "text", "text": text }));
    }
    for (index, (name, args)) in gemini_function_calls_from_parts(&parts)
        .into_iter()
        .enumerate()
    {
        content.push(json!({
          "type": "tool_use",
          "id": format!("toolu_{index}"),
          "name": name,
          "input": args,
        }));
    }
    let finish_reason = first
        .get("finishReason")
        .and_then(Value::as_str)
        .map(gemini_finish_reason_for_anthropic)
        .unwrap_or("end_turn");
    let mut out = Map::new();
    out.insert(
        "id".to_string(),
        Value::String(format!("msg_easyaiconfig_{}", now_epoch_ms())),
    );
    out.insert("type".to_string(), Value::String("message".to_string()));
    out.insert("role".to_string(), Value::String("assistant".to_string()));
    out.insert("model".to_string(), Value::String(model.to_string()));
    out.insert("content".to_string(), Value::Array(content));
    out.insert(
        "stop_reason".to_string(),
        Value::String(finish_reason.to_string()),
    );
    out.insert("stop_sequence".to_string(), Value::Null);
    if let Some(usage) = gemini_usage_for_anthropic(&value) {
        out.insert("usage".to_string(), usage);
    }
    Value::Object(out)
}

fn gemini_error_message(value: &Value) -> String {
    value
        .pointer("/error/message")
        .or_else(|| value.get("message"))
        .or_else(|| value.get("error"))
        .map(text_from_router_content)
        .filter(|message| !message.trim().is_empty())
        .unwrap_or_else(|| "Gemini upstream request failed".to_string())
}

fn gemini_error_code(value: &Value, status_code: u16) -> String {
    value
        .pointer("/error/status")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            value
                .pointer("/error/code")
                .and_then(Value::as_i64)
                .map(|value| value.to_string())
        })
        .unwrap_or_else(|| status_code.to_string())
}

fn openai_error_type(status_code: u16) -> &'static str {
    match status_code {
        401 => "authentication_error",
        403 => "permission_error",
        404 => "not_found_error",
        408 | 409 | 425 | 429 => "rate_limit_error",
        500..=599 => "server_error",
        _ => "invalid_request_error",
    }
}

fn anthropic_error_type(status_code: u16) -> &'static str {
    match status_code {
        401 => "authentication_error",
        403 => "permission_error",
        404 => "not_found_error",
        408 | 409 | 425 | 429 => "rate_limit_error",
        529 => "overloaded_error",
        500..=599 => "api_error",
        _ => "invalid_request_error",
    }
}

fn rectify_gemini_error_body(value: Value, source_protocol: &str, status_code: u16) -> Value {
    let message = gemini_error_message(&value);
    let code = gemini_error_code(&value, status_code);
    match normalize_router_protocol(source_protocol).as_str() {
        "anthropic" => json!({
          "type": "error",
          "error": {
            "type": anthropic_error_type(status_code),
            "message": message,
          }
        }),
        "openai-chat" | "openai-responses" => json!({
          "error": {
            "message": message,
            "type": openai_error_type(status_code),
            "param": Value::Null,
            "code": code,
          }
        }),
        _ => value,
    }
}

fn rectify_router_response_body(
    value: Value,
    source_protocol: &str,
    target_protocol: &str,
    target: &str,
) -> Value {
    let source_protocol = normalize_router_protocol(source_protocol);
    let target_protocol = normalize_router_protocol(target_protocol);
    if source_protocol.is_empty()
        || target_protocol.is_empty()
        || source_protocol == target_protocol
    {
        return value;
    }
    if target_protocol == "gemini" {
        let model = gemini_model_id_from_target(target);
        return match source_protocol.as_str() {
            "openai-chat" => gemini_response_to_chat(value, &model),
            "openai-responses" => gemini_response_to_responses(value, &model),
            "anthropic" => gemini_response_to_anthropic(value, &model),
            _ => value,
        };
    }
    value
}

fn parse_sse_json_payloads(body: &[u8]) -> Vec<Value> {
    let text = String::from_utf8_lossy(body);
    let mut payloads = Vec::new();
    let mut data_lines = Vec::new();
    let flush_event = |data_lines: &mut Vec<String>, payloads: &mut Vec<Value>| {
        if data_lines.is_empty() {
            return;
        }
        let payload = data_lines.join("\n");
        data_lines.clear();
        let trimmed = payload.trim();
        if trimmed.is_empty() || trimmed == "[DONE]" {
            return;
        }
        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            payloads.push(value);
        }
    };
    for line in text.lines() {
        let trimmed = line.trim_end_matches('\r');
        if trimmed.is_empty() {
            flush_event(&mut data_lines, &mut payloads);
            continue;
        }
        if let Some(data) = trimmed.strip_prefix("data:") {
            data_lines.push(data.trim_start().to_string());
        }
    }
    flush_event(&mut data_lines, &mut payloads);
    payloads
}

fn push_sse_data(out: &mut String, value: Value) {
    if let Ok(text) = serde_json::to_string(&value) {
        out.push_str("data: ");
        out.push_str(&text);
        out.push_str("\n\n");
    }
}

fn push_named_sse_event(out: &mut String, event: &str, value: Value) {
    if let Ok(text) = serde_json::to_string(&value) {
        out.push_str("event: ");
        out.push_str(event);
        out.push('\n');
        out.push_str("data: ");
        out.push_str(&text);
        out.push_str("\n\n");
    }
}

fn gemini_stream_finish_reason(value: &Value) -> Option<&str> {
    value
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|candidate| candidate.get("finishReason"))
        .and_then(Value::as_str)
}

fn gemini_stream_usage_value(value: &Value) -> Option<Value> {
    value.get("usageMetadata").cloned()
}

fn gemini_stream_aggregate(events: &[Value]) -> Value {
    let mut parts = Vec::new();
    let mut finish_reason = String::new();
    let mut usage_metadata = None;
    for event in events {
        if usage_metadata.is_none() {
            usage_metadata = gemini_stream_usage_value(event);
        } else if let Some(usage) = gemini_stream_usage_value(event) {
            usage_metadata = Some(usage);
        }
        if let Some(reason) = gemini_stream_finish_reason(event) {
            if !reason.trim().is_empty() {
                finish_reason = reason.to_string();
            }
        }
        let candidates = event
            .get("candidates")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for candidate in candidates {
            parts.extend(gemini_candidate_parts(&candidate));
        }
    }
    let mut candidate = json!({ "content": { "parts": parts } });
    if !finish_reason.is_empty() {
        ensure_json_object(&mut candidate)
            .insert("finishReason".to_string(), Value::String(finish_reason));
    }
    let mut aggregate = json!({ "candidates": [candidate] });
    if let Some(usage) = usage_metadata {
        ensure_json_object(&mut aggregate).insert("usageMetadata".to_string(), usage);
    }
    aggregate
}

fn gemini_stream_to_chat_sse(events: &[Value], model: &str) -> String {
    let id = format!("chatcmpl-easyaiconfig-{}", now_epoch_ms());
    let created = chrono::Utc::now().timestamp();
    let mut out = String::new();
    let mut sent_role = false;
    for event in events {
        let candidates = event
            .get("candidates")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let usage = gemini_usage_for_openai(event, false);
        if candidates.is_empty() && usage.is_some() {
            push_sse_data(
                &mut out,
                json!({
                  "id": id,
                  "object": "chat.completion.chunk",
                  "created": created,
                  "model": model,
                  "choices": [],
                  "usage": usage,
                }),
            );
            continue;
        }
        for (index, candidate) in candidates.iter().enumerate() {
            let parts = gemini_candidate_parts(candidate);
            let text = gemini_text_from_parts(&parts);
            let function_calls = gemini_function_calls_from_parts(&parts);
            let mut delta = Map::new();
            if !sent_role {
                delta.insert("role".to_string(), Value::String("assistant".to_string()));
                sent_role = true;
            }
            if !text.trim().is_empty() {
                delta.insert("content".to_string(), Value::String(text));
            }
            if !function_calls.is_empty() {
                let tool_calls = function_calls
                    .iter()
                    .enumerate()
                    .map(|(call_index, (name, args))| {
                        json!({
                          "index": call_index,
                          "id": format!("call_{call_index}"),
                          "type": "function",
                          "function": {
                            "name": name,
                            "arguments": serde_json::to_string(args).unwrap_or_else(|_| "{}".to_string())
                          }
                        })
                    })
                    .collect::<Vec<_>>();
                delta.insert("tool_calls".to_string(), Value::Array(tool_calls));
            }
            let finish_reason = candidate
                .get("finishReason")
                .and_then(Value::as_str)
                .map(gemini_finish_reason_for_openai);
            if delta.is_empty() && finish_reason.is_none() && usage.is_none() {
                continue;
            }
            let mut chunk = Map::new();
            chunk.insert("id".to_string(), Value::String(id.clone()));
            chunk.insert(
                "object".to_string(),
                Value::String("chat.completion.chunk".to_string()),
            );
            chunk.insert("created".to_string(), json!(created));
            chunk.insert("model".to_string(), Value::String(model.to_string()));
            chunk.insert(
                "choices".to_string(),
                json!([{
                  "index": index,
                  "delta": Value::Object(delta),
                  "finish_reason": finish_reason,
                }]),
            );
            if let Some(usage) = usage.clone() {
                chunk.insert("usage".to_string(), usage);
            }
            push_sse_data(&mut out, Value::Object(chunk));
        }
    }
    out.push_str("data: [DONE]\n\n");
    out
}

fn gemini_stream_to_responses_sse(events: &[Value], model: &str) -> String {
    let mut out = String::new();
    for event in events {
        let candidates = event
            .get("candidates")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for (index, candidate) in candidates.iter().enumerate() {
            let parts = gemini_candidate_parts(candidate);
            let text = gemini_text_from_parts(&parts);
            if !text.trim().is_empty() {
                push_named_sse_event(
                    &mut out,
                    "response.output_text.delta",
                    json!({
                      "type": "response.output_text.delta",
                      "item_id": format!("msg_{index}"),
                      "output_index": index,
                      "content_index": 0,
                      "delta": text,
                    }),
                );
            }
            for (call_index, (name, args)) in gemini_function_calls_from_parts(&parts)
                .into_iter()
                .enumerate()
            {
                push_named_sse_event(
                    &mut out,
                    "response.output_item.done",
                    json!({
                      "type": "response.output_item.done",
                      "output_index": index,
                      "item": {
                        "id": format!("fc_{index}_{call_index}"),
                        "type": "function_call",
                        "call_id": format!("call_{index}_{call_index}"),
                        "name": name,
                        "arguments": serde_json::to_string(&args).unwrap_or_else(|_| "{}".to_string()),
                        "status": "completed"
                      }
                    }),
                );
            }
        }
    }
    let completed = gemini_response_to_responses(gemini_stream_aggregate(events), model);
    push_named_sse_event(
        &mut out,
        "response.completed",
        json!({
          "type": "response.completed",
          "response": completed,
        }),
    );
    out
}

fn gemini_stream_to_anthropic_sse(events: &[Value], model: &str) -> String {
    let mut out = String::new();
    let aggregate = gemini_stream_aggregate(events);
    let usage = gemini_usage_for_anthropic(&aggregate).unwrap_or_else(|| json!({}));
    push_named_sse_event(
        &mut out,
        "message_start",
        json!({
          "type": "message_start",
          "message": {
            "id": format!("msg_easyaiconfig_{}", now_epoch_ms()),
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": [],
            "stop_reason": null,
            "stop_sequence": null,
            "usage": usage,
          }
        }),
    );

    let mut text_started = false;
    let mut text_index = 0_usize;
    let mut next_block_index = 0_usize;
    for event in events {
        let candidates = event
            .get("candidates")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for candidate in candidates {
            let parts = gemini_candidate_parts(&candidate);
            let text = gemini_text_from_parts(&parts);
            if !text.trim().is_empty() {
                if !text_started {
                    text_index = next_block_index;
                    next_block_index += 1;
                    text_started = true;
                    push_named_sse_event(
                        &mut out,
                        "content_block_start",
                        json!({
                          "type": "content_block_start",
                          "index": text_index,
                          "content_block": { "type": "text", "text": "" }
                        }),
                    );
                }
                push_named_sse_event(
                    &mut out,
                    "content_block_delta",
                    json!({
                      "type": "content_block_delta",
                      "index": text_index,
                      "delta": { "type": "text_delta", "text": text }
                    }),
                );
            }
            for (name, args) in gemini_function_calls_from_parts(&parts) {
                let index = next_block_index;
                next_block_index += 1;
                let tool_id = format!("toolu_{index}");
                push_named_sse_event(
                    &mut out,
                    "content_block_start",
                    json!({
                      "type": "content_block_start",
                      "index": index,
                      "content_block": {
                        "type": "tool_use",
                        "id": tool_id,
                        "name": name,
                        "input": {}
                      }
                    }),
                );
                push_named_sse_event(
                    &mut out,
                    "content_block_delta",
                    json!({
                      "type": "content_block_delta",
                      "index": index,
                      "delta": {
                        "type": "input_json_delta",
                        "partial_json": serde_json::to_string(&args).unwrap_or_else(|_| "{}".to_string())
                      }
                    }),
                );
                push_named_sse_event(
                    &mut out,
                    "content_block_stop",
                    json!({ "type": "content_block_stop", "index": index }),
                );
            }
        }
    }
    if text_started {
        push_named_sse_event(
            &mut out,
            "content_block_stop",
            json!({ "type": "content_block_stop", "index": text_index }),
        );
    }
    let stop_reason = aggregate
        .pointer("/candidates/0/finishReason")
        .and_then(Value::as_str)
        .map(gemini_finish_reason_for_anthropic)
        .unwrap_or("end_turn");
    push_named_sse_event(
        &mut out,
        "message_delta",
        json!({
          "type": "message_delta",
          "delta": { "stop_reason": stop_reason, "stop_sequence": null },
          "usage": usage,
        }),
    );
    push_named_sse_event(&mut out, "message_stop", json!({ "type": "message_stop" }));
    out
}

fn rectify_router_stream_response_body(
    body: &[u8],
    source_protocol: &str,
    target_protocol: &str,
    target: &str,
) -> Option<Vec<u8>> {
    let source_protocol = normalize_router_protocol(source_protocol);
    let target_protocol = normalize_router_protocol(target_protocol);
    if source_protocol.is_empty()
        || target_protocol.is_empty()
        || source_protocol == target_protocol
        || target_protocol != "gemini"
    {
        return None;
    }
    let events = parse_sse_json_payloads(body);
    if events.is_empty() {
        return None;
    }
    let model = gemini_model_id_from_target(target);
    let out = match source_protocol.as_str() {
        "openai-chat" => gemini_stream_to_chat_sse(&events, &model),
        "openai-responses" => gemini_stream_to_responses_sse(&events, &model),
        "anthropic" => gemini_stream_to_anthropic_sse(&events, &model),
        _ => return None,
    };
    Some(out.into_bytes())
}

fn upsert_proxy_response_header(headers: &mut Vec<(String, String)>, name: &str, value: &str) {
    if let Some((_, existing)) = headers
        .iter_mut()
        .find(|(header_name, _)| header_name.eq_ignore_ascii_case(name))
    {
        *existing = value.to_string();
    } else {
        headers.push((name.to_string(), value.to_string()));
    }
}

fn rectify_router_response(
    mut response: ProxyResponse,
    source_protocol: &str,
    target_protocol: &str,
    target: &str,
) -> ProxyResponse {
    if response.status_code >= 400 && !response.body.is_empty() {
        let source_protocol = normalize_router_protocol(source_protocol);
        let target_protocol = normalize_router_protocol(target_protocol);
        if target_protocol == "gemini" && source_protocol != target_protocol {
            if let Ok(value) = serde_json::from_slice::<Value>(&response.body) {
                let rectified = rectify_gemini_error_body(
                    value.clone(),
                    &source_protocol,
                    response.status_code,
                );
                if rectified != value {
                    if let Ok(body) = serde_json::to_vec(&rectified) {
                        response.body = body;
                        upsert_proxy_response_header(
                            &mut response.headers,
                            "content-type",
                            "application/json; charset=utf-8",
                        );
                    }
                }
            }
        }
        return response;
    }
    if response.body.is_empty() {
        return response;
    }
    if let Some(body) = rectify_router_stream_response_body(
        &response.body,
        source_protocol,
        target_protocol,
        target,
    ) {
        response.body = body;
        upsert_proxy_response_header(
            &mut response.headers,
            "content-type",
            "text/event-stream; charset=utf-8",
        );
        return response;
    }
    let Ok(value) = serde_json::from_slice::<Value>(&response.body) else {
        return response;
    };
    let rectified =
        rectify_router_response_body(value.clone(), source_protocol, target_protocol, target);
    if rectified == value {
        return response;
    }
    if let Ok(body) = serde_json::to_vec(&rectified) {
        response.body = body;
        upsert_proxy_response_header(
            &mut response.headers,
            "content-type",
            "application/json; charset=utf-8",
        );
    }
    response
}

fn preview_response_rectifier_string(input: &Value, keys: &[&str], fallback: &str) -> String {
    keys.iter()
        .find_map(|key| input.get(*key).and_then(Value::as_str))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn preview_response_rectifier_status(response: &Value) -> u16 {
    response
        .get("status")
        .or_else(|| response.get("statusCode"))
        .and_then(|value| {
            value.as_u64().or_else(|| {
                value
                    .as_str()
                    .and_then(|text| text.trim().parse::<u64>().ok())
            })
        })
        .map(|value| value.clamp(100, 599) as u16)
        .unwrap_or(200)
}

pub(crate) fn preview_router_response_rectifier(input: &Value) -> Result<Value, String> {
    let source_protocol = normalize_router_protocol(&preview_response_rectifier_string(
        input,
        &["sourceProtocol", "from", "clientProtocol", "protocol"],
        "openai-chat",
    ));
    let target_protocol = normalize_router_protocol(&preview_response_rectifier_string(
        input,
        &["targetProtocol", "to", "upstreamProtocol", "target"],
        "openai-chat",
    ));
    let response = input
        .get("response")
        .filter(|value| value.is_object())
        .unwrap_or(input);
    let path = response
        .get("path")
        .or_else(|| response.get("url"))
        .or_else(|| input.get("path"))
        .or_else(|| input.get("url"))
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    let status = preview_response_rectifier_status(response);
    let body = response
        .get("body")
        .cloned()
        .unwrap_or_else(|| response.clone());
    let original_body = body.clone();
    let mut changes = Vec::<Value>::new();
    let mut warnings = Vec::<Value>::new();

    let rectified_body = if source_protocol == target_protocol {
        body
    } else if status >= 400 && target_protocol == "gemini" {
        let converted = rectify_gemini_error_body(body, &source_protocol, status);
        if converted != original_body {
            changes.push(Value::String(
                "Converted Gemini error response to caller protocol error format.".to_string(),
            ));
        }
        converted
    } else if let Some(text) = body.as_str() {
        if target_protocol == "gemini" {
            if let Some(converted) = rectify_router_stream_response_body(
                text.as_bytes(),
                &source_protocol,
                &target_protocol,
                &path,
            ) {
                changes.push(Value::String(
                    "Converted Gemini streamGenerateContent SSE to caller protocol SSE."
                        .to_string(),
                ));
                Value::String(String::from_utf8_lossy(&converted).to_string())
            } else {
                Value::String(text.to_string())
            }
        } else {
            Value::String(text.to_string())
        }
    } else {
        let converted =
            rectify_router_response_body(body, &source_protocol, &target_protocol, &path);
        if converted != original_body {
            changes.push(Value::String(
                "Converted Gemini GenerateContent response to caller protocol response."
                    .to_string(),
            ));
        }
        converted
    };

    let changed = rectified_body != original_body;
    if !changed && source_protocol != target_protocol {
        warnings.push(Value::String(format!(
            "No automatic response rectifier exists for {} -> {}; response body left unchanged.",
            target_protocol, source_protocol
        )));
    }

    Ok(json!({
      "schema": "easyaiconfig.response-rectifier-preview.v1",
      "sourceProtocol": source_protocol,
      "targetProtocol": target_protocol,
      "changed": changed,
      "changes": changes,
      "warnings": warnings,
      "response": {
        "status": status,
        "path": path,
        "body": rectified_body,
      }
    }))
}

fn should_forward_header(name: &str) -> bool {
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "host"
            | "accept-encoding"
            | "content-length"
            | "connection"
            | "authorization"
            | "x-api-key"
            | "proxy-authorization"
            | "keep-alive"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn router_header_value<'a>(req: &'a LocalRequest, expected_name: &str) -> Option<&'a str> {
    req.headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(expected_name))
        .map(|(_, value)| value.trim())
}

fn router_client_authorized(req: &LocalRequest) -> bool {
    if router_header_value(req, "x-api-key")
        .map(|value| value == ROUTER_CLIENT_PROVIDER_KEY)
        .unwrap_or(false)
    {
        return true;
    }
    if router_header_value(req, "api-key")
        .map(|value| value == ROUTER_CLIENT_PROVIDER_KEY)
        .unwrap_or(false)
    {
        return true;
    }
    let Some(auth) = router_header_value(req, "authorization") else {
        return false;
    };
    let Some((scheme, token)) = auth.split_once(' ') else {
        return false;
    };
    scheme.eq_ignore_ascii_case("bearer") && token.trim() == ROUTER_CLIENT_PROVIDER_KEY
}

fn is_retry_status(status_code: u16) -> bool {
    status_code == 408
        || status_code == 409
        || status_code == 425
        || status_code == 429
        || status_code >= 500
}

fn effective_provider_circuit_state(item: &ProviderStats) -> &str {
    match item.circuit_state.as_str() {
        "open" => "open",
        "half-open" => "half-open",
        _ => "closed",
    }
}

fn provider_circuit_window_requests(item: &ProviderStats) -> usize {
    item.circuit_window.len()
}

fn provider_circuit_window_failures(item: &ProviderStats) -> usize {
    item.circuit_window
        .iter()
        .filter(|success| !**success)
        .count()
}

fn provider_circuit_error_rate(item: &ProviderStats) -> f64 {
    let requests = provider_circuit_window_requests(item);
    if requests == 0 {
        0.0
    } else {
        provider_circuit_window_failures(item) as f64 / requests as f64
    }
}

fn close_provider_circuit(item: &mut ProviderStats) {
    item.circuit_state = "closed".to_string();
    item.circuit_opened_at_ms = 0;
    item.circuit_open_until_ms = 0;
    item.circuit_consecutive_failures = 0;
    item.circuit_consecutive_successes = 0;
    item.circuit_window.clear();
}

fn half_open_provider_circuit(item: &mut ProviderStats, now_ms: i64) {
    item.circuit_state = "half-open".to_string();
    item.circuit_opened_at_ms = 0;
    item.circuit_open_until_ms = 0;
    item.circuit_consecutive_successes = 0;
    item.last_error = if item.last_error.trim().is_empty() {
        format!("circuit half-open at {now_ms}")
    } else {
        item.last_error.clone()
    };
}

fn open_provider_circuit(
    config: &RouterConfig,
    item: &mut ProviderStats,
    now_ms: i64,
    reason: &str,
) {
    let recovery_wait_ms = config.circuit_recovery_wait_ms.min(i64::MAX as u64) as i64;
    item.circuit_state = "open".to_string();
    item.circuit_opened_at_ms = now_ms;
    item.circuit_open_until_ms = now_ms.saturating_add(recovery_wait_ms);
    item.circuit_consecutive_successes = 0;
    if !reason.trim().is_empty() {
        item.last_error = reason.to_string();
    }
}

fn refresh_provider_circuit(config: &RouterConfig, item: &mut ProviderStats, now_ms: i64) {
    if !config.circuit_breaker_enabled {
        return;
    }
    match effective_provider_circuit_state(item) {
        "open" if item.circuit_open_until_ms > 0 && item.circuit_open_until_ms <= now_ms => {
            half_open_provider_circuit(item, now_ms);
        }
        "open" => {}
        "half-open" => {}
        _ => {
            item.circuit_state = "closed".to_string();
            item.circuit_opened_at_ms = 0;
            item.circuit_open_until_ms = 0;
        }
    }
}

fn update_provider_circuit_after_attempt(
    config: &RouterConfig,
    item: &mut ProviderStats,
    status_code: u16,
    success: bool,
    error: &str,
    now_ms: i64,
) {
    if !config.circuit_breaker_enabled {
        return;
    }
    refresh_provider_circuit(config, item, now_ms);
    item.circuit_window.push_back(success);
    while item.circuit_window.len() > CIRCUIT_WINDOW_LIMIT {
        item.circuit_window.pop_front();
    }

    if success {
        item.circuit_consecutive_failures = 0;
        item.circuit_consecutive_successes += 1;
        if effective_provider_circuit_state(item) == "half-open"
            && item.circuit_consecutive_successes >= config.circuit_success_threshold.max(1)
        {
            close_provider_circuit(item);
        }
        return;
    }

    item.circuit_consecutive_failures += 1;
    item.circuit_consecutive_successes = 0;
    let status_reason = if status_code == 0 {
        if error.trim().is_empty() {
            "network failure".to_string()
        } else {
            error.to_string()
        }
    } else if error.trim().is_empty() {
        format!("HTTP {status_code}")
    } else {
        format!("HTTP {status_code}: {error}")
    };
    if effective_provider_circuit_state(item) == "half-open" {
        open_provider_circuit(
            config,
            item,
            now_ms,
            &format!("half-open probe failed: {status_reason}"),
        );
        return;
    }
    if item.circuit_consecutive_failures >= config.circuit_failure_threshold.max(1) {
        open_provider_circuit(
            config,
            item,
            now_ms,
            &format!("failure threshold reached: {status_reason}"),
        );
        return;
    }
    let window_requests = provider_circuit_window_requests(item) as u64;
    if window_requests >= config.circuit_min_requests.max(1)
        && provider_circuit_error_rate(item) >= config.circuit_error_rate_threshold
    {
        open_provider_circuit(
            config,
            item,
            now_ms,
            &format!("error-rate threshold reached: {status_reason}"),
        );
    }
}

fn provider_balance_percent(target: &RouterProviderConfig) -> Option<f64> {
    if let Some(percent) = target.balance_percent {
        return Some(clamp_f64(percent, 0.0, 100.0));
    }
    let remaining = target.balance_remaining?;
    let total = target.balance_total?;
    if total > 0.0 {
        Some(clamp_f64((remaining / total) * 100.0, 0.0, 100.0))
    } else {
        None
    }
}

fn provider_balance_score(target: &RouterProviderConfig) -> f64 {
    if let Some(percent) = provider_balance_percent(target) {
        return percent;
    }
    if let Some(remaining) = target.balance_remaining {
        return remaining;
    }
    if target.balance_status == "ok" {
        return -0.5;
    }
    -1.0
}

fn provider_balance_known(target: &RouterProviderConfig) -> bool {
    target.balance_status == "ok"
        && (provider_balance_percent(target).is_some() || target.balance_remaining.is_some())
}

fn provider_low_balance(config: &RouterConfig, target: &RouterProviderConfig) -> bool {
    if !config.balance_guard_enabled {
        return false;
    }
    if config.balance_min_percent > 0.0 {
        if let Some(percent) = provider_balance_percent(target) {
            if percent < config.balance_min_percent {
                return true;
            }
        }
    }
    if config.balance_min_amount > 0.0 {
        if let Some(remaining) = target.balance_remaining {
            if remaining < config.balance_min_amount {
                return true;
            }
        }
    }
    false
}

fn balance_guarded_provider_pool(config: &RouterConfig) -> Vec<RouterProviderConfig> {
    if config.providers.is_empty() {
        return Vec::new();
    }
    if !config.balance_guard_enabled {
        return config.providers.clone();
    }
    let filtered = config
        .providers
        .iter()
        .filter(|target| !provider_low_balance(config, target))
        .cloned()
        .collect::<Vec<_>>();
    if filtered.is_empty() {
        config.providers.clone()
    } else {
        filtered
    }
}

fn circuit_guarded_provider_pool(
    config: &RouterConfig,
    stats: &Arc<Mutex<RouterStats>>,
    providers: Vec<RouterProviderConfig>,
) -> Vec<RouterProviderConfig> {
    if providers.is_empty() || !config.circuit_breaker_enabled {
        return providers;
    }
    let now_ms = now_epoch_ms();
    let mut guard = stats
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    providers
        .into_iter()
        .filter(|target| {
            let route_key = provider_route_key(target);
            let item = guard.providers.entry(route_key).or_default();
            refresh_provider_circuit(config, item, now_ms);
            effective_provider_circuit_state(item) != "open"
        })
        .collect()
}

fn next_router_index(stats: &Arc<Mutex<RouterStats>>, modulo: usize) -> usize {
    if modulo <= 1 {
        return 0;
    }
    let mut guard = stats
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let start = guard.next_index % modulo;
    guard.next_index = (guard.next_index + 1) % modulo;
    start
}

fn rotate_provider_order(
    providers: Vec<RouterProviderConfig>,
    start: usize,
) -> Vec<RouterProviderConfig> {
    if providers.len() <= 1 {
        return providers;
    }
    (0..providers.len())
        .map(|offset| providers[(start + offset) % providers.len()].clone())
        .collect()
}

fn round_robin_provider_order(
    providers: Vec<RouterProviderConfig>,
    stats: &Arc<Mutex<RouterStats>>,
) -> Vec<RouterProviderConfig> {
    let start = next_router_index(stats, providers.len());
    rotate_provider_order(providers, start)
}

fn weighted_provider_order(
    providers: Vec<RouterProviderConfig>,
    stats: &Arc<Mutex<RouterStats>>,
) -> Vec<RouterProviderConfig> {
    if providers.len() <= 1 {
        return providers;
    }
    let total_weight = providers
        .iter()
        .map(|target| target.weight.max(1).min(100) as usize)
        .sum::<usize>()
        .max(providers.len());
    let ticket = next_router_index(stats, total_weight);
    let mut cursor = 0_usize;
    let mut start = 0_usize;
    for (index, target) in providers.iter().enumerate() {
        cursor += target.weight.max(1).min(100) as usize;
        if ticket < cursor {
            start = index;
            break;
        }
    }
    rotate_provider_order(providers, start)
}

fn balance_provider_order(
    providers: Vec<RouterProviderConfig>,
    stats: &Arc<Mutex<RouterStats>>,
) -> Vec<RouterProviderConfig> {
    if providers.len() <= 1 {
        return providers;
    }
    let len = providers.len();
    let start = next_router_index(stats, len);
    let mut items = providers.into_iter().enumerate().collect::<Vec<_>>();
    items.sort_by(|(index_a, provider_a), (index_b, provider_b)| {
        let known_a = provider_balance_known(provider_a);
        let known_b = provider_balance_known(provider_b);
        if known_a != known_b {
            return known_b.cmp(&known_a);
        }
        let score_a = provider_balance_score(provider_a);
        let score_b = provider_balance_score(provider_b);
        let score_order = score_b
            .partial_cmp(&score_a)
            .unwrap_or(std::cmp::Ordering::Equal);
        if score_order != std::cmp::Ordering::Equal {
            return score_order;
        }
        let rotated_a = (index_a + len - start) % len;
        let rotated_b = (index_b + len - start) % len;
        rotated_a.cmp(&rotated_b)
    });
    items.into_iter().map(|(_, provider)| provider).collect()
}

fn select_provider_order(
    config: &RouterConfig,
    stats: &Arc<Mutex<RouterStats>>,
) -> Vec<RouterProviderConfig> {
    let providers =
        circuit_guarded_provider_pool(config, stats, balance_guarded_provider_pool(config));
    if providers.is_empty() {
        return Vec::new();
    }
    match config.route_strategy.as_str() {
        "priority" => providers,
        "round_robin" => round_robin_provider_order(providers, stats),
        "weighted" | "auto" => weighted_provider_order(providers, stats),
        "balance" => balance_provider_order(providers, stats),
        _ => weighted_provider_order(providers, stats),
    }
}

fn record_provider_attempt(
    config: &RouterConfig,
    stats: &Arc<Mutex<RouterStats>>,
    provider_key: &str,
    status_code: u16,
    success: bool,
    error: &str,
) {
    let now_ms = now_epoch_ms();
    let mut guard = stats
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let item = guard.providers.entry(provider_key.to_string()).or_default();
    item.requests += 1;
    item.last_status = status_code;
    item.last_error = error.to_string();
    if success {
        item.successes += 1;
    } else {
        item.failures += 1;
    }
    update_provider_circuit_after_attempt(config, item, status_code, success, error, now_ms);
    guard.last_provider = provider_key.to_string();
    guard.last_status = status_code;
    guard.last_error = error.to_string();
}

fn truncate_log_text(value: &str, max_chars: usize) -> String {
    let mut out = value.trim().chars().take(max_chars).collect::<String>();
    if value.trim().chars().count() > max_chars {
        out.push('…');
    }
    out
}

fn usage_u64(object: &Map<String, Value>, key: &str) -> u64 {
    object
        .get(key)
        .and_then(|value| match value {
            Value::Number(number) => number.as_u64(),
            Value::String(text) => text.trim().parse::<u64>().ok(),
            _ => None,
        })
        .unwrap_or(0)
}

fn usage_nested_u64(object: &Map<String, Value>, object_key: &str, value_key: &str) -> u64 {
    object
        .get(object_key)
        .and_then(Value::as_object)
        .map(|nested| usage_u64(nested, value_key))
        .unwrap_or(0)
}

fn looks_like_usage_object(object: &Map<String, Value>) -> bool {
    [
        "input_tokens",
        "prompt_tokens",
        "promptTokenCount",
        "output_tokens",
        "completion_tokens",
        "candidatesTokenCount",
        "total_tokens",
        "totalTokenCount",
        "cached_input_tokens",
        "cached_tokens",
        "cachedContentTokenCount",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    ]
    .iter()
    .any(|key| object.contains_key(*key))
}

fn usage_summary_from_object(object: &Map<String, Value>) -> RouterUsageSummary {
    let input_tokens = usage_u64(object, "input_tokens")
        .max(usage_u64(object, "prompt_tokens"))
        .max(usage_u64(object, "promptTokenCount"))
        .max(usage_u64(object, "input"))
        .max(usage_u64(object, "prompt"));
    let output_tokens = usage_u64(object, "output_tokens")
        .max(usage_u64(object, "completion_tokens"))
        .max(usage_u64(object, "candidatesTokenCount"))
        .max(usage_u64(object, "output"))
        .max(usage_u64(object, "completion"));
    let anthropic_cached = usage_u64(object, "cache_read_input_tokens")
        .saturating_add(usage_u64(object, "cache_creation_input_tokens"));
    let cached_input_tokens = usage_u64(object, "cached_input_tokens")
        .max(usage_u64(object, "cached_tokens"))
        .max(usage_u64(object, "cachedContentTokenCount"))
        .max(usage_u64(object, "prompt_cache_hit_tokens"))
        .max(anthropic_cached)
        .max(usage_nested_u64(
            object,
            "input_tokens_details",
            "cached_tokens",
        ))
        .max(usage_nested_u64(
            object,
            "prompt_tokens_details",
            "cached_tokens",
        ));
    let explicit_total = usage_u64(object, "total_tokens")
        .max(usage_u64(object, "totalTokenCount"))
        .max(usage_u64(object, "total"));
    let total_tokens = if explicit_total > 0 {
        explicit_total
    } else {
        input_tokens.saturating_add(output_tokens)
    };
    RouterUsageSummary {
        input_tokens,
        output_tokens,
        cached_input_tokens,
        total_tokens,
    }
}

fn usage_summary_from_value(value: &Value) -> Option<RouterUsageSummary> {
    if let Some(items) = value.as_array() {
        for item in items {
            if let Some(summary) = usage_summary_from_value(item) {
                return Some(summary);
            }
        }
        return None;
    }
    let object = value.as_object()?;
    if let Some(usage) = object.get("usage").and_then(Value::as_object) {
        let summary = usage_summary_from_object(usage);
        if summary.has_any() {
            return Some(summary);
        }
    }
    if looks_like_usage_object(object) {
        let summary = usage_summary_from_object(object);
        if summary.has_any() {
            return Some(summary);
        }
    }
    for nested in object.values() {
        if let Some(summary) = usage_summary_from_value(nested) {
            return Some(summary);
        }
    }
    None
}

fn extract_router_usage_summary(body: &[u8]) -> RouterUsageSummary {
    if body.is_empty() {
        return RouterUsageSummary::default();
    }
    if let Ok(value) = serde_json::from_slice::<Value>(body) {
        if let Some(summary) = usage_summary_from_value(&value) {
            return summary;
        }
    }

    let text = String::from_utf8_lossy(body);
    let mut last = RouterUsageSummary::default();
    for line in text.lines() {
        let trimmed = line.trim();
        let payload = trimmed
            .strip_prefix("data:")
            .map(str::trim)
            .unwrap_or(trimmed);
        if payload.is_empty() || payload == "[DONE]" || !payload.starts_with('{') {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(payload) else {
            continue;
        };
        if let Some(summary) = usage_summary_from_value(&value) {
            if summary.has_any() {
                last = summary;
            }
        }
    }
    last
}

fn router_transform_meta_from(
    source_protocol: &str,
    target_protocol: &str,
    original_request: &LocalRequest,
    rectified_request: &LocalRequest,
    raw_status_code: u16,
    raw_headers: &[(String, String)],
    raw_body: &[u8],
    final_response: &ProxyResponse,
) -> RouterTransformMeta {
    let source_protocol = normalize_router_protocol(source_protocol);
    let target_protocol = normalize_router_protocol(target_protocol);
    let request_converted = original_request.target != rectified_request.target
        || original_request.headers != rectified_request.headers
        || original_request.body != rectified_request.body;
    let response_converted = raw_status_code != final_response.status_code
        || raw_headers != final_response.headers.as_slice()
        || raw_body != final_response.body.as_slice();
    let error_normalized = raw_status_code >= 400
        && response_converted
        && target_protocol == "gemini"
        && source_protocol != target_protocol;
    RouterTransformMeta {
        source_protocol,
        target_protocol,
        request_converted,
        response_converted,
        error_normalized,
    }
}

fn push_router_log(
    stats: &Arc<Mutex<RouterStats>>,
    tool: &str,
    method: &str,
    target: &str,
    provider_key: &str,
    status_code: u16,
    success: bool,
    retry: bool,
    latency_ms: u64,
    request_bytes: u64,
    response_bytes: u64,
    usage: RouterUsageSummary,
    transform: &RouterTransformMeta,
    error: &str,
) {
    let now = chrono::Utc::now();
    let entry = RouterLogEntry {
        at_ms: now.timestamp_millis(),
        at: now.to_rfc3339(),
        tool: normalize_router_tool(tool),
        method: method.to_ascii_uppercase(),
        target: truncate_log_text(&path_query_from_target(target), 220),
        provider_key: provider_key.to_string(),
        status_code,
        success,
        retry,
        latency_ms,
        request_bytes,
        response_bytes,
        cached_input_tokens: usage.cached_input_tokens,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens: usage.total_tokens,
        source_protocol: transform.source_protocol.clone(),
        target_protocol: transform.target_protocol.clone(),
        request_converted: transform.request_converted,
        response_converted: transform.response_converted,
        error_normalized: transform.error_normalized,
        error: truncate_log_text(error, 500),
    };
    let _ = persist_router_log(&entry);
    let mut guard = stats
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.logs.push_back(entry);
    while guard.logs.len() > 120 {
        guard.logs.pop_front();
    }
}

fn finalize_request_stats(stats: &Arc<Mutex<RouterStats>>, success: bool) {
    let mut guard = stats
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.requests += 1;
    if success {
        guard.forwarded += 1;
        guard.proxy_ready = true;
    } else {
        guard.failed += 1;
    }
}

fn provider_secret_body(config: &RouterConfig, provider_key: &str) -> Value {
    json!({
      "scope": config.scope,
      "projectPath": config.project_path,
      "codexHome": config.codex_home,
      "providerKey": provider_key,
    })
}

fn forward_once(
    config: &RouterConfig,
    req: &LocalRequest,
    target: &RouterProviderConfig,
) -> Result<ForwardOutcome, String> {
    let tool = normalize_router_tool(&target.tool);
    let (base_url_value, api_key_value, auth_token_value, target_protocol_value) =
        if is_anthropic_router_tool(&tool) {
            let base_url = if target.base_url.trim().is_empty() {
                "https://api.anthropic.com".to_string()
            } else {
                target.base_url.trim().to_string()
            };
            (
                base_url,
                target.api_key.trim().to_string(),
                target.auth_token.trim().to_string(),
                router_protocol_or_default(&target.protocol, &tool),
            )
        } else {
            let secret = get_provider_secret(&provider_secret_body(config, &target.key))?;
            let secret_protocol = secret
                .get("protocol")
                .or_else(|| secret.get("wireApi"))
                .or_else(|| secret.get("wire_api"))
                .or_else(|| secret.get("api"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            (
                secret
                    .get("baseUrl")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
                secret
                    .get("apiKey")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
                String::new(),
                if target.protocol.trim().is_empty() {
                    router_protocol_or_default(secret_protocol, &tool)
                } else {
                    router_protocol_or_default(&target.protocol, &tool)
                },
            )
        };
    let base_url = base_url_value.trim();
    let api_key = api_key_value.trim();
    let auth_token = auth_token_value.trim();
    let target_protocol = router_protocol_or_default(&target_protocol_value, &tool);
    if base_url.is_empty() || (api_key.is_empty() && auth_token.is_empty()) {
        return Err("provider missing baseUrl or API key".to_string());
    }

    let source_protocol = infer_router_protocol_from_target(
        &req.target,
        default_router_protocol_for_tool(&config.tool),
    );
    let rectified_req = rectify_router_request(req, &source_protocol, &target_protocol);
    let upstream_url = build_upstream_url(base_url, &rectified_req.target)?;
    let method =
        Method::from_bytes(rectified_req.method.as_bytes()).map_err(|error| error.to_string())?;
    let client = Client::builder()
        .timeout(Duration::from_millis(config.timeout_ms))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| error.to_string())?;
    let mut builder = client
        .request(method, upstream_url)
        .header(ACCEPT_ENCODING, HeaderValue::from_static("identity"))
        .body(rectified_req.body.clone());
    if target_protocol == "gemini" {
        builder = builder.header("x-goog-api-key", api_key);
    } else if is_anthropic_router_tool(&tool) {
        if !auth_token.is_empty() {
            builder = builder.bearer_auth(auth_token);
        } else {
            builder = builder.header("x-api-key", api_key);
        }
        if !rectified_req
            .headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("anthropic-version"))
        {
            builder = builder.header("anthropic-version", "2023-06-01");
        }
    } else {
        builder = builder.bearer_auth(api_key);
    }
    for (name, value) in &rectified_req.headers {
        if !should_forward_header(name) {
            continue;
        }
        if let (Ok(header_name), Ok(header_value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) {
            builder = builder.header(header_name, header_value);
        }
    }
    if !rectified_req
        .headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("content-type"))
        && !rectified_req.body.is_empty()
    {
        builder = builder.header(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    }

    let response = builder.send().map_err(|error| error.to_string())?;
    let status_code = response.status().as_u16();
    let mut headers = Vec::new();
    for (name, value) in response.headers() {
        let lower = name.as_str().to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "content-length" | "connection" | "transfer-encoding" | "content-encoding"
        ) {
            continue;
        }
        if lower == "content-type"
            || lower.starts_with("x-")
            || lower.starts_with("openai-")
            || lower.starts_with("anthropic-")
        {
            if let Ok(text) = value.to_str() {
                headers.push((name.to_string(), text.to_string()));
            }
        }
    }
    let body = response
        .bytes()
        .map_err(|error| error.to_string())?
        .to_vec();
    let response = ProxyResponse {
        status_code,
        headers,
        body,
    };
    let raw_status_code = response.status_code;
    let raw_headers = response.headers.clone();
    let raw_body = response.body.clone();
    let response = rectify_router_response(
        response,
        &source_protocol,
        &target_protocol,
        &rectified_req.target,
    );
    let transform = router_transform_meta_from(
        &source_protocol,
        &target_protocol,
        req,
        &rectified_req,
        raw_status_code,
        &raw_headers,
        &raw_body,
        &response,
    );
    Ok(ForwardOutcome {
        response,
        transform,
    })
}

fn proxy_request(
    config: Arc<RouterConfig>,
    stats: Arc<Mutex<RouterStats>>,
    req: LocalRequest,
) -> ProxyResponse {
    let order = select_provider_order(&config, &stats);
    if order.is_empty() {
        let body =
            serde_json::to_vec(&json!({ "error": "no API Key providers configured for router" }))
                .unwrap_or_default();
        push_router_log(
            &stats,
            &config.tool,
            &req.method,
            &req.target,
            "-",
            503,
            false,
            false,
            0,
            req.body.len() as u64,
            body.len() as u64,
            RouterUsageSummary::default(),
            &RouterTransformMeta::default(),
            "no API Key providers configured for router",
        );
        finalize_request_stats(&stats, false);
        return ProxyResponse {
            status_code: 503,
            headers: vec![(
                "content-type".to_string(),
                "application/json; charset=utf-8".to_string(),
            )],
            body,
        };
    }

    let mut last_error = String::new();
    let mut last_response: Option<ProxyResponse> = None;
    for provider in order {
        let route_key = provider_route_key(&provider);
        let started = Instant::now();
        match forward_once(&config, &req, &provider) {
            Ok(outcome) => {
                let ForwardOutcome {
                    response,
                    transform,
                } = outcome;
                let latency_ms = started.elapsed().as_millis() as u64;
                let retry = is_retry_status(response.status_code);
                let routed = !retry;
                let body_text = String::from_utf8_lossy(&response.body);
                let message = if retry {
                    let summary = summarize_probe_error(response.status_code, &body_text);
                    if summary.trim().is_empty() {
                        "retryable upstream status".to_string()
                    } else {
                        format!("retryable upstream status: {summary}")
                    }
                } else if response.status_code >= 400 {
                    summarize_probe_error(response.status_code, &body_text)
                } else {
                    String::new()
                };
                let usage = extract_router_usage_summary(&response.body);
                record_provider_attempt(
                    &config,
                    &stats,
                    &route_key,
                    response.status_code,
                    routed,
                    &message,
                );
                push_router_log(
                    &stats,
                    &config.tool,
                    &req.method,
                    &req.target,
                    &route_key,
                    response.status_code,
                    (200..400).contains(&response.status_code),
                    retry,
                    latency_ms,
                    req.body.len() as u64,
                    response.body.len() as u64,
                    usage,
                    &transform,
                    &message,
                );
                if retry {
                    last_response = Some(response);
                    continue;
                }
                finalize_request_stats(&stats, true);
                return response;
            }
            Err(error) => {
                let latency_ms = started.elapsed().as_millis() as u64;
                last_error = error;
                record_provider_attempt(&config, &stats, &route_key, 0, false, &last_error);
                push_router_log(
                    &stats,
                    &config.tool,
                    &req.method,
                    &req.target,
                    &route_key,
                    0,
                    false,
                    true,
                    latency_ms,
                    req.body.len() as u64,
                    0,
                    RouterUsageSummary::default(),
                    &RouterTransformMeta::default(),
                    &last_error,
                );
            }
        }
    }

    finalize_request_stats(&stats, false);
    if let Some(response) = last_response {
        return response;
    }
    ProxyResponse {
        status_code: 502,
        headers: vec![(
            "content-type".to_string(),
            "application/json; charset=utf-8".to_string(),
        )],
        body: serde_json::to_vec(&json!({
          "error": "all router providers failed",
          "detail": last_error,
        }))
        .unwrap_or_default(),
    }
}

fn write_proxy_response(stream: &mut TcpStream, response: ProxyResponse) {
    let mut header_text = format!(
        "HTTP/1.1 {} {}\r\nContent-Length: {}\r\nConnection: close\r\n",
        response.status_code,
        reason_phrase(response.status_code),
        response.body.len()
    );
    let has_content_type = response
        .headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("content-type"));
    if !has_content_type {
        header_text.push_str("Content-Type: application/json; charset=utf-8\r\n");
    }
    for (name, value) in response.headers {
        if should_forward_header(&name) {
            header_text.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    header_text.push_str("X-EasyAIConfig-Router: 1\r\n\r\n");
    let _ = stream.write_all(header_text.as_bytes());
    let _ = stream.write_all(&response.body);
    let _ = stream.flush();
}

fn handle_connection(
    mut stream: TcpStream,
    config: Arc<RouterConfig>,
    stats: Arc<Mutex<RouterStats>>,
) {
    let req = match read_local_request(&mut stream) {
        Ok(req) => req,
        Err(error) => {
            write_json(&mut stream, 400, json!({ "error": error }));
            return;
        }
    };
    let path = path_query_from_target(&req.target);
    let path_only = path.split_once('?').map_or(path.as_str(), |(path, _)| path);
    if req.method.eq_ignore_ascii_case("OPTIONS") {
        write_response(&mut stream, 204, "text/plain; charset=utf-8", b"");
        return;
    }
    if path_only == "/" || path_only == "/health" || path_only == "/_easyai/health" {
        write_json(
            &mut stream,
            200,
            json!({
            "ok": true,
            "router": "EasyAIConfig",
            "tool": config.tool,
            "providerKeys": config.providers.iter().map(provider_route_key).collect::<Vec<_>>(),
            }),
        );
        return;
    }
    if !router_client_authorized(&req) {
        write_json(
            &mut stream,
            401,
            json!({
            "error": {
              "message": "invalid EasyAIConfig router API key",
              "type": "authentication_error",
            },
            }),
        );
        return;
    }
    let response = proxy_request(config, stats, req);
    write_proxy_response(&mut stream, response);
}

fn run_router(
    listener: TcpListener,
    config: Arc<RouterConfig>,
    running: Arc<AtomicBool>,
    stats: Arc<Mutex<RouterStats>>,
) {
    for incoming in listener.incoming() {
        if !running.load(Ordering::SeqCst) {
            break;
        }
        match incoming {
            Ok(stream) => {
                let config = Arc::clone(&config);
                let stats = Arc::clone(&stats);
                thread::spawn(move || handle_connection(stream, config, stats));
            }
            Err(error) => {
                let mut guard = stats
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                guard.last_error = error.to_string();
            }
        }
    }
}

pub(crate) fn query_provider_router_status(query: &Value) -> Result<Value, String> {
    let log_limit = router_status_log_limit(query);
    let guard = router_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(runtime) = guard.as_ref() {
        Ok(runtime_status_json(runtime, log_limit))
    } else {
        Ok(stopped_status_json(log_limit))
    }
}

pub(crate) fn query_provider_router_logs(query: &Value) -> Result<Value, String> {
    try_query_router_logs(query)
}

pub(crate) fn clear_provider_router_logs(body: &Value) -> Result<Value, String> {
    try_clear_router_logs(body)
}

pub(crate) fn probe_provider_router(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let model = object
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let timeout_ms = object
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(45000);
    let (port, tool, stats) = {
        let guard = router_slot()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(runtime) = guard.as_ref() else {
            return Err("本地路由网关未启动".to_string());
        };
        if !runtime.running.load(Ordering::SeqCst) {
            return Err("本地路由网关未运行".to_string());
        }
        (
            runtime.port,
            runtime.config.tool.clone(),
            Arc::clone(&runtime.stats),
        )
    };

    let started = Instant::now();
    let probe_result = send_local_router_probe(port, &tool, &model, timeout_ms);
    let latency_ms = started.elapsed().as_millis() as u64;
    match probe_result {
        Ok(status_code) => record_router_probe(&stats, true, status_code, "", latency_ms),
        Err(error) => record_router_probe(&stats, false, 0, &error, latency_ms),
    }

    let guard = router_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(runtime) = guard.as_ref() {
        Ok(runtime_status_json(runtime, ROUTER_STATUS_LOG_LIMIT))
    } else {
        Ok(stopped_status_json(ROUTER_STATUS_LOG_LIMIT))
    }
}

pub(crate) fn start_provider_router(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let provider_targets = provider_targets_from_body(&object);
    if provider_targets.is_empty() {
        return Err("至少需要 1 个 API Key Provider 才能启动本地路由".to_string());
    }
    let tool = normalize_router_tool(
        object
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or("codex"),
    );
    let codex_home = object
        .get("codexHome")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let local_router_no_proxy_added = if tool == "codex" {
        ensure_codex_router_no_proxy(&codex_home)?
    } else {
        false
    };

    let _ = stop_router_runtime();
    let requested_port = object
        .get("port")
        .and_then(Value::as_u64)
        .filter(|port| *port <= u16::MAX as u64)
        .map(|port| port as u16)
        .unwrap_or(DEFAULT_ROUTER_PORT);
    let (listener, port_fallback) = match TcpListener::bind(("127.0.0.1", requested_port)) {
        Ok(listener) => (listener, false),
        Err(error) => {
            if requested_port == 0 {
                return Err(error.to_string());
            }
            let fallback = TcpListener::bind(("127.0.0.1", 0)).map_err(|fallback_error| {
                format!("端口 {requested_port} 不可用：{error}; 自动端口也失败：{fallback_error}")
            })?;
            (fallback, true)
        }
    };
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let timeout_ms = clamp_u64(
        object
            .get("timeoutMs")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_ROUTER_UPSTREAM_TIMEOUT_MS),
        30000,
        MAX_ROUTER_UPSTREAM_TIMEOUT_MS,
    );
    let round_robin = object
        .get("roundRobin")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let route_strategy = normalize_route_strategy(
        object
            .get("routeStrategy")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        round_robin,
    );
    let circuit_min_requests = clamp_u64(
        object
            .get("circuitMinRequests")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_CIRCUIT_MIN_REQUESTS),
        1,
        CIRCUIT_WINDOW_LIMIT as u64,
    );
    let config = Arc::new(RouterConfig {
        scope: object
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("global")
            .trim()
            .to_string(),
        project_path: object
            .get("projectPath")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string(),
        codex_home: object
            .get("codexHome")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string(),
        tool,
        providers: provider_targets,
        timeout_ms,
        route_strategy,
        round_robin,
        balance_guard_enabled: object
            .get("balanceGuardEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        balance_min_percent: clamp_f64(
            object
                .get("balanceMinPercent")
                .and_then(Value::as_f64)
                .unwrap_or(5.0),
            0.0,
            100.0,
        ),
        balance_min_amount: clamp_f64(
            object
                .get("balanceMinAmount")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            0.0,
            f64::MAX,
        ),
        circuit_breaker_enabled: object
            .get("circuitBreakerEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        circuit_failure_threshold: clamp_u64(
            object
                .get("circuitFailureThreshold")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_CIRCUIT_FAILURE_THRESHOLD),
            1,
            100,
        ),
        circuit_recovery_wait_ms: clamp_u64(
            object
                .get("circuitRecoveryWaitMs")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_CIRCUIT_RECOVERY_WAIT_MS),
            1_000,
            3_600_000,
        ),
        circuit_success_threshold: clamp_u64(
            object
                .get("circuitSuccessThreshold")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_CIRCUIT_SUCCESS_THRESHOLD),
            1,
            20,
        ),
        circuit_error_rate_threshold: clamp_f64(
            object
                .get("circuitErrorRateThreshold")
                .and_then(Value::as_f64)
                .unwrap_or(DEFAULT_CIRCUIT_ERROR_RATE_THRESHOLD),
            0.1,
            1.0,
        ),
        circuit_min_requests,
        started_at: chrono::Utc::now().to_rfc3339(),
        port_fallback,
    });
    let running = Arc::new(AtomicBool::new(true));
    let stats = Arc::new(Mutex::new(RouterStats::default()));
    let thread_config = Arc::clone(&config);
    let thread_running = Arc::clone(&running);
    let thread_stats = Arc::clone(&stats);
    let handle =
        thread::spawn(move || run_router(listener, thread_config, thread_running, thread_stats));
    let runtime = RouterRuntime {
        config,
        running,
        stats,
        port,
        base_url: format!("http://127.0.0.1:{port}/v1"),
        handle: Some(handle),
    };
    let mut status = runtime_status_json(&runtime, ROUTER_STATUS_LOG_LIMIT);
    if let Some(object) = status.as_object_mut() {
        object.insert(
            "localRouterNoProxyAdded".to_string(),
            json!(local_router_no_proxy_added),
        );
    }
    let mut guard = router_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = Some(runtime);
    Ok(status)
}

pub(crate) fn stop_provider_router(_body: &Value) -> Result<Value, String> {
    Ok(stop_router_runtime())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_all_supported_router_tools() {
        let cases = [
            ("codex", "codex"),
            ("claude", "claudecode"),
            ("Claude-Code", "claudecode"),
            ("claude_desktop", "claude-desktop"),
            ("gemini-cli", "gemini"),
            ("open-code", "opencode"),
            ("open_claw", "openclaw"),
            ("hermes-agent", "hermes"),
            ("unknown", "codex"),
        ];
        for (input, expected) in cases {
            assert_eq!(normalize_router_tool(input), expected);
        }
    }

    #[test]
    fn router_log_query_normalizes_pagination_filters_and_time_range() {
        let query = json!({
          "query": " ERR ",
          "provider": "codex:primary",
          "tool": "gemini-cli",
          "status": "retry",
          "page": 0,
          "pageSize": 999,
          "fromMs": 2000,
          "toMs": 1000,
        });
        let parsed = parse_router_log_query(&query);
        assert_eq!(parsed.raw_query, "ERR");
        assert_eq!(parsed.query_like, "%err%");
        assert_eq!(parsed.provider, "codex:primary");
        assert_eq!(parsed.tool, "gemini");
        assert_eq!(parsed.status, "retry");
        assert_eq!(parsed.page, 1);
        assert_eq!(parsed.page_size, ROUTER_LOG_MAX_PAGE_SIZE);
        assert_eq!(parsed.from_ms, 1000);
        assert_eq!(parsed.to_ms, 2000);
    }

    #[test]
    fn router_log_clear_filter_matches_before_range_and_all() {
        let entry = RouterLogEntry {
            at_ms: 2_000,
            at: "2026-01-01T00:00:02Z".to_string(),
            tool: "codex".to_string(),
            method: "POST".to_string(),
            target: "/v1/responses".to_string(),
            provider_key: "codex:primary".to_string(),
            status_code: 200,
            success: true,
            retry: false,
            latency_ms: 10,
            request_bytes: 1,
            response_bytes: 2,
            cached_input_tokens: 0,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            source_protocol: "openai-responses".to_string(),
            target_protocol: "openai-responses".to_string(),
            request_converted: false,
            response_converted: false,
            error_normalized: false,
            error: String::new(),
        };
        assert!(router_log_entry_matches_clear(
            &entry,
            RouterLogClearFilter {
                all: true,
                before_ms: 0,
                from_ms: 0,
                to_ms: 0,
            },
        ));
        assert!(router_log_entry_matches_clear(
            &entry,
            RouterLogClearFilter {
                all: false,
                before_ms: 2_000,
                from_ms: 0,
                to_ms: 0,
            },
        ));
        assert!(router_log_entry_matches_clear(
            &entry,
            RouterLogClearFilter {
                all: false,
                before_ms: 0,
                from_ms: 1_500,
                to_ms: 2_500,
            },
        ));
        assert!(!router_log_entry_matches_clear(
            &entry,
            RouterLogClearFilter {
                all: false,
                before_ms: 1_000,
                from_ms: 0,
                to_ms: 0,
            },
        ));
    }

    #[test]
    fn router_log_retention_cutoff_keeps_thirty_days() {
        let now = 60_i64 * 24 * 60 * 60 * 1000;
        assert_eq!(
            router_log_retention_cutoff_ms(now),
            30_i64 * 24 * 60 * 60 * 1000
        );
    }

    #[test]
    fn router_header_filter_blocks_compression_and_hop_by_hop_headers() {
        assert!(!should_forward_header("Accept-Encoding"));
        assert!(!should_forward_header("TE"));
        assert!(!should_forward_header("Trailer"));
        assert!(!should_forward_header("Transfer-Encoding"));
        assert!(should_forward_header("Content-Type"));
    }

    #[test]
    fn keeps_route_keys_separate_for_all_runtime_tools() {
        let targets = [
            ("codex", "codex:work"),
            ("claudecode", "claudecode:work"),
            ("claude-desktop", "claude-desktop:work"),
            ("gemini", "gemini:work"),
            ("opencode", "opencode:work"),
            ("openclaw", "openclaw:work"),
            ("hermes", "hermes:work"),
        ];
        for (tool, expected_route_key) in targets {
            let target = RouterProviderConfig {
                tool: tool.to_string(),
                key: "work".to_string(),
                name: String::new(),
                base_url: String::new(),
                protocol: router_protocol_or_default("", tool),
                api_key: String::new(),
                auth_token: String::new(),
                weight: 1,
                balance_remaining: None,
                balance_total: None,
                balance_percent: None,
                balance_unit: String::new(),
                balance_status: "unknown".to_string(),
                balance_fetched_at: 0,
            };
            assert_eq!(provider_route_key(&target), expected_route_key);
        }
    }

    #[test]
    fn probe_payload_uses_anthropic_endpoint_for_claude_family_only() {
        let (claude_path, claude_body) = router_probe_payload("claude-desktop", "");
        assert_eq!(claude_path, "/v1/messages");
        assert_eq!(
            claude_body.get("max_tokens").and_then(Value::as_u64),
            Some(1)
        );

        let (hermes_path, hermes_body) = router_probe_payload("hermes", "");
        assert_eq!(hermes_path, "/v1/responses");
        assert_eq!(
            hermes_body.get("max_output_tokens").and_then(Value::as_u64),
            Some(1)
        );
    }

    fn json_request(target: &str, body: Value) -> LocalRequest {
        LocalRequest {
            method: "POST".to_string(),
            target: target.to_string(),
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body: serde_json::to_vec(&body).unwrap(),
        }
    }

    fn test_provider(tool: &str, key: &str) -> RouterProviderConfig {
        RouterProviderConfig {
            tool: tool.to_string(),
            key: key.to_string(),
            name: key.to_string(),
            base_url: "https://example.test".to_string(),
            protocol: router_protocol_or_default("", tool),
            api_key: "test-key".to_string(),
            auth_token: String::new(),
            weight: 1,
            balance_remaining: None,
            balance_total: None,
            balance_percent: None,
            balance_unit: String::new(),
            balance_status: "unknown".to_string(),
            balance_fetched_at: 0,
        }
    }

    fn test_router_config(providers: Vec<RouterProviderConfig>) -> RouterConfig {
        RouterConfig {
            scope: "test".to_string(),
            project_path: String::new(),
            codex_home: String::new(),
            tool: "codex".to_string(),
            providers,
            timeout_ms: 30_000,
            route_strategy: "priority".to_string(),
            round_robin: false,
            balance_guard_enabled: false,
            balance_min_percent: 0.0,
            balance_min_amount: 0.0,
            circuit_breaker_enabled: true,
            circuit_failure_threshold: 3,
            circuit_recovery_wait_ms: 1_000,
            circuit_success_threshold: 2,
            circuit_error_rate_threshold: 0.6,
            circuit_min_requests: 5,
            started_at: "2026-01-01T00:00:00Z".to_string(),
            port_fallback: false,
        }
    }

    #[test]
    fn circuit_breaker_opens_skips_half_opens_and_closes() {
        let config = test_router_config(vec![
            test_provider("codex", "primary"),
            test_provider("codex", "backup"),
        ]);
        let stats = Arc::new(Mutex::new(RouterStats::default()));

        for _ in 0..config.circuit_failure_threshold {
            record_provider_attempt(
                &config,
                &stats,
                "codex:primary",
                500,
                false,
                "upstream down",
            );
        }
        {
            let guard = stats.lock().unwrap();
            let primary = guard.providers.get("codex:primary").unwrap();
            assert_eq!(effective_provider_circuit_state(primary), "open");
            assert!(primary.circuit_open_until_ms > now_epoch_ms());
        }
        let order = select_provider_order(&config, &stats)
            .iter()
            .map(provider_route_key)
            .collect::<Vec<_>>();
        assert_eq!(order, vec!["codex:backup"]);

        {
            let mut guard = stats.lock().unwrap();
            guard
                .providers
                .get_mut("codex:primary")
                .unwrap()
                .circuit_open_until_ms = now_epoch_ms() - 1;
        }
        let order = select_provider_order(&config, &stats)
            .iter()
            .map(provider_route_key)
            .collect::<Vec<_>>();
        assert_eq!(order, vec!["codex:primary", "codex:backup"]);
        {
            let guard = stats.lock().unwrap();
            assert_eq!(
                effective_provider_circuit_state(guard.providers.get("codex:primary").unwrap()),
                "half-open"
            );
        }

        record_provider_attempt(&config, &stats, "codex:primary", 200, true, "");
        {
            let guard = stats.lock().unwrap();
            assert_eq!(
                effective_provider_circuit_state(guard.providers.get("codex:primary").unwrap()),
                "half-open"
            );
        }
        record_provider_attempt(&config, &stats, "codex:primary", 200, true, "");
        {
            let guard = stats.lock().unwrap();
            let primary = guard.providers.get("codex:primary").unwrap();
            assert_eq!(effective_provider_circuit_state(primary), "closed");
            assert_eq!(primary.circuit_open_until_ms, 0);
        }
    }

    #[test]
    fn circuit_breaker_opens_on_error_rate_threshold() {
        let mut config = test_router_config(vec![test_provider("codex", "primary")]);
        config.circuit_failure_threshold = 10;
        let stats = Arc::new(Mutex::new(RouterStats::default()));

        for success in [false, true, false, true, false] {
            record_provider_attempt(
                &config,
                &stats,
                "codex:primary",
                if success { 200 } else { 500 },
                success,
                "mixed failures",
            );
        }

        let guard = stats.lock().unwrap();
        let primary = guard.providers.get("codex:primary").unwrap();
        assert_eq!(effective_provider_circuit_state(primary), "open");
        assert_eq!(primary.circuit_consecutive_failures, 1);
        assert_eq!(provider_circuit_window_requests(primary), 5);
        assert_eq!(provider_circuit_window_failures(primary), 3);
    }

    #[test]
    fn live_rectifier_converts_responses_to_chat_request() {
        let req = json_request(
            "/v1/responses?trace=1",
            json!({
              "model": "gpt-test",
              "instructions": "system note",
              "input": "hello",
              "max_output_tokens": 7
            }),
        );

        let rectified = rectify_router_request(&req, "openai-responses", "openai-chat");
        assert_eq!(rectified.target, "/v1/chat/completions?trace=1");
        let body: Value = serde_json::from_slice(&rectified.body).unwrap();
        assert_eq!(body.get("max_tokens").and_then(Value::as_u64), Some(7));
        assert!(body.get("input").is_none());
        assert!(body.get("instructions").is_none());
        let messages = body.get("messages").and_then(Value::as_array).unwrap();
        assert_eq!(
            messages[0].get("role").and_then(Value::as_str),
            Some("system")
        );
        assert_eq!(
            messages[1].get("role").and_then(Value::as_str),
            Some("user")
        );
        assert_eq!(
            messages[1].get("content").and_then(Value::as_str),
            Some("hello")
        );
    }

    #[test]
    fn live_rectifier_converts_chat_to_anthropic_request() {
        let req = json_request(
            "/v1/chat/completions",
            json!({
              "model": "claude-test",
              "messages": [
                { "role": "system", "content": "system note" },
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "hi" }
              ],
              "max_completion_tokens": 11,
              "stop": ["END"]
            }),
        );

        let rectified = rectify_router_request(&req, "openai-chat", "anthropic");
        assert_eq!(rectified.target, "/v1/messages");
        let body: Value = serde_json::from_slice(&rectified.body).unwrap();
        assert_eq!(
            body.get("system").and_then(Value::as_str),
            Some("system note")
        );
        assert_eq!(body.get("max_tokens").and_then(Value::as_u64), Some(11));
        assert!(body.get("max_completion_tokens").is_none());
        assert!(body.get("stop").is_none());
        assert_eq!(
            body.get("stop_sequences")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1)
        );
        let messages = body.get("messages").and_then(Value::as_array).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(
            messages[0].get("role").and_then(Value::as_str),
            Some("user")
        );
        assert_eq!(
            messages[1].get("role").and_then(Value::as_str),
            Some("assistant")
        );
    }

    #[test]
    fn live_rectifier_converts_anthropic_to_responses_request() {
        let req = json_request(
            "/v1/messages",
            json!({
              "model": "gpt-test",
              "system": "system note",
              "messages": [
                { "role": "user", "content": [{ "type": "text", "text": "hello" }] }
              ],
              "max_tokens": 13
            }),
        );

        let rectified = rectify_router_request(&req, "anthropic", "openai-responses");
        assert_eq!(rectified.target, "/v1/responses");
        let body: Value = serde_json::from_slice(&rectified.body).unwrap();
        assert_eq!(
            body.get("instructions").and_then(Value::as_str),
            Some("system note")
        );
        assert_eq!(
            body.get("max_output_tokens").and_then(Value::as_u64),
            Some(13)
        );
        assert!(body.get("messages").is_none());
        let input = body.get("input").and_then(Value::as_array).unwrap();
        assert_eq!(input[0].get("role").and_then(Value::as_str), Some("user"));
        assert_eq!(
            input[0].get("content").and_then(Value::as_str),
            Some("hello")
        );
    }

    #[test]
    fn live_rectifier_converts_chat_to_gemini_request() {
        let req = json_request(
            "/v1/chat/completions?trace=1",
            json!({
              "model": "google/gemini-2.5-flash",
              "messages": [
                { "role": "system", "content": "Use JSON." },
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "hi" }
              ],
              "max_tokens": 21,
              "temperature": 0.2,
              "top_p": 0.9,
              "stop": ["END"],
              "response_format": { "type": "json_object" },
              "tools": [
                {
                  "type": "function",
                  "function": {
                    "name": "lookup",
                    "description": "Lookup data",
                    "parameters": { "type": "object", "properties": { "id": { "type": "string" } } }
                  }
                }
              ]
            }),
        );

        let rectified = rectify_router_request(&req, "openai-chat", "gemini");
        assert_eq!(
            rectified.target,
            "/v1beta/models/gemini-2.5-flash:generateContent?trace=1"
        );
        let body: Value = serde_json::from_slice(&rectified.body).unwrap();
        assert!(body.get("messages").is_none());
        assert!(body.get("model").is_none());
        assert_eq!(
            body.pointer("/systemInstruction/parts/0/text")
                .and_then(Value::as_str),
            Some("Use JSON.")
        );
        assert_eq!(
            body.pointer("/contents/0/role").and_then(Value::as_str),
            Some("user")
        );
        assert_eq!(
            body.pointer("/contents/1/role").and_then(Value::as_str),
            Some("model")
        );
        assert_eq!(
            body.pointer("/generationConfig/maxOutputTokens")
                .and_then(Value::as_u64),
            Some(21)
        );
        assert_eq!(
            body.pointer("/generationConfig/responseMimeType")
                .and_then(Value::as_str),
            Some("application/json")
        );
        assert_eq!(
            body.pointer("/tools/0/functionDeclarations/0/name")
                .and_then(Value::as_str),
            Some("lookup")
        );
    }

    #[test]
    fn build_upstream_url_deduplicates_gemini_version_prefix() {
        let url = build_upstream_url(
            "https://generativelanguage.googleapis.com/v1beta",
            "/v1beta/models/gemini-2.5-flash:generateContent",
        )
        .unwrap();
        assert_eq!(
      url,
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
    );
    }

    #[test]
    fn live_rectifier_converts_gemini_response_to_chat_response() {
        let body = json!({
          "candidates": [
            {
              "content": {
                "parts": [
                  { "text": "Hello from Gemini" },
                  { "functionCall": { "name": "lookup", "args": { "id": "42" } } }
                ]
              },
              "finishReason": "STOP"
            }
          ],
          "usageMetadata": {
            "promptTokenCount": 7,
            "candidatesTokenCount": 5,
            "totalTokenCount": 12,
            "cachedContentTokenCount": 2
          }
        });

        let rectified = rectify_router_response_body(
            body.clone(),
            "openai-chat",
            "gemini",
            "/v1beta/models/gemini-2.5-flash:generateContent",
        );

        assert_eq!(
            rectified.get("object").and_then(Value::as_str),
            Some("chat.completion")
        );
        assert_eq!(
            rectified.get("model").and_then(Value::as_str),
            Some("gemini-2.5-flash")
        );
        assert_eq!(
            rectified
                .pointer("/choices/0/message/content")
                .and_then(Value::as_str),
            Some("Hello from Gemini")
        );
        assert_eq!(
            rectified
                .pointer("/choices/0/message/tool_calls/0/function/name")
                .and_then(Value::as_str),
            Some("lookup")
        );
        assert_eq!(
            rectified
                .pointer("/choices/0/message/tool_calls/0/function/arguments")
                .and_then(Value::as_str),
            Some("{\"id\":\"42\"}")
        );
        assert_eq!(
            rectified
                .pointer("/usage/prompt_tokens")
                .and_then(Value::as_u64),
            Some(7)
        );
        assert_eq!(
            rectified
                .pointer("/usage/completion_tokens")
                .and_then(Value::as_u64),
            Some(5)
        );
        assert_eq!(
            rectified
                .pointer("/usage/prompt_tokens_details/cached_tokens")
                .and_then(Value::as_u64),
            Some(2)
        );
        assert_eq!(
            extract_router_usage_summary(&serde_json::to_vec(&body).unwrap()).total_tokens,
            12
        );
    }

    #[test]
    fn live_rectifier_converts_gemini_response_to_responses_and_anthropic() {
        let body = json!({
          "candidates": [
            {
              "content": {
                "parts": [
                  { "text": "Result text" },
                  { "functionCall": { "name": "lookup", "args": { "id": "abc" } } }
                ]
              },
              "finishReason": "MAX_TOKENS"
            }
          ],
          "usageMetadata": {
            "promptTokenCount": 3,
            "candidatesTokenCount": 4,
            "totalTokenCount": 7
          }
        });

        let responses = rectify_router_response_body(
            body.clone(),
            "openai-responses",
            "gemini",
            "/v1beta/models/gemini-2.5-flash:generateContent",
        );
        assert_eq!(
            responses.get("object").and_then(Value::as_str),
            Some("response")
        );
        assert_eq!(
            responses.get("output_text").and_then(Value::as_str),
            Some("Result text")
        );
        assert_eq!(
            responses.pointer("/output/1/type").and_then(Value::as_str),
            Some("function_call")
        );
        assert_eq!(
            responses
                .pointer("/usage/output_tokens")
                .and_then(Value::as_u64),
            Some(4)
        );

        let anthropic = rectify_router_response_body(
            body,
            "anthropic",
            "gemini",
            "/v1beta/models/gemini-2.5-flash:generateContent",
        );
        assert_eq!(
            anthropic.get("type").and_then(Value::as_str),
            Some("message")
        );
        assert_eq!(
            anthropic.pointer("/content/0/text").and_then(Value::as_str),
            Some("Result text")
        );
        assert_eq!(
            anthropic.pointer("/content/1/type").and_then(Value::as_str),
            Some("tool_use")
        );
        assert_eq!(
            anthropic.get("stop_reason").and_then(Value::as_str),
            Some("max_tokens")
        );
    }

    #[test]
    fn live_rectifier_converts_gemini_errors_to_caller_protocol() {
        let gemini_error = serde_json::to_vec(&json!({
          "error": {
            "code": 400,
            "message": "Invalid Gemini request",
            "status": "INVALID_ARGUMENT"
          }
        }))
        .unwrap();
        let openai = rectify_router_response(
            ProxyResponse {
                status_code: 400,
                headers: vec![("content-type".to_string(), "application/json".to_string())],
                body: gemini_error.clone(),
            },
            "openai-chat",
            "gemini",
            "/v1beta/models/gemini-2.5-flash:generateContent",
        );
        let openai_body: Value = serde_json::from_slice(&openai.body).unwrap();
        assert_eq!(openai.status_code, 400);
        assert_eq!(
            openai_body
                .pointer("/error/message")
                .and_then(Value::as_str),
            Some("Invalid Gemini request")
        );
        assert_eq!(
            openai_body.pointer("/error/type").and_then(Value::as_str),
            Some("invalid_request_error")
        );
        assert_eq!(
            openai_body.pointer("/error/code").and_then(Value::as_str),
            Some("invalid_argument")
        );

        let anthropic = rectify_router_response(
            ProxyResponse {
                status_code: 429,
                headers: vec![("content-type".to_string(), "application/json".to_string())],
                body: serde_json::to_vec(&json!({
                  "error": {
                    "code": 429,
                    "message": "Gemini quota exceeded",
                    "status": "RESOURCE_EXHAUSTED"
                  }
                }))
                .unwrap(),
            },
            "anthropic",
            "gemini",
            "/v1beta/models/gemini-2.5-flash:generateContent",
        );
        let anthropic_body: Value = serde_json::from_slice(&anthropic.body).unwrap();
        assert_eq!(
            anthropic_body.get("type").and_then(Value::as_str),
            Some("error")
        );
        assert_eq!(
            anthropic_body
                .pointer("/error/type")
                .and_then(Value::as_str),
            Some("rate_limit_error")
        );
        assert_eq!(
            anthropic_body
                .pointer("/error/message")
                .and_then(Value::as_str),
            Some("Gemini quota exceeded")
        );
    }

    #[test]
    fn router_transform_meta_flags_request_response_and_error_rectifiers() {
        let req = json_request(
            "/v1/chat/completions",
            json!({
              "model": "google/gemini-2.5-flash",
              "messages": [{ "role": "user", "content": "hello" }]
            }),
        );
        let rectified = rectify_router_request(&req, "openai-chat", "gemini");
        let raw_headers = vec![("content-type".to_string(), "application/json".to_string())];
        let raw_body = serde_json::to_vec(&json!({
          "error": {
            "code": 400,
            "message": "Invalid Gemini request",
            "status": "INVALID_ARGUMENT"
          }
        }))
        .unwrap();
        let final_response = rectify_router_response(
            ProxyResponse {
                status_code: 400,
                headers: raw_headers.clone(),
                body: raw_body.clone(),
            },
            "openai-chat",
            "gemini",
            &rectified.target,
        );

        let transform = router_transform_meta_from(
            "openai-chat",
            "gemini",
            &req,
            &rectified,
            400,
            &raw_headers,
            &raw_body,
            &final_response,
        );
        assert_eq!(transform.source_protocol, "openai-chat");
        assert_eq!(transform.target_protocol, "gemini");
        assert!(transform.request_converted);
        assert!(transform.response_converted);
        assert!(transform.error_normalized);

        let entry = RouterLogEntry {
            at_ms: 1,
            at: "2026-07-05T00:00:00Z".to_string(),
            tool: "codex".to_string(),
            method: "POST".to_string(),
            target: "/v1/chat/completions".to_string(),
            provider_key: "codex:gemini".to_string(),
            status_code: 400,
            success: false,
            retry: false,
            latency_ms: 12,
            request_bytes: req.body.len() as u64,
            response_bytes: final_response.body.len() as u64,
            cached_input_tokens: 0,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            source_protocol: transform.source_protocol,
            target_protocol: transform.target_protocol,
            request_converted: transform.request_converted,
            response_converted: transform.response_converted,
            error_normalized: transform.error_normalized,
            error: "Invalid Gemini request".to_string(),
        };
        let value = router_log_entry_json(&entry);
        assert_eq!(
            value.get("sourceProtocol").and_then(Value::as_str),
            Some("openai-chat")
        );
        assert_eq!(
            value.get("targetProtocol").and_then(Value::as_str),
            Some("gemini")
        );
        assert_eq!(
            value.get("requestConverted").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            value
                .pointer("/rectified/response")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            value.pointer("/rectified/error").and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn preview_response_rectifier_converts_gemini_error() {
        let preview = preview_router_response_rectifier(&json!({
          "sourceProtocol": "openai-chat",
          "targetProtocol": "gemini",
          "response": {
            "status": 400,
            "path": "/v1beta/models/gemini-2.5-flash:generateContent",
            "body": {
              "error": {
                "code": 400,
                "message": "Invalid Gemini request",
                "status": "INVALID_ARGUMENT"
              }
            }
          }
        }))
        .unwrap();
        assert_eq!(
            preview.get("schema").and_then(Value::as_str),
            Some("easyaiconfig.response-rectifier-preview.v1")
        );
        assert_eq!(preview.get("changed").and_then(Value::as_bool), Some(true));
        assert_eq!(
            preview
                .pointer("/response/body/error/message")
                .and_then(Value::as_str),
            Some("Invalid Gemini request")
        );
        assert_eq!(
            preview
                .pointer("/response/body/error/type")
                .and_then(Value::as_str),
            Some("invalid_request_error")
        );
        assert_eq!(
            preview
                .pointer("/response/body/error/code")
                .and_then(Value::as_str),
            Some("invalid_argument")
        );
    }

    #[test]
    fn live_rectifier_converts_gemini_stream_to_chat_sse() {
        let body = br#"data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}

data: {"candidates":[{"content":{"parts":[{"text":"lo"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}

"#;
        let rectified = rectify_router_stream_response_body(
            body,
            "openai-chat",
            "gemini",
            "/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
        )
        .unwrap();
        let text = String::from_utf8(rectified).unwrap();
        assert!(text.contains("chat.completion.chunk"));
        assert!(text.ends_with("data: [DONE]\n\n"));
        let events = parse_sse_json_payloads(text.as_bytes());
        assert_eq!(
            events[0]
                .pointer("/choices/0/delta/content")
                .and_then(Value::as_str),
            Some("Hel")
        );
        assert_eq!(
            events[1]
                .pointer("/choices/0/delta/content")
                .and_then(Value::as_str),
            Some("lo")
        );
        assert_eq!(
            events[1]
                .pointer("/choices/0/finish_reason")
                .and_then(Value::as_str),
            Some("stop")
        );
        assert_eq!(
            events[1]
                .pointer("/usage/total_tokens")
                .and_then(Value::as_u64),
            Some(5)
        );
    }

    #[test]
    fn live_rectifier_converts_gemini_stream_to_responses_and_anthropic_sse() {
        let body = br#"data: {"candidates":[{"content":{"parts":[{"text":"Result "}]}}]}

data: {"candidates":[{"content":{"parts":[{"text":"text"},{"functionCall":{"name":"lookup","args":{"id":"abc"}}}]},"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4,"totalTokenCount":7}}

"#;
        let responses = rectify_router_stream_response_body(
            body,
            "openai-responses",
            "gemini",
            "/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
        )
        .unwrap();
        let responses_text = String::from_utf8(responses).unwrap();
        assert!(responses_text.contains("event: response.output_text.delta"));
        assert!(responses_text.contains("event: response.output_item.done"));
        assert!(responses_text.contains("event: response.completed"));
        let response_events = parse_sse_json_payloads(responses_text.as_bytes());
        assert_eq!(
            response_events
                .iter()
                .find(
                    |event| event.get("type").and_then(Value::as_str) == Some("response.completed")
                )
                .and_then(|event| event.pointer("/response/usage/total_tokens"))
                .and_then(Value::as_u64),
            Some(7)
        );

        let anthropic = rectify_router_stream_response_body(
            body,
            "anthropic",
            "gemini",
            "/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
        )
        .unwrap();
        let anthropic_text = String::from_utf8(anthropic).unwrap();
        assert!(anthropic_text.contains("event: message_start"));
        assert!(anthropic_text.contains("event: content_block_delta"));
        assert!(anthropic_text.contains("event: message_stop"));
        let anthropic_events = parse_sse_json_payloads(anthropic_text.as_bytes());
        assert_eq!(
            anthropic_events
                .iter()
                .find(|event| event.get("type").and_then(Value::as_str) == Some("message_delta"))
                .and_then(|event| event.pointer("/usage/output_tokens"))
                .and_then(Value::as_u64),
            Some(4)
        );
    }

    #[test]
    fn live_rectifier_leaves_unsupported_or_invalid_requests_unchanged() {
        let invalid = LocalRequest {
            method: "POST".to_string(),
            target: "/v1/responses".to_string(),
            headers: vec![],
            body: b"not json".to_vec(),
        };
        let invalid_rectified = rectify_router_request(&invalid, "openai-responses", "openai-chat");
        assert_eq!(invalid_rectified.target, invalid.target);
        assert_eq!(invalid_rectified.body, invalid.body);

        let gemini = json_request(
            "/v1beta/models/gemini-2.5-flash:generateContent",
            json!({ "contents": [] }),
        );
        let gemini_rectified = rectify_router_request(&gemini, "gemini", "openai-chat");
        assert_eq!(gemini_rectified.target, gemini.target);
        assert_eq!(gemini_rectified.body, gemini.body);
    }
}
