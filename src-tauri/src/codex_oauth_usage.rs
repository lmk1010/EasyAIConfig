use chrono::{DateTime, Utc};
use reqwest::header::{
  HeaderMap, HeaderName, HeaderValue, ACCEPT, AUTHORIZATION, CACHE_CONTROL, PRAGMA, USER_AGENT,
};
use reqwest::Client;
use serde_json::{json, Map, Value};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::time::Duration;
use tokio::net::lookup_host;
use tokio::time::timeout;

use crate::{default_codex_home, parse_json_object, read_text, write_text};

const AUTH_FILENAME: &str = "auth.json";
const CODEX_OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_DEFAULT_VERSION: &str = "0.142.5";
const CODEX_DEFAULT_USER_AGENT: &str = "codex_cli_rs/0.142.5";
const CODEX_SYSTEM_DNS_PREFLIGHT_MS: u64 = 700;
const CODEX_SYSTEM_ATTEMPT_TIMEOUT_MS: u64 = 1_800;
const CHATGPT_DNS_FALLBACK_IPS: [Ipv4Addr; 4] = [
  Ipv4Addr::new(104, 18, 37, 228),
  Ipv4Addr::new(104, 18, 38, 228),
  Ipv4Addr::new(172, 64, 150, 16),
  Ipv4Addr::new(172, 64, 151, 16),
];

struct OAuthAccount {
  access_token: String,
  id_token: String,
  refresh_token: String,
  account_id: String,
  email: String,
  plan: String,
  sub: String,
}

struct EndpointSpec {
  id: &'static str,
  label: &'static str,
  method: &'static str,
  url: &'static str,
  token_kind: &'static str,
}

struct RefreshedOAuthTokens {
  access_token: String,
  id_token: String,
  refresh_token: String,
}

struct UsageProbeOutcome {
  first_json_payload: Option<Value>,
  saw_auth_error: bool,
  saw_blocked: bool,
  saw_network_error: bool,
}

fn clean_string(value: Option<&Value>) -> String {
  value
    .and_then(Value::as_str)
    .unwrap_or_default()
    .trim()
    .to_string()
}

fn clamp_u64(value: u64, min: u64, max: u64) -> u64 {
  value.max(min).min(max)
}

fn resolve_codex_home(object: &Map<String, Value>) -> Result<PathBuf, String> {
  let input = clean_string(object.get("codexHome"));
  if input.is_empty() {
    default_codex_home()
  } else {
    Ok(PathBuf::from(input))
  }
}

fn b64url_decode(input: &str) -> Option<Vec<u8>> {
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
  let mid = token.trim().split('.').nth(1)?;
  let bytes = b64url_decode(mid)?;
  let text = std::str::from_utf8(&bytes).ok()?;
  serde_json::from_str::<Value>(text).ok()
}

fn string_from_map(map: &Map<String, Value>, key: &str) -> String {
  map.get(key)
    .and_then(Value::as_str)
    .unwrap_or_default()
    .trim()
    .to_string()
}

fn read_oauth_account(codex_home: &PathBuf) -> Result<OAuthAccount, String> {
  let auth_path = codex_home.join(AUTH_FILENAME);
  let raw = read_text(&auth_path)?;
  if raw.trim().is_empty() {
    return Err("当前 CODEX_HOME 没有 auth.json，请先完成 Codex OAuth 登录。".to_string());
  }
  let auth: Value = serde_json::from_str(&raw)
    .map_err(|error| format!("Codex OAuth auth.json 解析失败: {}", error))?;
  let Some(tokens) = auth.get("tokens").and_then(Value::as_object) else {
    return Err("Codex OAuth auth.json 没有 tokens，请重新登录。".to_string());
  };
  let access_token = string_from_map(tokens, "access_token");
  if access_token.is_empty() {
    return Err("Codex OAuth auth.json 没有 access_token，请重新登录。".to_string());
  }

  let id_token = string_from_map(tokens, "id_token");
  let refresh_token = string_from_map(tokens, "refresh_token");
  let mut account_id = string_from_map(tokens, "account_id");
  let mut email = String::new();
  let mut plan = String::new();
  let mut sub = String::new();
  if let Some(payload) = decode_jwt_payload(&id_token) {
    if let Some(obj) = payload.as_object() {
      sub = string_from_map(obj, "sub");
      email = string_from_map(obj, "email");
      if let Some(auth_ns) = obj.get("https://api.openai.com/auth").and_then(Value::as_object) {
        if account_id.is_empty() {
          account_id = string_from_map(auth_ns, "chatgpt_account_id");
        }
        plan = string_from_map(auth_ns, "chatgpt_plan_type");
      }
    }
  }

  Ok(OAuthAccount {
    access_token,
    id_token,
    refresh_token,
    account_id,
    email,
    plan,
    sub,
  })
}

fn build_headers(account: &OAuthAccount, token_kind: &str) -> Result<HeaderMap, String> {
  let mut headers = HeaderMap::new();
  let token = if token_kind == "id_token" { &account.id_token } else { &account.access_token };
  if token.trim().is_empty() {
    return Err(format!("OAuth {token_kind} 为空"));
  }
  let auth_value = format!("Bearer {}", token.trim());
  headers.insert(
    AUTHORIZATION,
    HeaderValue::from_str(&auth_value).map_err(|_| format!("OAuth {token_kind} 格式无效"))?,
  );
  headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
  headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
  headers.insert(PRAGMA, HeaderValue::from_static("no-cache"));
  headers.insert(USER_AGENT, HeaderValue::from_static(CODEX_DEFAULT_USER_AGENT));
  headers.insert(
    HeaderName::from_static("openai-beta"),
    HeaderValue::from_static("responses=experimental"),
  );
  headers.insert(HeaderName::from_static("originator"), HeaderValue::from_static("codex_cli_rs"));
  headers.insert(HeaderName::from_static("version"), HeaderValue::from_static(CODEX_DEFAULT_VERSION));
  if !account.account_id.is_empty() {
    if let Ok(value) = HeaderValue::from_str(&account.account_id) {
      headers.insert(HeaderName::from_static("chatgpt-account-id"), value);
    }
  }
  Ok(headers)
}

