// Agent Session — 结构化事件会话（Claude stream-json + Codex exec --json）
//
// 与 terminal.rs 的 PTY 镜像并列：子进程 stdout NDJSON → 规范化 envelope
// 通过 Tauri `agent-event`（及可选 LAN remote fan-out）推给前端 timeline。

use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use tauri::{AppHandle, Emitter};

use crate::provider::get_string;
use crate::{app_home, ensure_dir, expand_home_path, home_dir, parse_json_object};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

pub(crate) fn install(handle: &AppHandle) {
  let _ = APP_HANDLE.set(handle.clone());
}

const MAX_EVENTS: usize = 2000;
const MAX_STDERR_LINES: usize = 40;

const PERMISSION_MODES: &[&str] = &[
  "manual",
  "acceptEdits",
  "auto",
  "plan",
  "dontAsk",
  "bypassPermissions",
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum AgentEngine {
  Claude,
  Codex,
}

impl AgentEngine {
  fn as_str(self) -> &'static str {
    match self {
      AgentEngine::Claude => "claude",
      AgentEngine::Codex => "codex",
    }
  }
  fn tool_name(self) -> &'static str {
    match self {
      AgentEngine::Claude => "claudecode",
      AgentEngine::Codex => "codex",
    }
  }
  fn from_tool(tool: &str) -> Self {
    let t = tool.trim().to_ascii_lowercase();
    if t == "codex" || t == "openai" {
      AgentEngine::Codex
    } else {
      AgentEngine::Claude
    }
  }
}

struct AgentRuntime {
  child: Child,
  stdin: Option<ChildStdin>,
  running: bool,
  exit_code: Option<i32>,
}

struct AgentSession {
  id: String,
  engine: AgentEngine,
  tool: String,
  title: String,
  cwd: String,
  model: String,
  permission_mode: String,
  sandbox: String,
  command_preview: String,
  created_at: String,
  claude_session_id: Mutex<Option<String>>,
  codex_session_id: Mutex<Option<String>>,
  seq: Mutex<u64>,
  events: Mutex<VecDeque<Value>>,
  stderr: Mutex<VecDeque<String>>,
  runtime: Mutex<AgentRuntime>,
  transcript_path: PathBuf,
}

type SessionMap = BTreeMap<String, Arc<AgentSession>>;

fn sessions() -> &'static Mutex<SessionMap> {
  static S: OnceLock<Mutex<SessionMap>> = OnceLock::new();
  S.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn now_ms() -> i64 {
  chrono::Utc::now().timestamp_millis()
}

fn transcripts_dir() -> Result<PathBuf, String> {
  let dir = app_home()?.join("agent-transcripts");
  ensure_dir(&dir)?;
  Ok(dir)
}

fn resolve_cwd(input: &str) -> Result<PathBuf, String> {
  if let Some(path) = expand_home_path(input) {
    return Ok(path);
  }
  home_dir()
}

fn resolve_claude_program(program: &str) -> String {
  let trimmed = program.trim();
  if !trimmed.is_empty() {
    if Path::new(trimmed).exists() {
      return trimmed.to_string();
    }
    if let Ok(path) = which::which(trimmed) {
      return path.to_string_lossy().to_string();
    }
    return trimmed.to_string();
  }
  which::which("claude")
    .map(|p| p.to_string_lossy().to_string())
    .unwrap_or_else(|_| {
      if cfg!(windows) {
        "claude.cmd".to_string()
      } else {
        "claude".to_string()
      }
    })
}

fn normalize_permission_mode(mode: &str) -> String {
  let m = mode.trim();
  if PERMISSION_MODES.iter().any(|x| *x == m) {
    m.to_string()
  } else {
    "manual".to_string()
  }
}

fn session_info(session: &AgentSession) -> Value {
  let running = session
    .runtime
    .lock()
    .map(|r| r.running)
    .unwrap_or(false);
  let exit_code = session
    .runtime
    .lock()
    .ok()
    .and_then(|r| r.exit_code);
  let claude_session_id = session
    .claude_session_id
    .lock()
    .ok()
    .and_then(|v| v.clone())
    .unwrap_or_default();
  let event_count = session.events.lock().map(|e| e.len()).unwrap_or(0);
  json!({
    "sessionId": session.id,
    "tool": session.tool,
    "title": session.title,
    "cwd": session.cwd,
    "model": session.model,
    "permissionMode": session.permission_mode,
    "commandPreview": session.command_preview,
    "createdAt": session.created_at,
    "running": running,
    "exitCode": exit_code,
    "claudeSessionId": claude_session_id,
    "eventCount": event_count,
    "kind": "agent",
    "view": "timeline",
  })
}

