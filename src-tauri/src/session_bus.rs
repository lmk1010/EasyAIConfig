//! 统一会话状态总线：Codex（及后续 Claude/hook）状态变化 → SSE + 桌面 Tauri 推送。
//! 手机 / 桌面不再靠 3–4s 轮询猜「等你」。

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::Write;
use std::net::TcpStream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const RING: usize = 256;

struct Bus {
    events: Mutex<VecDeque<(u64, Value)>>,
    seq: AtomicU64,
    cv: Condvar,
}

fn bus() -> &'static Bus {
    static B: OnceLock<Bus> = OnceLock::new();
    B.get_or_init(|| Bus {
        events: Mutex::new(VecDeque::new()),
        seq: AtomicU64::new(0),
        cv: Condvar::new(),
    })
}

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

pub(crate) fn install(handle: &AppHandle) {
    let _ = APP_HANDLE.set(handle.clone());
}

/// 发布一条总线事件（带递增 seq），并推给桌面 UI。
pub(crate) fn publish(mut payload: Value) {
    let seq = bus().seq.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("seq".to_string(), json!(seq));
        obj.entry("ts".to_string())
            .or_insert_with(|| json!(chrono::Utc::now().to_rfc3339()));
    }
    {
        let mut q = bus().events.lock().unwrap_or_else(|e| e.into_inner());
        q.push_back((seq, payload.clone()));
        while q.len() > RING {
            q.pop_front();
        }
        bus().cv.notify_all();
    }
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit("sessions-delta", payload);
    }
}

pub(crate) fn publish_agent_status(
    session_id: &str,
    tool: &str,
    agent_status: &str,
    pending_approval: &Value,
    session: Option<Value>,
) {
    let mut payload = json!({
        "type": "agent/status",
        "sessionId": session_id,
        "tool": tool,
        "agentStatus": agent_status,
        "pendingApproval": pending_approval,
        "bridge": true,
        "viewMode": "bridge",
    });
    if let Some(s) = session {
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("session".to_string(), s);
        }
    }
    publish(payload);
}

pub(crate) fn publish_upsert(session: Value) {
    let session_id = session
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    publish(json!({
        "type": "session/upsert",
        "sessionId": session_id,
        "session": session,
    }));
}

pub(crate) fn publish_remove(session_id: &str, tool: &str) {
    publish(json!({
        "type": "session/remove",
        "sessionId": session_id,
        "tool": tool,
    }));
}

/// Hook 雷达状态（无完整 session 时）
pub(crate) fn publish_hook_status(
    agent: &str,
    cwd: &str,
    agent_status: &str,
    summary: &str,
) {
    publish(json!({
        "type": "hook/status",
        "tool": agent,
        "cwd": cwd,
        "agentStatus": agent_status,
        "pendingApproval": if summary.is_empty() {
            Value::Null
        } else {
            json!({ "summary": summary })
        },
    }));
}

fn bridge_snapshot_sessions() -> Vec<Value> {
    let mut out = Vec::new();
    if let Ok(v) = crate::codex_app_server::api_list(&json!({})) {
        if let Some(arr) = v.get("sessions").and_then(Value::as_array) {
            for s in arr {
                let mut m = s.clone();
                if let Some(obj) = m.as_object_mut() {
                    obj.insert("bridge".to_string(), json!(true));
                    obj
                        .entry("viewMode".to_string())
                        .or_insert_with(|| json!("bridge"));
                }
                out.push(m);
            }
        }
    }
    if let Ok(v) = crate::claude_print_bridge::api_list(&json!({})) {
        if let Some(arr) = v.get("sessions").and_then(Value::as_array) {
            for s in arr {
                let mut m = s.clone();
                if let Some(obj) = m.as_object_mut() {
                    obj.insert("bridge".to_string(), json!(true));
                    obj
                        .entry("viewMode".to_string())
                        .or_insert_with(|| json!("bridge"));
                }
                out.push(m);
            }
        }
    }
    // PTY / tmux：一并进快照，手机不用再 REST 猜桌面新建
    if let Ok(v) = crate::terminal::terminal_list(&json!({})) {
        if let Some(arr) = v.get("rows").and_then(Value::as_array) {
            for s in arr {
                let mut m = s.clone();
                if let Some(obj) = m.as_object_mut() {
                    obj.insert("bridge".to_string(), json!(false));
                    if !obj.contains_key("viewMode") {
                        obj.insert("viewMode".to_string(), json!("terminal"));
                    }
                }
                out.push(m);
            }
        }
    }
    out
}

/// GET /api/sessions/stream — 列表级 SSE（鉴权后由 remote_server 独占连接调用）
pub(crate) fn handle_sessions_stream(stream: &mut TcpStream, query: &str) {
    // 长连接只写不读：清掉 keep-alive 阶段的读超时，避免误伤；写超时防半死连接。
    let _ = stream.set_read_timeout(None);
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));

    let pairs: Vec<(String, String)> = query
        .split('&')
        .filter(|s| !s.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((k, v)) => (k.to_string(), v.to_string()),
            None => (pair.to_string(), String::new()),
        })
        .collect();
    let after: u64 = pairs
        .iter()
        .find(|(k, _)| k == "after")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);

    let header = "HTTP/1.1 200 OK\r\n\
Content-Type: text/event-stream\r\n\
Cache-Control: no-cache\r\n\
Connection: keep-alive\r\n\
Access-Control-Allow-Origin: *\r\n\
X-Accel-Buffering: no\r\n\r\n";
    if stream.write_all(header.as_bytes()).is_err() {
        return;
    }
    let _ = stream.flush();

    // 首包：bridge 全量快照（Codex + Claude）；PTY 仍由客户端首刷 REST 合并
    let snap = json!({
        "type": "sessions/snapshot",
        "sessions": bridge_snapshot_sessions(),
    });
    if write_sse(stream, &snap).is_err() {
        return;
    }

    let mut cursor = after;
    let mut last_ping = Instant::now();
    loop {
        let batch: Vec<(u64, Value)> = {
            let mut q = match bus().events.lock() {
                Ok(g) => g,
                Err(e) => e.into_inner(),
            };
            if !q.iter().any(|(s, _)| *s > cursor) {
                // 5s：兼顾手机 NAT / 省电中间盒，别等太久才 ping
                match bus().cv.wait_timeout(q, Duration::from_secs(5)) {
                    Ok((guard, _)) => q = guard,
                    Err(e) => q = e.into_inner().0,
                }
            }
            q.iter()
                .filter(|(s, _)| *s > cursor)
                .cloned()
                .collect()
        };
        if batch.is_empty() {
            if last_ping.elapsed() >= Duration::from_secs(5) {
                if stream.write_all(b": ping\n\n").is_err() {
                    break;
                }
                let _ = stream.flush();
                last_ping = Instant::now();
            }
            continue;
        }
        for (seq, payload) in batch {
            cursor = seq;
            if write_sse(stream, &payload).is_err() {
                return;
            }
            last_ping = Instant::now();
        }
    }
}

fn write_sse(stream: &mut TcpStream, payload: &Value) -> Result<(), ()> {
    let line = format!("data: {}\n\n", payload);
    stream.write_all(line.as_bytes()).map_err(|_| ())?;
    stream.flush().map_err(|_| ())?;
    Ok(())
}

/// 供单元/调试：当前总线最大 seq
#[allow(dead_code)]
pub(crate) fn latest_seq() -> u64 {
    bus().seq.load(Ordering::SeqCst)
}
