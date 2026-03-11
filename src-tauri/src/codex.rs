use serde::Serialize;
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use uuid::Uuid;

const OPENCLAW_INSTALL_TASK_KEEP: usize = 12;
const OPENCLAW_INSTALL_SCRIPT_UNIX: &str = "curl -fsSL https://openclaw.ai/install.sh | OPENCLAW_NO_ONBOARD=1 bash -s -- --no-onboard --install-method npm";
const OPENCLAW_INSTALL_SCRIPT_WIN: &str = "$env:OPENCLAW_NO_ONBOARD='1'; iwr -useb https://openclaw.ai/install.ps1 | iex";
const OPENCLAW_NPM_REGISTRY_CN: &str = "https://registry.npmmirror.com";

static OPENCLAW_INSTALL_TASK_SEQ: AtomicU64 = AtomicU64::new(1);
static OPENCLAW_INSTALL_TASKS: OnceLock<Mutex<BTreeMap<String, OpenClawInstallTask>>> = OnceLock::new();

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenClawInstallLog {
  source: String,
  text: String,
  at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenClawInstallStep {
  key: String,
  title: String,
  description: String,
  hint: String,
  progress: u64,
  status: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenClawInstallTask {
  task_id: String,
  tool_id: String,
  #[serde(rename = "type")]
  task_type: String,
  method: String,
  command: String,
  status: String,
  progress: u64,
  step_index: usize,
  summary: String,
  hint: String,
  detail: String,
  steps: Vec<OpenClawInstallStep>,
  logs: Vec<OpenClawInstallLog>,
  started_at: String,
  updated_at: String,
  completed_at: Option<String>,
  version: Option<String>,
  error: Option<String>,
  next_actions: Vec<String>,
  #[serde(skip_serializing)]
  cancel_requested: bool,
  #[serde(skip_serializing)]
  child_pid: Option<u32>,
  #[serde(skip_serializing)]
  install_snapshot: OpenClawInstallSnapshot,
}

#[derive(Clone, Default)]
struct OpenClawInstallSnapshot {
  had_binary: bool,
  home_path: String,
  home_existed: bool,
  package_path: String,
  bin_paths: Vec<String>,
}

/// Resolve the user's full shell PATH.
/// On macOS / Linux, .app bundles don't inherit the login shell PATH,
/// so we run `$SHELL -lc 'echo $PATH'` to capture it.
fn windows_mingit_root() -> Option<PathBuf> {
  app_home().ok().map(|path| path.join("tools").join("mingit"))
}

fn windows_mingit_cmd_dirs() -> Vec<String> {
  let Some(root) = windows_mingit_root() else { return Vec::new(); };
  let candidates = [root.join("cmd"), root.join("mingw64").join("bin"), root.join("bin")];
  candidates
    .into_iter()
    .filter(|dir| dir.is_dir())
    .map(|dir| dir.to_string_lossy().to_string())
    .collect()
}

fn windows_user_npm_prefix() -> Option<PathBuf> {
  std::env::var("APPDATA").ok().map(PathBuf::from).map(|path| path.join("npm"))
}

fn windows_portable_node_root() -> Option<PathBuf> {
  app_home().ok().map(|path| path.join("tools").join("node"))
}

fn windows_portable_node_dirs() -> Vec<String> {
  let Some(root) = windows_portable_node_root() else { return Vec::new(); };
  let mut dirs = Vec::new();
  if root.join("node.exe").exists() {
    dirs.push(root.to_string_lossy().to_string());
  }
  if let Ok(entries) = fs::read_dir(&root) {
    for entry in entries.flatten() {
      let path = entry.path();
      if path.is_dir() && path.join("node.exe").exists() {
        dirs.push(path.to_string_lossy().to_string());
      }
    }
  }
  dirs
}

fn build_windows_full_path_env() -> String {
  let current = std::env::var("PATH").unwrap_or_default();
  let mut parts: Vec<String> = Vec::new();
  parts.extend(windows_portable_node_dirs());
  if let Some(prefix) = windows_user_npm_prefix() {
    parts.push(prefix.to_string_lossy().to_string());
  }
  parts.extend(windows_mingit_cmd_dirs());
  for p in current.split(';') {
    let item = p.trim();
    if !item.is_empty() {
      parts.push(item.to_string());
    }
  }
  let mut seen = HashSet::new();
  parts.retain(|p| seen.insert(p.to_ascii_lowercase()));
  parts.join(";")
}

/// Resolve the user's full shell PATH.
/// On macOS / Linux, .app bundles don't inherit the login shell PATH,
/// so we run `$SHELL -lc 'echo $PATH'` to capture it.
fn full_path_env() -> String {
  if cfg!(target_os = "windows") {
    return build_windows_full_path_env();
  }

  static CACHED: OnceLock<String> = OnceLock::new();
  CACHED
    .get_or_init(|| {
      let current = std::env::var("PATH").unwrap_or_default();

      let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
      let shell_path = Command::new(&shell)
        .args(["-lc", "echo $PATH"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

      let home = dirs::home_dir()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|| "/Users/unknown".to_string());

      let extra_paths = [
        format!("{}/.nvm/versions/node/*/bin", home),
        format!("{}/.npm-global/bin", home),
        format!("{}/.local/bin", home),
        format!("{}/bin", home),
        "/opt/homebrew/bin".to_string(),
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/local/sbin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
        "/usr/sbin".to_string(),
        "/sbin".to_string(),
      ];

      let nvm_dir = format!("{}/.nvm/versions/node", home);
      let mut nvm_paths = Vec::new();
      if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
        for entry in entries.flatten() {
          let bin = entry.path().join("bin");
          if bin.is_dir() {
            nvm_paths.push(bin.to_string_lossy().to_string());
          }
        }
      }
      nvm_paths.sort();
      nvm_paths.reverse();

      let mut all_parts: Vec<String> = Vec::new();
      for p in shell_path.split(':') {
        if !p.is_empty() {
          all_parts.push(p.to_string());
        }
      }
      all_parts.extend(nvm_paths);
      for p in current.split(':') {
        if !p.is_empty() {
          all_parts.push(p.to_string());
        }
      }
      all_parts.extend(extra_paths.into_iter().filter(|p| !p.contains('*')));

      let mut seen = HashSet::new();
      all_parts.retain(|p| seen.insert(p.clone()));
      all_parts.join(":")
    })
    .clone()
}

/// Create a Command with the full PATH environment set
fn create_command(program: &str) -> Command {
  let mut cmd = Command::new(program);
  cmd.env("PATH", full_path_env());
  cmd
}

fn run_command(command: &str, args: &[&str], cwd: Option<&Path>) -> Result<Value, String> {
  let mut cmd = create_command(command);
  cmd.args(args);
  cmd.stdin(Stdio::null()); // prevent /dev/tty errors in GUI context
  if let Some(dir) = cwd {
    cmd.current_dir(dir);
  }
  let output = cmd.output().map_err(|error| error.to_string())?;
  let stdout = String::from_utf8_lossy(&output.stdout).to_string();
  let stderr = String::from_utf8_lossy(&output.stderr).to_string();
  Ok(json!({
    "ok": output.status.success(),
    "code": output.status.code(),
    "stdout": stdout,
    "stderr": stderr,
  }))
}

fn run_command_dynamic(
  command: &str,
  args: &[String],
  cwd: Option<&Path>,
  extra_env: Option<(&str, String)>,
) -> Result<Value, String> {
  let mut cmd = create_command(command);
  cmd.stdin(Stdio::null());
  if let Some(dir) = cwd {
    cmd.current_dir(dir);
  }
  for arg in args {
    cmd.arg(arg);
  }
  if let Some((key, value)) = extra_env {
    cmd.env(key, value);
  }
  let output = cmd.output().map_err(|error| error.to_string())?;
  let stdout = String::from_utf8_lossy(&output.stdout).to_string();
  let stderr = String::from_utf8_lossy(&output.stderr).to_string();
  Ok(json!({
    "ok": output.status.success(),
    "code": output.status.code(),
    "stdout": stdout,
    "stderr": stderr,
  }))
}

fn openclaw_install_tasks() -> &'static Mutex<BTreeMap<String, OpenClawInstallTask>> {
  OPENCLAW_INSTALL_TASKS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn now_rfc3339() -> String {
  chrono::Utc::now().to_rfc3339()
}

fn openclaw_install_steps(method: &str) -> Vec<OpenClawInstallStep> {
  let specs = if method == "script" {
    vec![
      ("preflight", "检查运行环境", "确认脚本安装所需命令可用", "这一步在确认系统具备安装条件，你不用操作。", 8_u64),
      ("download", "下载官方安装器", "从 OpenClaw 官方地址拉取安装脚本", "如果网络慢，这一步可能停留几十秒，属于正常现象。", 24_u64),
      ("install", "执行安装脚本", "安装器正在写入程序和命令入口", "看到日志滚动代表仍在工作，请不要关闭窗口。", 62_u64),
      ("verify", "验证命令是否可用", "检查 `openclaw` 是否已能直接运行", "已经接近完成，正在做最后确认。", 88_u64),
      ("done", "整理下一步引导", "安装完成，准备告诉你接下来做什么", "安装结束后，我会直接告诉你下一步。", 100_u64),
    ]
  } else if method == "domestic" {
    vec![
      ("preflight", "准备国内安装环境", "检查 Node.js、npm，并优先启用应用内 Git", "这一步会尽量自动补齐缺失依赖，你不用手动处理。", 8_u64),
      ("download", "切换国内 npm 源", "使用 npmmirror 获取 OpenClaw 安装包和依赖", "国内网络下通常会更稳、更快。", 26_u64),
      ("install", "一键安装 OpenClaw", "正在安装到当前用户目录，避免系统权限问题", "安装过程可能有短暂静默，请耐心等待。", 64_u64),
      ("verify", "验证命令是否可用", "检查 `openclaw` 命令和版本", "已经接近完成，正在做最终验证。", 88_u64),
      ("done", "整理下一步引导", "安装完成，准备告诉你接下来做什么", "安装结束后，我会直接告诉你下一步。", 100_u64),
    ]
  } else {
    vec![
      ("preflight", "检查 Node.js / npm", "确认 npm 全局安装环境可用", "这一步在确认本机能执行 npm 安装。", 8_u64),
      ("download", "下载 OpenClaw 包", "npm 正在获取安装包和依赖信息", "如果网络慢，这一步可能较久，不代表卡死。", 26_u64),
      ("install", "全局安装 OpenClaw", "npm 正在把 OpenClaw 安装到全局环境", "安装过程可能没有持续输出，请耐心等待。", 64_u64),
      ("verify", "验证命令是否可用", "检查 `openclaw` 命令和版本", "已经接近完成，正在做最终验证。", 88_u64),
      ("done", "整理下一步引导", "安装完成，准备告诉你接下来做什么", "安装结束后，我会直接告诉你下一步。", 100_u64),
    ]
  };

  specs.into_iter().enumerate().map(|(index, (key, title, description, hint, progress))| OpenClawInstallStep {
    key: key.to_string(),
    title: title.to_string(),
    description: description.to_string(),
    hint: hint.to_string(),
    progress,
    status: if index == 0 { "running".to_string() } else { "pending".to_string() },
  }).collect()
}

fn create_openclaw_install_task(method: &str, command: &str) -> OpenClawInstallTask {
  let id = format!(
    "openclaw-install-{}-{}",
    chrono::Utc::now().timestamp_millis(),
    OPENCLAW_INSTALL_TASK_SEQ.fetch_add(1, AtomicOrdering::Relaxed)
  );
  let started_at = now_rfc3339();
  let steps = openclaw_install_steps(method);
  OpenClawInstallTask {
    task_id: id,
    tool_id: "openclaw".to_string(),
    task_type: "install".to_string(),
    method: method.to_string(),
    command: command.to_string(),
    status: "running".to_string(),
    progress: 4,
    step_index: 0,
    summary: steps[0].description.clone(),
    hint: steps[0].hint.clone(),
    detail: "正在准备安装任务…".to_string(),
    steps,
    logs: Vec::new(),
    started_at: started_at.clone(),
    updated_at: started_at,
    completed_at: None,
    version: None,
    error: None,
    next_actions: Vec::new(),
    cancel_requested: false,
    child_pid: None,
    install_snapshot: OpenClawInstallSnapshot::default(),
  }
}

fn npm_global_output(args: &[&str]) -> String {
  create_command(npm_command())
    .args(args)
    .stdin(Stdio::null())
    .output()
    .ok()
    .filter(|output| output.status.success())
    .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
    .unwrap_or_default()
}

fn capture_openclaw_install_snapshot() -> OpenClawInstallSnapshot {
  let binary = find_tool_binary("openclaw");
  let home = openclaw_home().ok();
  let npm_prefix = if cfg!(target_os = "windows") { windows_user_npm_prefix().map(|p| p.to_string_lossy().to_string()).unwrap_or_default() } else { npm_global_output(&["prefix", "-g"]) };
  let npm_root = if cfg!(target_os = "windows") { windows_user_npm_prefix().map(|p| p.join("node_modules").to_string_lossy().to_string()).unwrap_or_default() } else { npm_global_output(&["root", "-g"]) };
  let package_path = if npm_root.is_empty() {
    String::new()
  } else {
    PathBuf::from(&npm_root).join(OPENCLAW_PACKAGE).to_string_lossy().to_string()
  };
  let bin_paths = if npm_prefix.is_empty() {
    Vec::new()
  } else if cfg!(target_os = "windows") {
    vec![
      PathBuf::from(&npm_prefix).join("openclaw").to_string_lossy().to_string(),
      PathBuf::from(&npm_prefix).join("openclaw.cmd").to_string_lossy().to_string(),
      PathBuf::from(&npm_prefix).join("openclaw.ps1").to_string_lossy().to_string(),
    ]
  } else {
    vec![PathBuf::from(&npm_prefix).join("bin").join("openclaw").to_string_lossy().to_string()]
  };

  OpenClawInstallSnapshot {
    had_binary: binary.get("installed").and_then(Value::as_bool).unwrap_or(false),
    home_path: home.as_ref().map(|path| path.to_string_lossy().to_string()).unwrap_or_default(),
    home_existed: home.as_ref().map(|path| path.exists()).unwrap_or(false),
    package_path,
    bin_paths,
  }
}

fn is_openclaw_install_active(task: &OpenClawInstallTask) -> bool {
  task.status == "running" || task.status == "cancelling"
}

fn is_openclaw_install_cancelled(task: &OpenClawInstallTask) -> bool {
  task.cancel_requested || task.status == "cancelling" || task.status == "cancelled"
}

fn trim_openclaw_install_tasks(tasks: &mut BTreeMap<String, OpenClawInstallTask>) {
  while tasks.len() > OPENCLAW_INSTALL_TASK_KEEP {
    let removable = tasks.iter().find(|(_, task)| !is_openclaw_install_active(task)).map(|(task_id, _)| task_id.clone());
    if let Some(task_id) = removable {
      tasks.remove(&task_id);
    } else {
      break;
    }
  }
}

fn insert_openclaw_install_task(task: OpenClawInstallTask) {
  let mut tasks = openclaw_install_tasks().lock().expect("openclaw tasks lock poisoned");
  tasks.insert(task.task_id.clone(), task);
  trim_openclaw_install_tasks(&mut tasks);
}

fn with_openclaw_install_task<R>(task_id: &str, mut update: impl FnMut(&mut OpenClawInstallTask) -> R) -> Option<R> {
  let mut tasks = openclaw_install_tasks().lock().expect("openclaw tasks lock poisoned");
  let task = tasks.get_mut(task_id)?;
  Some(update(task))
}

fn get_openclaw_install_task_snapshot(task_id: &str) -> Option<OpenClawInstallTask> {
  let tasks = openclaw_install_tasks().lock().expect("openclaw tasks lock poisoned");
  tasks.get(task_id).cloned()
}

fn touch_openclaw_install_task(task: &mut OpenClawInstallTask) {
  task.updated_at = now_rfc3339();
}

fn set_openclaw_install_step(task: &mut OpenClawInstallTask, step_index: usize, detail: Option<String>) {
  if task.steps.is_empty() {
    return;
  }
  let safe_index = step_index.min(task.steps.len().saturating_sub(1));
  if safe_index < task.step_index {
    return;
  }
  task.step_index = safe_index;
  task.progress = task.progress.max(task.steps[safe_index].progress);
  task.summary = task.steps[safe_index].description.clone();
  task.hint = task.steps[safe_index].hint.clone();
  if let Some(text) = detail {
    task.detail = text;
  }
  for (index, step) in task.steps.iter_mut().enumerate() {
    step.status = if index < safe_index {
      "done".to_string()
    } else if index == safe_index {
      "running".to_string()
    } else {
      "pending".to_string()
    };
  }
  touch_openclaw_install_task(task);
}

fn clean_openclaw_install_line(line: &str) -> String {
  line.replace('\u{1b}', "").trim().to_string()
}

fn push_openclaw_install_log(task_id: &str, source: &str, line: &str) {
  let cleaned = clean_openclaw_install_line(line);
  if cleaned.is_empty() {
    return;
  }
  let _ = with_openclaw_install_task(task_id, |task| {
    task.logs.push(OpenClawInstallLog {
      source: source.to_string(),
      text: cleaned.clone(),
      at: now_rfc3339(),
    });
    if task.logs.len() > 120 {
      let drain_len = task.logs.len() - 120;
      task.logs.drain(0..drain_len);
    }
    task.detail = cleaned.clone();
    infer_openclaw_install_step(task, &cleaned);
    touch_openclaw_install_task(task);
  });
}

fn infer_openclaw_install_step(task: &mut OpenClawInstallTask, line: &str) {
  let cleaned = clean_openclaw_install_line(line);
  let text = cleaned.to_lowercase();
  if task.method == "script" {
    if text.contains("[1/3]") || text.contains("preparing environment") || text.contains("homebrew") || text.contains("node.js") || text.contains("active npm") || text.contains("active node") {
      set_openclaw_install_step(task, 0, Some(cleaned));
      return;
    }
    if text.contains("curl") || text.contains("download") || text.contains("fetch") || text.contains("http://") || text.contains("https://") || text.contains("installer") || text.contains("install plan") {
      set_openclaw_install_step(task, 1, Some(cleaned));
      return;
    }
    if text.contains("[2/3]") || text.contains("installing openclaw") || text.contains("extract") || text.contains("copy") || text.contains("link") || text.contains("binary") || text.contains("daemon") || text.contains("git already installed") {
      set_openclaw_install_step(task, 2, Some(cleaned));
    }
    return;
  }

  if text.contains("fetch") || text.contains("tarball") || text.contains("manifest") || text.contains("registry") || text.contains("http") {
    set_openclaw_install_step(task, 1, Some(cleaned));
    return;
  }
  if text.contains("install") || text.contains("added") || text.contains("changed") || text.contains("build") || text.contains("postinstall") || text.contains("preinstall") || text.contains("link") || text.contains("reify") {
    set_openclaw_install_step(task, 2, Some(cleaned));
  }
}

fn terminate_openclaw_install_process(pid: u32) {
  if cfg!(target_os = "windows") {
    let _ = Command::new("taskkill")
      .args(["/PID", &pid.to_string(), "/T", "/F"])
      .stdin(Stdio::null())
      .output();
    return;
  }

  let _ = Command::new("pkill")
    .args(["-TERM", "-P", &pid.to_string()])
    .stdin(Stdio::null())
    .output();
  let _ = Command::new("kill")
    .args(["-TERM", &pid.to_string()])
    .stdin(Stdio::null())
    .output();
  thread::sleep(Duration::from_millis(900));
  let _ = Command::new("pkill")
    .args(["-KILL", "-P", &pid.to_string()])
    .stdin(Stdio::null())
    .output();
  let _ = Command::new("kill")
    .args(["-KILL", &pid.to_string()])
    .stdin(Stdio::null())
    .output();
}

fn cleanup_cancelled_openclaw_install(task: &mut OpenClawInstallTask) -> Vec<String> {
  let mut cleanup_errors = Vec::new();
  let snapshot = task.install_snapshot.clone();

  if !snapshot.had_binary {
    let _ = codex_npm_action(&["uninstall", "-g", OPENCLAW_PACKAGE]);
    for target in std::iter::once(snapshot.package_path.clone()).chain(snapshot.bin_paths.clone().into_iter()) {
      if target.trim().is_empty() {
        continue;
      }
      let path = PathBuf::from(&target);
      let remove_result = if path.is_dir() {
        std::fs::remove_dir_all(&path)
      } else {
        std::fs::remove_file(&path)
      };
      if let Err(error) = remove_result {
        if error.kind() != std::io::ErrorKind::NotFound {
          cleanup_errors.push(format!("删除 {} 失败：{}", target, error));
        }
      }
    }
  }

  if !snapshot.home_existed && !snapshot.home_path.trim().is_empty() {
    let home = PathBuf::from(&snapshot.home_path);
    if let Err(error) = std::fs::remove_dir_all(&home) {
      if error.kind() != std::io::ErrorKind::NotFound {
        cleanup_errors.push(format!("删除 {} 失败：{}", snapshot.home_path, error));
      }
    }
  }

  cleanup_errors
}

fn cancel_openclaw_install_task_inner(task_id: &str) -> Result<(), String> {
  let mut pid_to_kill = None;
  let exists = with_openclaw_install_task(task_id, |task| {
    if !is_openclaw_install_active(task) {
      return;
    }
    task.cancel_requested = true;
    task.status = "cancelling".to_string();
    task.summary = "正在中断 OpenClaw 安装…".to_string();
    task.hint = "先别关闭窗口，正在终止安装进程并清理残留。".to_string();
    task.detail = "正在停止安装进程…".to_string();
    pid_to_kill = task.child_pid;
    touch_openclaw_install_task(task);
  });
  if exists.is_none() {
    return Err("安装任务不存在，可能已经过期，请重新开始安装".to_string());
  }

  if let Some(pid) = pid_to_kill {
    terminate_openclaw_install_process(pid);
  }

  let _ = with_openclaw_install_task(task_id, |task| {
    let cleanup_errors = cleanup_cancelled_openclaw_install(task);
    for (index, step) in task.steps.iter_mut().enumerate() {
      step.status = if index < task.step_index {
        "done".to_string()
      } else if index == task.step_index {
        "error".to_string()
      } else {
        "pending".to_string()
      };
    }
    task.status = "cancelled".to_string();
    task.progress = 100;
    task.child_pid = None;
    task.error = if cleanup_errors.is_empty() { None } else { Some(cleanup_errors.join("；")) };
    task.summary = if task.error.is_some() {
      "安装已中断，但清理时遇到问题。".to_string()
    } else {
      "安装已中断，残留已清理。".to_string()
    };
    task.hint = if task.error.is_some() {
      "大部分安装已撤销，但还有少量路径需要你手动确认。".to_string()
    } else {
      "本次安装已彻底中断，你可以随时重新开始。".to_string()
    };
    task.detail = task.error.clone().unwrap_or_else(|| "未发现需要额外清理的残留。".to_string());
    task.next_actions = if task.error.is_some() {
      vec![
        "请先查看最后日志中的清理报错。".to_string(),
        "确认相关路径已删除后，再重新安装。".to_string(),
      ]
    } else {
      vec!["如需继续，请重新点击安装 OpenClaw。".to_string()]
    };
    task.completed_at = Some(now_rfc3339());
    touch_openclaw_install_task(task);
  });

  Ok(())
}

fn fail_openclaw_install_task(task_id: &str, message: String) {
  let _ = with_openclaw_install_task(task_id, |task| {
    if is_openclaw_install_cancelled(task) {
      return;
    }
    for (index, step) in task.steps.iter_mut().enumerate() {
      step.status = if index < task.step_index {
        "done".to_string()
      } else if index == task.step_index {
        "error".to_string()
      } else {
        "pending".to_string()
      };
    }
    task.status = "error".to_string();
    task.summary = "OpenClaw 安装失败，需要你看一眼错误提示。".to_string();
    task.hint = "先看下方“最后日志”，通常会直接告诉你缺的是网络、权限还是依赖。".to_string();
    task.detail = message.clone();
    task.child_pid = None;
    task.error = Some(message.clone());
    task.next_actions = vec![
      "先确认网络能访问 npm 或 openclaw.ai。".to_string(),
      "如果脚本安装失败，可改用 npm 安装。".to_string(),
      "如果 npm 安装失败，请检查 Node.js / npm 是否正常。".to_string(),
    ];
    task.completed_at = Some(now_rfc3339());
    touch_openclaw_install_task(task);
  });
}

fn complete_openclaw_install_task(task_id: &str, version: Option<String>) {
  let _ = with_openclaw_install_task(task_id, |task| {
    if is_openclaw_install_cancelled(task) {
      return;
    }
    if let Some(last_index) = task.steps.len().checked_sub(1) {
      task.step_index = last_index;
      for (index, step) in task.steps.iter_mut().enumerate() {
        step.status = if index <= last_index { "done".to_string() } else { "pending".to_string() };
      }
    }
    task.status = "success".to_string();
    task.progress = 100;
    task.summary = "OpenClaw 安装完成，已经可以使用。".to_string();
    task.hint = "现在你不用再做技术判断，直接按下面“接下来怎么做”操作就行。".to_string();
    task.detail = version.clone().map(|v| format!("已检测到版本：{v}")).unwrap_or_else(|| "已检测到 openclaw 命令。".to_string());
    task.child_pid = None;
    task.version = version.clone();
    task.next_actions = vec![
      "下一步 1：点击“启动 OpenClaw”打开工具。".to_string(),
      "下一步 2：首次使用建议执行 `openclaw onboard --install-daemon`。".to_string(),
      "下一步 3：如需改配置，可编辑 `~/.openclaw/openclaw.json`。".to_string(),
    ];
    task.completed_at = Some(now_rfc3339());
    touch_openclaw_install_task(task);
  });
}

fn spawn_openclaw_install_task_runner(task_id: String) {
  thread::spawn(move || {
    let task = match get_openclaw_install_task_snapshot(&task_id) {
      Some(task) => task,
      None => return,
    };

    let method = task.method.clone();
    let mut current_method = method.clone();
    let mut command = if current_method == "script" {
      if cfg!(target_os = "windows") {
        let mut cmd = create_command("powershell");
        cmd.args(["-Command", OPENCLAW_INSTALL_SCRIPT_WIN]);
        cmd
      } else {
        let mut cmd = create_command("bash");
        cmd.args(["-lc", OPENCLAW_INSTALL_SCRIPT_UNIX]);
        cmd
      }
    } else {
      let mut cmd = create_command(npm_command());
      apply_windows_openclaw_npm_env(&mut cmd, current_method == "domestic");
      if current_method == "domestic" {
        cmd.arg("--registry").arg(OPENCLAW_NPM_REGISTRY_CN);
      }
      cmd.args(["install", "-g", &format!("{}@latest", OPENCLAW_PACKAGE)]);
      cmd
    };

    if get_openclaw_install_task_snapshot(&task_id).map(|task| is_openclaw_install_cancelled(&task)).unwrap_or(false) {
      return;
    }

    if current_method == "script" {
      if !cfg!(target_os = "windows") && command_exists("curl").is_none() {
        fail_openclaw_install_task(&task_id, "未检测到 `curl`，无法执行脚本安装。请先安装 curl，或改用 npm 安装。".to_string());
        return;
      }
      if command_exists("git").is_none() {
        push_openclaw_install_log(&task_id, "stdout", "未检测到 Git，正在尝试自动安装…");

        let auto_installed = try_auto_install_git(&task_id);

        if !auto_installed {
          // Auto-install failed — try to fallback to domestic npm
          push_openclaw_install_log(&task_id, "stdout", "Git 自动安装失败，尝试自动切换为一键安装方式…");
          let node_ok = ensure_node_and_npm_available(&task_id);
          let npm_ok = command_exists(npm_command()).is_some();
          if node_ok && npm_ok {
            push_openclaw_install_log(&task_id, "stdout", &format!("已自动切换为一键安装方式，将使用国内 npm 源：{}", OPENCLAW_NPM_REGISTRY_CN));
            current_method = "domestic".to_string();
            // Rebuild command for npm
            command = {
              let mut cmd = create_command(npm_command());
              apply_windows_openclaw_npm_env(&mut cmd, true);
              cmd.arg("--registry").arg(OPENCLAW_NPM_REGISTRY_CN);
              cmd.args(["install", "-g", &format!("{}@latest", OPENCLAW_PACKAGE)]);
              cmd
            };
            // Update the task's method/command display
            let _ = with_openclaw_install_task(&task_id, |t| {
              t.method = "domestic".to_string();
              t.command = format!("{} install -g {}@latest --registry={}", npm_command(), OPENCLAW_PACKAGE, OPENCLAW_NPM_REGISTRY_CN);
              t.steps = openclaw_install_steps("domestic");
            });
          } else {
            let hint = if cfg!(target_os = "windows") {
              "脚本安装依赖 Git，自动安装失败且未找到 npm。请手动安装 Git (https://git-scm.com/download/win) 后重试。"
            } else {
              "脚本安装依赖 Git，自动安装失败且未找到 npm。请先安装 Git 后重试。"
            };
            fail_openclaw_install_task(&task_id, hint.to_string());
            return;
          }
        }
      }
    }

    if current_method == "domestic" {
      push_openclaw_install_log(&task_id, "stdout", &format!("已启用国内 npm 源：{}", OPENCLAW_NPM_REGISTRY_CN));
      if cfg!(target_os = "windows") && command_exists("git").is_none() {
        push_openclaw_install_log(&task_id, "stdout", "一键安装模式正在检查 Git，可选依赖将优先使用应用内 MinGit…");
        if !try_auto_install_git(&task_id) {
          push_openclaw_install_log(&task_id, "stderr", "应用内 Git 预安装失败，将继续尝试 npm 安装；如依赖需要 Git，日志会继续提示。");
        }
      }
    }

    if current_method == "npm" || current_method == "domestic" {
      let _ = ensure_node_and_npm_available(&task_id);
      let node_output = create_command("node").arg("--version").output();
      let npm_output = create_command(npm_command()).arg("--version").output();
      match (node_output, npm_output) {
        (Ok(node), Ok(npm)) if node.status.success() && npm.status.success() => {
          let node_version = String::from_utf8_lossy(&node.stdout).trim().to_string();
          let npm_version = String::from_utf8_lossy(&npm.stdout).trim().to_string();
          push_openclaw_install_log(&task_id, "stdout", &format!("Node.js {node_version} / npm {npm_version}"));
        }
        (Ok(_), Ok(_)) => {
          fail_openclaw_install_task(&task_id, "未检测到可用的 Node.js / npm，请先修复运行环境后重试。".to_string());
          return;
        }
        _ => {
          fail_openclaw_install_task(&task_id, "未检测到 Node.js 或 npm，请先安装 Node.js 18+。".to_string());
          return;
        }
      }
    }

    let _ = with_openclaw_install_task(&task_id, |task| {
      set_openclaw_install_step(task, 1, Some(format!("即将执行：{}", task.command)));
    });

    command.env("PATH", full_path_env());
    if current_method == "npm" || current_method == "domestic" {
      apply_windows_openclaw_npm_env(&mut command, current_method == "domestic");
    }
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match command.spawn() {
      Ok(child) => child,
      Err(error) => {
        fail_openclaw_install_task(&task_id, error.to_string());
        return;
      }
    };

    let _ = with_openclaw_install_task(&task_id, |task| {
      task.child_pid = Some(child.id());
      touch_openclaw_install_task(task);
    });

    let stdout_handle = child.stdout.take().map(|stdout| {
      let task_id = task_id.clone();
      thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
          push_openclaw_install_log(&task_id, "stdout", &line);
        }
      })
    });

    let stderr_handle = child.stderr.take().map(|stderr| {
      let task_id = task_id.clone();
      thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
          push_openclaw_install_log(&task_id, "stderr", &line);
        }
      })
    });

    let status = match child.wait() {
      Ok(status) => status,
      Err(error) => {
        fail_openclaw_install_task(&task_id, error.to_string());
        return;
      }
    };

    if let Some(handle) = stdout_handle { let _ = handle.join(); }
    if let Some(handle) = stderr_handle { let _ = handle.join(); }

    if get_openclaw_install_task_snapshot(&task_id).map(|task| is_openclaw_install_cancelled(&task)).unwrap_or(false) {
      return;
    }

    if !status.success() {
      let message = get_openclaw_install_task_snapshot(&task_id)
        .and_then(|task| task.logs.last().map(|item| item.text.clone()))
        .unwrap_or_else(|| format!("安装命令退出码：{}", status.code().map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string())));
      fail_openclaw_install_task(&task_id, message);
      return;
    }

    let _ = with_openclaw_install_task(&task_id, |task| {
      set_openclaw_install_step(task, 3, Some("安装命令已执行完成，正在验证 openclaw 命令…".to_string()));
    });

    if get_openclaw_install_task_snapshot(&task_id).map(|task| is_openclaw_install_cancelled(&task)).unwrap_or(false) {
      return;
    }

    let binary = find_tool_binary("openclaw");
    if !binary.get("installed").and_then(Value::as_bool).unwrap_or(false) {
      fail_openclaw_install_task(&task_id, "安装命令已执行完成，但系统里仍未找到 `openclaw` 命令。".to_string());
      return;
    }

    complete_openclaw_install_task(&task_id, binary.get("version").and_then(Value::as_str).map(|s| s.to_string()));
  });
}