fn endpoints(include_id_token_fallback: bool) -> Vec<EndpointSpec> {
  let mut specs = vec![
    EndpointSpec {
      id: "codex_wham_backend_access_get",
      label: "Codex WHAM usage",
      method: "GET",
      url: "https://chatgpt.com/backend-api/wham/usage",
      token_kind: "access_token",
    },
    EndpointSpec {
      id: "codex_usage_backend_access_get",
      label: "Codex backend usage",
      method: "GET",
      url: "https://chatgpt.com/backend-api/codex/usage",
      token_kind: "access_token",
    },
  ];
  if include_id_token_fallback {
    specs.push(EndpointSpec {
      id: "codex_usage_backend_id_get",
      label: "Codex backend usage",
      method: "GET",
      url: "https://chatgpt.com/backend-api/codex/usage",
      token_kind: "id_token",
    });
  }
  specs
}

fn looks_like_cloudflare_block(status_code: u16, headers: &HeaderMap, body: &str) -> bool {
  let server = headers
    .get("server")
    .and_then(|v| v.to_str().ok())
    .unwrap_or_default()
    .to_ascii_lowercase();
  let cf_ray = headers.contains_key("cf-ray");
  let text = body.to_ascii_lowercase();
  (status_code == 403 || status_code == 503)
    && (cf_ray
      || server.contains("cloudflare")
      || text.contains("cf-chl")
      || text.contains("challenge-platform")
      || text.contains("just a moment"))
}

fn short_body_message(body: &str) -> String {
  let text = body.split_whitespace().collect::<Vec<_>>().join(" ");
  if text.is_empty() {
    return String::new();
  }
  text.chars().take(180).collect()
}

fn endpoint_attempt(spec: &EndpointSpec, status: &str, status_code: Option<u16>, message: &str) -> Value {
  json!({
    "id": spec.id,
    "label": spec.label,
    "method": spec.method,
    "endpoint": spec.url,
    "tokenKind": spec.token_kind,
    "status": status,
    "statusCode": status_code,
    "message": message,
  })
}

fn oauth_refresh_attempt(status: &str, status_code: Option<u16>, message: &str) -> Value {
  json!({
    "id": "codex_oauth_refresh",
    "label": "Codex OAuth refresh",
    "method": "POST",
    "endpoint": CODEX_OAUTH_TOKEN_URL,
    "tokenKind": "refresh_token",
    "status": status,
    "statusCode": status_code,
    "message": message,
  })
}

fn dns_fallback_attempt(message: &str) -> Value {
  json!({
    "id": "codex_chatgpt_dns_fallback",
    "label": "ChatGPT DNS fallback",
    "method": "CONNECT",
    "endpoint": "https://chatgpt.com",
    "tokenKind": "none",
    "status": "retry",
    "statusCode": Value::Null,
    "message": message,
  })
}

fn chatgpt_dns_fallback_addrs() -> Vec<SocketAddr> {
  CHATGPT_DNS_FALLBACK_IPS
    .iter()
    .map(|ip| SocketAddr::new(IpAddr::V4(*ip), 443))
    .collect()
}

fn build_oauth_usage_client(timeout_ms: u64, chatgpt_dns_fallback: bool) -> Result<Client, String> {
  let mut builder = Client::builder()
    .timeout(Duration::from_millis(timeout_ms))
    .redirect(reqwest::redirect::Policy::limited(2));
  if chatgpt_dns_fallback {
    let addrs = chatgpt_dns_fallback_addrs();
    builder = builder.resolve_to_addrs("chatgpt.com", &addrs);
  }
  builder.build().map_err(|error| error.to_string())
}

fn should_retry_chatgpt_dns_fallback(outcome: &UsageProbeOutcome) -> bool {
  outcome.saw_network_error && outcome.first_json_payload.is_none() && !outcome.saw_auth_error && !outcome.saw_blocked
}

fn ipv4_in_cidr(ip: Ipv4Addr, base: Ipv4Addr, prefix: u32) -> bool {
  let ip = u32::from(ip);
  let base = u32::from(base);
  let mask = if prefix == 0 { 0 } else { u32::MAX << (32 - prefix) };
  (ip & mask) == (base & mask)
}

fn ipv6_in_cidr(ip: Ipv6Addr, base: Ipv6Addr, prefix: u32) -> bool {
  let ip = u128::from(ip);
  let base = u128::from(base);
  let mask = if prefix == 0 { 0 } else { u128::MAX << (128 - prefix) };
  (ip & mask) == (base & mask)
}

