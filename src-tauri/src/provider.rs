use reqwest::Client;
use reqwest::header::{
  HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE,
  PRAGMA, USER_AGENT,
};
use serde_json::{json, Map, Value};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};
use std::time::Duration;
use url::Url;

use crate::parse_json_object;

pub(crate) fn normalize_base_url(base_url: &str) -> Result<String, String> {
  let raw = base_url.trim();
  if raw.is_empty() {
    return Err("Base URL is required".to_string());
  }

  let with_scheme = if raw.contains("://") {
    raw.to_string()
  } else {
    let lower = raw.to_lowercase();
    if lower.starts_with("localhost") || lower.starts_with("127.0.0.1") || lower.starts_with("0.0.0.0") {
      format!("http://{raw}")
    } else {
      format!("https://{raw}")
    }
  };

  let mut url = Url::parse(&with_scheme).map_err(|error| error.to_string())?;
  // 只做最小处理：去掉多余尾部斜杠，路径段原样保留。
  // 不做任何"智能补全"——有的网关就是不要 /v1，自动加上会 404。
  // 旧实现里"自动补 /v1 + 在 /v2 后面再拼 /v1"也一并删掉。
  let trimmed = url.path().trim_end_matches('/').to_string();
  url.set_path(&trimmed);
  Ok(url.to_string().trim_end_matches('/').to_string())
}

pub(crate) fn slugify_provider_key(value: &str) -> String {
  let mut slug = String::new();
  let mut previous_dash = false;

  for ch in value.trim().to_lowercase().replace("http://", "").replace("https://", "").chars() {
    if ch.is_ascii_alphanumeric() {
      slug.push(ch);
      previous_dash = false;
    } else if !previous_dash {
      slug.push('-');
      previous_dash = true;
    }
  }

  let slug = slug.trim_matches('-').to_string();
  if slug.is_empty() {
    return "custom".to_string();
  }
  if slug.chars().next().is_some_and(|ch| ch.is_ascii_digit()) {
    format!("provider-{slug}")
  } else {
    slug
  }
}

pub(crate) fn infer_provider_seed(base_url: &str) -> String {
  let url = match Url::parse(base_url) {
    Ok(url) => url,
    Err(_) => return "custom".to_string(),
  };
  let hostname = url.host_str().unwrap_or_default().trim_start_matches("www.");
  let ignored = ["api", "openai", "codex", "gateway", "chat", "www", "dapi"];
  for part in hostname.split('.') {
    let clean = part.trim().to_lowercase();
    if clean.is_empty() || ignored.contains(&clean.as_str()) || !clean.chars().any(|ch| ch.is_ascii_alphabetic()) {
      continue;
    }
    return clean;
  }
  hostname.split('.').next().unwrap_or("custom").to_string()
}

pub(crate) fn infer_provider_label(base_url: &str, provider_key: &str) -> String {
  let seed = infer_provider_seed(base_url);
  let source = if seed.is_empty() { provider_key } else { &seed };
  source
    .split(['-', '_', ' '])
    .filter(|part| !part.is_empty())
    .map(|part| {
      let mut chars = part.chars();
      match chars.next() {
        Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
        None => String::new(),
      }
    })
    .collect::<Vec<_>>()
    .join(" ")
}

pub(crate) fn infer_env_key(provider_key: &str) -> String {
  format!(
    "{}_API_KEY",
    slugify_provider_key(provider_key).replace('-', "_").to_uppercase()
  )
}

/// 在已有 `model_providers` 表里按 base_url（已规范化）找命中条目。
/// 用于 save_config 检测「用户只改了 URL/重命名 providerKey，实际指向的还是
/// 同一个 provider」的场景，避免在 TOML 里产生孤儿条目。
pub(crate) fn find_provider_entry_by_base_url(
  config: &Value,
  base_url: &str,
) -> Option<(String, Map<String, Value>)> {
  let providers = config.get("model_providers")?.as_object()?;
  let target = base_url.trim();
  if target.is_empty() {
    return None;
  }
  for (key, provider) in providers.iter() {
    let item = match provider.as_object() {
      Some(item) => item,
      None => continue,
    };
    let existing = item.get("base_url").and_then(Value::as_str).unwrap_or("").trim();
    if existing == target {
      return Some((key.clone(), item.clone()));
    }
  }
  None
}

