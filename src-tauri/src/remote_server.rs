// 手机端远程访问服务（P0 「最强」项）。
//
// 在桌面 App 里按需拉起一个绑定 0.0.0.0 的轻量 HTTP 服务，把现有的 dispatch()
// API 面原样暴露给手机浏览器（同一路径 / 方法 / {ok,data} 形态），配一个手机专用
// Web UI（remote_mobile.html + 内嵌 xterm）。这样：
//   - 同一 WiFi：手机直接开 http://<内网IP>:<port>/#t=<token>
//   - 跨网 / 4G：配一台 VPS 用 SSH 反向隧道 (-R) 把本机端口中转出去
//
// 安全：所有 /api/* 必须带正确 token（header x-remote-token 或 query token）。
// 静态资源（HTML / xterm）无秘密，可直接取。只放开一组白名单 API，避免手机误触
// 卸载 / 更新等危险操作。

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::provider::get_string;
use crate::{app_home, ensure_dir, parse_json_object, read_text, routes::dispatch, write_secret};

const DEFAULT_PORT: u16 = 8790;
const REMOTE_CONFIG_FILE: &str = "remote-config.json";
const MOBILE_HTML: &str = include_str!("remote_mobile.html");
const XTERM_JS: &str = include_str!("../../public/vendor/xterm/xterm.mjs");
const XTERM_CSS: &str = include_str!("../../public/vendor/xterm/xterm.css");
const XTERM_FIT: &str = include_str!("../../public/vendor/xterm/addon-fit.mjs");
const MAX_HEADER_BYTES: usize = 32 * 1024;
// 32MB：给手机端图片上传留足余量（base64 会膨胀 ~33%）
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

// 手机端能调用的 API 前缀白名单。故意不含 install/uninstall/update 等危险操作。
const REMOTE_API_ALLOW: &[&str] = &[
    "/api/terminal/",
    "/api/terminal/stream",
    "/api/codex/",
    "/api/claude/",
    "/api/agent/",
    "/api/state",
    "/api/sessions/inventory",
    "/api/claudecode/state",
    "/api/claudecode/oauth/profiles",
    "/api/codex/oauth/profiles",
    "/api/project-binding",
    "/api/project-bindings",
    "/api/provider/test-saved",
    "/api/config/save",
];

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
pub(crate) fn install(handle: &AppHandle) {
    let _ = APP_HANDLE.set(handle.clone());
}

struct RemoteState {
    port: u16,
    token: String,
    stop: Arc<AtomicBool>,
}

struct TunnelState {
    child: Child,
    host: String,
    remote_port: u16,
    ssh_user: String,
}

// ─── 已连接手机客户端登记（按 IP）──────────────────────────────
#[derive(Clone)]
struct ClientInfo {
    ip: String,
    last_seen_ms: i64,
    user_agent: String,
    last_path: String,
    requests: u64,
    first_seen_ms: i64,
}
fn clients() -> &'static Mutex<std::collections::HashMap<String, ClientInfo>> {
    static C: OnceLock<Mutex<std::collections::HashMap<String, ClientInfo>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}
/// 每个通过鉴权的远程请求登记一次来源手机(排除本机回环)。
fn record_client(ip: &str, ua: &str, path: &str) {
    if ip.is_empty() || ip.starts_with("127.") || ip == "::1" || ip == "localhost" {
        return;
    }
    let now = chrono::Utc::now().timestamp_millis();
    if let Ok(mut map) = clients().lock() {
        let entry = map.entry(ip.to_string()).or_insert(ClientInfo {
            ip: ip.to_string(),
            last_seen_ms: now,
            user_agent: ua.to_string(),
            last_path: path.to_string(),
            requests: 0,
            first_seen_ms: now,
        });
        entry.last_seen_ms = now;
        if !ua.is_empty() {
            entry.user_agent = ua.to_string();
        }
        entry.last_path = path.to_string();
        entry.requests += 1;
    }
}
/// 已连接客户端列表(最近 5 分钟出现过的)，在线=30s 内活跃。
fn clients_value() -> Value {
    let now = chrono::Utc::now().timestamp_millis();
    let mut list: Vec<Value> = Vec::new();
    if let Ok(map) = clients().lock() {
        for c in map.values() {
            let age = now - c.last_seen_ms;
            if age > 300_000 {
                continue;
            }
            list.push(json!({
                "ip": c.ip,
                "lastSeenMs": c.last_seen_ms,
                "firstSeenMs": c.first_seen_ms,
                "online": age < 30_000,
                "userAgent": c.user_agent,
                "lastPath": c.last_path,
                "requests": c.requests,
            }));
        }
    }
    list.sort_by(|a, b| {
        b.get("lastSeenMs")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .cmp(&a.get("lastSeenMs").and_then(Value::as_i64).unwrap_or(0))
    });
    Value::Array(list)
}