fn looks_like_cloudflare_edge(ip: IpAddr) -> bool {
  match ip {
    IpAddr::V4(ip) => [
      (Ipv4Addr::new(173, 245, 48, 0), 20),
      (Ipv4Addr::new(103, 21, 244, 0), 22),
      (Ipv4Addr::new(103, 22, 200, 0), 22),
      (Ipv4Addr::new(103, 31, 4, 0), 22),
      (Ipv4Addr::new(141, 101, 64, 0), 18),
      (Ipv4Addr::new(108, 162, 192, 0), 18),
      (Ipv4Addr::new(190, 93, 240, 0), 20),
      (Ipv4Addr::new(188, 114, 96, 0), 20),
      (Ipv4Addr::new(197, 234, 240, 0), 22),
      (Ipv4Addr::new(198, 41, 128, 0), 17),
      (Ipv4Addr::new(162, 158, 0, 0), 15),
      (Ipv4Addr::new(104, 16, 0, 0), 13),
      (Ipv4Addr::new(104, 24, 0, 0), 14),
      (Ipv4Addr::new(172, 64, 0, 0), 13),
      (Ipv4Addr::new(131, 0, 72, 0), 22),
    ]
    .iter()
    .any(|(base, prefix)| ipv4_in_cidr(ip, *base, *prefix)),
    IpAddr::V6(ip) => [
      (Ipv6Addr::new(0x2400, 0xcb00, 0, 0, 0, 0, 0, 0), 32),
      (Ipv6Addr::new(0x2606, 0x4700, 0, 0, 0, 0, 0, 0), 32),
      (Ipv6Addr::new(0x2803, 0xf800, 0, 0, 0, 0, 0, 0), 32),
      (Ipv6Addr::new(0x2405, 0xb500, 0, 0, 0, 0, 0, 0), 32),
      (Ipv6Addr::new(0x2405, 0x8100, 0, 0, 0, 0, 0, 0), 32),
      (Ipv6Addr::new(0x2a06, 0x98c0, 0, 0, 0, 0, 0, 0), 29),
      (Ipv6Addr::new(0x2c0f, 0xf248, 0, 0, 0, 0, 0, 0), 32),
    ]
    .iter()
    .any(|(base, prefix)| ipv6_in_cidr(ip, *base, *prefix)),
  }
}

fn chatgpt_dns_fallback_reason_for_addrs(addrs: &[IpAddr]) -> Option<String> {
  if addrs.is_empty() {
    return Some("系统 DNS 没有返回 chatgpt.com 地址".to_string());
  }
  if addrs.iter().any(|ip| looks_like_cloudflare_edge(*ip)) {
    return None;
  }
  let sample = addrs
    .iter()
    .take(4)
    .map(ToString::to_string)
    .collect::<Vec<_>>()
    .join(", ");
  Some(format!("系统 DNS 将 chatgpt.com 解析到非 Cloudflare 地址: {sample}"))
}

async fn chatgpt_dns_fallback_reason() -> Option<String> {
  let result = timeout(
    Duration::from_millis(CODEX_SYSTEM_DNS_PREFLIGHT_MS),
    lookup_host(("chatgpt.com", 443)),
  )
  .await;
  match result {
    Ok(Ok(iter)) => {
      let addrs = iter.map(|addr| addr.ip()).collect::<Vec<_>>();
      chatgpt_dns_fallback_reason_for_addrs(&addrs)
    }
    Ok(Err(error)) => Some(format!("系统 DNS 解析 chatgpt.com 失败: {error}")),
    Err(_) => Some(format!("系统 DNS 解析 chatgpt.com 超过 {CODEX_SYSTEM_DNS_PREFLIGHT_MS}ms")),
  }
}

fn persist_refreshed_oauth_tokens(codex_home: &PathBuf, tokens: &RefreshedOAuthTokens) -> Result<(), String> {
  let auth_path = codex_home.join(AUTH_FILENAME);
  let raw = read_text(&auth_path)?;
  let mut auth: Value = serde_json::from_str(&raw)
    .map_err(|error| format!("Codex OAuth auth.json 解析失败: {}", error))?;
  let Some(auth_object) = auth.as_object_mut() else {
    return Err("Codex OAuth auth.json 不是 JSON object".to_string());
  };
  let Some(tokens_object) = auth_object.get_mut("tokens").and_then(Value::as_object_mut) else {
    return Err("Codex OAuth auth.json 没有 tokens".to_string());
  };
  tokens_object.insert("access_token".to_string(), Value::String(tokens.access_token.clone()));
  if !tokens.id_token.trim().is_empty() {
    tokens_object.insert("id_token".to_string(), Value::String(tokens.id_token.clone()));
  }
  if !tokens.refresh_token.trim().is_empty() {
    tokens_object.insert("refresh_token".to_string(), Value::String(tokens.refresh_token.clone()));
  }
  auth_object.insert("last_refresh".to_string(), Value::String(Utc::now().to_rfc3339()));
  let text = serde_json::to_string_pretty(&auth)
    .map_err(|error| format!("Codex OAuth auth.json 序列化失败: {}", error))?;
  write_text(&auth_path, &format!("{}\n", text))
}

async fn refresh_codex_oauth_tokens(client: &Client, refresh_token: &str) -> Result<RefreshedOAuthTokens, String> {
  let rt = refresh_token.trim();
  if rt.is_empty() {
    return Err("auth.json 没有 refresh_token".to_string());
  }
  let params = [
    ("grant_type", "refresh_token"),
    ("refresh_token", rt),
    ("client_id", CODEX_OAUTH_CLIENT_ID),
  ];
  let response = client
    .post(CODEX_OAUTH_TOKEN_URL)
    .header(ACCEPT, "application/json")
    .form(&params)
    .send()
    .await
    .map_err(|error| if error.is_timeout() { "刷新 OAuth token 超时".to_string() } else { error.to_string() })?;
  let status = response.status();
  let status_code = status.as_u16();
  let text = response.text().await.unwrap_or_default();
  if !status.is_success() {
    let body = short_body_message(&text);
    return Err(if body.is_empty() {
      format!("刷新 OAuth token 失败: HTTP {status_code}")
    } else {
      format!("刷新 OAuth token 失败: HTTP {status_code} {body}")
    });
  }
  let payload = serde_json::from_str::<Value>(&text)
    .map_err(|error| format!("刷新 OAuth token 响应解析失败: {error}"))?;
  let Some(object) = payload.as_object() else {
    return Err("刷新 OAuth token 响应不是 JSON object".to_string());
  };
  let access_token = string_from_map(object, "access_token");
  if access_token.is_empty() {
    return Err("刷新 OAuth token 响应没有 access_token".to_string());
  }
  Ok(RefreshedOAuthTokens {
    access_token,
    id_token: string_from_map(object, "id_token"),
    refresh_token: string_from_map(object, "refresh_token"),
  })
}