fn get_session(id: &str) -> Result<Arc<AgentSession>, String> {
  let map = sessions().lock().map_err(|e| e.to_string())?;
  map
    .get(id)
    .cloned()
    .ok_or_else(|| format!("agent session 不存在: {id}"))
}

fn next_seq(session: &AgentSession) -> u64 {
  let mut seq = session.seq.lock().unwrap_or_else(|p| p.into_inner());
  *seq += 1;
  *seq
}

fn append_event(session: &AgentSession, envelope: Value) {
  if let Ok(mut events) = session.events.lock() {
    events.push_back(envelope.clone());
    while events.len() > MAX_EVENTS {
      events.pop_front();
    }
  }
  // transcript 落盘（best-effort）
  if let Ok(mut file) = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(&session.transcript_path)
  {
    let _ = writeln!(file, "{envelope}");
  }
  if let Some(app) = APP_HANDLE.get() {
    let _ = app.emit("agent-event", envelope);
  }
}

fn emit_envelope(session: &AgentSession, typ: &str, payload: Value) {
  let envelope = json!({
    "v": 1,
    "sessionId": session.id,
    "seq": next_seq(session),
    "ts": now_ms(),
    "type": typ,
    "payload": payload,
  });
  append_event(session, envelope);
}

fn tool_verb(name: &str) -> &'static str {
  match name {
    "Read" | "FileReadTool" => "Reading",
    "Write" | "FileWriteTool" => "Writing",
    "Edit" | "MultiEdit" | "FileEditTool" => "Editing",
    "Bash" | "BashTool" => "Running",
    "Glob" | "GlobTool" => "Searching",
    "Grep" | "GrepTool" => "Searching",
    "WebFetch" => "Fetching",
    "WebSearch" => "Searching",
    "Task" => "Running task",
    "NotebookEditTool" => "Editing notebook",
    "LSP" => "LSP",
    _ => "Tool",
  }
}

fn tool_target(input: &Map<String, Value>) -> String {
  for key in [
    "file_path",
    "filePath",
    "path",
    "pattern",
    "command",
    "url",
    "query",
  ] {
    if let Some(v) = input.get(key).and_then(Value::as_str) {
      let t = v.trim();
      if !t.is_empty() {
        if t.len() > 120 {
          return format!("{}…", &t[..117]);
        }
        return t.to_string();
      }
    }
  }
  String::new()
}

fn tool_summary(name: &str, input: &Map<String, Value>) -> String {
  let verb = tool_verb(name);
  let target = tool_target(input);
  if target.is_empty() {
    if verb == "Tool" {
      name.to_string()
    } else {
      format!("{verb}")
    }
  } else if verb == "Tool" {
    format!("{name} {target}")
  } else {
    format!("{verb} {target}")
  }
}

fn extract_text_from_content(content: &Value) -> String {
  if let Some(s) = content.as_str() {
    return s.to_string();
  }
  let Some(arr) = content.as_array() else {
    return String::new();
  };
  let mut parts = Vec::new();
  for block in arr {
    let typ = block.get("type").and_then(Value::as_str).unwrap_or("");
    if typ == "text" {
      if let Some(t) = block.get("text").and_then(Value::as_str) {
        if !t.is_empty() {
          parts.push(t.to_string());
        }
      }
    }
  }
  parts.join("")
}

fn content_has_tool_result(content: &Value) -> bool {
  content
    .as_array()
    .map(|arr| {
      arr.iter().any(|b| {
        matches!(
          b.get("type").and_then(Value::as_str),
          Some("tool_result")
        )
      })
    })
    .unwrap_or(false)
}

