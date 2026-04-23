use portable_pty::{
  native_pty_system, Child, CommandBuilder, MasterPty, PtySize,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use crate::{home_dir, parse_json_object};
use crate::provider::get_string;

const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 32;

struct TerminalSession {
  id: String,
  tool: String,
  title: String,
  cwd: String,
  command_preview: String,
  created_at: String,
  output: Mutex<Vec<u8>>,
  runtime: Mutex<TerminalRuntime>,
}

struct TerminalRuntime {
  master: Box<dyn MasterPty + Send>,
  writer: Box<dyn Write + Send>,
  child: Box<dyn Child + Send>,
  running: bool,
  exit_code: Option<i32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalSessionInfo {
  session_id: String,
  tool: String,
  title: String,
  cwd: String,
  command_preview: String,
  created_at: String,
  running: bool,
  exit_code: Option<i32>,
}

type SessionMap = BTreeMap<String, Arc<TerminalSession>>;

fn terminal_sessions() -> &'static Mutex<SessionMap> {
  static SESSIONS: OnceLock<Mutex<SessionMap>> = OnceLock::new();
  SESSIONS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn default_cwd() -> Result<PathBuf, String> {
  home_dir()
}

fn parse_body_path(object: &serde_json::Map<String, Value>, key: &str) -> Result<PathBuf, String> {
  let input = get_string(object, key);
  if input.trim().is_empty() {
    return default_cwd();
  }
  Ok(PathBuf::from(input))
}

fn parse_rows(object: &serde_json::Map<String, Value>, key: &str, fallback: u16) -> u16 {
  object
    .get(key)
    .and_then(Value::as_u64)
    .and_then(|value| u16::try_from(value).ok())
    .filter(|value| *value > 0)
    .unwrap_or(fallback)
}

fn refresh_session_state(session: &Arc<TerminalSession>) {
  let Ok(mut runtime) = session.runtime.lock() else { return; };
  if !runtime.running {
    return;
  }
  match runtime.child.try_wait() {
    Ok(Some(status)) => {
      runtime.running = false;
      runtime.exit_code = i32::try_from(status.exit_code()).ok();
    }
    Ok(None) => {}
    Err(_) => {}
  }
}

fn session_info(session: &Arc<TerminalSession>) -> TerminalSessionInfo {
  refresh_session_state(session);
  let (running, exit_code) = session
    .runtime
    .lock()
    .map(|runtime| (runtime.running, runtime.exit_code))
    .unwrap_or((false, None));
  TerminalSessionInfo {
    session_id: session.id.clone(),
    tool: session.tool.clone(),
    title: session.title.clone(),
    cwd: session.cwd.clone(),
    command_preview: session.command_preview.clone(),
    created_at: session.created_at.clone(),
    running,
    exit_code,
  }
}

fn get_session(session_id: &str) -> Result<Arc<TerminalSession>, String> {
  terminal_sessions()
    .lock()
    .map_err(|error| error.to_string())?
    .get(session_id)
    .cloned()
    .ok_or_else(|| "终端会话不存在".to_string())
}

fn insert_session(session: Arc<TerminalSession>) -> Result<(), String> {
  let mut sessions = terminal_sessions().lock().map_err(|error| error.to_string())?;
  sessions.insert(session.id.clone(), session);
  Ok(())
}

fn remove_session(session_id: &str) -> Result<Option<Arc<TerminalSession>>, String> {
  let mut sessions = terminal_sessions().lock().map_err(|error| error.to_string())?;
  Ok(sessions.remove(session_id))
}

fn read_session_output(session: &Arc<TerminalSession>, cursor: usize) -> Value {
  let output = session.output.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  let safe_cursor = cursor.min(output.len());
  let chunk = String::from_utf8_lossy(&output[safe_cursor..]).to_string();
  json!({
    "session": session_info(session),
    "cursor": output.len(),
    "data": chunk,
  })
}

fn build_command_preview(program: &str, args: &[String]) -> String {
  let mut parts = vec![program.to_string()];
  parts.extend(args.iter().cloned());
  parts.join(" ")
}

pub(crate) fn spawn_embedded_terminal(
  cwd: &Path,
  title: &str,
  tool: &str,
  program: &str,
  args: &[String],
  envs: &[(String, String)],
  rows: u16,
  cols: u16,
  command_preview: Option<String>,
) -> Result<Value, String> {
  let pty_system = native_pty_system();
  let pair = pty_system
    .openpty(PtySize {
      rows: rows.max(1),
      cols: cols.max(1),
      pixel_width: 0,
      pixel_height: 0,
    })
    .map_err(|error| error.to_string())?;

  let mut command = CommandBuilder::new(program);
  command.cwd(cwd);
  command.args(args);
  for (key, value) in envs {
    command.env(key, value);
  }

  let master = pair.master;
  let mut reader = master.try_clone_reader().map_err(|error| error.to_string())?;
  let writer = master.take_writer().map_err(|error| error.to_string())?;
  let child = pair
    .slave
    .spawn_command(command)
    .map_err(|error| error.to_string())?;

  let session = Arc::new(TerminalSession {
    id: uuid::Uuid::new_v4().to_string(),
    tool: tool.to_string(),
    title: title.to_string(),
    cwd: cwd.to_string_lossy().to_string(),
    command_preview: command_preview.unwrap_or_else(|| build_command_preview(program, args)),
    created_at: chrono::Utc::now().to_rfc3339(),
    output: Mutex::new(Vec::new()),
    runtime: Mutex::new(TerminalRuntime {
      master,
      writer,
      child,
      running: true,
      exit_code: None,
    }),
  });

  let session_for_reader = Arc::clone(&session);
  std::thread::spawn(move || {
    let mut chunk = [0_u8; 4096];
    loop {
      match reader.read(&mut chunk) {
        Ok(0) => {
          refresh_session_state(&session_for_reader);
          break;
        }
        Ok(size) => {
          let mut output = session_for_reader
            .output
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
          output.extend_from_slice(&chunk[..size]);
        }
        Err(_) => {
          refresh_session_state(&session_for_reader);
          break;
        }
      }
    }
  });

  insert_session(Arc::clone(&session))?;
  Ok(json!({
    "ok": true,
    "terminalSession": session_info(&session),
  }))
}

pub(crate) fn terminal_create(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let cwd = parse_body_path(&object, "cwd")?;
  let title = get_string(&object, "title");
  let tool = get_string(&object, "tool");
  let program = get_string(&object, "program");
  if program.trim().is_empty() {
    return Err("program 不能为空".to_string());
  }
  let args = object
    .get("args")
    .and_then(Value::as_array)
    .map(|items| {
      items
        .iter()
        .filter_map(Value::as_str)
        .map(|item| item.to_string())
        .collect::<Vec<_>>()
    })
    .unwrap_or_default();
  let envs = object
    .get("env")
    .and_then(Value::as_object)
    .map(|items| {
      items
        .iter()
        .filter_map(|(key, value)| value.as_str().map(|text| (key.clone(), text.to_string())))
        .collect::<Vec<_>>()
    })
    .unwrap_or_default();
  let rows = parse_rows(&object, "rows", DEFAULT_ROWS);
  let cols = parse_rows(&object, "cols", DEFAULT_COLS);
  let preview = object
    .get("commandPreview")
    .and_then(Value::as_str)
    .map(|value| value.to_string());
  spawn_embedded_terminal(
    &cwd,
    if title.trim().is_empty() { &program } else { &title },
    if tool.trim().is_empty() { "shell" } else { &tool },
    &program,
    &args,
    &envs,
    rows,
    cols,
    preview,
  )
}

pub(crate) fn terminal_list(_query: &Value) -> Result<Value, String> {
  let sessions = terminal_sessions().lock().map_err(|error| error.to_string())?;
  let rows = sessions.values().map(session_info).collect::<Vec<_>>();
  Ok(json!({
    "supported": cfg!(target_os = "windows"),
    "rows": rows,
  }))
}

pub(crate) fn terminal_read(query: &Value) -> Result<Value, String> {
  let object = parse_json_object(query);
  let session_id = get_string(&object, "sessionId");
  if session_id.trim().is_empty() {
    return Err("sessionId 不能为空".to_string());
  }
  let cursor = object
    .get("cursor")
    .and_then(Value::as_u64)
    .map(|value| value as usize)
    .unwrap_or(0);
  let session = get_session(&session_id)?;
  Ok(read_session_output(&session, cursor))
}

pub(crate) fn terminal_write(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let session_id = get_string(&object, "sessionId");
  let data = get_string(&object, "data");
  if session_id.trim().is_empty() {
    return Err("sessionId 不能为空".to_string());
  }
  let session = get_session(&session_id)?;
  let mut runtime = session.runtime.lock().map_err(|error| error.to_string())?;
  if !runtime.running {
    return Err("终端会话已结束".to_string());
  }
  runtime
    .writer
    .write_all(data.as_bytes())
    .map_err(|error| error.to_string())?;
  runtime.writer.flush().map_err(|error| error.to_string())?;
  Ok(json!({ "ok": true }))
}

pub(crate) fn terminal_resize(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let session_id = get_string(&object, "sessionId");
  if session_id.trim().is_empty() {
    return Err("sessionId 不能为空".to_string());
  }
  let rows = parse_rows(&object, "rows", DEFAULT_ROWS);
  let cols = parse_rows(&object, "cols", DEFAULT_COLS);
  let session = get_session(&session_id)?;
  let runtime = session.runtime.lock().map_err(|error| error.to_string())?;
  runtime
    .master
    .resize(PtySize {
      rows,
      cols,
      pixel_width: 0,
      pixel_height: 0,
    })
    .map_err(|error| error.to_string())?;
  Ok(json!({ "ok": true, "rows": rows, "cols": cols }))
}

pub(crate) fn terminal_close(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let session_id = get_string(&object, "sessionId");
  let remove = object.get("remove").and_then(Value::as_bool).unwrap_or(false);
  if session_id.trim().is_empty() {
    return Err("sessionId 不能为空".to_string());
  }
  let session = get_session(&session_id)?;
  {
    let mut runtime = session.runtime.lock().map_err(|error| error.to_string())?;
    let _ = runtime.child.kill();
    runtime.running = false;
  }
  if remove {
    let _ = remove_session(&session_id)?;
  }
  Ok(json!({
    "ok": true,
    "removed": remove,
    "session": session_info(&session),
  }))
}