fn value_as_f64(value: &Value) -> Option<f64> {
  if let Some(number) = value.as_f64() {
    return Some(number);
  }
  let text = value.as_str()?.trim();
  if text.is_empty() {
    return None;
  }
  let cleaned = text
    .replace(',', "")
    .replace('%', "")
    .trim()
    .to_string();
  cleaned.parse::<f64>().ok()
}

fn normalize_key(value: &str) -> String {
  value
    .chars()
    .filter(|ch| ch.is_ascii_alphanumeric())
    .flat_map(|ch| ch.to_lowercase())
    .collect()
}

fn key_matches(key: &str, aliases: &[&str]) -> bool {
  let normalized = normalize_key(key);
  aliases.iter().any(|alias| normalized == normalize_key(alias))
}

fn map_number(map: &Map<String, Value>, aliases: &[&str]) -> Option<f64> {
  for (key, value) in map {
    if key_matches(key, aliases) {
      if let Some(number) = value_as_f64(value) {
        return Some(number);
      }
    }
  }
  None
}

fn normalize_remaining_percent(value: f64) -> f64 {
  let percent = if value > 0.0 && value <= 1.0 { value * 100.0 } else { value };
  percent.clamp(0.0, 100.0)
}

fn normalize_used_percent(value: f64) -> f64 {
  value.clamp(0.0, 100.0)
}

fn map_string(map: &Map<String, Value>, aliases: &[&str]) -> String {
  for (key, value) in map {
    if key_matches(key, aliases) {
      if let Some(text) = value.as_str().map(str::trim).filter(|text| !text.is_empty()) {
        return text.chars().take(80).collect();
      }
    }
  }
  String::new()
}

fn value_to_timestamp_iso(value: &Value) -> String {
  if let Some(text) = value.as_str().map(str::trim).filter(|text| !text.is_empty()) {
    if let Ok(number) = text.replace(',', "").parse::<f64>() {
      return number_to_timestamp_iso(number);
    }
    if DateTime::parse_from_rfc3339(text).is_ok() {
      return text.to_string();
    }
    return text.chars().take(120).collect();
  }
  value.as_f64().map(number_to_timestamp_iso).unwrap_or_default()
}

fn number_to_timestamp_iso(value: f64) -> String {
  if !value.is_finite() || value <= 0.0 {
    return String::new();
  }
  let millis = value > 10_000_000_000.0;
  let seconds = if millis { (value / 1000.0).floor() } else { value.floor() };
  let nanos = if millis {
    (((value / 1000.0) - seconds) * 1_000_000_000.0).round()
  } else {
    ((value - seconds) * 1_000_000_000.0).round()
  };
  DateTime::from_timestamp(seconds as i64, nanos.max(0.0).min(999_999_999.0) as u32)
    .map(|dt| dt.to_rfc3339())
    .unwrap_or_default()
}

fn map_timestamp(map: &Map<String, Value>, aliases: &[&str]) -> String {
  for (key, value) in map {
    if key_matches(key, aliases) {
      let iso = value_to_timestamp_iso(value);
      if !iso.is_empty() {
        return iso;
      }
    }
  }
  String::new()
}

fn find_number(value: &Value, aliases: &[&str]) -> Option<f64> {
  fn walk(value: &Value, aliases: &[&str], depth: usize) -> Option<f64> {
    if depth > 8 {
      return None;
    }
    match value {
      Value::Object(map) => {
        if let Some(number) = map_number(map, aliases) {
          return Some(number);
        }
        for child in map.values() {
          if child.is_object() || child.is_array() {
            if let Some(number) = walk(child, aliases, depth + 1) {
              return Some(number);
            }
          }
        }
        None
      }
      Value::Array(items) => {
        for child in items.iter().take(64) {
          if let Some(number) = walk(child, aliases, depth + 1) {
            return Some(number);
          }
        }
        None
      }
      _ => None,
    }
  }
  walk(value, aliases, 0)
}

fn find_string(value: &Value, aliases: &[&str]) -> String {
  fn walk(value: &Value, aliases: &[&str], depth: usize) -> String {
    if depth > 8 {
      return String::new();
    }
    match value {
      Value::Object(map) => {
        let text = map_string(map, aliases);
        if !text.is_empty() {
          return text;
        }
        for child in map.values() {
          if child.is_object() || child.is_array() {
            let found = walk(child, aliases, depth + 1);
            if !found.is_empty() {
              return found;
            }
          }
        }
        String::new()
      }
      Value::Array(items) => {
        for child in items.iter().take(64) {
          let found = walk(child, aliases, depth + 1);
          if !found.is_empty() {
            return found;
          }
        }
        String::new()
      }
      _ => String::new(),
    }
  }
  walk(value, aliases, 0)
}

