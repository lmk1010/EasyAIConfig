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
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::provider::get_string;
use crate::{app_home, ensure_dir, parse_json_object, read_text, write_text};

const IP_HISTORY_FILE: &str = "ip-history.jsonl";
const CACHE_TTL: Duration = Duration::from_secs(300); // 5 min
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
fn process_command(program: &str) -> Command {
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(not(target_os = "windows"))]
fn process_command(program: &str) -> Command {
    Command::new(program)
}

// Ordered list of geo-IP providers to try. The first one that returns a
// well-formed response wins. We prefer HTTPS so captive portals / firewalls
// that strip HTTP don't leave us blind; ip-api.com is kept as a last-resort
// fallback because it has the richest data but only speaks plain HTTP on the
// free tier.
struct IpProvider {
    label: &'static str,
    url: &'static str,
    kind: IpProviderKind,
}

#[derive(Clone, Copy)]
enum IpProviderKind {
    // { ip, country_code, country_name, region, city, org, ... }
    IpapiCo,
    // { ip, country, country_code, city, region, org, isp, ... }
    Ipwhois,
    // { status:"success", country, countryCode, regionName, city, isp, org, as, query }
    IpApiCom,
    // just { ip }
    Ipify,
}

const IP_PROVIDERS: &[IpProvider] = &[
  IpProvider { label: "ipapi.co",   url: "https://ipapi.co/json/",                    kind: IpProviderKind::IpapiCo },
  IpProvider { label: "ipwho.is",   url: "https://ipwho.is/",                          kind: IpProviderKind::Ipwhois },
  IpProvider { label: "ip-api.com", url: "http://ip-api.com/json/?fields=status,country,countryCode,regionName,city,isp,org,as,query", kind: IpProviderKind::IpApiCom },
  IpProvider { label: "ipify.org",  url: "https://api.ipify.org?format=json",         kind: IpProviderKind::Ipify },
];

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
    for key in &[
        "http_proxy",
        "https_proxy",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "all_proxy",
    ] {
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
        if let Ok(out) = process_command("scutil").arg("--proxy").output() {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                if text.contains("HTTPEnable : 1")
                    || text.contains("HTTPSEnable : 1")
                    || text.contains("SOCKSEnable : 1")
                {
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
        return (
            "warn",
            "无法识别当前 IP 的国家信息，建议先确认出口线路。".to_string(),
        );
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
    (
        "safe",
        format!(
            "出口 IP 位于 {}，可正常使用 Codex / Claude Code 官方登录。",
            cc
        ),
    )
}

// Pick up OS / shell proxy config so reqwest goes through the same tunnel
// the user's browser would. reqwest auto-reads http(s)_proxy env vars but
// NOT macOS system proxy — we pull that in via `scutil --proxy`.
fn detect_system_proxy_url() -> Option<String> {
    for key in &[
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ] {
        if let Ok(v) = std::env::var(key) {
            let v = v.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = process_command("scutil").arg("--proxy").output() {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                // Prefer SOCKS (works for both HTTP/HTTPS), then HTTPS, then HTTP.
                // Very simple parse — scutil prints dict-like lines.
                let parse = |prefix: &str| -> Option<(String, u16)> {
                    let mut host: Option<String> = None;
                    let mut port: Option<u16> = None;
                    let mut enabled = false;
                    for line in text.lines() {
                        let t = line.trim();
                        if t.starts_with(&format!("{}Enable", prefix)) {
                            enabled = t.contains(": 1");
                        } else if t.starts_with(&format!("{}Proxy", prefix)) {
                            host = t.split(':').nth(1).map(|s| s.trim().to_string());
                        } else if t.starts_with(&format!("{}Port", prefix)) {
                            port = t.split(':').nth(1).and_then(|s| s.trim().parse().ok());
                        }
                    }
                    if enabled {
                        host.zip(port)
                    } else {
                        None
                    }
                };
                if let Some((h, p)) = parse("SOCKS") {
                    return Some(format!("socks5://{}:{}", h, p));
                }
                if let Some((h, p)) = parse("HTTPS") {
                    return Some(format!("http://{}:{}", h, p));
                }
                if let Some((h, p)) = parse("HTTP") {
                    return Some(format!("http://{}:{}", h, p));
                }
            }
        }
    }
    None
}

fn build_probe_client() -> Result<reqwest::blocking::Client, String> {
    let mut b = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(8))
        .user_agent("EasyAIConfig/1.0 (IP geolocation probe)");
    if let Some(url) = detect_system_proxy_url() {
        if let Ok(proxy) = reqwest::Proxy::all(&url) {
            b = b.proxy(proxy);
        }
    }
    b.build()
        .map_err(|e| format!("build http client failed: {}", e))
}

// Fallback HTTP fetch via the system `curl` binary. Used when reqwest fails
// — curl transparently obeys:
//   - shell http_proxy / https_proxy / all_proxy env vars
//   - ~/.curlrc
//   - macOS system proxy (indirectly, since most Clash-style tools set the
//     env vars when system-proxy mode is on)
// so in practice this catches every proxy configuration reqwest misses.
// Returns parsed JSON on success; err string on failure.
fn curl_fetch_json(url: &str) -> Result<Value, String> {
    let proxy_arg = detect_system_proxy_url();
    let mut cmd = process_command("curl");
    cmd.args([
        "-sS", // silent, but show errors
        "--max-time",
        "8",
        "--connect-timeout",
        "4",
        "-A",
        "EasyAIConfig/1.0 (IP geolocation probe)",
    ]);
    if let Some(p) = &proxy_arg {
        cmd.args(["-x", p]);
    }
    cmd.arg(url);
    let out = cmd.output().map_err(|e| format!("curl 调用失败: {}", e))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("curl 退出码 {}", out.status)
        } else {
            err
        });
    }
    let text = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str::<Value>(&text).map_err(|e| format!("curl 响应解析失败: {}", e))
}

