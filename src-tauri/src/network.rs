// Network / IP firewall module.
//
// Single purpose: figure out what outbound IP the user's machine currently
// presents to the internet, where that IP is geographically, and whether it's
// safe to launch an "official" OAuth CLI (Codex / Claude Code) from there.
//
// Why this exists: Anthropic and OpenAI both geo-fence their official consumer
// plans. Hitting api.openai.com / api.anthropic.com from a flagged region
// (currently: mainland China) is a known path to account suspension. We DO NOT
// want to auto-probe those endpoints to check — that's the exact API call that
// could trigger the ban. Instead we poll a neutral 3rd-party geo-IP service
// (ip-api.com — free, no account, 45 req/min ceiling) and make a judgment call
// locally.
//
// Also logs an ip-history.jsonl so the user can see which IPs they've
// recently used. De-duped per hour bucket, kept for 30 days.

use chrono::{Duration as ChronoDuration, Utc};
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::{app_home, ensure_dir, parse_json_object, read_text, write_text};
use crate::provider::get_string;

const IP_HISTORY_FILE: &str = "ip-history.jsonl";
const IP_API_URL: &str = "http://ip-api.com/json/?fields=status,country,countryCode,regionName,city,isp,org,as,query";
const CACHE_TTL: Duration = Duration::from_secs(300); // 5 min

// Country codes whose IPs we flag as 'block' for the official OAuth paths.
// Kept conservative on purpose — we only include regions known to actively
// cause OAuth account issues. HK / MO / TW are NOT in here because they
// aren't geo-fenced the same way.
const BLOCK_COUNTRIES: &[&str] = &["CN"];

static IP_CACHE: Mutex<Option<(Instant, Value)>> = Mutex::new(None);

fn ip_history_path() -> Result<std::path::PathBuf, String> {
  Ok(app_home()?.join(IP_HISTORY_FILE))
}

// Detect whether the OS / shell has a proxy configured. Doesn't guarantee
// traffic is actually routed through it — that's what the IP lookup is for —
// but helps explain the verdict ("you have a proxy configured yet still hit
// ip-api from a CN IP → your proxy isn't taking effect").
fn probe_proxy() -> Value {
  let mut hints = Vec::<String>::new();
  for key in &["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy"] {
    if let Ok(v) = std::env::var(key) {
      let v = v.trim();
      if !v.is_empty() {
        hints.push(format!("{}={}", key, v));
      }
    }
  }

  #[cfg(target_os = "macos")]
  {
    // `scutil --proxy` prints system-level proxy configuration. Best effort.
    if let Ok(out) = std::process::Command::new("scutil").arg("--proxy").output() {
      if out.status.success() {
        let text = String::from_utf8_lossy(&out.stdout);
        if text.contains("HTTPEnable : 1") || text.contains("HTTPSEnable : 1") || text.contains("SOCKSEnable : 1") {
          hints.push("system:macOS network proxy enabled".to_string());
        }
      }
    }
  }

  json!({
    "hasProxy": !hints.is_empty(),
    "hints": hints,
  })
}

fn verdict_for(country_code: &str, has_proxy: bool) -> (&'static str, String) {
  let cc = country_code.trim().to_ascii_uppercase();
  if cc.is_empty() {
    return ("warn", "无法识别当前 IP 的国家信息，建议先确认出口线路。".to_string());
  }
  let blocked = BLOCK_COUNTRIES.iter().any(|c| c.eq_ignore_ascii_case(&cc));
  if blocked {
    let msg = if has_proxy {
      format!("当前出口 IP 位于 {}，代理已配置但未生效（请求仍从 {} 发出）。启动官方 OAuth 工具大概率被风控。", cc, cc)
    } else {
      format!("当前出口 IP 位于 {}，且未检测到代理。直接启动 Codex / Claude Code 官方 OAuth 可能触发账号风控，强烈不建议。", cc)
    };
    return ("block", msg);
  }
  ("safe", format!("出口 IP 位于 {}，可正常使用 Codex / Claude Code 官方登录。", cc))
}

fn fetch_ip_info_remote() -> Result<Value, String> {
  let client = reqwest::blocking::Client::builder()
    .connect_timeout(Duration::from_secs(3))
    .timeout(Duration::from_secs(6))
    .build()
    .map_err(|e| format!("build http client failed: {}", e))?;
  let resp = client
    .get(IP_API_URL)
    .send()
    .map_err(|e| format!("IP 查询失败: {}", e))?;
  if !resp.status().is_success() {
    return Err(format!("IP 查询返回 {}", resp.status()));
  }
  let body: Value = resp.json().map_err(|e| format!("IP 响应解析失败: {}", e))?;
  if body.get("status").and_then(Value::as_str) != Some("success") {
    return Err("IP 查询未返回 success".to_string());
  }
  Ok(body)
}