fn find_timestamp(value: &Value, aliases: &[&str]) -> String {
  fn walk(value: &Value, aliases: &[&str], depth: usize) -> String {
    if depth > 8 {
      return String::new();
    }
    match value {
      Value::Object(map) => {
        let text = map_timestamp(map, aliases);
        if !text.is_empty() {
          return text;
        }
        for child in map.values() {
          if child.is_object() || child.is_array() {
            let found = walk(child, aliases, depth + 1);
            if !found.is_empty() {
              return found;
            }
          }
        }
        String::new()
      }
      Value::Array(items) => {
        for child in items.iter().take(64) {
          let found = walk(child, aliases, depth + 1);
          if !found.is_empty() {
            return found;
          }
        }
        String::new()
      }
      _ => String::new(),
    }
  }
  walk(value, aliases, 0)
}

fn infer_window_id(path: &str, label: &str) -> String {
  let text = normalize_key(&format!("{path} {label}"));
  if text.contains("review") {
    return "review".to_string();
  }
  if text.contains("week") || text.contains("weekly") || text.contains("secondary") {
    return "weekly".to_string();
  }
  if text.contains("fivehour") || text.contains("5hour") || text.contains("5h") || text.contains("primary") {
    return "five_hour".to_string();
  }
  if text.contains("daily") || text.contains("day") {
    return "daily".to_string();
  }
  "other".to_string()
}

fn display_label_for_window(id: &str, raw_label: &str) -> String {
  let cleaned = raw_label.trim();
  if !cleaned.is_empty() {
    return cleaned.to_string();
  }
  match id {
    "five_hour" => "5 小时".to_string(),
    "weekly" => "周限制".to_string(),
    "review" => "Review".to_string(),
    "daily" => "日限制".to_string(),
    _ => "额度窗口".to_string(),
  }
}

fn window_from_map(map: &Map<String, Value>, path: &str) -> Option<Value> {
  let limit = map_number(map, &[
    "limit",
    "max",
    "maximum",
    "quota",
    "total",
    "cap",
    "allocated",
  ]);
  let used = map_number(map, &["used", "usage", "consumed", "current", "spent"]);
  let used_percent = map_number(map, &[
    "used_percent",
    "used_percentage",
    "percent_used",
    "usage_percent",
    "usage_percentage",
  ]);
  let remaining = map_number(map, &[
    "remaining",
    "available",
    "left",
    "remain",
    "remaining_requests",
    "remaining_tokens",
  ]);
  let percent = map_number(map, &[
    "remaining_percent",
    "remaining_percentage",
    "available_percent",
    "available_percentage",
    "percent_remaining",
    "percent",
  ]);
  let reset_at = map_string(map, &[
    "reset_at",
    "resetAt",
    "resets_at",
    "reset_time",
    "primary_reset_at",
    "secondary_reset_at",
  ]);
  let reset_at = if reset_at.is_empty() {
    map_timestamp(map, &[
      "reset_at",
      "resetAt",
      "resets_at",
      "reset_time",
      "primary_reset_at",
      "secondary_reset_at",
    ])
  } else {
    reset_at
  };
  let reset_seconds = map_number(map, &[
    "reset_after_seconds",
    "resets_in_seconds",
    "seconds_until_reset",
    "reset_in_seconds",
  ]);
  let limit_window_seconds = map_number(map, &[
    "limit_window_seconds",
    "window_seconds",
    "period_seconds",
    "duration_seconds",
  ]);
  let raw_label = map_string(map, &[
    "name",
    "label",
    "title",
    "window",
    "period",
    "limit_name",
    "limitName",
    "type",
    "bucket",
  ]);

  let numeric_count = [limit, used, used_percent, remaining, percent, reset_seconds, limit_window_seconds]
    .iter()
    .filter(|item| item.is_some())
    .count();
  let path_hint = normalize_key(path);
  let likely_limit_path = path_hint.contains("limit")
    || path_hint.contains("quota")
    || path_hint.contains("usage")
    || path_hint.contains("window")
    || path_hint.contains("review")
    || path_hint.contains("primary")
    || path_hint.contains("secondary");
  if numeric_count == 0 || (!likely_limit_path && numeric_count < 2 && reset_at.is_empty()) {
    return None;
  }

  let id = infer_window_id(path, &raw_label);
  let remaining_value = remaining.or_else(|| {
    if let (Some(limit), Some(used)) = (limit, used) {
      Some((limit - used).max(0.0))
    } else {
      None
    }
  });
  let used_percent_value = used_percent.map(normalize_used_percent);
  let mut remaining_percent = percent.map(normalize_remaining_percent);
  if remaining_percent.is_none() {
    if let Some(used_percent) = used_percent_value {
      remaining_percent = Some((100.0 - used_percent).clamp(0.0, 100.0));
    }
  }
  if remaining_percent.is_none() {
    if let (Some(remaining), Some(limit)) = (remaining_value, limit) {
      if limit > 0.0 {
        remaining_percent = Some(normalize_remaining_percent(remaining / limit));
      }
    }
  }

  Some(json!({
    "id": id,
    "label": display_label_for_window(&id, &raw_label),
    "limit": limit,
    "used": used,
    "usedPercent": used_percent_value,
    "remaining": remaining_value,
    "remainingPercent": remaining_percent,
    "resetAt": reset_at,
    "resetInSeconds": reset_seconds,
    "limitWindowSeconds": limit_window_seconds,
    "sourcePath": path,
  }))
}

