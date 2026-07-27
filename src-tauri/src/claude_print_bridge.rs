//! Claude Code print-bridge：手机 Timeline 走官方 `--print` + stream-json，
//! 替代 PTY 刮屏。对标 `codex_app_server`，事件归一成同一套 notification，
//! 以便 Flutter Timeline 复用。
//!
//! 通道：本机 `claude -p --input-format stream-json --output-format stream-json`
//! （stdin/stdout NDJSON）。不经 Anthropic Remote Control / CCR。

use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use crate::provider::get_string;
use crate::{expand_home_path, parse_json_object};

const EVENT_RING: usize = 512;

static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<BridgeSession>>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, Arc<BridgeSession>>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct BridgeSession {
    session_id: String,
    /// Claude 侧 session_id（resume / 展示用）
    claude_session_id: Mutex<String>,
    created_at: String,
    title: Mutex<String>,
    cwd: Mutex<String>,
    model: Mutex<String>,
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    events: Mutex<VecDeque<(u64, Value)>>,
    event_seq: AtomicU64,
    event_cv: Condvar,
    token_total: Mutex<i64>,
    context_window: Mutex<i64>,
    alive: Mutex<bool>,
    turn_active: Mutex<bool>,
    /// 当前 assistant 流式 item（message.id）
    active_item_id: Mutex<String>,
    origin: Mutex<String>,
    /// working | waiting | done
    agent_status: Mutex<String>,
    pending_approval: Mutex<Option<Value>>,
    /// 最近一次 rate_limit_event（供用量面板）
    last_rate_limits: Mutex<Option<Value>>,
}

impl BridgeSession {
    fn push_event(&self, payload: Value) {
        let seq = self.event_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let mut q = self.events.lock().unwrap();
        q.push_back((seq, payload));
        while q.len() > EVENT_RING {
            q.pop_front();
        }
        self.event_cv.notify_all();
    }

    fn write_line(&self, line: &str) -> Result<(), String> {
        let mut guard = self.stdin.lock().map_err(|e| e.to_string())?;
        let stdin = guard
            .as_mut()
            .ok_or_else(|| "claude print-bridge 已退出".to_string())?;
        stdin
            .write_all(line.as_bytes())
            .map_err(|e| e.to_string())?;
        stdin.write_all(b"\n").map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;
        Ok(())
    }