/// 将 Claude NDJSON 一行映射为 0..N 条规范化 envelope（已 emit）
fn process_ndjson_line(session: &AgentSession, line: &str) {
  let trimmed = line.trim();
  if trimmed.is_empty() {
    return;
  }
  let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
    emit_envelope(
      session,
      "raw",
      json!({ "line": trimmed.chars().take(500).collect::<String>() }),
    );
    return;
  };
  let msg_type = msg.get("type").and_then(Value::as_str).unwrap_or("");

  // 捕获 session_id（若干消息都会带）
  if let Some(sid) = msg
    .get("session_id")
    .and_then(Value::as_str)
    .filter(|s| !s.is_empty())
  {
    if let Ok(mut slot) = session.claude_session_id.lock() {
      *slot = Some(sid.to_string());
    }
  }

  match msg_type {
    "assistant" => {
      let message = msg.get("message").cloned().unwrap_or(Value::Null);
      let content = message.get("content").cloned().unwrap_or(Value::Null);
      if let Some(arr) = content.as_array() {
        for block in arr {
          let btype = block.get("type").and_then(Value::as_str).unwrap_or("");
          match btype {
            "text" => {
              let text = block.get("text").and_then(Value::as_str).unwrap_or("");
              if !text.is_empty() {
                emit_envelope(
                  session,
                  "timeline.item",
                  json!({
                    "role": "assistant",
                    "text": text,
                    "messageId": message.get("id"),
                  }),
                );
              }
            }
            "tool_use" => {
              let name = block.get("name").and_then(Value::as_str).unwrap_or("Tool");
              let input = block
                .get("input")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
              let summary = tool_summary(name, &input);
              emit_envelope(
                session,
                "tool",
                json!({
                  "phase": "start",
                  "name": name,
                  "toolUseId": block.get("id"),
                  "input": input,
                  "summary": summary,
                }),
              );
            }
            "thinking" => {
              let text = block.get("thinking").and_then(Value::as_str)
                .or_else(|| block.get("text").and_then(Value::as_str))
                .unwrap_or("");
              if !text.is_empty() {
                emit_envelope(
                  session,
                  "timeline.item",
                  json!({
                    "role": "thinking",
                    "text": text,
                  }),
                );
              }
            }
            _ => {}
          }
        }
      }
      // usage on assistant message
      if let Some(usage) = message.get("usage") {
        emit_envelope(session, "usage", usage.clone());
      }
    }
    "user" => {
      let message = msg.get("message").cloned().unwrap_or(Value::Null);
      let content = message.get("content").cloned().unwrap_or(Value::Null);
      let is_synthetic = msg
        .get("isSynthetic")
        .and_then(Value::as_bool)
        .unwrap_or(false);
      let parent_tool = msg.get("parent_tool_use_id");
      if content_has_tool_result(&content) {
        if let Some(arr) = content.as_array() {
          for block in arr {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
              continue;
            }
            let result_text = extract_text_from_content(
              &json!([block]),
            );
            let preview = {
              let t = if let Some(s) = block.get("content").and_then(Value::as_str) {
                s.to_string()
              } else {
                extract_text_from_content(block.get("content").unwrap_or(&Value::Null))
              };
              if t.len() > 400 {
                format!("{}…", &t[..397])
              } else {
                t
              }
            };
            emit_envelope(
              session,
              "tool",
              json!({
                "phase": "result",
                "toolUseId": block.get("tool_use_id"),
                "isError": block.get("is_error").and_then(Value::as_bool).unwrap_or(false),
                "preview": preview,
                "resultText": result_text,
              }),
            );
          }
        }
      } else if !is_synthetic && parent_tool.is_none() {
        let text = extract_text_from_content(&content);
        if !text.trim().is_empty() {
          emit_envelope(
            session,
            "timeline.item",
            json!({
              "role": "user",
              "text": text,
              "replay": msg.get("isReplay").and_then(Value::as_bool).unwrap_or(false),
            }),
          );
        }
      }
    }
    "result" => {
      let subtype = msg.get("subtype").and_then(Value::as_str).unwrap_or("");
      let is_error = subtype != "success" && !subtype.is_empty();
      let errors = msg.get("errors").cloned().unwrap_or(json!([]));
      let result_text = msg
        .get("result")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
      emit_envelope(
        session,
        "status",
        json!({
          "state": if subtype == "success" { "completed" } else if subtype.is_empty() { "result" } else { "error" },
          "subtype": subtype,
          "isError": is_error,
          "errors": errors,
          "result": result_text,
          "durationMs": msg.get("duration_ms"),
          "usage": msg.get("usage"),
        }),
      );
      if let Some(usage) = msg.get("usage") {
        emit_envelope(session, "usage", usage.clone());
      }
      if !result_text.is_empty() && subtype == "success" {
        // 部分版本只在 result 里给最终文本
        emit_envelope(
          session,
          "timeline.item",
          json!({
            "role": "assistant",
            "text": result_text,
            "fromResult": true,
          }),
        );
      }
    }
    "control_request" => {
      let request_id = msg.get("request_id").cloned().unwrap_or(Value::Null);
      let request = msg.get("request").cloned().unwrap_or(Value::Null);
      let subtype = request
        .get("subtype")
        .and_then(Value::as_str)
        .unwrap_or("");
      if subtype == "can_use_tool" {
        let tool_name = request
          .get("tool_name")
          .and_then(Value::as_str)
          .unwrap_or("Tool");
        let input = request
          .get("input")
          .and_then(Value::as_object)
          .cloned()
          .unwrap_or_default();
        let summary = tool_summary(tool_name, &input);
        emit_envelope(
          session,
          "permission",
          json!({
            "requestId": request_id,
            "toolName": tool_name,
            "toolUseId": request.get("tool_use_id"),
            "input": input,
            "summary": summary,
            "status": "pending",
          }),
        );
      } else {
        emit_envelope(
          session,
          "raw",
          json!({ "kind": "control_request", "message": msg }),
        );
      }
    }
    "stream_event" | "content_block_delta" | "message_delta" => {
      // partial streaming
      let delta = msg
        .get("delta")
        .cloned()
        .or_else(|| msg.get("event").cloned())
        .unwrap_or(msg.clone());
      let text = delta
        .get("text")
        .and_then(Value::as_str)
        .or_else(|| {
          delta
            .pointer("/delta/text")
            .and_then(Value::as_str)
        })
        .or_else(|| {
          delta
            .get("partial_message")
            .and_then(|p| p.pointer("/content/0/text"))
            .and_then(Value::as_str)
        })
        .unwrap_or("");
      if !text.is_empty() {
        emit_envelope(
          session,
          "timeline.delta",
          json!({
            "role": "assistant",
            "text": text,
          }),
        );
      } else {
        // try nested event shape from --include-partial-messages
        if let Some(event) = msg.get("event") {
          let et = event.get("type").and_then(Value::as_str).unwrap_or("");
          if et == "content_block_delta" {
            if let Some(t) = event
              .pointer("/delta/text")
              .and_then(Value::as_str)
              .filter(|s| !s.is_empty())
            {
              emit_envelope(
                session,
                "timeline.delta",
                json!({ "role": "assistant", "text": t }),
              );
            }
          }
        }
      }
    }
    "system" => {
      // init / status hints
      let subtype = msg.get("subtype").and_then(Value::as_str).unwrap_or("");
      emit_envelope(
        session,
        "status",
        json!({
          "state": "system",
          "subtype": subtype,
          "message": msg.get("message").or_else(|| msg.get("data")),
          "model": msg.get("model"),
          "cwd": msg.get("cwd"),
        }),
      );
      if let Some(model) = msg.get("model").and_then(Value::as_str) {
        // no mut on session.model (immutable after create) — surface via mode/status only
        let _ = model;
      }
    }
    _ => {
      emit_envelope(
        session,
        "raw",
        json!({ "kind": msg_type, "message": msg }),
      );
    }
  }
}