fn collect_windows(value: &Value) -> Vec<Value> {
  fn walk(value: &Value, path: &str, depth: usize, out: &mut Vec<Value>) {
    if depth > 8 || out.len() >= 24 {
      return;
    }
    match value {
      Value::Object(map) => {
        if let Some(window) = window_from_map(map, path) {
          out.push(window);
        }
        for (key, child) in map {
          if child.is_object() || child.is_array() {
            let child_path = if path.is_empty() { key.clone() } else { format!("{path}.{key}") };
            walk(child, &child_path, depth + 1, out);
          }
        }
      }
      Value::Array(items) => {
        for (index, child) in items.iter().take(64).enumerate() {
          if child.is_object() || child.is_array() {
            let child_path = if path.is_empty() { format!("[{index}]") } else { format!("{path}[{index}]") };
            walk(child, &child_path, depth + 1, out);
          }
        }
      }
      _ => {}
    }
  }
  let mut out = Vec::new();
  walk(value, "", 0, &mut out);
  out
}

fn first_window_by_id(windows: &[Value], id: &str) -> Value {
  windows
    .iter()
    .find(|item| item.get("id").and_then(Value::as_str).unwrap_or("") == id)
    .cloned()
    .unwrap_or(Value::Null)
}

fn min_remaining_percent(windows: &[Value]) -> Option<f64> {
  windows
    .iter()
    .filter_map(|item| item.get("remainingPercent").and_then(Value::as_f64))
    .filter(|value| value.is_finite())
    .fold(None, |acc: Option<f64>, value| Some(acc.map_or(value, |prev| prev.min(value))))
}

fn json_shape(value: &Value, depth: usize) -> Value {
  if depth > 3 {
    return json!("...");
  }
  match value {
    Value::Object(map) => {
      let mut out = Map::new();
      for (key, child) in map.iter().take(24) {
        out.insert(key.clone(), json_shape(child, depth + 1));
      }
      if map.len() > 24 {
        out.insert("_truncated".to_string(), json!(map.len() - 24));
      }
      Value::Object(out)
    }
    Value::Array(items) => {
      if let Some(first) = items.first() {
        json!([json_shape(first, depth + 1)])
      } else {
        json!([])
      }
    }
    Value::String(_) => json!("string"),
    Value::Number(_) => json!("number"),
    Value::Bool(_) => json!("boolean"),
    Value::Null => Value::Null,
  }
}