    fn set_agent_status(&self, status: &str) {
        let next = match status {
            "working" | "waiting" | "done" => status,
            _ => "done",
        };
        let changed = {
            let mut g = self.agent_status.lock().unwrap_or_else(|e| e.into_inner());
            if *g == next {
                false
            } else {
                *g = next.to_string();
                true
            }
        };
        if !changed {
            return;
        }
        let pending = self
            .pending_approval
            .lock()
            .ok()
            .and_then(|p| p.clone())
            .unwrap_or(Value::Null);
        let summary = pending
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let title = self
            .title
            .lock()
            .ok()
            .map(|t| t.clone())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| "Claude".to_string());
        crate::desktop_notify::agent_status_changed(&title, next, &summary);
        self.push_event(json!({
            "type": "notification",
            "method": "agent/status",
            "params": {
                "agentStatus": next,
                "pendingApproval": pending,
            },
            "sessionId": self.session_id,
        }));
        crate::session_bus::publish_agent_status(
            &self.session_id,
            "claude",
            next,
            &pending,
            Some(self.snapshot()),
        );
    }

    fn set_waiting(&self, method: &str, id: &Value, summary: &str) {
        if let Ok(mut p) = self.pending_approval.lock() {
            *p = Some(json!({
                "method": method,
                "id": id,
                "summary": summary,
            }));
        }
        self.set_agent_status("waiting");
    }

    fn clear_waiting_after_approval(&self) {
        if let Ok(mut p) = self.pending_approval.lock() {
            *p = None;
        }
        let busy = *self.turn_active.lock().unwrap_or_else(|e| e.into_inner());
        self.set_agent_status(if busy { "working" } else { "done" });
    }

    fn snapshot(&self) -> Value {
        let claude_sid = self
            .claude_session_id
            .lock()
            .ok()
            .map(|t| t.clone())
            .unwrap_or_default();
        let pending = self
            .pending_approval
            .lock()
            .ok()
            .and_then(|p| p.clone());
        let agent_status = self
            .agent_status
            .lock()
            .ok()
            .map(|s| s.clone())
            .unwrap_or_else(|| "done".to_string());
        json!({
            "sessionId": self.session_id,
            "threadId": claude_sid,
            "turnId": if *self.turn_active.lock().unwrap_or_else(|e| e.into_inner()) {
                Some("active")
            } else {
                None
            },
            "title": self.title.lock().ok().map(|t| t.clone()).unwrap_or_default(),
            "cwd": self.cwd.lock().ok().map(|t| t.clone()).unwrap_or_default(),
            "model": self.model.lock().ok().map(|t| t.clone()).unwrap_or_default(),
            "effort": "",
            "createdAt": self.created_at,
            "running": *self.alive.lock().unwrap_or_else(|e| e.into_inner()),
            "bridge": true,
            "viewMode": "bridge",
            "tool": "claude",
            "origin": self.origin.lock().ok().map(|o| o.clone()).unwrap_or_default(),
            "commandPreview": "claude -p stream-json",
            "agentStatus": agent_status,
            "pendingApproval": pending,
            "tokens": {
                "total": *self.token_total.lock().unwrap_or_else(|e| e.into_inner()),
                "contextWindow": *self.context_window.lock().unwrap_or_else(|e| e.into_inner()),
            }
        })
    }
}

fn resolve_claude_bin() -> Result<String, String> {
    if let Ok(p) = which::which("claude") {
        return Ok(p.to_string_lossy().to_string());
    }
    let home = dirs::home_dir().unwrap_or_default();
    let candidates = [
        home.join(".npm-global/bin/claude"),
        home.join(".local/bin/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ];
    for c in candidates {
        if c.is_file() {
            return Ok(c.to_string_lossy().to_string());
        }
    }
    Err("未找到 claude 可执行文件，请先安装 Claude Code CLI".to_string())
}

fn env_map_from_body(body: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(Value::Object(env)) = body.get("env") {
        for (k, v) in env {
            if let Some(s) = v.as_str() {
                out.insert(k.clone(), json!(s));
            }
        }
    }
    out
}

fn spawn_print_bridge(
    claude_bin: &str,
    cwd: &str,
    model: &str,
    resume_id: &str,
    env: &Map<String, Value>,
) -> Result<(Child, ChildStdin, std::process::ChildStdout), String> {
    let mut args = vec![
        "-p".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
    ];
    if !model.is_empty() {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    if !resume_id.is_empty() {
        args.push("--resume".to_string());
        args.push(resume_id.to_string());
    }

    let mut cmd = Command::new(claude_bin);
    cmd.args(&args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in env {
        if let Some(s) = v.as_str() {
            cmd.env(k, s);
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", path);
    }
    // GUI 进程常缺代理；与 codex bridge 一致注入系统代理
    let has_proxy = env.keys().any(|k| {
        let k = k.to_ascii_lowercase();
        k == "https_proxy" || k == "http_proxy" || k == "all_proxy"
    });
    if !has_proxy {
        if let Some(proxy) = crate::terminal::detect_system_proxy() {
            for key in ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"] {
                cmd.env(key, &proxy);
            }
            let has_no_proxy = env.keys().any(|k| k.eq_ignore_ascii_case("NO_PROXY"))
                || std::env::var("NO_PROXY").is_ok()
                || std::env::var("no_proxy").is_ok();
            if !has_no_proxy {
                cmd.env("NO_PROXY", "localhost,127.0.0.1,::1");
            }
            eprintln!("[claude-print-bridge] 已注入系统代理: {proxy}");
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 claude print-bridge 失败: {e}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "claude stdin 不可用".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "claude stdout 不可用".to_string())?;
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                if line.contains("ERROR") || line.contains("error") {
                    eprintln!("[claude-print-bridge] {line}");
                }
            }
        });
    }
    Ok((child, stdin, stdout))
}

fn start_reader(session: Arc<BridgeSession>, stdout: std::process::ChildStdout) {
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(msg) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            handle_inbound(&session, msg);
        }
        if let Ok(mut alive) = session.alive.lock() {
            *alive = false;
        }
        if let Ok(mut t) = session.turn_active.lock() {
            *t = false;
        }
        if let Ok(mut p) = session.pending_approval.lock() {
            *p = None;
        }
        session.set_agent_status("done");
        session.push_event(json!({
            "type": "bridge/closed",
            "sessionId": session.session_id,
        }));
    });
}