fn parse_git_windows_release_candidates(listing: &str) -> Vec<String> {
  let mut releases = Vec::new();
  for token in listing.split(|ch| ch == '"' || ch == '\'' || ch == '<' || ch == '>' || ch == ' ' || ch == '\n' || ch == '\r') {
    let name = token.rsplit('/').next().unwrap_or(token).trim().trim_end_matches('/');
    if name.starts_with('v') && name.contains(".windows.") {
      releases.push(name.to_string());
    }
  }
  releases.sort_by(|left, right| {
    let left_trimmed = left.trim_start_matches('v');
    let right_trimmed = right.trim_start_matches('v');
    let (left_core, left_rev) = left_trimmed.rsplit_once(".windows.").unwrap_or((left_trimmed, "0"));
    let (right_core, right_rev) = right_trimmed.rsplit_once(".windows.").unwrap_or((right_trimmed, "0"));
    compare_versions(left_core, right_core)
      .then_with(|| left_rev.parse::<u32>().unwrap_or(0).cmp(&right_rev.parse::<u32>().unwrap_or(0)))
  });
  releases.dedup();
  releases
}

fn parse_mingit_asset_candidates(listing: &str) -> Vec<String> {
  let mut assets = Vec::new();
  for token in listing.split(|ch| ch == '"' || ch == '\'' || ch == '<' || ch == '>' || ch == ' ' || ch == '\n' || ch == '\r') {
    if !token.contains("MinGit-") || !token.ends_with("-64-bit.zip") {
      continue;
    }
    let name = token.rsplit('/').next().unwrap_or(token).trim();
    if name.starts_with("MinGit-") && name.ends_with("-64-bit.zip") {
      assets.push(name.to_string());
    }
  }
  assets.sort();
  assets.dedup();
  assets
}

