use chrono::{Duration as ChronoDuration, Utc};
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, COOKIE, PRAGMA,
    SET_COOKIE, USER_AGENT,
};
use reqwest::Client;
use serde_json::{json, Map, Value};
use std::time::Duration;
use url::Url;

use crate::config::get_provider_secret;
use crate::parse_json_object;
use crate::provider::normalize_base_url;
use crate::{app_home, ensure_secret_dir, read_text, write_secret};

const NEWAPI_QUOTA_UNITS_PER_RMB: f64 = 500000.0;
const REMOTE_PANEL_CREDENTIALS_FILE: &str = "provider-remote-panel-credentials.json";

#[derive(Clone)]
struct EndpointSpec {
    id: &'static str,
    label: &'static str,
    panel_hint: &'static str,
    url: String,
}

#[derive(Clone)]
struct NumericField {
    value: f64,
    path: String,
}

#[derive(Default)]
struct RemoteUsageAggregate {
    provider_type: String,
    remaining: Option<NumericField>,
    used: Option<NumericField>,
    total: Option<NumericField>,
    cost: Option<NumericField>,
    tokens: Option<NumericField>,
    requests: Option<NumericField>,
    currency: String,
    balance_unit: String,
    usage_unit: String,
    source_endpoints: Vec<String>,
}

#[derive(Clone, Debug)]
struct RemotePanelCredential {
    provider_key: String,
    tool: String,
    panel_type: String,
    auth_mode: String,
    base_url: String,
    username: String,
    email: String,
    password: String,
    user_id: String,
    access_token: String,
    saved_at: String,
}

fn clamp_u64(value: u64, min: u64, max: u64) -> u64 {
    value.max(min).min(max)
}

fn normalized_key(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect()
}

fn clean_string(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn remote_panel_credential_key(tool: &str, provider_key: &str) -> String {
    format!("{}::{}", tool.trim().to_lowercase(), provider_key.trim())
}

fn remote_panel_credentials_path() -> Result<std::path::PathBuf, String> {
    Ok(app_home()?.join(REMOTE_PANEL_CREDENTIALS_FILE))
}

fn read_remote_panel_credentials_store() -> Result<Value, String> {
    let path = remote_panel_credentials_path()?;
    let raw = read_text(&path)?;
    if raw.trim().is_empty() {
        return Ok(json!({ "version": 1, "records": {} }));
    }
    let mut parsed = serde_json::from_str::<Value>(&raw)
        .unwrap_or_else(|_| json!({ "version": 1, "records": {} }));
    if !parsed.get("records").map(Value::is_object).unwrap_or(false) {
        parsed["records"] = json!({});
    }
    Ok(parsed)
}

fn write_remote_panel_credentials_store(value: &Value) -> Result<(), String> {
    let path = remote_panel_credentials_path()?;
    if let Some(parent) = path.parent() {
        ensure_secret_dir(parent)?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    write_secret(&path, &format!("{text}\n"))
}

fn credential_from_value(provider_key: &str, tool: &str, value: &Value) -> RemotePanelCredential {
    RemotePanelCredential {
        provider_key: provider_key.to_string(),
        tool: tool.to_string(),
        panel_type: clean_string(value.get("panelType")).to_lowercase(),
        auth_mode: clean_string(value.get("authMode")).to_lowercase(),
        base_url: clean_string(value.get("baseUrl")),
        username: clean_string(value.get("username")),
        email: clean_string(value.get("email")),
        password: clean_string(value.get("password")),
        user_id: clean_string(value.get("userId")),
        access_token: clean_string(value.get("accessToken")),
        saved_at: clean_string(value.get("savedAt")),
    }
}

fn sanitize_remote_panel_credential(credential: &RemotePanelCredential) -> Value {
    json!({
      "exists": true,
      "providerKey": credential.provider_key.clone(),
      "tool": credential.tool.clone(),
      "panelType": credential.panel_type.clone(),
      "authMode": credential.auth_mode.clone(),
      "baseUrl": credential.base_url.clone(),
      "panelUrl": management_root(&credential.base_url),
      "username": credential.username.clone(),
      "email": credential.email.clone(),
      "userId": credential.user_id.clone(),
      "hasPassword": !credential.password.is_empty(),
      "hasAccessToken": !credential.access_token.is_empty(),
      "savedAt": credential.saved_at.clone(),
    })
}

fn read_remote_panel_credential(
    tool: &str,
    provider_key: &str,
) -> Result<Option<RemotePanelCredential>, String> {
    let store = read_remote_panel_credentials_store()?;
    let key = remote_panel_credential_key(tool, provider_key);
    let Some(raw) = store
        .get("records")
        .and_then(Value::as_object)
        .and_then(|records| records.get(&key))
    else {
        return Ok(None);
    };
    Ok(Some(credential_from_value(provider_key, tool, raw)))
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
        .replace('$', "")
        .replace('¥', "")
        .replace('￥', "")
        .replace('%', "")
        .trim()
        .to_string();
    cleaned.parse::<f64>().ok()
}

fn value_as_short_string(value: &Value) -> Option<String> {
    let text = value.as_str()?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.chars().take(24).collect())
    }
}

fn key_matches(key: &str, aliases: &[&str]) -> bool {
    let clean = normalized_key(key);
    aliases.iter().any(|alias| clean == normalized_key(alias))
}

fn find_number_with_path(value: &Value, aliases: &[&str]) -> Option<NumericField> {
    fn walk(value: &Value, aliases: &[&str], path: &str, depth: usize) -> Option<NumericField> {
        if depth > 7 {
            return None;
        }
        match value {
            Value::Object(map) => {
                for (key, child) in map {
                    if key_matches(key, aliases) {
                        if let Some(number) = value_as_f64(child) {
                            return Some(NumericField {
                                value: number,
                                path: if path.is_empty() {
                                    key.clone()
                                } else {
                                    format!("{path}.{key}")
                                },
                            });
                        }
                    }
                }
                for (key, child) in map {
                    if child.is_object() || child.is_array() {
                        let child_path = if path.is_empty() {
                            key.clone()
                        } else {
                            format!("{path}.{key}")
                        };
                        if let Some(found) = walk(child, aliases, &child_path, depth + 1) {
                            return Some(found);
                        }
                    }
                }
                None
            }
            Value::Array(items) => {
                for (index, child) in items.iter().take(32).enumerate() {
                    let child_path = if path.is_empty() {
                        format!("[{index}]")
                    } else {
                        format!("{path}[{index}]")
                    };
                    if let Some(found) = walk(child, aliases, &child_path, depth + 1) {
                        return Some(found);
                    }
                }
                None
            }
            _ => None,
        }
    }

    walk(value, aliases, "", 0)
}

fn find_string_with_path(value: &Value, aliases: &[&str]) -> Option<String> {
    fn walk(value: &Value, aliases: &[&str], depth: usize) -> Option<String> {
        if depth > 6 {
            return None;
        }
        match value {
            Value::Object(map) => {
                for (key, child) in map {
                    if key_matches(key, aliases) {
                        if let Some(text) = value_as_short_string(child) {
                            return Some(text);
                        }
                    }
                }
                for child in map.values() {
                    if child.is_object() || child.is_array() {
                        if let Some(found) = walk(child, aliases, depth + 1) {
                            return Some(found);
                        }
                    }
                }
                None
            }
            Value::Array(items) => {
                for child in items.iter().take(32) {
                    if let Some(found) = walk(child, aliases, depth + 1) {
                        return Some(found);
                    }
                }
                None
            }
            _ => None,
        }
    }

    walk(value, aliases, 0)
}

