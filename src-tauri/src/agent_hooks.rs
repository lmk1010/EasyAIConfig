//! Managed agent status hooks（学 Orca）：本机 loopback 接收 Claude/Codex 官方 hook，
//! 归一为 working / waiting / done，供手机列表「等你」雷达。
//! 可开关；卸载时移除托管条目。

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use crate::provider::get_string;
use crate::{app_home, ensure_dir, parse_json_object};

const MANAGED_MARKER: &str = "easy-ai-config-agent-hook";

struct HookStatus {
    agent: String,
    status: String,
    summary: String,
    cwd: String,
    updated_at: Instant,
}

struct HookState {
    enabled: bool,
    token: String,
    port: u16,
    stop: Arc<AtomicBool>,
    statuses: HashMap<String, HookStatus>,
}

static STATE: OnceLock<Mutex<HookState>> = OnceLock::new();
static BOUND_PORT: AtomicU16 = AtomicU16::new(0);

fn state() -> &'static Mutex<HookState> {
    STATE.get_or_init(|| {
        Mutex::new(HookState {
            enabled: false,
            token: uuid::Uuid::new_v4().to_string().replace('-', ""),
            port: 0,
            stop: Arc::new(AtomicBool::new(true)),
            statuses: HashMap::new(),
        })
    })
}

fn hooks_dir() -> PathBuf {
    let dir = app_home()
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("/tmp"))
                .join(".codex-config-ui")
        })
        .join("agent-hooks");
    let _ = ensure_dir(&dir);
    dir
}

fn script_path() -> PathBuf {
    hooks_dir().join("easyai-hook.sh")
}

fn env_path() -> PathBuf {
    hooks_dir().join("env")
}

fn state_path() -> PathBuf {
    hooks_dir().join("state.json")
}

fn write_hook_env(port: u16, token: &str) -> Result<(), String> {
    let body = format!(
        "# easy-ai-config managed — rewritten on start; keep hooks.json command stable\nEASYAI_HOOK_PORT={port}\nEASYAI_HOOK_TOKEN={token}\n"
    );
    std::fs::write(env_path(), body).map_err(|e| e.to_string())
}

fn persist_state(enabled: bool, port: u16, token: &str) {
    let v = json!({
        "enabled": enabled,
        "port": port,
        "token": token,
    });
    let _ = std::fs::write(
        state_path(),
        serde_json::to_string_pretty(&v).unwrap_or_default(),
    );
}

fn load_persisted() -> Option<(bool, u16, String)> {
    let text = std::fs::read_to_string(state_path()).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let enabled = v.get("enabled").and_then(Value::as_bool)?;
    let port = v.get("port").and_then(Value::as_u64)? as u16;
    let token = v
        .get("token")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if token.is_empty() {
        return None;
    }
    Some((enabled, port, token))
}

fn write_hook_script() -> Result<PathBuf, String> {
    let path = script_path();
    let env = env_path();
    let env_s = env.to_string_lossy();
    let body = format!(
        r#"#!/bin/bash
# easy-ai-config managed agent status hook
ENV_FILE="${{EASYAI_HOOK_ENV:-{env_s}}}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
PORT="${{EASYAI_HOOK_PORT:-}}"
TOKEN="${{EASYAI_HOOK_TOKEN:-}}"
if [ -z "$PORT" ] || [ -z "$TOKEN" ]; then
  exit 0
fi
PAYLOAD=$(cat)
AGENT="${{EASYAI_HOOK_AGENT:-unknown}}"
CWD="${{PWD:-}}"
curl -sS -m 2 \
  -H "Content-Type: application/json" \
  -H "X-EasyAI-Hook-Token: ${{TOKEN}}" \
  -H "X-EasyAI-Hook-Agent: ${{AGENT}}" \
  -H "X-EasyAI-Hook-Cwd: ${{CWD}}" \
  --data-binary "$PAYLOAD" \
  "http://127.0.0.1:${{PORT}}/hook" >/dev/null 2>&1 || true
exit 0
"#
    );
    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
    }
    Ok(path)
}

fn normalize_cwd(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    if s.is_empty() {
        return s;
    }
    if s.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            s = home.join(&s[2..]).to_string_lossy().to_string();
        }
    } else if s == "~" {
        if let Some(home) = dirs::home_dir() {
            s = home.to_string_lossy().to_string();
        }
    }
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    if let Ok(canon) = std::fs::canonicalize(&s) {
        return canon.to_string_lossy().to_string();
    }
    s
}