fn resolve_mingit_download_urls(task_id: &str) -> Result<Vec<String>, String> {
  let bases = [
    "https://repo.huaweicloud.com/git-for-windows/",
    "https://repo.huaweicloud.com/repository/toolkit/git-for-windows/",
  ];
  let client = reqwest::blocking::Client::builder()
    .timeout(Duration::from_secs(20))
    .user_agent("EasyAIConfig/1.0.13")
    .build()
    .map_err(|error| error.to_string())?;

  let mut urls = Vec::new();
  for base in bases {
    push_openclaw_install_log(task_id, "stdout", &format!("正在获取华为云 Git 镜像目录：{}", base));
    let base_listing = match client.get(base).send().and_then(|response| response.error_for_status()) {
      Ok(response) => match response.text() {
        Ok(text) => text,
        Err(error) => {
          push_openclaw_install_log(task_id, "stderr", &format!("华为云目录读取失败：{}", error));
          continue;
        }
      },
      Err(error) => {
        push_openclaw_install_log(task_id, "stderr", &format!("华为云目录访问失败：{}", error));
        continue;
      }
    };

    let latest_release = match parse_git_windows_release_candidates(&base_listing).into_iter().next_back() {
      Some(release) => release,
      None => {
        push_openclaw_install_log(task_id, "stderr", "华为云目录中未找到 Git for Windows 版本");
        continue;
      }
    };

    let release_url = format!("{}{}/", base, latest_release);
    push_openclaw_install_log(task_id, "stdout", &format!("正在获取华为云版本目录：{}", release_url));
    let release_listing = match client.get(&release_url).send().and_then(|response| response.error_for_status()) {
      Ok(response) => match response.text() {
        Ok(text) => text,
        Err(error) => {
          push_openclaw_install_log(task_id, "stderr", &format!("华为云版本目录读取失败：{}", error));
          continue;
        }
      },
      Err(error) => {
        push_openclaw_install_log(task_id, "stderr", &format!("华为云版本目录访问失败：{}", error));
        continue;
      }
    };

    let mut assets = parse_mingit_asset_candidates(&release_listing);
    assets.sort_by(|left, right| {
      let lv = left.trim_start_matches("MinGit-").trim_end_matches("-64-bit.zip");
      let rv = right.trim_start_matches("MinGit-").trim_end_matches("-64-bit.zip");
      compare_versions(lv, rv)
    });
    if let Some(asset) = assets.into_iter().next_back() {
      urls.push(format!("{}{}", release_url, asset));
    }
  }

  urls.sort();
  urls.dedup();
  if urls.is_empty() {
    Err("未能从华为云镜像获取 MinGit 下载地址".to_string())
  } else {
    Ok(urls)
  }
}

fn download_archive(url: &str, archive_path: &Path) -> Result<(), String> {
  let client = reqwest::blocking::Client::builder()
    .timeout(Duration::from_secs(180))
    .user_agent("EasyAIConfig/1.0.13")
    .build()
    .map_err(|error| error.to_string())?;
  let mut response = client.get(url).send().map_err(|error| error.to_string())?;
  if !response.status().is_success() {
    return Err(format!("下载失败，HTTP {}", response.status()));
  }

  let mut file = File::create(archive_path).map_err(|error| error.to_string())?;
  response.copy_to(&mut file).map_err(|error| error.to_string())?;
  file.flush().map_err(|error| error.to_string())?;

  let data = fs::read(archive_path).map_err(|error| error.to_string())?;
  if data.len() < 4 || &data[..2] != b"PK" {
    return Err("下载内容不是有效的 ZIP 文件".to_string());
  }
  Ok(())
}

fn extract_zip_archive(archive_path: &Path, destination: &Path) -> Result<(), String> {
  if destination.exists() {
    fs::remove_dir_all(destination).map_err(|error| error.to_string())?;
  }
  ensure_dir(destination)?;

  let file = File::open(archive_path).map_err(|error| error.to_string())?;
  let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
  for index in 0..archive.len() {
    let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
    let Some(safe_name) = entry.enclosed_name().map(|path| path.to_path_buf()) else {
      continue;
    };
    let output_path = destination.join(safe_name);
    if entry.is_dir() {
      ensure_dir(&output_path)?;
      continue;
    }
    if let Some(parent) = output_path.parent() {
      ensure_dir(parent)?;
    }
    let mut output = File::create(&output_path).map_err(|error| error.to_string())?;
    std::io::copy(&mut entry, &mut output).map_err(|error| error.to_string())?;
    output.flush().map_err(|error| error.to_string())?;
  }
  Ok(())
}