fn data_view(payload: &Value) -> &Value {
    payload.get("data").unwrap_or(payload)
}

fn payload_contains_key(payload: &Value, aliases: &[&str]) -> bool {
    find_number_with_path(payload, aliases).is_some()
        || find_string_with_path(payload, aliases).is_some()
}

fn infer_provider_type(endpoint: &EndpointSpec, payload: &Value, base_url: &str) -> String {
    let host = Url::parse(base_url)
        .ok()
        .and_then(|url| url.host_str().map(|host| host.to_lowercase()))
        .unwrap_or_default();
    let text = serde_json::to_string(payload)
        .unwrap_or_default()
        .to_lowercase();
    if host.contains("sub2api") || text.contains("sub2api") {
        return "sub2api".to_string();
    }
    if endpoint.panel_hint == "newapi"
        || text.contains("new-api")
        || payload_contains_key(
            payload,
            &["used_quota", "remain_quota", "request_count", "quota"],
        )
    {
        return "newapi".to_string();
    }
    if endpoint.panel_hint == "billing" {
        return "openai-compatible-billing".to_string();
    }
    "unknown".to_string()
}

fn merge_field(target: &mut Option<NumericField>, next: Option<NumericField>) {
    if target.is_none() {
        *target = next;
    }
}

fn extract_metrics(
    endpoint: &EndpointSpec,
    payload: &Value,
    base_url: &str,
) -> RemoteUsageAggregate {
    let data = data_view(payload);
    let mut out = RemoteUsageAggregate {
        provider_type: infer_provider_type(endpoint, payload, base_url),
        ..RemoteUsageAggregate::default()
    };

    out.remaining = find_number_with_path(
        data,
        &[
            "remaining",
            "remain",
            "remain_quota",
            "remaining_quota",
            "available",
            "available_quota",
            "quota",
            "balance",
            "credit",
            "credits",
            "grant_amount",
            "total_available",
        ],
    );
    out.used = find_number_with_path(
        data,
        &[
            "used",
            "used_quota",
            "used_amount",
            "consumed",
            "spent",
            "total_used",
            "total_usage",
        ],
    );
    out.total = find_number_with_path(
        data,
        &[
            "total",
            "total_quota",
            "quota_limit",
            "hard_limit",
            "hard_limit_usd",
            "system_hard_limit",
            "system_hard_limit_usd",
            "grants_total",
        ],
    );
    out.cost = find_number_with_path(
        data,
        &[
            "cost",
            "total_cost",
            "total_cost_usd",
            "amount",
            "total_amount",
            "total_usage",
            "used_amount",
            "spent",
        ],
    );
    out.tokens = find_number_with_path(
        data,
        &[
            "total_tokens",
            "total_token",
            "tokens",
            "token_count",
            "used_tokens",
        ],
    );
    if out.tokens.is_none() {
        let prompt = find_number_with_path(data, &["prompt_tokens", "input_tokens"]);
        let completion = find_number_with_path(data, &["completion_tokens", "output_tokens"]);
        if prompt.is_some() || completion.is_some() {
            out.tokens = Some(NumericField {
                value: prompt.as_ref().map(|item| item.value).unwrap_or(0.0)
                    + completion.as_ref().map(|item| item.value).unwrap_or(0.0),
                path: "prompt_tokens+completion_tokens".to_string(),
            });
        }
    }
    out.requests = find_number_with_path(
        data,
        &[
            "request_count",
            "requests",
            "request_total",
            "total_requests",
            "count",
        ],
    );
    out.currency = find_string_with_path(data, &["currency", "currency_code"]).unwrap_or_default();

    let signal_paths = [
        out.remaining.as_ref().map(|item| item.path.as_str()),
        out.used.as_ref().map(|item| item.path.as_str()),
        out.total.as_ref().map(|item| item.path.as_str()),
        out.cost.as_ref().map(|item| item.path.as_str()),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ");
    let signal_lc = signal_paths.to_lowercase();
    out.balance_unit = if !out.currency.is_empty() {
        out.currency.clone()
    } else if signal_lc.contains("usd") {
        "USD".to_string()
    } else if signal_lc.contains("balance") || signal_lc.contains("credit") {
        "credit".to_string()
    } else {
        "quota".to_string()
    };
    out.usage_unit = if !out.currency.is_empty() {
        out.currency.clone()
    } else if signal_lc.contains("usd") || endpoint.panel_hint == "billing" {
        "USD".to_string()
    } else {
        "raw".to_string()
    };
    out
}

fn merge_metrics(target: &mut RemoteUsageAggregate, next: RemoteUsageAggregate, endpoint_id: &str) {
    let had_signal = next.remaining.is_some()
        || next.used.is_some()
        || next.total.is_some()
        || next.cost.is_some()
        || next.tokens.is_some()
        || next.requests.is_some();
    if !had_signal {
        return;
    }
    if target.provider_type.is_empty() || target.provider_type == "unknown" {
        target.provider_type = next.provider_type;
    }
    merge_field(&mut target.remaining, next.remaining);
    merge_field(&mut target.used, next.used);
    merge_field(&mut target.total, next.total);
    merge_field(&mut target.cost, next.cost);
    merge_field(&mut target.tokens, next.tokens);
    merge_field(&mut target.requests, next.requests);
    if target.currency.is_empty() {
        target.currency = next.currency;
    }
    if target.balance_unit.is_empty() {
        target.balance_unit = next.balance_unit;
    }
    if target.usage_unit.is_empty() {
        target.usage_unit = next.usage_unit;
    }
    if !target
        .source_endpoints
        .iter()
        .any(|item| item == endpoint_id)
    {
        target.source_endpoints.push(endpoint_id.to_string());
    }
}

fn clean_base(base_url: &str) -> Result<String, String> {
    normalize_base_url(base_url).or_else(|_| {
        Url::parse(base_url.trim())
            .map(|url| url.to_string().trim_end_matches('/').to_string())
            .map_err(|error| error.to_string())
    })
}

fn management_root(base_url: &str) -> String {
    let mut url = match Url::parse(base_url) {
        Ok(url) => url,
        Err(_) => return base_url.trim_end_matches('/').to_string(),
    };
    let path = url.path().trim_end_matches('/').to_string();
    let lower = path.to_lowercase();
    let suffixes = [
        "/api/openai/v1",
        "/api/openai-compatible/v1",
        "/api/compatible-mode/v1",
        "/compatible-mode/v1",
        "/openai-compatible/v1",
        "/openai/v1",
        "/api/v1",
        "/v1",
    ];
    let next_path = if let Some(suffix) = suffixes
        .iter()
        .find(|suffix| lower.as_str() == **suffix || lower.ends_with(**suffix))
    {
        path[..path.len().saturating_sub(suffix.len())]
            .trim_end_matches('/')
            .to_string()
    } else if lower == "/api" {
        String::new()
    } else {
        path
    };
    url.set_path(&next_path);
    url.set_query(None);
    url.set_fragment(None);
    url.to_string().trim_end_matches('/').to_string()
}

fn join_url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

fn push_endpoint(
    endpoints: &mut Vec<EndpointSpec>,
    id: &'static str,
    label: &'static str,
    panel_hint: &'static str,
    url: String,
) {
    if endpoints.iter().any(|item| item.url == url) {
        return;
    }
    endpoints.push(EndpointSpec {
        id,
        label,
        panel_hint,
        url,
    });
}

fn candidate_endpoints(base_url: &str, days: u64) -> Vec<EndpointSpec> {
    let base = base_url.trim_end_matches('/').to_string();
    let root = management_root(&base);
    let end_date = Utc::now().date_naive();
    let start_date = end_date - ChronoDuration::days(days.saturating_sub(1) as i64);
    let usage_query = format!(
        "start_date={}&end_date={}",
        start_date.format("%Y-%m-%d"),
        end_date.format("%Y-%m-%d")
    );

    let mut endpoints = Vec::new();
    push_endpoint(
        &mut endpoints,
        "newapi_user_self",
        "NewAPI 用户余额",
        "newapi",
        join_url(&root, "/api/user/self"),
    );
    push_endpoint(
        &mut endpoints,
        "newapi_token_self",
        "NewAPI Token 余额",
        "newapi",
        join_url(&root, "/api/token/self"),
    );

    let billing_bases = [base.clone(), join_url(&root, "/v1"), root.clone()];
    for billing_base in billing_bases {
        push_endpoint(
            &mut endpoints,
            "billing_subscription",
            "OpenAI-compatible 余额",
            "billing",
            join_url(&billing_base, "/dashboard/billing/subscription"),
        );
        push_endpoint(
            &mut endpoints,
            "billing_usage",
            "OpenAI-compatible 用量",
            "billing",
            format!(
                "{}?{}",
                join_url(&billing_base, "/dashboard/billing/usage"),
                usage_query
            ),
        );
    }

    endpoints
}

fn build_headers(api_key: &str) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/json, text/plain, */*"),
    );
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static("EasyAIConfig/1.0 relay-usage-check"),
    );
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.insert(PRAGMA, HeaderValue::from_static("no-cache"));
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", api_key.trim()))
            .map_err(|error| error.to_string())?,
    );
    Ok(headers)
}

fn build_panel_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/json, text/plain, */*"),
    );
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static("EasyAIConfig/1.0 relay-panel-usage"),
    );
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.insert(PRAGMA, HeaderValue::from_static("no-cache"));
    headers
}