fn paths_match(a: &str, b: &str) -> bool {
    let a = normalize_cwd(a);
    let b = normalize_cwd(b);
    if a.is_empty() || b.is_empty() {
        return false;
    }
    a == b || a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/"))
}

fn bridge_covers_cwd(cwd: &str) -> bool {
    if cwd.trim().is_empty() {
        return false;
    }
    let mut sessions = Vec::new();
    if let Ok(v) = crate::codex_app_server::api_list(&json!({})) {
        if let Some(arr) = v.get("sessions").and_then(Value::as_array) {
            sessions.extend(arr.iter().cloned());
        }
    }
    if let Ok(v) = crate::claude_print_bridge::api_list(&json!({})) {
        if let Some(arr) = v.get("sessions").and_then(Value::as_array) {
            sessions.extend(arr.iter().cloned());
        }
    }
    for s in sessions {
        let scwd = s.get("cwd").and_then(Value::as_str).unwrap_or("");
        if paths_match(scwd, cwd) {
            return true;
        }
    }
    false
}

fn extract_event_name(payload: &Value) -> String {
    payload
        .get("hook_event_name")
        .or_else(|| payload.get("event"))
        .or_else(|| payload.get("type"))
        .or_else(|| payload.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn extract_tool_name(payload: &Value) -> String {
    payload
        .get("tool_name")
        .or_else(|| payload.get("toolName"))
        .or_else(|| payload.pointer("/tool_input/name"))
        .or_else(|| payload.pointer("/tool/name"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn summarize_waiting(payload: &Value, event: &str, tool: &str) -> String {
    payload
        .get("message")
        .or_else(|| payload.get("prompt"))
        .or_else(|| payload.get("reason"))
        .or_else(|| payload.get("tool_input"))
        .map(|v| {
            if let Some(s) = v.as_str() {
                s.to_string()
            } else {
                v.to_string()
            }
        })
        .unwrap_or_else(|| {
            if !tool.is_empty() {
                tool.to_string()
            } else {
                event.to_string()
            }
        })
        .chars()
        .take(160)
        .collect()
}

fn normalize_payload(agent: &str, payload: &Value) -> (String, String) {
    // returns (status, summary) — exact event names first, then fuzzy
    let event = extract_event_name(payload);
    let tool = extract_tool_name(payload);
    let lower_event = event.to_ascii_lowercase();
    let lower_tool = tool.to_ascii_lowercase();

    // Exact / known waiting
    if matches!(
        event.as_str(),
        "PermissionRequest" | "permission_request" | "RequestPermission"
    ) || lower_tool.contains("askuser")
        || lower_tool == "ask_user_question"
        || lower_tool == "askuserquestion"
    {
        return (
            "waiting".into(),
            summarize_waiting(payload, &event, &tool),
        );
    }

    if lower_event == "notification" {
        let msg = payload
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        if msg.contains("waiting")
            || msg.contains("permission")
            || msg.contains("approval")
            || msg.contains("confirm")
        {
            return (
                "waiting".into(),
                summarize_waiting(payload, &event, &tool),
            );
        }
    }

    if lower_event.contains("permission")
        || (lower_event.contains("notification")
            && payload
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase()
                .contains("waiting"))
    {
        return (
            "waiting".into(),
            summarize_waiting(payload, &event, &tool),
        );
    }

    if matches!(
        event.as_str(),
        "Stop" | "SessionEnd" | "AgentEnd" | "stop" | "session_end"
    ) || lower_event == "done"
        || lower_event.contains("sessionend")
        || lower_event.contains("agent_end")
    {
        return ("done".into(), format!("{agent} idle"));
    }

    if matches!(event.as_str(), "SessionStart" | "session_start")
        || lower_event.contains("sessionstart")
    {
        return ("done".into(), format!("{agent} ready"));
    }

    if matches!(
        event.as_str(),
        "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "user_prompt_submit"
    ) || !event.is_empty()
        || !tool.is_empty()
    {
        let summary = if tool.is_empty() {
            event.clone()
        } else {
            tool.clone()
        };
        return ("working".into(), summary.chars().take(160).collect());
    }
    ("working".into(), agent.to_string())
}

fn handle_hook_http(mut stream: TcpStream, expect_token: &str) {
    let mut buf = [0u8; 65536];
    let n = match stream.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return,
    };
    let req = String::from_utf8_lossy(&buf[..n]);
    let mut headers = Map::new();
    let mut body = String::new();
    if let Some(idx) = req.find("\r\n\r\n") {
        for line in req[..idx].lines().skip(1) {
            if let Some((k, v)) = line.split_once(':') {
                headers.insert(k.trim().to_ascii_lowercase(), json!(v.trim()));
            }
        }
        body = req[idx + 4..].to_string();
    }
    let token = headers
        .get("x-easyai-hook-token")
        .and_then(Value::as_str)
        .unwrap_or("");
    if token != expect_token {
        let _ = stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
        return;
    }
    let agent = headers
        .get("x-easyai-hook-agent")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let cwd_raw = headers
        .get("x-easyai-hook-cwd")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let payload: Value = serde_json::from_str(body.trim()).unwrap_or(json!({}));
    let cwd_from_payload = payload
        .get("cwd")
        .or_else(|| payload.get("cwd_path"))
        .or_else(|| payload.pointer("/session/cwd"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let cwd = normalize_cwd(if cwd_raw.is_empty() {
        cwd_from_payload
    } else {
        &cwd_raw
    });
    let (status, summary) = normalize_payload(&agent, &payload);
    let key = if cwd.is_empty() {
        format!("{agent}:default")
    } else {
        format!("{agent}:{cwd}")
    };
    let mut changed = true;
    if let Ok(mut st) = state().lock() {
        if let Some(prev) = st.statuses.get(&key) {
            changed = prev.status != status;
        }
        st.statuses.insert(
            key.clone(),
            HookStatus {
                agent: agent.clone(),
                status: status.clone(),
                summary: summary.clone(),
                cwd: cwd.clone(),
                updated_at: Instant::now(),
            },
        );
    }
    // bridge 会话已覆盖同一 cwd 时，桌面通知以 bridge 为准，避免双弹
    if changed
        && (status == "waiting" || status == "done")
        && !bridge_covers_cwd(&cwd)
    {
        crate::desktop_notify::agent_status_changed(
            &format!("{agent} · hook"),
            &status,
            &summary,
        );
    }
    crate::session_bus::publish_hook_status(&agent, &cwd, &status, &summary);
    let resp = json!({ "ok": true, "status": status });
    let body = resp.to_string();
    let _ = write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
}

/// OSC 终端标题兜底：hook 未打到时，从 PTY 标题推断 working / waiting / done。
pub(crate) fn note_osc_title(cwd: &str, title: &str) {
    let cwd = normalize_cwd(cwd);
    if cwd.is_empty() || title.trim().is_empty() {
        return;
    }
    let lower = title.to_ascii_lowercase();
    let status = if lower.contains("waiting")
        || lower.contains("permission")
        || lower.contains("approval")
        || lower.contains("confirm")
        || lower.contains("ask ")
    {
        "waiting"
    } else if lower.contains("idle")
        || lower.contains("ready")
        || lower.ends_with(" —")
        || lower == "codex"
        || lower == "claude"
    {
        "done"
    } else if lower.contains("working")
        || lower.contains("running")
        || lower.contains("thinking")
        || lower.contains("codex")
        || lower.contains("claude")
    {
        "working"
    } else {
        return;
    };
    let summary: String = title.chars().take(160).collect();
    let agent = if lower.contains("claude") {
        "claude"
    } else {
        "codex"
    };
    let key = format!("{agent}:{cwd}");
    let mut changed = true;
    if let Ok(mut st) = state().lock() {
        if !st.enabled {
            return;
        }
        if let Some(prev) = st.statuses.get(&key) {
            // hook 刚更新过（3s 内）则以 hook 为准，不让 OSC 覆盖
            if prev.updated_at.elapsed() < Duration::from_secs(3) && prev.status != status {
                // 仅当 hook 是 working、OSC 报 waiting 时允许升级
                if !(prev.status == "working" && status == "waiting") {
                    return;
                }
            }
            changed = prev.status != status;
        }
        st.statuses.insert(
            key,
            HookStatus {
                agent: agent.to_string(),
                status: status.to_string(),
                summary: summary.clone(),
                cwd: cwd.clone(),
                updated_at: Instant::now(),
            },
        );
    } else {
        return;
    }
    if changed && (status == "waiting" || status == "done") && !bridge_covers_cwd(&cwd) {
        crate::desktop_notify::agent_status_changed(
            &format!("{agent} · osc"),
            status,
            &summary,
        );
    }
    crate::session_bus::publish_hook_status(agent, &cwd, status, &summary);
}

fn start_listener(port: u16, token: String, stop: Arc<AtomicBool>) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|e| e.to_string())?;
    BOUND_PORT.store(port, Ordering::SeqCst);
    thread::spawn(move || {
        while !stop.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let token = token.clone();
                    thread::spawn(move || handle_hook_http(stream, &token));
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(40));
                }
                Err(_) => thread::sleep(Duration::from_millis(100)),
            }
        }
        BOUND_PORT.store(0, Ordering::SeqCst);
    });
    Ok(())
}