fn install_mingit_from_mirror(task_id: &str) -> bool {
  let Some(root) = windows_mingit_root() else {
    push_openclaw_install_log(task_id, "stderr", "无法确定 MinGit 安装目录");
    return false;
  };
  let tools_dir = match root.parent() {
    Some(path) => path.to_path_buf(),
    None => {
      push_openclaw_install_log(task_id, "stderr", "无法确定 MinGit 工具目录");
      return false;
    }
  };
  if let Err(error) = ensure_dir(&tools_dir) {
    push_openclaw_install_log(task_id, "stderr", &format!("创建工具目录失败：{}", error));
    return false;
  }

  let archive_path = tools_dir.join("MinGit.zip");
  let download_urls = match resolve_mingit_download_urls(task_id) {
    Ok(urls) => urls,
    Err(error) => {
      push_openclaw_install_log(task_id, "stderr", &error);
      return false;
    }
  };

  let mut last_error = None;
  for download_url in download_urls {
    push_openclaw_install_log(task_id, "stdout", &format!("正在下载 MinGit：{}", download_url));
    if archive_path.exists() {
      let _ = fs::remove_file(&archive_path);
    }
    match download_archive(&download_url, &archive_path) {
      Ok(()) => {}
      Err(error) => {
        push_openclaw_install_log(task_id, "stderr", &format!("MinGit 下载失败：{}", error));
        last_error = Some(error);
        continue;
      }
    }
    if let Err(error) = extract_zip_archive(&archive_path, &root) {
      push_openclaw_install_log(task_id, "stderr", &format!("MinGit 解压失败：{}", error));
      last_error = Some(error);
      continue;
    }
    if !root.join("cmd").join("git.exe").exists() {
      let error = "MinGit 解压完成，但未找到 git.exe".to_string();
      push_openclaw_install_log(task_id, "stderr", &error);
      last_error = Some(error);
      continue;
    }
    if command_exists("git").is_some() {
      push_openclaw_install_log(task_id, "stdout", "✓ 已自动安装 MinGit，将使用应用内置 Git");
      return true;
    }
    let error = "MinGit 已下载，但仍未检测到 git 命令".to_string();
    push_openclaw_install_log(task_id, "stderr", &error);
    last_error = Some(error);
  }

  if let Some(error) = last_error {
    push_openclaw_install_log(task_id, "stderr", &format!("MinGit 所有下载源均失败：{}", error));
  }
  false
}

fn resolve_portable_node_download_url(task_id: &str) -> Result<String, String> {
  let shasums_url = "https://cdn.npmmirror.com/binaries/node/latest-v22.x/SHASUMS256.txt";
  push_openclaw_install_log(task_id, "stdout", &format!("正在获取 Node.js 镜像索引：{}", shasums_url));
  let client = reqwest::blocking::Client::builder()
    .timeout(Duration::from_secs(20))
    .build()
    .map_err(|error| error.to_string())?;
  let body = client
    .get(shasums_url)
    .send()
    .and_then(|response| response.error_for_status())
    .map_err(|error| error.to_string())?
    .text()
    .map_err(|error| error.to_string())?;
  let asset = body
    .lines()
    .filter_map(|line| line.split_whitespace().last())
    .find(|name| name.starts_with("node-v") && name.ends_with("-win-x64.zip"))
    .ok_or_else(|| "未能从镜像索引中找到可用的 Node.js win-x64.zip".to_string())?;
  Ok(format!("https://cdn.npmmirror.com/binaries/node/latest-v22.x/{}", asset))
}

fn install_portable_node_from_mirror(task_id: &str) -> bool {
  let Some(root) = windows_portable_node_root() else {
    push_openclaw_install_log(task_id, "stderr", "无法确定便携版 Node.js 安装目录");
    return false;
  };
  let tools_dir = match root.parent() {
    Some(path) => path.to_path_buf(),
    None => {
      push_openclaw_install_log(task_id, "stderr", "无法确定便携版 Node.js 工具目录");
      return false;
    }
  };
  if let Err(error) = ensure_dir(&tools_dir) {
    push_openclaw_install_log(task_id, "stderr", &format!("创建 Node.js 工具目录失败：{}", error));
    return false;
  }

  let archive_path = tools_dir.join("node-win-x64.zip");
  let download_url = match resolve_portable_node_download_url(task_id) {
    Ok(url) => url,
    Err(error) => {
      push_openclaw_install_log(task_id, "stderr", &error);
      return false;
    }
  };

  push_openclaw_install_log(task_id, "stdout", &format!("正在下载便携版 Node.js：{}", download_url));
  if archive_path.exists() {
    let _ = fs::remove_file(&archive_path);
  }
  if let Err(error) = download_archive(&download_url, &archive_path) {
    push_openclaw_install_log(task_id, "stderr", &format!("便携版 Node.js 下载失败：{}", error));
    return false;
  }
  if let Err(error) = extract_zip_archive(&archive_path, &root) {
    push_openclaw_install_log(task_id, "stderr", &format!("便携版 Node.js 解压失败：{}", error));
    return false;
  }
  if windows_portable_node_dirs().is_empty() {
    push_openclaw_install_log(task_id, "stderr", "便携版 Node.js 解压完成，但未找到 node.exe");
    return false;
  }

  let node_ok = command_exists("node").is_some();
  let npm_ok = command_exists(npm_command()).is_some();
  if node_ok && npm_ok {
    push_openclaw_install_log(task_id, "stdout", "✓ 已自动安装便携版 Node.js / npm，将使用应用内置运行时");
    return true;
  }

  push_openclaw_install_log(task_id, "stderr", "便携版 Node.js 已下载，但仍未检测到 node / npm");
  false
}

fn ensure_node_and_npm_available(task_id: &str) -> bool {
  let node_ok = command_exists("node").is_some();
  let npm_ok = command_exists(npm_command()).is_some();
  if node_ok && npm_ok {
    return true;
  }
  if cfg!(target_os = "windows") {
    push_openclaw_install_log(task_id, "stdout", "未检测到可用的 Node.js / npm，正在尝试自动安装便携版 Node.js…");
    return install_portable_node_from_mirror(task_id);
  }
  false
}

fn apply_windows_openclaw_npm_env(command: &mut Command, use_cn_registry: bool) {
  if !cfg!(target_os = "windows") {
    return;
  }
  if let Some(prefix) = windows_user_npm_prefix() {
    let prefix_str = prefix.to_string_lossy().to_string();
    let mut path_parts = vec![prefix_str.clone()];
    let current = full_path_env();
    path_parts.extend(current.split(';').filter(|entry| !entry.trim().is_empty()).map(|entry| entry.trim().to_string()));
    let mut seen = HashSet::new();
    path_parts.retain(|entry| seen.insert(entry.to_ascii_lowercase()));
    command.env("NPM_CONFIG_PREFIX", &prefix_str);
    command.env("npm_config_prefix", &prefix_str);
    command.env("PATH", path_parts.join(";"));
    if use_cn_registry {
      command.env("NPM_CONFIG_REGISTRY", OPENCLAW_NPM_REGISTRY_CN);
      command.env("npm_config_registry", OPENCLAW_NPM_REGISTRY_CN);
    }
  }
}

fn command_exists(command: &str) -> Option<String> {
  // Set PATH before using which
  std::env::set_var("PATH", full_path_env());
  which::which(command).ok().map(|path| path.to_string_lossy().to_string())
}

/// Try to install Git automatically. Returns true if Git becomes available after the attempt.
fn try_auto_install_git(task_id: &str) -> bool {
  if command_exists("git").is_some() {
    push_openclaw_install_log(task_id, "stdout", "✓ 已检测到现有 Git，直接使用用户环境中的 Git");
    return true;
  }

  if cfg!(target_os = "windows") {
    push_openclaw_install_log(task_id, "stdout", "正在通过 winget 安装 Git…");
    let result = create_command("winget")
      .args([
        "install", "--id", "Git.Git", "-e",
        "--source", "winget",
        "--accept-source-agreements",
        "--accept-package-agreements",
      ])
      .stdin(Stdio::null())
      .output();

    match result {
      Ok(out) => {
        let stdout_text = String::from_utf8_lossy(&out.stdout).to_string();
        let stderr_text = String::from_utf8_lossy(&out.stderr).to_string();
        if !stdout_text.trim().is_empty() {
          push_openclaw_install_log(task_id, "stdout", stdout_text.trim());
        }
        if !stderr_text.trim().is_empty() {
          push_openclaw_install_log(task_id, "stderr", stderr_text.trim());
        }
        if out.status.success() {
          push_openclaw_install_log(task_id, "stdout", "winget 安装命令已完成，正在验证 Git…");
          let current_path = std::env::var("PATH").unwrap_or_default();
          let git_paths = "C:\\Program Files\\Git\\cmd;C:\\Program Files\\Git\\bin;C:\\Program Files (x86)\\Git\\cmd";
          std::env::set_var("PATH", format!("{};{}", git_paths, current_path));
          if command_exists("git").is_some() {
            push_openclaw_install_log(task_id, "stdout", "✓ Git 已安装成功");
            return true;
          }
          push_openclaw_install_log(task_id, "stderr", "winget 已执行但仍未检测到 Git，尝试安装内置 MinGit…");
        } else {
          push_openclaw_install_log(task_id, "stderr", "winget 安装 Git 失败，尝试安装内置 MinGit…");
        }
      }
      Err(e) => {
        push_openclaw_install_log(task_id, "stderr", &format!("winget 不可用或执行出错：{}", e));
      }
    }

    return install_mingit_from_mirror(task_id);
  } else if cfg!(target_os = "macos") {
    // Try Homebrew
    if command_exists("brew").is_some() {
      push_openclaw_install_log(task_id, "stdout", "正在通过 Homebrew 安装 Git…");
      let result = create_command("brew")
        .args(["install", "git"])
        .stdin(Stdio::null())
        .output();

      match result {
        Ok(out) => {
          let stdout_text = String::from_utf8_lossy(&out.stdout).to_string();
          if !stdout_text.trim().is_empty() {
            // Only log last few lines to avoid flooding
            for line in stdout_text.lines().rev().take(3).collect::<Vec<_>>().into_iter().rev() {
              push_openclaw_install_log(task_id, "stdout", line);
            }
          }
          if out.status.success() {
            push_openclaw_install_log(task_id, "stdout", "✓ Git 已通过 Homebrew 安装成功");
            // brew install git will place it in PATH via /opt/homebrew/bin or /usr/local/bin
            // which are already in full_path_env, so it should be findable
            if command_exists("git").is_some() {
              return true;
            }
          } else {
            let stderr_text = String::from_utf8_lossy(&out.stderr).to_string();
            push_openclaw_install_log(task_id, "stderr", &format!("brew install git 失败：{}", stderr_text.trim()));
          }
        }
        Err(e) => {
          push_openclaw_install_log(task_id, "stderr", &format!("brew 执行出错：{}", e));
        }
      }
    } else {
      push_openclaw_install_log(task_id, "stderr", "未检测到 Homebrew，无法自动安装 Git");
    }
  } else {
    // Linux — don't try to auto-install (needs sudo)
    push_openclaw_install_log(task_id, "stderr", "Linux 上需要手动安装 Git（如 sudo apt install git）");
  }

  false
}

fn codex_candidates() -> Vec<String> {
  let mut paths = which::which_all("codex")
    .map(|items| items.map(|item| item.to_string_lossy().to_string()).collect::<Vec<_>>())
    .unwrap_or_default();

  if cfg!(not(target_os = "windows")) {
    if let Ok(home) = home_dir() {
      paths.push(home.join(".npm-global/bin/codex").to_string_lossy().to_string());
    }
    paths.push("/usr/local/bin/codex".to_string());
    paths.push("/opt/homebrew/bin/codex".to_string());
  }

  paths.sort();
  paths.dedup();
  paths
}

pub(crate) fn find_codex_binary() -> Value {
  let mut candidates = codex_candidates()
    .into_iter()
    .filter_map(|candidate_path| {
      let output = create_command(&candidate_path).arg("--version").output().ok()?;
      if !output.status.success() {
        return None;
      }
      let version_output = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
      )
      .trim()
      .to_string();
      Some(json!({
        "path": candidate_path,
        "installed": true,
        "version": version_output,
      }))
    })
    .collect::<Vec<_>>();

  candidates.sort_by(|left, right| {
    let left_version = left.get("version").and_then(Value::as_str).unwrap_or_default();
    let right_version = right.get("version").and_then(Value::as_str).unwrap_or_default();
    compare_versions(right_version, left_version)
  });

  let selected = candidates.first().cloned();
  json!({
    "installed": selected.is_some(),
    "version": selected.as_ref().and_then(|item| item.get("version")).cloned().unwrap_or(Value::Null),
    "path": selected
      .as_ref()
      .and_then(|item| item.get("path").and_then(Value::as_str).map(|text| text.to_string()))
      .or_else(|| command_exists("codex"))
      .unwrap_or_default(),
    "candidates": candidates,
    "installCommand": format!("{} install -g {}", npm_command(), OPENAI_CODEX_PACKAGE),
  })
}

pub(crate) fn codex_npm_action(args: &[&str]) -> Result<Value, String> {
  let result = run_command(npm_command(), args, None)?;
  Ok(json!({
    "ok": result.get("ok").and_then(Value::as_bool).unwrap_or(false),
    "code": result.get("code").cloned().unwrap_or(Value::Null),
    "stdout": result.get("stdout").cloned().unwrap_or(Value::String(String::new())),
    "stderr": result.get("stderr").cloned().unwrap_or(Value::String(String::new())),
    "command": format!("{} {}", npm_command(), args.join(" ")),
  }))
}

fn escape_applescript(text: &str) -> String {
  text.replace('\\', "\\\\").replace('"', "\\\"")
}