fn notify(session: &BridgeSession, method: &str, params: Value) {
    session.push_event(json!({
        "type": "notification",
        "method": method,
        "params": params,
        "sessionId": session.session_id,
    }));
}

fn handle_inbound(session: &BridgeSession, msg: Value) {
    let ty = msg.get("type").and_then(Value::as_str).unwrap_or("");

    if let Some(sid) = msg.get("session_id").and_then(Value::as_str) {
        if !sid.is_empty() {
            if let Ok(mut g) = session.claude_session_id.lock() {
                if g.is_empty() {
                    *g = sid.to_string();
                }
            }
        }
    }

    match ty {
        "system" => {
            let subtype = msg.get("subtype").and_then(Value::as_str).unwrap_or("");
            if subtype == "init" {
                if let Some(model) = msg.get("model").and_then(Value::as_str) {
                    if let Ok(mut m) = session.model.lock() {
                        *m = model.to_string();
                    }
                    notify(
                        session,
                        "thread/settings/updated",
                        json!({ "threadSettings": { "model": model } }),
                    );
                }
            }
        }
        "stream_event" => {
            let event = msg.get("event").cloned().unwrap_or(Value::Null);
            let et = event.get("type").and_then(Value::as_str).unwrap_or("");
            match et {
                "message_start" => {
                    let mid = event
                        .pointer("/message/id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if !mid.is_empty() {
                        if let Ok(mut id) = session.active_item_id.lock() {
                            *id = mid;
                        }
                    }
                }
                "content_block_start" => {
                    let cb = event.get("content_block").cloned().unwrap_or(Value::Null);
                    let cb_type = cb.get("type").and_then(Value::as_str).unwrap_or("");
                    if cb_type == "tool_use" {
                        let name = cb.get("name").and_then(Value::as_str).unwrap_or("tool");
                        let id = cb.get("id").and_then(Value::as_str).unwrap_or("");
                        notify(
                            session,
                            "item/started",
                            json!({
                                "item": {
                                    "id": id,
                                    "type": "commandExecution",
                                    "command": name,
                                    "tool": name,
                                }
                            }),
                        );
                    } else if cb_type == "thinking" {
                        // 推理块开始：留给 delta
                    }
                }
                "content_block_delta" => {
                    let delta = event.get("delta").cloned().unwrap_or(Value::Null);
                    let dtype = delta.get("type").and_then(Value::as_str).unwrap_or("");
                    let item_id = session
                        .active_item_id
                        .lock()
                        .ok()
                        .map(|s| s.clone())
                        .unwrap_or_default();
                    if dtype == "text_delta" {
                        let text = delta.get("text").and_then(Value::as_str).unwrap_or("");
                        if !text.is_empty() {
                            notify(
                                session,
                                "item/agentMessage/delta",
                                json!({
                                    "itemId": item_id,
                                    "delta": text,
                                }),
                            );
                        }
                    } else if dtype == "thinking_delta" {
                        let text = delta.get("thinking").and_then(Value::as_str).unwrap_or("");
                        if !text.is_empty() {
                            notify(
                                session,
                                "item/reasoning/delta",
                                json!({
                                    "itemId": item_id,
                                    "delta": text,
                                }),
                            );
                        }
                    }
                }
                "message_stop" => {
                    let item_id = session
                        .active_item_id
                        .lock()
                        .ok()
                        .map(|s| s.clone())
                        .unwrap_or_default();
                    if !item_id.is_empty() {
                        notify(
                            session,
                            "item/completed",
                            json!({
                                "item": {
                                    "id": item_id,
                                    "type": "agentMessage",
                                    "text": "",
                                }
                            }),
                        );
                    }
                }
                _ => {}
            }
        }
        "assistant" => {
            // 完整 assistant 帧：若无流式 delta，用整段文本兜底
            let mid = msg
                .pointer("/message/id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let content = msg.pointer("/message/content").cloned().unwrap_or(Value::Null);
            let mut text = String::new();
            if let Some(arr) = content.as_array() {
                for block in arr {
                    let btype = block.get("type").and_then(Value::as_str).unwrap_or("");
                    if btype == "text" {
                        if let Some(t) = block.get("text").and_then(Value::as_str) {
                            text.push_str(t);
                        }
                    } else if btype == "tool_use" {
                        let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                        let id = block.get("id").and_then(Value::as_str).unwrap_or("");
                        notify(
                            session,
                            "item/started",
                            json!({
                                "item": {
                                    "id": id,
                                    "type": "commandExecution",
                                    "command": name,
                                    "tool": name,
                                }
                            }),
                        );
                    }
                }
            }
            // 仅在尚无 active 流时推完整消息（避免与 delta 重复）
            let has_active = session
                .active_item_id
                .lock()
                .ok()
                .map(|s| !s.is_empty())
                .unwrap_or(false);
            if !text.is_empty() && !has_active && !mid.is_empty() {
                notify(
                    session,
                    "item/completed",
                    json!({
                        "item": {
                            "id": mid,
                            "type": "agentMessage",
                            "text": text,
                        }
                    }),
                );
            }
        }
        "result" => {
            if let Ok(mut t) = session.turn_active.lock() {
                *t = false;
            }
            if let Ok(mut id) = session.active_item_id.lock() {
                *id = String::new();
            }
            let waiting = session
                .pending_approval
                .lock()
                .ok()
                .map(|p| p.is_some())
                .unwrap_or(false);
            if !waiting {
                session.set_agent_status("done");
            }
            // usage
            let input = msg
                .pointer("/usage/input_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let output = msg
                .pointer("/usage/output_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let cache_r = msg
                .pointer("/usage/cache_read_input_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let cache_c = msg
                .pointer("/usage/cache_creation_input_tokens")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let total = input + output + cache_r + cache_c;
            if total > 0 {
                if let Ok(mut v) = session.token_total.lock() {
                    *v += total;
                }
                notify(
                    session,
                    "thread/tokenUsage/updated",
                    json!({
                        "tokenUsage": {
                            "total": *session.token_total.lock().unwrap_or_else(|e| e.into_inner()),
                            "contextWindow": *session.context_window.lock().unwrap_or_else(|e| e.into_inner()),
                        }
                    }),
                );
            }
            notify(session, "turn/completed", json!({}));
        }
        "rate_limit_event" => {
            let info = msg.get("rate_limit_info").cloned().unwrap_or(json!({}));
            if let Ok(mut g) = session.last_rate_limits.lock() {
                *g = Some(info.clone());
            }
            notify(session, "account/rateLimits/updated", info);
        }
        "control_request" => {
            // Claude → host：审批等
            let request_id = msg
                .get("request_id")
                .cloned()
                .unwrap_or(Value::Null);
            let request = msg.get("request").cloned().unwrap_or(json!({}));
            let subtype = request
                .get("subtype")
                .and_then(Value::as_str)
                .unwrap_or("");
            if subtype == "can_use_tool" {
                let tool = request
                    .get("tool_name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool");
                let title = request
                    .get("title")
                    .or_else(|| request.get("display_name"))
                    .or_else(|| request.get("description"))
                    .and_then(Value::as_str)
                    .unwrap_or(tool);
                let summary = format!("{tool}: {title}");
                session.set_waiting("item/tool/requestApproval", &request_id, &summary);
                session.push_event(json!({
                    "type": "serverRequest",
                    "method": "item/tool/requestApproval",
                    "id": request_id,
                    "params": {
                        "command": summary,
                        "tool": tool,
                        "input": request.get("input").cloned().unwrap_or(json!({})),
                        "toolUseId": request.get("tool_use_id").cloned().unwrap_or(Value::Null),
                    },
                    "sessionId": session.session_id,
                }));
            } else if subtype == "elicitation" {
                let message = request
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("需要确认");
                session.set_waiting("item/tool/elicitation", &request_id, message);
                session.push_event(json!({
                    "type": "serverRequest",
                    "method": "item/tool/elicitation",
                    "id": request_id,
                    "params": { "message": message, "command": message },
                    "sessionId": session.session_id,
                }));
            }
        }
        _ => {}
    }
}

fn get_session(session_id: &str) -> Result<Arc<BridgeSession>, String> {
    sessions()
        .lock()
        .map_err(|e| e.to_string())?
        .get(session_id)
        .cloned()
        .ok_or_else(|| "claude bridge 会话不存在".to_string())
}

/// POST /api/claude/thread/start
pub(crate) fn api_thread_start(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let cwd_raw = get_string(&object, "cwd");
    let cwd = expand_home_path(&cwd_raw)
        .map(|p| p.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            dirs::home_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| ".".to_string())
        });
    let model = get_string(&object, "model");
    let title = {
        let t = get_string(&object, "title");
        if t.is_empty() {
            "Claude".to_string()
        } else {
            t
        }
    };
    let resume_id = {
        let a = get_string(&object, "resumeThreadId");
        if a.is_empty() {
            get_string(&object, "resumeSessionId")
        } else {
            a
        }
    };
    let env = env_map_from_body(&object);
    let origin = {
        let o = get_string(&object, "origin");
        if o.is_empty() {
            "desktop".to_string()
        } else {
            o
        }
    };

    let claude_bin = resolve_claude_bin()?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let (child, stdin, stdout) =
        spawn_print_bridge(&claude_bin, &cwd, &model, &resume_id, &env)?;

    let session = Arc::new(BridgeSession {
        session_id: session_id.clone(),
        claude_session_id: Mutex::new(resume_id.clone()),
        created_at: chrono::Utc::now().to_rfc3339(),
        title: Mutex::new(title),
        cwd: Mutex::new(cwd),
        model: Mutex::new(model),
        child: Mutex::new(Some(child)),
        stdin: Mutex::new(Some(stdin)),
        events: Mutex::new(VecDeque::new()),
        event_seq: AtomicU64::new(0),
        event_cv: Condvar::new(),
        token_total: Mutex::new(0),
        context_window: Mutex::new(200_000),
        alive: Mutex::new(true),
        turn_active: Mutex::new(false),
        active_item_id: Mutex::new(String::new()),
        origin: Mutex::new(origin),
        agent_status: Mutex::new("done".to_string()),
        pending_approval: Mutex::new(None),
        last_rate_limits: Mutex::new(None),
    });

    start_reader(session.clone(), stdout);
    sessions()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_id, session.clone());

    let snap = session.snapshot();
    crate::session_bus::publish_upsert(snap.clone());
    Ok(snap)
}

/// POST /api/claude/thread/resume
pub(crate) fn api_thread_resume(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let session_id = get_string(&object, "sessionId");
    let thread_id = get_string(&object, "threadId");
    if !session_id.is_empty() {
        // 已有 bridge：直接返回快照（Claude print 进程本身保持多轮）
        return Ok(get_session(&session_id)?.snapshot());
    }
    if thread_id.is_empty() {
        return Err("sessionId 或 threadId 不能为空".to_string());
    }
    let mut start_body = object.clone();
    start_body.insert("resumeThreadId".to_string(), json!(thread_id));
    api_thread_start(&Value::Object(start_body))
}

/// POST /api/claude/turn/start
pub(crate) fn api_turn_start(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let session_id = get_string(&object, "sessionId");
    let text = get_string(&object, "text");
    if session_id.is_empty() {
        return Err("sessionId 不能为空".to_string());
    }
    if text.trim().is_empty() {
        return Err("text 不能为空".to_string());
    }
    let session = get_session(&session_id)?;
    let mut client_msg_id = get_string(&object, "clientId");
    if client_msg_id.is_empty() {
        client_msg_id = uuid::Uuid::new_v4().to_string();
    }

    session.push_event(json!({
        "type": "local/userMessage",
        "sessionId": session_id,
        "text": text,
        "clientId": client_msg_id,
    }));
    if let Ok(mut t) = session.turn_active.lock() {
        *t = true;
    }
    if let Ok(mut id) = session.active_item_id.lock() {
        *id = String::new();
    }
    session.set_agent_status("working");
    notify(&session, "turn/started", json!({ "turn": { "id": "active" } }));

    let user_msg = json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": text,
        }
    });
    session.write_line(&user_msg.to_string())?;

    Ok(json!({
        "ok": true,
        "turn": { "id": "active" },
        "clientId": client_msg_id,
        "session": session.snapshot(),
    }))
}