fn server_state() -> &'static Mutex<Option<RemoteState>> {
    static S: OnceLock<Mutex<Option<RemoteState>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

// ─── 远程配置持久化（~/.codex-config-ui/remote-config.json）──────────────
// 存 { enabled, port, token, tunnel:{...,autostart} }。作用：
//   1) token 持久化 → 桌面重启后手机无需重新配对（会话/QR 保持不变）
//   2) enabled/tunnel 持久化 → 开机自动恢复远程服务与 VPS 隧道（"一键"体验）
fn config_path() -> Option<PathBuf> {
    app_home().ok().map(|d| d.join(REMOTE_CONFIG_FILE))
}

fn load_saved_config() -> Value {
    if let Some(path) = config_path() {
        if let Ok(text) = read_text(&path) {
            if !text.trim().is_empty() {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    return value;
                }
            }
        }
    }
    json!({})
}

fn save_saved_config(value: &Value) {
    if let Ok(home) = app_home() {
        let _ = ensure_dir(&home);
    }
    if let Some(path) = config_path() {
        if let Ok(text) = serde_json::to_string_pretty(value) {
            let _ = write_secret(&path, &text); // 含 token，0600
        }
    }
}

fn persist_server_state(enabled: bool, port: u16, token: &str) {
    let mut cfg = load_saved_config();
    if !cfg.is_object() {
        cfg = json!({});
    }
    if let Some(obj) = cfg.as_object_mut() {
        obj.insert("enabled".to_string(), json!(enabled));
        obj.insert("port".to_string(), json!(port));
        obj.insert("token".to_string(), json!(token));
    }
    save_saved_config(&cfg);
}

fn persist_tunnel_config(tunnel: Option<Value>) {
    let mut cfg = load_saved_config();
    if !cfg.is_object() {
        cfg = json!({});
    }
    if let Some(obj) = cfg.as_object_mut() {
        match tunnel {
            Some(t) => {
                obj.insert("tunnel".to_string(), t);
            }
            None => {
                // 保留隧道参数，只把 autostart 关掉
                if let Some(existing) = obj.get_mut("tunnel").and_then(Value::as_object_mut) {
                    existing.insert("autostart".to_string(), json!(false));
                }
            }
        }
    }
    save_saved_config(&cfg);
}