fn normalize_token(value: &str) -> String {
  value
    .to_lowercase()
    .replace("http://", "")
    .replace("https://", "")
    .chars()
    .filter(|ch| ch.is_ascii_alphanumeric())
    .collect()
}

fn score_key_candidate(candidate_key: &str, provider: &ProviderMeta) -> i32 {
  let candidate = normalize_token(candidate_key)
    .trim_end_matches("apikey")
    .trim_end_matches("oaikey")
    .trim_end_matches("key")
    .trim_end_matches("token")
    .to_string();

  let targets = vec![provider.key.as_str(), provider.name.as_str(), provider.base_url.as_str()]
    .into_iter()
    .map(normalize_token)
    .filter(|item| !item.is_empty())
    .collect::<Vec<_>>();

  let mut score = 0;
  for target in targets {
    if target == candidate {
      score += 120;
    }
    if target.contains(&candidate) {
      score += 60;
    }
    if candidate.contains(&target) {
      score += 30;
    }
    let prefix_len = target.len().min(candidate.len()).min(8);
    if prefix_len >= 4 && target[..prefix_len] == candidate[..prefix_len] {
      score += (prefix_len as i32) * 5;
    }
  }

  // 第三方 OpenAI 兼容网关（NewAPI / oneapi / packycode 等）默认就用
  // `OPENAI_API_KEY`，旧版无条件 -60 会让正常部署反复"找不到 key"。
  // 不再特殊处罚 —— provider.env_key 显式存在时凭 +1000 分自然胜出，
  // 其他更贴近的 key 也会自然命中；OPENAI_API_KEY 在没有更优候选时
  // 是合理的回退。
  score
}

fn candidate_env_keys(provider: &ProviderMeta) -> Vec<String> {
  let mut keys = HashSet::new();
  let seeds = vec![
    provider.key.clone(),
    provider.name.clone(),
    Url::parse(&provider.base_url)
      .ok()
      .and_then(|url| url.host_str().map(|host| host.to_string()))
      .unwrap_or_default(),
  ];

  for seed in seeds {
    let normalized = seed
      .chars()
      .map(|ch| if ch.is_ascii_alphanumeric() { ch.to_ascii_uppercase() } else { '_' })
      .collect::<String>()
      .trim_matches('_')
      .to_string();
    if normalized.is_empty() {
      continue;
    }
    keys.insert(format!("{normalized}_API_KEY"));
    keys.insert(format!("{normalized}_OAI_KEY"));
    keys.insert(format!("{normalized}_KEY"));
  }

  keys.into_iter().collect()
}

#[derive(Clone)]
struct ProviderMeta {
  key: String,
  name: String,
  base_url: String,
  env_key: String,
  wire_api: String,
  inline_bearer_token: String,
  is_active: bool,
}

#[derive(Clone)]
struct ProviderSecret {
  key: Option<String>,
  value: String,
  source: Option<String>,
  score: i32,
}

pub(crate) fn flatten_auth_json(auth_json: &Value) -> BTreeMap<String, String> {
  let mut flat = BTreeMap::new();
  if let Some(object) = auth_json.as_object() {
    for (key, value) in object {
      if let Some(text) = value.as_str() {
        flat.insert(key.clone(), text.to_string());
      }
    }
  }
  flat
}