/// POST /api/claude/turn/interrupt
pub(crate) fn api_turn_interrupt(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let session_id = get_string(&object, "sessionId");
    let session = get_session(&session_id)?;
    let request_id = uuid::Uuid::new_v4().to_string();
    let msg = json!({
        "type": "control_request",
        "request_id": request_id,
        "request": { "subtype": "interrupt" },
    });
    session.write_line(&msg.to_string())?;
    if let Ok(mut t) = session.turn_active.lock() {
        *t = false;
    }
    if let Ok(mut p) = session.pending_approval.lock() {
        *p = None;
    }
    session.set_agent_status("done");
    notify(&session, "turn/completed", json!({}));
    Ok(json!({ "ok": true, "session": session.snapshot() }))
}

/// POST /api/claude/approval
pub(crate) fn api_approval(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let session_id = get_string(&object, "sessionId");
    let request_id = object
        .get("requestId")
        .and_then(|v| {
            v.as_str()
                .map(|s| s.to_string())
                .or_else(|| v.as_i64().map(|n| n.to_string()))
                .or_else(|| v.as_u64().map(|n| n.to_string()))
        })
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "requestId 不能为空".to_string())?;

    let decision_raw = object
        .get("decision")
        .cloned()
        .unwrap_or_else(|| json!(get_string(&object, "decision")));
    let decision_str = decision_raw
        .as_str()
        .unwrap_or("")
        .to_string();

    // Codex UI: accept / acceptForSession / decline → Claude: allow / deny
    let (behavior, updated_permissions) = match decision_str.as_str() {
        "accept" | "allow" | "approve" | "yes" => ("allow", false),
        "acceptForSession" | "always" => ("allow", true),
        "decline" | "deny" | "reject" | "no" => ("deny", false),
        other if other.is_empty() => {
            // 允许直接传 { behavior: "allow" }
            let b = decision_raw
                .get("behavior")
                .and_then(Value::as_str)
                .unwrap_or("deny");
            (b, false)
        }
        _ => ("deny", false),
    };

    let mut response_body = json!({ "behavior": behavior });
    if behavior == "allow" {
        response_body
            .as_object_mut()
            .unwrap()
            .insert("updatedInput".to_string(), json!({}));
        if updated_permissions {
            // 会话级允许：带空 updatedPermissions 占位；具体规则由 Claude 侧处理
            response_body
                .as_object_mut()
                .unwrap()
                .insert("updatedPermissions".to_string(), json!([]));
        }
    } else {
        response_body
            .as_object_mut()
            .unwrap()
            .insert("message".to_string(), json!("User declined"));
    }

    let session = get_session(&session_id)?;
    let msg = json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": response_body,
        }
    });
    session.write_line(&msg.to_string())?;
    session.clear_waiting_after_approval();
    Ok(json!({ "ok": true, "session": session.snapshot() }))
}