fn saved_token() -> String {
    load_saved_config()
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn saved_autostart() -> bool {
    load_saved_config()
        .get("autoStart")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn persist_autostart(on: bool) {
    let mut cfg = load_saved_config();
    if !cfg.is_object() {
        cfg = json!({});
    }
    if let Some(obj) = cfg.as_object_mut() {
        obj.insert("autoStart".to_string(), json!(on));
    }
    save_saved_config(&cfg);
}

fn tunnel_state() -> &'static Mutex<Option<TunnelState>> {
    static S: OnceLock<Mutex<Option<TunnelState>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

// 给一个 IPv4 打分：分越高越像"手机能连的真实局域网地址"。
// 关键：排除 VPN / 保留段（198.18/15 基准测试段、CGNAT 100.64/10、
// 链路本地 169.254、回环等），家庭/办公常见的 192.168、10.x、172.16-31 优先。
fn lan_ip_score(ip: &std::net::Ipv4Addr) -> i32 {
    let o = ip.octets();
    if ip.is_loopback() || ip.is_unspecified() {
        return -1000;
    }
    if o[0] == 169 && o[1] == 254 {
        return -900; // link-local
    }
    if o[0] == 198 && (o[1] == 18 || o[1] == 19) {
        return -800; // 基准测试段（常被 VPN/虚拟网卡借用，就是本次踩的坑）
    }
    if o[0] == 100 && (64..=127).contains(&o[1]) {
        return -700; // CGNAT / 部分 VPN
    }
    if o[0] == 192 && o[1] == 168 {
        return 100; // 最常见的家用/办公 WiFi
    }
    if o[0] == 10 {
        return 80;
    }
    if o[0] == 172 && (16..=31).contains(&o[1]) {
        return 70;
    }
    if !ip.is_private() {
        return 10; // 公网地址（少见，但比 VPN 保留段强）
    }
    30
}

// 枚举所有网卡，返回按"像真实局域网"降序排序的 IPv4 列表。
fn candidate_lan_ips() -> Vec<String> {
    let mut scored: Vec<(i32, String)> = Vec::new();
    if let Ok(list) = local_ip_address::list_afinet_netifas() {
        for (_name, addr) in list {
            if let std::net::IpAddr::V4(v4) = addr {
                let score = lan_ip_score(&v4);
                if score <= -100 {
                    continue; // 丢弃 VPN / 保留 / 回环
                }
                scored.push((score, v4.to_string()));
            }
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    scored.dedup_by(|a, b| a.1 == b.1);
    scored.into_iter().map(|(_, ip)| ip).collect()
}

// 主内网 IP：优先取评分最高的候选；都没有再退回 UDP 探测法。
fn primary_lan_ip() -> Option<String> {
    if let Some(ip) = candidate_lan_ips().into_iter().next() {
        return Some(ip);
    }
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let addr = socket.local_addr().ok()?;
    let ip = addr.ip().to_string();
    if ip == "0.0.0.0" {
        None
    } else {
        Some(ip)
    }
}

fn qr_svg(text: &str) -> Option<String> {
    use qrcode::render::svg;
    use qrcode::QrCode;
    let code = QrCode::new(text.as_bytes()).ok()?;
    let image = code
        .render::<svg::Color>()
        .min_dimensions(224, 224)
        .quiet_zone(true)
        .dark_color(svg::Color("#0b0e14"))
        .light_color(svg::Color("#ffffff"))
        .build();
    Some(image)
}

fn status_value(state: &RemoteState) -> Value {
    let candidates = candidate_lan_ips();
    // 用户手动指定过 IP 就优先它（应对多网卡/特殊拓扑）
    let manual_ip = load_saved_config()
        .get("manualIp")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let chosen_ip = manual_ip
        .clone()
        .or_else(|| candidates.first().cloned())
        .or_else(primary_lan_ip);
    let make_url =
        |host: &str| format!("http://{host}:{}/#t={}", state.port, state.token);
    let primary_url = chosen_ip.as_deref().map(make_url);
    // 所有候选（供 UI 下拉切换）：手动 IP 置顶，其余按评分。
    let mut url_list: Vec<Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for host in manual_ip.iter().chain(candidates.iter()) {
        if seen.insert(host.clone()) {
            url_list.push(json!({ "ip": host, "url": make_url(host) }));
        }
    }
    let urls = url_list;
    let qr = primary_url.as_deref().and_then(qr_svg);
    let tunnel = tunnel_state()
        .lock()
        .ok()
        .and_then(|guard| {
            guard.as_ref().map(|t| {
                json!({
                    "active": true,
                    "host": t.host,
                    "sshUser": t.ssh_user,
                    "remotePort": t.remote_port,
                    "url": format!("http://{}:{}/#t={}", t.host, t.remote_port, state.token),
                })
            })
        })
        .unwrap_or_else(|| json!({ "active": false }));
    json!({
        "enabled": true,
        "port": state.port,
        "token": state.token,
        "primaryUrl": primary_url,
        "chosenIp": chosen_ip,
        "manualIp": manual_ip,
        "urls": urls,
        "qrSvg": qr,
        "tunnel": tunnel,
        "autoStart": saved_autostart(),
        "clients": clients_value(),
    })
}

pub(crate) fn remote_status(_query: &Value) -> Result<Value, String> {
    let guard = server_state().lock().map_err(|e| e.to_string())?;
    match guard.as_ref() {
        Some(state) => Ok(status_value(state)),
        None => Ok(json!({
            "enabled": false,
            "autoStart": saved_autostart(),
            "clients": clients_value(),
            "tunnel": { "active": false },
        })),
    }
}

/// 设置「开机自启」开关（独立于当前是否开启）。
pub(crate) fn remote_set_autostart(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let on = object
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    persist_autostart(on);
    remote_status(&json!({}))
}

/// 手动指定/切换手机要连的本机 IP（应对多网卡/VPN 场景）。传空串清除。
pub(crate) fn remote_set_ip(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let ip = get_string(&object, "ip");
    let mut cfg = load_saved_config();
    if !cfg.is_object() {
        cfg = json!({});
    }
    if let Some(obj) = cfg.as_object_mut() {
        if ip.trim().is_empty() {
            obj.remove("manualIp");
        } else {
            obj.insert("manualIp".to_string(), json!(ip.trim()));
        }
    }
    save_saved_config(&cfg);
    remote_status(&json!({}))
}

// 真正拉起监听 + 后台 accept 线程。token 复用持久化里的那份（保持手机配对）。
fn start_server_with(requested_port: u16, token: String) -> Result<Value, String> {
    let mut guard = server_state().lock().map_err(|e| e.to_string())?;
    if let Some(existing) = guard.as_ref() {
        return Ok(status_value(existing));
    }
    let (listener, port) = match TcpListener::bind(("0.0.0.0", requested_port)) {
        Ok(listener) => {
            let port = listener.local_addr().map(|a| a.port()).unwrap_or(requested_port);
            (listener, port)
        }
        Err(_) => {
            let listener = TcpListener::bind(("0.0.0.0", 0))
                .map_err(|e| format!("无法绑定端口：{e}"))?;
            let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
            (listener, port)
        }
    };
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_thread = Arc::clone(&stop);
    let token_for_thread = token.clone();
    thread::spawn(move || serve(listener, token_for_thread, stop_for_thread));

    let state = RemoteState {
        port,
        token: token.clone(),
        stop,
    };
    let value = status_value(&state);
    *guard = Some(state);
    persist_server_state(true, port, &token);
    Ok(value)
}

pub(crate) fn remote_start(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let requested_port = object
        .get("port")
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
        })
        .filter(|p| *p <= u16::MAX as u64)
        .map(|p| p as u16)
        .unwrap_or_else(|| {
            load_saved_config()
                .get("port")
                .and_then(Value::as_u64)
                .map(|p| p as u16)
                .unwrap_or(DEFAULT_PORT)
        });

    // token：显式 rotateToken 才换新，否则复用持久化的那份（手机不用重新配对）
    let rotate = object
        .get("rotateToken")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let existing_token = saved_token();
    let token = if rotate || existing_token.is_empty() {
        uuid::Uuid::new_v4().simple().to_string()
    } else {
        existing_token
    };
    start_server_with(requested_port, token)
}

pub(crate) fn remote_stop(_body: &Value) -> Result<Value, String> {
    // 先停隧道再停本地服务
    let _ = tunnel_stop(&json!({}));
    let mut guard = server_state().lock().map_err(|e| e.to_string())?;
    if let Some(state) = guard.take() {
        state.stop.store(true, Ordering::SeqCst);
        // 主动踢一下 accept 循环（连自己一下让 accept 返回后看到 stop）
        let _ = TcpStream::connect(("127.0.0.1", state.port));
        // 保留 token，仅标记 disabled（下次开启仍复用同一 token）
        persist_server_state(false, state.port, &state.token);
    }
    Ok(json!({ "enabled": false, "tunnel": { "active": false } }))
}

/// 桌面启动时调用：只要上次处于「开启」状态(enabled)或显式打开了「开机自启」，
/// 就自动恢复远程服务（含隧道 autostart 一并重连）。这样 dev 重启 / 重开 app
/// 后手机无需重新配对、服务不掉。
pub(crate) fn restore_on_launch() {
    let cfg = load_saved_config();
    let want = saved_autostart()
        || cfg.get("enabled").and_then(Value::as_bool) == Some(true);
    if !want {
        return;
    }
    let port = cfg
        .get("port")
        .and_then(Value::as_u64)
        .map(|p| p as u16)
        .unwrap_or(DEFAULT_PORT);
    let token = {
        let t = saved_token();
        if t.is_empty() {
            uuid::Uuid::new_v4().simple().to_string()
        } else {
            t
        }
    };
    if start_server_with(port, token).is_err() {
        return;
    }
    if let Some(tunnel) = cfg.get("tunnel") {
        if tunnel.get("autostart").and_then(Value::as_bool) == Some(true) {
            let _ = tunnel_start(&tunnel.clone());
        }
    }
}

// ─── SSH 反向隧道（VPS 中转）────────────────────────────────────────────
// 等价命令：ssh -N -o ExitOnForwardFailure=yes -R <remotePort>:localhost:<localPort> user@host
pub(crate) fn tunnel_start(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let host = get_string(&object, "host");
    if host.trim().is_empty() {
        return Err("VPS host 不能为空".to_string());
    }
    let ssh_user = {
        let u = get_string(&object, "sshUser");
        if u.trim().is_empty() {
            "root".to_string()
        } else {
            u
        }
    };
    let ssh_port = object
        .get("sshPort")
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
        })
        .filter(|p| *p <= u16::MAX as u64)
        .map(|p| p as u16)
        .unwrap_or(22);
    let remote_port = object
        .get("remotePort")
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
        })
        .filter(|p| *p <= u16::MAX as u64)
        .map(|p| p as u16)
        .unwrap_or(8790);
    let identity_file = get_string(&object, "identityFile");

    // 必须先有本地服务
    let local_port = {
        let guard = server_state().lock().map_err(|e| e.to_string())?;
        match guard.as_ref() {
            Some(state) => state.port,
            None => return Err("请先开启本机远程服务，再建立 VPS 隧道".to_string()),
        }
    };

    // 关掉旧隧道
    let _ = tunnel_stop(&json!({}));

    let forward = format!("{remote_port}:localhost:{local_port}");
    let target = format!("{ssh_user}@{host}");
    let mut command = Command::new("ssh");
    command
        .arg("-N")
        .arg("-o")
        .arg("ExitOnForwardFailure=yes")
        .arg("-o")
        .arg("ServerAliveInterval=30")
        .arg("-o")
        .arg("ServerAliveCountMax=3")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-p")
        .arg(ssh_port.to_string())
        .arg("-R")
        .arg(&forward);
    if !identity_file.trim().is_empty() {
        command.arg("-i").arg(identity_file.trim());
    }
    command.arg(&target);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let child = command
        .spawn()
        .map_err(|e| format!("启动 ssh 失败（确认已安装 ssh 客户端并配置免密）：{e}"))?;

    let mut guard = tunnel_state().lock().map_err(|e| e.to_string())?;
    *guard = Some(TunnelState {
        child,
        host: host.trim().to_string(),
        remote_port,
        ssh_user: ssh_user.clone(),
    });
    drop(guard);

    // 持久化隧道参数（开机自动重连）
    persist_tunnel_config(Some(json!({
        "host": host.trim(),
        "sshUser": ssh_user,
        "sshPort": ssh_port,
        "remotePort": remote_port,
        "identityFile": identity_file.trim(),
        "autostart": true,
    })));

    // 回读一份完整状态（含隧道 url）
    let server_guard = server_state().lock().map_err(|e| e.to_string())?;
    match server_guard.as_ref() {
        Some(state) => Ok(status_value(state)),
        None => Ok(json!({ "enabled": false })),
    }
}