fn build_newapi_access_headers(access_token: &str, user_id: &str) -> Result<HeaderMap, String> {
    let mut headers = build_panel_headers();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", access_token.trim()))
            .map_err(|error| error.to_string())?,
    );
    if !user_id.trim().is_empty() {
        let value = HeaderValue::from_str(user_id.trim()).map_err(|error| error.to_string())?;
        headers.insert("X-User-Id", value.clone());
        headers.insert("New-Api-User", value);
    }
    Ok(headers)
}

fn set_cookie_header_from_response(
    headers: &HeaderMap,
    target: &mut HeaderMap,
) -> Result<bool, String> {
    let cookies = headers
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(|raw| raw.split(';').next())
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("; ");
    if cookies.is_empty() {
        return Ok(false);
    }
    target.insert(
        COOKIE,
        HeaderValue::from_str(&cookies).map_err(|error| error.to_string())?,
    );
    Ok(true)
}

fn api_response_message(payload: &Value) -> String {
    payload
        .get("message")
        .or_else(|| payload.get("msg"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn parse_wrapped_data(text: &str) -> Result<Value, String> {
    let payload = serde_json::from_str::<Value>(text).map_err(|error| error.to_string())?;
    if payload.get("success").and_then(Value::as_bool) == Some(false) {
        let message = api_response_message(&payload);
        return Err(if message.is_empty() {
            "upstream returned success=false".to_string()
        } else {
            message
        });
    }
    if let Some(data) = payload.get("data") {
        return Ok(data.clone());
    }
    Ok(payload)
}

fn value_number_any(value: &Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(number) = value.get(*key).and_then(value_as_f64) {
            return Some(number);
        }
    }
    None
}

fn value_string_any(value: &Value, keys: &[&str]) -> String {
    for key in keys {
        let text = clean_string(value.get(*key));
        if !text.is_empty() {
            return text;
        }
    }
    String::new()
}

fn header_text(headers: &HeaderMap, name: &str) -> String {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

fn looks_like_cloudflare_block(status_code: u16, headers: &HeaderMap, body: &str) -> bool {
    let server = header_text(headers, "server").to_lowercase();
    let cf_mitigated = header_text(headers, "cf-mitigated").to_lowercase();
    let content_type = header_text(headers, "content-type").to_lowercase();
    let text = body.to_lowercase();
    let challenge_text = text.contains("just a moment")
        || text.contains("cf-chl")
        || text.contains("challenge-platform")
        || text.contains("turnstile")
        || text.contains("/cdn-cgi/challenge-platform")
        || text.contains("checking your browser");
    cf_mitigated.contains("challenge")
        || ((status_code == 403 || status_code == 503 || status_code == 429)
            && challenge_text
            && (server.contains("cloudflare")
                || content_type.contains("text/html")
                || text.contains("cloudflare")))
}

fn short_body_message(body: &str) -> String {
    let clean = body.split_whitespace().collect::<Vec<_>>().join(" ");
    clean.chars().take(160).collect()
}

fn attempt_json(
    endpoint: &EndpointSpec,
    status: &str,
    status_code: Option<u16>,
    message: &str,
) -> Value {
    json!({
      "endpoint": endpoint.id,
      "label": endpoint.label,
      "status": status,
      "statusCode": status_code,
      "message": message,
    })
}

fn field_value(field: &Option<NumericField>) -> Option<f64> {
    field.as_ref().map(|item| item.value)
}

fn field_source(field: &Option<NumericField>) -> Option<String> {
    field.as_ref().map(|item| item.path.clone())
}

fn aggregate_to_json(
    aggregate: &mut RemoteUsageAggregate,
    base_url: &str,
    provider_key: &str,
    days: u64,
    attempts: Vec<Value>,
) -> Value {
    if aggregate.total.is_none() {
        if let (Some(remaining), Some(used)) = (&aggregate.remaining, &aggregate.used) {
            aggregate.total = Some(NumericField {
                value: remaining.value + used.value,
                path: format!("{} + {}", remaining.path, used.path),
            });
        }
    }
    let provider_type = if aggregate.provider_type.is_empty() {
        "unknown"
    } else {
        &aggregate.provider_type
    };
    json!({
      "status": "ok",
      "supported": true,
      "providerType": provider_type,
      "providerKey": provider_key,
      "baseUrl": base_url,
      "checkedAt": Utc::now().to_rfc3339(),
      "period": {
        "days": days,
      },
      "balance": {
        "remaining": field_value(&aggregate.remaining),
        "remainingSource": field_source(&aggregate.remaining),
        "used": field_value(&aggregate.used),
        "usedSource": field_source(&aggregate.used),
        "total": field_value(&aggregate.total),
        "totalSource": field_source(&aggregate.total),
        "unit": if aggregate.balance_unit.is_empty() { "raw" } else { &aggregate.balance_unit },
        "currency": if aggregate.currency.is_empty() { Value::Null } else { json!(aggregate.currency) },
      },
      "usage": {
        "cost": field_value(&aggregate.cost),
        "costSource": field_source(&aggregate.cost),
        "totalTokens": field_value(&aggregate.tokens),
        "tokensSource": field_source(&aggregate.tokens),
        "requests": field_value(&aggregate.requests),
        "requestsSource": field_source(&aggregate.requests),
        "unit": if aggregate.usage_unit.is_empty() { "raw" } else { &aggregate.usage_unit },
      },
      "source": {
        "endpoints": aggregate.source_endpoints,
      },
      "endpointsTried": attempts,
      "message": "远程中转统计已同步；字段按面板返回的原始单位展示。",
    })
}

fn remote_error_json(
    status: &str,
    provider_type: &str,
    provider_key: &str,
    base_url: &str,
    message: &str,
    attempts: Vec<Value>,
) -> Value {
    json!({
      "status": status,
      "supported": false,
      "providerType": provider_type,
      "providerKey": provider_key,
      "baseUrl": base_url,
      "panelUrl": management_root(base_url),
      "checkedAt": Utc::now().to_rfc3339(),
      "message": message,
      "endpointsTried": attempts,
    })
}

fn attach_remote_auth_info(result: &mut Value, credential: &RemotePanelCredential) {
    if let Some(map) = result.as_object_mut() {
        map.insert(
            "panelUrl".to_string(),
            json!(management_root(&credential.base_url)),
        );
        map.insert(
            "auth".to_string(),
            json!({
              "mode": credential.auth_mode.clone(),
              "panelType": credential.panel_type.clone(),
              "saved": true,
              "username": credential.username.clone(),
              "email": credential.email.clone(),
              "userId": credential.user_id.clone(),
            }),
        );
    }
}

async fn panel_get_text(
    client: &Client,
    url: &str,
    headers: HeaderMap,
) -> Result<(u16, HeaderMap, String), String> {
    let response = client
        .get(url)
        .headers(headers)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let text = response.text().await.unwrap_or_default();
    Ok((status, headers, text))
}

async fn panel_post_json(
    client: &Client,
    url: &str,
    headers: HeaderMap,
    payload: Value,
) -> Result<(u16, HeaderMap, String), String> {
    let response = client
        .post(url)
        .headers(headers)
        .json(&payload)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let text = response.text().await.unwrap_or_default();
    Ok((status, headers, text))
}

fn panel_attempt(
    endpoint: &EndpointSpec,
    status: &str,
    status_code: Option<u16>,
    message: &str,
) -> Value {
    attempt_json(endpoint, status, status_code, message)
}

fn newapi_login_payload_data(text: &str) -> Result<Value, String> {
    let data = parse_wrapped_data(text)?;
    if data
        .get("require_2fa")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err("账号启用了 2FA，当前不支持自动登录查询".to_string());
    }
    Ok(data)
}

async fn query_newapi_panel_usage(
    client: &Client,
    credential: &RemotePanelCredential,
    days: u64,
) -> Result<Value, String> {
    let root = management_root(&credential.base_url);
    let mut attempts = Vec::new();
    let mut headers = build_panel_headers();
    let mut login_user_id: String;

    if credential.auth_mode == "newapi_password" {
        let endpoint = EndpointSpec {
            id: "newapi_panel_login",
            label: "NewAPI 用户登录",
            panel_hint: "newapi",
            url: join_url(&root, "/api/user/login"),
        };
        let (status_code, response_headers, text) = match panel_post_json(
            client,
            &endpoint.url,
            build_panel_headers(),
            json!({ "username": credential.username, "password": credential.password }),
        )
        .await
        {
            Ok(output) => output,
            Err(error) => {
                attempts.push(panel_attempt(&endpoint, "network_error", None, &error));
                return Ok(remote_error_json(
                    "auth_error",
                    "newapi",
                    &credential.provider_key,
                    &credential.base_url,
                    "NewAPI 面板登录请求失败。",
                    attempts,
                ));
            }
        };
        if looks_like_cloudflare_block(status_code, &response_headers, &text) {
            attempts.push(panel_attempt(
                &endpoint,
                "blocked",
                Some(status_code),
                "Cloudflare/bot challenge",
            ));
            return Ok(remote_error_json(
                "blocked",
                "cloudflare-protected",
                &credential.provider_key,
                &credential.base_url,
                "该中转面板存在 Cloudflare/bot 拦截，当前不支持自动查询余额/远程用量。",
                attempts,
            ));
        }
        if status_code != 200 {
            attempts.push(panel_attempt(
                &endpoint,
                "auth_error",
                Some(status_code),
                &short_body_message(&text),
            ));
            return Ok(remote_error_json(
                "auth_error",
                "newapi",
                &credential.provider_key,
                &credential.base_url,
                "NewAPI 用户名/密码登录失败。",
                attempts,
            ));
        }
        let data = match newapi_login_payload_data(&text) {
            Ok(data) => data,
            Err(error) => {
                attempts.push(panel_attempt(
                    &endpoint,
                    "auth_error",
                    Some(status_code),
                    &error,
                ));
                return Ok(remote_error_json(
                    "auth_error",
                    "newapi",
                    &credential.provider_key,
                    &credential.base_url,
                    &error,
                    attempts,
                ));
            }
        };
        login_user_id = value_string_any(&data, &["id", "user_id"]);
        let cookie_ok = set_cookie_header_from_response(&response_headers, &mut headers)?;
        let login_access_token = value_string_any(&data, &["access_token", "accessToken"]);
        if !login_access_token.is_empty() {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {login_access_token}"))
                    .map_err(|error| error.to_string())?,
            );
        }
        if !login_user_id.is_empty() {
            let value = HeaderValue::from_str(&login_user_id).map_err(|error| error.to_string())?;
            headers.insert("X-User-Id", value.clone());
            headers.insert("New-Api-User", value);
        }
        if !cookie_ok && login_access_token.is_empty() {
            attempts.push(panel_attempt(
                &endpoint,
                "auth_error",
                Some(status_code),
                "登录成功但未返回会话 Cookie 或 access_token",
            ));
            return Ok(remote_error_json(
                "auth_error",
                "newapi",
                &credential.provider_key,
                &credential.base_url,
                "NewAPI 登录成功但未返回可用于查询的会话凭据。",
                attempts,
            ));
        }
        attempts.push(panel_attempt(
            &endpoint,
            "ok",
            Some(status_code),
            "已登录并取得面板会话",
        ));
    } else {
        headers = build_newapi_access_headers(&credential.access_token, &credential.user_id)?;
        login_user_id = credential.user_id.clone();
    }

    let user_endpoint = EndpointSpec {
        id: "newapi_user_self",
        label: "NewAPI 用户余额",
        panel_hint: "newapi",
        url: join_url(&root, "/api/user/self"),
    };
    let (status_code, response_headers, text) =
        match panel_get_text(client, &user_endpoint.url, headers.clone()).await {
            Ok(output) => output,
            Err(error) => {
                attempts.push(panel_attempt(&user_endpoint, "network_error", None, &error));
                return Ok(remote_error_json(
                    "auth_error",
                    "newapi",
                    &credential.provider_key,
                    &credential.base_url,
                    "NewAPI 用户信息查询失败。",
                    attempts,
                ));
            }
        };
    if looks_like_cloudflare_block(status_code, &response_headers, &text) {
        attempts.push(panel_attempt(
            &user_endpoint,
            "blocked",
            Some(status_code),
            "Cloudflare/bot challenge",
        ));
        return Ok(remote_error_json(
            "blocked",
            "cloudflare-protected",
            &credential.provider_key,
            &credential.base_url,
            "该中转面板存在 Cloudflare/bot 拦截，当前不支持自动查询余额/远程用量。",
            attempts,
        ));
    }
    if status_code == 401 || status_code == 403 {
        attempts.push(panel_attempt(
            &user_endpoint,
            "auth_error",
            Some(status_code),
            "用户凭据无权访问 /api/user/self",
        ));
        return Ok(remote_error_json(
            "auth_error",
            "newapi",
            &credential.provider_key,
            &credential.base_url,
            "NewAPI 面板凭据无权访问用户余额接口。",
            attempts,
        ));
    }
    if status_code != 200 {
        attempts.push(panel_attempt(
            &user_endpoint,
            "http_error",
            Some(status_code),
            &short_body_message(&text),
        ));
        return Ok(remote_error_json(
            "unsupported",
            "newapi",
            &credential.provider_key,
            &credential.base_url,
            "NewAPI 用户余额接口返回异常。",
            attempts,
        ));
    }
    let user_data = match parse_wrapped_data(&text) {
        Ok(data) => data,
        Err(error) => {
            attempts.push(panel_attempt(
                &user_endpoint,
                "parse_error",
                Some(status_code),
                &error,
            ));
            return Ok(remote_error_json(
                "unsupported",
                "newapi",
                &credential.provider_key,
                &credential.base_url,
                "NewAPI 用户余额响应无法解析。",
                attempts,
            ));
        }
    };
    attempts.push(panel_attempt(
        &user_endpoint,
        "ok",
        Some(status_code),
        "已读取用户 quota",
    ));

    let quota = value_number_any(&user_data, &["quota"]).unwrap_or(0.0);
    let used_quota = value_number_any(&user_data, &["used_quota"]).unwrap_or(0.0);
    let request_count = value_number_any(&user_data, &["request_count"]);
    let mut aggregate = RemoteUsageAggregate {
        provider_type: "newapi".to_string(),
        remaining: Some(NumericField {
            value: quota / NEWAPI_QUOTA_UNITS_PER_RMB,
            path: "data.quota / 500000".to_string(),
        }),
        used: Some(NumericField {
            value: used_quota / NEWAPI_QUOTA_UNITS_PER_RMB,
            path: "data.used_quota / 500000".to_string(),
        }),
        total: Some(NumericField {
            value: (quota + used_quota) / NEWAPI_QUOTA_UNITS_PER_RMB,
            path: "(data.quota + data.used_quota) / 500000".to_string(),
        }),
        requests: request_count.map(|value| NumericField {
            value,
            path: "data.request_count".to_string(),
        }),
        balance_unit: "RMB".to_string(),
        usage_unit: "RMB".to_string(),
        source_endpoints: vec!["newapi_user_self".to_string()],
        ..RemoteUsageAggregate::default()
    };

    if login_user_id.is_empty() {
        login_user_id = value_string_any(&user_data, &["id", "user_id"]);
    }

    let stat_endpoint = EndpointSpec {
        id: "newapi_log_self_stat",
        label: "NewAPI 远程消耗",
        panel_hint: "newapi",
        url: join_url(&root, "/api/log/self/stat"),
    };
    if let Ok((stat_code, stat_headers, stat_text)) =
        panel_get_text(client, &stat_endpoint.url, headers).await
    {
        if looks_like_cloudflare_block(stat_code, &stat_headers, &stat_text) {
            attempts.push(panel_attempt(
                &stat_endpoint,
                "blocked",
                Some(stat_code),
                "Cloudflare/bot challenge",
            ));
        } else if stat_code == 200 {
            match parse_wrapped_data(&stat_text) {
                Ok(stat_data) => {
                    if let Some(stat_quota) = value_number_any(&stat_data, &["quota"]) {
                        aggregate.cost = Some(NumericField {
                            value: stat_quota / NEWAPI_QUOTA_UNITS_PER_RMB,
                            path: "data.quota / 500000".to_string(),
                        });
                        aggregate
                            .source_endpoints
                            .push("newapi_log_self_stat".to_string());
                    }
                    attempts.push(panel_attempt(
                        &stat_endpoint,
                        "ok",
                        Some(stat_code),
                        "已读取用户统计",
                    ));
                }
                Err(error) => attempts.push(panel_attempt(
                    &stat_endpoint,
                    "parse_error",
                    Some(stat_code),
                    &error,
                )),
            }
        } else {
            attempts.push(panel_attempt(
                &stat_endpoint,
                if stat_code == 401 || stat_code == 403 {
                    "auth_error"
                } else {
                    "http_error"
                },
                Some(stat_code),
                &short_body_message(&stat_text),
            ));
        }
    }

    let mut result = aggregate_to_json(
        &mut aggregate,
        &credential.base_url,
        &credential.provider_key,
        days,
        attempts,
    );
    attach_remote_auth_info(&mut result, credential);
    if let Some(auth) = result.get_mut("auth").and_then(Value::as_object_mut) {
        auth.insert("userIdResolved".to_string(), json!(login_user_id));
    }
    Ok(result)
}

fn sub2api_subscription_remaining_usd(data: &Value) -> Option<f64> {
    let items = data.as_array()?;
    let mut total = 0.0;
    let mut known = false;
    for item in items {
        let Some(progress) = item.get("progress").and_then(Value::as_object) else {
            continue;
        };
        let mut effective: Option<f64> = None;
        for key in ["daily", "weekly", "monthly"] {
            let Some(window) = progress.get(key) else {
                continue;
            };
            let limit = value_number_any(window, &["limit_usd"]).unwrap_or(0.0);
            if limit <= 0.0 {
                continue;
            }
            let remaining = value_number_any(window, &["remaining_usd"])
                .unwrap_or(0.0)
                .max(0.0);
            effective = Some(effective.map_or(remaining, |current| current.min(remaining)));
        }
        if let Some(value) = effective {
            total += value;
            known = true;
        }
    }
    if known {
        Some(total)
    } else {
        None
    }
}

async fn query_sub2api_panel_usage(
    client: &Client,
    credential: &RemotePanelCredential,
    days: u64,
) -> Result<Value, String> {
    let root = management_root(&credential.base_url);
    let mut attempts = Vec::new();
    let login_endpoint = EndpointSpec {
        id: "sub2api_panel_login",
        label: "sub2api 用户登录",
        panel_hint: "sub2api",
        url: join_url(&root, "/api/v1/auth/login"),
    };
    let email = if credential.email.is_empty() {
        &credential.username
    } else {
        &credential.email
    };
    let (status_code, response_headers, text) = match panel_post_json(
        client,
        &login_endpoint.url,
        build_panel_headers(),
        json!({ "email": email, "password": credential.password }),
    )
    .await
    {
        Ok(output) => output,
        Err(error) => {
            attempts.push(panel_attempt(
                &login_endpoint,
                "network_error",
                None,
                &error,
            ));
            return Ok(remote_error_json(
                "auth_error",
                "sub2api",
                &credential.provider_key,
                &credential.base_url,
                "sub2api 登录请求失败。",
                attempts,
            ));
        }
    };
    if looks_like_cloudflare_block(status_code, &response_headers, &text) {
        attempts.push(panel_attempt(
            &login_endpoint,
            "blocked",
            Some(status_code),
            "Cloudflare/bot challenge",
        ));
        return Ok(remote_error_json(
            "blocked",
            "cloudflare-protected",
            &credential.provider_key,
            &credential.base_url,
            "该中转面板存在 Cloudflare/bot 拦截，当前不支持自动查询余额/远程用量。",
            attempts,
        ));
    }
    if status_code != 200 {
        attempts.push(panel_attempt(
            &login_endpoint,
            "auth_error",
            Some(status_code),
            &short_body_message(&text),
        ));
        return Ok(remote_error_json(
            "auth_error",
            "sub2api",
            &credential.provider_key,
            &credential.base_url,
            "sub2api 用户名/密码登录失败。",
            attempts,
        ));
    }
    let data = match parse_wrapped_data(&text) {
        Ok(data) => data,
        Err(error) => {
            attempts.push(panel_attempt(
                &login_endpoint,
                "auth_error",
                Some(status_code),
                &error,
            ));
            return Ok(remote_error_json(
                "auth_error",
                "sub2api",
                &credential.provider_key,
                &credential.base_url,
                &error,
                attempts,
            ));
        }
    };
    if data
        .get("requires_2fa")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        attempts.push(panel_attempt(
            &login_endpoint,
            "auth_error",
            Some(status_code),
            "账号启用了 2FA，当前不支持",
        ));
        return Ok(remote_error_json(
            "auth_error",
            "sub2api",
            &credential.provider_key,
            &credential.base_url,
            "sub2api 账号启用了 2FA，当前不支持自动登录查询。",
            attempts,
        ));
    }
    let access_token = value_string_any(&data, &["access_token", "accessToken"]);
    if access_token.is_empty() {
        attempts.push(panel_attempt(
            &login_endpoint,
            "auth_error",
            Some(status_code),
            "登录响应没有 access_token",
        ));
        return Ok(remote_error_json(
            "auth_error",
            "sub2api",
            &credential.provider_key,
            &credential.base_url,
            "sub2api 登录成功但没有返回 access_token。",
            attempts,
        ));
    }
    attempts.push(panel_attempt(
        &login_endpoint,
        "ok",
        Some(status_code),
        "已取得 JWT",
    ));
    let mut headers = build_panel_headers();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {access_token}"))
            .map_err(|error| error.to_string())?,
    );

    let profile_endpoint = EndpointSpec {
        id: "sub2api_user_profile",
        label: "sub2api 账户余额",
        panel_hint: "sub2api",
        url: join_url(&root, "/api/v1/user/profile"),
    };
    let (profile_code, profile_headers, profile_text) =
        match panel_get_text(client, &profile_endpoint.url, headers.clone()).await {
            Ok(output) => output,
            Err(error) => {
                attempts.push(panel_attempt(
                    &profile_endpoint,
                    "network_error",
                    None,
                    &error,
                ));
                return Ok(remote_error_json(
                    "auth_error",
                    "sub2api",
                    &credential.provider_key,
                    &credential.base_url,
                    "sub2api profile 查询失败。",
                    attempts,
                ));
            }
        };
    if looks_like_cloudflare_block(profile_code, &profile_headers, &profile_text) {
        attempts.push(panel_attempt(
            &profile_endpoint,
            "blocked",
            Some(profile_code),
            "Cloudflare/bot challenge",
        ));
        return Ok(remote_error_json(
            "blocked",
            "cloudflare-protected",
            &credential.provider_key,
            &credential.base_url,
            "该中转面板存在 Cloudflare/bot 拦截，当前不支持自动查询余额/远程用量。",
            attempts,
        ));
    }
    if profile_code != 200 {
        attempts.push(panel_attempt(
            &profile_endpoint,
            "http_error",
            Some(profile_code),
            &short_body_message(&profile_text),
        ));
        return Ok(remote_error_json(
            "unsupported",
            "sub2api",
            &credential.provider_key,
            &credential.base_url,
            "sub2api profile 接口返回异常。",
            attempts,
        ));
    }
    let profile_data = match parse_wrapped_data(&profile_text) {
        Ok(data) => data,
        Err(error) => {
            attempts.push(panel_attempt(
                &profile_endpoint,
                "parse_error",
                Some(profile_code),
                &error,
            ));
            return Ok(remote_error_json(
                "unsupported",
                "sub2api",
                &credential.provider_key,
                &credential.base_url,
                "sub2api profile 响应无法解析。",
                attempts,
            ));
        }
    };
    attempts.push(panel_attempt(
        &profile_endpoint,
        "ok",
        Some(profile_code),
        "已读取账户余额",
    ));

    let mut remaining_usd = value_number_any(&profile_data, &["balance"]).unwrap_or(0.0);
    let progress_endpoint = EndpointSpec {
        id: "sub2api_subscriptions_progress",
        label: "sub2api 订阅剩余额度",
        panel_hint: "sub2api",
        url: join_url(&root, "/api/v1/subscriptions/progress"),
    };
    if let Ok((progress_code, progress_headers, progress_text)) =
        panel_get_text(client, &progress_endpoint.url, headers.clone()).await
    {
        if looks_like_cloudflare_block(progress_code, &progress_headers, &progress_text) {
            attempts.push(panel_attempt(
                &progress_endpoint,
                "blocked",
                Some(progress_code),
                "Cloudflare/bot challenge",
            ));
        } else if progress_code == 200 {
            match parse_wrapped_data(&progress_text) {
                Ok(progress_data) => {
                    if let Some(subscription_remaining) =
                        sub2api_subscription_remaining_usd(&progress_data)
                    {
                        remaining_usd += subscription_remaining;
                        attempts.push(panel_attempt(
                            &progress_endpoint,
                            "ok",
                            Some(progress_code),
                            "已读取订阅剩余额度",
                        ));
                    } else {
                        attempts.push(panel_attempt(
                            &progress_endpoint,
                            "no_signal",
                            Some(progress_code),
                            "没有可识别订阅剩余额度",
                        ));
                    }
                }
                Err(error) => attempts.push(panel_attempt(
                    &progress_endpoint,
                    "parse_error",
                    Some(progress_code),
                    &error,
                )),
            }
        } else {
            attempts.push(panel_attempt(
                &progress_endpoint,
                "unsupported",
                Some(progress_code),
                &short_body_message(&progress_text),
            ));
        }
    }

    let stats_endpoint = EndpointSpec {
        id: "sub2api_dashboard_stats",
        label: "sub2api 远程消耗",
        panel_hint: "sub2api",
        url: join_url(&root, "/api/v1/usage/dashboard/stats"),
    };
    let mut used_usd = None;
    let mut tokens = None;
    let mut requests = None;
    if let Ok((stats_code, stats_headers, stats_text)) =
        panel_get_text(client, &stats_endpoint.url, headers).await
    {
        if looks_like_cloudflare_block(stats_code, &stats_headers, &stats_text) {
            attempts.push(panel_attempt(
                &stats_endpoint,
                "blocked",
                Some(stats_code),
                "Cloudflare/bot challenge",
            ));
        } else if stats_code == 200 {
            match parse_wrapped_data(&stats_text) {
                Ok(stats_data) => {
                    used_usd = value_number_any(
                        &stats_data,
                        &["total_actual_cost", "actual_cost", "total_cost"],
                    );
                    tokens =
                        value_number_any(&stats_data, &["total_tokens", "token_count", "tokens"]);
                    requests = value_number_any(
                        &stats_data,
                        &["total_requests", "request_count", "requests"],
                    );
                    attempts.push(panel_attempt(
                        &stats_endpoint,
                        "ok",
                        Some(stats_code),
                        "已读取 dashboard stats",
                    ));
                }
                Err(error) => attempts.push(panel_attempt(
                    &stats_endpoint,
                    "parse_error",
                    Some(stats_code),
                    &error,
                )),
            }
        } else {
            attempts.push(panel_attempt(
                &stats_endpoint,
                "unsupported",
                Some(stats_code),
                &short_body_message(&stats_text),
            ));
        }
    }

    let mut aggregate = RemoteUsageAggregate {
        provider_type: "sub2api".to_string(),
        remaining: Some(NumericField {
            value: remaining_usd,
            path: "profile.balance + subscriptions.remaining_usd".to_string(),
        }),
        used: used_usd.map(|value| NumericField {
            value,
            path: "stats.total_actual_cost".to_string(),
        }),
        cost: used_usd.map(|value| NumericField {
            value,
            path: "stats.total_actual_cost".to_string(),
        }),
        tokens: tokens.map(|value| NumericField {
            value,
            path: "stats.total_tokens".to_string(),
        }),
        requests: requests.map(|value| NumericField {
            value,
            path: "stats.total_requests".to_string(),
        }),
        balance_unit: "USD".to_string(),
        usage_unit: "USD".to_string(),
        source_endpoints: vec![
            "sub2api_user_profile".to_string(),
            "sub2api_subscriptions_progress".to_string(),
            "sub2api_dashboard_stats".to_string(),
        ],
        ..RemoteUsageAggregate::default()
    };
    if let Some(used) = used_usd {
        aggregate.total = Some(NumericField {
            value: remaining_usd + used,
            path: "remaining + used".to_string(),
        });
    }
    let mut result = aggregate_to_json(
        &mut aggregate,
        &credential.base_url,
        &credential.provider_key,
        days,
        attempts,
    );
    attach_remote_auth_info(&mut result, credential);
    Ok(result)
}