fn launch_codex_terminal_command(cwd: &Path) -> Result<String, String> {
  let codex_binary = find_codex_binary();
  let codex_path = codex_binary
    .get("path")
    .and_then(Value::as_str)
    .filter(|path| !path.is_empty())
    .unwrap_or("codex");
  let cwd_text = cwd.to_string_lossy().to_string();

  if cfg!(target_os = "macos") {
    let script = [
      "tell application \"Terminal\"",
      "activate",
      &format!(
        "do script \"cd {} && {}\"",
        escape_applescript(&cwd_text),
        escape_applescript(codex_path)
      ),
      "end tell",
    ]
    .join("\n");

    let output = create_command("osascript")
      .arg("-e")
      .arg(script)
      .output()
      .map_err(|error| error.to_string())?;
    if !output.status.success() {
      return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    return Ok("Codex 已在 Terminal 中启动".to_string());
  }

  if cfg!(target_os = "windows") {
    create_command("cmd.exe")
      .args([
        "/c",
        "start",
        "",
        "cmd",
        "/k",
        &format!("cd /d \"{}\" && \"{}\"", cwd_text, codex_path),
      ])
      .spawn()
      .map_err(|error| error.to_string())?;
    return Ok("Codex 已在新命令窗口中启动".to_string());
  }

  let terminals = vec![
    ("x-terminal-emulator", vec!["-e".to_string(), format!("bash -lc \"cd '{}' && '{}'\"", cwd_text, codex_path)]),
    ("gnome-terminal", vec!["--".to_string(), "bash".to_string(), "-lc".to_string(), format!("cd '{}' && '{}'", cwd_text, codex_path)]),
    ("konsole", vec!["-e".to_string(), "bash".to_string(), "-lc".to_string(), format!("cd '{}' && '{}'", cwd_text, codex_path)]),
  ];

  for (command, args) in terminals {
    if command_exists(command).is_none() {
      continue;
    }
    create_command(command)
      .args(args)
      .spawn()
      .map_err(|error| error.to_string())?;
    return Ok("Codex 已在新终端中启动".to_string());
  }

  Err("没有找到可用终端，请先手动运行 codex".to_string())
}


pub(crate) fn get_codex_release_info() -> Result<Value, String> {
  let result = codex_npm_action(&["view", OPENAI_CODEX_PACKAGE, "dist-tags", "--json"])?;
  if !result.get("ok").and_then(Value::as_bool).unwrap_or(false) {
    let message = result
      .get("stderr")
      .and_then(Value::as_str)
      .filter(|text| !text.trim().is_empty())
      .or_else(|| result.get("stdout").and_then(Value::as_str))
      .unwrap_or("获取版本信息失败")
      .trim()
      .to_string();
    return Err(message);
  }

  let tags = serde_json::from_str::<Value>(result.get("stdout").and_then(Value::as_str).unwrap_or("{}"))
    .unwrap_or_else(|_| json!({}));
  let current = find_codex_binary();
  let current_version = current
    .get("version")
    .and_then(Value::as_str)
    .and_then(extract_version);
  let latest_stable = tags.get("latest").and_then(Value::as_str).map(|text| text.to_string());
  let latest_alpha = tags.get("alpha").and_then(Value::as_str).map(|text| text.to_string());

  let has_stable_update = match (&current_version, &latest_stable) {
    (Some(current), Some(latest)) => compare_versions(latest, current) == Ordering::Greater,
    _ => false,
  };
  let has_alpha_update = match (&current_version, &latest_alpha) {
    (Some(current), Some(latest)) => compare_versions(latest, current) == Ordering::Greater,
    _ => false,
  };

  Ok(json!({
    "currentVersion": current_version,
    "latestStable": latest_stable,
    "latestAlpha": latest_alpha,
    "hasStableUpdate": has_stable_update,
    "hasAlphaUpdate": has_alpha_update,
    "isInstalled": current.get("installed").and_then(Value::as_bool).unwrap_or(false),
  }))
}

pub(crate) fn launch_codex(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let cwd = {
    let input = get_string(&object, "cwd");
    if input.is_empty() { home_dir()? } else { PathBuf::from(input) }
  };
  let codex_binary = find_codex_binary();
  if !codex_binary.get("installed").and_then(Value::as_bool).unwrap_or(false) {
    return Err("Codex 尚未安装，请先点击安装".to_string());
  }
  let message = launch_codex_terminal_command(&cwd)?;
  Ok(json!({ "ok": true, "cwd": cwd.to_string_lossy().to_string(), "message": message }))
}

pub(crate) fn check_setup_environment(query: &Value) -> Result<Value, String> {
  let query_object = parse_json_object(query);
  let codex_home = {
    let input = get_string(&query_object, "codexHome");
    if input.is_empty() { default_codex_home()? } else { PathBuf::from(input) }
  };

  // 1. Check Node.js
  let node_output = create_command("node").arg("--version").output();
  let (node_installed, node_version, node_major) = match node_output {
    Ok(output) if output.status.success() => {
      let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
      let major = version
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
      (true, Some(version), major)
    }
    _ => (false, None, 0),
  };

  // 2. Check npm
  let npm_output = create_command(npm_command()).arg("--version").output();
  let (npm_installed, npm_version) = match npm_output {
    Ok(output) if output.status.success() => {
      let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
      (true, Some(version))
    }
    _ => (false, None),
  };

  // 3. Check codex binary
  let codex_binary = find_codex_binary();
  let codex_installed = codex_binary.get("installed").and_then(Value::as_bool).unwrap_or(false);

  // 4. Check config files
  let global_config_path = codex_home.join("config.toml");
  let global_env_path = codex_home.join(".env");
  let config_content = read_text(&global_config_path)?;
  let env_content = read_text(&global_env_path)?;
  let config_exists = !config_content.trim().is_empty();
  let env_exists = !env_content.trim().is_empty();

  // 5. Check if there are any providers configured
  let (has_providers, has_active_provider) = if config_exists {
    match parse_toml_config(&config_content) {
      Ok(config) => {
        let providers = config
          .get("model_providers")
          .and_then(Value::as_object)
          .map(|p| !p.is_empty())
          .unwrap_or(false);
        let active = config
          .get("model_provider")
          .and_then(Value::as_str)
          .map(|s| !s.is_empty())
          .unwrap_or(false);
        (providers, active)
      }
      Err(_) => (false, false),
    }
  } else {
    (false, false)
  };

  let needs_setup = !codex_installed || !config_exists || !has_providers;

  Ok(json!({
    "node": {
      "installed": node_installed,
      "version": node_version,
      "major": node_major,
      "sufficient": node_major >= 18,
    },
    "npm": {
      "installed": npm_installed,
      "version": npm_version,
    },
    "codex": {
      "installed": codex_installed,
      "version": codex_binary.get("version").cloned().unwrap_or(Value::Null),
      "path": codex_binary.get("path").cloned().unwrap_or(Value::Null),
    },
    "config": {
      "exists": config_exists,
      "envExists": env_exists,
      "hasProviders": has_providers,
      "hasActiveProvider": has_active_provider,
      "configPath": global_config_path.to_string_lossy().to_string(),
      "envPath": global_env_path.to_string_lossy().to_string(),
    },
    "needsSetup": needs_setup,
    "codexHome": codex_home.to_string_lossy().to_string(),
  }))
}
use crate::{
  app_home, compare_versions, default_codex_home, extract_version, home_dir, npm_command,
  parse_json_object, parse_toml_config, read_text, OPENAI_CODEX_PACKAGE,
  claude_code_home, openclaw_home, write_text, ensure_dir, CLAUDE_CODE_PACKAGE,
  OPENCLAW_PACKAGE,
};
use crate::provider::get_string;

/* ═══════════════  Multi-tool support  ═══════════════ */

fn find_tool_binary(binary_name: &str) -> Value {
  // Set PATH before using which
  std::env::set_var("PATH", full_path_env());
  let bin_path = which::which(binary_name)
    .ok()
    .map(|p| p.to_string_lossy().to_string());

  if let Some(ref path) = bin_path {
    let output = create_command(path).arg("--version").output();
    if let Ok(out) = output {
      if out.status.success() {
        let version = format!(
          "{}{}",
          String::from_utf8_lossy(&out.stdout),
          String::from_utf8_lossy(&out.stderr)
        ).trim().to_string();
        return json!({
          "installed": true,
          "version": version,
          "path": path,
        });
      }
    }
  }

  json!({
    "installed": false,
    "version": Value::Null,
    "path": Value::Null,
  })
}

pub(crate) fn list_tools() -> Result<Value, String> {
  let codex_binary = find_codex_binary();
  let claude_binary = find_tool_binary("claude");
  let openclaw_binary = find_tool_binary("openclaw");

  Ok(json!([
    {
      "id": "codex",
      "name": "Codex CLI",
      "description": "OpenAI 官方 AI 编程助手",
      "supported": true,
      "configFormat": "toml",
      "installMethod": "npm",
      "npmPackage": OPENAI_CODEX_PACKAGE,
      "binary": codex_binary,
    },
    {
      "id": "claudecode",
      "name": "Claude Code",
      "description": "Anthropic 终端原生 AI 编程助手",
      "supported": true,
      "configFormat": "json",
      "installMethod": "npm",
      "npmPackage": CLAUDE_CODE_PACKAGE,
      "binary": claude_binary,
    },
    {
      "id": "openclaw",
      "name": "OpenClaw",
      "description": "开源多渠道 AI 助手平台",
      "supported": true,
      "configFormat": "json",
      "installMethod": "multi",
      "npmPackage": OPENCLAW_PACKAGE,
      "installMethods": if cfg!(target_os = "windows") {
        json!(["domestic", "wsl", "script"])
      } else {
        json!(["script", "npm", "source", "docker"])
      },
      "binary": openclaw_binary,
    },
  ]))
}

/* ═══════════════  Claude Code  ═══════════════ */

/// Read Anthropic env vars from the user's login shell.
/// Tauri .app bundles don't inherit shell exports, so we must read them explicitly.
fn read_shell_anthropic_env() -> std::collections::HashMap<String, String> {
  let mut result = std::collections::HashMap::new();

  if cfg!(target_os = "windows") {
    // On Windows, env vars are usually inherited
    for var in &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"] {
      if let Ok(val) = std::env::var(var) {
        if !val.trim().is_empty() {
          result.insert(var.to_string(), val);
        }
      }
    }
    return result;
  }

  let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
  // Use a separator to split multiple values from one shell invocation
  let script = r#"echo "___AK=${ANTHROPIC_API_KEY}___AT=${ANTHROPIC_AUTH_TOKEN}___BU=${ANTHROPIC_BASE_URL}___""#;
  let output = create_command(&shell)
    .args(["-lc", script])
    .output()
    .ok()
    .filter(|o| o.status.success())
    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    .unwrap_or_default();

  fn extract(output: &str, prefix: &str, suffix: &str) -> String {
    output
      .find(prefix)
      .and_then(|start| {
        let val_start = start + prefix.len();
        output[val_start..].find(suffix).map(|end| output[val_start..val_start + end].to_string())
      })
      .unwrap_or_default()
  }

  let ak = extract(&output, "___AK=", "___AT=");
  let at = extract(&output, "___AT=", "___BU=");
  let bu = extract(&output, "___BU=", "___");

  if !ak.is_empty() { result.insert("ANTHROPIC_API_KEY".to_string(), ak); }
  if !at.is_empty() { result.insert("ANTHROPIC_AUTH_TOKEN".to_string(), at); }
  if !bu.is_empty() { result.insert("ANTHROPIC_BASE_URL".to_string(), bu); }

  result
}

fn read_json_file(path: &Path) -> Result<Value, String> {
  let content = read_text(path)?;
  let trimmed = content.trim();
  if trimmed.is_empty() {
    return Ok(json!({}));
  }
  serde_json::from_str(trimmed).map_err(|e| e.to_string())
}

fn write_json_file(path: &Path, data: &Value) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    ensure_dir(parent)?;
  }
  let content = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
  write_text(path, &format!("{}\n", content))
}

