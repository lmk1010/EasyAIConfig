use portable_pty::{
  native_pty_system, Child, CommandBuilder, MasterPty, PtySize,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

use crate::{home_dir, parse_json_object};
use crate::provider::get_string;

// 全局 app handle，install() 时塞入；后台线程拿它 emit 事件
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
  /// codex session 的 jsonl 路径，watcher 锁定后写入；之后所有 token 查询直接读它
  jsonl_path: Mutex<Option<PathBuf>>,
}

// 全局已被某个 session 认领的 jsonl 路径集；防多 session 抢同一个文件
static CLAIMED_JSONL: OnceLock<Mutex<std::collections::HashSet<PathBuf>>> = OnceLock::new();
fn claimed_jsonl() -> &'static Mutex<std::collections::HashSet<PathBuf>> {
  CLAIMED_JSONL.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}
fn try_claim_jsonl(path: &Path) -> bool {
  if let Ok(mut set) = claimed_jsonl().lock() {
    set.insert(path.to_path_buf())
  } else { false }
}
fn release_jsonl(path: &Path) {
  if let Ok(mut set) = claimed_jsonl().lock() { set.remove(path); }
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
  let input = sanitize_terminal_text(&get_string(object, key));
  if input.trim().is_empty() {
    return default_cwd();
  }
  Ok(PathBuf::from(input))
}

fn sanitize_terminal_text(value: &str) -> String {
  value.trim_matches('\0').trim().to_string()
}

fn quote_windows_cmd_arg(value: &str) -> String {
  format!("\"{}\"", value.replace('"', "\"\""))
}

fn windows_command_line_tokens(command: &str) -> Vec<String> {
  let mut tokens = Vec::new();
  let mut current = String::new();
  let mut in_quotes = false;
  let mut chars = command.trim_matches('\0').chars().peekable();
  while let Some(ch) = chars.next() {
    match ch {
      '"' => {
        if in_quotes && matches!(chars.peek(), Some('"')) {
          current.push('"');
          let _ = chars.next();
        } else {
          in_quotes = !in_quotes;
        }
      }
      ch if ch.is_whitespace() && !in_quotes => {
        if !current.is_empty() {
          tokens.push(current.clone());
          current.clear();
        }
      }
      _ => current.push(ch),
    }
  }
  if !current.is_empty() {
    tokens.push(current);
  }
  tokens
}

fn windows_terminal_program_candidate_exists(program: &str) -> bool {
  let candidate = sanitize_terminal_text(program);
  if candidate.is_empty() {
    return false;
  }
  let path = Path::new(&candidate);
  path.exists() || windows_npm_shim_candidate(&candidate).is_some() || windows_where(&candidate).is_some()
}

fn split_windows_terminal_program_prefix(command: &str) -> Option<(String, Vec<String>)> {
  let text = sanitize_terminal_text(command);
  let boundaries = text
    .char_indices()
    .filter_map(|(index, ch)| ch.is_whitespace().then_some(index))
    .collect::<Vec<_>>();
  for index in boundaries.into_iter().rev() {
    let program = text[..index].trim();
    let rest = text[index..].trim();
    if program.is_empty() || rest.is_empty() {
      continue;
    }
    if windows_terminal_program_candidate_exists(program) {
      return Some((program.to_string(), windows_command_line_tokens(rest)));
    }
  }
  None
}

fn windows_where(command: &str) -> Option<String> {
  let trimmed = command.trim();
  if trimmed.is_empty() {
    return None;
  }
  let output = Command::new("where.exe").arg(trimmed).output().ok()?;
  if !output.status.success() {
    return None;
  }
  String::from_utf8_lossy(&output.stdout)
    .lines()
    .map(str::trim)
    .find(|line| !line.is_empty())
    .map(|line| line.trim_matches('"').to_string())
}

fn windows_npm_shim_candidate(program: &str) -> Option<String> {
  let path = Path::new(program);
  let parent = path.parent()?;
  let stem = path.file_name()?.to_string_lossy();
  for ext in ["cmd", "bat", "exe", "ps1"] {
    let candidate = parent.join(format!("{}.{}", stem, ext));
    if candidate.exists() {
      return Some(candidate.to_string_lossy().to_string());
    }
  }
  None
}