pub(crate) fn tunnel_stop(_body: &Value) -> Result<Value, String> {
    let mut guard = tunnel_state().lock().map_err(|e| e.to_string())?;
    if let Some(mut tunnel) = guard.take() {
        let _ = tunnel.child.kill();
        let _ = tunnel.child.wait();
    }
    // 关掉隧道 autostart（保留参数，方便下次一键重连）
    persist_tunnel_config(None);
    Ok(json!({ "active": false }))
}

/// VPS 一键前置检查：用 BatchMode ssh 快速验证 (1) 免密登录是否可用，
/// (2) 远端 sshd 是否开启 GatewayPorts（决定手机能否从公网连到反代端口）。
/// 不建立隧道，只探测，最长 ~10s。
pub(crate) fn tunnel_check(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let host = get_string(&object, "host");
    if host.trim().is_empty() {
        return Err("VPS host 不能为空".to_string());
    }
    let ssh_user = {
        let u = get_string(&object, "sshUser");
        if u.trim().is_empty() {
            "root".to_string()
        } else {
            u
        }
    };
    let ssh_port = object
        .get("sshPort")
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
        })
        .filter(|p| *p <= u16::MAX as u64)
        .map(|p| p as u16)
        .unwrap_or(22);
    let identity_file = get_string(&object, "identityFile");
    let target = format!("{ssh_user}@{host}");

    // 远端探测脚本：打印 EASSH_OK 证明登录成功；再尽力读出 GatewayPorts 配置
    let probe = "echo EASSH_OK; (sshd -T 2>/dev/null | grep -i gatewayports) \
         || (grep -Ehi '^[[:space:]]*gatewayports' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/* 2>/dev/null) \
         || echo GATEWAYPORTS_UNKNOWN";

    let mut command = Command::new("ssh");
    command
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=8")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-p")
        .arg(ssh_port.to_string());
    if !identity_file.trim().is_empty() {
        command.arg("-i").arg(identity_file.trim());
    }
    command.arg(&target).arg(probe);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = command
        .output()
        .map_err(|e| format!("无法执行 ssh（确认已安装 ssh 客户端）：{e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let ssh_ok = stdout.contains("EASSH_OK");
    let lower = stdout.to_lowercase();
    let gateway = if lower.contains("gatewayports yes") || lower.contains("gatewayports clientspecified")
    {
        "yes"
    } else if lower.contains("gatewayports no") {
        "no"
    } else {
        "unknown"
    };
    let hint = if !ssh_ok {
        "SSH 免密登录未通：先在电脑上 `ssh-copy-id` 到该 VPS，或填对私钥文件路径。".to_string()
    } else if gateway == "no" {
        "SSH 已通，但 VPS 未开 GatewayPorts。请在 /etc/ssh/sshd_config 加一行 `GatewayPorts yes`，再 `sudo systemctl restart sshd`，否则手机只能在 VPS 本机访问反代端口。".to_string()
    } else if gateway == "unknown" {
        "SSH 已通；无法确认 GatewayPorts（可能无权读取配置）。若建立隧道后手机连不上，请在 VPS 开启 `GatewayPorts yes`。".to_string()
    } else {
        "SSH 已通且 GatewayPorts 已开启，可直接建立隧道。".to_string()
    };
    Ok(json!({
        "sshOk": ssh_ok,
        "gatewayPorts": gateway,
        "hint": hint,
        "stderr": stderr.trim(),
    }))
}

// ─── HTTP 服务实现 ──────────────────────────────────────────────────────

fn serve(listener: TcpListener, token: String, stop: Arc<AtomicBool>) {
    listener
        .set_nonblocking(true)
        .unwrap_or_else(|_| ());
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        match listener.accept() {
            Ok((stream, addr)) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                let token = token.clone();
                let ip = addr.ip().to_string();
                thread::spawn(move || handle_connection(stream, token, ip));
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(120));
            }
            Err(_) => {
                thread::sleep(Duration::from_millis(200));
            }
        }
    }
}