pub(crate) fn load_claudecode_state() -> Result<Value, String> {
  let home = claude_code_home()?;
  let settings_path = home.join("settings.json");
  let settings = read_json_file(&settings_path)?;
  let binary = find_tool_binary("claude");

  let model = settings.get("model").and_then(Value::as_str).unwrap_or("").to_string();
  let always_thinking = settings.get("alwaysThinkingEnabled").and_then(Value::as_bool).unwrap_or(false);
  let skip_dangerous = settings.get("skipDangerousModePermissionPrompt").and_then(Value::as_bool).unwrap_or(false);
  let settings_json = serde_json::to_string_pretty(&settings).unwrap_or_else(|_| "{}".to_string());

  // Read env from settings
  let settings_env = settings.get("env").cloned().unwrap_or(json!({}));

  // ── Read Anthropic env vars from all sources ──
  // Tauri .app doesn't inherit login shell exports, so we read from shell too
  let shell_env = read_shell_anthropic_env();

  fn pick_env(var: &str, settings_env: &Value, shell_env: &std::collections::HashMap<String, String>) -> (String, String) {
    // Priority: settings.json > shell profile > process env
    let from_settings = settings_env.get(var).and_then(Value::as_str).unwrap_or("").to_string();
    if !from_settings.is_empty() {
      return ("settings.json".to_string(), from_settings);
    }
    let from_shell = shell_env.get(var).cloned().unwrap_or_default();
    if !from_shell.is_empty() {
      return ("shell".to_string(), from_shell);
    }
    let from_env = std::env::var(var).unwrap_or_default();
    if !from_env.trim().is_empty() {
      return ("env".to_string(), from_env);
    }
    (String::new(), String::new())
  }

  let (api_key_source, api_key_value) = pick_env("ANTHROPIC_API_KEY", &settings_env, &shell_env);
  let (auth_token_source, auth_token_value) = pick_env("ANTHROPIC_AUTH_TOKEN", &settings_env, &shell_env);
  let (base_url_source, base_url_value) = pick_env("ANTHROPIC_BASE_URL", &settings_env, &shell_env);

  // Effective credential: AUTH_TOKEN takes priority (it's used for proxy/oauth flows)
  let (effective_key_source, effective_key_value) = if !auth_token_value.is_empty() {
    (&auth_token_source, &auth_token_value)
  } else if !api_key_value.is_empty() {
    (&api_key_source, &api_key_value)
  } else {
    (&api_key_source, &api_key_value) // both empty
  };

  let has_api_key = !effective_key_value.is_empty();

  fn mask_key(key: &str) -> String {
    if key.len() > 12 {
      format!("{}...{}", &key[..8], &key[key.len()-4..])
    } else if !key.is_empty() {
      format!("{}...", &key[..key.len().min(4)])
    } else {
      String::new()
    }
  }

  let masked_api_key = mask_key(effective_key_value);
  let is_official = base_url_value.is_empty()
    || base_url_value.contains("anthropic.com")
    || base_url_value.contains("api.anthropic.com");

  // ── Check macOS Keychain / CLI login status ──
  let has_keychain_auth = if cfg!(target_os = "macos") {
    create_command("security")
      .args(["find-generic-password", "-s", "Claude Safe Storage", "-a", "Claude Key"])
      .output()
      .map(|o| o.status.success())
      .unwrap_or(false)
  } else {
    false
  };

  // ── Read ~/.claude.json for login status and used models ──
  let claude_json_path = dirs::home_dir()
    .ok_or("cannot find home")?
    .join(".claude.json");
  let claude_json = read_json_file(&claude_json_path).unwrap_or(json!({}));

  let has_completed_onboarding = claude_json.get("hasCompletedOnboarding")
    .and_then(Value::as_bool)
    .unwrap_or(false);

  // Login status — comprehensive
  let oauth = claude_json.get("oauthAccount");
  let login_info = if let Some(account) = oauth.and_then(Value::as_object) {
    json!({
      "loggedIn": true,
      "method": "oauth",
      "email": account.get("emailAddress").and_then(Value::as_str).unwrap_or(""),
      "orgName": account.get("orgName").and_then(Value::as_str).unwrap_or(""),
      "plan": account.get("accountPlan").and_then(Value::as_str).unwrap_or(""),
    })
  } else if has_keychain_auth && has_completed_onboarding {
    json!({
      "loggedIn": true,
      "method": "keychain",
      "email": "",
    })
  } else if has_api_key {
    json!({
      "loggedIn": true,
      "method": "api_key",
      "email": "",
      "apiKeySource": api_key_source,
    })
  } else {
    json!({
      "loggedIn": false,
      "method": "",
      "email": "",
    })
  };

  // Extract all models from project usage history
  let mut used_models = std::collections::BTreeSet::new();
  if let Some(projects) = claude_json.get("projects").and_then(Value::as_object) {
    for (_path, proj) in projects {
      if let Some(model_usage) = proj.get("lastModelUsage").and_then(Value::as_object) {
        for model_name in model_usage.keys() {
          used_models.insert(model_name.clone());
        }
      }
    }
  }

  Ok(json!({
    "toolId": "claudecode",
    "configHome": home.to_string_lossy().to_string(),
    "settingsPath": settings_path.to_string_lossy().to_string(),
    "settings": settings,
    "binary": binary,
    "model": model,
    "alwaysThinkingEnabled": always_thinking,
    "skipDangerousModePermissionPrompt": skip_dangerous,
    "hasApiKey": has_api_key,
    "maskedApiKey": masked_api_key,
    "apiKeySource": effective_key_source,
    "hasKeychainAuth": has_keychain_auth,
    "isOfficial": is_official,
    "envVars": {
      "ANTHROPIC_API_KEY": { "source": api_key_source, "masked": mask_key(&api_key_value), "set": !api_key_value.is_empty() },
      "ANTHROPIC_AUTH_TOKEN": { "source": auth_token_source, "masked": mask_key(&auth_token_value), "set": !auth_token_value.is_empty() },
      "ANTHROPIC_BASE_URL": { "source": base_url_source, "value": base_url_value, "set": !base_url_value.is_empty() },
    },
    "settingsJson": settings_json,
    "settingsEnv": settings_env,
    "login": login_info,
    "usedModels": used_models.into_iter().collect::<Vec<_>>(),
  }))
}

pub(crate) fn save_claudecode_config(body: &Value) -> Result<Value, String> {
  let home = claude_code_home()?;
  let settings_path = home.join("settings.json");
  let mut settings = read_json_file(&settings_path)?;
  let obj = parse_json_object(body);

  if let Some(model) = obj.get("model") {
    if let Some(s) = model.as_str() {
      if s.is_empty() {
        settings.as_object_mut().map(|o| o.remove("model"));
      } else {
        settings["model"] = json!(s);
      }
    }
  }
  if let Some(v) = obj.get("alwaysThinkingEnabled") {
    settings["alwaysThinkingEnabled"] = v.clone();
  }
  if let Some(v) = obj.get("skipDangerousModePermissionPrompt") {
    settings["skipDangerousModePermissionPrompt"] = v.clone();
  }
  if let Some(env) = obj.get("env").and_then(Value::as_object) {
    let existing = settings.as_object_mut().ok_or("invalid settings")?;
    let env_obj = existing.entry("env").or_insert_with(|| json!({}));
    if let Some(env_map) = env_obj.as_object_mut() {
      for (k, v) in env {
        env_map.insert(k.clone(), v.clone());
      }
    }
  }

  write_json_file(&settings_path, &settings)?;
  Ok(json!({ "saved": true, "settingsPath": settings_path.to_string_lossy().to_string() }))
}

pub(crate) fn save_claudecode_raw_config(body: &Value) -> Result<Value, String> {
  let home = claude_code_home()?;
  let settings_path = home.join("settings.json");
  let obj = parse_json_object(body);
  let raw = get_string(&obj, "settingsJson");
  if raw.trim().is_empty() {
    return Err("settings.json 内容不能为空".to_string());
  }
  let parsed: Value = serde_json::from_str(&raw).map_err(|e| format!("JSON 解析失败：{}", e))?;
  write_json_file(&settings_path, &parsed)?;
  Ok(json!({ "saved": true, "settingsPath": settings_path.to_string_lossy().to_string() }))
}