async fn query_remote_usage_with_credential(
    client: &Client,
    credential: &RemotePanelCredential,
    days: u64,
) -> Result<Value, String> {
    match credential.auth_mode.as_str() {
        "newapi_password" | "newapi_access_token" => {
            query_newapi_panel_usage(client, credential, days).await
        }
        "sub2api_password" => query_sub2api_panel_usage(client, credential, days).await,
        _ => Ok(remote_error_json(
            "unsupported",
            "unknown",
            &credential.provider_key,
            &credential.base_url,
            "远程面板凭据类型暂不支持。",
            Vec::new(),
        )),
    }
}

fn resolve_remote_panel_base_url(
    body: &Value,
    object: &Map<String, Value>,
) -> Result<String, String> {
    let direct = clean_string(object.get("baseUrl"));
    if !direct.is_empty() {
        return clean_base(&direct);
    }
    let secret = get_provider_secret(body)?;
    let base_url = secret
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if base_url.is_empty() {
        return Err("当前 Provider 未配置 Base URL".to_string());
    }
    clean_base(base_url)
}

fn normalize_remote_auth_mode(panel_type: &str, auth_mode: &str) -> String {
    let panel = panel_type.trim().to_lowercase();
    let mode = auth_mode.trim().to_lowercase();
    match mode.as_str() {
        "newapi_password" | "newapi_access_token" | "sub2api_password" => mode,
        "password" if panel == "sub2api" => "sub2api_password".to_string(),
        "password" => "newapi_password".to_string(),
        "access_token" | "token" | "user_access_token" => "newapi_access_token".to_string(),
        _ if panel == "sub2api" => "sub2api_password".to_string(),
        _ => "newapi_password".to_string(),
    }
}