struct HttpRequest {
    method: String,
    path: String,
    query: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|w| w == b"\r\n\r\n")
}

fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    stream
        .set_nonblocking(false)
        .map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| e.to_string())?;
    let mut buffer = Vec::new();
    let mut temp = [0_u8; 8192];
    let header_end = loop {
        let read = stream.read(&mut temp).map_err(|e| e.to_string())?;
        if read == 0 {
            return Err("connection closed".to_string());
        }
        buffer.extend_from_slice(&temp[..read]);
        if buffer.len() > MAX_HEADER_BYTES {
            return Err("headers too large".to_string());
        }
        if let Some(index) = find_header_end(&buffer) {
            break index + 4;
        }
    };
    let header_text = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut lines = header_text.split("\r\n").filter(|l| !l.is_empty());
    let request_line = lines.next().ok_or("missing request line")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target.clone(), String::new()),
    };

    let mut headers = Vec::new();
    let mut content_length = 0_usize;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim().to_string();
            let value = value.trim().to_string();
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.parse::<usize>().unwrap_or(0);
            }
            headers.push((name, value));
        }
    }
    if content_length > MAX_BODY_BYTES {
        return Err("body too large".to_string());
    }
    while buffer.len() < header_end + content_length {
        let read = stream.read(&mut temp).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&temp[..read]);
    }
    let end = (header_end + content_length).min(buffer.len());
    Ok(HttpRequest {
        method,
        path,
        query,
        headers,
        body: buffer[header_end..end].to_vec(),
    })
}