fn install_claude(script: &str, _port: u16, _token: &str) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "无 HOME".to_string())?;
    let settings = home.join(".claude/settings.json");
    let mut root: Value = std::fs::read_to_string(&settings)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}));
    if !root.is_object() {
        root = json!({});
    }
    let hooks = root
        .as_object_mut()
        .unwrap()
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "settings.hooks 非法".to_string())?;

    // 命令不含 port/token → hooks.json 哈希稳定，减少 Codex/Claude 反复「需要信任」
    let cmd = format!("EASYAI_HOOK_AGENT=claude {script}");
    let entry = json!({
        "matcher": "*",
        "hooks": [{
            "type": "command",
            "command": cmd,
            "timeout": 5,
            "statusMessage": MANAGED_MARKER
        }]
    });
    for event in [
        "PreToolUse",
        "PermissionRequest",
        "Notification",
        "Stop",
        "SessionStart",
    ] {
        let arr = hooks
            .entry(event.to_string())
            .or_insert_with(|| json!([]));
        let list = arr.as_array_mut().ok_or_else(|| "hooks array 非法".to_string())?;
        list.retain(|item| {
            !serde_json::to_string(item)
                .unwrap_or_default()
                .contains(MANAGED_MARKER)
        });
        list.insert(0, entry.clone());
    }
    if let Some(parent) = settings.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(
        &settings,
        serde_json::to_string_pretty(&root).unwrap_or_default(),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn uninstall_claude() -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "无 HOME".to_string())?;
    let settings = home.join(".claude/settings.json");
    let Ok(text) = std::fs::read_to_string(&settings) else {
        return Ok(());
    };
    let Ok(mut root) = serde_json::from_str::<Value>(&text) else {
        return Ok(());
    };
    if let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) {
        for (_k, v) in hooks.iter_mut() {
            if let Some(arr) = v.as_array_mut() {
                arr.retain(|item| {
                    !serde_json::to_string(item)
                        .unwrap_or_default()
                        .contains(MANAGED_MARKER)
                });
            }
        }
    }
    let _ = std::fs::write(
        &settings,
        serde_json::to_string_pretty(&root).unwrap_or_default(),
    );
    Ok(())
}

