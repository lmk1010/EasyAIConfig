//! Codex app-server bridge：手机 Timeline 走官方 JSON-RPC，替代 PTY 刮屏。
//!
//! 每个 bridge session 持有一个 `codex app-server --listen stdio://` 子进程，
//! 负责 initialize / thread / turn，并把 notification + server→client 审批请求
//! 推入环形缓冲，供 SSE `/api/codex/events` 消费。

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
use crate::{parse_json_object, expand_home_path};

const EVENT_RING: usize = 512;
const RPC_TIMEOUT: Duration = Duration::from_secs(60);

static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<BridgeSession>>>> = OnceLock::new();
static NEXT_RPC_ID: AtomicU64 = AtomicU64::new(1);

fn sessions() -> &'static Mutex<HashMap<String, Arc<BridgeSession>>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct PendingRpc {
    done: Arc<(Mutex<Option<Result<Value, String>>>, Condvar)>,
}

struct BridgeSession {
    session_id: String,
    created_at: String,
    thread_id: Mutex<String>,
    turn_id: Mutex<Option<String>>,
    title: Mutex<String>,
    cwd: Mutex<String>,
    model: Mutex<String>,
    effort: Mutex<String>,
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<u64, PendingRpc>>,
    events: Mutex<VecDeque<(u64, Value)>>,
    event_seq: AtomicU64,
    event_cv: Condvar,
    token_total: Mutex<i64>,
    context_window: Mutex<i64>,
    alive: Mutex<bool>,
    /// phone | desktop | ""
    origin: Mutex<String>,
    /// working | waiting | done — Orca-style agent status for phone list / 等你
    agent_status: Mutex<String>,
    /// pending server→client approval summary (cleared on respond)
    pending_approval: Mutex<Option<Value>>,
    /// 会话 CODEX_HOME（多账号）；空则 ~/.codex
    codex_home: PathBuf,
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
        let stdin = guard.as_mut().ok_or_else(|| "app-server 已退出".to_string())?;
        stdin
            .write_all(line.as_bytes())
            .map_err(|e| e.to_string())?;
        stdin.write_all(b"\n").map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;
        Ok(())
    }

    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = NEXT_RPC_ID.fetch_add(1, Ordering::SeqCst);
        let waiter = Arc::new((Mutex::new(None), Condvar::new()));
        {
            let mut pending = self.pending.lock().map_err(|e| e.to_string())?;
            pending.insert(
                id,
                PendingRpc {
                    done: waiter.clone(),
                },
            );
        }
        let msg = json!({
            "method": method,
            "id": id,
            "params": params,
        });
        self.write_line(&msg.to_string())?;

        let (lock, cv) = &*waiter;
        let mut guard = lock.lock().map_err(|e| e.to_string())?;
        let deadline = Instant::now() + RPC_TIMEOUT;
        while guard.is_none() {
            let now = Instant::now();
            if now >= deadline {
                self.pending.lock().ok().map(|mut p| p.remove(&id));
                return Err(format!("{method} 超时"));
            }
            let (g, _) = cv
                .wait_timeout(guard, deadline - now)
                .map_err(|e| e.to_string())?;
            guard = g;
        }
        match guard.take() {
            Some(Ok(v)) => Ok(v),
            Some(Err(e)) => Err(e),
            None => Err(format!("{method} 无响应")),
        }
    }

    fn respond(&self, id: Value, result: Value) -> Result<(), String> {
        let msg = json!({ "id": id, "result": result });
        self.write_line(&msg.to_string())
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
            .unwrap_or_else(|| "Codex".to_string());
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
            "codex",
            next,
            &pending,
            Some(self.snapshot()),
        );
    }

    fn set_waiting(&self, method: &str, id: &Value, params: &Value) {
        let summary = params
            .get("command")
            .or_else(|| params.get("message"))
            .and_then(Value::as_str)
            .unwrap_or(method)
            .to_string();
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
        let busy = self
            .turn_id
            .lock()
            .ok()
            .and_then(|t| t.clone())
            .is_some();
        self.set_agent_status(if busy { "working" } else { "done" });
    }

    fn snapshot(&self) -> Value {
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
        let mut model = self
            .model
            .lock()
            .ok()
            .map(|t| t.clone())
            .unwrap_or_default();
        let mut effort = self
            .effort
            .lock()
            .ok()
            .map(|t| t.clone())
            .unwrap_or_default();
        let account = crate::terminal::codex_account_context(&self.codex_home);
        if model.is_empty() {
            model = account
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
        }
        if effort.is_empty() {
            effort = account
                .get("effort")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
        }
        json!({
            "sessionId": self.session_id,
            "threadId": self.thread_id.lock().ok().map(|t| t.clone()).unwrap_or_default(),
            "turnId": self.turn_id.lock().ok().and_then(|t| t.clone()),
            "title": self.title.lock().ok().map(|t| t.clone()).unwrap_or_default(),
            "cwd": self.cwd.lock().ok().map(|t| t.clone()).unwrap_or_default(),
            "model": model,
            "effort": effort,
            "createdAt": self.created_at,
            "running": *self.alive.lock().unwrap_or_else(|e| e.into_inner()),
            "bridge": true,
            "viewMode": "bridge",
            "tool": "codex",
            "origin": self.origin.lock().ok().map(|o| o.clone()).unwrap_or_default(),
            "commandPreview": "codex app-server",
            "agentStatus": agent_status,
            "pendingApproval": pending,
            "authMode": account.get("authMode").cloned().unwrap_or(json!("")),
            "authLabel": account.get("authLabel").cloned().unwrap_or(json!("")),
            "provider": account.get("provider").cloned().unwrap_or(json!("")),
            "providerName": account.get("providerName").cloned().unwrap_or(json!("")),
            "tokens": {
                "total": *self.token_total.lock().unwrap_or_else(|e| e.into_inner()),
                "contextWindow": *self.context_window.lock().unwrap_or_else(|e| e.into_inner()),
            }
        })
    }
}