fn resolve_windows_terminal_command(program: &str, args: &[String]) -> (String, Vec<String>, String) {
  let mut tokens = windows_command_line_tokens(program);
  if tokens.is_empty() {
    tokens.push("cmd.exe".to_string());
  }
  let mut raw_program = sanitize_terminal_text(&tokens.remove(0));
  let mut merged_args = tokens
    .into_iter()
    .map(|item| sanitize_terminal_text(&item))
    .filter(|item| !item.is_empty())
    .collect::<Vec<_>>();
  if merged_args.is_empty() && raw_program.chars().any(char::is_whitespace) {
    if let Some((split_program, split_args)) = split_windows_terminal_program_prefix(&raw_program) {
      raw_program = split_program;
      merged_args = split_args;
    }
  }
  merged_args.extend(args.iter().map(|item| sanitize_terminal_text(item)).filter(|item| !item.is_empty()));

  let mut resolved_program = raw_program.clone();
  let raw_path = Path::new(&raw_program);
  let raw_lower = raw_program.to_ascii_lowercase();
  if !raw_path.exists() && !raw_lower.ends_with(".exe") && !raw_lower.ends_with(".cmd") && !raw_lower.ends_with(".bat") && !raw_lower.ends_with(".ps1") {
    if let Some(found) = windows_where(&raw_program) {
      resolved_program = found;
    }
  }
  let mut lower = resolved_program.to_ascii_lowercase();
  if !lower.ends_with(".exe") && !lower.ends_with(".cmd") && !lower.ends_with(".bat") && !lower.ends_with(".ps1") {
    if let Some(shim) = windows_npm_shim_candidate(&resolved_program) {
      resolved_program = shim;
      lower = resolved_program.to_ascii_lowercase();
    }
  }

  let mut preview_parts = vec![quote_windows_cmd_arg(&resolved_program)];
  preview_parts.extend(merged_args.iter().map(|arg| quote_windows_cmd_arg(arg)));
  let preview = preview_parts.join(" ");

  if lower.ends_with(".ps1") {
    let mut command_args = vec![
      "-NoProfile".to_string(),
      "-NonInteractive".to_string(),
      "-ExecutionPolicy".to_string(),
      "Bypass".to_string(),
      "-File".to_string(),
      resolved_program,
    ];
    command_args.extend(merged_args);
    return ("powershell.exe".to_string(), command_args, preview);
  }

  if lower.ends_with(".cmd") || lower.ends_with(".bat") {
    let mut command_args = vec![
      "/d".to_string(),
      "/c".to_string(),
      "call".to_string(),
      resolved_program,
    ];
    command_args.extend(merged_args);
    return ("cmd.exe".to_string(), command_args, preview);
  }

  if !lower.ends_with(".exe") {
    let mut command_args = vec![
      "/d".to_string(),
      "/c".to_string(),
      resolved_program,
    ];
    command_args.extend(merged_args);
    return ("cmd.exe".to_string(), command_args, preview);
  }

  (resolved_program, merged_args, preview)
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
  _codex_pid: Option<u32>,
) {
  let session_id = session.id.clone();
  let our_cwd = session.cwd.clone();
  let Ok(codex_home) = crate::default_codex_home() else { return; };
  let sessions_root = codex_home.join("sessions");
  if !sessions_root.is_dir() { return; }

  // 锁定阶段：只接受
  //   - spawn_time 之后才 modified 的（mtime 不能早于 spawn_time - 5s）
  //   - 第一行 session_meta.payload.cwd == 我们的 cwd
  //   - 还没有被任何其它 session 认领
  // 然后挑 mtime 最早的（spawn 后第一个出现的就是 codex 刚开的那一份）
  // 找到立即 try_claim_jsonl 原子认领，多 session 不抢同一文件
  let claim_floor = spawn_time
    .checked_sub(std::time::Duration::from_secs(5))
    .unwrap_or(spawn_time);
  let deadline = std::time::Instant::now() + std::time::Duration::from_secs(45);
  let mut target: Option<PathBuf> = None;
  while std::time::Instant::now() < deadline {
    if let Some(path) = find_unclaimed_session_jsonl(&sessions_root, &our_cwd, claim_floor) {
      if try_claim_jsonl(&path) {
        if let Ok(mut slot) = session.jsonl_path.lock() {
          *slot = Some(path.clone());
        }
        target = Some(path);
        break;
      }
    }
    std::thread::sleep(std::time::Duration::from_millis(300));
  }
  let Some(target) = target else { return; };

  // tail 阶段：200ms 监视这一份独占文件，size 增加才读，模拟"事件触发"
  // codex 每次完成一轮 HTTP 请求才 append token_count，所以 size 变化 = HTTP 事件
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
                  // 从 jsonl 文件名 rollout-2026-06-25T...-019efcda-63cd-7ba1-8ef1-fe9a79c872f6.jsonl
                  // 提取 codex session id（最后一段 UUID）；resume 用
                  let codex_session_id = target
                    .file_stem().and_then(|s| s.to_str())
                    .map(|stem| {
                      // 取最后一段 UUID（5 段 split-/，4 中线分隔的 36 char）
                      // 文件名形如 rollout-<ts>-<uuid>，UUID 在最后
                      let parts: Vec<&str> = stem.split('-').collect();
                      if parts.len() >= 5 {
                        let tail = parts[parts.len()-5..].join("-");
                        if tail.len() == 36 { return tail; }
                      }
                      String::new()
                    })
                    .unwrap_or_default();
                  let payload = json!({
                    "sessionId": session_id,
                    "codexSessionId": codex_session_id,
                    "input": total.get("input_tokens").and_then(Value::as_u64).unwrap_or(0),
                    "cached": total.get("cached_input_tokens").and_then(Value::as_u64).unwrap_or(0),
                    "output": total.get("output_tokens").and_then(Value::as_u64).unwrap_or(0),
                    "reasoning": total.get("reasoning_output_tokens").and_then(Value::as_u64).unwrap_or(0),
                    "total": total.get("total_tokens").and_then(Value::as_u64).unwrap_or(0),
                    "contextWindow": context_window,
                  });
                  let _ = app.emit("terminal-tokens", payload);
                }
              }
            }
          }
        }
      }
    }
    std::thread::sleep(std::time::Duration::from_millis(200));
  }
  release_jsonl(&target);
}