fn install_codex(script: &str, _port: u16, _token: &str) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "无 HOME".to_string())?;
    let codex = home.join(".codex");
    let _ = std::fs::create_dir_all(&codex);
    let hooks_json = codex.join("hooks.json");
    let mut root: Value = std::fs::read_to_string(&hooks_json)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({ "hooks": {} }));
    let hooks = root
        .as_object_mut()
        .unwrap()
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "hooks.json 非法".to_string())?;
    let cmd = format!("EASYAI_HOOK_AGENT=codex {script}");
    let entry = json!({
        "hooks": [{
            "type": "command",
            "command": cmd,
            "timeout": 5,
            "statusMessage": MANAGED_MARKER
        }]
    });
    for event in [
        "SessionStart",
        "Stop",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "PermissionRequest",
    ] {
        let arr = hooks
            .entry(event.to_string())
            .or_insert_with(|| json!([]));
        let list = arr.as_array_mut().ok_or_else(|| "hooks array 非法".to_string())?;
        list.retain(|item| {
            !serde_json::to_string(item)
                .unwrap_or_default()
                .contains(MANAGED_MARKER)
        });
        list.insert(0, entry.clone());
    }
    std::fs::write(
        &hooks_json,
        serde_json::to_string_pretty(&root).unwrap_or_default(),
    )
    .map_err(|e| e.to_string())?;

    // 打开 features.hooks（旧名 features.codex_hooks 已废弃）
    let config_toml = codex.join("config.toml");
    let text = std::fs::read_to_string(&config_toml).unwrap_or_default();
    let fixed = ensure_features_hooks(&text);
    if fixed != text {
        let _ = std::fs::write(&config_toml, fixed);
    }
    Ok(())
}