fn resolve_codex_bin() -> Result<String, String> {
    let detected = crate::codex::find_codex_binary();
    detected
        .get("path")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| "未找到 codex 可执行文件，请先安装 @openai/codex".to_string())
}

fn env_has_proxy(env: &Map<String, Value>) -> bool {
    env.keys().any(|k| {
        let k = k.to_ascii_lowercase();
        k == "https_proxy" || k == "http_proxy" || k == "all_proxy"
    })
}

fn spawn_app_server(codex_bin: &str, env: &Map<String, Value>) -> Result<(Child, ChildStdin, std::process::ChildStdout), String> {
    let mut cmd = Command::new(codex_bin);
    cmd.args(["app-server", "--listen", "stdio://"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in env {
        if let Some(s) = v.as_str() {
            cmd.env(k, s);
        }
    }
    // 与嵌入终端一致：GUI 进程通常没有 shell 里的代理变量，
    // 从 macOS 系统代理 / 环境变量注入，否则 OAuth 会直连被污染的 chatgpt.com。
    if !env_has_proxy(env) {
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
            eprintln!("[codex-app-server] 已注入系统代理: {proxy}");
        }
    }
    // GUI 启动时 PATH 可能缺 npm 全局 bin；补常见路径
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", path);
    }
    let mut child = cmd.spawn().map_err(|e| format!("启动 app-server 失败: {e}"))?;
    let stdin = child.stdin.take().ok_or_else(|| "app-server stdin 不可用".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "app-server stdout 不可用".to_string())?;
    // 吞掉 stderr，避免塞满管道；可按需落日志
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                if line.contains("ERROR") || line.contains("error") {
                    eprintln!("[codex-app-server] {line}");
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
        session.push_event(json!({
            "type": "bridge/closed",
            "sessionId": session.session_id,
        }));
    });
}

fn handle_inbound(session: &BridgeSession, msg: Value) {
    // Response: { id, result } / { id, error }
    if let Some(id_v) = msg.get("id") {
        if msg.get("method").is_none() {
            let id = match id_v {
                Value::Number(n) => n.as_u64(),
                Value::String(s) => s.parse().ok(),
                _ => None,
            };
            if let Some(id) = id {
                let result = if let Some(err) = msg.get("error") {
                    let message = err
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("RPC error")
                        .to_string();
                    Err(message)
                } else {
                    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                };
                if let Ok(mut pending) = session.pending.lock() {
                    if let Some(p) = pending.remove(&id) {
                        let (lock, cv) = &*p.done;
                        if let Ok(mut g) = lock.lock() {
                            *g = Some(result);
                        }
                        cv.notify_all();
                    }
                }
            }
            return;
        }
        // Server → client request（审批等）→ 等你
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or(json!({}));
        let method_l = method.to_ascii_lowercase();
        if method_l.contains("requestapproval")
            || method_l.contains("requestuserinput")
            || method_l.contains("elicitation")
        {
            session.set_waiting(method, &id_v, &params);
        }
        session.push_event(json!({
            "type": "serverRequest",
            "method": method,
            "id": id_v,
            "params": params,
            "sessionId": session.session_id,
        }));
        return;
    }

    // Notification
    if let Some(method) = msg.get("method").and_then(Value::as_str) {
        let params = msg.get("params").cloned().unwrap_or(json!({}));
        on_notification(session, method, &params);
        session.push_event(json!({
            "type": "notification",
            "method": method,
            "params": params,
            "sessionId": session.session_id,
        }));
    }
}