fn panel_type_for_auth_mode(panel_type: &str, auth_mode: &str) -> String {
    let panel = panel_type.trim().to_lowercase();
    if panel == "newapi" || panel == "sub2api" {
        return panel;
    }
    if auth_mode.starts_with("sub2api") {
        "sub2api".to_string()
    } else {
        "newapi".to_string()
    }
}

pub(crate) fn get_provider_remote_usage_credential(query: &Value) -> Result<Value, String> {
    let object = parse_json_object(query);
    let provider_key = clean_string(object.get("providerKey"));
    if provider_key.is_empty() {
        return Err("providerKey is required".to_string());
    }
    let tool = clean_string(object.get("tool"));
    let tool = if tool.is_empty() {
        "codex".to_string()
    } else {
        tool.to_lowercase()
    };
    match read_remote_panel_credential(&tool, &provider_key)? {
        Some(credential) => Ok(sanitize_remote_panel_credential(&credential)),
        None => Ok(json!({ "exists": false, "providerKey": provider_key, "tool": tool })),
    }
}

pub(crate) fn save_provider_remote_usage_credential(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let provider_key = clean_string(object.get("providerKey"));
    if provider_key.is_empty() {
        return Err("providerKey is required".to_string());
    }
    let tool_raw = clean_string(object.get("tool"));
    let tool = if tool_raw.is_empty() {
        "codex".to_string()
    } else {
        tool_raw.to_lowercase()
    };
    let base_url = resolve_remote_panel_base_url(body, &object)?;
    let panel_type_input = clean_string(object.get("panelType"));
    let auth_mode =
        normalize_remote_auth_mode(&panel_type_input, &clean_string(object.get("authMode")));
    let panel_type = panel_type_for_auth_mode(&panel_type_input, &auth_mode);
    let existing = read_remote_panel_credential(&tool, &provider_key)?;
    let username = clean_string(object.get("username"));
    let email = clean_string(object.get("email"));
    let user_id = clean_string(object.get("userId"));
    let mut password = clean_string(object.get("password"));
    let mut access_token = clean_string(object.get("accessToken"));
    if password.is_empty() {
        if let Some(prev) = &existing {
            password = prev.password.clone();
        }
    }
    if access_token.is_empty() {
        if let Some(prev) = &existing {
            access_token = prev.access_token.clone();
        }
    }

    match auth_mode.as_str() {
        "newapi_password" => {
            if username.is_empty() {
                return Err("NewAPI 用户名不能为空".to_string());
            }
            if password.is_empty() {
                return Err("NewAPI 密码不能为空".to_string());
            }
        }
        "newapi_access_token" => {
            if user_id.is_empty() {
                return Err("NewAPI User ID 不能为空".to_string());
            }
            if access_token.is_empty() {
                return Err("NewAPI Access Token 不能为空".to_string());
            }
        }
        "sub2api_password" => {
            if email.is_empty() && username.is_empty() {
                return Err("sub2api 邮箱不能为空".to_string());
            }
            if password.is_empty() {
                return Err("sub2api 密码不能为空".to_string());
            }
        }
        _ => return Err("不支持的远程面板认证方式".to_string()),
    }

    let credential = RemotePanelCredential {
        provider_key: provider_key.clone(),
        tool: tool.clone(),
        panel_type,
        auth_mode,
        base_url,
        username,
        email,
        password,
        user_id,
        access_token,
        saved_at: Utc::now().to_rfc3339(),
    };

    let mut store = read_remote_panel_credentials_store()?;
    if !store.get("records").map(Value::is_object).unwrap_or(false) {
        store["records"] = json!({});
    }
    let key = remote_panel_credential_key(&tool, &provider_key);
    let records = store
        .get_mut("records")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "credential store is invalid".to_string())?;
    records.insert(
        key,
        json!({
          "providerKey": credential.provider_key,
          "tool": credential.tool,
          "panelType": credential.panel_type,
          "authMode": credential.auth_mode,
          "baseUrl": credential.base_url,
          "username": credential.username,
          "email": credential.email,
          "password": credential.password,
          "userId": credential.user_id,
          "accessToken": credential.access_token,
          "savedAt": credential.saved_at,
        }),
    );
    write_remote_panel_credentials_store(&store)?;
    let saved = read_remote_panel_credential(&tool, &provider_key)?
        .ok_or_else(|| "credential save failed".to_string())?;
    Ok(sanitize_remote_panel_credential(&saved))
}