// Parallel-probe every provider and return a Vec of normalized results,
// tagging failures with an error string so the UI can surface which source
// is flaky. We never "fall back" silently — every row is a vantage point
// the user can see.
fn probe_all_providers() -> Vec<Value> {
    let handles: Vec<_> = IP_PROVIDERS
        .iter()
        .map(|p| {
            let label = p.label.to_string();
            let url = p.url.to_string();
            let _kind = p.kind;
            std::thread::spawn(move || {
                let start = std::time::Instant::now();
                let mut via_transport = "reqwest";
                let mut reqwest_err = String::new();

                // Attempt 1: reqwest (fast, single binary, obeys detect_system_proxy_url).
                let parsed_body: Option<Value> = (|| -> Option<Value> {
                    let client = match build_probe_client() {
                        Ok(c) => c,
                        Err(e) => {
                            reqwest_err = e;
                            return None;
                        }
                    };
                    let resp = match client.get(&url).send() {
                        Ok(r) => r,
                        Err(e) => {
                            reqwest_err = format!("{}", e);
                            return None;
                        }
                    };
                    if !resp.status().is_success() {
                        reqwest_err = format!("HTTP {}", resp.status());
                        return None;
                    }
                    match resp.json::<Value>() {
                        Ok(v) => Some(v),
                        Err(e) => {
                            reqwest_err = format!("parse {}", e);
                            None
                        }
                    }
                })();

                // Attempt 2: curl fallback — catches every macOS proxy setup reqwest
                // misses (SOCKS without the right feature, TUN, corporate MITM certs
                // that rustls won't trust, etc).
                let body = match parsed_body {
                    Some(v) => v,
                    None => {
                        via_transport = "curl";
                        match curl_fetch_json(&url) {
                            Ok(v) => v,
                            Err(curl_err) => {
                                let err = if reqwest_err.is_empty() {
                                    curl_err
                                } else {
                                    format!("{} (curl: {})", reqwest_err, curl_err)
                                };
                                return json!({
                                  "label": label, "ok": false, "error": err,
                                  "ms": start.elapsed().as_millis() as u64,
                                  "transport": "none",
                                });
                            }
                        }
                    }
                };

                let provider_ref = IP_PROVIDERS.iter().find(|x| x.label == label);
                match provider_ref.and_then(|p| normalize_provider_response(p, body)) {
                    Some(mut norm) => {
                        if let Some(obj) = norm.as_object_mut() {
                            obj.insert("ok".to_string(), json!(true));
                            obj.insert("label".to_string(), json!(label));
                            obj.insert("ms".to_string(), json!(start.elapsed().as_millis() as u64));
                            obj.insert("transport".to_string(), json!(via_transport));
                        }
                        norm
                    }
                    None => json!({
                      "label": label, "ok": false, "error": "返回结构不符",
                      "ms": start.elapsed().as_millis() as u64,
                      "transport": via_transport,
                    }),
                }
            })
        })
        .collect();

    handles.into_iter().filter_map(|h| h.join().ok()).collect()
}