fn on_notification(session: &BridgeSession, method: &str, params: &Value) {
    match method {
        "turn/started" => {
            if let Some(tid) = params
                .pointer("/turn/id")
                .and_then(Value::as_str)
                .map(|s| s.to_string())
            {
                if let Ok(mut t) = session.turn_id.lock() {
                    *t = Some(tid);
                }
            }
            let waiting = session
                .pending_approval
                .lock()
                .ok()
                .map(|p| p.is_some())
                .unwrap_or(false);
            if !waiting {
                session.set_agent_status("working");
            }
        }
        "turn/completed" => {
            if let Ok(mut t) = session.turn_id.lock() {
                *t = None;
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
        }
        "thread/tokenUsage/updated" => {
            // 尽力解析 total / context window
            if let Some(total) = params
                .pointer("/tokenUsage/total")
                .or_else(|| params.pointer("/usage/total"))
                .or_else(|| params.get("total"))
                .and_then(Value::as_i64)
            {
                if let Ok(mut v) = session.token_total.lock() {
                    *v = total;
                }
            }
            if let Some(win) = params
                .pointer("/tokenUsage/contextWindow")
                .or_else(|| params.pointer("/contextWindow"))
                .and_then(Value::as_i64)
            {
                if let Ok(mut v) = session.context_window.lock() {
                    *v = win;
                }
            }
            // last / lastTokens shapes vary — also try nested maps
            if let Some(obj) = params.as_object() {
                for key in ["tokenUsage", "usage", "last", "total"] {
                    if let Some(inner) = obj.get(key).and_then(Value::as_object) {
                        if let Some(t) = inner.get("total").and_then(Value::as_i64) {
                            if let Ok(mut v) = session.token_total.lock() {
                                *v = t;
                            }
                        }
                        if let Some(w) = inner
                            .get("contextWindow")
                            .or_else(|| inner.get("context_window"))
                            .and_then(Value::as_i64)
                        {
                            if let Ok(mut v) = session.context_window.lock() {
                                *v = w;
                            }
                        }
                    }
                }
            }
        }
        "thread/settings/updated" => {
            if let Some(model) = params
                .pointer("/threadSettings/model")
                .or_else(|| params.pointer("/settings/model"))
                .and_then(Value::as_str)
            {
                if let Ok(mut m) = session.model.lock() {
                    *m = model.to_string();
                }
            }
            if let Some(effort) = params
                .pointer("/threadSettings/effort")
                .or_else(|| params.pointer("/threadSettings/reasoningEffort"))
                .or_else(|| params.pointer("/settings/effort"))
                .and_then(Value::as_str)
            {
                if let Ok(mut e) = session.effort.lock() {
                    *e = effort.to_string();
                }
            }
        }
        _ => {}
    }
}

fn initialize_handshake(session: &BridgeSession) -> Result<(), String> {
    session.request(
        "initialize",
        json!({
            "clientInfo": {
                "name": "easy_ai_config",
                "title": "EasyAIConfig",
                "version": env!("CARGO_PKG_VERSION"),
            },
            "capabilities": {
                "experimentalApi": true
            }
        }),
    )?;
    // initialized 是 notification，无 id
    session.write_line(r#"{"method":"initialized"}"#)?;
    Ok(())
}

fn get_session(session_id: &str) -> Result<Arc<BridgeSession>, String> {
    sessions()
        .lock()
        .map_err(|e| e.to_string())?
        .get(session_id)
        .cloned()
        .ok_or_else(|| "bridge 会话不存在".to_string())
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

/// POST /api/codex/thread/start
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
            "Codex".to_string()
        } else {
            t
        }
    };
    let resume_thread_id = get_string(&object, "resumeThreadId");
    let env = env_map_from_body(&object);
    let origin = {
        let o = get_string(&object, "origin");
        if o.is_empty() { "desktop".to_string() } else { o }
    };
    let codex_home = {
        let from_env = env
            .get("CODEX_HOME")
            .and_then(Value::as_str)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        if let Some(h) = from_env {
            std::path::PathBuf::from(h)
        } else {
            dirs::home_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join(".codex")
        }
    };
    // 启动参数未带 model 时，从 config 预填，避免顶栏只显示 "Codex"
    let model = if model.is_empty() {
        crate::terminal::read_codex_config_str(&codex_home, "model").unwrap_or_default()
    } else {
        model
    };
    let effort_seed =
        crate::terminal::read_codex_config_str(&codex_home, "model_reasoning_effort")
            .unwrap_or_default();

    let codex_bin = resolve_codex_bin()?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let (child, stdin, stdout) = spawn_app_server(&codex_bin, &env)?;

    let session = Arc::new(BridgeSession {
        session_id: session_id.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
        thread_id: Mutex::new(String::new()),
        turn_id: Mutex::new(None),
        title: Mutex::new(title.clone()),
        cwd: Mutex::new(cwd.clone()),
        model: Mutex::new(model.clone()),
        effort: Mutex::new(effort_seed),
        child: Mutex::new(Some(child)),
        stdin: Mutex::new(Some(stdin)),
        pending: Mutex::new(HashMap::new()),
        events: Mutex::new(VecDeque::new()),
        event_seq: AtomicU64::new(0),
        event_cv: Condvar::new(),
        token_total: Mutex::new(0),
        context_window: Mutex::new(0),
        alive: Mutex::new(true),
        origin: Mutex::new(origin),
        agent_status: Mutex::new("done".to_string()),
        pending_approval: Mutex::new(None),
        codex_home,
    });

    start_reader(session.clone(), stdout);
    initialize_handshake(&session)?;

    let thread_result = if !resume_thread_id.is_empty() {
        session.request(
            "thread/resume",
            json!({
                "threadId": resume_thread_id,
            }),
        )?
    } else {
        let mut params = json!({
            "cwd": cwd,
        });
        if !model.is_empty() {
            params
                .as_object_mut()
                .unwrap()
                .insert("model".to_string(), json!(model));
        }
        session.request("thread/start", params)?
    };

    let thread_id = thread_result
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if thread_id.is_empty() {
        return Err("thread/start 未返回 thread.id".to_string());
    }
    if let Ok(mut t) = session.thread_id.lock() {
        *t = thread_id.clone();
    }
    // 从 thread 对象补模型
    if let Some(m) = thread_result
        .pointer("/thread/model")
        .and_then(Value::as_str)
    {
        if let Ok(mut model_lock) = session.model.lock() {
            if model_lock.is_empty() {
                *model_lock = m.to_string();
            }
        }
    }

    sessions()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_id.clone(), session.clone());

    let snap = session.snapshot();
    crate::session_bus::publish_upsert(snap.clone());
    Ok(snap)
}