fn write_stdin_line(session: &AgentSession, line: &str) -> Result<(), String> {
  let mut runtime = session.runtime.lock().map_err(|e| e.to_string())?;
  if !runtime.running {
    return Err("agent session 已结束".to_string());
  }
  let stdin = runtime
    .stdin
    .as_mut()
    .ok_or_else(|| "stdin 不可用".to_string())?;
  stdin
    .write_all(line.as_bytes())
    .map_err(|e| e.to_string())?;
  if !line.ends_with('\n') {
    stdin.write_all(b"\n").map_err(|e| e.to_string())?;
  }
  stdin.flush().map_err(|e| e.to_string())?;
  Ok(())
}

fn build_user_message_line(text: &str) -> String {
  // Claude stream-json user message (SDK-compatible minimal shape)
  let msg = json!({
    "type": "user",
    "message": {
      "role": "user",
      "content": text,
    },
  });
  msg.to_string()
}

fn build_control_response(request_id: &str, behavior: &str, message: Option<&str>) -> String {
  let mut response = json!({
    "behavior": behavior,
  });
  if let Some(m) = message {
    if !m.is_empty() {
      response
        .as_object_mut()
        .unwrap()
        .insert("message".to_string(), json!(m));
    }
  }
  json!({
    "type": "control_response",
    "response": {
      "subtype": "success",
      "request_id": request_id,
      "response": response,
    }
  })
  .to_string()
}