/// 找一份"未被任何 session 认领、cwd 完全匹配、spawn 之后 modified"的 codex jsonl。
/// 取 mtime 最早的一份（spawn 出来的第一个就是 codex 刚开的那个）。
fn find_unclaimed_session_jsonl(
  sessions_root: &Path,
  target_cwd: &str,
  claim_floor: std::time::SystemTime,
) -> Option<PathBuf> {
  use std::fs;
  use std::io::{BufRead, BufReader};
  if target_cwd.trim().is_empty() { return None; }
  let claimed = claimed_jsonl().lock().ok()?.clone();
  let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
  fn walk(
    dir: &Path,
    target_cwd: &str,
    floor: std::time::SystemTime,
    claimed: &std::collections::HashSet<PathBuf>,
    best: &mut Option<(std::time::SystemTime, PathBuf)>,
  ) {
    let Ok(entries) = fs::read_dir(dir) else { return; };
    for entry in entries.flatten() {
      let path = entry.path();
      let Ok(meta) = entry.metadata() else { continue; };
      if meta.is_dir() {
        walk(&path, target_cwd, floor, claimed, best);
      } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
        if claimed.contains(&path) { continue; }
        let Ok(mtime) = meta.modified() else { continue; };
        if mtime < floor { continue; }
        let Ok(file) = std::fs::File::open(&path) else { continue; };
        let mut reader = BufReader::new(file);
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() { continue; }
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue; };
        let cwd = v.get("payload").and_then(|p| p.get("cwd")).and_then(Value::as_str).unwrap_or("");
        if cwd != target_cwd { continue; }
        if best.as_ref().map(|(t, _)| mtime < *t).unwrap_or(true) {
          *best = Some((mtime, path));
        }
      }
    }
  }
  walk(sessions_root, target_cwd, claim_floor, &claimed, &mut best);
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
    jsonl_path: Mutex::new(None),
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
  if session_id.trim().is_empty() { return Err("sessionId 不能为空".to_string()); }
  let session = get_session(&session_id)?;
  // 只允许读 watcher 给本 session 锁定的 jsonl — 杜绝跨 session 抢数据
  let path = match session.jsonl_path.lock().ok().and_then(|p| p.clone()) {
    Some(p) => p,
    None => {
      return Ok(json!({
        "ok": true,
        "path": null,
        "tokens": null,
        "reason": "watcher 还在认领 jsonl",
      }));
    }
  };
  let token_evt = read_latest_token_count(&path);
  Ok(json!({
    "ok": true,
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
  let program = sanitize_terminal_text(&get_string(&object, "program"));
  if program.trim().is_empty() {
    return Err("program 不能为空".to_string());
  }
  let mut args = object
    .get("args")
    .and_then(Value::as_array)
    .map(|items| {
      items
        .iter()
        .filter_map(Value::as_str)
        .map(sanitize_terminal_text)
        .filter(|item| !item.is_empty())
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
  let (program, resolved_preview) = if cfg!(target_os = "windows") {
    let (resolved_program, resolved_args, resolved_preview) = resolve_windows_terminal_command(&program, &args);
    args = resolved_args;
    (resolved_program, Some(resolved_preview))
  } else {
    (program, None)
  };
  spawn_embedded_terminal(
    &cwd,
    if title.trim().is_empty() { &program } else { &title },
    if tool.trim().is_empty() { "shell" } else { &tool },
    &program,
    &args,
    &envs,
    rows,
    cols,
    preview.or(resolved_preview),
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