fn query_pairs(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|s| !s.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((k, v)) => (url_decode(k), url_decode(v)),
            None => (url_decode(pair), String::new()),
        })
        .collect()
}

fn url_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(hi), Some(lo)) = (hi, lo) {
                    out.push((hi * 16 + lo) as u8);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

fn header_value<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

fn write_response(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
    keep_alive: bool,
) {
    let conn = if keep_alive {
        "Connection: keep-alive\r\nKeep-Alive: timeout=15, max=200\r\n"
    } else {
        "Connection: close\r\n"
    };
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS, DELETE\r\nCache-Control: no-store\r\n{conn}\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn write_json(stream: &mut TcpStream, status: &str, value: &Value, keep_alive: bool) {
    write_response(
        stream,
        status,
        "application/json; charset=utf-8",
        value.to_string().as_bytes(),
        keep_alive,
    );
}

fn client_wants_close(headers: &[(String, String)]) -> bool {
    header_value(headers, "connection")
        .map(|v| v.to_ascii_lowercase().contains("close"))
        .unwrap_or(false)
}

/// 处理单个 HTTP 请求。返回 true 表示连接可继续复用；false / SSE 后关闭。
fn handle_one_request(
    stream: &mut TcpStream,
    request: &HttpRequest,
    token: &str,
    peer_ip: &str,
) -> bool {
    let keep_alive = !client_wants_close(&request.headers);

    if request.method.eq_ignore_ascii_case("OPTIONS") {
        write_response(stream, "204 No Content", "text/plain", b"", keep_alive);
        return keep_alive;
    }

    // 静态资源（无秘密）
    match request.path.as_str() {
        "/" | "/m" | "/index.html" => {
            write_response(
                stream,
                "200 OK",
                "text/html; charset=utf-8",
                MOBILE_HTML.as_bytes(),
                keep_alive,
            );
            return keep_alive;
        }
        "/vendor/xterm/xterm.mjs" => {
            write_response(
                stream,
                "200 OK",
                "text/javascript; charset=utf-8",
                XTERM_JS.as_bytes(),
                keep_alive,
            );
            return keep_alive;
        }
        "/vendor/xterm/addon-fit.mjs" => {
            write_response(
                stream,
                "200 OK",
                "text/javascript; charset=utf-8",
                XTERM_FIT.as_bytes(),
                keep_alive,
            );
            return keep_alive;
        }
        "/vendor/xterm/xterm.css" => {
            write_response(
                stream,
                "200 OK",
                "text/css; charset=utf-8",
                XTERM_CSS.as_bytes(),
                keep_alive,
            );
            return keep_alive;
        }
        "/favicon.ico" => {
            write_response(stream, "204 No Content", "image/x-icon", b"", keep_alive);
            return keep_alive;
        }
        _ => {}
    }

    if !request.path.starts_with("/api/") {
        write_json(
            stream,
            "404 Not Found",
            &json!({ "ok": false, "error": "not found" }),
            keep_alive,
        );
        return keep_alive;
    }

    // token 校验：header 或 query
    let pairs = query_pairs(&request.query);
    let query_token = pairs
        .iter()
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    let header_token = header_value(&request.headers, "x-remote-token").unwrap_or("");
    if header_token != token && query_token != token {
        write_json(
            stream,
            "401 Unauthorized",
            &json!({ "ok": false, "error": "invalid token" }),
            false,
        );
        return false;
    }

    // 鉴权通过 → 登记这台手机(用于桌面「已连接手机」列表)
    let ua = header_value(&request.headers, "user-agent")
        .unwrap_or("")
        .to_string();
    record_client(peer_ip, &ua, &request.path);

    // SSE 实时推流：独占连接，结束后关闭。
    if request.method.eq_ignore_ascii_case("GET") && request.path == "/api/terminal/stream" {
        handle_terminal_stream(stream, &request.query);
        return false;
    }
    if request.method.eq_ignore_ascii_case("GET") && request.path == "/api/codex/events" {
        crate::codex_app_server::handle_events_sse(stream, &request.query);
        return false;
    }
    if request.method.eq_ignore_ascii_case("GET") && request.path == "/api/claude/events" {
        crate::claude_print_bridge::handle_events_sse(stream, &request.query);
        return false;
    }

    // 白名单
    let allowed = REMOTE_API_ALLOW
        .iter()
        .any(|prefix| request.path.starts_with(prefix));
    if !allowed {
        write_json(
            stream,
            "403 Forbidden",
            &json!({ "ok": false, "error": "该接口不允许远程调用" }),
            keep_alive,
        );
        return keep_alive;
    }

    // 组装 query / body 传给现有 dispatch
    let mut query_map = serde_json::Map::new();
    for (k, v) in pairs {
        if k == "token" {
            continue;
        }
        query_map.insert(k, Value::String(v));
    }
    let query_value = Value::Object(query_map);
    let mut body_value: Value = if request.body.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&request.body).unwrap_or_else(|_| json!({}))
    };

    // 标记来源 + 「手机在看」：终端相关请求都记一笔远程活跃。
    if request.path.starts_with("/api/terminal/") {
        // 新建会话注入 origin=phone，让桌面/列表能标出「手机开的」
        if request.path == "/api/terminal/create" {
            if let Some(obj) = body_value.as_object_mut() {
                obj.insert("origin".to_string(), json!("phone"));
            }
        }
        // 从 query 或 body 里取 sessionId，标记该会话被手机访问过
        let sid = query_value
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .or_else(|| {
                body_value
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string())
            });
        if let Some(sid) = sid {
            crate::terminal::mark_remote_activity(&sid);
        }
    }
    // app-server / print-bridge：手机新建也标 origin=phone
    if request.path == "/api/codex/thread/start"
        || request.path == "/api/codex/thread/resume"
        || request.path == "/api/claude/thread/start"
        || request.path == "/api/claude/thread/resume"
    {
        if let Some(obj) = body_value.as_object_mut() {
            obj.insert("origin".to_string(), json!("phone"));
        }
    }

    let Some(app) = APP_HANDLE.get().cloned() else {
        write_json(
            stream,
            "503 Service Unavailable",
            &json!({ "ok": false, "error": "app not ready" }),
            keep_alive,
        );
        return keep_alive;
    };

    let path = request.path.clone();
    let method = request.method.clone();
    let result = tauri::async_runtime::block_on(async move {
        dispatch(app, &path, &method, &query_value, &body_value).await
    });
    match result {
        Ok(data) => write_json(
            stream,
            "200 OK",
            &json!({ "ok": true, "data": data }),
            keep_alive,
        ),
        Err(error) => write_json(
            stream,
            "200 OK",
            &json!({ "ok": false, "error": error }),
            keep_alive,
        ),
    }
    keep_alive
}