// Pick the "primary" result for the hero: prefer a vantage that returned a
// country code; tie-break by fastest response.
fn pick_primary(vantages: &[Value]) -> Option<Value> {
    let mut best: Option<&Value> = None;
    let mut best_ms: u64 = u64::MAX;
    for v in vantages {
        if v.get("ok").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let has_geo = !v
            .get("countryCode")
            .and_then(Value::as_str)
            .unwrap_or("")
            .is_empty();
        let ms = v.get("ms").and_then(Value::as_u64).unwrap_or(u64::MAX);
        let score_ok = has_geo;
        let cur_score_ok = best
            .map(|b| {
                !b.get("countryCode")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .is_empty()
            })
            .unwrap_or(false);
        if best.is_none()
            || (score_ok && !cur_score_ok)
            || (score_ok == cur_score_ok && ms < best_ms)
        {
            best = Some(v);
            best_ms = ms;
        }
    }
    best.cloned()
}

fn normalize_provider_response(p: &IpProvider, body: Value) -> Option<Value> {
    let obj = body.as_object()?;
    let s = |k: &str| obj.get(k).and_then(Value::as_str).unwrap_or("").to_string();

    match p.kind {
        IpProviderKind::IpapiCo => {
            if !obj.contains_key("ip") {
                return None;
            }
            Some(json!({
              "query": s("ip"),
              "country": s("country_name"),
              "countryCode": s("country_code"),
              "regionName": s("region"),
              "city": s("city"),
              "isp": s("org"),
              "org": s("org"),
              "as": s("asn"),
              "via": p.label,
            }))
        }
        IpProviderKind::Ipwhois => {
            // ipwho.is uses "success" bool and fields {ip, country, country_code, city, region, connection.isp}
            if obj.get("success").and_then(Value::as_bool) == Some(false) {
                return None;
            }
            let ip = s("ip");
            if ip.is_empty() {
                return None;
            }
            let conn = obj.get("connection").and_then(Value::as_object);
            let isp = conn
                .and_then(|c| c.get("isp").and_then(Value::as_str))
                .unwrap_or("")
                .to_string();
            let org = conn
                .and_then(|c| c.get("org").and_then(Value::as_str))
                .unwrap_or("")
                .to_string();
            let as_s = conn
                .and_then(|c| {
                    c.get("asn").and_then(|v| {
                        v.as_u64()
                            .map(|n| n.to_string())
                            .or_else(|| v.as_str().map(|s| s.to_string()))
                    })
                })
                .unwrap_or_default();
            Some(json!({
              "query": ip,
              "country": s("country"),
              "countryCode": s("country_code"),
              "regionName": s("region"),
              "city": s("city"),
              "isp": isp,
              "org": org,
              "as": as_s,
              "via": p.label,
            }))
        }
        IpProviderKind::IpApiCom => {
            if obj.get("status").and_then(Value::as_str) != Some("success") {
                return None;
            }
            Some(json!({
              "query": s("query"),
              "country": s("country"),
              "countryCode": s("countryCode"),
              "regionName": s("regionName"),
              "city": s("city"),
              "isp": s("isp"),
              "org": s("org"),
              "as": s("as"),
              "via": p.label,
            }))
        }
        IpProviderKind::Ipify => {
            let ip = s("ip");
            if ip.is_empty() {
                return None;
            }
            Some(json!({
              "query": ip,
              "country": "",
              "countryCode": "",
              "regionName": "",
              "city": "",
              "isp": "",
              "org": "",
              "as": "",
              "via": p.label,
            }))
        }
    }
}