/// POST /api/claude/thread/settings
pub(crate) fn api_thread_settings(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let session_id = get_string(&object, "sessionId");
    let session = get_session(&session_id)?;
    let model = get_string(&object, "model");
    if !model.is_empty() {
        let request_id = uuid::Uuid::new_v4().to_string();
        let msg = json!({
            "type": "control_request",
            "request_id": request_id,
            "request": {
                "subtype": "set_model",
                "model": model,
            }
        });
        session.write_line(&msg.to_string())?;
        if let Ok(mut m) = session.model.lock() {
            *m = model.clone();
        }
        notify(
            &session,
            "thread/settings/updated",
            json!({ "threadSettings": { "model": model } }),
        );
    }
    Ok(session.snapshot())
}

/// GET /api/claude/session
pub(crate) fn api_session_get(query: &Value) -> Result<Value, String> {
    let object = parse_json_object(query);
    let session_id = get_string(&object, "sessionId");
    Ok(get_session(&session_id)?.snapshot())
}

/// GET /api/claude/models — print-bridge 无上游 model/list，返回常用预设
pub(crate) fn api_models(query: &Value) -> Result<Value, String> {
    let object = parse_json_object(query);
    let session_id = get_string(&object, "sessionId");
    let current = if session_id.is_empty() {
        String::new()
    } else {
        get_session(&session_id)
            .ok()
            .and_then(|s| s.model.lock().ok().map(|m| m.clone()))
            .unwrap_or_default()
    };
    let presets = [
        ("claude-opus-4-20250514", "Opus 4"),
        ("claude-sonnet-4-20250514", "Sonnet 4"),
        ("claude-haiku-4-20250514", "Haiku 4"),
        ("claude-opus-4-1-20250805", "Opus 4.1"),
        ("claude-sonnet-4-5-20250929", "Sonnet 4.5"),
        ("claude-haiku-4-5-20251001", "Haiku 4.5"),
        ("claude-opus-4-6", "Opus 4.6"),
        ("claude-sonnet-4-6", "Sonnet 4.6"),
        ("opus", "opus（别名）"),
        ("sonnet", "sonnet（别名）"),
        ("haiku", "haiku（别名）"),
    ];
    let data: Vec<Value> = presets
        .iter()
        .map(|(id, name)| {
            json!({
                "id": id,
                "slug": id,
                "model": id,
                "displayName": name,
                "name": name,
                "current": *id == current,
            })
        })
        .collect();
    Ok(json!({ "data": data, "models": data, "current": current }))
}

