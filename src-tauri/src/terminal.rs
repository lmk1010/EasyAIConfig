use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{Read, Write};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

use crate::provider::get_string;
use crate::{app_home, ensure_dir, home_dir, parse_json_object};

// 全局 app handle，install() 时塞入；后台线程拿它 emit 事件
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
pub(crate) fn install(handle: &AppHandle) {
    let _ = APP_HANDLE.set(handle.clone());
}

const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 32;
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

struct TerminalSession {
    id: String,
    tool: String,
    title: String,
    cwd: String,
    command_preview: String,
    created_at: String,
    /// 谁创建的：phone(手机远程) / desktop(桌面本机)
    origin: String,
    /// 该会话的 CODEX_HOME(多账号时指向 profile 目录)；决定 jsonl 写到哪
    codex_home: Option<PathBuf>,
    /// tmux 会话名(常驻持久化)：进程跑在 tmux 里，PTY 只是附着的客户端，
    /// App/PTY 断了 tmux 里的 codex 还活着，重开直接 reattach。None 表示未用 tmux。
    tmux_name: Option<String>,
    /// 界面模式：terminal（完整 TUI，可常驻 tmux）| tmux（手机↔电脑镜像 attach）。
    /// 注意：不能用「有没有 tmux_name」推断——终端模式也会包进 tmux 做持久化。
    view_mode: String,
    /// PTY 尺寸(渲染 codex TUI picker 时按此还原屏幕)
    term_size: Mutex<(u16, u16)>,
    /// 最近一次被远程(手机)请求的时间戳(ms)；用于「手机在看」标识
    last_remote_ms: Mutex<i64>,
    /// 会话展示名：取会话第一句用户消息，解析后缓存
    display_title: Mutex<Option<String>>,
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
    } else {
        false
    }
}
fn release_jsonl(path: &Path) {
    if let Ok(mut set) = claimed_jsonl().lock() {
        set.remove(path);
    }
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
    display_name: String,
    cwd: String,
    command_preview: String,
    created_at: String,
    running: bool,
    exit_code: Option<i32>,
    origin: String,
    remote_active: bool,
    /// 是否常驻(跑在 tmux 里，App 重启进程仍存活)
    persistent: bool,
    /// bridge | terminal | tmux
    #[serde(skip_serializing_if = "Option::is_none")]
    view_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auth_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auth_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_name: Option<String>,
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

/// 返回 bytes 里最长的合法 UTF-8 前缀长度。用于终端推流在字符边界切分，
/// 跨 8KB read 边界的不完整多字节序列（中文/emoji）留到下一次拼接后再吐，
/// 避免 from_utf8_lossy 把半个字符替换成 �。
pub(crate) fn utf8_valid_prefix_len(bytes: &[u8]) -> usize {
    match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(error) => error.valid_up_to(),
    }
}

/// 从 PTY 字节流提取 OSC 标题（`ESC ] Ps ; Pt BEL` / `ESC ] Ps ; Pt ESC \\`）。
fn extract_osc_titles(bytes: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 3 < bytes.len() {
        if bytes[i] == 0x1b && bytes[i + 1] == b']' {
            let mut j = i + 2;
            while j < bytes.len() && bytes[j] != b';' {
                // Ps 通常很短
                if j > i + 8 {
                    break;
                }
                j += 1;
            }
            if j >= bytes.len() || bytes[j] != b';' {
                i += 1;
                continue;
            }
            j += 1;
            let start = j;
            let mut end = None;
            while j < bytes.len() {
                if bytes[j] == 0x07 {
                    end = Some(j);
                    break;
                }
                if bytes[j] == 0x1b && j + 1 < bytes.len() && bytes[j + 1] == b'\\' {
                    end = Some(j);
                    break;
                }
                // 标题过长则放弃本段
                if j - start > 256 {
                    break;
                }
                j += 1;
            }
            if let Some(e) = end {
                if let Ok(s) = std::str::from_utf8(&bytes[start..e]) {
                    let t = s.trim();
                    if !t.is_empty() {
                        out.push(t.to_string());
                    }
                }
                i = if bytes[e] == 0x1b { e + 2 } else { e + 1 };
                continue;
            }
        }
        i += 1;
    }
    out
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
    path.exists()
        || windows_npm_shim_candidate(&candidate).is_some()
        || windows_where(&candidate).is_some()
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
    let output = process_command("where.exe").arg(trimmed).output().ok()?;
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

fn resolve_windows_terminal_command(
    program: &str,
    args: &[String],
) -> (String, Vec<String>, String) {
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
        if let Some((split_program, split_args)) =
            split_windows_terminal_program_prefix(&raw_program)
        {
            raw_program = split_program;
            merged_args = split_args;
        }
    }
    merged_args.extend(
        args.iter()
            .map(|item| sanitize_terminal_text(item))
            .filter(|item| !item.is_empty()),
    );

    let mut resolved_program = raw_program.clone();
    let raw_path = Path::new(&raw_program);
    let raw_lower = raw_program.to_ascii_lowercase();
    if !raw_path.exists()
        && !raw_lower.ends_with(".exe")
        && !raw_lower.ends_with(".cmd")
        && !raw_lower.ends_with(".bat")
        && !raw_lower.ends_with(".ps1")
    {
        if let Some(found) = windows_where(&raw_program) {
            resolved_program = found;
        }
    }
    let mut lower = resolved_program.to_ascii_lowercase();
    if !lower.ends_with(".exe")
        && !lower.ends_with(".cmd")
        && !lower.ends_with(".bat")
        && !lower.ends_with(".ps1")
    {
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
        let mut command_args = vec!["/d".to_string(), "/c".to_string(), resolved_program];
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
    let Ok(mut runtime) = session.runtime.lock() else {
        return;
    };
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
    let now = chrono::Utc::now().timestamp_millis();
    let remote_active = session
        .last_remote_ms
        .lock()
        .map(|v| now - *v < 15_000 && *v > 0)
        .unwrap_or(false);
    let view_mode = Some(if session.view_mode == "tmux" {
        "tmux".to_string()
    } else {
        "terminal".to_string()
    });
    let mut model = None;
    let mut effort = None;
    let mut auth_mode = None;
    let mut auth_label = None;
    let mut provider = None;
    let mut provider_name = None;
    if session.tool.eq_ignore_ascii_case("codex") {
        let home = session
            .codex_home
            .clone()
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".codex"));
        let ctx = codex_account_context(&home);
        model = ctx
            .get("model")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        effort = ctx
            .get("effort")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        auth_mode = ctx
            .get("authMode")
            .and_then(Value::as_str)
            .map(|s| s.to_string());
        auth_label = ctx
            .get("authLabel")
            .and_then(Value::as_str)
            .map(|s| s.to_string());
        provider = ctx
            .get("provider")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        provider_name = ctx
            .get("providerName")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
    }
    TerminalSessionInfo {
        session_id: session.id.clone(),
        tool: session.tool.clone(),
        title: session.title.clone(),
        display_name: session_display_name(session),
        cwd: session.cwd.clone(),
        command_preview: session.command_preview.clone(),
        created_at: session.created_at.clone(),
        running,
        exit_code,
        origin: session.origin.clone(),
        remote_active,
        persistent: session.tmux_name.is_some(),
        view_mode,
        model,
        effort,
        auth_mode,
        auth_label,
        provider,
        provider_name,
    }
}

/// 会话展示名：优先「第一句用户消息」(codex 从 jsonl 解析并缓存)，否则回退到 title。
fn session_display_name(session: &Arc<TerminalSession>) -> String {
    if let Ok(cached) = session.display_title.lock() {
        if let Some(name) = cached.as_ref() {
            if !name.trim().is_empty() {
                return name.clone();
            }
        }
    }
    // 尝试从已认领的 codex jsonl 里取第一条 user_message
    let path = session.jsonl_path.lock().ok().and_then(|p| p.clone());
    if let Some(path) = path {
        if let Some(first) = codex_first_user_message(&path) {
            let name = first.chars().take(40).collect::<String>();
            if let Ok(mut slot) = session.display_title.lock() {
                *slot = Some(name.clone());
            }
            return name;
        }
    }
    if !session.title.trim().is_empty() {
        session.title.clone()
    } else {
        session.id.chars().take(8).collect()
    }
}