/// POST /api/codex/thread/resume — 对本 bridge session 再 resume（或用已有 sessionId）
pub(crate) fn api_thread_resume(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let session_id = get_string(&object, "sessionId");
    let thread_id_override = get_string(&object, "threadId");
    if session_id.is_empty() {
        // 允许直接用 threadId 开新 bridge
        if thread_id_override.is_empty() {
            return Err("sessionId 或 threadId 不能为空".to_string());
        }
        let mut start_body = object.clone();
        start_body.insert("resumeThreadId".to_string(), json!(thread_id_override));
        return api_thread_start(&Value::Object(start_body));
    }
    let session = get_session(&session_id)?;
    let thread_id = if thread_id_override.is_empty() {
        session.thread_id.lock().map_err(|e| e.to_string())?.clone()
    } else {
        thread_id_override
    };
    let result = session.request(
        "thread/resume",
        json!({ "threadId": thread_id }),
    )?;
    if let Some(tid) = result.pointer("/thread/id").and_then(Value::as_str) {
        if let Ok(mut t) = session.thread_id.lock() {
            *t = tid.to_string();
        }
    }
    Ok(session.snapshot())
}

/// POST /api/codex/turn/start
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
    let thread_id = session.thread_id.lock().map_err(|e| e.to_string())?.clone();
    if thread_id.is_empty() {
        return Err("thread 未就绪".to_string());
    }
    let mut client_msg_id = get_string(&object, "clientId");
    if client_msg_id.is_empty() {
        client_msg_id = uuid::Uuid::new_v4().to_string();
    }
    // 本地先推一条 user 消息事件；手机端若已用同一 clientId 乐观渲染则去重
    session.push_event(json!({
        "type": "local/userMessage",
        "sessionId": session_id,
        "text": text,
        "clientId": client_msg_id,
    }));
    let result = session.request(
        "turn/start",
        json!({
            "threadId": thread_id,
            "clientUserMessageId": client_msg_id,
            "input": [{ "type": "text", "text": text }],
        }),
    )?;
    if let Some(tid) = result.pointer("/turn/id").and_then(Value::as_str) {
        if let Ok(mut t) = session.turn_id.lock() {
            *t = Some(tid.to_string());
        }
    }
    session.set_agent_status("working");
    Ok(json!({
        "ok": true,
        "turn": result.get("turn").cloned().unwrap_or(result),
        "clientId": client_msg_id,
        "session": session.snapshot(),
    }))
}