/// GET /api/claude/rate-limits — 最近 rate_limit_event + 会话 token + 本地 5h 窗口
pub(crate) fn api_rate_limits(query: &Value) -> Result<Value, String> {
    let object = parse_json_object(query);
    let session_id = get_string(&object, "sessionId");
    let session = get_session(&session_id)?;
    let last = session
        .last_rate_limits
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or(Value::Null);
    let local = crate::usage_stats::claudecode_local_usage(&json!({})).unwrap_or(json!({}));
    Ok(json!({
        "note": "Claude 快速通道：官方配额事件（若有）+ 本会话 token + 本地 5h 消息窗口",
        "rateLimitEvent": last,
        "sessionTokens": {
            "total": *session.token_total.lock().unwrap_or_else(|e| e.into_inner()),
            "contextWindow": *session.context_window.lock().unwrap_or_else(|e| e.into_inner()),
        },
        "localUsage": local,
        "model": session.model.lock().ok().map(|m| m.clone()).unwrap_or_default(),
    }))
}

/// GET /api/claude/list
pub(crate) fn api_list(_query: &Value) -> Result<Value, String> {
    let map = sessions().lock().map_err(|e| e.to_string())?;
    let mut list: Vec<Value> = map.values().map(|s| s.snapshot()).collect();
    list.sort_by(|a, b| {
        let ta = a
            .get("createdAt")
            .and_then(Value::as_str)
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|t| t.timestamp_millis())
            .unwrap_or(0);
        let tb = b
            .get("createdAt")
            .and_then(Value::as_str)
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|t| t.timestamp_millis())
            .unwrap_or(0);
        tb.cmp(&ta)
    });
    Ok(json!({ "sessions": list }))
}

