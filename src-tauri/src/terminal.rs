use portable_pty::{
  native_pty_system, Child, CommandBuilder, MasterPty, PtySize,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

use crate::{home_dir, parse_json_object};
use crate::provider::get_string;

// 全局 app handle，install() 时塞入；reader 线程拿它 emit 数据事件
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
pub(crate) fn install(handle: &AppHandle) {
  let _ = APP_HANDLE.set(handle.clone());
}

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

/// 找出 spawn 之后产生的 codex session jsonl，然后 tail 它解 token_count 事件。
/// codex 启动后会在 ~/.codex/sessions/YYYY/MM/DD/ 新写一个 jsonl，我们等几百毫秒
/// 让它出现，找 mtime > spawn_time 的最新一个，从头读，每读到一个 token_count
/// emit "terminal-tokens" 给前端。
fn watch_codex_session_tokens(
  session: &Arc<TerminalSession>,
  spawn_time: std::time::SystemTime,
  codex_pid: Option<u32>,
) {
  let session_id = session.id.clone();
  let codex_home = match crate::default_codex_home() {
    Ok(p) => p,
    Err(error) => {
      log::warn!("[token-watcher] no codex_home: {error}");
      return;
    }
  };
  let sessions_root = codex_home.join("sessions");
  if !sessions_root.is_dir() {
    log::warn!("[token-watcher] sessions_root not a dir: {sessions_root:?}");
    return;
  }

  // 找 jsonl 的两条路：
  // (1) lsof 问 codex 进程开的 .jsonl —— 最快最准
  // (2) 兜底：在 sessions_root 下扫 mtime 最新的（容忍 60s 时钟偏差）
  let watch_cutoff = spawn_time
    .checked_sub(std::time::Duration::from_secs(60))
    .unwrap_or(spawn_time);
  let deadline = std::time::Instant::now() + std::time::Duration::from_secs(45);
  let mut target: Option<PathBuf> = None;
  while std::time::Instant::now() < deadline {
    // 1. lsof 直查
    if let Some(pid) = codex_pid {
      if let Some(path) = find_codex_jsonl_via_lsof(pid) {
        log::info!("[token-watcher] lsof hit: pid={pid} → {path:?}");
        target = Some(path);
        break;
      }
    }
    // 2. fallback：扫目录
    if let Some(path) = find_latest_codex_jsonl_after(&sessions_root, watch_cutoff) {
      target = Some(path);
      break;
    }
    std::thread::sleep(std::time::Duration::from_millis(500));
  }
  let Some(target) = target else {
    log::warn!("[token-watcher] no jsonl found for session {session_id} after 45s; pid={codex_pid:?} root={sessions_root:?}");
    return;
  };
  log::info!("[token-watcher] tailing {target:?} for session {session_id}");

  // tail 该 jsonl：每 400ms 轮询新行
  let mut cursor: u64 = 0;
  loop {
    // 主进程退出则收线程
    {
      let runtime = session.runtime.lock();
      let still_running = runtime.map(|r| r.running).unwrap_or(false);
      if !still_running { break; }
    }
    if let Ok(meta) = std::fs::metadata(&target) {
      let size = meta.len();
      if size > cursor {
        if let Ok(mut file) = std::fs::File::open(&target) {
          use std::io::{Read, Seek, SeekFrom};
          let _ = file.seek(SeekFrom::Start(cursor));
          let mut buf = Vec::new();
          if file.read_to_end(&mut buf).is_ok() {
            cursor = size;
            for line in buf.split(|b| *b == b'\n') {
              if line.is_empty() { continue; }
              let Ok(text) = std::str::from_utf8(line) else { continue; };
              let Ok(v) = serde_json::from_str::<Value>(text) else { continue; };
              let p = v.get("payload");
              let kind = p.and_then(|p| p.get("type")).and_then(Value::as_str).unwrap_or("");
              if kind != "token_count" { continue; }
              let info = p.and_then(|p| p.get("info"));
              // info 可能是 null（首条 token_count 是空的）；跳过即可
              let Some(info) = info else { continue; };
              if info.is_null() { continue; }
              let total = info.get("total_token_usage");
              if let Some(total) = total {
                if let Some(app) = APP_HANDLE.get() {
                  let context_window = info
                    .get("model_context_window")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                  let payload = json!({
                    "sessionId": session_id,
                    "input": total.get("input_tokens").and_then(Value::as_u64).unwrap_or(0),
                    "cached": total.get("cached_input_tokens").and_then(Value::as_u64).unwrap_or(0),
                    "output": total.get("output_tokens").and_then(Value::as_u64).unwrap_or(0),
                    "reasoning": total.get("reasoning_output_tokens").and_then(Value::as_u64).unwrap_or(0),
                    "total": total.get("total_tokens").and_then(Value::as_u64).unwrap_or(0),
                    "contextWindow": context_window,
                  });
                  log::info!("[token-watcher] emit {payload}");
                  let _ = app.emit("terminal-tokens", payload);
                }
              }
            }
          }
        }
      }
    }
    std::thread::sleep(std::time::Duration::from_millis(500));
  }
}

/// 用 lsof 问 codex 进程（含所有子孙进程）开了哪些 .jsonl 文件。
/// codex 通过 npm 装时 PATH 上的 `codex` 是个 node 脚本 wrapper，会 fork
/// 真正的 codex Rust 子进程，那个子进程才持有 jsonl。所以必须递归扫子树。
fn find_codex_jsonl_via_lsof(pid: u32) -> Option<PathBuf> {
  #[cfg(not(target_os = "windows"))]
  {
    use std::process::Command;
    // 1. 收集 pid + 所有后代 pid
    let mut pids = vec![pid];
    collect_descendant_pids(pid, &mut pids, 0);
    log::info!("[token-watcher] scanning pids: {:?}", pids);
    let mut best: Option<PathBuf> = None;
    for p in pids {
      let out = match Command::new("lsof").args(["-p", &p.to_string(), "-Fn"]).output() {
        Ok(o) if o.status.success() => o,
        _ => continue,
      };
      let text = String::from_utf8_lossy(&out.stdout);
      for line in text.lines() {
        let Some(rest) = line.strip_prefix('n') else { continue; };
        if rest.ends_with(".jsonl") && (rest.contains("/.codex/sessions/") || rest.contains("/sessions/")) {
          let path = PathBuf::from(rest);
          if rest.contains("rollout-") { return Some(path); }
          if best.is_none() { best = Some(path); }
        }
      }
    }
    return best;
  }
  #[cfg(target_os = "windows")]
  {
    let _ = pid;
    None
  }
}

#[cfg(not(target_os = "windows"))]
fn collect_descendant_pids(parent: u32, acc: &mut Vec<u32>, depth: u8) {
  if depth > 6 { return; } // 防御性深度上限
  use std::process::Command;
  let Ok(out) = Command::new("pgrep").args(["-P", &parent.to_string()]).output() else { return; };
  if !out.status.success() { return; }
  let text = String::from_utf8_lossy(&out.stdout);
  for line in text.lines() {
    if let Ok(child) = line.trim().parse::<u32>() {
      if child != parent {
        acc.push(child);
        collect_descendant_pids(child, acc, depth + 1);
      }
    }
  }
}

fn find_latest_codex_jsonl_after(sessions_root: &Path, after: std::time::SystemTime) -> Option<PathBuf> {
  use std::fs;
  let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
  fn walk(dir: &Path, after: std::time::SystemTime, best: &mut Option<(std::time::SystemTime, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else { return; };
    for entry in entries.flatten() {
      let path = entry.path();
      let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
      if meta.is_dir() {
        walk(&path, after, best);
      } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
        if let Ok(mtime) = meta.modified() {
          if mtime > after {
            if best.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
              *best = Some((mtime, path));
            }
          }
        }
      }
    }
  }
  walk(sessions_root, after, &mut best);
  best.map(|(_, p)| p)
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

  // 若是 codex 会话，启动一个 jsonl watcher 抓 token_count 事件
  // 优先用 lsof 拿 codex 进程开的真实 jsonl，避免 mtime 猜错
  if tool.eq_ignore_ascii_case("codex") {
    let session_for_watch = Arc::clone(&session);
    let spawn_time = std::time::SystemTime::now();
    let codex_pid = session.runtime.lock().ok().and_then(|r| r.child.process_id());
    std::thread::spawn(move || watch_codex_session_tokens(&session_for_watch, spawn_time, codex_pid));
  }

  let session_for_reader = Arc::clone(&session);
  std::thread::spawn(move || {
    let mut chunk = [0_u8; 8192];
    loop {
      match reader.read(&mut chunk) {
        Ok(0) => {
          refresh_session_state(&session_for_reader);
          // 通知前端会话结束
          if let Some(app) = APP_HANDLE.get() {
            let _ = app.emit(
              "terminal-exit",
              json!({
                "sessionId": session_for_reader.id,
                "exitCode": session_for_reader.runtime.lock().ok().and_then(|r| r.exit_code),
              }),
            );
          }
          break;
        }
        Ok(size) => {
          let data = &chunk[..size];
          // 1) 落到 output buffer 给 read 接口兜底用
          {
            let mut output = session_for_reader
              .output
              .lock()
              .unwrap_or_else(|poisoned| poisoned.into_inner());
            output.extend_from_slice(data);
          }
          // 2) push 给前端：UTF-8 解码后 emit 一个 "terminal-data" 事件
          if let Some(app) = APP_HANDLE.get() {
            let text = String::from_utf8_lossy(data).to_string();
            let _ = app.emit(
              "terminal-data",
              json!({
                "sessionId": session_for_reader.id,
                "data": text,
              }),
            );
          }
        }
        Err(_) => {
          refresh_session_state(&session_for_reader);
          if let Some(app) = APP_HANDLE.get() {
            let _ = app.emit(
              "terminal-exit",
              json!({ "sessionId": session_for_reader.id, "exitCode": None::<i32> }),
            );
          }
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

/// GET /api/terminal/token-snapshot?sessionId=<our_session_uuid>
/// 给前端 poll 兜底用：根据 sessionId 找到对应 codex pid → lsof 拿 jsonl
/// → 从尾部读最后一条带 info 的 token_count 事件 → 返回真实数字。
/// 完全独立于 watcher 线程，永远可主动调。
pub(crate) fn terminal_token_snapshot(query: &Value) -> Result<Value, String> {
  let object = parse_json_object(query);
  let session_id = get_string(&object, "sessionId");
  if session_id.trim().is_empty() {
    return Err("sessionId 不能为空".to_string());
  }
  let session = get_session(&session_id)?;
  let pid = session.runtime.lock().ok().and_then(|r| r.child.process_id());
  // 1) 优先 lsof
  let mut jsonl: Option<PathBuf> = pid.and_then(find_codex_jsonl_via_lsof);
  // 2) fallback：默认 home 下扫最近一小时
  if jsonl.is_none() {
    if let Ok(codex_home) = crate::default_codex_home() {
      let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
      jsonl = find_latest_codex_jsonl_after(&codex_home.join("sessions"), cutoff);
    }
  }
  let Some(path) = jsonl else {
    return Ok(json!({
      "ok": true,
      "pid": pid,
      "path": null,
      "tokens": null,
      "reason": "no jsonl found via lsof or directory scan",
    }));
  };
  // 读整个文件最后 32KB 找最新带 info 的 token_count
  let token_evt = read_latest_token_count(&path);
  Ok(json!({
    "ok": true,
    "pid": pid,
    "path": path.to_string_lossy(),
    "tokens": token_evt,
  }))
}

fn read_latest_token_count(path: &Path) -> Option<Value> {
  use std::io::{Read, Seek, SeekFrom};
  let mut file = std::fs::File::open(path).ok()?;
  let len = file.metadata().ok()?.len();
  let tail_size = 32 * 1024_u64;
  let start = len.saturating_sub(tail_size);
  file.seek(SeekFrom::Start(start)).ok()?;
  let mut buf = Vec::new();
  file.read_to_end(&mut buf).ok()?;
  let text = String::from_utf8_lossy(&buf);
  // 倒序找最后一条带 info 的 token_count
  let mut last: Option<Value> = None;
  for line in text.lines() {
    let Ok(v) = serde_json::from_str::<Value>(line) else { continue; };
    let p = v.get("payload");
    let kind = p.and_then(|p| p.get("type")).and_then(Value::as_str).unwrap_or("");
    if kind != "token_count" { continue; }
    let info = p.and_then(|p| p.get("info"));
    let Some(info) = info else { continue; };
    if info.is_null() { continue; }
    let Some(total) = info.get("total_token_usage") else { continue; };
    last = Some(json!({
      "input": total.get("input_tokens").and_then(Value::as_u64).unwrap_or(0),
      "cached": total.get("cached_input_tokens").and_then(Value::as_u64).unwrap_or(0),
      "output": total.get("output_tokens").and_then(Value::as_u64).unwrap_or(0),
      "reasoning": total.get("reasoning_output_tokens").and_then(Value::as_u64).unwrap_or(0),
      "total": total.get("total_tokens").and_then(Value::as_u64).unwrap_or(0),
      "contextWindow": info.get("model_context_window").and_then(Value::as_u64).unwrap_or(0),
    }));
  }
  last
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