fn build_control_request(subtype: &str, extra: Map<String, Value>) -> String {
  let request_id = uuid::Uuid::new_v4().to_string();
  let mut request = Map::new();
  request.insert("subtype".to_string(), json!(subtype));
  for (k, v) in extra {
    request.insert(k, v);
  }
  json!({
    "type": "control_request",
    "request_id": request_id,
    "request": request,
  })
  .to_string()
}

fn spawn_reader_threads(session: Arc<AgentSession>, stdout: std::process::ChildStdout, stderr: std::process::ChildStderr) {
  let session_out = Arc::clone(&session);
  thread::spawn(move || {
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
      match line {
        Ok(text) => process_ndjson_line(&session_out, &text),
        Err(_) => break,
      }
    }
    // stdout EOF → wait child
    let mut code = None;
    if let Ok(mut runtime) = session_out.runtime.lock() {
      if let Ok(status) = runtime.child.wait() {
        code = status.code();
        runtime.exit_code = code;
      }
      runtime.running = false;
      runtime.stdin = None;
    }
    emit_envelope(
      &session_out,
      "status",
      json!({
        "state": "exited",
        "exitCode": code,
      }),
    );
  });

  let session_err = Arc::clone(&session);
  thread::spawn(move || {
    let reader = BufReader::new(stderr);
    for line in reader.lines() {
      let Ok(text) = line else { break };
      if let Ok(mut buf) = session_err.stderr.lock() {
        buf.push_back(text.clone());
        while buf.len() > MAX_STDERR_LINES {
          buf.pop_front();
        }
      }
    }
  });
}

/// POST /api/agent/create
pub(crate) fn agent_create(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let cwd = resolve_cwd(&get_string(&object, "cwd"))?;
  let model = get_string(&object, "model");
  let permission_mode = normalize_permission_mode(&get_string(&object, "permissionMode"));
  let resume = get_string(&object, "resume");
  let title_input = get_string(&object, "title");
  let program_input = get_string(&object, "program");
  let program = resolve_claude_program(&program_input);

  let mut args: Vec<String> = vec![
    "-p".to_string(),
    "--output-format".to_string(),
    "stream-json".to_string(),
    "--input-format".to_string(),
    "stream-json".to_string(),
    "--include-partial-messages".to_string(),
    "--replay-user-messages".to_string(),
    "--verbose".to_string(),
    "--permission-mode".to_string(),
    permission_mode.clone(),
  ];
  if !model.trim().is_empty() {
    args.push("--model".to_string());
    args.push(model.clone());
  }
  if !resume.trim().is_empty() {
    args.push("--resume".to_string());
    args.push(resume.clone());
  }
  // 额外 flags
  if let Some(extra) = object.get("args").and_then(Value::as_array) {
    for item in extra {
      if let Some(s) = item.as_str() {
        let t = s.trim();
        if !t.is_empty() {
          args.push(t.to_string());
        }
      }
    }
  }
  // raw flags string
  let flags = get_string(&object, "flags");
  if !flags.trim().is_empty() {
    for part in flags.split_whitespace() {
      args.push(part.to_string());
    }
  }

  let envs: Vec<(String, String)> = object
    .get("env")
    .and_then(Value::as_object)
    .map(|m| {
      m.iter()
        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
        .collect()
    })
    .unwrap_or_default();

  let command_preview = {
    let mut parts = vec![program.clone()];
    parts.extend(args.iter().cloned());
    parts.join(" ")
  };

  let mut cmd = Command::new(&program);
  cmd
    .args(&args)
    .current_dir(&cwd)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  for (k, v) in &envs {
    cmd.env(k, v);
  }
  // 确保非交互
  cmd.env("CI", "1");
  #[cfg(windows)]
  {
    cmd.creation_flags(CREATE_NO_WINDOW);
  }

  let mut child = cmd
    .spawn()
    .map_err(|e| format!("启动 claude 失败: {e}（program={program}）"))?;

  let stdin = child.stdin.take();
  let stdout = child
    .stdout
    .take()
    .ok_or_else(|| "无法获取 claude stdout".to_string())?;
  let stderr = child
    .stderr
    .take()
    .ok_or_else(|| "无法获取 claude stderr".to_string())?;

  let id = uuid::Uuid::new_v4().to_string();
  let transcript_path = transcripts_dir()?.join(format!("{id}.jsonl"));
  let title = if title_input.trim().is_empty() {
    format!("claude · {permission_mode}")
  } else {
    title_input
  };

  let session = Arc::new(AgentSession {
    id: id.clone(),
    engine: AgentEngine::Claude,
    tool: "claudecode".to_string(),
    title,
    cwd: cwd.to_string_lossy().to_string(),
    model: model.clone(),
    permission_mode: permission_mode.clone(),
    sandbox: String::new(),
    command_preview: command_preview.clone(),
    created_at: chrono::Utc::now().to_rfc3339(),
    claude_session_id: Mutex::new(None),
    codex_session_id: Mutex::new(None),
    seq: Mutex::new(0),
    events: Mutex::new(VecDeque::new()),
    stderr: Mutex::new(VecDeque::new()),
    runtime: Mutex::new(AgentRuntime {
      child,
      stdin,
      running: true,
      exit_code: None,
    }),
    transcript_path,
  });

  {
    let mut map = sessions().lock().map_err(|e| e.to_string())?;
    map.insert(id.clone(), Arc::clone(&session));
  }

  emit_envelope(
    &session,
    "status",
    json!({
      "state": "started",
      "permissionMode": permission_mode,
      "model": model,
      "cwd": session.cwd,
      "command": command_preview,
    }),
  );
  emit_envelope(
    &session,
    "mode",
    json!({
      "permissionMode": permission_mode,
      "source": "create",
    }),
  );

  spawn_reader_threads(Arc::clone(&session), stdout, stderr);

  // 可选：创建后立刻发第一条 prompt
  let initial = get_string(&object, "prompt");
  if !initial.trim().is_empty() {
    let line = build_user_message_line(&initial);
    if let Err(err) = write_stdin_line(&session, &line) {
      emit_envelope(
        &session,
        "status",
        json!({ "state": "error", "message": format!("发送初始 prompt 失败: {err}") }),
      );
    } else {
      emit_envelope(
        &session,
        "timeline.item",
        json!({ "role": "user", "text": initial, "local": true }),
      );
    }
  }

  Ok(json!({
    "ok": true,
    "agentSession": session_info(&session),
  }))
}