fn resolve_provider_secret(
  provider: &ProviderMeta,
  env_file: &BTreeMap<String, String>,
  auth_json: &BTreeMap<String, String>,
) -> ProviderSecret {
  let runtime_env = std::env::vars().collect::<BTreeMap<_, _>>();
  let explicit_keys = if provider.env_key.trim().is_empty() {
    Vec::new()
  } else {
    vec![provider.env_key.clone()]
  };

  let mut discovered_keys = env_file
    .keys()
    .chain(runtime_env.keys())
    .chain(auth_json.keys())
    .filter(|key| {
      let lower = key.to_lowercase();
      lower.ends_with("key") || lower.ends_with("token")
    })
    .cloned()
    .collect::<Vec<_>>();

  let mut candidate_keys = explicit_keys.clone();
  candidate_keys.extend(candidate_env_keys(provider));
  candidate_keys.append(&mut discovered_keys);
  candidate_keys.sort();
  candidate_keys.dedup();

  let mut candidates = Vec::new();
  for key in candidate_keys {
    let dynamic_score = score_key_candidate(&key, provider);
    if let Some(value) = env_file.get(&key) {
      candidates.push(ProviderSecret {
        key: Some(key.clone()),
        value: value.clone(),
        source: Some(".env".to_string()),
        score: if explicit_keys.contains(&key) { 1000 } else { dynamic_score + 100 },
      });
    }
    if let Some(value) = runtime_env.get(&key) {
      candidates.push(ProviderSecret {
        key: Some(key.clone()),
        value: value.clone(),
        source: Some("system-env".to_string()),
        score: if explicit_keys.contains(&key) { 950 } else { dynamic_score + 90 },
      });
    }
    if let Some(value) = auth_json.get(&key) {
      candidates.push(ProviderSecret {
        key: Some(key.clone()),
        value: value.clone(),
        source: Some("auth.json".to_string()),
        score: if explicit_keys.contains(&key) { 900 } else { dynamic_score + 80 },
      });
    }
  }

  if !provider.inline_bearer_token.trim().is_empty() {
    candidates.push(ProviderSecret {
      key: None,
      value: provider.inline_bearer_token.clone(),
      source: Some("config.toml".to_string()),
      score: 850,
    });
  }

  candidates.sort_by(|left, right| right.score.cmp(&left.score));
  candidates.into_iter().next().unwrap_or(ProviderSecret {
    key: explicit_keys.first().cloned(),
    value: String::new(),
    source: None,
    score: 0,
  })
}