fn append_history(entry: &Value) -> Result<(), String> {
  ensure_dir(&app_home()?)?;
  let path = ip_history_path()?;
  let existing = read_text(&path)?;
  let now = Utc::now();
  let cutoff = now - ChronoDuration::days(30);
  let new_ip = entry.get("ip").and_then(Value::as_str).unwrap_or("").to_string();
  let new_hour = now.format("%Y-%m-%dT%H").to_string();

  let mut kept = Vec::new();
  let mut saw_dupe = false;
  for line in existing.lines() {
    let line = line.trim();
    if line.is_empty() { continue; }
    let parsed: Value = match serde_json::from_str(line) {
      Ok(v) => v,
      Err(_) => continue,
    };
    let ts_str = parsed.get("ts").and_then(Value::as_str).unwrap_or("");
    let ts = match chrono::DateTime::parse_from_rfc3339(ts_str) {
      Ok(t) => t.with_timezone(&Utc),
      Err(_) => continue,
    };
    if ts < cutoff { continue; }
    // Hour-bucket dedup: if this line is the same IP in the same hour as the
    // new entry, drop it (the new one supersedes).
    let line_ip = parsed.get("ip").and_then(Value::as_str).unwrap_or("").to_string();
    let line_hour = ts.format("%Y-%m-%dT%H").to_string();
    if line_ip == new_ip && line_hour == new_hour {
      saw_dupe = true;
      continue;
    }
    kept.push(parsed);
  }
  kept.push(entry.clone());
  let _ = saw_dupe;

  let mut buf = String::new();
  for row in kept {
    if let Ok(text) = serde_json::to_string(&row) {
      buf.push_str(&text);
      buf.push('\n');
    }
  }
  write_text(&path, &buf)
}

fn read_history_last_n(limit: usize) -> Result<Vec<Value>, String> {
  let path = ip_history_path()?;
  let text = read_text(&path)?;
  if text.trim().is_empty() { return Ok(Vec::new()); }
  let mut rows: Vec<Value> = text
    .lines()
    .filter_map(|l| serde_json::from_str(l.trim()).ok())
    .collect();
  rows.reverse();
  rows.truncate(limit);
  Ok(rows)
}

fn cache_get_fresh() -> Option<Value> {
  let guard = IP_CACHE.lock().ok()?;
  let (ts, val) = guard.as_ref()?;
  if ts.elapsed() < CACHE_TTL { Some(val.clone()) } else { None }
}

fn cache_put(val: Value) {
  if let Ok(mut g) = IP_CACHE.lock() {
    *g = Some((Instant::now(), val));
  }
}

// Public: resolve IP info (cached). Always returns a Value; on error the
// Value has `ok: false` and a human-readable message so the frontend can
// render a muted "无法获取 IP" state instead of blocking the whole page.
fn build_status(force: bool) -> Value {
  if !force {
    if let Some(cached) = cache_get_fresh() {
      return cached;
    }
  }

  let proxy = probe_proxy();
  let has_proxy = proxy.get("hasProxy").and_then(Value::as_bool).unwrap_or(false);

  let remote = match fetch_ip_info_remote() {
    Ok(v) => v,
    Err(e) => {
      return json!({
        "ok": false,
        "error": e,
        "proxy": proxy,
        "verdict": "warn",
        "verdictCopy": "无法联网查询 IP（可能是本地无网络或 3rd-party 服务不可达），暂无法判断是否安全。",
      });
    }
  };

  let ip = remote.get("query").and_then(Value::as_str).unwrap_or("").to_string();
  let country = remote.get("country").and_then(Value::as_str).unwrap_or("").to_string();
  let country_code = remote.get("countryCode").and_then(Value::as_str).unwrap_or("").to_string();
  let city = remote.get("city").and_then(Value::as_str).unwrap_or("").to_string();
  let region = remote.get("regionName").and_then(Value::as_str).unwrap_or("").to_string();
  let isp = remote.get("isp").and_then(Value::as_str).unwrap_or("").to_string();
  let org = remote.get("org").and_then(Value::as_str).unwrap_or("").to_string();
  let asn = remote.get("as").and_then(Value::as_str).unwrap_or("").to_string();

  let (verdict, verdict_copy) = verdict_for(&country_code, has_proxy);

  let ts = Utc::now().to_rfc3339();
  let history_entry = json!({
    "ts": ts,
    "ip": ip,
    "country": country,
    "countryCode": country_code,
    "city": city,
    "region": region,
    "isp": isp,
    "org": org,
    "asn": asn,
  });
  let _ = append_history(&history_entry);

  let status = json!({
    "ok": true,
    "ip": ip,
    "country": country,
    "countryCode": country_code,
    "city": city,
    "region": region,
    "isp": isp,
    "org": org,
    "asn": asn,
    "proxy": proxy,
    "verdict": verdict,
    "verdictCopy": verdict_copy,
    "checkedAt": ts,
  });
  cache_put(status.clone());
  status
}