/// 把 `hooks = true` 写进 `[features]`；顺带把废弃的 `codex_hooks` 迁过去。
/// 清掉误写入其它 section 的布尔项（`[shell_environment_policy.set]` 值必须是 string）。
fn ensure_features_hooks(text: &str) -> String {
    let mut section = String::new();
    let mut cleaned: Vec<String> = Vec::new();
    let mut features_has_hooks = false;
    for line in text.lines() {
        let raw = line.trim();
        if raw.starts_with('[') && raw.ends_with(']') {
            section = raw.to_string();
        }
        // 废弃名：从 [features] 迁走；其它段直接丢弃
        if raw.starts_with("codex_hooks") {
            continue;
        }
        if raw.starts_with("hooks")
            && (raw.contains('=') || raw == "hooks")
            && section == "[features]"
        {
            // 避免 hooks 表/子表误伤：只匹配 `hooks = ...` 单行布尔
            if raw.starts_with("hooks =") || raw.starts_with("hooks=") {
                features_has_hooks = true;
                cleaned.push("hooks = true".to_string());
                continue;
            }
        }
        cleaned.push(line.to_string());
    }
    let mut out = cleaned.join("\n");
    if !out.ends_with('\n') && !out.is_empty() {
        out.push('\n');
    }
    if features_has_hooks {
        return out;
    }
    if let Some(idx) = out.find("[features]") {
        let insert_at = idx + "[features]".len();
        out.insert_str(insert_at, "\nhooks = true");
    } else {
        out.push_str("\n[features]\nhooks = true\n");
    }
    out
}

fn uninstall_codex() -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "无 HOME".to_string())?;
    let hooks_json = home.join(".codex/hooks.json");
    let Ok(text) = std::fs::read_to_string(&hooks_json) else {
        return Ok(());
    };
    let Ok(mut root) = serde_json::from_str::<Value>(&text) else {
        return Ok(());
    };
    if let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) {
        for (_k, v) in hooks.iter_mut() {
            if let Some(arr) = v.as_array_mut() {
                arr.retain(|item| {
                    !serde_json::to_string(item)
                        .unwrap_or_default()
                        .contains(MANAGED_MARKER)
                });
            }
        }
    }
    let _ = std::fs::write(
        &hooks_json,
        serde_json::to_string_pretty(&root).unwrap_or_default(),
    );
    Ok(())
}

/// GET /api/agent-hooks/status
pub(crate) fn api_status(_query: &Value) -> Result<Value, String> {
    let st = state().lock().map_err(|e| e.to_string())?;
    Ok(json!({
        "enabled": st.enabled,
        "port": st.port,
        "boundPort": BOUND_PORT.load(Ordering::SeqCst),
        "statusCount": st.statuses.len(),
        "needsTrust": st.enabled,
        "trustHint": if st.enabled {
            "若 Codex/Claude 提示 Hooks need review，请在本机 CLI 信任一次 easy-ai-config 托管 hook（命令不含 token，重启一般无需再信）"
        } else {
            ""
        },
    }))
}