/// POST /api/codex/turn/interrupt
pub(crate) fn api_turn_interrupt(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let session_id = get_string(&object, "sessionId");
    let session = get_session(&session_id)?;
    let thread_id = session.thread_id.lock().map_err(|e| e.to_string())?.clone();
    let turn_id = session
        .turn_id
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "没有进行中的 turn".to_string())?;
    session.request(
        "turn/interrupt",
        json!({ "threadId": thread_id, "turnId": turn_id }),
    )?;
    Ok(json!({ "ok": true }))
}

/// POST /api/codex/approval — 回应 server→client 审批请求
pub(crate) fn api_approval(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let session_id = get_string(&object, "sessionId");
    let request_id = object
        .get("requestId")
        .cloned()
        .ok_or_else(|| "requestId 不能为空".to_string())?;
    let decision = object
        .get("decision")
        .cloned()
        .unwrap_or_else(|| json!(get_string(&object, "decision")));
    if decision.as_str().map(|s| s.is_empty()).unwrap_or(false) && !decision.is_object() {
        return Err("decision 不能为空".to_string());
    }
    let session = get_session(&session_id)?;
    session.respond(request_id, json!({ "decision": decision }))?;
    session.clear_waiting_after_approval();
    Ok(json!({ "ok": true, "session": session.snapshot() }))
}

/// GET /api/codex/models
pub(crate) fn api_models(query: &Value) -> Result<Value, String> {
    let object = parse_json_object(query);
    let session_id = get_string(&object, "sessionId");
    let session = get_session(&session_id)?;
    let result = session.request("model/list", json!({}))?;
    Ok(result)
}

/// POST /api/codex/thread/settings
pub(crate) fn api_thread_settings(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let session_id = get_string(&object, "sessionId");
    let session = get_session(&session_id)?;
    let thread_id = session.thread_id.lock().map_err(|e| e.to_string())?.clone();
    let mut params = json!({ "threadId": thread_id });
    let obj = params.as_object_mut().unwrap();
    let model = get_string(&object, "model");
    let effort = get_string(&object, "reasoningEffort");
    let effort_alt = get_string(&object, "effort");
    if !model.is_empty() {
        obj.insert("model".to_string(), json!(model.clone()));
        if let Ok(mut m) = session.model.lock() {
            *m = model;
        }
    }
    let effort_val = if !effort.is_empty() { effort } else { effort_alt };
    if !effort_val.is_empty() {
        // app-server v2 字段名是 effort；部分版本/通知里也会带 reasoningEffort
        obj.insert("effort".to_string(), json!(effort_val.clone()));
        obj.insert("reasoningEffort".to_string(), json!(effort_val.clone()));
        if let Ok(mut e) = session.effort.lock() {
            *e = effort_val;
        }
    }
    session.request("thread/settings/update", params)?;
    Ok(session.snapshot())
}

/// GET /api/codex/rate-limits
pub(crate) fn api_rate_limits(query: &Value) -> Result<Value, String> {
    let object = parse_json_object(query);
    let session_id = get_string(&object, "sessionId");
    let session = get_session(&session_id)?;
    let result = session.request("account/rateLimits/read", json!({}))?;
    Ok(result)
}

/// GET /api/codex/session
pub(crate) fn api_session_get(query: &Value) -> Result<Value, String> {
    let object = parse_json_object(query);
    let session_id = get_string(&object, "sessionId");
    Ok(get_session(&session_id)?.snapshot())
}

/// GET /api/codex/list — 当前 bridge 会话列表（给手机会话页）
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

/// POST /api/codex/close
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
        if let Ok(mut child) = session.child.lock() {
            if let Some(mut c) = child.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
        crate::session_bus::publish_remove(&session_id, "codex");
    }
    Ok(json!({ "ok": true }))
}

/// SSE：推送 bridge 事件（notification + serverRequest + local）。
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
            let _ = write_sse(stream, &json!({"type":"bridge/closed","sessionId": session_id}));
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