fn handle_connection(mut stream: TcpStream, token: String, peer_ip: String) {
    // keep-alive：同一 TCP 连接复用多次 HTTP，砍掉手机端每次握手的延迟。
    let _ = stream.set_read_timeout(Some(Duration::from_secs(20)));
    let mut served = 0_u32;
    loop {
        if served >= 200 {
            break;
        }
        let request = match read_request(&mut stream) {
            Ok(req) => req,
            Err(_) => break,
        };
        served += 1;
        if !handle_one_request(&mut stream, &request, &token, &peer_ip) {
            break;
        }
    }
}

// ─── SSE 终端实时推流 ───────────────────────────────────────────────────
// GET /api/terminal/stream?sessionId=<id>&cursor=<n>&token=<t>
// 直接把 PTY output 增量按 text/event-stream 持续推给手机，取代 800ms 轮询。
// 与工具无关：codex / claudecode / shell 都只是 PTY，读的是同一份 output 缓冲。
// 每连接独占一个线程，这里阻塞轮询即可（serve() 为每个连接 spawn 线程）。

/// 写一帧 `data: {json}\n\n`。JSON 序列化天然转义换行/控制字符，SSE 单行不被截断。
fn write_sse_data(stream: &mut TcpStream, payload: &Value) -> std::io::Result<()> {
    stream.write_all(format!("data: {}\n\n", payload).as_bytes())?;
    stream.flush()
}