fn normalize_usage_payload(payload: &Value, account: &OAuthAccount, attempts: Vec<Value>, codex_home: &PathBuf) -> Value {
  let windows = collect_windows(payload);
  let remaining_percent = min_remaining_percent(&windows);
  let total_tokens = find_number(payload, &["total_tokens", "totalTokens", "tokens", "token_count"]);
  let input_tokens = find_number(payload, &["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
  let output_tokens = find_number(payload, &["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
  let requests = find_number(payload, &["requests", "request_count", "requestCount", "total_requests"]);
  let payload_email = find_string(payload, &["email", "user_email", "account_email"]);
  let payload_account_id = find_string(payload, &["account_id", "accountId", "chatgpt_account_id"]);
  let payload_plan = find_string(payload, &["plan_type", "planType", "plan", "tier", "subscription_plan"]);
  let membership_expires_at = find_timestamp(payload, &[
    "membership_expires_at",
    "subscription_expires_at",
    "subscription_expiry",
    "plan_expires_at",
    "expires_at",
    "expire_at",
    "expiry_at",
    "valid_until",
    "current_period_end",
    "period_end",
  ]);
  let membership_renews_at = find_timestamp(payload, &[
    "renews_at",
    "renew_at",
    "renewal_at",
    "next_renewal_at",
    "next_invoice_at",
    "billing_period_end",
  ]);
  let credits_balance = find_string(payload, &["balance", "credit_balance", "credits_balance"]);
  let credits_available = find_number(payload, &["available_count", "available_credits", "credits_available"]);

  json!({
    "status": "ok",
    "supported": true,
    "providerType": "codex-oauth",
    "message": if remaining_percent.is_some() { "Codex OAuth 官方额度已同步。" } else { "官方接口已返回，但没有识别到稳定额度字段。" },
    "baseUrl": "https://chatgpt.com",
    "codexHome": codex_home.to_string_lossy().to_string(),
    "account": {
      "email": if payload_email.is_empty() { account.email.clone() } else { payload_email },
      "plan": if payload_plan.is_empty() { account.plan.clone() } else { payload_plan.clone() },
      "planType": if payload_plan.is_empty() { account.plan.clone() } else { payload_plan },
      "accountId": if payload_account_id.is_empty() { account.account_id.clone() } else { payload_account_id },
      "sub": account.sub,
      "membership": {
        "expiresAt": membership_expires_at,
        "renewsAt": membership_renews_at,
      },
      "credits": {
        "balance": credits_balance,
        "availableCount": credits_available,
        "hasCredits": payload.pointer("/credits/has_credits").cloned().unwrap_or(Value::Null),
        "unlimited": payload.pointer("/credits/unlimited").cloned().unwrap_or(Value::Null),
      },
      "spendControl": payload.get("spend_control").cloned().unwrap_or(Value::Null),
    },
    "quota": {
      "remainingPercent": remaining_percent,
    },
    "summary": {
      "remainingPercent": remaining_percent,
      "primaryRemainingPercent": first_window_by_id(&windows, "five_hour").get("remainingPercent").cloned().unwrap_or(Value::Null),
      "secondaryRemainingPercent": first_window_by_id(&windows, "weekly").get("remainingPercent").cloned().unwrap_or(Value::Null),
      "fiveHour": first_window_by_id(&windows, "five_hour"),
      "weekly": first_window_by_id(&windows, "weekly"),
      "review": first_window_by_id(&windows, "review"),
    },
    "windows": windows,
    "usage": {
      "totalTokens": total_tokens,
      "inputTokens": input_tokens,
      "outputTokens": output_tokens,
      "requests": requests,
    },
    "rawShape": json_shape(payload, 0),
    "endpointsTried": attempts,
    "fetchedAt": Utc::now().to_rfc3339(),
  })
}

fn oauth_error_json(
  status: &str,
  message: &str,
  account: &OAuthAccount,
  attempts: Vec<Value>,
  codex_home: &PathBuf,
) -> Value {
  json!({
    "status": status,
    "supported": false,
    "providerType": "codex-oauth",
    "message": message,
    "baseUrl": "https://chatgpt.com",
    "codexHome": codex_home.to_string_lossy().to_string(),
    "account": {
      "email": account.email,
      "plan": account.plan,
      "accountId": account.account_id,
      "sub": account.sub,
    },
    "quota": { "remainingPercent": Value::Null },
    "summary": {
      "remainingPercent": Value::Null,
      "fiveHour": Value::Null,
      "weekly": Value::Null,
      "review": Value::Null,
    },
    "windows": [],
    "usage": {},
    "endpointsTried": attempts,
    "fetchedAt": Utc::now().to_rfc3339(),
  })
}

async fn run_codex_oauth_usage_probe(
  client: &Client,
  account: &mut OAuthAccount,
  codex_home: &PathBuf,
  attempts: &mut Vec<Value>,
) -> Result<UsageProbeOutcome, String> {
  let mut saw_auth_error = false;
  let mut saw_blocked = false;
  let mut saw_network_error = false;
  let mut first_json_payload: Option<Value> = None;
  let mut refreshed_access_token = false;

  let endpoint_specs = endpoints(!account.id_token.trim().is_empty());
  let mut index = 0usize;
  while index < endpoint_specs.len() {
    let spec = &endpoint_specs[index];
    let headers = match build_headers(&account, spec.token_kind) {
      Ok(headers) => headers,
      Err(error) => {
        attempts.push(endpoint_attempt(spec, "skipped", None, &error));
        index += 1;
        continue;
      }
    };
    let request = if spec.method == "POST" {
      client.post(spec.url).headers(headers.clone()).json(&json!({}))
    } else {
      client.get(spec.url).headers(headers.clone())
    };
    let response = match request.send().await {
      Ok(response) => response,
      Err(error) => {
        saw_network_error = true;
        let should_break_for_chatgpt_dns = spec.url.contains("chatgpt.com");
        attempts.push(endpoint_attempt(
          spec,
          if error.is_timeout() { "timeout" } else { "network_error" },
          None,
          &if error.is_timeout() { "请求超时".to_string() } else { error.to_string() },
        ));
        if should_break_for_chatgpt_dns {
          break;
        }
        index += 1;
        continue;
      }
    };

    let status = response.status();
    let status_code = status.as_u16();
    let headers_snapshot = response.headers().clone();
    let text = response.text().await.unwrap_or_default();

    if looks_like_cloudflare_block(status_code, &headers_snapshot, &text) {
      saw_blocked = true;
      attempts.push(endpoint_attempt(spec, "blocked", Some(status_code), "Cloudflare/bot challenge"));
      index += 1;
      continue;
    }
    if status_code == 401 || status_code == 403 {
      let body_message = short_body_message(&text);
      if spec.token_kind == "access_token" && !refreshed_access_token && !account.refresh_token.trim().is_empty() {
        attempts.push(endpoint_attempt(
          spec,
          "auth_error",
          Some(status_code),
          if body_message.is_empty() { "access_token 鉴权失败，尝试刷新 OAuth token" } else { &body_message },
        ));
        match refresh_codex_oauth_tokens(&client, &account.refresh_token).await {
          Ok(tokens) => {
            if let Err(error) = persist_refreshed_oauth_tokens(&codex_home, &tokens) {
              saw_auth_error = true;
              attempts.push(oauth_refresh_attempt(
                "persist_error",
                Some(200),
                &format!("OAuth token 已刷新，但写回 auth.json 失败: {error}"),
              ));
              break;
            }
            account.access_token = tokens.access_token;
            if !tokens.id_token.trim().is_empty() {
              account.id_token = tokens.id_token;
            }
            if !tokens.refresh_token.trim().is_empty() {
              account.refresh_token = tokens.refresh_token;
            }
            refreshed_access_token = true;
            saw_auth_error = false;
            attempts.push(oauth_refresh_attempt("ok", Some(200), "OAuth token 已刷新，重试官方额度接口"));
            index = 0;
            continue;
          }
          Err(error) => {
            saw_auth_error = true;
            attempts.push(oauth_refresh_attempt("auth_error", None, &error));
          }
        }
      } else {
        saw_auth_error = true;
      }
      attempts.push(endpoint_attempt(spec, "auth_error", Some(status_code), &body_message));
      index += 1;
      continue;
    }
    if status_code == 404 || status_code == 405 {
      attempts.push(endpoint_attempt(spec, "unsupported", Some(status_code), "接口不存在或方法不支持"));
      index += 1;
      continue;
    }
    if !status.is_success() {
      attempts.push(endpoint_attempt(spec, "http_error", Some(status_code), &short_body_message(&text)));
      index += 1;
      continue;
    }

    let payload = match serde_json::from_str::<Value>(&text) {
      Ok(payload) => payload,
      Err(error) => {
        attempts.push(endpoint_attempt(spec, "parse_error", Some(status_code), &error.to_string()));
        index += 1;
        continue;
      }
    };
    attempts.push(endpoint_attempt(spec, "ok", Some(status_code), "官方接口已返回 JSON"));
    if !collect_windows(&payload).is_empty() {
      return Ok(UsageProbeOutcome {
        first_json_payload: Some(payload),
        saw_auth_error,
        saw_blocked,
        saw_network_error,
      });
    }
    if first_json_payload.is_none() {
      first_json_payload = Some(payload);
    }
    index += 1;
  }

  Ok(UsageProbeOutcome {
    first_json_payload,
    saw_auth_error,
    saw_blocked,
    saw_network_error,
  })
}

pub(crate) async fn query_codex_oauth_usage(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let codex_home = resolve_codex_home(&object)?;
  let mut account = read_oauth_account(&codex_home)?;
  let fallback_timeout_ms = clamp_u64(
    object.get("fallbackTimeoutMs").and_then(Value::as_u64).unwrap_or(8_000),
    3_000,
    12_000,
  );
  let system_timeout_ms = clamp_u64(
    object
      .get("systemTimeoutMs")
      .and_then(Value::as_u64)
      .unwrap_or(CODEX_SYSTEM_ATTEMPT_TIMEOUT_MS),
    1_000,
    4_000,
  );

  let mut attempts = Vec::new();
  let mut used_dns_fallback = false;
  let mut outcome;

  if let Some(reason) = chatgpt_dns_fallback_reason().await {
    used_dns_fallback = true;
    attempts.push(dns_fallback_attempt(&format!(
      "{reason}，直接使用内置 Cloudflare 边缘 IP 查询官方额度接口。"
    )));
    let fallback_client = build_oauth_usage_client(fallback_timeout_ms, true)?;
    outcome = run_codex_oauth_usage_probe(&fallback_client, &mut account, &codex_home, &mut attempts).await?;
  } else {
    let client = build_oauth_usage_client(system_timeout_ms, false)?;
    outcome = run_codex_oauth_usage_probe(&client, &mut account, &codex_home, &mut attempts).await?;
  }

  if !used_dns_fallback && should_retry_chatgpt_dns_fallback(&outcome) {
    attempts.push(dns_fallback_attempt(
      "系统 DNS 访问 chatgpt.com 失败，使用内置 Cloudflare 边缘 IP 重试官方额度接口。",
    ));
    let fallback_client = build_oauth_usage_client(fallback_timeout_ms, true)?;
    outcome = run_codex_oauth_usage_probe(&fallback_client, &mut account, &codex_home, &mut attempts).await?;
  }

  if let Some(payload) = outcome.first_json_payload {
    return Ok(normalize_usage_payload(&payload, &account, attempts, &codex_home));
  }
  if outcome.saw_blocked {
    return Ok(oauth_error_json(
      "blocked",
      "官方接口被 Cloudflare/bot challenge 拦截，当前不支持自动查询。",
      &account,
      attempts,
      &codex_home,
    ));
  }
  if outcome.saw_auth_error {
    return Ok(oauth_error_json(
      "auth_error",
      "Codex OAuth token 无权访问官方额度接口，请重新登录或稍后再试。",
      &account,
      attempts,
      &codex_home,
    ));
  }
  if outcome.saw_network_error {
    return Ok(oauth_error_json(
      "network_error",
      "官方额度接口网络请求失败；如果 chatgpt.com 被解析到异常 IP，请切换 DNS/代理后重试。",
      &account,
      attempts,
      &codex_home,
    ));
  }
  Ok(oauth_error_json(
    "unsupported",
    "当前 Codex 官方接口没有返回可用额度数据。",
    &account,
    attempts,
    &codex_home,
  ))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn collect_windows_parses_wham_used_percent() {
    let payload = json!({
      "rate_limit": {
        "allowed": true,
        "limit_reached": false,
        "primary_window": {
          "used_percent": 1,
          "limit_window_seconds": 18000,
          "reset_after_seconds": 18000,
          "reset_at": 1783075018
        },
        "secondary_window": {
          "used_percent": 0,
          "limit_window_seconds": 604800,
          "reset_after_seconds": 604800,
          "reset_at": 1783661818
        }
      },
      "code_review_rate_limit": null
    });

    let windows = collect_windows(&payload);
    let five_hour = first_window_by_id(&windows, "five_hour");
    let weekly = first_window_by_id(&windows, "weekly");

    assert_eq!(five_hour.get("remainingPercent").and_then(Value::as_f64), Some(99.0));
    assert_eq!(five_hour.get("usedPercent").and_then(Value::as_f64), Some(1.0));
    assert_eq!(five_hour.get("resetInSeconds").and_then(Value::as_f64), Some(18000.0));
    assert_eq!(
      five_hour.get("resetAt").and_then(Value::as_str),
      Some("2026-07-03T10:36:58+00:00")
    );
    assert_eq!(five_hour.get("limitWindowSeconds").and_then(Value::as_f64), Some(18000.0));
    assert!(five_hour.get("remaining").is_some_and(Value::is_null));
    assert!(five_hour.get("limit").is_some_and(Value::is_null));

    assert_eq!(weekly.get("remainingPercent").and_then(Value::as_f64), Some(100.0));
    assert_eq!(weekly.get("usedPercent").and_then(Value::as_f64), Some(0.0));
    assert_eq!(weekly.get("resetInSeconds").and_then(Value::as_f64), Some(604800.0));
    assert_eq!(
      weekly.get("resetAt").and_then(Value::as_str),
      Some("2026-07-10T05:36:58+00:00")
    );
  }

  #[test]
  fn chatgpt_dns_prefers_fallback_for_non_cloudflare_addrs() {
    let bad = vec![IpAddr::V4(Ipv4Addr::new(31, 13, 67, 33))];
    let good = vec![IpAddr::V4(Ipv4Addr::new(104, 18, 37, 228))];

    assert!(chatgpt_dns_fallback_reason_for_addrs(&bad).is_some());
    assert!(chatgpt_dns_fallback_reason_for_addrs(&good).is_none());
  }
}