fn launch_terminal_command(cwd: &Path, command_text: &str, tool_label: &str) -> Result<String, String> {
  let cwd_text = cwd.to_string_lossy().to_string();

  if cfg!(target_os = "macos") {
    let script = [
      "tell application \"Terminal\"",
      "activate",
      &format!(
        "do script \"cd {} && {}\"",
        escape_applescript(&cwd_text),
        escape_applescript(command_text)
      ),
      "end tell",
    ]
    .join("\n");

    let output = create_command("osascript")
      .arg("-e")
      .arg(script)
      .output()
      .map_err(|error| error.to_string())?;
    if !output.status.success() {
      return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    return Ok(format!("{} 已在 Terminal 中启动", tool_label));
  }

  if cfg!(target_os = "windows") {
    create_command("cmd.exe")
      .args([
        "/c", "start", "", "cmd", "/k",
        &format!("cd /d \"{}\" && {}", cwd_text, command_text),
      ])
      .spawn()
      .map_err(|error| error.to_string())?;
    return Ok(format!("{} 已在新命令窗口中启动", tool_label));
  }

  let terminals = vec![
    ("x-terminal-emulator", vec!["-e".to_string(), format!("bash -lc \"cd '{}' && {}\"", cwd_text, command_text)]),
    ("gnome-terminal", vec!["--".to_string(), "bash".to_string(), "-lc".to_string(), format!("cd '{}' && {}", cwd_text, command_text)]),
    ("konsole", vec!["-e".to_string(), "bash".to_string(), "-lc".to_string(), format!("cd '{}' && {}", cwd_text, command_text)]),
  ];

  for (command, args) in terminals {
    if command_exists(command).is_none() { continue; }
    create_command(command).args(args).spawn().map_err(|error| error.to_string())?;
    return Ok(format!("{} 已在新终端中启动", tool_label));
  }

  Err(format!("没有找到可用终端，请先手动运行 {}", command_text))
}

fn launch_terminal_for_tool(cwd: &Path, binary_path: &str, tool_label: &str) -> Result<String, String> {
  launch_terminal_command(cwd, binary_path, tool_label)
}

fn check_openclaw_gateway_reachable(gateway_url: &str) -> bool {
  reqwest::blocking::Client::builder()
    .connect_timeout(std::time::Duration::from_millis(500))
    .timeout(std::time::Duration::from_millis(1200))
    .redirect(reqwest::redirect::Policy::none())
    .build()
    .ok()
    .and_then(|client| client.get(gateway_url).send().ok())
    .map(|response| response.status().as_u16() > 0)
    .unwrap_or(false)
}

fn normalize_openclaw_control_ui_base_path(value: &str) -> String {
  let trimmed = value.trim();
  if trimmed.is_empty() || trimmed == "/" {
    "/".to_string()
  } else {
    format!("/{}", trimmed.trim_matches('/'))
  }
}

fn extract_url_from_text(text: &str) -> Option<String> {
  text.split_whitespace()
    .find(|part| part.starts_with("http://") || part.starts_with("https://"))
    .map(|part| part.trim_end_matches(|ch: char| [')', ',', '.', ';'].contains(&ch)).to_string())
}

pub(crate) fn launch_claudecode(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let cwd = {
    let input = get_string(&object, "cwd");
    if input.is_empty() { home_dir()? } else { PathBuf::from(input) }
  };
  let binary = find_tool_binary("claude");
  if !binary.get("installed").and_then(Value::as_bool).unwrap_or(false) {
    return Err("Claude Code 尚未安装，请先点击安装".to_string());
  }
  let bin_path = binary.get("path").and_then(Value::as_str).unwrap_or("claude");
  let message = launch_terminal_for_tool(&cwd, bin_path, "Claude Code")?;
  Ok(json!({ "ok": true, "cwd": cwd.to_string_lossy().to_string(), "message": message }))
}

/* ═══════════════  OpenClaw  ═══════════════ */

pub(crate) fn load_openclaw_state() -> Result<Value, String> {
  let home = openclaw_home()?;
  let config_path = home.join("openclaw.json");
  let binary = find_tool_binary("openclaw");

  let mut config = if config_path.exists() {
    read_json_file(&config_path).unwrap_or(json!({}))
  } else {
    json!({})
  };
  let config_exists = config_path.exists();
  if config_exists && ensure_openclaw_gateway_defaults(&mut config) {
    write_json_file(&config_path, &config)?;
  }

  let config_json = serde_json::to_string_pretty(&config).unwrap_or_else(|_| "{}".to_string());

  // Read env vars relevant to OpenClaw, with config fallback
  let gateway_token_env = std::env::var("OPENCLAW_GATEWAY_TOKEN").unwrap_or_default();
  let gateway_token_cfg = config.pointer("/gateway/auth/token")
    .and_then(Value::as_str).unwrap_or("").to_string();
  let gateway_token = if !gateway_token_env.is_empty() { gateway_token_env } else { gateway_token_cfg };

  let gateway_port_env = std::env::var("OPENCLAW_GATEWAY_PORT").unwrap_or_default();
  let gateway_port_cfg = config.pointer("/gateway/port")
    .and_then(Value::as_u64).map(|p| p.to_string()).unwrap_or_default();
  let gateway_port = if !gateway_port_env.is_empty() { gateway_port_env }
    else if !gateway_port_cfg.is_empty() { gateway_port_cfg }
    else { "18789".to_string() };
  let gateway_auth_mode = config.pointer("/gateway/auth/mode")
    .and_then(Value::as_str).unwrap_or("token").to_string();

  let gateway_url = format!("http://127.0.0.1:{}/", gateway_port);
  let gateway_reachable = check_openclaw_gateway_reachable(&gateway_url);
  let needs_onboarding = binary.get("installed").and_then(Value::as_bool).unwrap_or(false) && !config_exists;
  let dashboard_url = build_openclaw_dashboard_url(&gateway_url, &config, &gateway_token);

  Ok(json!({
    "toolId": "openclaw",
    "configHome": home.to_string_lossy().to_string(),
    "configPath": config_path.to_string_lossy().to_string(),
    "configExists": config_exists,
    "config": config,
    "configJson": config_json,
    "binary": binary,
    "gatewayAuthMode": gateway_auth_mode,
    "gatewayToken": if gateway_token.is_empty() { Value::Null } else { json!(gateway_token) },
    "gatewayTokenReady": gateway_auth_mode != "token" || !gateway_token.is_empty(),
    "gatewayPort": gateway_port,
    "gatewayUrl": gateway_url,
    "dashboardUrl": dashboard_url,
    "gatewayReachable": gateway_reachable,
    "needsOnboarding": needs_onboarding,
    "installMethods": if cfg!(target_os = "windows") {
      json!(["domestic", "wsl", "script"])
    } else {
      json!(["script", "npm", "source", "docker"])
    },
  }))
}

fn build_openclaw_dashboard_url(gateway_url: &str, config: &Value, gateway_token: &str) -> String {
  let base = config.pointer("/gateway/controlUi/basePath").and_then(Value::as_str).unwrap_or("/");
  let mut url = reqwest::Url::parse(gateway_url).unwrap_or_else(|_| reqwest::Url::parse("http://127.0.0.1:18789/").unwrap());
  url.set_path(&normalize_openclaw_control_ui_base_path(base));
  if !gateway_token.trim().is_empty() {
    url.query_pairs_mut().append_pair("token", gateway_token);
  }
  url.to_string()
}

pub(crate) fn get_openclaw_dashboard_url(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let cwd = {
    let input = object.get("cwd").and_then(Value::as_str).unwrap_or("").to_string();
    if input.is_empty() { home_dir()? } else { PathBuf::from(input) }
  };
  let state = load_openclaw_state()?;
  let binary = state.get("binary").cloned().unwrap_or_else(|| json!({}));
  if !binary.get("installed").and_then(Value::as_bool).unwrap_or(false) {
    return Err("OpenClaw 尚未安装".to_string());
  }
  let bin_path = binary.get("path").and_then(Value::as_str).unwrap_or("openclaw").to_string();
  std::env::set_var("PATH", full_path_env());
  let output = create_command(&bin_path)
    .args(["dashboard", "--no-open"])
    .current_dir(&cwd)
    .output();
  let (stdout, stderr) = match output {
    Ok(out) => (String::from_utf8_lossy(&out.stdout).to_string(), String::from_utf8_lossy(&out.stderr).to_string()),
    Err(_) => (String::new(), String::new()),
  };
  let merged = format!("{}\n{}", stdout, stderr);
  let fallback = state.get("dashboardUrl").and_then(Value::as_str).unwrap_or("");
  let url = extract_url_from_text(&merged).unwrap_or_else(|| fallback.to_string());
  Ok(json!({ "ok": !url.is_empty(), "url": url, "stdout": stdout.trim(), "stderr": stderr.trim(), "command": format!("{} dashboard --no-open", bin_path) }))
}

pub(crate) fn save_openclaw_config(body: &Value) -> Result<Value, String> {
  let home = openclaw_home()?;
  let config_path = home.join("openclaw.json");
  let obj = parse_json_object(body);
  let raw = obj.get("configJson")
    .and_then(Value::as_str)
    .unwrap_or("{}")
    .to_string();
  if raw.trim().is_empty() {
    return Err("配置内容不能为空".to_string());
  }
  let mut parsed: Value = serde_json::from_str(&raw).map_err(|e| format!("JSON 解析失败：{}", e))?;
  ensure_openclaw_gateway_defaults(&mut parsed);
  write_json_file(&config_path, &parsed)?;
  Ok(json!({ "saved": true, "configPath": config_path.to_string_lossy().to_string() }))
}

pub(crate) fn launch_openclaw(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let cwd = {
    let input = object.get("cwd").and_then(Value::as_str).unwrap_or("").to_string();
    if input.is_empty() { home_dir()? } else { PathBuf::from(input) }
  };
  let state = load_openclaw_state()?;
  let binary = state.get("binary").cloned().unwrap_or_else(|| json!({}));
  if !binary.get("installed").and_then(Value::as_bool).unwrap_or(false) {
    return Err("OpenClaw 尚未安装，请先选择安装方式进行安装".to_string());
  }

  if !state.get("configExists").and_then(Value::as_bool).unwrap_or(false) {
    let onboard = onboard_openclaw(body)?;
    let mut response = parse_json_object(&onboard);
    response.insert("mode".to_string(), json!("onboard"));
    response.insert("gatewayUrl".to_string(), state.get("gatewayUrl").cloned().unwrap_or(Value::Null));
    return Ok(Value::Object(response));
  }

  if state.get("gatewayReachable").and_then(Value::as_bool).unwrap_or(false) {
    return Ok(json!({
      "ok": true,
      "cwd": cwd.to_string_lossy().to_string(),
      "mode": "dashboard",
      "gatewayUrl": state.get("gatewayUrl").cloned().unwrap_or(Value::Null),
      "message": "OpenClaw Dashboard 已准备好",
    }));
  }

  let bin_path = binary.get("path").and_then(Value::as_str).unwrap_or("openclaw");
  let command = format!("{} gateway start || {} gateway", bin_path, bin_path);
  let message = launch_terminal_command(&cwd, &command, "OpenClaw Gateway")?;
  Ok(json!({
    "ok": true,
    "cwd": cwd.to_string_lossy().to_string(),
    "mode": "gateway",
    "gatewayUrl": state.get("gatewayUrl").cloned().unwrap_or(Value::Null),
    "command": command,
    "message": message,
  }))
}

pub(crate) fn onboard_openclaw(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let cwd = {
    let input = object.get("cwd").and_then(Value::as_str).unwrap_or("").to_string();
    if input.is_empty() { home_dir()? } else { PathBuf::from(input) }
  };
  let binary = find_tool_binary("openclaw");
  if !binary.get("installed").and_then(Value::as_bool).unwrap_or(false) {
    return Err("OpenClaw 尚未安装，请先完成安装".to_string());
  }
  let bin_path = binary.get("path").and_then(Value::as_str).unwrap_or("openclaw").to_string();

  let auth_choice = object.get("authChoice").and_then(Value::as_str).unwrap_or("skip").to_string();
  let api_key = object.get("apiKey").and_then(Value::as_str).unwrap_or("").to_string();
  let _api_key_type = object.get("apiKeyType").and_then(Value::as_str).unwrap_or("").to_string();

  let mut args: Vec<String> = vec![
    "onboard".into(),
    "--non-interactive".into(),
    "--accept-risk".into(),
    "--flow".into(), "quickstart".into(),
    "--skip-channels".into(),
    "--skip-skills".into(),
    "--skip-search".into(),
    "--json".into(),
  ];
  if !cfg!(target_os = "windows") {
    args.push("--install-daemon".into());
  }

  if !auth_choice.is_empty() && auth_choice != "skip" {
    args.push("--auth-choice".into());
    args.push(auth_choice.clone());
    if !api_key.is_empty() {
      let flag = match auth_choice.as_str() {
        "anthropic" => "--anthropic-api-key",
        "openai-api-key" => "--openai-api-key",
        "openrouter-api-key" => "--openrouter-api-key",
        "gemini-api-key" => "--gemini-api-key",
        "mistral-api-key" => "--mistral-api-key",
        "together-api-key" => "--together-api-key",
        "xai-api-key" => "--xai-api-key",
        _ => "--custom-api-key",
      };
      args.push(flag.into());
      args.push(api_key);
    }
  } else {
    args.push("--auth-choice".into());
    args.push("skip".into());
  }

  let command_text = format!("{} {}", bin_path, args.join(" "));

  // Run as child process — not in terminal.
  // Redirect stdin to /dev/null so that any internal TTY reads get EOF
  // instead of crashing with "/dev/tty: Device not configured" in a GUI context.
  std::env::set_var("PATH", full_path_env());
  let output = create_command(&bin_path)
    .args(&args)
    .current_dir(&cwd)
    .stdin(Stdio::null())
    .output()
    .map_err(|e| format!("执行 openclaw onboard 失败：{}", e))?;

  let stdout = String::from_utf8_lossy(&output.stdout).to_string();
  let stderr = String::from_utf8_lossy(&output.stderr).to_string();

  let config_path = openclaw_home()?.join("openclaw.json");
  if config_path.exists() {
    let mut config = read_json_file(&config_path).unwrap_or(json!({}));
    if ensure_openclaw_gateway_defaults(&mut config) {
      write_json_file(&config_path, &config)?;
    }
  }

  let success = stdout.contains("Updated") || stdout.contains("openclaw.json") || output.status.success();

  Ok(json!({
    "ok": success,
    "cwd": cwd.to_string_lossy().to_string(),
    "command": command_text,
    "message": if success { "OpenClaw 初始化完成" } else { "初始化可能未完成" },
    "stdout": stdout.trim(),
    "stderr": stderr.trim(),
  }))
}

fn generate_openclaw_gateway_token() -> String {
  format!("oc_{}", Uuid::new_v4().simple())
}

fn ensure_openclaw_gateway_defaults(config: &mut Value) -> bool {
  let mut changed = false;
  if !config.is_object() {
    *config = json!({});
    changed = true;
  }

  let root = match config.as_object_mut() {
    Some(value) => value,
    None => return changed,
  };
  let gateway = root.entry("gateway".to_string()).or_insert_with(|| json!({}));
  if !gateway.is_object() {
    *gateway = json!({});
    changed = true;
  }

  let gateway_obj = match gateway.as_object_mut() {
    Some(value) => value,
    None => return changed,
  };
  let auth = gateway_obj.entry("auth".to_string()).or_insert_with(|| json!({}));
  if !auth.is_object() {
    *auth = json!({});
    changed = true;
  }

  let auth_obj = match auth.as_object_mut() {
    Some(value) => value,
    None => return changed,
  };
  let mode = auth_obj.get("mode").and_then(Value::as_str).unwrap_or("").trim().to_string();
  if mode.is_empty() {
    auth_obj.insert("mode".to_string(), json!("token"));
    changed = true;
  }

  let effective_mode = auth_obj.get("mode").and_then(Value::as_str).unwrap_or("token");
  if effective_mode == "token" {
    let token = auth_obj.get("token").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if token.is_empty() {
      auth_obj.insert("token".to_string(), json!(generate_openclaw_gateway_token()));
      changed = true;
    }
  }

  changed
}

pub(crate) fn start_openclaw_install_task(body: &Value) -> Result<Value, String> {
  let obj = parse_json_object(body);
  let method = obj.get("method").and_then(Value::as_str).unwrap_or(if cfg!(target_os = "windows") { "domestic" } else { "script" });
  if method != "script" && method != "npm" && method != "domestic" {
    return Err("只有一键安装、脚本安装和 npm 安装支持实时进度追踪".to_string());
  }

  let command = if method == "script" {
    if cfg!(target_os = "windows") {
      OPENCLAW_INSTALL_SCRIPT_WIN.to_string()
    } else {
      OPENCLAW_INSTALL_SCRIPT_UNIX.to_string()
    }
  } else if method == "domestic" {
    format!("{} install -g {}@latest --registry={}", npm_command(), OPENCLAW_PACKAGE, OPENCLAW_NPM_REGISTRY_CN)
  } else {
    format!("{} install -g {}@latest", npm_command(), OPENCLAW_PACKAGE)
  };

  let mut task = create_openclaw_install_task(method, &command);
  task.install_snapshot = capture_openclaw_install_snapshot();
  let response = serde_json::to_value(&task).map_err(|error| error.to_string())?;
  insert_openclaw_install_task(task.clone());
  spawn_openclaw_install_task_runner(task.task_id.clone());
  Ok(response)
}

pub(crate) fn get_openclaw_install_task(query: &Value) -> Result<Value, String> {
  let obj = parse_json_object(query);
  let task_id = obj.get("taskId").and_then(Value::as_str).unwrap_or("").trim();
  if task_id.is_empty() {
    return Err("安装任务不存在，可能已经过期，请重新开始安装".to_string());
  }
  let task = get_openclaw_install_task_snapshot(task_id)
    .ok_or_else(|| "安装任务不存在，可能已经过期，请重新开始安装".to_string())?;
  serde_json::to_value(task).map_err(|error| error.to_string())
}

pub(crate) fn cancel_openclaw_install_task(body: &Value) -> Result<Value, String> {
  let obj = parse_json_object(body);
  let task_id = obj.get("taskId").and_then(Value::as_str).unwrap_or("").trim();
  if task_id.is_empty() {
    return Err("安装任务不存在，可能已经过期，请重新开始安装".to_string());
  }
  cancel_openclaw_install_task_inner(task_id)?;
  let task = get_openclaw_install_task_snapshot(task_id)
    .ok_or_else(|| "安装任务不存在，可能已经过期，请重新开始安装".to_string())?;
  serde_json::to_value(task).map_err(|error| error.to_string())
}

/// Run install via a particular method
pub(crate) fn run_openclaw_install_script(body: &Value) -> Result<Value, String> {
  let obj = parse_json_object(body);
  let method = obj.get("method").and_then(Value::as_str).unwrap_or(if cfg!(target_os = "windows") { "domestic" } else { "script" });

  match method {
    "domestic" => {
      let _ = ensure_node_and_npm_available("direct-openclaw-install");
      let mut cmd = create_command(npm_command());
      apply_windows_openclaw_npm_env(&mut cmd, true);
      cmd.args(["install", "-g", &format!("{}@latest", OPENCLAW_PACKAGE), "--registry", OPENCLAW_NPM_REGISTRY_CN]);
      cmd.stdin(Stdio::null());
      let output = cmd.output().map_err(|error| error.to_string())?;
      Ok(json!({
        "ok": output.status.success(),
        "method": "domestic",
        "command": format!("{} install -g {}@latest --registry={}", npm_command(), OPENCLAW_PACKAGE, OPENCLAW_NPM_REGISTRY_CN),
        "stdout": String::from_utf8_lossy(&output.stdout).to_string(),
        "stderr": String::from_utf8_lossy(&output.stderr).to_string(),
      }))
    }
    "wsl" => {
      Ok(json!({
        "ok": true,
        "method": "wsl",
        "instructions": [
          "wsl --status",
          "wsl --install -d Ubuntu-24.04",
          "wsl -d Ubuntu-24.04 -- bash -lc \"curl -fsSL https://openclaw.ai/install.sh | OPENCLAW_NO_ONBOARD=1 bash -s -- --no-onboard --install-method npm\"",
          "wsl -d Ubuntu-24.04 -- bash -lc \"openclaw --version\"",
        ],
        "message": "WSL2 适合熟悉 Linux 的高级用户；如果本机还没装 Ubuntu，首次初始化会较久。",
      }))
    }
    "script" => {
      // Run the install script via curl | bash (macOS/Linux) or PowerShell (Windows)
      if cfg!(target_os = "windows") {
        let _ = ensure_node_and_npm_available("direct-openclaw-install");
        let result = run_command("powershell", &["-Command", OPENCLAW_INSTALL_SCRIPT_WIN], None)?;
        Ok(json!({
          "ok": result.get("ok").and_then(Value::as_bool).unwrap_or(false),
          "method": "script",
          "command": OPENCLAW_INSTALL_SCRIPT_WIN,
          "stdout": result.get("stdout").cloned().unwrap_or(Value::Null),
          "stderr": result.get("stderr").cloned().unwrap_or(Value::Null),
        }))
      } else {
        let result = run_command("bash", &["-c", OPENCLAW_INSTALL_SCRIPT_UNIX], None)?;
        Ok(json!({
          "ok": result.get("ok").and_then(Value::as_bool).unwrap_or(false),
          "method": "script",
          "command": OPENCLAW_INSTALL_SCRIPT_UNIX,
          "stdout": result.get("stdout").cloned().unwrap_or(Value::Null),
          "stderr": result.get("stderr").cloned().unwrap_or(Value::Null),
        }))
      }
    }
    "npm" => {
      let _ = ensure_node_and_npm_available("direct-openclaw-install");
      let mut cmd = create_command(npm_command());
      apply_windows_openclaw_npm_env(&mut cmd, false);
      cmd.args(["install", "-g", &format!("{}@latest", OPENCLAW_PACKAGE)]);
      cmd.stdin(Stdio::null());
      let output = cmd.output().map_err(|error| error.to_string())?;
      let result = json!({
        "ok": output.status.success(),
        "code": output.status.code(),
        "stdout": String::from_utf8_lossy(&output.stdout).to_string(),
        "stderr": String::from_utf8_lossy(&output.stderr).to_string(),
      });
      Ok(json!({
        "ok": result.get("ok").and_then(Value::as_bool).unwrap_or(false),
        "method": "npm",
        "command": format!("{} install -g {}@latest", npm_command(), OPENCLAW_PACKAGE),
        "stdout": result.get("stdout").cloned().unwrap_or(Value::Null),
        "stderr": result.get("stderr").cloned().unwrap_or(Value::Null),
      }))
    }
    "source" => {
      // For source install, we return instructions instead of running directly
      Ok(json!({
        "ok": true,
        "method": "source",
        "instructions": [
          "git clone https://github.com/openclaw/openclaw.git",
          "cd openclaw",
          "pnpm install",
          "pnpm ui:build",
          "pnpm build",
          "pnpm link --global",
          "openclaw onboard --install-daemon",
        ],
        "message": "源码构建需要在终端中手动执行以上命令",
      }))
    }
    "docker" => {
      // For docker install, we return instructions
      Ok(json!({
        "ok": true,
        "method": "docker",
        "instructions": [
          "git clone https://github.com/openclaw/openclaw.git",
          "cd openclaw",
          "./docker-setup.sh",
        ],
        "message": "Docker 安装需要在终端中手动执行以上命令",
      }))
    }
    _ => Err(format!("不支持的安装方式：{}", method)),
  }
}

fn run_remote_ssh_command(
  host: &str,
  port: u16,
  username: &str,
  auth_method: &str,
  password: &str,
  key_path: &str,
  remote_command: &str,
) -> Result<Value, String> {
  if command_exists("ssh").is_none() {
    return Err("本机未检测到 ssh 命令，请先安装 OpenSSH 客户端".to_string());
  }

  let mut ssh_args: Vec<String> = vec![
    "-o".to_string(), "StrictHostKeyChecking=accept-new".to_string(),
    "-o".to_string(), "ConnectTimeout=12".to_string(),
    "-p".to_string(), port.to_string(),
  ];

  match auth_method {
    "key" => {
      if key_path.trim().is_empty() {
        return Err("请选择 SSH 私钥文件".to_string());
      }
      let key_file = PathBuf::from(key_path);
      if !key_file.exists() {
        return Err(format!("未找到 SSH 私钥文件：{}", key_path));
      }
      ssh_args.push("-i".to_string());
      ssh_args.push(key_path.to_string());
      ssh_args.push("-o".to_string());
      ssh_args.push("BatchMode=yes".to_string());
    }
    "agent" => {
      ssh_args.push("-o".to_string());
      ssh_args.push("BatchMode=yes".to_string());
    }
    "password" => {
      if password.trim().is_empty() {
        return Err("请输入远程服务器密码".to_string());
      }
    }
    _ => return Err("不支持的远程登录方式".to_string()),
  }

  ssh_args.push(format!("{}@{}", username, host));
  ssh_args.push(remote_command.to_string());

  if auth_method == "password" {
    if command_exists("sshpass").is_none() {
      return Err("密码登录需要本机安装 sshpass（macOS 可用 brew install hudochenkov/sshpass/sshpass）".to_string());
    }
    let mut args = vec!["-e".to_string(), "ssh".to_string()];
    args.extend(ssh_args);
    return run_command_dynamic("sshpass", &args, None, Some(("SSHPASS", password.to_string())));
  }

  run_command_dynamic("ssh", &ssh_args, None, None)
}

pub(crate) fn install_openclaw_remote(body: &Value) -> Result<Value, String> {
  let obj = parse_json_object(body);
  let host = get_string(&obj, "host");
  if host.trim().is_empty() {
    return Err("请输入远程服务器 IP 或域名".to_string());
  }

  let username = get_string(&obj, "username");
  if username.trim().is_empty() {
    return Err("请输入远程登录用户名".to_string());
  }

  let port = match obj.get("port") {
    Some(Value::Number(n)) => n.as_u64().unwrap_or(22),
    Some(Value::String(s)) if !s.trim().is_empty() => s.trim().parse::<u64>().unwrap_or(0),
    _ => 22,
  };
  if port == 0 || port > 65535 {
    return Err("远程端口必须是 1-65535 的整数".to_string());
  }

  let auth_method = {
    let input = get_string(&obj, "authMethod").to_lowercase();
    if input.trim().is_empty() { "agent".to_string() } else { input }
  };
  if auth_method != "agent" && auth_method != "password" && auth_method != "key" {
    return Err("不支持的远程登录方式".to_string());
  }

  let password = get_string(&obj, "password");
  let key_path_raw = get_string(&obj, "keyPath");
  let key_path = if key_path_raw.starts_with("~/") {
    if let Some(home) = dirs::home_dir() {
      home.join(key_path_raw.trim_start_matches("~/")).to_string_lossy().to_string()
    } else {
      key_path_raw
    }
  } else {
    key_path_raw
  };

  let install_method = {
    let input = get_string(&obj, "installMethod").to_lowercase();
    if input.trim().is_empty() { "script".to_string() } else { input }
  };
  if install_method != "script" && install_method != "npm" {
    return Err("远程安装仅支持脚本安装或 npm 安装".to_string());
  }

  let remote_os = {
    let input = get_string(&obj, "remoteOs").to_lowercase();
    if input.trim().is_empty() || input == "unix" || input == "linux" || input == "macos" || input == "darwin" {
      "unix".to_string()
    } else if input == "windows" || input == "win" {
      "windows".to_string()
    } else {
      return Err("远程系统仅支持 Linux/macOS 或 Windows".to_string());
    }
  };

  let remote_command = if remote_os == "windows" {
    if install_method == "script" {
      format!(
        "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"{}\"",
        OPENCLAW_INSTALL_SCRIPT_WIN.replace('"', "\\\"")
      )
    } else {
      "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"npm install -g openclaw@latest\"".to_string()
    }
  } else if install_method == "script" {
    OPENCLAW_INSTALL_SCRIPT_UNIX.to_string()
  } else {
    format!("{} install -g {}@latest", npm_command(), OPENCLAW_PACKAGE)
  };
  let target = format!("{}@{}:{}", username, host, port);

  let install_result = run_remote_ssh_command(
    &host,
    port as u16,
    &username,
    &auth_method,
    &password,
    &key_path,
    &remote_command,
  )?;

  if !install_result.get("ok").and_then(Value::as_bool).unwrap_or(false) {
    let stderr = install_result.get("stderr").and_then(Value::as_str).unwrap_or("").trim();
    let stdout = install_result.get("stdout").and_then(Value::as_str).unwrap_or("").trim();
    if !stderr.is_empty() {
      return Err(stderr.to_string());
    }
    if !stdout.is_empty() {
      return Err(stdout.to_string());
    }
    return Err(format!("远程安装失败：{}", target));
  }

  let verify_command = if remote_os == "windows" {
    "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"openclaw --version\""
  } else {
    "sh -lc 'openclaw --version 2>/dev/null || true'"
  };
  let verify_result = run_remote_ssh_command(
    &host,
    port as u16,
    &username,
    &auth_method,
    &password,
    &key_path,
    verify_command,
  )?;

  let verify_stdout = verify_result.get("stdout").and_then(Value::as_str).unwrap_or("").to_string();
  let verify_stderr = verify_result.get("stderr").and_then(Value::as_str).unwrap_or("").to_string();
  let verify_text = format!("{}{}", verify_stdout, verify_stderr);
  let version = extract_version(&verify_text);

  Ok(json!({
    "ok": true,
    "mode": "remote",
    "method": install_method,
    "command": remote_command,
    "remote": {
      "host": host,
      "port": port,
      "username": username,
      "authMethod": auth_method,
      "os": remote_os,
      "target": target,
    },
    "version": version,
    "stdout": install_result.get("stdout").cloned().unwrap_or(Value::Null),
    "stderr": install_result.get("stderr").cloned().unwrap_or(Value::Null),
    "verifyStdout": verify_result.get("stdout").cloned().unwrap_or(Value::Null),
    "verifyStderr": verify_result.get("stderr").cloned().unwrap_or(Value::Null),
  }))
}

pub(crate) fn open_url_in_browser(body: &Value) -> Result<Value, String> {
  let obj = parse_json_object(body);
  let url = obj.get("url").and_then(Value::as_str).unwrap_or("").trim().to_string();
  if url.is_empty() {
    return Err("URL 不能为空".to_string());
  }
  // Validate it looks like a URL
  if !url.starts_with("http://") && !url.starts_with("https://") {
    return Err("只允许打开 http/https URL".to_string());
  }

  let result = if cfg!(target_os = "macos") {
    Command::new("open").arg(&url).spawn()
  } else if cfg!(target_os = "windows") {
    Command::new("cmd").args(["/c", "start", "", &url]).spawn()
  } else {
    Command::new("xdg-open").arg(&url).spawn()
  };

  match result {
    Ok(_) => Ok(json!({ "opened": true, "url": url })),
    Err(e) => Err(format!("打开浏览器失败：{}", e)),
  }
}

pub(crate) fn stop_openclaw_gateway() -> Result<Value, String> {
  std::env::set_var("PATH", full_path_env());

  // Try `openclaw gateway stop` first
  let bin = which::which("openclaw").ok();
  if let Some(ref bin_path) = bin {
    let output = create_command(bin_path.to_str().unwrap_or("openclaw"))
      .args(["gateway", "stop"])
      .output();
    if let Ok(out) = output {
      if out.status.success() {
        return Ok(json!({ "stopped": true, "method": "gateway stop" }));
      }
    }
  }

  // Fallback: kill process by name
  let kill_result = if cfg!(target_os = "windows") {
    Command::new("taskkill").args(["/F", "/IM", "openclaw.exe"]).output()
  } else {
    Command::new("pkill").args(["-f", "openclaw.*gateway"]).output()
  };

  match kill_result {
    Ok(out) if out.status.success() => Ok(json!({ "stopped": true, "method": "pkill" })),
    _ => Ok(json!({ "stopped": false, "message": "未找到运行中的 OpenClaw 进程" })),
  }
}

pub(crate) fn uninstall_openclaw(body: &Value) -> Result<Value, String> {
  let obj = parse_json_object(body);
  let purge = obj.get("purge").and_then(Value::as_bool).unwrap_or(false);

  let mut purged_paths: Vec<String> = Vec::new();

  // If purge requested, remove the OpenClaw data directory (~/.openclaw)
  if purge {
    let home = openclaw_home()?;
    if home.exists() {
      std::fs::remove_dir_all(&home).map_err(|e| format!("删除 {:?} 失败：{}", home, e))?;
      purged_paths.push(home.to_string_lossy().to_string());
    }
  }

  // Run npm uninstall
  let result = codex_npm_action(&["uninstall", "-g", OPENCLAW_PACKAGE])?;

  Ok(json!({
    "ok": result.get("ok").and_then(Value::as_bool).unwrap_or(false),
    "code": result.get("code").cloned().unwrap_or(Value::Null),
    "stdout": result.get("stdout").cloned().unwrap_or(Value::String(String::new())),
    "stderr": result.get("stderr").cloned().unwrap_or(Value::String(String::new())),
    "command": result.get("command").cloned().unwrap_or(Value::String(String::new())),
    "purge": purge,
    "purgedPaths": purged_paths,
  }))
}
