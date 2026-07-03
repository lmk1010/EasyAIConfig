use reqwest::blocking::Client;
use reqwest::header::{HeaderName, HeaderValue, CONTENT_TYPE};
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

use crate::config::get_provider_secret;
use crate::{
  app_home, default_codex_home, ensure_dir, expand_home_path, parse_env, parse_json_object,
  read_text, stringify_env, write_secret,
};
use crate::provider::normalize_base_url;

const DEFAULT_ROUTER_PORT: u16 = 18791;
const ROUTER_CLIENT_PROVIDER_KEY: &str = "easyai-router";
const LOCAL_ROUTER_NO_PROXY_ITEMS: &[&str] = &["127.0.0.1", "localhost", "::1"];
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;
const MAX_ROUTER_LOG_ROWS: i64 = 10_000;
const ROUTER_STATUS_LOG_LIMIT: i64 = 120;

#[derive(Clone)]
struct RouterProviderConfig {
  tool: String,
  key: String,
  name: String,
  base_url: String,
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
    self.input_tokens > 0 || self.output_tokens > 0 || self.cached_input_tokens > 0 || self.total_tokens > 0
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

static ROUTER: OnceLock<Mutex<Option<RouterRuntime>>> = OnceLock::new();

fn router_slot() -> &'static Mutex<Option<RouterRuntime>> {
  ROUTER.get_or_init(|| Mutex::new(None))
}

fn clamp_u64(value: u64, min: u64, max: u64) -> u64 {
  value.max(min).min(max)
}

fn normalize_router_tool(value: &str) -> String {
  match value.trim().to_ascii_lowercase().as_str() {
    "claude" | "claudecode" | "claude-code" => "claudecode".to_string(),
    _ => "codex".to_string(),
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
  object.get(key).and_then(Value::as_f64).filter(|value| value.is_finite())
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
  format!("{}:{}", normalize_router_tool(&target.tool), target.key.trim())
}

fn provider_key_json(target: &RouterProviderConfig) -> Value {
  json!({
    "tool": normalize_router_tool(&target.tool),
    "providerKey": target.key,
    "routeKey": provider_route_key(target),
    "name": target.name,
    "baseUrl": target.base_url,
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
        error TEXT NOT NULL DEFAULT ''
      )",
      [],
    )
    .map_err(|error| error.to_string())?;
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

fn prune_router_logs(connection: &Connection) {
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
    "error": item.error,
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
    "providers": [],
    "logs": [],
  })
}

fn memory_router_stats_json(stats: &RouterStats) -> Value {
  let provider_stats = stats
    .providers
    .iter()
    .map(|(key, item)| {
      json!({
        "providerKey": key,
        "tool": key.split_once(':').map_or("", |(tool, _)| tool),
        "requests": item.requests,
        "successes": item.successes,
        "failures": item.failures,
        "lastStatus": item.last_status,
        "lastError": item.last_error,
        "requestBytes": 0,
        "responseBytes": 0,
        "cachedInputTokens": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "totalTokens": 0,
      })
    })
    .collect::<Vec<_>>();
  let logs = stats.logs.iter().rev().map(router_log_entry_json).collect::<Vec<_>>();
  json!({
    "requests": stats.requests,
    "forwarded": stats.forwarded,
    "failed": stats.failed,
    "lastProvider": stats.last_provider,
    "lastStatus": stats.last_status,
    "lastError": stats.last_error,
    "requestBytes": 0,
    "responseBytes": 0,
    "cachedInputTokens": 0,
    "inputTokens": 0,
    "outputTokens": 0,
    "totalTokens": 0,
    "providers": provider_stats,
    "logs": logs,
  })
}