fn handle_terminal_stream(stream: &mut TcpStream, query: &str) {
    let pairs = query_pairs(query);
    let session_id = pairs
        .iter()
        .find(|(k, _)| k == "sessionId")
        .map(|(_, v)| v.clone())
        .unwrap_or_default();
    if session_id.trim().is_empty() {
        write_json(
            stream,
            "400 Bad Request",
            &json!({ "ok": false, "error": "sessionId 不能为空" }),
            false,
        );
        return;
    }
    // 起始 cursor：客户端先 read 一次拿到历史与游标，再从该游标处开流，避免重复/漏字。
    let mut cursor = pairs
        .iter()
        .find(|(k, _)| k == "cursor")
        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        .unwrap_or(0);

    // SSE 响应头，直接写进 TcpStream（不走通用响应器，因为要长连接持续写）。
    let head = "HTTP/1.1 200 OK\r\n\
Content-Type: text/event-stream; charset=utf-8\r\n\
Cache-Control: no-store\r\n\
Connection: keep-alive\r\n\
Access-Control-Allow-Origin: *\r\n\
X-Accel-Buffering: no\r\n\r\n";
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }
    // retry：EventSource 断线后 3s 自动重连（Flutter 端自行控制重连）。
    if stream.write_all(b"retry: 3000\n\n").is_err() {
        return;
    }
    if stream.flush().is_err() {
        return;
    }
    // 只写不读；设个写超时，防止对端半死时线程永久阻塞。
    let _ = stream.set_write_timeout(Some(Duration::from_secs(20)));

    // 跨轮次缓存不完整的多字节尾字节，凑齐再吐（同 terminal.rs 读线程的做法）。
    let mut pending: Vec<u8> = Vec::new();
    let mut last_activity = Instant::now();

    loop {
        let Some((bytes, new_len, running, exit_code)) =
            crate::terminal::read_output_from(&session_id, cursor)
        else {
            // 会话已被移除，结束推流。
            break;
        };
        cursor = new_len;
        if !bytes.is_empty() {
            pending.extend_from_slice(&bytes);
        }

        // 只吐合法 UTF-8 前缀；残留 > 3 字节必非「半个字符」（UTF-8 单字符最多 4 字节），
        // 视为非法字节 lossy 冲掉，防止 pending 无限增长卡住后续输出。
        let valid = crate::terminal::utf8_valid_prefix_len(&pending);
        let emit = if valid > 0 {
            let text = String::from_utf8_lossy(&pending[..valid]).to_string();
            pending.drain(..valid);
            Some(text)
        } else if pending.len() > 3 {
            let text = String::from_utf8_lossy(&pending).to_string();
            pending.clear();
            Some(text)
        } else {
            None
        };

        let mut wrote = false;
        if let Some(text) = emit {
            // 上报的 cursor 减去尚未吐出的尾字节，保证客户端据此回退轮询不漏字。
            let emitted_cursor = cursor.saturating_sub(pending.len());
            let payload = json!({ "data": text, "cursor": emitted_cursor });
            if write_sse_data(stream, &payload).is_err() {
                break;
            }
            last_activity = Instant::now();
            wrote = true;
        }

        if !running {
            // 会话已退出：child.try_wait() 可能比 PTY 读线程落盘最后一段 output 更早，
            // 宽限几轮把尾巴读干净，再吐残留字节 + 发 exit 事件收尾，尽量不漏内容。
            for _ in 0..3 {
                thread::sleep(Duration::from_millis(40));
                if let Some((tail, tail_len, _, _)) =
                    crate::terminal::read_output_from(&session_id, cursor)
                {
                    cursor = tail_len;
                    if !tail.is_empty() {
                        pending.extend_from_slice(&tail);
                    }
                }
            }
            if !pending.is_empty() {
                let text = String::from_utf8_lossy(&pending).to_string();
                pending.clear();
                let payload = json!({ "data": text, "cursor": cursor });
                let _ = write_sse_data(stream, &payload);
            }
            let _ = stream.write_all(
                format!("event: exit\ndata: {}\n\n", json!({ "exitCode": exit_code })).as_bytes(),
            );
            let _ = stream.flush();
            break;
        }

        if !wrote {
            // 空闲时每 ~15s 发心跳注释行，保活穿透代理；顺带借写失败探测断连。
            if last_activity.elapsed() >= Duration::from_secs(15) {
                if stream.write_all(b": ping\n\n").is_err() || stream.flush().is_err() {
                    break;
                }
                last_activity = Instant::now();
            }
            thread::sleep(Duration::from_millis(60));
        }
    }
}