/// POST /api/agent-hooks/on
pub(crate) fn api_on(_body: &Value) -> Result<Value, String> {
    let script = write_hook_script()?;
    let script_s = script.to_string_lossy().to_string();
    let (token, port, already) = {
        let mut st = state().lock().map_err(|e| e.to_string())?;
        if st.enabled && st.port > 0 && BOUND_PORT.load(Ordering::SeqCst) == st.port {
            let token = st.token.clone();
            let port = st.port;
            drop(st);
            write_hook_env(port, &token)?;
            (token, port, true)
        } else {
            st.stop.store(true, Ordering::SeqCst);
            st.stop = Arc::new(AtomicBool::new(false));
            let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            drop(listener);
            // 优先复用持久化 token，避免手机侧无关；hook env 会重写
            if let Some((_, _, saved_token)) = load_persisted() {
                if !saved_token.is_empty() {
                    st.token = saved_token;
                }
            }
            st.port = port;
            st.enabled = true;
            let token = st.token.clone();
            let stop = st.stop.clone();
            start_listener(port, token.clone(), stop)?;
            drop(st);
            write_hook_env(port, &token)?;
            (token, port, false)
        }
    };
    install_claude(&script_s, port, &token)?;
    install_codex(&script_s, port, &token)?;
    persist_state(true, port, &token);
    Ok(json!({
        "ok": true,
        "enabled": true,
        "port": port,
        "script": script_s,
        "already": already,
        "installed": ["claude", "codex"],
        "needsTrust": true,
        "trustHint": "首次启用后若 CLI 提示 Hooks need review，请信任 easy-ai-config 托管 hook；之后重启桌面不会因 port/token 变化而反复弹窗",
    }))
}

/// POST /api/agent-hooks/off
pub(crate) fn api_off(_body: &Value) -> Result<Value, String> {
    let token = {
        let mut st = state().lock().map_err(|e| e.to_string())?;
        st.enabled = false;
        st.stop.store(true, Ordering::SeqCst);
        st.port = 0;
        st.statuses.clear();
        st.token.clone()
    };
    persist_state(false, 0, &token);
    let _ = uninstall_claude();
    let _ = uninstall_codex();
    Ok(json!({ "ok": true, "enabled": false }))
}

/// 桌面启动时：若上次开启过 Hook 雷达，自动监听并重写 env（hooks 命令不变）。
pub(crate) fn restore_on_launch() {
    let Some((enabled, _old_port, token)) = load_persisted() else {
        return;
    };
    if !enabled {
        return;
    }
    let script = match write_hook_script() {
        Ok(p) => p,
        Err(_) => return,
    };
    let script_s = script.to_string_lossy().to_string();
    let port = {
        let mut st = match state().lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        if st.enabled && st.port > 0 {
            return;
        }
        st.stop.store(true, Ordering::SeqCst);
        st.stop = Arc::new(AtomicBool::new(false));
        st.token = token.clone();
        let listener = match TcpListener::bind("127.0.0.1:0") {
            Ok(l) => l,
            Err(_) => return,
        };
        let port = match listener.local_addr() {
            Ok(a) => a.port(),
            Err(_) => return,
        };
        drop(listener);
        st.port = port;
        st.enabled = true;
        let stop = st.stop.clone();
        if start_listener(port, token.clone(), stop).is_err() {
            st.enabled = false;
            st.port = 0;
            return;
        }
        port
    };
    let _ = write_hook_env(port, &token);
    let _ = install_claude(&script_s, port, &token);
    let _ = install_codex(&script_s, port, &token);
    persist_state(true, port, &token);
}

/// GET /api/agent-hooks/sessions — 雷达状态列表（供手机合并）
pub(crate) fn api_sessions(_query: &Value) -> Result<Value, String> {
    let st = state().lock().map_err(|e| e.to_string())?;
    let mut list = Vec::new();
    for (key, s) in &st.statuses {
        // 丢弃 30 分钟无更新
        if s.updated_at.elapsed() > Duration::from_secs(30 * 60) {
            continue;
        }
        list.push(json!({
            "id": key,
            "tool": s.agent,
            "agentStatus": s.status,
            "pendingSummary": if s.status == "waiting" { s.summary.clone() } else { String::new() },
            "cwd": s.cwd,
            "bridge": false,
            "viewMode": "terminal",
            "running": s.status != "done",
            "title": format!("{} · hook", s.agent),
            "commandPreview": "agent-hook",
            "origin": "hook",
            "radar": true,
        }));
    }
    Ok(json!({ "sessions": list, "enabled": st.enabled }))
}

/// 兼容空 body
pub(crate) fn api_toggle(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let enabled = object
        .get("enabled")
        .and_then(Value::as_bool)
        .or_else(|| {
            let s = get_string(&object, "enabled");
            if s == "true" {
                Some(true)
            } else if s == "false" {
                Some(false)
            } else {
                None
            }
        });
    match enabled {
        Some(true) => api_on(body),
        Some(false) => api_off(body),
        None => api_status(body),
    }
}