/// GET /api/agent/list
pub(crate) fn agent_list(_query: &Value) -> Result<Value, String> {
  let map = sessions().lock().map_err(|e| e.to_string())?;
  let rows: Vec<Value> = map.values().map(|s| session_info(s)).collect();
  Ok(json!({ "ok": true, "rows": rows }))
}

/// GET /api/agent/read?sessionId=&cursor=
pub(crate) fn agent_read(query: &Value) -> Result<Value, String> {
  let object = parse_json_object(query);
  let session_id = get_string(&object, "sessionId");
  if session_id.trim().is_empty() {
    return Err("sessionId 不能为空".to_string());
  }
  let cursor = object
    .get("cursor")
    .and_then(Value::as_u64)
    .unwrap_or(0) as usize;
  let session = get_session(&session_id)?;
  let events = session.events.lock().map_err(|e| e.to_string())?;
  let slice: Vec<Value> = events.iter().skip(cursor).cloned().collect();
  let next_cursor = cursor + slice.len();
  Ok(json!({
    "ok": true,
    "sessionId": session_id,
    "events": slice,
    "cursor": next_cursor,
    "total": events.len(),
    "session": session_info(&session),
  }))
}

/// POST /api/agent/prompt  { sessionId, text }
pub(crate) fn agent_prompt(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let session_id = get_string(&object, "sessionId");
  let text = get_string(&object, "text");
  if session_id.trim().is_empty() {
    return Err("sessionId 不能为空".to_string());
  }
  if text.trim().is_empty() {
    return Err("text 不能为空".to_string());
  }
  let session = get_session(&session_id)?;
  let line = build_user_message_line(&text);
  write_stdin_line(&session, &line)?;
  emit_envelope(
    &session,
    "timeline.item",
    json!({ "role": "user", "text": text, "local": true }),
  );
  Ok(json!({ "ok": true }))
}