/// POST /api/claude/close
pub(crate) fn api_close(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let session_id = get_string(&object, "sessionId");
    let session = {
        let mut map = sessions().lock().map_err(|e| e.to_string())?;
        map.remove(&session_id)
    };
    if let Some(session) = session {
        if let Ok(mut alive) = session.alive.lock() {
            *alive = false;
        }
        // 关闭 stdin，让 print 进程自然结束；再 kill 兜底
        {
            let _ = session.stdin.lock().ok().and_then(|mut g| g.take());
        }
        if let Ok(mut child) = session.child.lock() {
            if let Some(mut c) = child.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
        crate::session_bus::publish_remove(&session_id, "claude");
    }
    Ok(json!({ "ok": true }))
}

/// SSE：推送 bridge 事件
pub(crate) fn handle_events_sse(stream: &mut TcpStream, query: &str) {
    use std::io::Write as _;
    let pairs: Vec<(String, String)> = query
        .split('&')
        .filter(|s| !s.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((k, v)) => (k.to_string(), v.to_string()),
            None => (pair.to_string(), String::new()),
        })
        .collect();
    let session_id = pairs
        .iter()
        .find(|(k, _)| k == "sessionId")
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    let after: u64 = pairs
        .iter()
        .find(|(k, _)| k == "after")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);

    let Ok(session) = get_session(session_id) else {
        let body = br#"{"ok":false,"error":"session not found"}"#;
        let header = format!(
            "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(header.as_bytes());
        let _ = stream.write_all(body);
        return;
    };

    let header = "HTTP/1.1 200 OK\r\n\
Content-Type: text/event-stream\r\n\
Cache-Control: no-cache\r\n\
Connection: keep-alive\r\n\
Access-Control-Allow-Origin: *\r\n\r\n";
    if stream.write_all(header.as_bytes()).is_err() {
        return;
    }
    let _ = stream.flush();

    let mut cursor = after;
    let mut last_ping = Instant::now();
    loop {
        if !*session.alive.lock().unwrap_or_else(|e| e.into_inner()) {
            let _ = write_sse(
                stream,
                &json!({"type":"bridge/closed","sessionId": session_id}),
            );
            break;
        }
        let batch: Vec<(u64, Value)> = {
            let mut q = match session.events.lock() {
                Ok(g) => g,
                Err(e) => e.into_inner(),
            };
            if !q.iter().any(|(s, _)| *s > cursor) {
                match session.event_cv.wait_timeout(q, Duration::from_secs(8)) {
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
            if last_ping.elapsed() >= Duration::from_secs(8) {
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
            let mut framed = payload;
            if let Some(obj) = framed.as_object_mut() {
                obj.insert("seq".to_string(), json!(seq));
            }
            if write_sse(stream, &framed).is_err() {
                return;
            }
        }
        last_ping = Instant::now();
    }
}

fn write_sse(stream: &mut TcpStream, payload: &Value) -> std::io::Result<()> {
    use std::io::Write as _;
    stream.write_all(format!("data: {}\n\n", payload).as_bytes())?;
    stream.flush()
}