fn mask_secret_value(value: &str) -> String {
  let trimmed = value.trim();
  if trimmed.is_empty() {
    return String::new();
  }

  let chars = trimmed.chars().collect::<Vec<_>>();
  if chars.len() <= 8 {
    return "*".repeat(chars.len());
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
  format!("{prefix}****{suffix}")
}

fn build_provider_meta(key: &str, provider_object: &Map<String, Value>, active_provider_key: &str) -> ProviderMeta {
  ProviderMeta {
    key: key.to_string(),
    name: {
      let name = get_string(provider_object, "name");
      if name.is_empty() { key.to_string() } else { name }
    },
    base_url: get_string(provider_object, "base_url"),
    env_key: get_string_any(provider_object, &["env_key", "temp_env_key"]),
    wire_api: {
      let wire = get_string(provider_object, "wire_api");
      if wire.is_empty() { "responses".to_string() } else { wire }
    },
    inline_bearer_token: get_string(provider_object, "experimental_bearer_token"),
    is_active: active_provider_key == key,
  }
}

fn resolve_saved_provider(
  config: &Value,
  env_file: &BTreeMap<String, String>,
  auth_json: &BTreeMap<String, String>,
  provider_key: &str,
) -> Result<(ProviderMeta, ProviderSecret), String> {
  let config_object = parse_json_object(config);
  let active_provider_key = get_string(&config_object, "model_provider");
  let provider_object = config_object
    .get("model_providers")
    .and_then(Value::as_object)
    .and_then(|providers| providers.get(provider_key))
    .and_then(Value::as_object)
    .cloned()
    .ok_or_else(|| format!("未找到 Provider：{provider_key}"))?;

  let provider = build_provider_meta(provider_key, &provider_object, &active_provider_key);
  let secret = resolve_provider_secret(&provider, env_file, auth_json);
  Ok((provider, secret))
}

pub(crate) fn reveal_provider_api_key(
  config: &Value,
  env_file: &BTreeMap<String, String>,
  auth_json: &BTreeMap<String, String>,
  provider_key: &str,
) -> Result<Value, String> {
  let (provider, secret) = resolve_saved_provider(config, env_file, auth_json, provider_key)?;
  if secret.value.trim().is_empty() {
    return Err(format!("Provider {} 未找到 API Key", provider.name));
  }

  Ok(json!({
    "providerKey": provider.key,
    "providerName": provider.name,
    "baseUrl": provider.base_url,
    "wireApi": provider.wire_api,
    "hasApiKey": true,
    "maskedApiKey": mask_secret_value(&secret.value),
    "apiKey": secret.value,
    "keySource": secret.source,
    "resolvedKeyName": secret.key,
  }))
}

pub(crate) async fn detect_saved_provider(
  config: &Value,
  env_file: &BTreeMap<String, String>,
  auth_json: &BTreeMap<String, String>,
  provider_key: &str,
  timeout_ms: u64,
  codex_home_hint: &str,
) -> Result<Value, String> {
  let (provider, secret) = resolve_saved_provider(config, env_file, auth_json, provider_key)?;
  if provider.base_url.trim().is_empty() {
    return Err(format!("Provider {} 未配置 Base URL", provider.name));
  }
  if secret.value.trim().is_empty() {
    return Err(format!("Provider {} 未找到 API Key", provider.name));
  }

  // 把 providerKey + codexHome 显式传下去，让 probe log 用真正的行 key 落记录，
  // 否则 detect_provider 只能从 baseUrl 推断，跟前端 /probe-summary 查询 key 不一致。
  detect_provider(&json!({
    "baseUrl": provider.base_url,
    "apiKey": secret.value,
    "timeoutMs": timeout_ms,
    "providerKey": provider_key,
    "codexHome": codex_home_hint,
  }))
  .await
}

pub(crate) fn get_string(object: &Map<String, Value>, key: &str) -> String {
  object
    .get(key)
    .and_then(Value::as_str)
    .unwrap_or_default()
    .to_string()
}

pub(crate) fn get_string_any(object: &Map<String, Value>, keys: &[&str]) -> String {
  for key in keys {
    let value = get_string(object, key);
    if !value.is_empty() {
      return value;
    }
  }
  String::new()
}

pub(crate) fn summarize_providers(
  config: &Value,
  env_file: &BTreeMap<String, String>,
  auth_json: &BTreeMap<String, String>,
) -> Vec<Value> {
  let config_object = parse_json_object(config);
  let active_provider_key = get_string(&config_object, "model_provider");
  let provider_map = config_object
    .get("model_providers")
    .and_then(Value::as_object)
    .cloned()
    .unwrap_or_default();

  let mut providers = provider_map
    .into_iter()
    .map(|(key, provider)| {
      let provider_object = provider.as_object().cloned().unwrap_or_default();
      let base = build_provider_meta(&key, &provider_object, &active_provider_key);
      let secret = resolve_provider_secret(&base, env_file, auth_json);
      json!({
        "key": base.key,
        "name": base.name,
        "baseUrl": base.base_url,
        "envKey": base.env_key,
        "wireApi": base.wire_api,
        "hasInlineBearerToken": !base.inline_bearer_token.is_empty(),
        "isActive": base.is_active,
        "hasApiKey": !secret.value.is_empty(),
        "maskedApiKey": mask_secret_value(&secret.value),
        "keySource": secret.source,
        "resolvedKeyName": secret.key,
      })
    })
    .collect::<Vec<_>>();

  providers.sort_by(|left, right| {
    let left_active = left.get("isActive").and_then(Value::as_bool).unwrap_or(false);
    let right_active = right.get("isActive").and_then(Value::as_bool).unwrap_or(false);
    if left_active != right_active {
      return if left_active { Ordering::Less } else { Ordering::Greater };
    }
    let left_key = left.get("key").and_then(Value::as_str).unwrap_or_default();
    let right_key = right.get("key").and_then(Value::as_str).unwrap_or_default();
    left_key.cmp(right_key)
  });

  providers
}


fn parse_model_version(model_id: &str) -> Option<(i32, i32)> {
  let lower = model_id.to_lowercase();
  let marker = lower.find("gpt-")? + 4;
  let suffix = &lower[marker..];
  let mut parts = suffix.split(['.', '-']);
  let major = parts.next()?.parse::<i32>().ok()?;
  let minor = parts.next().and_then(|part| part.parse::<i32>().ok()).unwrap_or(0);
  Some((major, minor))
}

fn compare_models(left: &str, right: &str) -> Ordering {
  let left_version = parse_model_version(left);
  let right_version = parse_model_version(right);
  match (left_version, right_version) {
    (Some((lm, ln)), Some((rm, rn))) => {
      if lm != rm {
        return rm.cmp(&lm);
      }
      if ln != rn {
        return rn.cmp(&ln);
      }
      let left_codex = left.to_lowercase().contains("codex");
      let right_codex = right.to_lowercase().contains("codex");
      if left_codex != right_codex {
        return left_codex.cmp(&right_codex);
      }
      left.cmp(right)
    }
    (Some(_), None) => Ordering::Less,
    (None, Some(_)) => Ordering::Greater,
    (None, None) => left.cmp(right),
  }
}

fn summarize_models(model_ids: Vec<String>) -> Value {
  let mut unique = model_ids.into_iter().filter(|id| !id.is_empty()).collect::<Vec<_>>();
  unique.sort_by(|left, right| compare_models(left, right));
  unique.dedup();
  let gpt_models = unique
    .iter()
    .filter(|id| id.to_lowercase().contains("gpt"))
    .cloned()
    .collect::<Vec<_>>();
  json!({
    "models": unique,
    "supportsGpt": !gpt_models.is_empty(),
    "recommendedModel": gpt_models.first().cloned().or_else(|| unique.first().cloned()),
  })
}

pub(crate) async fn detect_provider(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let normalized_base_url = normalize_base_url(&get_string(&object, "baseUrl"))?;
  let api_key = get_string(&object, "apiKey");
  let timeout_ms = object.get("timeoutMs").and_then(Value::as_u64).unwrap_or(15000);
  // 把这次探测的元信息提前抓出来：保存 provider 行触发的探测会带 providerKey + codexHome，
  // 自由 detect 模式可能没有 providerKey，那就用 baseUrl slug 凑一个。
  let probe_provider_key = {
    let explicit = get_string(&object, "providerKey");
    if !explicit.trim().is_empty() {
      explicit
    } else {
      slugify_provider_key(&infer_provider_seed(&normalized_base_url))
    }
  };
  let probe_codex_home = get_string(&object, "codexHome");
  let probe_started_at = std::time::Instant::now();

  let mut headers = HeaderMap::new();
  headers.insert(ACCEPT, HeaderValue::from_static("application/json, text/plain, */*"));
  headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
  headers.insert(USER_AGENT, HeaderValue::from_static("Mozilla/5.0 EasyAIConfig/0.1"));
  headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("zh-CN,zh;q=0.9,en;q=0.8"));
  headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
  headers.insert(PRAGMA, HeaderValue::from_static("no-cache"));
  headers.insert(
    AUTHORIZATION,
    HeaderValue::from_str(&format!("Bearer {}", api_key.trim())).map_err(|error| error.to_string())?,
  );

  let client = Client::builder()
    .timeout(Duration::from_millis(timeout_ms))
    .build()
    .map_err(|error| error.to_string())?;
  let send_result = client
    .get(format!("{normalized_base_url}/models"))
    .headers(headers)
    .send()
    .await;
  let response = match send_result {
    Ok(resp) => resp,
    Err(error) => {
      let elapsed = probe_started_at.elapsed().as_millis() as u64;
      let msg = if error.is_timeout() {
        "检测超时：该接口 15 秒内没有返回模型列表，请检查 Base URL、Key 或服务端兼容性".to_string()
      } else {
        error.to_string()
      };
      crate::provider_health::record_probe(
        &probe_provider_key,
        &probe_codex_home,
        Some(&normalized_base_url),
        false,
        Some(elapsed),
        None,
        Some(&msg),
      );
      return Err(msg);
    }
  };

  let status = response.status();
  let text = response.text().await.map_err(|error| error.to_string())?;
  let payload = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);

  if !status.is_success() {
    let message = payload
      .pointer("/error/message")
      .and_then(Value::as_str)
      .or_else(|| payload.get("message").and_then(Value::as_str))
      .map(|text| text.to_string())
      .unwrap_or_else(|| if text.is_empty() { format!("HTTP {status}") } else { text.clone() });
    let elapsed = probe_started_at.elapsed().as_millis() as u64;
    let err = format!("检测失败：{message}");
    crate::provider_health::record_probe(
      &probe_provider_key,
      &probe_codex_home,
      Some(&normalized_base_url),
      false,
      Some(elapsed),
      Some(status.as_u16()),
      Some(&err),
    );
    return Err(err);
  }

  let model_ids = payload
    .get("data")
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default()
    .into_iter()
    .filter_map(|item| item.get("id").and_then(Value::as_str).map(|text| text.to_string()))
    .collect::<Vec<_>>();

  let summary = summarize_models(model_ids);
  let elapsed = probe_started_at.elapsed().as_millis() as u64;
  crate::provider_health::record_probe(
    &probe_provider_key,
    &probe_codex_home,
    Some(&normalized_base_url),
    true,
    Some(elapsed),
    Some(status.as_u16()),
    None,
  );
  Ok(json!({
    "baseUrl": normalized_base_url,
    "status": "ok",
    "latencyMs": elapsed,
    "models": summary.get("models").cloned().unwrap_or_else(|| json!([])),
    "supportsGpt": summary.get("supportsGpt").cloned().unwrap_or_else(|| json!(false)),
    "recommendedModel": summary.get("recommendedModel").cloned().unwrap_or(Value::Null),
    "raw": payload,
  }))
}