// ---- Public routes ----

pub(crate) fn get_network_status(_query: &Value) -> Result<Value, String> {
  Ok(build_status(false))
}

pub(crate) fn refresh_network_status(body: &Value) -> Result<Value, String> {
  let obj = parse_json_object(body);
  let force = obj.get("force").and_then(Value::as_bool).unwrap_or(true);
  Ok(build_status(force))
}

// Measures round-trip latency to a handful of neutral endpoints via raw TCP
// connect. Gives the user a sense of how fast their current line is without
// ever touching an AI vendor's API — reaching api.openai.com or
// api.anthropic.com from a flagged region is the exact signal that gets
// accounts banned, so those are deliberately excluded.
//
// Each probe uses std::net::TcpStream::connect_timeout to port 443 with a
// short cap. The user-visible "latency" is the TCP handshake time, not ICMP
// ping — good enough as a relative signal.
pub(crate) fn get_network_latency(_query: &Value) -> Result<Value, String> {
  use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
  use std::time::Instant;

  struct Target {
    label: &'static str,
    host: &'static str,
    port: u16,
    why: &'static str,
  }

  let targets = [
    Target { label: "Cloudflare DNS", host: "1.1.1.1", port: 443, why: "最近公网节点" },
    Target { label: "Google DNS",     host: "8.8.8.8", port: 443, why: "海外公网节点" },
    Target { label: "ip-api.com",     host: "ip-api.com", port: 80, why: "IP 查询服务（我们自己也在用）" },
    // HK edge / CN edge if reachable — gives a "近端 vs 远端" picture
    Target { label: "Github",         host: "github.com", port: 443, why: "常用代码站点" },
  ];

  // Run probes in parallel so total runtime is max-of rather than sum-of.
  let handles: Vec<_> = targets
    .iter()
    .map(|t| {
      let host = t.host.to_string();
      let port = t.port;
      let label = t.label.to_string();
      let why = t.why.to_string();
      std::thread::spawn(move || {
        let addr_res: Result<Vec<SocketAddr>, _> =
          (host.as_str(), port).to_socket_addrs().map(|i| i.collect());
        let resolved_ip = addr_res
          .as_ref()
          .ok()
          .and_then(|v| v.first().map(|s| s.ip().to_string()))
          .unwrap_or_default();
        let start = Instant::now();
        let outcome = match addr_res {
          Ok(addrs) => {
            let Some(first) = addrs.first().copied() else {
              return json!({
                "label": label, "host": host, "port": port, "why": why,
                "ok": false, "error": "DNS 解析失败", "ms": 0, "ip": resolved_ip,
              });
            };
            match TcpStream::connect_timeout(&first, std::time::Duration::from_millis(3000)) {
              Ok(_) => {
                let ms = start.elapsed().as_millis() as u64;
                json!({
                  "label": label, "host": host, "port": port, "why": why,
                  "ok": true, "ms": ms, "ip": resolved_ip,
                })
              }
              Err(e) => json!({
                "label": label, "host": host, "port": port, "why": why,
                "ok": false, "error": e.to_string(), "ms": 0, "ip": resolved_ip,
              }),
            }
          }
          Err(e) => json!({
            "label": label, "host": host, "port": port, "why": why,
            "ok": false, "error": format!("DNS: {}", e), "ms": 0, "ip": resolved_ip,
          }),
        };
        outcome
      })
    })
    .collect();

  let rows: Vec<Value> = handles.into_iter().filter_map(|h| h.join().ok()).collect();

  // Summary stats to make the section glanceable.
  let oks: Vec<u64> = rows
    .iter()
    .filter_map(|r| if r.get("ok").and_then(Value::as_bool).unwrap_or(false) {
      r.get("ms").and_then(Value::as_u64)
    } else { None })
    .collect();
  let avg = if oks.is_empty() { 0 } else { oks.iter().sum::<u64>() / oks.len() as u64 };
  let max = oks.iter().copied().max().unwrap_or(0);
  let reachable = oks.len();
  let total = rows.len();

  Ok(json!({
    "rows": rows,
    "summary": {
      "avgMs": avg,
      "maxMs": max,
      "reachable": reachable,
      "total": total,
    },
  }))
}

pub(crate) fn list_network_ip_history(query: &Value) -> Result<Value, String> {
  let obj = parse_json_object(query);
  let limit = get_string(&obj, "limit")
    .parse::<usize>()
    .ok()
    .filter(|n| *n > 0 && *n <= 500)
    .unwrap_or(50);
  let rows = read_history_last_n(limit)?;
  Ok(json!({ "rows": rows }))
}