pub(crate) fn delete_provider_remote_usage_credential(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let provider_key = clean_string(object.get("providerKey"));
    if provider_key.is_empty() {
        return Err("providerKey is required".to_string());
    }
    let tool_raw = clean_string(object.get("tool"));
    let tool = if tool_raw.is_empty() {
        "codex".to_string()
    } else {
        tool_raw.to_lowercase()
    };
    let mut store = read_remote_panel_credentials_store()?;
    let key = remote_panel_credential_key(&tool, &provider_key);
    let removed = store
        .get_mut("records")
        .and_then(Value::as_object_mut)
        .and_then(|records| records.remove(&key))
        .is_some();
    write_remote_panel_credentials_store(&store)?;
    Ok(json!({ "deleted": removed, "providerKey": provider_key, "tool": tool }))
}

pub(crate) async fn query_saved_provider_remote_usage(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let mode = object
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if mode == "oauth" {
        return Ok(json!({
          "status": "unsupported",
          "supported": false,
          "providerType": "official-oauth",
          "message": "Codex OAuth 官方用量查询暂不启用：需要确认官方客户端接口，避免账号风险。",
          "endpointsTried": [],
        }));
    }

    let provider_key = object
        .get("providerKey")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if provider_key.is_empty() {
        return Err("providerKey is required".to_string());
    }
    let tool = object
        .get("tool")
        .and_then(Value::as_str)
        .unwrap_or("codex")
        .trim()
        .to_lowercase();
    let days = clamp_u64(
        object.get("days").and_then(Value::as_u64).unwrap_or(30),
        1,
        366,
    );
    let timeout_ms = clamp_u64(
        object
            .get("timeoutMs")
            .and_then(Value::as_u64)
            .unwrap_or(9000),
        3000,
        20000,
    );

    let client = Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|error| error.to_string())?;

    if let Some(mut credential) =
        read_remote_panel_credential(if tool.is_empty() { "codex" } else { &tool }, &provider_key)?
    {
        credential.base_url = if credential.base_url.trim().is_empty() {
            resolve_remote_panel_base_url(body, &object)?
        } else {
            clean_base(&credential.base_url)?
        };
        return query_remote_usage_with_credential(&client, &credential, days).await;
    }

    let secret = get_provider_secret(body)?;
    let base_url = secret
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let api_key = secret
        .get("apiKey")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if base_url.is_empty() {
        return Err(format!("Provider {} 未配置 Base URL", provider_key));
    }

    if api_key.is_empty() {
        return Err(format!(
            "Provider {} 未找到 API Key 或远程面板认证",
            provider_key
        ));
    }

    let base_url = clean_base(base_url)?;
    let endpoints = candidate_endpoints(&base_url, days);
    let headers = build_headers(api_key)?;

    let mut attempts = Vec::new();
    let mut aggregate = RemoteUsageAggregate::default();
    let mut saw_auth_error = false;
    let mut saw_success_no_signal = false;

    for endpoint in endpoints {
        let response = match client
            .get(&endpoint.url)
            .headers(headers.clone())
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                attempts.push(attempt_json(
                    &endpoint,
                    if error.is_timeout() {
                        "timeout"
                    } else {
                        "network_error"
                    },
                    None,
                    &if error.is_timeout() {
                        "请求超时".to_string()
                    } else {
                        error.to_string()
                    },
                ));
                continue;
            }
        };

        let status = response.status();
        let status_code = status.as_u16();
        let headers_snapshot = response.headers().clone();
        let text = response.text().await.unwrap_or_default();
        if looks_like_cloudflare_block(status_code, &headers_snapshot, &text) {
            attempts.push(attempt_json(
                &endpoint,
                "blocked",
                Some(status_code),
                "Cloudflare/bot challenge",
            ));
            return Ok(json!({
              "status": "blocked",
              "supported": false,
              "providerType": "cloudflare-protected",
              "providerKey": provider_key,
              "baseUrl": base_url,
              "checkedAt": Utc::now().to_rfc3339(),
              "message": "该中转面板存在 Cloudflare/bot 拦截，当前不支持自动查询余额/远程用量。",
              "endpointsTried": attempts,
            }));
        }

        if status_code == 401 || status_code == 403 {
            saw_auth_error = true;
            attempts.push(attempt_json(
                &endpoint,
                "auth_error",
                Some(status_code),
                "API Key 无权访问该面板查询接口",
            ));
            continue;
        }
        if status_code == 404 || status_code == 405 {
            attempts.push(attempt_json(
                &endpoint,
                "unsupported",
                Some(status_code),
                "接口不存在",
            ));
            continue;
        }
        if !status.is_success() {
            attempts.push(attempt_json(
                &endpoint,
                "http_error",
                Some(status_code),
                &short_body_message(&text),
            ));
            continue;
        }

        let payload = serde_json::from_str::<Value>(&text)
            .unwrap_or_else(|_| json!({ "_text": short_body_message(&text) }));
        let extracted = extract_metrics(&endpoint, &payload, &base_url);
        let had_signal = extracted.remaining.is_some()
            || extracted.used.is_some()
            || extracted.total.is_some()
            || extracted.cost.is_some()
            || extracted.tokens.is_some()
            || extracted.requests.is_some();
        if had_signal {
            attempts.push(attempt_json(
                &endpoint,
                "ok",
                Some(status_code),
                "已读取余额/用量字段",
            ));
            merge_metrics(&mut aggregate, extracted, endpoint.id);
        } else {
            saw_success_no_signal = true;
            attempts.push(attempt_json(
                &endpoint,
                "no_signal",
                Some(status_code),
                "响应成功，但没有可识别的余额/用量字段",
            ));
        }
    }

    let has_signal = aggregate.remaining.is_some()
        || aggregate.used.is_some()
        || aggregate.total.is_some()
        || aggregate.cost.is_some()
        || aggregate.tokens.is_some()
        || aggregate.requests.is_some();
    if has_signal {
        return Ok(aggregate_to_json(
            &mut aggregate,
            &base_url,
            &provider_key,
            days,
            attempts,
        ));
    }

    let status = if saw_auth_error && !saw_success_no_signal {
        "auth_error"
    } else {
        "unsupported"
    };
    let message = if status == "auth_error" {
        "中转面板拒绝使用当前 API Key 查询余额/用量；可能需要面板用户 Token，当前不尝试网页登录或绕过。"
    } else {
        "未发现 NewAPI/sub2api/OpenAI-compatible billing 可用查询接口，当前渠道暂不支持远程余额/用量同步。"
    };
    Ok(json!({
      "status": status,
      "supported": false,
      "providerType": "unknown",
      "providerKey": provider_key,
      "baseUrl": base_url,
      "checkedAt": Utc::now().to_rfc3339(),
      "message": message,
      "endpointsTried": attempts,
    }))
}