/// POST /api/agent/permission  { sessionId, requestId, behavior: allow|deny, message? }
pub(crate) fn agent_permission(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let session_id = get_string(&object, "sessionId");
  let request_id = get_string(&object, "requestId");
  let behavior = get_string(&object, "behavior");
  let message = get_string(&object, "message");
  if session_id.trim().is_empty() {
    return Err("sessionId 不能为空".to_string());
  }
  if request_id.trim().is_empty() {
    return Err("requestId 不能为空".to_string());
  }
  let behavior = match behavior.as_str() {
    "allow" | "deny" => behavior,
    _ => return Err("behavior 必须是 allow 或 deny".to_string()),
  };
  let session = get_session(&session_id)?;
  let line = build_control_response(
    &request_id,
    &behavior,
    if message.is_empty() {
      None
    } else {
      Some(&message)
    },
  );
  write_stdin_line(&session, &line)?;
  emit_envelope(
    &session,
    "permission",
    json!({
      "requestId": request_id,
      "status": behavior,
      "resolved": true,
    }),
  );
  Ok(json!({ "ok": true, "behavior": behavior }))
}

/// POST /api/agent/set-mode  { sessionId, permissionMode }
pub(crate) fn agent_set_mode(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let session_id = get_string(&object, "sessionId");
  let mode = normalize_permission_mode(&get_string(&object, "permissionMode"));
  if session_id.trim().is_empty() {
    return Err("sessionId 不能为空".to_string());
  }
  let session = get_session(&session_id)?;
  let mut extra = Map::new();
  extra.insert("mode".to_string(), json!(mode));
  let line = build_control_request("set_permission_mode", extra);
  match write_stdin_line(&session, &line) {
    Ok(()) => {
      emit_envelope(
        &session,
        "mode",
        json!({
          "permissionMode": mode,
          "source": "set-mode",
          "hot": true,
        }),
      );
      Ok(json!({
        "ok": true,
        "permissionMode": mode,
        "hot": true,
        "note": "已发送 set_permission_mode；若 Claude 未支持热切换，请新建会话",
      }))
    }
    Err(err) => Err(err),
  }
}

/// POST /api/agent/set-model  { sessionId, model }
pub(crate) fn agent_set_model(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let session_id = get_string(&object, "sessionId");
  let model = get_string(&object, "model");
  if session_id.trim().is_empty() {
    return Err("sessionId 不能为空".to_string());
  }
  if model.trim().is_empty() {
    return Err("model 不能为空".to_string());
  }
  let session = get_session(&session_id)?;
  let mut extra = Map::new();
  extra.insert("model".to_string(), json!(model));
  let line = build_control_request("set_model", extra);
  write_stdin_line(&session, &line)?;
  emit_envelope(
    &session,
    "status",
    json!({ "state": "model", "model": model }),
  );
  Ok(json!({ "ok": true, "model": model }))
}

/// POST /api/agent/interrupt  { sessionId }
pub(crate) fn agent_interrupt(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let session_id = get_string(&object, "sessionId");
  if session_id.trim().is_empty() {
    return Err("sessionId 不能为空".to_string());
  }
  let session = get_session(&session_id)?;
  let line = build_control_request("interrupt", Map::new());
  // best-effort control; also try Ctrl-C on stdin for stubborn children
  let _ = write_stdin_line(&session, &line);
  emit_envelope(
    &session,
    "status",
    json!({ "state": "interrupt_requested" }),
  );
  Ok(json!({ "ok": true }))
}

/// POST /api/agent/close  { sessionId, remove? }
pub(crate) fn agent_close(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let session_id = get_string(&object, "sessionId");
  let remove = object
    .get("remove")
    .and_then(Value::as_bool)
    .unwrap_or(true);
  if session_id.trim().is_empty() {
    return Err("sessionId 不能为空".to_string());
  }
  let session = get_session(&session_id)?;
  {
    let mut runtime = session.runtime.lock().map_err(|e| e.to_string())?;
    // drop stdin first
    runtime.stdin = None;
    let _ = runtime.child.kill();
    runtime.running = false;
  }
  emit_envelope(
    &session,
    "status",
    json!({ "state": "closed" }),
  );
  if remove {
    let mut map = sessions().lock().map_err(|e| e.to_string())?;
    map.remove(&session_id);
  }
  Ok(json!({
    "ok": true,
    "removed": remove,
    "session": session_info(&session),
  }))
}