fn persist_router_log(entry: &RouterLogEntry) -> Result<(), String> {
  let connection = open_router_log_db()?;
  connection
    .execute(
      "INSERT INTO provider_router_logs
        (at_ms, at, tool, provider_key, method, target, status_code, success, retry, latency_ms,
         request_bytes, response_bytes, cached_input_tokens, input_tokens, output_tokens, total_tokens, error)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
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
        request_bytes, response_bytes, cached_input_tokens, input_tokens, output_tokens, total_tokens, error
       FROM provider_router_logs
       ORDER BY id DESC
       LIMIT ?1",
    )
    .map_err(|error| error.to_string())?;
  let mapped_logs = log_stmt
    .query_map(params![limit], |row| {
      let entry = RouterLogEntry {
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
        error: row.get::<_, String>(16)?,
      };
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
    "providers": providers,
    "logs": logs,
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
  let host = url.host_str().unwrap_or_default().trim_matches(&['[', ']'][..]).to_ascii_lowercase();
  let port = url.port_or_known_default().unwrap_or(0);
  port == DEFAULT_ROUTER_PORT && (host == "127.0.0.1" || host == "localhost" || host == "::1")
}

fn is_router_self_target(target: &RouterProviderConfig) -> bool {
  let key = target.key.trim().to_ascii_lowercase();
  let name = target.name.trim().to_ascii_lowercase();
  key == ROUTER_CLIENT_PROVIDER_KEY
    || provider_route_key(target).to_ascii_lowercase() == format!("codex:{ROUTER_CLIENT_PROVIDER_KEY}")
    || provider_route_key(target).to_ascii_lowercase() == format!("claudecode:{ROUTER_CLIENT_PROVIDER_KEY}")
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
    if !items.iter().any(|existing| existing.eq_ignore_ascii_case(item)) {
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

fn dedupe_provider_targets(raw: Vec<RouterProviderConfig>, primary: &str) -> Vec<RouterProviderConfig> {
  let mut out: Vec<RouterProviderConfig> = Vec::new();
  let primary = primary.trim().to_string();
  if !primary.is_empty() {
    if let Some(index) = raw.iter().position(|item| {
      item.key == primary || provider_route_key(item) == primary
    }) {
      out.push(raw[index].clone());
    }
  }
  for target in raw {
    let clean = target.key.trim();
    if clean.is_empty() || out.iter().any(|item| provider_route_key(item) == provider_route_key(&target)) {
      continue;
    }
    out.push(target);
  }
  out
}

fn provider_targets_from_body(object: &Map<String, Value>) -> Vec<RouterProviderConfig> {
  let default_tool = normalize_router_tool(object.get("tool").and_then(Value::as_str).unwrap_or("codex"));
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
        tool: normalize_router_tool(item_object.get("tool").and_then(Value::as_str).unwrap_or(&default_tool)),
        key,
        name: item_object.get("name").and_then(Value::as_str).unwrap_or_default().trim().to_string(),
        base_url: item_object.get("baseUrl").and_then(Value::as_str).unwrap_or_default().trim().to_string(),
        api_key: item_object.get("apiKey").and_then(Value::as_str).unwrap_or_default().trim().to_string(),
        auth_token: item_object.get("authToken").and_then(Value::as_str).unwrap_or_default().trim().to_string(),
        weight: json_u64(&item_object, "weight").unwrap_or(1).max(1).min(100) as u32,
        balance_remaining: json_f64(&item_object, "balanceRemaining"),
        balance_total: json_f64(&item_object, "balanceTotal"),
        balance_percent: json_f64(&item_object, "balancePercent").map(|value| clamp_f64(value, 0.0, 100.0)),
        balance_unit: item_object.get("balanceUnit").and_then(Value::as_str).unwrap_or_default().trim().to_string(),
        balance_status: item_object.get("balanceStatus").and_then(Value::as_str).unwrap_or("unknown").trim().to_ascii_lowercase(),
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
      tool: default_tool,
      key: key.trim().to_string(),
      name: String::new(),
      base_url: String::new(),
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
  let primary = object.get("primaryProviderKey").and_then(Value::as_str).unwrap_or_default();
  let targets = targets
    .into_iter()
    .filter(|target| !is_router_self_target(target))
    .collect::<Vec<_>>();
  dedupe_provider_targets(targets, primary)
}

fn runtime_status_json(runtime: &RouterRuntime) -> Value {
  let stats = runtime.stats.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  let proxy_ready = stats.proxy_ready || stats.forwarded > 0;
  let memory_stats = memory_router_stats_json(&stats);
  let persisted_stats = load_persisted_router_stats(ROUTER_STATUS_LOG_LIMIT);
  let stats_json = if persisted_stats.get("logs").and_then(Value::as_array).map_or(false, |items| !items.is_empty())
    || persisted_stats.get("requests").and_then(Value::as_i64).unwrap_or(0) > 0
  {
    persisted_stats
  } else {
    memory_stats
  };
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

fn stopped_status_json() -> Value {
  let stats = load_persisted_router_stats(ROUTER_STATUS_LOG_LIMIT);
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

fn stop_router_runtime() -> Value {
  let runtime = {
    let mut guard = router_slot().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.take()
  };
  if let Some(mut runtime) = runtime {
    runtime.running.store(false, Ordering::SeqCst);
    let _ = TcpStream::connect(("127.0.0.1", runtime.port));
    if let Some(handle) = runtime.handle.take() {
      let _ = handle.join();
    }
  }
  stopped_status_json()
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
  let body = serde_json::to_vec(&value).unwrap_or_else(|_| b"{\"error\":\"encode failed\"}".to_vec());
  write_response(stream, status_code, "application/json; charset=utf-8", &body);
}

fn router_probe_payload(tool: &str, model: &str) -> (&'static str, Value) {
  let normalized_tool = normalize_router_tool(tool);
  let model = model.trim();
  if normalized_tool == "claudecode" {
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

fn send_local_router_probe(port: u16, tool: &str, model: &str, timeout_ms: u64) -> Result<u16, String> {
  let timeout = Duration::from_millis(clamp_u64(timeout_ms, 5000, 120000));
  let (path, body_value) = router_probe_payload(tool, model);
  let body = serde_json::to_vec(&body_value).map_err(|error| error.to_string())?;
  let addr = SocketAddr::from(([127, 0, 0, 1], port));
  let mut stream = TcpStream::connect_timeout(&addr, timeout).map_err(|error| error.to_string())?;
  stream.set_read_timeout(Some(timeout)).map_err(|error| error.to_string())?;
  stream.set_write_timeout(Some(timeout)).map_err(|error| error.to_string())?;
  let request_head = format!(
    "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer easyai-router\r\nContent-Type: application/json\r\nAccept: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
    body.len()
  );
  stream.write_all(request_head.as_bytes()).map_err(|error| error.to_string())?;
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
    Err(summarize_probe_error(status_code, &http_body_text(&response)))
  }
}

fn record_router_probe(
  stats: &Arc<Mutex<RouterStats>>,
  ok: bool,
  status_code: u16,
  error: &str,
  latency_ms: u64,
) {
  let mut guard = stats.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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
  stream.set_read_timeout(Some(Duration::from_secs(30))).map_err(|error| error.to_string())?;
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

  let header_text = std::str::from_utf8(&buffer[..header_end]).map_err(|error| error.to_string())?;
  let mut lines = header_text.split("\r\n").filter(|line| !line.is_empty());
  let request_line = lines.next().ok_or_else(|| "missing request line".to_string())?;
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
  let base = normalize_base_url(base_url)
    .or_else(|_| Url::parse(base_url.trim()).map(|url| url.to_string().trim_end_matches('/').to_string()).map_err(|error| error.to_string()))?;
  let parsed_base = Url::parse(&base).map_err(|error| error.to_string())?;
  let path_query = path_query_from_target(target);
  let (raw_path, query) = path_query.split_once('?').map_or((path_query.as_str(), ""), |(path, query)| (path, query));
  let path = if raw_path.starts_with('/') {
    raw_path.to_string()
  } else {
    format!("/{raw_path}")
  };
  let base_path = parsed_base.path().trim_end_matches('/').to_lowercase();
  let forwarded_path = if (base_path == "/v1" || base_path.ends_with("/v1"))
    && (path == "/v1" || path.starts_with("/v1/"))
  {
    let stripped = &path[3..];
    if stripped.is_empty() { "/".to_string() } else { stripped.to_string() }
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

fn should_forward_header(name: &str) -> bool {
  !matches!(
    name.to_ascii_lowercase().as_str(),
    "host"
      | "content-length"
      | "connection"
      | "authorization"
      | "x-api-key"
      | "proxy-authorization"
      | "keep-alive"
      | "transfer-encoding"
      | "upgrade"
  )
}

fn router_header_value<'a>(req: &'a LocalRequest, expected_name: &str) -> Option<&'a str> {
  req
    .headers
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
  status_code == 408 || status_code == 409 || status_code == 425 || status_code == 429 || status_code >= 500
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
  target.balance_status == "ok" && (provider_balance_percent(target).is_some() || target.balance_remaining.is_some())
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

fn next_router_index(stats: &Arc<Mutex<RouterStats>>, modulo: usize) -> usize {
  if modulo <= 1 {
    return 0;
  }
  let mut guard = stats.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  let start = guard.next_index % modulo;
  guard.next_index = (guard.next_index + 1) % modulo;
  start
}

fn rotate_provider_order(providers: Vec<RouterProviderConfig>, start: usize) -> Vec<RouterProviderConfig> {
  if providers.len() <= 1 {
    return providers;
  }
  (0..providers.len())
    .map(|offset| providers[(start + offset) % providers.len()].clone())
    .collect()
}

fn round_robin_provider_order(providers: Vec<RouterProviderConfig>, stats: &Arc<Mutex<RouterStats>>) -> Vec<RouterProviderConfig> {
  let start = next_router_index(stats, providers.len());
  rotate_provider_order(providers, start)
}

fn weighted_provider_order(providers: Vec<RouterProviderConfig>, stats: &Arc<Mutex<RouterStats>>) -> Vec<RouterProviderConfig> {
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

fn balance_provider_order(providers: Vec<RouterProviderConfig>, stats: &Arc<Mutex<RouterStats>>) -> Vec<RouterProviderConfig> {
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
    let score_order = score_b.partial_cmp(&score_a).unwrap_or(std::cmp::Ordering::Equal);
    if score_order != std::cmp::Ordering::Equal {
      return score_order;
    }
    let rotated_a = (index_a + len - start) % len;
    let rotated_b = (index_b + len - start) % len;
    rotated_a.cmp(&rotated_b)
  });
  items.into_iter().map(|(_, provider)| provider).collect()
}

fn select_provider_order(config: &RouterConfig, stats: &Arc<Mutex<RouterStats>>) -> Vec<RouterProviderConfig> {
  let providers = balance_guarded_provider_pool(config);
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
  stats: &Arc<Mutex<RouterStats>>,
  provider_key: &str,
  status_code: u16,
  success: bool,
  error: &str,
) {
  let mut guard = stats.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  let item = guard.providers.entry(provider_key.to_string()).or_default();
  item.requests += 1;
  item.last_status = status_code;
  item.last_error = error.to_string();
  if success {
    item.successes += 1;
  } else {
    item.failures += 1;
  }
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
    "output_tokens",
    "completion_tokens",
    "total_tokens",
    "cached_input_tokens",
    "cached_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ]
  .iter()
  .any(|key| object.contains_key(*key))
}

fn usage_summary_from_object(object: &Map<String, Value>) -> RouterUsageSummary {
  let input_tokens = usage_u64(object, "input_tokens")
    .max(usage_u64(object, "prompt_tokens"))
    .max(usage_u64(object, "input"))
    .max(usage_u64(object, "prompt"));
  let output_tokens = usage_u64(object, "output_tokens")
    .max(usage_u64(object, "completion_tokens"))
    .max(usage_u64(object, "output"))
    .max(usage_u64(object, "completion"));
  let anthropic_cached = usage_u64(object, "cache_read_input_tokens")
    .saturating_add(usage_u64(object, "cache_creation_input_tokens"));
  let cached_input_tokens = usage_u64(object, "cached_input_tokens")
    .max(usage_u64(object, "cached_tokens"))
    .max(usage_u64(object, "prompt_cache_hit_tokens"))
    .max(anthropic_cached)
    .max(usage_nested_u64(object, "input_tokens_details", "cached_tokens"))
    .max(usage_nested_u64(object, "prompt_tokens_details", "cached_tokens"));
  let explicit_total = usage_u64(object, "total_tokens").max(usage_u64(object, "total"));
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
    let payload = trimmed.strip_prefix("data:").map(str::trim).unwrap_or(trimmed);
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
    error: truncate_log_text(error, 500),
  };
  let _ = persist_router_log(&entry);
  let mut guard = stats.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  guard.logs.push_back(entry);
  while guard.logs.len() > 120 {
    guard.logs.pop_front();
  }
}

fn finalize_request_stats(stats: &Arc<Mutex<RouterStats>>, success: bool) {
  let mut guard = stats.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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

fn forward_once(config: &RouterConfig, req: &LocalRequest, target: &RouterProviderConfig) -> Result<ProxyResponse, String> {
  let tool = normalize_router_tool(&target.tool);
  let (base_url_value, api_key_value, auth_token_value) = if tool == "claudecode" {
    let base_url = if target.base_url.trim().is_empty() {
      "https://api.anthropic.com".to_string()
    } else {
      target.base_url.trim().to_string()
    };
    (base_url, target.api_key.trim().to_string(), target.auth_token.trim().to_string())
  } else {
    let secret = get_provider_secret(&provider_secret_body(config, &target.key))?;
    (
      secret.get("baseUrl").and_then(Value::as_str).unwrap_or_default().trim().to_string(),
      secret.get("apiKey").and_then(Value::as_str).unwrap_or_default().trim().to_string(),
      String::new(),
    )
  };
  let base_url = base_url_value.trim();
  let api_key = api_key_value.trim();
  let auth_token = auth_token_value.trim();
  if base_url.is_empty() || (api_key.is_empty() && auth_token.is_empty()) {
    return Err("provider missing baseUrl or API key".to_string());
  }

  let upstream_url = build_upstream_url(base_url, &req.target)?;
  let method = Method::from_bytes(req.method.as_bytes()).map_err(|error| error.to_string())?;
  let client = Client::builder()
    .timeout(Duration::from_millis(config.timeout_ms))
    .redirect(reqwest::redirect::Policy::limited(5))
    .build()
    .map_err(|error| error.to_string())?;
  let mut builder = client
    .request(method, upstream_url)
    .body(req.body.clone());
  if tool == "claudecode" {
    if !auth_token.is_empty() {
      builder = builder.bearer_auth(auth_token);
    } else {
      builder = builder.header("x-api-key", api_key);
    }
    if !req.headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("anthropic-version")) {
      builder = builder.header("anthropic-version", "2023-06-01");
    }
  } else {
    builder = builder.bearer_auth(api_key);
  }
  for (name, value) in &req.headers {
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
  if !req.headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("content-type")) && !req.body.is_empty() {
    builder = builder.header(CONTENT_TYPE, HeaderValue::from_static("application/json"));
  }

  let response = builder.send().map_err(|error| error.to_string())?;
  let status_code = response.status().as_u16();
  let mut headers = Vec::new();
  for (name, value) in response.headers() {
    let lower = name.as_str().to_ascii_lowercase();
    if matches!(lower.as_str(), "content-length" | "connection" | "transfer-encoding" | "content-encoding") {
      continue;
    }
    if lower == "content-type" || lower.starts_with("x-") || lower.starts_with("openai-") || lower.starts_with("anthropic-") {
      if let Ok(text) = value.to_str() {
        headers.push((name.to_string(), text.to_string()));
      }
    }
  }
  let body = response.bytes().map_err(|error| error.to_string())?.to_vec();
  Ok(ProxyResponse { status_code, headers, body })
}

fn proxy_request(config: Arc<RouterConfig>, stats: Arc<Mutex<RouterStats>>, req: LocalRequest) -> ProxyResponse {
  let order = select_provider_order(&config, &stats);
  if order.is_empty() {
    let body = serde_json::to_vec(&json!({ "error": "no API Key providers configured for router" })).unwrap_or_default();
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
      "no API Key providers configured for router",
    );
    finalize_request_stats(&stats, false);
    return ProxyResponse {
      status_code: 503,
      headers: vec![("content-type".to_string(), "application/json; charset=utf-8".to_string())],
      body,
    };
  }

  let mut last_error = String::new();
  let mut last_response: Option<ProxyResponse> = None;
  for provider in order {
    let route_key = provider_route_key(&provider);
    let started = Instant::now();
    match forward_once(&config, &req, &provider) {
      Ok(response) => {
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
        record_provider_attempt(&stats, &route_key, response.status_code, routed, &message);
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
        record_provider_attempt(&stats, &route_key, 0, false, &last_error);
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
    headers: vec![("content-type".to_string(), "application/json; charset=utf-8".to_string())],
    body: serde_json::to_vec(&json!({
      "error": "all router providers failed",
      "detail": last_error,
    })).unwrap_or_default(),
  }
}

fn write_proxy_response(stream: &mut TcpStream, response: ProxyResponse) {
  let mut header_text = format!(
    "HTTP/1.1 {} {}\r\nContent-Length: {}\r\nConnection: close\r\n",
    response.status_code,
    reason_phrase(response.status_code),
    response.body.len()
  );
  let has_content_type = response.headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("content-type"));
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

fn handle_connection(mut stream: TcpStream, config: Arc<RouterConfig>, stats: Arc<Mutex<RouterStats>>) {
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
    write_json(&mut stream, 200, json!({
      "ok": true,
      "router": "EasyAIConfig",
      "tool": config.tool,
      "providerKeys": config.providers.iter().map(provider_route_key).collect::<Vec<_>>(),
    }));
    return;
  }
  if !router_client_authorized(&req) {
    write_json(&mut stream, 401, json!({
      "error": {
        "message": "invalid EasyAIConfig router API key",
        "type": "authentication_error",
      },
    }));
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
        let mut guard = stats.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.last_error = error.to_string();
      }
    }
  }
}

pub(crate) fn query_provider_router_status(_query: &Value) -> Result<Value, String> {
  let guard = router_slot().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  if let Some(runtime) = guard.as_ref() {
    Ok(runtime_status_json(runtime))
  } else {
    Ok(stopped_status_json())
  }
}

pub(crate) fn probe_provider_router(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let model = object.get("model").and_then(Value::as_str).unwrap_or_default().trim().to_string();
  let timeout_ms = object.get("timeoutMs").and_then(Value::as_u64).unwrap_or(45000);
  let (port, tool, stats) = {
    let guard = router_slot().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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

  let guard = router_slot().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  if let Some(runtime) = guard.as_ref() {
    Ok(runtime_status_json(runtime))
  } else {
    Ok(stopped_status_json())
  }
}

pub(crate) fn start_provider_router(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let provider_targets = provider_targets_from_body(&object);
  if provider_targets.is_empty() {
    return Err("至少需要 1 个 API Key Provider 才能启动本地路由".to_string());
  }
  let tool = normalize_router_tool(object.get("tool").and_then(Value::as_str).unwrap_or("codex"));
  let codex_home = object.get("codexHome").and_then(Value::as_str).unwrap_or_default().trim().to_string();
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
  let port = listener.local_addr().map_err(|error| error.to_string())?.port();
  let timeout_ms = clamp_u64(object.get("timeoutMs").and_then(Value::as_u64).unwrap_or(180000), 30000, 600000);
  let round_robin = object.get("roundRobin").and_then(Value::as_bool).unwrap_or(true);
  let route_strategy = normalize_route_strategy(
    object.get("routeStrategy").and_then(Value::as_str).unwrap_or_default(),
    round_robin,
  );
  let config = Arc::new(RouterConfig {
    scope: object.get("scope").and_then(Value::as_str).unwrap_or("global").trim().to_string(),
    project_path: object.get("projectPath").and_then(Value::as_str).unwrap_or_default().trim().to_string(),
    codex_home: object.get("codexHome").and_then(Value::as_str).unwrap_or_default().trim().to_string(),
    tool,
    providers: provider_targets,
    timeout_ms,
    route_strategy,
    round_robin,
    balance_guard_enabled: object.get("balanceGuardEnabled").and_then(Value::as_bool).unwrap_or(true),
    balance_min_percent: clamp_f64(object.get("balanceMinPercent").and_then(Value::as_f64).unwrap_or(5.0), 0.0, 100.0),
    balance_min_amount: clamp_f64(object.get("balanceMinAmount").and_then(Value::as_f64).unwrap_or(0.0), 0.0, f64::MAX),
    started_at: chrono::Utc::now().to_rfc3339(),
    port_fallback,
  });
  let running = Arc::new(AtomicBool::new(true));
  let stats = Arc::new(Mutex::new(RouterStats::default()));
  let thread_config = Arc::clone(&config);
  let thread_running = Arc::clone(&running);
  let thread_stats = Arc::clone(&stats);
  let handle = thread::spawn(move || run_router(listener, thread_config, thread_running, thread_stats));
  let runtime = RouterRuntime {
    config,
    running,
    stats,
    port,
    base_url: format!("http://127.0.0.1:{port}/v1"),
    handle: Some(handle),
  };
  let mut status = runtime_status_json(&runtime);
  if let Some(object) = status.as_object_mut() {
    object.insert("localRouterNoProxyAdded".to_string(), json!(local_router_no_proxy_added));
  }
  let mut guard = router_slot().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  *guard = Some(runtime);
  Ok(status)
}

pub(crate) fn stop_provider_router(_body: &Value) -> Result<Value, String> {
  Ok(stop_router_runtime())
}