/// 读 codex jsonl 的第一条真实用户消息（跳过环境上下文等脚手架）。
fn codex_first_user_message(path: &Path) -> Option<String> {
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let event_type = v.get("type").and_then(Value::as_str).unwrap_or("");
        let payload = v.get("payload");
        let payload_type = payload
            .and_then(|p| p.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if event_type == "event_msg" && payload_type == "user_message" {
            let msg = payload
                .and_then(|p| p.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if !msg.is_empty() && !is_codex_scaffolding(&msg) {
                return Some(msg.replace('\n', " "));
            }
        }
    }
    None
}

/// 标记某会话最近被远程(手机)访问过——用于「手机在看」标识。
pub(crate) fn mark_remote_activity(session_id: &str) {
    if let Ok(sessions) = terminal_sessions().lock() {
        if let Some(s) = sessions.get(session_id) {
            if let Ok(mut v) = s.last_remote_ms.lock() {
                *v = chrono::Utc::now().timestamp_millis();
            }
        }
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
    let mut sessions = terminal_sessions()
        .lock()
        .map_err(|error| error.to_string())?;
    sessions.insert(session.id.clone(), session);
    Ok(())
}

fn remove_session(session_id: &str) -> Result<Option<Arc<TerminalSession>>, String> {
    let mut sessions = terminal_sessions()
        .lock()
        .map_err(|error| error.to_string())?;
    Ok(sessions.remove(session_id))
}

fn read_session_output(session: &Arc<TerminalSession>, cursor: usize) -> Value {
    let output = session
        .output
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let safe_cursor = cursor.min(output.len());
    let chunk = String::from_utf8_lossy(&output[safe_cursor..]).to_string();
    json!({
      "session": session_info(session),
      "cursor": output.len(),
      "data": chunk,
    })
}

/// SSE 实时推流用：从 output 缓冲的 cursor 处取增量「原始字节」（不做 UTF-8 解码，
/// 由调用方按字符边界切分），连同最新总长度 new_len 与运行状态一起返回。
/// 返回 (raw_new_bytes, new_len, running, exit_code)；会话不存在返回 None。
pub(crate) fn read_output_from(
    session_id: &str,
    cursor: usize,
) -> Option<(Vec<u8>, usize, bool, Option<i32>)> {
    let session = get_session(session_id).ok()?;
    refresh_session_state(&session);
    let (bytes, new_len) = {
        let output = session
            .output
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let len = output.len();
        (output[cursor.min(len)..].to_vec(), len)
    };
    let (running, exit_code) = session
        .runtime
        .lock()
        .map(|runtime| (runtime.running, runtime.exit_code))
        .unwrap_or((false, None));
    Some((bytes, new_len, running, exit_code))
}

fn build_command_preview(program: &str, args: &[String]) -> String {
    let mut parts = vec![program.to_string()];
    parts.extend(args.iter().cloned());
    parts.join(" ")
}

/// 该会话 codex rollout jsonl 的根目录。
/// 关键：多账号时会话带 CODEX_HOME→profile 目录，codex 会把 jsonl 写到
/// $CODEX_HOME/sessions 而非 ~/.codex/sessions。必须按会话的 CODEX_HOME 找，
/// 否则切了账号的会话永远认领不到 jsonl(timeline 空、无 token、名称不更新)。
fn session_sessions_root(session: &Arc<TerminalSession>) -> PathBuf {
    if let Some(home) = session.codex_home.as_ref() {
        if !home.as_os_str().is_empty() {
            return home.join("sessions");
        }
    }
    crate::default_codex_home()
        .map(|h| h.join("sessions"))
        .unwrap_or_else(|_| PathBuf::from("/nonexistent"))
}

/// 找出 spawn 之后产生的 codex session jsonl，然后 tail 它解 token_count 事件。
/// codex 启动后会在 <codex_home>/sessions/YYYY/MM/DD/ 新写一个 jsonl，我们等几百毫秒
/// 让它出现，找 mtime > spawn_time 的最新一个，从头读，每读到一个 token_count
/// emit "terminal-tokens" 给前端。
fn watch_codex_session_tokens(
    session: &Arc<TerminalSession>,
    spawn_time: std::time::SystemTime,
    _codex_pid: Option<u32>,
) {
    let session_id = session.id.clone();
    let our_cwd = session.cwd.clone();
    let sessions_root = session_sessions_root(session);
    // 目录可能在首条消息后才出现(codex 首次写 rollout 时创建)，所以循环里再等它出现。

    // 锁定阶段：只接受
    //   - spawn_time 之后才 modified 的（mtime 不能早于 spawn_time - 5s）
    //   - 第一行 session_meta.payload.cwd == 我们的 cwd
    //   - 还没有被任何其它 session 认领
    // 然后挑 mtime 最早的（spawn 后第一个出现的就是 codex 刚开的那一份）
    // 找到立即 try_claim_jsonl 原子认领，多 session 不抢同一文件
    let claim_floor = spawn_time
        .checked_sub(std::time::Duration::from_secs(5))
        .unwrap_or(spawn_time);
    // 不再用 45s 硬超时：codex 往往要等用户发出第一条消息后才写 rollout jsonl，
    // 那可能远晚于 spawn。只要会话还活着就持续尝试认领，直到进程退出。
    let mut target: Option<PathBuf> = None;
    loop {
        // 会话已结束就不必再找
        let still_running = session
            .runtime
            .lock()
            .map(|r| r.running)
            .unwrap_or(false);
        if !still_running {
            break;
        }
        if let Some(path) = find_unclaimed_session_jsonl(&sessions_root, &our_cwd, claim_floor) {
            if try_claim_jsonl(&path) {
                if let Ok(mut slot) = session.jsonl_path.lock() {
                    *slot = Some(path.clone());
                }
                target = Some(path);
                break;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    let Some(target) = target else {
        return;
    };

    // tail 阶段：200ms 监视这一份独占文件，size 增加才读，模拟"事件触发"
    // codex 每次完成一轮 HTTP 请求才 append token_count，所以 size 变化 = HTTP 事件
    let mut cursor: u64 = 0;
    loop {
        // 主进程退出则收线程
        {
            let runtime = session.runtime.lock();
            let still_running = runtime.map(|r| r.running).unwrap_or(false);
            if !still_running {
                break;
            }
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
                            if line.is_empty() {
                                continue;
                            }
                            let Ok(text) = std::str::from_utf8(line) else {
                                continue;
                            };
                            let Ok(v) = serde_json::from_str::<Value>(text) else {
                                continue;
                            };
                            let p = v.get("payload");
                            let kind = p
                                .and_then(|p| p.get("type"))
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            if kind != "token_count" {
                                continue;
                            }
                            let info = p.and_then(|p| p.get("info"));
                            // info 可能是 null（首条 token_count 是空的）；跳过即可
                            let Some(info) = info else {
                                continue;
                            };
                            if info.is_null() {
                                continue;
                            }
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
                                        .file_stem()
                                        .and_then(|s| s.to_str())
                                        .map(|stem| {
                                            // 取最后一段 UUID（5 段 split-/，4 中线分隔的 36 char）
                                            // 文件名形如 rollout-<ts>-<uuid>，UUID 在最后
                                            let parts: Vec<&str> = stem.split('-').collect();
                                            if parts.len() >= 5 {
                                                let tail = parts[parts.len() - 5..].join("-");
                                                if tail.len() == 36 {
                                                    return tail;
                                                }
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
    if target_cwd.trim().is_empty() {
        return None;
    }
    let claimed = claimed_jsonl().lock().ok()?.clone();
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    fn walk(
        dir: &Path,
        target_cwd: &str,
        floor: std::time::SystemTime,
        claimed: &std::collections::HashSet<PathBuf>,
        best: &mut Option<(std::time::SystemTime, PathBuf)>,
    ) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                walk(&path, target_cwd, floor, claimed, best);
            } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                if claimed.contains(&path) {
                    continue;
                }
                let Ok(mtime) = meta.modified() else {
                    continue;
                };
                if mtime < floor {
                    continue;
                }
                let Ok(file) = std::fs::File::open(&path) else {
                    continue;
                };
                let mut reader = BufReader::new(file);
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
                    continue;
                };
                let cwd = v
                    .get("payload")
                    .and_then(|p| p.get("cwd"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if cwd != target_cwd {
                    continue;
                }
                if best.as_ref().map(|(t, _)| mtime < *t).unwrap_or(true) {
                    *best = Some((mtime, path));
                }
            }
        }
    }
    walk(sessions_root, target_cwd, claim_floor, &claimed, &mut best);
    best.map(|(_, p)| p)
}

// ─── tmux 常驻持久化 ──────────────────────────────────────────
/// tmux 可执行路径(GUI App 的 PATH 常不含 brew 目录，需显式找)。
fn tmux_bin() -> Option<String> {
    if let Ok(p) = which::which("tmux") {
        return Some(p.to_string_lossy().to_string());
    }
    for p in [
        "/opt/homebrew/bin/tmux",
        "/usr/local/bin/tmux",
        "/usr/bin/tmux",
    ] {
        if Path::new(p).exists() {
            return Some(p.to_string());
        }
    }
    None
}

/// 从 `tmux … -t name` / `attach-session -t name` 参数里取出目标会话名。
fn extract_tmux_target_name(args: &[String]) -> Option<String> {
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "-t" || a == "-s" {
            if let Some(name) = args.get(i + 1) {
                let name = name.trim();
                if !name.is_empty() {
                    return Some(name.to_string());
                }
            }
        } else if let Some(rest) = a.strip_prefix("-t") {
            let name = rest.trim();
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
        i += 1;
    }
    None
}

fn eac_home() -> PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".codex-config-ui"))
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

/// 干净的 tmux 配置：关状态栏/鼠标、Esc 零延迟、会话保活。
pub(crate) fn tmux_config_path() -> String {
    let dir = eac_home();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("tmux.conf");
    let cfg = "set -g status off\n\
               set -g mouse off\n\
               set -sg escape-time 0\n\
               set -g assume-paste-time 0\n\
               set -g history-limit 50000\n\
               set -g default-terminal \"xterm-256color\"\n\
               set -g destroy-unattached off\n\
               setw -g aggressive-resize on\n";
    // 总是刷新一次，保证配置最新
    let _ = std::fs::write(&path, cfg);
    path.to_string_lossy().to_string()
}

fn shell_quote(s: &str) -> String {
    if s.is_empty() {
        return "''".to_string();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 把 codex/claude 命令包进 tmux：`tmux -f cfg new-session -A -s NAME -x C -y R "env ... prog args"`。
/// -A：会话已存在则直接 reattach(进程还活着)，否则新建并运行命令。
fn build_tmux_command(
    tmux: &str,
    program: &str,
    args: &[String],
    envs: &[(String, String)],
    tmux_name: &str,
    cols: u16,
    rows: u16,
) -> (String, Vec<String>) {
    let mut inner = vec!["env".to_string()];
    for (k, v) in envs {
        if v.is_empty() {
            continue;
        }
        inner.push(format!("{}={}", k, shell_quote(v)));
    }
    inner.push(shell_quote(program));
    for a in args {
        inner.push(shell_quote(a));
    }
    let shell_cmd = inner.join(" ");
    let tmux_args = vec![
        "-f".to_string(),
        tmux_config_path(),
        "new-session".to_string(),
        "-A".to_string(),
        "-s".to_string(),
        tmux_name.to_string(),
        "-x".to_string(),
        cols.max(1).to_string(),
        "-y".to_string(),
        rows.max(1).to_string(),
        shell_cmd,
    ];
    (tmux.to_string(), tmux_args)
}

/// tmux 会话元数据(重启后据此把常驻会话恢复成可重连列表)。
fn tmux_meta_path() -> PathBuf {
    eac_home().join("tmux-sessions.json")
}
fn load_tmux_meta() -> Value {
    std::fs::read_to_string(tmux_meta_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .unwrap_or_else(|| json!({}))
}
fn save_tmux_meta(name: &str, meta: Value) {
    let mut all = load_tmux_meta();
    if let Some(obj) = all.as_object_mut() {
        obj.insert(name.to_string(), meta);
    }
    let dir = eac_home();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(tmux_meta_path(), serde_json::to_string_pretty(&all).unwrap_or_default());
}
fn remove_tmux_meta(name: &str) {
    let mut all = load_tmux_meta();
    if let Some(obj) = all.as_object_mut() {
        obj.remove(name);
    }
    let _ = std::fs::write(tmux_meta_path(), serde_json::to_string_pretty(&all).unwrap_or_default());
}
/// tmux 会话是否还活着。
fn tmux_has_session(tmux: &str, name: &str) -> bool {
    std::process::Command::new(tmux)
        .args(["has-session", "-t", name])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 探测系统代理：优先已有环境变量，其次 macOS 系统代理设置(scutil)。
/// 返回形如 http://127.0.0.1:7890 的代理地址，供 codex/claude 会话直连翻墙。
pub(crate) fn detect_system_proxy() -> Option<String> {
    for key in [
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ] {
        if let Ok(value) = std::env::var(key) {
            let value = value.trim().to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("scutil")
            .arg("--proxy")
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        let get = |key: &str| -> Option<String> {
            text.lines().find_map(|line| {
                let line = line.trim();
                line.strip_prefix(&format!("{key} : "))
                    .map(|s| s.trim().to_string())
            })
        };
        // 优先 HTTPS，其次 HTTP，最后 SOCKS
        if get("HTTPSEnable").as_deref() == Some("1") {
            if let (Some(host), Some(port)) = (get("HTTPSProxy"), get("HTTPSPort")) {
                return Some(format!("http://{host}:{port}"));
            }
        }
        if get("HTTPEnable").as_deref() == Some("1") {
            if let (Some(host), Some(port)) = (get("HTTPProxy"), get("HTTPPort")) {
                return Some(format!("http://{host}:{port}"));
            }
        }
        if get("SOCKSEnable").as_deref() == Some("1") {
            if let (Some(host), Some(port)) = (get("SOCKSProxy"), get("SOCKSPort")) {
                return Some(format!("socks5://{host}:{port}"));
            }
        }
    }
    None
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
    spawn_embedded_terminal_with_origin(
        cwd,
        title,
        tool,
        program,
        args,
        envs,
        rows,
        cols,
        command_preview,
        "desktop",
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_embedded_terminal_with_origin(
    cwd: &Path,
    title: &str,
    tool: &str,
    program: &str,
    args: &[String],
    envs: &[(String, String)],
    rows: u16,
    cols: u16,
    command_preview: Option<String>,
    origin: &str,
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

    // 代理适配：codex/claude 官方账号直连 OpenAI/Anthropic 常被墙(tls handshake eof)，
    // 自动带上系统代理让其走代理，稳定可用。用户已显式传代理则尊重之。
    let mut effective_envs: Vec<(String, String)> = envs.to_vec();
    // 远程 / 无 shell 的 PTY 经常不带 TERM；tmux/TUI 会报
    // "open terminal failed: terminal does not support clear"
    if !effective_envs
        .iter()
        .any(|(k, _)| k.eq_ignore_ascii_case("TERM"))
    {
        effective_envs.push(("TERM".to_string(), "xterm-256color".to_string()));
    }
    if !effective_envs
        .iter()
        .any(|(k, _)| k.eq_ignore_ascii_case("COLORTERM"))
    {
        effective_envs.push(("COLORTERM".to_string(), "truecolor".to_string()));
    }
    let is_ai_tool =
        tool.eq_ignore_ascii_case("codex") || tool.eq_ignore_ascii_case("claudecode");
    let has_proxy = effective_envs.iter().any(|(k, _)| {
        let k = k.to_ascii_lowercase();
        k == "https_proxy" || k == "http_proxy" || k == "all_proxy"
    });
    if is_ai_tool && !has_proxy {
        if let Some(proxy) = detect_system_proxy() {
            for key in ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"] {
                effective_envs.push((key.to_string(), proxy.clone()));
            }
            if !effective_envs
                .iter()
                .any(|(k, _)| k.eq_ignore_ascii_case("NO_PROXY"))
            {
                effective_envs.push((
                    "NO_PROXY".to_string(),
                    "localhost,127.0.0.1,::1".to_string(),
                ));
            }
        }
    }

    // tmux 常驻：仅当「真正启动 codex/claude」时包进 tmux。
    // 镜像模式 program 本身已是 tmux attach，再包一层会导致：
    // 内层 attach 失败 → pane 退出 → 外层 session 销毁 → 手机立刻「已退出」。
    let session_id = uuid::Uuid::new_v4().to_string();
    let tmux = tmux_bin();
    let program_is_tmux = Path::new(program)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| {
            let s = s.to_ascii_lowercase();
            s == "tmux" || s.starts_with("tmux.")
        })
        .unwrap_or(false);
    let use_tmux = is_ai_tool && tmux.is_some() && !program_is_tmux;
    let mirror_target = if program_is_tmux {
        extract_tmux_target_name(args)
    } else {
        None
    };
    let tmux_name = if use_tmux {
        Some(format!("eac-{}", &session_id[..8]))
    } else {
        mirror_target.clone()
    };
    // 镜像 = program 本身是 tmux attach；终端模式即便包进 tmux 也仍是 terminal
    let view_mode = if program_is_tmux {
        "tmux".to_string()
    } else {
        "terminal".to_string()
    };
    let (real_program, real_args) = if let (Some(tmux), Some(name)) = (&tmux, &tmux_name) {
        if use_tmux {
            // 记录元数据，重启后可把常驻会话恢复成「可重连」
            save_tmux_meta(
                name,
                json!({
                    "tool": tool,
                    "title": title,
                    "cwd": cwd.to_string_lossy(),
                    "program": program,
                    "args": args,
                    "codexHome": effective_envs.iter().find(|(k,_)| k=="CODEX_HOME").map(|(_,v)| v.clone()).unwrap_or_default(),
                    "commandPreview": command_preview.clone().unwrap_or_else(|| build_command_preview(program, args)),
                    "createdAt": chrono::Utc::now().to_rfc3339(),
                }),
            );
            build_tmux_command(tmux, program, args, &effective_envs, name, cols, rows)
        } else {
            (program.to_string(), args.to_vec())
        }
    } else {
        (program.to_string(), args.to_vec())
    };

    let mut command = CommandBuilder::new(&real_program);
    command.cwd(cwd);
    command.args(&real_args);
    // tmux 客户端本身也带上 env(首次启动 server 时继承；codex 的 env 已内嵌到命令里)
    for (key, value) in &effective_envs {
        if value.is_empty() {
            command.env_remove(key);
        } else {
            command.env(key, value);
        }
    }

    let master = pair.master;
    let reader = master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let writer = master.take_writer().map_err(|error| error.to_string())?;
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;

    let session = Arc::new(TerminalSession {
        id: session_id,
        tool: tool.to_string(),
        title: title.to_string(),
        cwd: cwd.to_string_lossy().to_string(),
        command_preview: command_preview.unwrap_or_else(|| build_command_preview(program, args)),
        created_at: chrono::Utc::now().to_rfc3339(),
        origin: if origin.trim().is_empty() { "desktop".to_string() } else { origin.to_string() },
        codex_home: effective_envs
            .iter()
            .find(|(k, _)| k == "CODEX_HOME")
            .map(|(_, v)| PathBuf::from(v))
            .filter(|p| !p.as_os_str().is_empty()),
        tmux_name,
        view_mode,
        term_size: Mutex::new((rows.max(1), cols.max(1))),
        last_remote_ms: Mutex::new(0),
        display_title: Mutex::new(None),
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

    finalize_session(session, reader)
}

/// spawn / reattach 共用的收尾：启动 codex jsonl watcher + PTY 读线程 + 注册会话。
fn finalize_session(
    session: Arc<TerminalSession>,
    mut reader: Box<dyn std::io::Read + Send>,
) -> Result<Value, String> {
    let tool = session.tool.clone();
    // 若是 codex 会话，启动一个 jsonl watcher 抓 token_count 事件。
    // claim_floor 用会话 created_at(而非 now)：重连常驻会话时 jsonl 是早先创建的，
    // 用 now 会因 mtime 早于 floor 而认领不到。
    if tool.eq_ignore_ascii_case("codex") {
        let session_for_watch = Arc::clone(&session);
        let spawn_time = chrono::DateTime::parse_from_rfc3339(&session.created_at)
            .ok()
            .map(|dt| {
                std::time::UNIX_EPOCH
                    + std::time::Duration::from_secs((dt.timestamp() - 3).max(0) as u64)
            })
            .unwrap_or_else(std::time::SystemTime::now);
        let codex_pid = session
            .runtime
            .lock()
            .ok()
            .and_then(|r| r.child.process_id());
        std::thread::spawn(move || {
            watch_codex_session_tokens(&session_for_watch, spawn_time, codex_pid)
        });
    }

    let session_for_reader = Arc::clone(&session);
    std::thread::spawn(move || {
        let mut chunk = [0_u8; 8192];
        // 跨 read 边界缓存不完整的 UTF-8 尾字节，字符边界处再 emit。
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => {
                    // 收尾：残留字节按 lossy 吐出，避免丢内容
                    if !pending.is_empty() {
                        if let Some(app) = APP_HANDLE.get() {
                            let text = String::from_utf8_lossy(&pending).to_string();
                            let _ = app.emit(
                                "terminal-data",
                                json!({ "sessionId": session_for_reader.id, "data": text }),
                            );
                        }
                        pending.clear();
                    }
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
                    // OSC 标题兜底 → Hook 雷达（cwd 匹配终端/镜像）
                    for title in extract_osc_titles(data) {
                        crate::agent_hooks::note_osc_title(&session_for_reader.cwd, &title);
                    }
                    // 2) push 给前端：只 emit 合法 UTF-8 前缀，半个多字节字符留到下次
                    if let Some(app) = APP_HANDLE.get() {
                        pending.extend_from_slice(data);
                        let valid = utf8_valid_prefix_len(&pending);
                        if valid > 0 {
                            let text = String::from_utf8_lossy(&pending[..valid]).to_string();
                            pending.drain(..valid);
                            let _ = app.emit(
                                "terminal-data",
                                json!({
                                  "sessionId": session_for_reader.id,
                                  "data": text,
                                }),
                            );
                        }
                        // 残留 > 3 字节不可能只是"半个字符"（UTF-8 单字符最多 4 字节），
                        // 说明是真非法字节，lossy 冲掉以防 pending 无限增长卡住后续输出
                        if pending.len() > 3 {
                            let text = String::from_utf8_lossy(&pending).to_string();
                            pending.clear();
                            let _ = app.emit(
                                "terminal-data",
                                json!({
                                  "sessionId": session_for_reader.id,
                                  "data": text,
                                }),
                            );
                        }
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
    // 列表总线：手机即时看到桌面新建的终端 / tmux
    if let Ok(info) = serde_json::to_value(session_info(&session)) {
        let mut snap = info;
        if let Some(obj) = snap.as_object_mut() {
            obj.insert("bridge".to_string(), json!(false));
        }
        crate::session_bus::publish_upsert(snap);
    }
    Ok(json!({
      "ok": true,
      "terminalSession": session_info(&session),
    }))
}

/// 重连一个仍存活的 tmux 常驻会话(App 重启后调用):PTY 附着到还在跑的 codex。
fn reattach_tmux_session(name: &str, meta: &Value) -> Result<Value, String> {
    let tmux = tmux_bin().ok_or("tmux 不可用")?;
    let tool = meta.get("tool").and_then(Value::as_str).unwrap_or("codex");
    let title = meta.get("title").and_then(Value::as_str).unwrap_or("codex");
    let cwd = meta.get("cwd").and_then(Value::as_str).unwrap_or("");
    let codex_home = meta
        .get("codexHome")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let preview = meta.get("commandPreview").and_then(Value::as_str).unwrap_or("");
    let created = meta.get("createdAt").and_then(Value::as_str).unwrap_or("");
    let (rows, cols) = (DEFAULT_ROWS, DEFAULT_COLS);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let mut command = CommandBuilder::new(&tmux);
    if !cwd.is_empty() {
        command.cwd(cwd);
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    // 恢复时只 attach，不要再 new-session -A（避免空 pane / 语义混乱）
    command.args([
        "-f",
        &tmux_config_path(),
        "attach-session",
        "-t",
        name,
    ]);
    let master = pair.master;
    let reader = master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = master.take_writer().map_err(|e| e.to_string())?;
    let child = pair.slave.spawn_command(command).map_err(|e| e.to_string())?;
    let session = Arc::new(TerminalSession {
        id: uuid::Uuid::new_v4().to_string(),
        tool: tool.to_string(),
        title: title.to_string(),
        cwd: cwd.to_string(),
        command_preview: if preview.is_empty() {
            "codex".to_string()
        } else {
            preview.to_string()
        },
        created_at: if created.is_empty() {
            chrono::Utc::now().to_rfc3339()
        } else {
            created.to_string()
        },
        origin: "desktop".to_string(),
        codex_home,
        tmux_name: Some(name.to_string()),
        // 重启恢复的是「终端常驻」会话，不是镜像 attach
        view_mode: "terminal".to_string(),
        term_size: Mutex::new((rows.max(1), cols.max(1))),
        last_remote_ms: Mutex::new(0),
        display_title: Mutex::new(None),
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
    finalize_session(session, reader)
}

/// App 启动时把仍存活的 tmux 常驻会话恢复成可用会话(最多 12 个)。
pub(crate) fn restore_tmux_sessions() {
    let Some(tmux) = tmux_bin() else {
        return;
    };
    let meta = load_tmux_meta();
    let Some(obj) = meta.as_object() else {
        return;
    };
    let mut count = 0;
    for (name, m) in obj.clone() {
        if count >= 12 {
            break;
        }
        if !tmux_has_session(&tmux, &name) {
            remove_tmux_meta(&name); // 已死，清理元数据
            continue;
        }
        if reattach_tmux_session(&name, &m).is_ok() {
            count += 1;
        }
    }
}

/// GET /api/terminal/token-snapshot?sessionId=<our_session_uuid>
/// 给前端 poll 兜底用：根据 sessionId 找到对应 codex pid → lsof 拿 jsonl
/// → 从尾部读最后一条带 info 的 token_count 事件 → 返回真实数字。
/// 完全独立于 watcher 线程，永远可主动调。
/// GET /api/terminal/codex-picker?sessionId=X
/// 渲染该会话当前的 codex TUI 屏幕(vt100)，识别「模型选择器 / 推理级别选择器」
/// 并解析出编号选项，供手机端做原生选择器(选中后 write 对应数字即可切换)。
/// 返回 { stage: "model"|"reasoning"|"none", title, options:[{index,label,detail,current}], model }
pub(crate) fn terminal_codex_picker(query: &Value) -> Result<Value, String> {
    let object = parse_json_object(query);
    let session_id = get_string(&object, "sessionId");
    if session_id.trim().is_empty() {
        return Err("sessionId 不能为空".to_string());
    }
    let session = get_session(&session_id)?;
    let (rows, cols) = session
        .term_size
        .lock()
        .map(|s| *s)
        .unwrap_or((DEFAULT_ROWS, DEFAULT_COLS));
    let output = session
        .output
        .lock()
        .map(|o| o.clone())
        .unwrap_or_default();
    // 只喂末尾缓冲给 vt100：全量 clone+replay 会随会话变长越来越慢（手机轮询时尤其卡）
    const PICKER_TAIL_BYTES: usize = 96 * 1024;
    let tail = if output.len() > PICKER_TAIL_BYTES {
        // 尽量从完整 escape 序列边界切开，避免半截 CSI
        let start = output.len() - PICKER_TAIL_BYTES;
        let slice = &output[start..];
        let cut = slice
            .iter()
            .position(|&b| b == b'\x1b')
            .map(|i| start + i)
            .unwrap_or(start);
        output[cut..].to_vec()
    } else {
        output
    };
    // 用 vt100 还原屏幕(codex 靠光标定位重绘，必须真正模拟终端才能拿到正确文本)
    // 高度给足，避免选项多时标题被挤出可视区导致识别失败。
    let mut parser = vt100::Parser::new(rows.max(45), cols.max(80), 0);
    parser.process(&tail);
    let contents = parser.screen().contents();
    Ok(parse_codex_picker(&contents))
}

/// 从渲染后的屏幕文本里解析 codex 的模型/推理选择器。
/// 解析屏幕里的编号选项：可选前导 "›" 光标，然后 "N. Label (key)"。
/// 返回 [{index,label,key,current}]，同时给出第一条选项所在行号。
fn parse_numbered_options(lines: &[&str]) -> (Vec<Value>, Option<usize>) {
    let mut options = Vec::new();
    let mut first_idx = None;
    for (li, raw) in lines.iter().enumerate() {
        let trimmed = raw.trim_start();
        let pointed =
            trimmed.starts_with('›') || trimmed.starts_with('>') || trimmed.starts_with('❯');
        let body = trimmed.trim_start_matches(['›', '>', '❯']).trim_start();
        let Some(dot) = body.find('.') else { continue };
        let (num, rest) = body.split_at(dot);
        if num.is_empty() || num.len() > 2 || !num.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let Ok(index) = num.parse::<u32>() else { continue };
        if index == 0 {
            continue;
        }
        let rest = rest[1..].trim();
        if rest.is_empty() {
            continue;
        }
        // 括号里的快捷键 (y)/(p)/(esc)
        let key = rest
            .rfind('(')
            .and_then(|i| rest[i + 1..].find(')').map(|j| rest[i + 1..i + 1 + j].to_string()))
            .filter(|k| k.len() <= 4)
            .unwrap_or_default();
        let label = if !key.is_empty() {
            rest.rfind('(').map(|i| rest[..i].trim().to_string()).unwrap_or_else(|| rest.to_string())
        } else {
            rest.to_string()
        };
        let label = label.replace("(current)", "").replace("(default)", "").trim().to_string();
        if label.is_empty() {
            continue;
        }
        if first_idx.is_none() {
            first_idx = Some(li);
        }
        options.push(json!({
            "index": index, "label": label, "key": key, "current": pointed,
        }));
    }
    (options, first_idx)
}

/// 通用提示标题：取第一条选项上方紧邻的一段非空文本(问句)。
fn generic_prompt_title(lines: &[&str], first_opt_idx: usize) -> String {
    let mut collected: Vec<String> = Vec::new();
    let mut i = first_opt_idx as isize - 1;
    while i >= 0 && collected.len() < 4 {
        let t = lines[i as usize].trim();
        if t.is_empty() {
            break;
        }
        // 跳过边框/输入行/状态点
        if t.starts_with('›')
            || t.starts_with('❯')
            || t.starts_with('•')
            || t.starts_with('╭')
            || t.starts_with('╰')
            || t.starts_with('│')
            || t.starts_with('─')
            || t.starts_with('>')
        {
            break;
        }
        collected.push(t.to_string());
        i -= 1;
    }
    collected.reverse();
    collected.join(" ")
}

/// Codex `/usage` 菜单：当前高亮项带 `1.`，未高亮项经常不带编号，只缩进两列文本。
/// 例：
///   › 1. Show usage                View recent account token usage.
///        Redeem usage limit reset  No usage limit resets available.
fn parse_usage_menu_options(lines: &[&str]) -> Option<Vec<Value>> {
    let joined = lines.join("\n").to_lowercase();
    let looks_like_usage = (joined.contains("show usage") || joined.contains("\nusage\n") || joined.contains("  usage"))
        && (joined.contains("redeem") || joined.contains("usage limit") || joined.contains("account usage"));
    if !looks_like_usage {
        return None;
    }
    let mut options: Vec<Value> = Vec::new();
    let mut next_index: u32 = 1;
    for raw in lines {
        let trimmed = raw.trim_start();
        let pointed =
            trimmed.starts_with('›') || trimmed.starts_with('>') || trimmed.starts_with('❯');
        let mut body = trimmed
            .trim_start_matches(['›', '>', '❯'])
            .trim_start()
            .to_string();
        if let Some(dot) = body.find('.') {
            let (num, rest) = body.split_at(dot);
            if !num.is_empty()
                && num.len() <= 2
                && num.chars().all(|c| c.is_ascii_digit())
            {
                if let Ok(i) = num.parse::<u32>() {
                    next_index = i;
                    body = rest[1..].trim().to_string();
                }
            }
        }
        let lower = body.to_lowercase();
        if !(lower.starts_with("show usage") || lower.starts_with("redeem")) {
            continue;
        }
        // Label 与 detail 通常用 ≥2 空格分隔
        let mut parts = body
            .split("  ")
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();
        if parts.is_empty() {
            continue;
        }
        let label = parts.remove(0).to_string();
        let detail = parts.join(" ");
        options.push(json!({
            "index": next_index,
            "label": label,
            "detail": detail,
            "current": pointed,
            "key": "",
        }));
        next_index = next_index.saturating_add(1);
    }
    if options.is_empty() {
        None
    } else {
        Some(options)
    }
}

fn parse_codex_picker(contents: &str) -> Value {
    let lines: Vec<&str> = contents.lines().collect();
    let joined = contents;
    // 审批提示：codex 要跑命令/写文件时弹出「Would you like to run…」+ 编号 Yes/No
    let is_approval = joined.contains("Would you like to run")
        || joined.contains("Do you want to")
        || (joined.contains("Yes, proceed") && joined.contains("No,"));
    if is_approval {
        // 命令：以 "$ " 开头的行
        let command = lines
            .iter()
            .find_map(|l| {
                let t = l.trim();
                t.strip_prefix("$ ").map(|s| s.trim().to_string())
            })
            .unwrap_or_default();
        let reason = lines
            .iter()
            .find_map(|l| {
                let t = l.trim();
                t.strip_prefix("Reason:").map(|s| s.trim().to_string())
            })
            .unwrap_or_default();
        // 解析编号选项 + 括号里的快捷键
        let mut options = Vec::new();
        for raw in &lines {
            let body = raw
                .trim_start()
                .trim_start_matches(['›', '>', '❯'])
                .trim_start();
            let Some(dot) = body.find('.') else { continue };
            let (num, rest) = body.split_at(dot);
            if num.is_empty() || !num.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            let Ok(index) = num.parse::<u32>() else { continue };
            let rest = rest[1..].trim();
            if rest.is_empty() {
                continue;
            }
            // 抽括号里的快捷键 (y) (p) (esc)
            let key = rest
                .rfind('(')
                .and_then(|i| rest[i + 1..].find(')').map(|j| rest[i + 1..i + 1 + j].to_string()))
                .unwrap_or_default();
            // label 去掉尾部 (key)
            let label = if let Some(i) = rest.rfind('(') {
                rest[..i].trim().to_string()
            } else {
                rest.to_string()
            };
            options.push(json!({ "index": index, "label": label, "key": key }));
        }
        if !options.is_empty() {
            return json!({
                "stage": "approval",
                "title": "需要你确认",
                "command": command,
                "reason": reason,
                "options": options,
            });
        }
    }
    // /usage 菜单：未高亮项常无编号，必须专用解析，否则 App「查看用量」会一直失败
    if let Some(options) = parse_usage_menu_options(&lines) {
        return json!({
            "stage": "prompt",
            "title": "Usage",
            "options": options,
        });
    }
    let is_reasoning = joined.contains("Select Reasoning Level");
    let is_model = joined.contains("Select Model and Effort") || joined.contains("Select a model");
    let stage = if is_reasoning {
        "reasoning"
    } else if is_model {
        "model"
    } else {
        "none"
    };
    if stage == "none" {
        // 通用交互提示兜底：目录信任 / Press enter to continue / 任意编号 Yes-No 等。
        // 只要「有编号选项」且「codex 在等确认」，就统一传给 App 做原生按钮。
        let waiting = joined.contains("Press enter")
            || joined.contains("to continue")
            || joined.contains("to confirm")
            || joined.contains("Do you trust")
            || joined.contains("Do you want")
            || joined.contains("? ")
            || joined.contains("?\n");
        if waiting {
            let (options, first_idx) = parse_numbered_options(&lines);
            if options.len() >= 2 {
                let title = first_idx
                    .map(|i| generic_prompt_title(&lines, i))
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| "需要你确认".to_string());
                return json!({
                    "stage": "prompt",
                    "title": title,
                    "options": options,
                });
            }
            // 只有 1 个带编号项时也返回（例如某些版本只高亮显示编号）
            if options.len() == 1 {
                let title = first_idx
                    .map(|i| generic_prompt_title(&lines, i))
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| "需要你确认".to_string());
                return json!({
                    "stage": "prompt",
                    "title": title,
                    "options": options,
                });
            }
        }
        return json!({ "stage": "none", "options": [] });
    }
    // 选择器里 "Select Reasoning Level for <model>" 带当前模型名
    let model = lines
        .iter()
        .find_map(|l| {
            let t = l.trim();
            t.strip_prefix("Select Reasoning Level for ")
                .map(|s| s.trim().to_string())
        })
        .unwrap_or_default();
    // 逐行解析：可选前导 "›"(光标)，然后 "N. Label   Detail"
    let mut options = Vec::new();
    for raw in &lines {
        let line = raw.trim_end();
        let trimmed = line.trim_start();
        // 去掉光标标记，记录是否是当前指向行
        let pointed = trimmed.starts_with('›') || trimmed.starts_with('>') || trimmed.starts_with('❯');
        let body = trimmed
            .trim_start_matches(['›', '>', '❯'])
            .trim_start();
        // 匹配 "N. ..."
        let Some(dot) = body.find('.') else { continue };
        let (num_str, rest) = body.split_at(dot);
        if num_str.is_empty() || !num_str.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let Ok(index) = num_str.parse::<u32>() else { continue };
        if index == 0 || index > 20 {
            continue;
        }
        let rest = rest[1..].trim_start(); // 去掉 '.'
        if rest.is_empty() {
            continue;
        }
        // label 与 detail 用连续 2+ 空格分隔
        let (label_part, detail) = match rest.find("  ") {
            Some(pos) => (rest[..pos].trim(), rest[pos..].trim()),
            None => (rest.trim(), ""),
        };
        let is_current = label_part.contains("(current)") || pointed;
        // 清掉 (current)/(default) 后缀得到干净名字
        let clean = label_part
            .replace("(current)", "")
            .replace("(default)", "")
            .trim()
            .to_string();
        if clean.is_empty() {
            continue;
        }
        options.push(json!({
            "index": index,
            "label": clean,
            "detail": detail,
            "current": is_current,
            "default": label_part.contains("(default)"),
        }));
    }
    json!({
        "stage": stage,
        "title": if is_reasoning { "选择推理级别" } else { "选择模型" },
        "model": model,
        "options": options,
    })
}

pub(crate) fn terminal_token_snapshot(query: &Value) -> Result<Value, String> {
    let object = parse_json_object(query);
    let session_id = get_string(&object, "sessionId");
    if session_id.trim().is_empty() {
        return Err("sessionId 不能为空".to_string());
    }
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
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let p = v.get("payload");
        let kind = p
            .and_then(|p| p.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if kind != "token_count" {
            continue;
        }
        let info = p.and_then(|p| p.get("info"));
        let Some(info) = info else {
            continue;
        };
        if info.is_null() {
            continue;
        }
        let Some(total) = info.get("total_token_usage") else {
            continue;
        };
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

fn program_looks_like_codex(program: &str) -> bool {
    let name = Path::new(program)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(program)
        .to_ascii_lowercase();
    name == "codex" || name.starts_with("codex.")
}

fn args_have_model_provider_override(args: &[String]) -> bool {
    args.windows(2).any(|pair| {
        pair[0] == "-c"
            && pair[1]
                .split_once('=')
                .map(|(k, _)| k.trim().trim_matches('"') == "model_provider")
                .unwrap_or(false)
    })
}

/// 从 CODEX_HOME/config.toml 读顶层字符串配置（如 model / model_provider）。
pub(crate) fn read_codex_config_str(codex_home: &Path, key: &str) -> Option<String> {
    let text = std::fs::read_to_string(codex_home.join("config.toml")).ok()?;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('[') {
            continue;
        }
        let Some(rest) = line.strip_prefix(key) else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        let val = rest
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .trim()
            .to_string();
        if !val.is_empty() {
            return Some(val);
        }
    }
    None
}

/// 账号上下文：订阅(ChatGPT OAuth) / BYOK(API Key 或第三方 Provider) + 模型。
/// 供手机 Timeline / 终端顶栏展示。
pub(crate) fn codex_account_context(codex_home: &Path) -> Value {
    let auth_text = std::fs::read_to_string(codex_home.join("auth.json")).unwrap_or_default();
    let auth = serde_json::from_str::<Value>(&auth_text).unwrap_or_else(|_| json!({}));
    let auth_mode_raw = auth
        .get("auth_mode")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let has_chatgpt_tokens = auth
        .get("tokens")
        .and_then(Value::as_object)
        .map(|obj| {
            obj.contains_key("access_token")
                || obj.contains_key("id_token")
                || obj.contains_key("refresh_token")
        })
        .unwrap_or(false);
    let has_api_key = auth
        .get("OPENAI_API_KEY")
        .and_then(Value::as_str)
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let chatgpt = auth_mode_raw == "chatgpt" || has_chatgpt_tokens;
    let provider = read_codex_config_str(codex_home, "model_provider")
        .filter(|p| !p.is_empty() && !p.eq_ignore_ascii_case("openai"));
    let model = read_codex_config_str(codex_home, "model").unwrap_or_default();
    let effort = read_codex_config_str(codex_home, "model_reasoning_effort").unwrap_or_default();

    let (auth_mode, auth_label, provider_name) = if chatgpt && provider.is_none() {
        ("chatgpt", "订阅", "ChatGPT")
    } else if let Some(ref p) = provider {
        ("provider", "BYOK", p.as_str())
    } else if has_api_key {
        ("api_key", "BYOK", "OpenAI API")
    } else if chatgpt {
        ("chatgpt", "订阅", "ChatGPT")
    } else {
        ("unknown", "未登录", "")
    };

    json!({
        "authMode": auth_mode,
        "authLabel": auth_label,
        "provider": provider.clone().unwrap_or_default(),
        "providerName": provider_name,
        "model": model,
        "effort": effort,
        "codexHome": codex_home.to_string_lossy(),
    })
}

/// 从 CODEX_HOME/config.toml 读取**显式**配置的 model_provider。
///
/// 不再从 `model_catalog_json` 文件名（如 model-catalog.lucoo.json）或「唯一
/// provider」推断：catalog 只是模型列表，用户用 ChatGPT 账号登录时 config 里
/// 故意不写 model_provider；乱注入 lucoo 等会劫持账号登录。
fn infer_codex_model_provider(codex_home: &Path) -> Option<String> {
    read_codex_config_str(codex_home, "model_provider")
}

fn resolve_session_codex_home(envs: &[(String, String)]) -> PathBuf {
    if let Some((_, home)) = envs.iter().find(|(k, _)| k == "CODEX_HOME") {
        let trimmed = home.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
}

/// ChatGPT OAuth 登录时 auth.json 带 tokens；此时即使 config 误留了第三方
/// model_provider，终端启动也不应强行覆盖成 API 线路（账号优先）。
fn codex_home_uses_chatgpt_auth(codex_home: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(codex_home.join("auth.json")) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    let mode = value
        .get("auth_mode")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    if mode == "chatgpt" {
        return true;
    }
    value
        .get("tokens")
        .and_then(Value::as_object)
        .map(|obj| {
            obj.contains_key("access_token")
                || obj.contains_key("id_token")
                || obj.contains_key("refresh_token")
        })
        .unwrap_or(false)
}

fn ensure_codex_model_provider_arg(args: &mut Vec<String>, envs: &[(String, String)]) {
    if args_have_model_provider_override(args) {
        return;
    }
    let codex_home = resolve_session_codex_home(envs);
    // 账号登录优先：有 ChatGPT OAuth 就不要自动塞第三方 provider
    if codex_home_uses_chatgpt_auth(&codex_home) {
        eprintln!(
            "[terminal] 检测到 ChatGPT 账号登录（{}），不自动注入 model_provider",
            codex_home.display()
        );
        return;
    }
    let Some(provider) = infer_codex_model_provider(&codex_home) else {
        return;
    };
    // openai 默认留给官方 OAuth；不要强行改写
    if provider.eq_ignore_ascii_case("openai") {
        return;
    }
    args.push("-c".to_string());
    args.push(format!("model_provider=\"{provider}\""));
    eprintln!("[terminal] 自动补齐 model_provider={provider}（config 显式配置）");
}

fn merge_codex_dotenv_into_envs(envs: &mut Vec<(String, String)>) {
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let path = home.join(".codex").join(".env");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    let existing: std::collections::HashSet<String> =
        envs.iter().map(|(k, _)| k.to_ascii_uppercase()).collect();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let key = k.trim();
        if key.is_empty() {
            continue;
        }
        if existing.contains(&key.to_ascii_uppercase()) {
            continue;
        }
        // 已在进程环境里也不覆盖
        if std::env::var(key).is_ok() {
            continue;
        }
        let mut val = v.trim().to_string();
        if (val.starts_with('"') && val.ends_with('"'))
            || (val.starts_with('\'') && val.ends_with('\''))
        {
            val = val[1..val.len() - 1].to_string();
        }
        if !val.is_empty() {
            envs.push((key.to_string(), val));
        }
    }
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
    let mut envs = object
        .get("env")
        .and_then(Value::as_object)
        .map(|items| {
            items
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|text| (key.clone(), text.to_string()))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    // Codex：仅当 config 显式写了 model_provider、且不是 ChatGPT 账号登录时，
    // 才补 -c；切勿用 model_catalog_json 文件名（lucoo）劫持 OAuth。
    if tool.eq_ignore_ascii_case("codex") || program_looks_like_codex(&program) {
        ensure_codex_model_provider_arg(&mut args, &envs);
        merge_codex_dotenv_into_envs(&mut envs);
    }
    let rows = parse_rows(&object, "rows", DEFAULT_ROWS);
    let cols = parse_rows(&object, "cols", DEFAULT_COLS);
    let preview = object
        .get("commandPreview")
        .and_then(Value::as_str)
        .map(|value| value.to_string());
    // origin：远程服务在转发手机请求时注入 "phone"；本机默认 "desktop"
    let origin = {
        let o = get_string(&object, "origin");
        if o.trim().is_empty() {
            "desktop".to_string()
        } else {
            o
        }
    };
    let (program, resolved_preview) = if cfg!(target_os = "windows") {
        let (resolved_program, resolved_args, resolved_preview) =
            resolve_windows_terminal_command(&program, &args);
        args = resolved_args;
        (resolved_program, Some(resolved_preview))
    } else {
        (program, None)
    };
    spawn_embedded_terminal_with_origin(
        &cwd,
        if title.trim().is_empty() {
            &program
        } else {
            &title
        },
        if tool.trim().is_empty() {
            "shell"
        } else {
            &tool
        },
        &program,
        &args,
        &envs,
        rows,
        cols,
        preview.or(resolved_preview),
        &origin,
    )
}

/// GET /api/terminal/list-dir?path=<dir>
/// 列出电脑上某目录的子目录，供手机端可视化选工作目录(不用手输路径)。
/// 返回 { path, parent, home, dirs:[{name,path}] }。
pub(crate) fn terminal_list_dir(query: &Value) -> Result<Value, String> {
    let object = parse_json_object(query);
    let mut path = get_string(&object, "path");
    let home = dirs::home_dir().map(|p| p.to_string_lossy().to_string());
    if path.trim().is_empty() {
        path = home.clone().unwrap_or_else(|| "/".to_string());
    }
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("不是目录: {path}"));
    }
    let mut dirs: Vec<Value> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&p) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue; // 跳过隐藏目录
            }
            let is_dir = entry
                .file_type()
                .map(|t| t.is_dir())
                .unwrap_or(false)
                || entry.path().is_dir();
            if is_dir {
                dirs.push(json!({
                    "name": name,
                    "path": entry.path().to_string_lossy(),
                }));
            }
        }
    }
    dirs.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
    });
    let parent = p.parent().map(|pp| pp.to_string_lossy().to_string());
    Ok(json!({
        "path": p.to_string_lossy(),
        "parent": parent,
        "home": home,
        "dirs": dirs,
    }))
}

pub(crate) fn terminal_list(_query: &Value) -> Result<Value, String> {
    let sessions = terminal_sessions()
        .lock()
        .map_err(|error| error.to_string())?;
    let mut rows = sessions.values().map(session_info).collect::<Vec<_>>();
    // 新 → 旧，保证桌面/手机列表一致
    rows.sort_by(|a, b| {
        let ta = chrono::DateTime::parse_from_rfc3339(&a.created_at)
            .map(|t| t.timestamp_millis())
            .unwrap_or(0);
        let tb = chrono::DateTime::parse_from_rfc3339(&b.created_at)
            .map(|t| t.timestamp_millis())
            .unwrap_or(0);
        tb.cmp(&ta).then_with(|| b.session_id.cmp(&a.session_id))
    });
    Ok(json!({
      "supported": true,
      "rows": rows,
    }))
}

pub(crate) fn terminal_read(query: &Value) -> Result<Value, String> {
    let object = parse_json_object(query);
    let session_id = get_string(&object, "sessionId");
    if session_id.trim().is_empty() {
        return Err("sessionId 不能为空".to_string());
    }
    // cursor 可能是数字(JSON body)或字符串(URL query — 前端 searchParams 全是 string)。
    // 之前只用 as_u64()，字符串会解析失败 fallback 0 → 每次重挂载都从头灌整段历史，
    // 切回会话时内容整段重复。这里两种形态都接受。
    let cursor = object
        .get("cursor")
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str().and_then(|text| text.trim().parse::<u64>().ok()))
        })
        .map(|value| value as usize)
        .unwrap_or(0);
    let session = get_session(&session_id)?;
    Ok(read_session_output(&session, cursor))
}

pub(crate) fn terminal_write(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let session_id = get_string(&object, "sessionId");
    let data = get_string(&object, "data");
    // submit=true：服务端写完文本后短延迟再发 \r（手机端一次 HTTP 完成提交，省一倍 RTT）
    // 分开发是因为 tmux 下「文本+\r」同包会被当成粘贴；短 sleep 后单独 \r 才能当提交键。
    let submit = object.get("submit").and_then(Value::as_bool).unwrap_or(false);
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
    if submit {
        // 释放锁再睡，避免卡住其它 read/picker
        drop(runtime);
        std::thread::sleep(std::time::Duration::from_millis(35));
        let mut runtime = session.runtime.lock().map_err(|error| error.to_string())?;
        if runtime.running {
            runtime
                .writer
                .write_all(b"\r")
                .map_err(|error| error.to_string())?;
            runtime.writer.flush().map_err(|error| error.to_string())?;
        }
    }
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
    drop(runtime);
    if let Ok(mut sz) = session.term_size.lock() {
        *sz = (rows.max(1), cols.max(1));
    }
    Ok(json!({ "ok": true, "rows": rows, "cols": cols }))
}

/// POST /api/terminal/upload
/// body: { filename, dataBase64 }（dataBase64 可带 data:image/png;base64, 前缀）
/// 把手机端传来的图片/文件落到 ~/.codex-config-ui/uploads/，返回绝对路径。
/// 手机端拿到 path 后即可把它作为参数/文本发进 codex / claude 会话（两者都能读本地图片路径）。
pub(crate) fn terminal_upload(body: &Value) -> Result<Value, String> {
    use base64::Engine;
    let object = parse_json_object(body);
    let filename = get_string(&object, "filename");
    let mut data_b64 = get_string(&object, "dataBase64");
    if data_b64.trim().is_empty() {
        return Err("dataBase64 不能为空".to_string());
    }
    // 去掉 data URL 前缀 data:<mime>;base64,
    if let Some(idx) = data_b64.find("base64,") {
        data_b64 = data_b64[(idx + "base64,".len())..].to_string();
    }
    let cleaned: String = data_b64.split_whitespace().collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(cleaned.as_bytes())
        .map_err(|e| format!("base64 解码失败：{e}"))?;
    if bytes.is_empty() {
        return Err("上传内容为空".to_string());
    }
    let dir = app_home()?.join("uploads");
    ensure_dir(&dir)?;
    let safe = sanitize_upload_filename(&filename);
    let name = format!(
        "{}-{}",
        chrono::Utc::now().timestamp_millis(),
        if safe.is_empty() { "upload.bin".to_string() } else { safe }
    );
    let path = dir.join(&name);
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(json!({
        "ok": true,
        "path": path.to_string_lossy(),
        "bytes": bytes.len(),
    }))
}

fn sanitize_upload_filename(input: &str) -> String {
    let base = input
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(input)
        .trim_matches('\0')
        .trim();
    base.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect()
}

/// 现场为某 PTY 会话认领一份 codex jsonl（timeline 兜底路径）。
/// 用会话 created_at 作为 claim_floor，容忍 codex 延迟写文件。
fn claim_jsonl_for_session(session: &Arc<TerminalSession>) -> Option<PathBuf> {
    let sessions_root = session_sessions_root(session);
    if !sessions_root.is_dir() {
        return None;
    }
    // created_at 是 RFC3339；解析成 SystemTime，减 10s 容差作为 floor。
    let floor = chrono::DateTime::parse_from_rfc3339(&session.created_at)
        .ok()
        .map(|dt| {
            std::time::UNIX_EPOCH
                + std::time::Duration::from_secs(
                    (dt.timestamp() - 10).max(0) as u64,
                )
        })
        .unwrap_or(std::time::UNIX_EPOCH);
    let path = find_unclaimed_session_jsonl(&sessions_root, &session.cwd, floor)?;
    if try_claim_jsonl(&path) {
        if let Ok(mut slot) = session.jsonl_path.lock() {
            *slot = Some(path.clone());
        }
        Some(path)
    } else {
        // 已被（大概率是本会话的 watcher）认领：直接用
        if let Ok(slot) = session.jsonl_path.lock() {
            if let Some(p) = slot.clone() {
                return Some(p);
            }
        }
        None
    }
}

/// GET /api/terminal/timeline?sessionId=<ptyId>&cursor=<lineOffset>
/// 把该会话认领的 codex JSONL 解析成结构化消息流（用户/助手/工具），
/// 供手机端做原生 timeline 渲染，替代直接搬终端字节。
/// cursor 是「已读到的行号」，增量返回新消息 + 新行号。
pub(crate) fn terminal_timeline(query: &Value) -> Result<Value, String> {
    let object = parse_json_object(query);
    let session_id = get_string(&object, "sessionId");
    if session_id.trim().is_empty() {
        return Err("sessionId 不能为空".to_string());
    }
    let cursor = object
        .get("cursor")
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
        })
        .unwrap_or(0) as usize;
    let session = get_session(&session_id)?;
    let (running, exit_code) = session
        .runtime
        .lock()
        .map(|r| (r.running, r.exit_code))
        .unwrap_or((false, None));

    // 优先用 watcher 认领的 jsonl；若还没有（watcher 线程可能已退出/未认领），
    // 这里按 cwd + created_at 现场找一份并认领，保证 timeline 稳健可用。
    let mut path = session.jsonl_path.lock().ok().and_then(|p| p.clone());
    if path.is_none() && session.tool.eq_ignore_ascii_case("codex") {
        if let Some(found) = claim_jsonl_for_session(&session) {
            path = Some(found);
        }
    }
    let Some(path) = path else {
        return Ok(json!({
            "ok": true,
            "ready": false,
            "reason": "正在等待 codex 写入会话文件…",
            "messages": [],
            "cursor": 0,
            "running": running,
            "exitCode": exit_code,
        }));
    };

    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut line_no = 0usize;
    let mut messages: Vec<Value> = Vec::new();
    let mut model = String::new();
    let mut effort = String::new();
    for line in reader.lines().map_while(Result::ok) {
        line_no += 1;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        // 始终跟踪最新 model/effort(turn_context)，不受 cursor 限制，供顶部状态条显示
        if event.get("type").and_then(Value::as_str) == Some("turn_context") {
            if let Some(p) = event.get("payload") {
                if let Some(m) = p.get("model").and_then(Value::as_str) {
                    if !m.is_empty() {
                        model = m.to_string();
                    }
                }
                if let Some(e) = p.get("effort").and_then(Value::as_str) {
                    if !e.is_empty() {
                        effort = e.to_string();
                    }
                }
            }
        }
        // 消息只取 cursor 之后的(增量)
        if line_no <= cursor {
            continue;
        }
        if let Some(msg) = codex_event_to_message(&event, line_no, &mut model) {
            messages.push(msg);
        }
    }

    Ok(json!({
        "ok": true,
        "ready": true,
        "messages": messages,
        "cursor": line_no,
        "running": running,
        "exitCode": exit_code,
        "model": model,
        "effort": effort,
    }))
}

/// codex 会往对话里注入一堆 XML 包裹的脚手架（系统指令 / 环境上下文 / 用户守则），
/// 这些不是真实对话，timeline 要过滤掉，否则手机上就是"一堆 XML 原始文字"。
fn is_codex_scaffolding(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("<environment_context")
        || t.starts_with("<permissions")
        || t.starts_with("<collaboration_mode")
        || t.starts_with("<user_instructions")
        || t.starts_with("<tools_instructions")
        || t.starts_with("<available_tools")
        || t.contains("<permissions instructions>")
        || t.contains("<collaboration_mode>")
}

/// 把一条 codex JSONL 事件转成 timeline 消息；非消息/脚手架事件返回 None。
/// 消息形态：{ seq, role: user|assistant|reasoning|tool, kind, text }
fn codex_event_to_message(event: &Value, seq: usize, model: &mut String) -> Option<Value> {
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
    let payload = event.get("payload");
    let payload_type = payload
        .and_then(|p| p.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("");

    if event_type == "session_meta" || event_type == "turn_context" {
        if let Some(m) = payload
            .and_then(|p| p.get("model"))
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
        {
            *model = m.to_string();
        }
        return None;
    }

    // 真实用户消息只认 event_msg/user_message；response_item 里的 role=user
    // 基本都是环境上下文注入或同一条的重复，下面统一跳过。
    if event_type == "event_msg" && payload_type == "user_message" {
        let text = payload
            .and_then(|p| p.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if text.is_empty() || is_codex_scaffolding(&text) {
            return None;
        }
        return Some(json!({ "seq": seq, "role": "user", "kind": "text", "text": text }));
    }

    // 结构化消息：只保留 assistant（真实回复）；user 一律跳过（脚手架/重复）。
    if event_type == "response_item" && payload_type == "message" {
        let role = payload
            .and_then(|p| p.get("role"))
            .and_then(Value::as_str)
            .unwrap_or("assistant");
        if role == "user" || role == "developer" || role == "system" {
            return None;
        }
        let text = payload
            .and_then(|p| p.get("content"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        item.get("text")
                            .and_then(Value::as_str)
                            .or_else(|| item.get("input_text").and_then(Value::as_str))
                            .or_else(|| item.get("output_text").and_then(Value::as_str))
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        if text.trim().is_empty() || is_codex_scaffolding(&text) {
            return None;
        }
        return Some(json!({ "seq": seq, "role": "assistant", "kind": "text", "text": text }));
    }

    // 助手推理（可折叠展示）
    if event_type == "event_msg"
        && (payload_type == "agent_reasoning" || payload_type == "reasoning")
    {
        let text = payload
            .and_then(|p| p.get("text").or_else(|| p.get("message")))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if text.is_empty() {
            return None;
        }
        return Some(json!({ "seq": seq, "role": "reasoning", "kind": "reasoning", "text": text }));
    }

    // 工具调用：命令 / shell / 补丁
    if event_type == "response_item"
        && (payload_type == "function_call"
            || payload_type == "local_shell_call"
            || payload_type == "custom_tool_call")
    {
        let name = payload
            .and_then(|p| p.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("tool");
        let args_raw = payload
            .and_then(|p| p.get("arguments"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let (tool_kind, title) = format_tool_call(name, args_raw, payload);
        return Some(json!({
            "seq": seq, "role": "tool", "kind": "tool_call", "tool": tool_kind, "text": title
        }));
    }

    // 工具输出（命令结果 / 补丁结果）
    if event_type == "response_item" && payload_type == "function_call_output" {
        let out = payload
            .and_then(|p| p.get("output"))
            .and_then(|o| o.as_str().map(|s| s.to_string()).or_else(|| {
                // output 有时是对象 { content, ... }
                o.get("content").and_then(Value::as_str).map(|s| s.to_string())
            }))
            .unwrap_or_default();
        let cleaned = clean_tool_output(&out);
        if cleaned.trim().is_empty() {
            return None;
        }
        return Some(json!({
            "seq": seq, "role": "tool", "kind": "tool_output", "text": cleaned
        }));
    }

    None
}

/// 把工具调用格式化成 (kind, 标题)。kind: exec|patch|read|tool。
fn format_tool_call(name: &str, args_raw: &str, payload: Option<&Value>) -> (String, String) {
    let args: Value = serde_json::from_str(args_raw).unwrap_or(Value::Null);
    let lname = name.to_lowercase();
    // 命令类：exec_command / shell / local_shell
    let is_exec = lname.contains("exec") || lname.contains("shell") || lname == "bash";
    if is_exec {
        // cmd 可能是字符串，或 command 是数组
        let cmd = args
            .get("cmd")
            .and_then(Value::as_str)
            .map(|s| s.to_string())
            .or_else(|| {
                args.get("command").and_then(|c| {
                    c.as_str().map(|s| s.to_string()).or_else(|| {
                        c.as_array().map(|arr| {
                            arr.iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join(" ")
                        })
                    })
                })
            })
            // local_shell_call 直接在 payload.command
            .or_else(|| {
                payload
                    .and_then(|p| p.get("command"))
                    .and_then(|c| c.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
            })
            .unwrap_or_else(|| args_raw.to_string());
        let cmd = cmd.trim().chars().take(400).collect::<String>();
        return ("exec".to_string(), cmd);
    }
    // 补丁类：apply_patch
    if lname.contains("patch") || args.get("patch").is_some() || args.get("input").is_some() {
        let patch = args
            .get("patch")
            .or_else(|| args.get("input"))
            .and_then(Value::as_str)
            .unwrap_or("");
        // 从 patch 里抽出涉及的文件
        let files: Vec<String> = patch
            .lines()
            .filter_map(|l| {
                let t = l.trim();
                for pfx in ["*** Update File:", "*** Add File:", "*** Delete File:"] {
                    if let Some(rest) = t.strip_prefix(pfx) {
                        return Some(rest.trim().to_string());
                    }
                }
                None
            })
            .collect();
        let title = if files.is_empty() {
            "应用补丁".to_string()
        } else {
            format!("修改 {}", files.join(", "))
        };
        return ("patch".to_string(), title);
    }
    // 读文件类
    if lname.contains("read") || lname.contains("cat") || lname.contains("view") {
        let path = args
            .get("path")
            .or_else(|| args.get("file"))
            .or_else(|| args.get("filename"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let title = if path.is_empty() {
            name.to_string()
        } else {
            format!("读取 {path}")
        };
        return ("read".to_string(), title);
    }
    // 其它：名字 + 简短参数
    let preview = args_raw.trim().chars().take(120).collect::<String>();
    (
        "tool".to_string(),
        if preview.is_empty() {
            name.to_string()
        } else {
            format!("{name} {preview}")
        },
    )
}

/// 清理 exec_command 的输出：去掉 "Chunk ID/Wall time/Process exited/Output:" 前言，
/// 只留真正的命令输出；带上退出码提示；过长截断。
fn clean_tool_output(raw: &str) -> String {
    let raw = raw.trim();
    if raw.is_empty() {
        return String::new();
    }
    // 退出码
    let exit_code = raw
        .lines()
        .find_map(|l| {
            let t = l.trim();
            t.strip_prefix("Process exited with code ")
                .and_then(|s| s.trim().parse::<i32>().ok())
        });
    // 真正输出：优先 "Output:" 之后
    let body = if let Some(idx) = raw.find("\nOutput:\n") {
        raw[idx + "\nOutput:\n".len()..].to_string()
    } else if let Some(idx) = raw.find("Output:\n") {
        raw[idx + "Output:\n".len()..].to_string()
    } else if raw.starts_with("Chunk ID:") || raw.starts_with("Wall time:") {
        // 只有前言没有 Output → 视为空
        String::new()
    } else {
        raw.to_string()
    };
    let body = body.trim_end();
    let body = if body.chars().count() > 1500 {
        let s: String = body.chars().take(1500).collect();
        format!("{s}\n…（输出过长已截断）")
    } else {
        body.to_string()
    };
    match exit_code {
        Some(0) | None => body,
        Some(code) => {
            if body.is_empty() {
                format!("[退出码 {code}]")
            } else {
                format!("{body}\n[退出码 {code}]")
            }
        }
    }
}

pub(crate) fn terminal_close(body: &Value) -> Result<Value, String> {
    let object = parse_json_object(body);
    let session_id = get_string(&object, "sessionId");
    let remove = object
        .get("remove")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if session_id.trim().is_empty() {
        return Err("sessionId 不能为空".to_string());
    }
    let session = get_session(&session_id)?;
    {
        let mut runtime = session.runtime.lock().map_err(|error| error.to_string())?;
        let _ = runtime.child.kill(); // 杀 PTY 客户端；tmux 会话(codex)仍在后台存活=detach
        runtime.running = false;
    }
    if remove {
        // 显式删除 → 真正结束常驻的 tmux 会话
        if let Some(name) = session.tmux_name.clone() {
            if let Some(tmux) = tmux_bin() {
                let _ = std::process::Command::new(&tmux)
                    .args(["kill-session", "-t", &name])
                    .output();
            }
            remove_tmux_meta(&name);
        }
        let _ = remove_session(&session_id)?;
        crate::session_bus::publish_remove(&session_id, &session.tool);
    } else if let Ok(info) = serde_json::to_value(session_info(&session)) {
        let mut snap = info;
        if let Some(obj) = snap.as_object_mut() {
            obj.insert("bridge".to_string(), json!(false));
        }
        crate::session_bus::publish_upsert(snap);
    }
    Ok(json!({
      "ok": true,
      "removed": remove,
      "session": session_info(&session),
    }))
}