/// GET /api/agent/transcript?sessionId=
pub(crate) fn agent_transcript(query: &Value) -> Result<Value, String> {
  let object = parse_json_object(query);
  let session_id = get_string(&object, "sessionId");
  if session_id.trim().is_empty() {
    return Err("sessionId 不能为空".to_string());
  }
  // 优先内存
  if let Ok(session) = get_session(&session_id) {
    let events: Vec<Value> = session
      .events
      .lock()
      .map(|e| e.iter().cloned().collect())
      .unwrap_or_default();
    return Ok(json!({
      "ok": true,
      "sessionId": session_id,
      "source": "memory",
      "events": events,
      "session": session_info(&session),
      "transcriptPath": session.transcript_path.to_string_lossy(),
    }));
  }
  // 落盘回放
  let path = transcripts_dir()?.join(format!("{session_id}.jsonl"));
  if !path.exists() {
    return Err(format!("找不到 transcript: {session_id}"));
  }
  let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
  let mut events = Vec::new();
  for line in text.lines() {
    if let Ok(v) = serde_json::from_str::<Value>(line) {
      events.push(v);
    }
  }
  Ok(json!({
    "ok": true,
    "sessionId": session_id,
    "source": "disk",
    "events": events,
    "transcriptPath": path.to_string_lossy(),
  }))
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::Mutex as StdMutex;

  // 用假 session 测 parser：不 spawn 进程
  fn fake_session() -> AgentSession {
    // 造一个已退出的 dummy child 很麻烦；测试只走 process_ndjson_line 的纯逻辑
    // 通过 events buffer 断言
    use std::process::Stdio;
    let mut child = Command::new(if cfg!(windows) { "cmd" } else { "true" })
      .args(if cfg!(windows) {
        vec!["/C", "exit", "0"]
      } else {
        vec![]
      })
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .stdin(Stdio::null())
      .spawn()
      .expect("spawn dummy");
    let _ = child.wait();
    let dir = std::env::temp_dir().join("ea-agent-test");
    let _ = std::fs::create_dir_all(&dir);
    let transcript = dir.join(format!("{}.jsonl", uuid::Uuid::new_v4()));
    AgentSession {
      id: "test-session".to_string(),
      engine: AgentEngine::Claude,
      tool: "claudecode".to_string(),
      title: "test".to_string(),
      cwd: ".".to_string(),
      model: String::new(),
      permission_mode: "manual".to_string(),
      sandbox: String::new(),
      command_preview: "claude".to_string(),
      created_at: chrono::Utc::now().to_rfc3339(),
      claude_session_id: Mutex::new(None),
      codex_session_id: Mutex::new(None),
      seq: Mutex::new(0),
      events: Mutex::new(VecDeque::new()),
      stderr: Mutex::new(VecDeque::new()),
      runtime: Mutex::new(AgentRuntime {
        child,
        stdin: None,
        running: false,
        exit_code: Some(0),
      }),
      transcript_path: transcript,
    }
  }

  fn event_types(session: &AgentSession) -> Vec<String> {
    session
      .events
      .lock()
      .unwrap()
      .iter()
      .filter_map(|e| e.get("type").and_then(Value::as_str).map(|s| s.to_string()))
      .collect()
  }

  #[test]
  fn parses_assistant_text_and_tool_use() {
    let session = fake_session();
    let line = r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"hello"},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"src/main.rs"}}]},"session_id":"sess-abc"}"#;
    process_ndjson_line(&session, line);
    let types = event_types(&session);
    assert!(types.contains(&"timeline.item".to_string()));
    assert!(types.contains(&"tool".to_string()));
    let sid = session.claude_session_id.lock().unwrap().clone();
    assert_eq!(sid.as_deref(), Some("sess-abc"));
  }

  #[test]
  fn parses_permission_request() {
    let session = fake_session();
    let line = r#"{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"},"tool_use_id":"tu-1"}}"#;
    process_ndjson_line(&session, line);
    let events = session.events.lock().unwrap();
    let perm = events
      .iter()
      .find(|e| e.get("type").and_then(Value::as_str) == Some("permission"))
      .expect("permission event");
    assert_eq!(
      perm.pointer("/payload/toolName").and_then(Value::as_str),
      Some("Bash")
    );
    assert_eq!(
      perm.pointer("/payload/requestId").and_then(Value::as_str),
      Some("req-1")
    );
  }

  #[test]
  fn parses_result_success() {
    let session = fake_session();
    let line = r#"{"type":"result","subtype":"success","result":"done","duration_ms":12}"#;
    process_ndjson_line(&session, line);
    let types = event_types(&session);
    assert!(types.contains(&"status".to_string()));
  }

  #[test]
  fn normalize_mode_defaults() {
    assert_eq!(normalize_permission_mode("plan"), "plan");
    assert_eq!(normalize_permission_mode("nope"), "manual");
  }

  // silence unused warning in some rustc configs
  #[allow(dead_code)]
  static _LOCK: StdMutex<()> = StdMutex::new(());
}