fn append_history(entry: &Value) -> Result<(), String> {
    ensure_dir(&app_home()?)?;
    let path = ip_history_path()?;
    let existing = read_text(&path)?;
    let now = Utc::now();
    let cutoff = now - ChronoDuration::days(30);
    let new_ip = entry
        .get("ip")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let new_hour = now.format("%Y-%m-%dT%H").to_string();

    let mut kept = Vec::new();
    let mut saw_dupe = false;
    for line in existing.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parsed: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ts_str = parsed.get("ts").and_then(Value::as_str).unwrap_or("");
        let ts = match chrono::DateTime::parse_from_rfc3339(ts_str) {
            Ok(t) => t.with_timezone(&Utc),
            Err(_) => continue,
        };
        if ts < cutoff {
            continue;
        }
        // Hour-bucket dedup: if this line is the same IP in the same hour as the
        // new entry, drop it (the new one supersedes).
        let line_ip = parsed
            .get("ip")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
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
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
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
    if ts.elapsed() < CACHE_TTL {
        Some(val.clone())
    } else {
        None
    }
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
    let has_proxy = proxy
        .get("hasProxy")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let vantages = probe_all_providers();
    let primary = match pick_primary(&vantages) {
        Some(v) => v,
        None => {
            let errs: Vec<String> = vantages
                .iter()
                .filter_map(|v| {
                    let label = v
                        .get("label")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let err = v
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if err.is_empty() {
                        None
                    } else {
                        Some(format!("{}: {}", label, err))
                    }
                })
                .collect();
            return json!({
              "ok": false,
              "error": if errs.is_empty() { "所有 IP 查询服务均不可达".to_string() } else { errs.join(" · ") },
              "vantages": vantages,
              "proxy": proxy,
              "verdict": "warn",
              "verdictCopy": "无法联网查询 IP。所有中立节点都不可达。",
            });
        }
    };

    let ip = primary
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let country = primary
        .get("country")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let country_code = primary
        .get("countryCode")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let city = primary
        .get("city")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let region = primary
        .get("regionName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let isp = primary
        .get("isp")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let org = primary
        .get("org")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let asn = primary
        .get("as")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let via = primary
        .get("via")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    // Split-tunnel detection: if any two OK vantages report different IPs,
    // routing is inconsistent — worth warning about because the IP Google /
    // OpenAI / Anthropic actually sees may not match the primary one.
    let mut seen_ips: Vec<String> = Vec::new();
    for v in &vantages {
        if v.get("ok").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let q = v
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if q.is_empty() {
            continue;
        }
        if !seen_ips.contains(&q) {
            seen_ips.push(q);
        }
    }
    let split_tunnel = seen_ips.len() > 1;

    let (mut verdict, mut verdict_copy) = verdict_for(&country_code, has_proxy);
    if split_tunnel && verdict != "block" {
        verdict = "warn";
        verdict_copy = format!(
      "检测到分流 — 不同视角看到的 IP 不一致（{}）。AI 服务看到的 IP 可能与首选视角不同，启动前请确认。",
      seen_ips.join(" / ")
    );
    }

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
      "via": via,
      "vantages": vantages,
      "splitTunnel": split_tunnel,
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
        Target {
            label: "Cloudflare DNS",
            host: "1.1.1.1",
            port: 443,
            why: "最近公网节点",
        },
        Target {
            label: "Google DNS",
            host: "8.8.8.8",
            port: 443,
            why: "海外公网节点",
        },
        Target {
            label: "ip-api.com",
            host: "ip-api.com",
            port: 80,
            why: "IP 查询服务（我们自己也在用）",
        },
        // HK edge / CN edge if reachable — gives a "近端 vs 远端" picture
        Target {
            label: "Github",
            host: "github.com",
            port: 443,
            why: "常用代码站点",
        },
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
                        match TcpStream::connect_timeout(
                            &first,
                            std::time::Duration::from_millis(3000),
                        ) {
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
        .filter_map(|r| {
            if r.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                r.get("ms").and_then(Value::as_u64)
            } else {
                None
            }
        })
        .collect();
    let avg = if oks.is_empty() {
        0
    } else {
        oks.iter().sum::<u64>() / oks.len() as u64
    };
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
