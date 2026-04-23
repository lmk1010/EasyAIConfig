use serde::Serialize;
use serde_json::{json, Map, Value};
use rusqlite::{params, Connection, OptionalExtension};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::fs;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::io::Write;
use std::net::ToSocketAddrs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use uuid::Uuid;

const OPENCODE_INSTALL_TASK_KEEP: usize = 12;
const OPENCLAW_INSTALL_TASK_KEEP: usize = 12;
const OPENCODE_INSTALL_SCRIPT_UNIX: &str = "curl -fsSL https://opencode.ai/install | bash";
const OPENCODE_NPM_REGISTRY_CN: &str = "https://registry.npmmirror.com";
const OPENCLAW_INSTALL_SCRIPT_UNIX: &str = "curl -fsSL https://openclaw.ai/install.sh | OPENCLAW_NO_ONBOARD=1 bash -s -- --no-onboard --install-method npm";
const OPENCLAW_INSTALL_SCRIPT_WIN: &str = "$env:OPENCLAW_NO_ONBOARD='1'; iwr -useb https://openclaw.ai/install.ps1 | iex";
const OPENCLAW_NPM_REGISTRY_CN: &str = "https://registry.npmmirror.com";
const CODEX_APP_MAC_DOWNLOAD_URL: &str = "https://persistent.oaistatic.com/codex-app-prod/Codex.dmg";
const CODEX_APP_WIN_STORE_URL: &str = "https://apps.microsoft.com/detail/9plm9xgg6vks";
const CODEX_APP_WIN_STORE_URI: &str = "ms-windows-store://pdp/?ProductId=9PLM9XGG6VKS";
const CODEX_APP_DOCS_URL: &str = "https://developers.openai.com/codex/app";

static OPENCODE_INSTALL_TASK_SEQ: AtomicU64 = AtomicU64::new(1);
static OPENCODE_INSTALL_TASKS: OnceLock<Mutex<BTreeMap<String, OpenCodeInstallTask>>> = OnceLock::new();
static OPENCLAW_INSTALL_TASK_SEQ: AtomicU64 = AtomicU64::new(1);
static OPENCLAW_INSTALL_TASKS: OnceLock<Mutex<BTreeMap<String, OpenClawInstallTask>>> = OnceLock::new();

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenCodeInstallLog {
  source: String,
  text: String,
  at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenCodeInstallStep {
  key: String,
  title: String,
  description: String,
  hint: String,
  progress: u64,
  status: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenCodeInstallTask {
  task_id: String,
  tool_id: String,
  action: String,
  requested_method: String,
  method: String,
  command: String,
  google_reachable: Option<bool>,
  used_domestic_mirror: Option<bool>,
  status: String,
  progress: u64,
  step_index: usize,
  summary: String,
  hint: String,
  detail: String,
  steps: Vec<OpenCodeInstallStep>,
  logs: Vec<OpenCodeInstallLog>,
  started_at: String,
  updated_at: String,
  completed_at: Option<String>,
  version: Option<String>,
  error: Option<String>,
  #[serde(skip_serializing)]
  cancel_requested: bool,
  #[serde(skip_serializing)]
  child_pid: Option<u32>,
}

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

fn windows_user_extra_bin_dirs() -> Vec<String> {
  let mut dirs = Vec::new();
  if let Ok(pnpm_home) = std::env::var("PNPM_HOME") {
    let p = PathBuf::from(pnpm_home);
    if p.is_dir() {
      dirs.push(p.to_string_lossy().to_string());
    }
  }
  if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
    let local = PathBuf::from(local_app_data);
    let candidates = [
      local.join("pnpm"),
      local.join("Yarn").join("bin"),
      local.join("Volta").join("bin"),
    ];
    for dir in candidates {
      if dir.is_dir() {
        dirs.push(dir.to_string_lossy().to_string());
      }
    }
  }
  if let Ok(user_profile) = std::env::var("USERPROFILE") {
    let profile = PathBuf::from(user_profile);
    let candidates = [profile.join(".bun").join("bin"), profile.join(".volta").join("bin")];
    for dir in candidates {
      if dir.is_dir() {
        dirs.push(dir.to_string_lossy().to_string());
      }
    }
  }
  if let Ok(bun_install) = std::env::var("BUN_INSTALL") {
    let bun_bin = PathBuf::from(bun_install).join("bin");
    if bun_bin.is_dir() {
      dirs.push(bun_bin.to_string_lossy().to_string());
    }
  }
  dirs
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

fn windows_binary_candidates_from_dir(dir: &Path, binary_name: &str) -> Vec<PathBuf> {
  if dir.as_os_str().is_empty() {
    return Vec::new();
  }
  [
    dir.join(format!("{}.cmd", binary_name)),
    dir.join(format!("{}.exe", binary_name)),
    dir.join(format!("{}.bat", binary_name)),
    dir.join(format!("{}.ps1", binary_name)),
    dir.join(binary_name),
  ]
  .into_iter()
  .collect()
}

fn windows_common_tool_candidate_paths(binary_name: &str) -> Vec<PathBuf> {
  if !cfg!(target_os = "windows") {
    return Vec::new();
  }

  let mut dirs: Vec<PathBuf> = Vec::new();
  if let Some(prefix) = windows_user_npm_prefix() {
    dirs.push(prefix);
  }
  dirs.extend(windows_user_extra_bin_dirs().into_iter().map(PathBuf::from));
  dirs.extend(windows_portable_node_dirs().into_iter().map(PathBuf::from));

  if let Ok(user_profile) = std::env::var("USERPROFILE") {
    dirs.push(PathBuf::from(&user_profile).join("scoop").join("shims"));
  }
  if let Ok(program_data) = std::env::var("ProgramData") {
    dirs.push(PathBuf::from(&program_data).join("chocolatey").join("bin"));
  }

  let mut seen = HashSet::new();
  let mut candidates = Vec::new();
  for dir in dirs {
    let dir_key = dir.to_string_lossy().to_ascii_lowercase();
    if !seen.insert(dir_key) || !dir.is_dir() {
      continue;
    }
    candidates.extend(windows_binary_candidates_from_dir(&dir, binary_name));
  }
  candidates
}

fn windows_binary_candidate_rank(path: &str) -> u8 {
  let lower = path.to_ascii_lowercase();
  if lower.ends_with(".cmd") {
    return 0;
  }
  if lower.ends_with(".exe") {
    return 1;
  }
  if lower.ends_with(".bat") {
    return 2;
  }
  if lower.ends_with(".ps1") {
    return 4;
  }
  3
}

fn read_binary_version_output(candidate_path: &Path) -> Option<String> {
  if !candidate_path.exists() {
    return None;
  }

  let path_text = candidate_path.to_string_lossy().to_string();
  let lower = path_text.to_ascii_lowercase();
  let output = if cfg!(target_os = "windows") && lower.ends_with(".ps1") {
    create_command("powershell.exe")
      .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
      .arg(&path_text)
      .arg("--version")
      .output()
      .ok()?
  } else {
    create_command(&path_text).arg("--version").output().ok()?
  };

  if !output.status.success() {
    return None;
  }

  Some(
    format!(
      "{}{}",
      String::from_utf8_lossy(&output.stdout),
      String::from_utf8_lossy(&output.stderr)
    )
    .trim()
    .to_string(),
  )
}

fn read_binary_version_output_with_options(candidate_path: &Path, passive: bool) -> Option<Option<String>> {
  if !candidate_path.exists() {
    return None;
  }
  if cfg!(target_os = "windows") && passive {
    return Some(None);
  }
  read_binary_version_output(candidate_path).map(Some)
}

fn collect_detected_binary_candidates(candidate_paths: Vec<PathBuf>, fallback_command: &str, passive: bool) -> Value {
  let mut seen = HashSet::new();
  let mut candidates = candidate_paths
    .into_iter()
    .filter(|path| seen.insert(path.to_string_lossy().to_ascii_lowercase()))
    .filter_map(|candidate_path| {
      let version = read_binary_version_output_with_options(&candidate_path, passive)?;
      let path_text = candidate_path.to_string_lossy().to_string();
      Some(json!({
        "installed": true,
        "version": version.map(Value::String).unwrap_or(Value::Null),
        "path": path_text,
      }))
    })
    .collect::<Vec<_>>();

  candidates.sort_by(|left, right| {
    if !passive {
      let left_version = left.get("version").and_then(Value::as_str).unwrap_or_default();
      let right_version = right.get("version").and_then(Value::as_str).unwrap_or_default();
      let version_order = compare_versions(right_version, left_version);
      if version_order != Ordering::Equal {
        return version_order;
      }
    }
    let left_rank = left
      .get("path")
      .and_then(Value::as_str)
      .map(windows_binary_candidate_rank)
      .unwrap_or(u8::MAX);
    let right_rank = right
      .get("path")
      .and_then(Value::as_str)
      .map(windows_binary_candidate_rank)
      .unwrap_or(u8::MAX);
    left_rank.cmp(&right_rank)
  });

  let selected = candidates.first().cloned();
  json!({
    "installed": selected.is_some(),
    "version": selected.as_ref().and_then(|item| item.get("version")).cloned().unwrap_or(Value::Null),
    "path": selected
      .as_ref()
      .and_then(|item| item.get("path").and_then(Value::as_str).map(|text| text.to_string()))
      .or_else(|| if passive { None } else { command_exists(fallback_command) })
      .unwrap_or_default(),
    "candidates": candidates,
  })
}

#[cfg(target_os = "windows")]
fn windows_registry_path_entries() -> Vec<String> {
  static CACHED: OnceLock<Vec<String>> = OnceLock::new();
  CACHED
    .get_or_init(|| {
      let script = "$user=[Environment]::GetEnvironmentVariable('Path','User');$machine=[Environment]::GetEnvironmentVariable('Path','Machine');Write-Output $user;Write-Output $machine";
      let mut command = Command::new("powershell.exe");
      command.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
      command.creation_flags(CREATE_NO_WINDOW);
      let output = command.output().ok();
      let mut parts = Vec::new();
      if let Some(out) = output.filter(|out| out.status.success()) {
        for line in String::from_utf8_lossy(&out.stdout).lines() {
          for item in line.split(';') {
            let entry = item.trim();
            if !entry.is_empty() {
              parts.push(entry.to_string());
            }
          }
        }
      }
      parts
    })
    .clone()
}

fn build_windows_path_env(include_registry_entries: bool) -> String {
  let current = std::env::var("PATH").unwrap_or_default();
  let mut parts: Vec<String> = Vec::new();
  parts.extend(windows_portable_node_dirs());
  if let Some(prefix) = windows_user_npm_prefix() {
    parts.push(prefix.to_string_lossy().to_string());
  }
  parts.extend(windows_user_extra_bin_dirs());
  parts.extend(windows_mingit_cmd_dirs());
  if include_registry_entries {
    #[cfg(target_os = "windows")]
    parts.extend(windows_registry_path_entries());
  }
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

fn build_windows_full_path_env() -> String {
  build_windows_path_env(true)
}

fn build_windows_passive_path_env() -> String {
  build_windows_path_env(false)
}

fn apply_discovery_path_env(passive: bool) {
  if cfg!(target_os = "windows") {
    let path_value = if passive {
      build_windows_passive_path_env()
    } else {
      build_windows_full_path_env()
    };
    std::env::set_var("PATH", path_value);
    return;
  }
  std::env::set_var("PATH", full_path_env());
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

      let bun_install_bin = std::env::var("BUN_INSTALL")
        .ok()
        .map(|path| PathBuf::from(path).join("bin").to_string_lossy().to_string())
        .unwrap_or_default();
      let pnpm_home = std::env::var("PNPM_HOME").unwrap_or_default();

      let extra_paths = [
        format!("{}/.nvm/versions/node/*/bin", home),
        format!("{}/.bun/bin", home),
        format!("{}/Library/pnpm", home),
        format!("{}/.local/share/pnpm", home),
        format!("{}/.pnpm", home),
        format!("{}/.yarn/bin", home),
        format!("{}/.config/yarn/global/node_modules/.bin", home),
        format!("{}/.volta/bin", home),
        format!("{}/.asdf/shims", home),
        format!("{}/.npm-global/bin", home),
        format!("{}/.local/bin", home),
        format!("{}/bin", home),
        bun_install_bin,
        pnpm_home,
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
  #[cfg(target_os = "windows")]
  cmd.creation_flags(CREATE_NO_WINDOW);
  cmd
}

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
fn launch_windows_background_command(cwd: &Path, command_text: &str, tool_label: &str) -> Result<String, String> {
  let mut cmd = create_command("cmd.exe");
  cmd.args(["/d", "/s", "/c", command_text])
    .current_dir(cwd)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .creation_flags(CREATE_NO_WINDOW);
  cmd.spawn().map_err(|error| error.to_string())?;
  Ok(format!("{} 已在后台启动", tool_label))
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


fn opencode_install_tasks() -> &'static Mutex<BTreeMap<String, OpenCodeInstallTask>> {
  OPENCODE_INSTALL_TASKS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn opencode_install_steps(action: &str) -> Vec<OpenCodeInstallStep> {
  let specs = if action == "uninstall" {
    vec![
      ("inspect", "检查当前安装", "确认当前 OpenCode 安装状态与路径", "先确认当前命令在哪里。", 10_u64),
      ("remove", "执行卸载命令", "按最终方式移除 OpenCode", "正在移除全局命令和安装内容。", 58_u64),
      ("verify", "验证卸载结果", "确认 `opencode` 命令已经不可用", "马上结束，正在做最后确认。", 92_u64),
    ]
  } else {
    vec![
      ("network", "检测网络环境", "检测 Google 可达性并判断是否走国内优化", "这一步是真实网络探测，请稍等。", 8_u64),
      ("method", "确定安装方式", "根据你的选择和网络结果确定最终安装方案", "正在确认最终执行方式和命令。", 28_u64),
      ("execute", "执行安装命令", "真正开始安装 OpenCode 与依赖", "这里耗时最长，日志会持续更新。", 62_u64),
      ("verify", "验证安装结果", "确认 `opencode` 命令已经可用", "快完成了，正在验证版本和命令。", 92_u64),
    ]
  };

  specs.into_iter().enumerate().map(|(index, (key, title, description, hint, progress))| OpenCodeInstallStep {
    key: key.to_string(),
    title: title.to_string(),
    description: description.to_string(),
    hint: hint.to_string(),
    progress,
    status: if index == 0 { "running".to_string() } else { "pending".to_string() },
  }).collect()
}

fn create_opencode_install_task(action: &str, requested_method: &str) -> OpenCodeInstallTask {
  let id = format!(
    "opencode-install-{}-{}",
    chrono::Utc::now().timestamp_millis(),
    OPENCODE_INSTALL_TASK_SEQ.fetch_add(1, AtomicOrdering::Relaxed)
  );
  let started_at = now_rfc3339();
  let steps = opencode_install_steps(action);
  OpenCodeInstallTask {
    task_id: id,
    tool_id: "opencode".to_string(),
    action: action.to_string(),
    requested_method: requested_method.to_string(),
    method: String::new(),
    command: String::new(),
    google_reachable: None,
    used_domestic_mirror: None,
    status: "running".to_string(),
    progress: steps.first().map(|step| step.progress).unwrap_or(4),
    step_index: 0,
    summary: steps.first().map(|step| step.description.clone()).unwrap_or_else(|| "正在准备任务…".to_string()),
    hint: steps.first().map(|step| step.hint.clone()).unwrap_or_else(|| "请稍候。".to_string()),
    detail: if action == "uninstall" { "正在读取当前安装状态…".to_string() } else { "正在初始化安装任务…".to_string() },
    steps,
    logs: Vec::new(),
    started_at: started_at.clone(),
    updated_at: started_at,
    completed_at: None,
    version: None,
    error: None,
    cancel_requested: false,
    child_pid: None,
  }
}

fn trim_opencode_install_tasks(tasks: &mut BTreeMap<String, OpenCodeInstallTask>) {
  while tasks.len() > OPENCODE_INSTALL_TASK_KEEP {
    let removable = tasks.iter().find(|(_, task)| task.status != "running" && task.status != "cancelling").map(|(task_id, _)| task_id.clone());
    if let Some(task_id) = removable {
      tasks.remove(&task_id);
    } else {
      break;
    }
  }
}

fn insert_opencode_install_task(task: OpenCodeInstallTask) {
  match opencode_install_tasks().lock() {
    Ok(mut tasks) => {
      tasks.insert(task.task_id.clone(), task);
      trim_opencode_install_tasks(&mut tasks);
    }
    Err(e) => eprintln!("opencode tasks lock poisoned: {}", e),
  }
}

fn with_opencode_install_task<R>(task_id: &str, mut update: impl FnMut(&mut OpenCodeInstallTask) -> R) -> Option<R> {
  let mut tasks = opencode_install_tasks().lock().ok()?;
  let task = tasks.get_mut(task_id)?;
  Some(update(task))
}

fn get_opencode_install_task_snapshot(task_id: &str) -> Option<OpenCodeInstallTask> {
  let tasks = opencode_install_tasks().lock().ok()?;
  tasks.get(task_id).cloned()
}

fn touch_opencode_install_task(task: &mut OpenCodeInstallTask) {
  task.updated_at = now_rfc3339();
}

fn set_opencode_install_step(task: &mut OpenCodeInstallTask, step_index: usize, detail: Option<String>) {
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
      if task.status == "error" { "error".to_string() } else { "running".to_string() }
    } else {
      "pending".to_string()
    };
  }
  touch_opencode_install_task(task);
}

fn push_opencode_install_log(task_id: &str, source: &str, line: &str) {
  let cleaned = line.trim().to_string();
  if cleaned.is_empty() {
    return;
  }
  let _ = with_opencode_install_task(task_id, |task| {
    task.logs.push(OpenCodeInstallLog {
      source: source.to_string(),
      text: cleaned.clone(),
      at: now_rfc3339(),
    });
    if task.logs.len() > 160 {
      let drain_len = task.logs.len() - 160;
      task.logs.drain(0..drain_len);
    }
    task.detail = cleaned.clone();
    if task.status == "running" && task.step_index == 2 && task.action != "uninstall" {
      task.progress = task.progress.max(62).min(88);
    }
    touch_opencode_install_task(task);
  });
}

fn infer_opencode_uninstall_method() -> String {
  let binary = find_tool_binary("opencode");
  let path = binary.get("path").and_then(Value::as_str).unwrap_or("").to_lowercase();
  if path.contains("homebrew") || path.contains("/cellar/") {
    return "brew".to_string();
  }
  "npm".to_string()
}

fn resolve_opencode_effective_method_for_task(method: &str) -> (String, Option<bool>) {
  let normalized = resolve_opencode_install_method(method);
  if normalized != "auto" {
    return (normalized, None);
  }
  let google_ok = can_access_google();
  if google_ok {
    if cfg!(target_os = "windows") {
      ("npm".to_string(), Some(true))
    } else {
      ("script".to_string(), Some(true))
    }
  } else {
    ("domestic".to_string(), Some(false))
  }
}

fn build_opencode_task_command(action: &str, method: &str) -> (String, Vec<String>, String) {
  let latest_package = format!("{}@latest", OPENCODE_PACKAGE);
  match method {
    "domestic" => {
      let mut args = if action == "uninstall" {
        vec!["uninstall".to_string(), "-g".to_string(), OPENCODE_PACKAGE.to_string()]
      } else {
        let mut args = vec!["install".to_string(), "-g".to_string(), latest_package.clone()];
        if action == "reinstall" { args.push("--force".to_string()); }
        args
      };
      if action != "uninstall" {
        args.push("--registry".to_string());
        args.push(OPENCODE_NPM_REGISTRY_CN.to_string());
      }
      (npm_command().to_string(), args.clone(), format!("{} {}", npm_command(), args.join(" ")))
    }
    "npm" => {
      let args = if action == "uninstall" {
        vec!["uninstall".to_string(), "-g".to_string(), OPENCODE_PACKAGE.to_string()]
      } else {
        let mut args = vec!["install".to_string(), "-g".to_string(), latest_package.clone()];
        if action == "reinstall" { args.push("--force".to_string()); }
        args
      };
      (npm_command().to_string(), args.clone(), format!("{} {}", npm_command(), args.join(" ")))
    }
    "brew" => {
      let script = if action == "install" {
        "brew install anomalyco/tap/opencode".to_string()
      } else if action == "reinstall" {
        "brew reinstall anomalyco/tap/opencode".to_string()
      } else if action == "update" {
        "brew upgrade anomalyco/tap/opencode || brew install anomalyco/tap/opencode".to_string()
      } else {
        "brew uninstall anomalyco/tap/opencode || brew uninstall opencode".to_string()
      };
      ("sh".to_string(), vec!["-lc".to_string(), script.clone()], script)
    }
    "scoop" => {
      let script = if action == "install" {
        "scoop install opencode".to_string()
      } else if action == "reinstall" {
        "scoop uninstall opencode; scoop install opencode".to_string()
      } else if action == "update" {
        "scoop update opencode".to_string()
      } else {
        "scoop uninstall opencode".to_string()
      };
      ("powershell.exe".to_string(), vec!["-NoProfile".to_string(), "-NonInteractive".to_string(), "-ExecutionPolicy".to_string(), "Bypass".to_string(), "-Command".to_string(), script.clone()], script)
    }
    "choco" => {
      let script = if action == "install" {
        "choco install opencode -y".to_string()
      } else if action == "reinstall" {
        "choco uninstall opencode -y; choco install opencode -y".to_string()
      } else if action == "update" {
        "choco upgrade opencode -y".to_string()
      } else {
        "choco uninstall opencode -y".to_string()
      };
      ("powershell.exe".to_string(), vec!["-NoProfile".to_string(), "-NonInteractive".to_string(), "-ExecutionPolicy".to_string(), "Bypass".to_string(), "-Command".to_string(), script.clone()], script)
    }
    "script" => {
      if cfg!(target_os = "windows") {
        ("powershell.exe".to_string(), vec!["-NoProfile".to_string(), "-NonInteractive".to_string(), "-ExecutionPolicy".to_string(), "Bypass".to_string(), "-Command".to_string(), OPENCODE_INSTALL_SCRIPT_UNIX.to_string()], OPENCODE_INSTALL_SCRIPT_UNIX.to_string())
      } else {
        ("sh".to_string(), vec!["-lc".to_string(), OPENCODE_INSTALL_SCRIPT_UNIX.to_string()], OPENCODE_INSTALL_SCRIPT_UNIX.to_string())
      }
    }
    _ => {
      let binary = find_tool_binary("opencode");
      let path = binary.get("path").and_then(Value::as_str).unwrap_or("").trim().to_string();
      let script = if path.is_empty() {
        "rm -f <opencode-binary>".to_string()
      } else if cfg!(target_os = "windows") {
        format!("Remove-Item -Force '{}'", path.replace('\'', "''"))
      } else {
        format!("rm -f {}", quote_posix_shell_arg(&path))
      };
      if cfg!(target_os = "windows") {
        ("powershell.exe".to_string(), vec!["-NoProfile".to_string(), "-NonInteractive".to_string(), "-ExecutionPolicy".to_string(), "Bypass".to_string(), "-Command".to_string(), script.clone()], script)
      } else {
        ("sh".to_string(), vec!["-lc".to_string(), script.clone()], script)
      }
    }
  }
}

fn cancel_opencode_install_task_inner(task_id: &str) -> Result<(), String> {
  let mut pid_to_kill = None;
  let exists = with_opencode_install_task(task_id, |task| {
    if task.status != "running" && task.status != "cancelling" {
      return;
    }
    task.cancel_requested = true;
    task.status = "cancelling".to_string();
    task.summary = "正在中断 OpenCode 安装…".to_string();
    task.hint = "先别关闭窗口，正在停止安装进程。".to_string();
    task.detail = "正在终止安装命令…".to_string();
    pid_to_kill = task.child_pid;
    touch_opencode_install_task(task);
  });
  if exists.is_none() {
    return Err("OpenCode 任务不存在，可能已经过期，请重新开始".to_string());
  }

  if let Some(pid) = pid_to_kill {
    terminate_openclaw_install_process(pid);
  }

  let _ = with_opencode_install_task(task_id, |task| {
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
    task.error = None;
    task.summary = "OpenCode 安装已中断".to_string();
    task.hint = "你可以随时重新开始安装。".to_string();
    task.detail = "安装进程已停止。".to_string();
    task.completed_at = Some(now_rfc3339());
    touch_opencode_install_task(task);
  });
  Ok(())
}

fn fail_opencode_install_task(task_id: &str, message: String) {
  let _ = with_opencode_install_task(task_id, |task| {
    if task.cancel_requested || task.status == "cancelled" {
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
    task.summary = if task.action == "uninstall" { "OpenCode 卸载失败".to_string() } else { "OpenCode 安装失败".to_string() };
    task.hint = "先看最后日志，通常能直接看到是网络、权限还是依赖问题。".to_string();
    task.detail = message.clone();
    task.child_pid = None;
    task.error = Some(message.clone());
    task.completed_at = Some(now_rfc3339());
    touch_opencode_install_task(task);
  });
}

fn complete_opencode_install_task(task_id: &str, version: Option<String>) {
  let _ = with_opencode_install_task(task_id, |task| {
    for step in task.steps.iter_mut() {
      step.status = "done".to_string();
    }
    task.status = "success".to_string();
    task.progress = 100;
    task.summary = if task.action == "update" { "OpenCode 已更新完成".to_string() } else if task.action == "reinstall" { "OpenCode 已重装完成".to_string() } else if task.action == "uninstall" { "OpenCode 已卸载完成".to_string() } else { "OpenCode 已安装完成".to_string() };
    task.hint = if task.action == "uninstall" { "如需恢复，重新点击安装即可。".to_string() } else { "下一步可以直接启动 OpenCode，或先去配置 Provider / 模型。".to_string() };
    task.detail = if task.action == "uninstall" { "已确认 opencode 命令不可用。".to_string() } else { version.clone().map(|v| format!("已检测到版本：{v}")).unwrap_or_else(|| "已检测到 opencode 命令。".to_string()) };
    task.child_pid = None;
    task.version = version.clone();
    task.completed_at = Some(now_rfc3339());
    touch_opencode_install_task(task);
  });
}

fn spawn_opencode_install_task_runner(task_id: String) {
  thread::spawn(move || {
    let task = match get_opencode_install_task_snapshot(&task_id) {
      Some(task) => task,
      None => return,
    };

    let action = task.action.clone();
    let requested_method = task.requested_method.clone();
    let (effective_method, google_reachable) = if action == "uninstall" {
      let normalized = resolve_opencode_install_method(&requested_method);
      if normalized == "auto" {
        (infer_opencode_uninstall_method(), None)
      } else {
        (normalized, None)
      }
    } else {
      resolve_opencode_effective_method_for_task(&requested_method)
    };
    let (program, args, display_command) = build_opencode_task_command(&action, &effective_method);

    let _ = with_opencode_install_task(&task_id, |task| {
      task.method = effective_method.clone();
      task.google_reachable = google_reachable;
      task.used_domestic_mirror = Some(effective_method == "domestic");
      task.command = display_command.clone();
      if action == "uninstall" {
        set_opencode_install_step(task, 1, Some(format!("即将执行：{}", task.command)));
      } else {
        set_opencode_install_step(task, 1, Some(format!("已确认最终方式：{}", task.method)));
      }
    });

    if action != "uninstall" {
      if let Some(reachable) = google_reachable {
        push_opencode_install_log(&task_id, "stdout", &format!("Google 可达性检测结果：{}", if reachable { "可访问" } else { "不可访问" }));
      } else {
        push_opencode_install_log(&task_id, "stdout", "本次按你的指定方式执行，未触发 Google 连通性检测。");
      }
      push_opencode_install_log(&task_id, "stdout", &format!("最终安装方式：{}", effective_method));
    } else {
      push_opencode_install_log(&task_id, "stdout", &format!("最终卸载方式：{}", effective_method));
    }
    push_opencode_install_log(&task_id, "stdout", &format!("执行命令：{}", display_command));

    if (effective_method == "npm" || effective_method == "domestic") && action != "uninstall" {
      let node_output = create_command("node").arg("--version").output();
      let npm_output = create_command(npm_command()).arg("--version").output();
      match (node_output, npm_output) {
        (Ok(node), Ok(npm)) if node.status.success() && npm.status.success() => {
          let node_version = String::from_utf8_lossy(&node.stdout).trim().to_string();
          let npm_version = String::from_utf8_lossy(&npm.stdout).trim().to_string();
          push_opencode_install_log(&task_id, "stdout", &format!("Node.js {node_version} / npm {npm_version}"));
        }
        _ => {
          fail_opencode_install_task(&task_id, "未检测到 Node.js 或 npm，请先安装 Node.js 18+。".to_string());
          return;
        }
      }
    }

    if effective_method == "script" && !cfg!(target_os = "windows") && command_exists("curl").is_none() {
      fail_opencode_install_task(&task_id, "未检测到 `curl`，无法执行官方脚本安装。请先安装 curl，或改用 npm 安装。".to_string());
      return;
    }

    let _ = with_opencode_install_task(&task_id, |task| {
      if action != "uninstall" {
        set_opencode_install_step(task, 2, Some(format!("正在执行：{}", task.command)));
      }
    });

    let mut command = create_command(&program);
    command.args(&args);
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match command.spawn() {
      Ok(child) => child,
      Err(error) => {
        fail_opencode_install_task(&task_id, error.to_string());
        return;
      }
    };

    let _ = with_opencode_install_task(&task_id, |task| {
      task.child_pid = Some(child.id());
      touch_opencode_install_task(task);
    });

    let stdout_handle = child.stdout.take().map(|stdout| {
      let task_id = task_id.clone();
      thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
          push_opencode_install_log(&task_id, "stdout", &line);
        }
      })
    });

    let stderr_handle = child.stderr.take().map(|stderr| {
      let task_id = task_id.clone();
      thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
          push_opencode_install_log(&task_id, "stderr", &line);
        }
      })
    });

    let status = match child.wait() {
      Ok(status) => status,
      Err(error) => {
        fail_opencode_install_task(&task_id, error.to_string());
        return;
      }
    };

    if let Some(handle) = stdout_handle { let _ = handle.join(); }
    if let Some(handle) = stderr_handle { let _ = handle.join(); }

    if get_opencode_install_task_snapshot(&task_id).map(|task| task.cancel_requested || task.status == "cancelled").unwrap_or(false) {
      return;
    }

    if !status.success() {
      let message = get_opencode_install_task_snapshot(&task_id)
        .and_then(|task| task.logs.last().map(|item| item.text.clone()))
        .unwrap_or_else(|| format!("安装命令退出码：{}", status.code().map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string())));
      fail_opencode_install_task(&task_id, message);
      return;
    }

    let binary = find_tool_binary("opencode");
    if action == "uninstall" {
      if binary.get("installed").and_then(Value::as_bool).unwrap_or(false) {
        fail_opencode_install_task(&task_id, "卸载命令已执行完成，但系统里仍检测到 `opencode` 命令。".to_string());
        return;
      }
      complete_opencode_install_task(&task_id, None);
      return;
    }

    let _ = with_opencode_install_task(&task_id, |task| {
      set_opencode_install_step(task, 3, Some("安装命令执行完成，正在验证 opencode 命令…".to_string()));
    });

    if !binary.get("installed").and_then(Value::as_bool).unwrap_or(false) {
      fail_opencode_install_task(&task_id, "安装命令已执行完成，但系统里仍未找到 `opencode` 命令。".to_string());
      return;
    }

    complete_opencode_install_task(&task_id, binary.get("version").and_then(Value::as_str).map(|s| s.to_string()));
  });
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
  match openclaw_install_tasks().lock() {
    Ok(mut tasks) => {
      tasks.insert(task.task_id.clone(), task);
      trim_openclaw_install_tasks(&mut tasks);
    }
    Err(e) => eprintln!("openclaw tasks lock poisoned: {}", e),
  }
}

fn with_openclaw_install_task<R>(task_id: &str, mut update: impl FnMut(&mut OpenClawInstallTask) -> R) -> Option<R> {
  let mut tasks = openclaw_install_tasks().lock().ok()?;
  let task = tasks.get_mut(task_id)?;
  Some(update(task))
}

fn get_openclaw_install_task_snapshot(task_id: &str) -> Option<OpenClawInstallTask> {
  let tasks = openclaw_install_tasks().lock().ok()?;
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
    let _ = create_command("taskkill")
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

fn apply_windows_user_npm_env(command: &mut Command) {
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
  }
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

fn command_exists_with_options(command: &str, passive: bool) -> Option<String> {
  apply_discovery_path_env(passive);
  which::which(command).ok().map(|path| path.to_string_lossy().to_string())
}

fn command_exists(command: &str) -> Option<String> {
  command_exists_with_options(command, false)
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

fn codex_candidates(passive: bool) -> Vec<PathBuf> {
  apply_discovery_path_env(passive);
  let mut paths = which::which_all("codex")
    .map(|items| items.collect::<Vec<_>>())
    .unwrap_or_default();

  if let Ok(home) = home_dir() {
    if cfg!(target_os = "windows") {
      paths.extend(windows_common_tool_candidate_paths("codex"));
    } else {
      paths.extend([
        home.join(".npm-global").join("bin").join("codex"),
        home.join(".bun").join("bin").join("codex"),
        home.join("Library").join("pnpm").join("codex"),
        home.join(".local").join("share").join("pnpm").join("codex"),
        home.join(".pnpm").join("codex"),
        home.join(".yarn").join("bin").join("codex"),
        home.join(".volta").join("bin").join("codex"),
        home.join(".asdf").join("shims").join("codex"),
        PathBuf::from("/usr/local/bin/codex"),
        PathBuf::from("/opt/homebrew/bin/codex"),
      ]);
    }
  }

  paths
}

pub(crate) fn find_codex_binary() -> Value {
  find_codex_binary_with_options(false)
}

pub(crate) fn find_codex_binary_with_options(passive: bool) -> Value {
  let mut detected = collect_detected_binary_candidates(codex_candidates(passive), "codex", passive);
  if let Some(object) = detected.as_object_mut() {
    object.insert(
      "installCommand".to_string(),
      Value::String(format!("{} install -g {}", npm_command(), OPENAI_CODEX_PACKAGE)),
    );
  }
  detected
}

pub(crate) fn codex_npm_action(args: &[&str]) -> Result<Value, String> {
  let mut cmd = create_command(npm_command());
  cmd.args(args).stdin(Stdio::null());
  apply_windows_user_npm_env(&mut cmd);
  let output = cmd.output().map_err(|error| error.to_string())?;
  let stdout = String::from_utf8_lossy(&output.stdout).to_string();
  let stderr = String::from_utf8_lossy(&output.stderr).to_string();
  Ok(json!({
    "ok": output.status.success(),
    "code": output.status.code(),
    "stdout": stdout,
    "stderr": stderr,
    "command": format!("{} {}", npm_command(), args.join(" ")),
  }))
}

fn escape_applescript(text: &str) -> String {
  text.replace('\\', "\\\\").replace('"', "\\\"")
}

fn macos_iterm_available() -> bool {
  let home = home_dir().ok();
  Path::new("/Applications/iTerm.app").exists()
    || Path::new("/Applications/iTerm2.app").exists()
    || home.as_ref().map(|h| h.join("Applications/iTerm.app").exists()).unwrap_or(false)
    || home.as_ref().map(|h| h.join("Applications/iTerm2.app").exists()).unwrap_or(false)
}

fn macos_termius_available() -> bool {
  let home = home_dir().ok();
  Path::new("/Applications/Termius.app").exists()
    || home.as_ref().map(|h| h.join("Applications/Termius.app").exists()).unwrap_or(false)
}

fn resolve_macos_terminal_profile(profile: &str) -> &'static str {
  let normalized = profile.trim().to_lowercase();
  if normalized == "terminal" {
    return "terminal";
  }
  if normalized == "termius" {
    return if macos_termius_available() { "termius" } else { "terminal" };
  }
  if normalized == "iterm" {
    return if macos_iterm_available() { "iterm" } else { "terminal" };
  }
  if macos_iterm_available() { "iterm" } else { "terminal" }
}

fn launch_macos_terminal_with_profile(cwd: &Path, command_text: &str, tool_label: &str, terminal_profile: &str) -> Result<String, String> {
  let shell_command = format!("cd {} && {}", quote_posix_shell_arg(&cwd.to_string_lossy()), command_text);
  let resolved = resolve_macos_terminal_profile(terminal_profile);

  if resolved == "termius" {
    let opened = create_command("open")
      .args(["-a", "Termius"])
      .output()
      .map_err(|error| error.to_string())?;
    if !opened.status.success() {
      return Err(String::from_utf8_lossy(&opened.stderr).trim().to_string());
    }

    let script = [
      "tell application \"Termius\" to activate",
      "delay 0.25",
      "tell application \"System Events\"",
      &format!("keystroke \"{}\"", escape_applescript(&shell_command)),
      "key code 36",
      "end tell",
    ].join("\n");
    let typed = create_command("osascript")
      .arg("-e")
      .arg(script)
      .output()
      .map_err(|error| error.to_string())?;
    if typed.status.success() {
      return Ok(format!("{} 已在 Termius 中启动", tool_label));
    }

    return Ok(format!("{} 已打开 Termius，请在 Termius 中执行：{}", tool_label, shell_command));
  }

  let script = if resolved == "iterm" {
    [
      "tell application \"iTerm\"",
      "activate",
      "create window with default profile",
      &format!(
        "tell current session of current window to write text \"{}\"",
        escape_applescript(&shell_command)
      ),
      "end tell",
    ]
    .join("\n")
  } else {
    [
      "tell application \"Terminal\"",
      "activate",
      &format!("do script \"{}\"", escape_applescript(&shell_command)),
      "end tell",
    ]
    .join("\n")
  };

  let output = create_command("osascript")
    .arg("-e")
    .arg(script)
    .output()
    .map_err(|error| error.to_string())?;
  if !output.status.success() {
    return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
  }

  let app_label = if resolved == "iterm" { "iTerm" } else { "Terminal" };
  Ok(format!("{} 已在 {} 中启动", tool_label, app_label))
}

fn requested_codex_home_from_object(object: &Map<String, Value>) -> Result<PathBuf, String> {
  let input = get_string(object, "codexHome");
  if input.is_empty() {
    default_codex_home()
  } else {
    Ok(PathBuf::from(input))
  }
}

fn with_codex_home_command(command: &str, codex_home: &Path) -> String {
  if cfg!(target_os = "windows") {
    return format!(
      "set \"CODEX_HOME={}\" && {}",
      normalize_windows_cmd_path(&codex_home.to_string_lossy()),
      command
    );
  }
  format!(
    "CODEX_HOME={} {}",
    quote_posix_shell_arg(&codex_home.to_string_lossy()),
    command
  )
}

fn launch_codex_terminal_command(cwd: &Path, terminal_profile: &str, codex_home: &Path) -> Result<String, String> {
  let codex_binary = find_codex_binary();
  let codex_path = codex_binary
    .get("path")
    .and_then(Value::as_str)
    .filter(|path| !path.is_empty())
    .unwrap_or("codex");
  let command_text = if cfg!(target_os = "windows") {
    let empty_args: Vec<String> = Vec::new();
    with_codex_home_command(&build_windows_binary_command(codex_path, &empty_args, "codex"), codex_home)
  } else {
    with_codex_home_command(&quote_posix_shell_arg(codex_path), codex_home)
  };

  if cfg!(target_os = "macos") {
    return launch_macos_terminal_with_profile(cwd, &command_text, "Codex", terminal_profile);
  }

  launch_terminal_command(cwd, &command_text, "Codex")
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
  let codex_home = requested_codex_home_from_object(&object)?;
  ensure_dir(&codex_home)?;
  let terminal_profile = get_string(&object, "terminalProfile");
  let codex_binary = find_codex_binary();
  if !codex_binary.get("installed").and_then(Value::as_bool).unwrap_or(false) {
    return Err("Codex 尚未安装，请先点击安装".to_string());
  }
  let message = launch_codex_terminal_command(&cwd, &terminal_profile, &codex_home)?;
  Ok(json!({
    "ok": true,
    "cwd": cwd.to_string_lossy().to_string(),
    "codexHome": codex_home.to_string_lossy().to_string(),
    "message": message
  }))
}

pub(crate) fn login_codex(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let cwd = {
    let input = get_string(&object, "cwd");
    if input.is_empty() { home_dir()? } else { PathBuf::from(input) }
  };
  let terminal_profile = get_string(&object, "terminalProfile");
  let codex_home = requested_codex_home_from_object(&object)?;
  ensure_dir(&codex_home)?;
  let live_auth_raw = read_text(&codex_home.join("auth.json")).unwrap_or_default();
  if !live_auth_raw.trim().is_empty() {
    migrate_auth_json_env_to_codex_env(&codex_home, &live_auth_raw)?;
    let _ = write_switch_backup(&live_auth_raw);
  }
  let codex_binary = find_codex_binary();
  if !codex_binary.get("installed").and_then(Value::as_bool).unwrap_or(false) {
    return Err("Codex 尚未安装，请先点击安装".to_string());
  }
  let binary_path = codex_binary
    .get("path")
    .and_then(Value::as_str)
    .filter(|text| !text.trim().is_empty())
    .unwrap_or("codex");
  let command = if cfg!(target_os = "windows") {
    build_windows_binary_command(binary_path, &["login".to_string()], "codex")
  } else {
    format!("{} login", quote_posix_shell_arg(binary_path))
  };
  let command = with_codex_home_command(&command, &codex_home);
  let message = if cfg!(target_os = "macos") {
    launch_macos_terminal_with_profile(&cwd, &command, "Codex 登录", &terminal_profile)?
  } else {
    launch_terminal_command(&cwd, &command, "Codex 登录")?
  };
  Ok(json!({
    "ok": true,
    "cwd": cwd.to_string_lossy().to_string(),
    "codexHome": codex_home.to_string_lossy().to_string(),
    "message": message
  }))
}

fn normalize_codex_session_preview(text: &str, fallback: &str) -> String {
  let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
  if collapsed.is_empty() {
    return fallback.to_string();
  }
  if collapsed.chars().count() > 72 {
    let prefix = collapsed.chars().take(72).collect::<String>();
    return format!("{}...", prefix);
  }
  collapsed
}

fn extract_codex_user_message_preview(event: &Value) -> String {
  let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
  let payload = event.get("payload").and_then(Value::as_object);
  if event_type == "event_msg" && payload.and_then(|item| item.get("type")).and_then(Value::as_str) == Some("user_message") {
    return normalize_codex_session_preview(payload.and_then(|item| item.get("message")).and_then(Value::as_str).unwrap_or(""), "");
  }
  if event_type == "response_item"
    && payload.and_then(|item| item.get("type")).and_then(Value::as_str) == Some("message")
    && payload.and_then(|item| item.get("role")).and_then(Value::as_str) == Some("user") {
    let content = payload.and_then(|item| item.get("content")).and_then(Value::as_array);
    let joined = content
      .map(|items| {
        items
          .iter()
          .filter(|item| item.get("type").and_then(Value::as_str) == Some("input_text"))
          .filter_map(|item| item.get("text").and_then(Value::as_str).map(str::trim))
          .filter(|text| !text.is_empty())
          .collect::<Vec<_>>()
          .join(" ")
      })
      .unwrap_or_default();
    return normalize_codex_session_preview(&joined, "");
  }
  String::new()
}

fn normalize_path_for_compare(raw: &str) -> Option<PathBuf> {
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return None;
  }
  let mut normalized = PathBuf::new();
  let base = if Path::new(trimmed).is_absolute() {
    PathBuf::from(trimmed)
  } else {
    std::env::current_dir().ok()?.join(trimmed)
  };
  for component in base.components() {
    match component {
      std::path::Component::CurDir => {}
      std::path::Component::ParentDir => {
        let _ = normalized.pop();
      }
      _ => normalized.push(component.as_os_str()),
    }
  }
  Some(normalized)
}

fn is_same_or_nested_path(left: &str, right: &str) -> bool {
  let Some(left_path) = normalize_path_for_compare(left) else { return false; };
  let Some(right_path) = normalize_path_for_compare(right) else { return false; };
  left_path == right_path || left_path.starts_with(&right_path) || right_path.starts_with(&left_path)
}

fn is_uuid_like(text: &str) -> bool {
  if text.len() != 36 {
    return false;
  }
  text.chars().enumerate().all(|(idx, ch)| match idx {
    8 | 13 | 18 | 23 => ch == '-',
    _ => ch.is_ascii_hexdigit(),
  })
}

fn extract_codex_session_id_from_stem(stem: &str) -> String {
  let trimmed = stem.trim();
  if trimmed.len() >= 36 {
    if let Some(candidate) = trimmed.get(trimmed.len() - 36..) {
      if is_uuid_like(candidate) {
        return candidate.to_string();
      }
    }
  }
  trimmed.to_string()
}

fn normalize_codex_session_id(session_id: &str) -> String {
  let raw = session_id.trim();
  if raw.is_empty() {
    return String::new();
  }
  if is_uuid_like(raw) {
    return raw.to_string();
  }
  if raw.len() >= 36 {
    if let Some(candidate) = raw.get(raw.len() - 36..) {
      if is_uuid_like(candidate) {
        return candidate.to_string();
      }
    }
  }
  raw.to_string()
}

fn read_codex_session_summary(file_path: &Path, modified_ms: u64) -> Option<Value> {
  let file = File::open(file_path).ok()?;
  let reader = BufReader::new(file);
  let mut session_id = String::new();
  let mut cwd = String::new();
  let mut provider = String::new();
  let mut model = String::new();
  let mut title = String::new();

  for line in reader.lines().map_while(Result::ok) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
      continue;
    }
    let Ok(event) = serde_json::from_str::<Value>(trimmed) else { continue; };
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
    if event_type == "session_meta" {
      if let Some(payload) = event.get("payload").and_then(Value::as_object) {
        let meta_id = payload.get("id").and_then(Value::as_str).unwrap_or("").trim();
        let meta_cwd = payload.get("cwd").and_then(Value::as_str).unwrap_or("").trim();
        let meta_provider = payload.get("model_provider").and_then(Value::as_str).unwrap_or("").trim();
        let meta_model = payload.get("model").and_then(Value::as_str).unwrap_or("").trim();
        if !meta_id.is_empty() { session_id = meta_id.to_string(); }
        if !meta_cwd.is_empty() { cwd = meta_cwd.to_string(); }
        if !meta_provider.is_empty() { provider = meta_provider.to_string(); }
        if !meta_model.is_empty() { model = meta_model.to_string(); }
      }
      continue;
    }
    if event_type == "turn_context" {
      if cwd.is_empty() {
        if let Some(turn_cwd) = event
          .get("payload")
          .and_then(Value::as_object)
          .and_then(|item| item.get("cwd"))
          .and_then(Value::as_str)
          .map(str::trim)
          .filter(|value| !value.is_empty()) {
          cwd = turn_cwd.to_string();
        }
      }
      if let Some(turn_model) = event
        .get("payload")
        .and_then(Value::as_object)
        .and_then(|item| item.get("model"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty()) {
        model = turn_model.to_string();
      }
      continue;
    }
    if title.is_empty() {
      title = extract_codex_user_message_preview(&event);
    }
  }

  let stem = file_path.file_stem().and_then(|name| name.to_str()).unwrap_or("unknown");
  let fallback_session_id = extract_codex_session_id_from_stem(stem);
  let updated_at_ms = if modified_ms > 0 { modified_ms } else { chrono::Utc::now().timestamp_millis().max(0) as u64 };
  let updated_at = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(updated_at_ms.min(i64::MAX as u64) as i64)
    .map(|time| time.to_rfc3339())
    .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

  Some(json!({
    "sessionId": if session_id.is_empty() { fallback_session_id } else { session_id },
    "title": if title.is_empty() { normalize_codex_session_preview(stem, "未命名会话") } else { title },
    "cwd": cwd,
    "provider": if provider.is_empty() { "unknown".to_string() } else { provider },
    "model": if model.is_empty() { "unknown".to_string() } else { model },
    "updatedAt": updated_at,
    "updatedAtMs": updated_at_ms,
    "filePath": file_path.to_string_lossy().to_string(),
  }))
}

fn build_codex_session_command(binary_path: &str, args: &[String]) -> String {
  if cfg!(target_os = "windows") {
    return build_windows_binary_command(binary_path, args, "codex");
  }
  let binary = if binary_path.trim().is_empty() { "codex".to_string() } else { quote_posix_shell_arg(binary_path) };
  let mut parts = vec![binary];
  parts.extend(args.iter().map(|arg| quote_posix_shell_arg(arg)));
  parts.join(" ")
}

fn resolve_codex_session_path(file_path: &str, codex_home: &Path) -> Result<PathBuf, String> {
  let trimmed = file_path.trim();
  if trimmed.is_empty() {
    return Err("缺少会话文件路径".to_string());
  }
  let candidate = PathBuf::from(trimmed);
  if candidate.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
    return Err("会话文件必须是 .jsonl".to_string());
  }
  if !candidate.exists() {
    return Err("会话文件不存在".to_string());
  }
  let sessions_root = codex_home.join("sessions");
  if sessions_root.exists() {
    let canonical_root = fs::canonicalize(&sessions_root).unwrap_or(sessions_root);
    let canonical_file = fs::canonicalize(&candidate).map_err(|error| error.to_string())?;
    if !canonical_file.starts_with(&canonical_root) {
      return Err("会话文件不在 CODEX_HOME/sessions 目录中".to_string());
    }
    return Ok(canonical_file);
  }
  Ok(candidate)
}

fn extract_codex_event_preview(event: &Value) -> String {
  let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
  if event_type == "event_msg" && event.get("payload").and_then(Value::as_object).and_then(|item| item.get("type")).and_then(Value::as_str) == Some("user_message") {
    let payload = event.get("payload").and_then(Value::as_object);
    let message = payload.and_then(|item| item.get("message")).and_then(Value::as_str).unwrap_or("");
    return normalize_codex_session_preview(message, "");
  }
  if event_type == "response_item"
    && event.get("payload").and_then(Value::as_object).and_then(|item| item.get("type")).and_then(Value::as_str) == Some("message") {
    let payload = event.get("payload").and_then(Value::as_object);
    let content = payload.and_then(|item| item.get("content")).and_then(Value::as_array);
    let joined = content
      .map(|items| {
        items
          .iter()
          .filter_map(|item| {
            let text = item.get("text").and_then(Value::as_str).or_else(|| item.get("input_text").and_then(Value::as_str));
            text.map(str::trim).filter(|value| !value.is_empty())
          })
          .collect::<Vec<_>>()
          .join(" ")
      })
      .unwrap_or_default();
    return normalize_codex_session_preview(&joined, "");
  }
  if event_type == "event_msg" && event.get("payload").and_then(Value::as_object).and_then(|item| item.get("type")).and_then(Value::as_str) == Some("token_count") {
    return "token_count".to_string();
  }
  let payload_type = event
    .get("payload")
    .and_then(Value::as_object)
    .and_then(|item| item.get("type"))
    .and_then(Value::as_str)
    .unwrap_or("");
  if !payload_type.is_empty() {
    return payload_type.to_string();
  }
  String::new()
}

pub(crate) fn list_codex_sessions(query: &Value) -> Result<Value, String> {
  let query_object = parse_json_object(query);
  let target_cwd = get_string(&query_object, "cwd");
  let codex_home = {
    let input = get_string(&query_object, "codexHome");
    if input.is_empty() { default_codex_home()? } else { PathBuf::from(input) }
  };
  let max_items = get_string(&query_object, "limit").parse::<usize>().ok().unwrap_or(20).clamp(1, 100);
  let show_all = matches!(get_string(&query_object, "all").trim().to_lowercase().as_str(), "1" | "true" | "yes");
  let sessions_root = codex_home.join("sessions");

  let mut file_entries = list_jsonl_files(&sessions_root)
    .into_iter()
    .map(|path| CodexUsageSessionFile { modified_ms: file_modified_ms(&path), path })
    .collect::<Vec<_>>();
  file_entries.sort_by(|left, right| right.modified_ms.cmp(&left.modified_ms));

  let mut items = Vec::new();
  for entry in file_entries {
    if items.len() >= max_items {
      break;
    }
    let Some(summary) = read_codex_session_summary(&entry.path, entry.modified_ms) else { continue; };
    let session_cwd = summary.get("cwd").and_then(Value::as_str).unwrap_or("");
    if !show_all && !target_cwd.trim().is_empty() && !is_same_or_nested_path(session_cwd, &target_cwd) {
      continue;
    }
    items.push(summary);
  }

  Ok(json!({
    "ok": true,
    "source": sessions_root.to_string_lossy().to_string(),
    "cwd": target_cwd,
    "all": show_all,
    "items": items,
  }))
}

pub(crate) fn get_codex_session_detail(query: &Value) -> Result<Value, String> {
  let query_object = parse_json_object(query);
  let codex_home = {
    let input = get_string(&query_object, "codexHome");
    if input.is_empty() { default_codex_home()? } else { PathBuf::from(input) }
  };
  let file_path = resolve_codex_session_path(&get_string(&query_object, "filePath"), &codex_home)?;
  let preview_limit = get_string(&query_object, "limit").parse::<usize>().ok().unwrap_or(120).clamp(20, 500);
  let modified_ms = file_modified_ms(&file_path);
  let summary = read_codex_session_summary(&file_path, modified_ms).unwrap_or_else(|| {
    json!({
      "sessionId": file_path.file_stem().and_then(|name| name.to_str()).unwrap_or("unknown"),
      "title": file_path.file_stem().and_then(|name| name.to_str()).unwrap_or("unknown"),
      "cwd": "",
      "provider": "unknown",
      "model": "unknown",
      "updatedAt": chrono::Utc::now().to_rfc3339(),
      "updatedAtMs": modified_ms,
      "filePath": file_path.to_string_lossy().to_string(),
    })
  });

  let file = File::open(&file_path).map_err(|error| error.to_string())?;
  let reader = BufReader::new(file);
  let mut total_lines = 0usize;
  let mut parsed_events = 0usize;
  let mut invalid_lines = 0usize;
  let mut first_timestamp = String::new();
  let mut last_timestamp = String::new();
  let mut recent_events: VecDeque<Value> = VecDeque::new();

  for line in reader.lines().map_while(Result::ok) {
    total_lines += 1;
    let trimmed = line.trim();
    if trimmed.is_empty() {
      continue;
    }
    let Ok(event) = serde_json::from_str::<Value>(trimmed) else {
      invalid_lines += 1;
      continue;
    };
    parsed_events += 1;
    let timestamp = event.get("timestamp").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if first_timestamp.is_empty() && !timestamp.is_empty() {
      first_timestamp = timestamp.clone();
    }
    if !timestamp.is_empty() {
      last_timestamp = timestamp.clone();
    }
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("unknown").to_string();
    let role = event
      .get("payload")
      .and_then(Value::as_object)
      .and_then(|item| item.get("role"))
      .and_then(Value::as_str)
      .unwrap_or("")
      .to_string();
    recent_events.push_back(json!({
      "line": total_lines,
      "type": event_type,
      "role": role,
      "timestamp": timestamp,
      "preview": extract_codex_event_preview(&event),
    }));
    while recent_events.len() > preview_limit {
      recent_events.pop_front();
    }
  }

  Ok(json!({
    "ok": true,
    "summary": summary,
    "stats": { "totalLines": total_lines, "parsedEvents": parsed_events, "invalidLines": invalid_lines, "firstTimestamp": first_timestamp, "lastTimestamp": last_timestamp },
    "recentEvents": recent_events.into_iter().collect::<Vec<_>>(),
    "previewLimit": preview_limit,
  }))
}

fn launch_codex_session_action(body: &Value, action: &str) -> Result<Value, String> {
  let object = parse_json_object(body);
  let cwd = {
    let input = get_string(&object, "cwd");
    if input.is_empty() { home_dir()? } else { PathBuf::from(input) }
  };
  let codex_home = requested_codex_home_from_object(&object)?;
  ensure_dir(&codex_home)?;
  let session_id = normalize_codex_session_id(&get_string(&object, "sessionId"));
  let last = object.get("last").and_then(Value::as_bool).unwrap_or(false);
  let terminal_profile = get_string(&object, "terminalProfile");
  let codex_binary = find_codex_binary();
  if !codex_binary.get("installed").and_then(Value::as_bool).unwrap_or(false) {
    return Err("Codex 尚未安装，请先点击安装".to_string());
  }
  let subcommand = if action == "fork" { "fork" } else { "resume" };
  let mut args = vec![subcommand.to_string()];
  if last {
    args.push("--last".to_string());
  } else if !session_id.is_empty() {
    args.push(session_id.clone());
  } else {
    return Err("缺少会话 ID".to_string());
  }

  let binary_path = codex_binary
    .get("path")
    .and_then(Value::as_str)
    .filter(|text| !text.trim().is_empty())
    .unwrap_or("codex");
  let command = with_codex_home_command(&build_codex_session_command(binary_path, &args), &codex_home);
  let tool_label = if action == "fork" { "Codex 分叉恢复" } else { "Codex 会话恢复" };
  let message = if cfg!(target_os = "macos") {
    launch_macos_terminal_with_profile(&cwd, &command, tool_label, &terminal_profile)?
  } else {
    launch_terminal_command(&cwd, &command, tool_label)?
  };
  Ok(json!({
    "ok": true,
    "cwd": cwd.to_string_lossy().to_string(),
    "codexHome": codex_home.to_string_lossy().to_string(),
    "sessionId": session_id,
    "message": message
  }))
}

pub(crate) fn resume_codex_session(body: &Value) -> Result<Value, String> {
  launch_codex_session_action(body, "resume")
}

pub(crate) fn fork_codex_session(body: &Value) -> Result<Value, String> {
  launch_codex_session_action(body, "fork")
}

pub(crate) fn export_codex_session(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let codex_home = {
    let input = get_string(&object, "codexHome");
    if input.is_empty() { default_codex_home()? } else { PathBuf::from(input) }
  };
  let file_path = resolve_codex_session_path(&get_string(&object, "filePath"), &codex_home)?;
  let format = {
    let input = get_string(&object, "format").trim().to_lowercase();
    if input == "json" { "json" } else { "jsonl" }
  };
  let modified_ms = file_modified_ms(&file_path);
  let summary = read_codex_session_summary(&file_path, modified_ms).unwrap_or_else(|| {
    json!({
      "sessionId": file_path.file_stem().and_then(|name| name.to_str()).unwrap_or("unknown"),
      "title": file_path.file_stem().and_then(|name| name.to_str()).unwrap_or("unknown"),
      "cwd": "",
      "provider": "unknown",
      "model": "unknown",
      "updatedAt": chrono::Utc::now().to_rfc3339(),
      "updatedAtMs": modified_ms,
      "filePath": file_path.to_string_lossy().to_string(),
    })
  });
  let raw_content = fs::read_to_string(&file_path).map_err(|error| error.to_string())?;
  let session_id = summary.get("sessionId").and_then(Value::as_str).unwrap_or("codex-session");
  let normalized_id = session_id
    .chars()
    .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '-' })
    .collect::<String>();

  if format == "json" {
    let events = raw_content
      .lines()
      .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
      .collect::<Vec<_>>();
    let content = serde_json::to_string_pretty(&json!({
      "session": summary,
      "events": events,
    })).map_err(|error| error.to_string())?;
    return Ok(json!({
      "ok": true,
      "format": "json",
      "mime": "application/json",
      "fileName": format!("{}-export.json", normalized_id),
      "content": content,
    }));
  }

  Ok(json!({
    "ok": true,
    "format": "jsonl",
    "mime": "application/x-ndjson",
    "fileName": format!("{}-export.jsonl", normalized_id),
    "content": raw_content,
  }))
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexUsageTotals {
  input: u64,
  cached_input: u64,
  output: u64,
  reasoning: u64,
  total: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexUsageProviderStat {
  provider: String,
  totals: CodexUsageTotals,
  events: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexUsageModelStat {
  model: String,
  totals: CodexUsageTotals,
  events: u64,
}

#[derive(Clone)]
struct CodexUsageSessionStat {
  session_id: String,
  provider: String,
  model: String,
  cwd: String,
  totals: CodexUsageTotals,
  updated_at_ms: i64,
  updated_at: String,
}

struct CodexUsageSessionFile {
  path: PathBuf,
  modified_ms: u64,
}

const CODEX_USAGE_CACHE_TTL_SECS: i64 = 60;

fn codex_usage_num(value: Option<&Value>) -> u64 {
  value
    .and_then(|item| item.as_u64().or_else(|| item.as_i64().and_then(|num| if num >= 0 { Some(num as u64) } else { None })))
    .unwrap_or(0)
}

fn add_codex_usage_totals(target: &mut CodexUsageTotals, usage: &Value) {
  target.input += codex_usage_num(usage.get("input_tokens"));
  target.cached_input += codex_usage_num(usage.get("cached_input_tokens"));
  target.output += codex_usage_num(usage.get("output_tokens"));
  target.reasoning += codex_usage_num(usage.get("reasoning_output_tokens"));
  target.total += codex_usage_num(usage.get("total_tokens"));
}

fn list_jsonl_files(root: &Path) -> Vec<PathBuf> {
  let mut result = Vec::new();
  let mut stack = vec![root.to_path_buf()];
  while let Some(dir) = stack.pop() {
    let Ok(entries) = fs::read_dir(&dir) else { continue; };
    for entry in entries.flatten() {
      let path = entry.path();
      if path.is_dir() {
        stack.push(path);
      } else if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
        result.push(path);
      }
    }
  }
  result
}

fn list_all_files(root: &Path) -> Vec<PathBuf> {
  let mut result = Vec::new();
  let mut stack = vec![root.to_path_buf()];
  while let Some(dir) = stack.pop() {
    let Ok(entries) = fs::read_dir(&dir) else { continue; };
    for entry in entries.flatten() {
      let path = entry.path();
      if path.is_dir() {
        stack.push(path);
      } else if path.is_file() {
        result.push(path);
      }
    }
  }
  result
}

fn collect_storage_usage(path: &Path) -> (bool, bool, u64, u64) {
  if !path.exists() {
    return (false, false, 0, 0);
  }
  if path.is_file() {
    let bytes = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    return (true, true, bytes, 1);
  }
  let files = list_all_files(path);
  let bytes = files
    .iter()
    .fold(0u64, |sum, file| sum.saturating_add(fs::metadata(file).map(|meta| meta.len()).unwrap_or(0)));
  (true, false, bytes, files.len() as u64)
}

fn system_storage_entry(key: &str, label: &str, path: &Path) -> Value {
  let (exists, is_file, bytes, file_count) = collect_storage_usage(path);
  json!({
    "key": key,
    "label": label,
    "path": path.to_string_lossy().to_string(),
    "exists": exists,
    "isFile": is_file,
    "bytes": bytes,
    "fileCount": file_count,
  })
}

pub(crate) fn get_system_storage_state() -> Result<Value, String> {
  let app = app_home()?;
  let cache_dir = app.join("cache");
  let backups_dir = backups_root()?;
  let codex_home = default_codex_home()?;
  let claude_home = claude_code_home()?;
  let openclaw_home = openclaw_home()?;

  let entries = vec![
    system_storage_entry("app_cache", "应用缓存", &cache_dir),
    system_storage_entry("backups", "配置备份", &backups_dir),
    system_storage_entry("codex_home", "Codex 数据", &codex_home),
    system_storage_entry("claude_home", "Claude Code 数据", &claude_home),
    system_storage_entry("openclaw_home", "OpenClaw 数据", &openclaw_home),
  ];

  let total_bytes = entries
    .iter()
    .fold(0u64, |sum, item| sum.saturating_add(item.get("bytes").and_then(Value::as_u64).unwrap_or(0)));
  let total_files = entries
    .iter()
    .fold(0u64, |sum, item| sum.saturating_add(item.get("fileCount").and_then(Value::as_u64).unwrap_or(0)));

  Ok(json!({
    "generatedAt": chrono::Utc::now().to_rfc3339(),
    "appHome": app.to_string_lossy().to_string(),
    "entries": entries,
    "totalBytes": total_bytes,
    "totalFiles": total_files,
  }))
}

pub(crate) fn cleanup_system_storage(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let clear_cache = object.get("clearCache").and_then(Value::as_bool).unwrap_or(true);
  let clear_backups = object.get("clearBackups").and_then(Value::as_bool).unwrap_or(false);

  let mut removed_paths: Vec<String> = Vec::new();
  let mut failed_paths: Vec<String> = Vec::new();

  if clear_cache {
    let cache_dir = app_home()?.join("cache");
    if cache_dir.exists() {
      match fs::remove_dir_all(&cache_dir) {
        Ok(_) => removed_paths.push(cache_dir.to_string_lossy().to_string()),
        Err(error) => failed_paths.push(format!("{}: {}", cache_dir.to_string_lossy(), error)),
      }
    }
  }

  if clear_backups {
    let backups_dir = backups_root()?;
    if backups_dir.exists() {
      match fs::remove_dir_all(&backups_dir) {
        Ok(_) => removed_paths.push(backups_dir.to_string_lossy().to_string()),
        Err(error) => failed_paths.push(format!("{}: {}", backups_dir.to_string_lossy(), error)),
      }
    }
  }

  let state = get_system_storage_state()?;
  Ok(json!({
    "ok": failed_paths.is_empty(),
    "removedPaths": removed_paths,
    "failedPaths": failed_paths,
    "state": state,
  }))
}

fn file_modified_ms(path: &Path) -> u64 {
  fs::metadata(path)
    .ok()
    .and_then(|meta| meta.modified().ok())
    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
    .unwrap_or(0)
}

fn codex_usage_cache_path(_codex_home: &Path, _day_count: i64) -> Result<PathBuf, String> {
  let cache_dir = app_home()?.join("cache");
  ensure_dir(&cache_dir)?;
  Ok(cache_dir.join("metrics.db"))
}

fn codex_usage_cache_key(sessions_root: &Path, day_count: i64) -> String {
  format!("{}::{}", sessions_root.to_string_lossy(), day_count)
}

fn open_codex_usage_cache_db(db_path: &Path) -> Result<Connection, String> {
  let connection = Connection::open(db_path).map_err(|error| error.to_string())?;
  connection.execute(
    "CREATE TABLE IF NOT EXISTS codex_usage_cache (
      cache_key TEXT PRIMARY KEY,
      sessions_root TEXT NOT NULL,
      day_count INTEGER NOT NULL,
      file_count INTEGER NOT NULL,
      latest_mtime_ms INTEGER NOT NULL,
      generated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )",
    [],
  ).map_err(|error| error.to_string())?;
  connection.execute(
    "CREATE TABLE IF NOT EXISTS claude_usage_cache (
      cache_key TEXT PRIMARY KEY,
      telemetry_root TEXT NOT NULL,
      day_count INTEGER NOT NULL,
      file_count INTEGER NOT NULL,
      latest_mtime_ms INTEGER NOT NULL,
      generated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )",
    [],
  ).map_err(|error| error.to_string())?;
  Ok(connection)
}

fn claude_usage_cache_key(telemetry_root: &Path, day_count: i64) -> String {
  format!("{}::{}", telemetry_root.to_string_lossy(), day_count)
}

fn read_claude_usage_cache(cache_path: &Path, telemetry_root: &Path, day_count: i64, file_count: u64, latest_mtime_ms: u64, cache_only: bool) -> Option<Value> {
  let connection = open_codex_usage_cache_db(cache_path).ok()?;
  let cache_key = claude_usage_cache_key(telemetry_root, day_count);
  let row = connection.query_row(
    "SELECT telemetry_root, day_count, file_count, latest_mtime_ms, generated_at, payload_json FROM claude_usage_cache WHERE cache_key = ?1",
    [cache_key],
    |row| {
      Ok((
        row.get::<_, String>(0)?,
        row.get::<_, i64>(1)?,
        row.get::<_, u64>(2)?,
        row.get::<_, u64>(3)?,
        row.get::<_, String>(4)?,
        row.get::<_, String>(5)?,
      ))
    },
  ).optional().ok()??;
  if row.0 != telemetry_root.to_string_lossy() || row.1 != day_count {
    return None;
  }
  if cache_only {
    return serde_json::from_str::<Value>(&row.5).ok();
  }
  if let Ok(generated_at) = chrono::DateTime::parse_from_rfc3339(&row.4) {
    let age_secs = chrono::Utc::now().signed_duration_since(generated_at.with_timezone(&chrono::Utc)).num_seconds();
    if age_secs >= 0 && age_secs <= CODEX_USAGE_CACHE_TTL_SECS {
      return serde_json::from_str::<Value>(&row.5).ok();
    }
  }
  if row.2 != file_count || row.3 != latest_mtime_ms {
    return None;
  }
  serde_json::from_str::<Value>(&row.5).ok()
}

fn write_claude_usage_cache(cache_path: &Path, telemetry_root: &Path, day_count: i64, file_count: u64, latest_mtime_ms: u64, payload: &Value) {
  let Ok(connection) = open_codex_usage_cache_db(cache_path) else { return; };
  let payload_json = serde_json::to_string(payload).unwrap_or_default();
  let generated_at = payload.get("generatedAt").and_then(Value::as_str).unwrap_or_default();
  let _ = connection.execute(
    "INSERT INTO claude_usage_cache (cache_key, telemetry_root, day_count, file_count, latest_mtime_ms, generated_at, payload_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(cache_key) DO UPDATE SET
       telemetry_root = excluded.telemetry_root,
       day_count = excluded.day_count,
       file_count = excluded.file_count,
       latest_mtime_ms = excluded.latest_mtime_ms,
       generated_at = excluded.generated_at,
       payload_json = excluded.payload_json",
    params![
      claude_usage_cache_key(telemetry_root, day_count),
      telemetry_root.to_string_lossy().to_string(),
      day_count,
      file_count,
      latest_mtime_ms,
      generated_at,
      payload_json,
    ],
  );
}

fn list_recent_session_files(root: &Path, window_start_day: chrono::NaiveDate) -> Vec<CodexUsageSessionFile> {
  list_jsonl_files(root)
    .into_iter()
    .filter_map(|path| {
      if let Some(file_day) = session_file_day(&path, root) {
        if file_day < window_start_day {
          return None;
        }
      }
      Some(CodexUsageSessionFile {
        modified_ms: file_modified_ms(&path),
        path,
      })
    })
    .collect()
}

fn read_codex_usage_cache(cache_path: &Path, sessions_root: &Path, day_count: i64, file_count: u64, latest_mtime_ms: u64, cache_only: bool) -> Option<Value> {
  let connection = open_codex_usage_cache_db(cache_path).ok()?;
  let cache_key = codex_usage_cache_key(sessions_root, day_count);
  let row = connection.query_row(
    "SELECT sessions_root, day_count, file_count, latest_mtime_ms, generated_at, payload_json FROM codex_usage_cache WHERE cache_key = ?1",
    [cache_key],
    |row| {
      Ok((
        row.get::<_, String>(0)?,
        row.get::<_, i64>(1)?,
        row.get::<_, u64>(2)?,
        row.get::<_, u64>(3)?,
        row.get::<_, String>(4)?,
        row.get::<_, String>(5)?,
      ))
    },
  ).optional().ok()??;
  if row.0 != sessions_root.to_string_lossy() {
    return None;
  }
  if row.1 != day_count {
    return None;
  }
  if cache_only {
    return serde_json::from_str::<Value>(&row.5).ok();
  }
  if let Ok(generated_at) = chrono::DateTime::parse_from_rfc3339(&row.4) {
    let age_secs = chrono::Utc::now().signed_duration_since(generated_at.with_timezone(&chrono::Utc)).num_seconds();
    if age_secs >= 0 && age_secs <= CODEX_USAGE_CACHE_TTL_SECS {
      return serde_json::from_str::<Value>(&row.5).ok();
    }
  }
  if row.2 != file_count {
    return None;
  }
  if row.3 != latest_mtime_ms {
    return None;
  }
  serde_json::from_str::<Value>(&row.5).ok()
}

fn write_codex_usage_cache(cache_path: &Path, sessions_root: &Path, day_count: i64, file_count: u64, latest_mtime_ms: u64, payload: &Value) {
  let Ok(connection) = open_codex_usage_cache_db(cache_path) else { return; };
  let payload_json = serde_json::to_string(payload).unwrap_or_default();
  let generated_at = payload.get("generatedAt").and_then(Value::as_str).unwrap_or_default();
  let _ = connection.execute(
    "INSERT INTO codex_usage_cache (cache_key, sessions_root, day_count, file_count, latest_mtime_ms, generated_at, payload_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(cache_key) DO UPDATE SET
       sessions_root = excluded.sessions_root,
       day_count = excluded.day_count,
       file_count = excluded.file_count,
       latest_mtime_ms = excluded.latest_mtime_ms,
       generated_at = excluded.generated_at,
       payload_json = excluded.payload_json",
    params![
      codex_usage_cache_key(sessions_root, day_count),
      sessions_root.to_string_lossy().to_string(),
      day_count,
      file_count,
      latest_mtime_ms,
      generated_at,
      payload_json,
    ],
  );
}

fn session_file_day(file_path: &Path, sessions_root: &Path) -> Option<chrono::NaiveDate> {
  let relative = file_path.strip_prefix(sessions_root).ok()?;
  let mut parts = relative.components();
  let year = parts.next()?.as_os_str().to_str()?.parse::<i32>().ok()?;
  let month = parts.next()?.as_os_str().to_str()?.parse::<u32>().ok()?;
  let day = parts.next()?.as_os_str().to_str()?.parse::<u32>().ok()?;
  chrono::NaiveDate::from_ymd_opt(year, month, day)
}

pub(crate) fn get_codex_usage_metrics(query: &Value) -> Result<Value, String> {
  let query_object = parse_json_object(query);
  let codex_home = {
    let input = get_string(&query_object, "codexHome");
    if input.is_empty() { default_codex_home()? } else { PathBuf::from(input) }
  };
  let day_count = get_string(&query_object, "days")
    .parse::<i64>()
    .ok()
    .map(|days| days.clamp(1, 90))
    .unwrap_or(30);
  let force_refresh = matches!(get_string(&query_object, "force").as_str(), "1" | "true" | "yes");
  let window_start = chrono::Utc::now() - chrono::Duration::days(day_count);
  let window_start_day = window_start.date_naive();
  let sessions_root = codex_home.join("sessions");
  let cache_path = codex_usage_cache_path(&codex_home, day_count)?;
  let session_files = list_recent_session_files(&sessions_root, window_start_day);
  let file_count = session_files.len() as u64;
  let latest_mtime_ms = session_files.iter().map(|item| item.modified_ms).max().unwrap_or(0);

  if !force_refresh {
    if let Some(payload) = read_codex_usage_cache(&cache_path, &sessions_root, day_count, file_count, latest_mtime_ms, true) {
      return Ok(payload);
    }
    return Ok(json!({
      "ok": true,
      "cacheMiss": true,
      "days": day_count,
      "generatedAt": chrono::Utc::now().to_rfc3339(),
      "source": cache_path.to_string_lossy().to_string(),
      "sourceType": "dashboard-cache-sqlite",
      "totals": { "input": 0, "cachedInput": 0, "output": 0, "reasoning": 0, "total": 0 },
      "daily": Vec::<Value>::new(),
      "providers": Vec::<Value>::new(),
      "models": Vec::<Value>::new(),
      "sessions": Vec::<Value>::new(),
    }));
  }

  let mut totals = CodexUsageTotals::default();
  let mut by_day: BTreeMap<String, CodexUsageTotals> = BTreeMap::new();
  let mut by_provider: BTreeMap<String, CodexUsageProviderStat> = BTreeMap::new();
  let mut by_model: BTreeMap<String, CodexUsageModelStat> = BTreeMap::new();
  let mut by_session: BTreeMap<String, CodexUsageSessionStat> = BTreeMap::new();

  for file_entry in session_files {
    let file_path = file_entry.path;
    let Ok(file) = File::open(&file_path) else { continue; };
    let reader = BufReader::new(file);
    let mut session_id = String::new();
    let mut provider = String::new();
    let mut cwd = String::new();
    let mut current_model = String::new();

    for line in reader.lines().map_while(Result::ok) {
      let trimmed = line.trim();
      if trimmed.is_empty() {
        continue;
      }
      let Ok(event) = serde_json::from_str::<Value>(trimmed) else { continue; };
      if event.get("type").and_then(Value::as_str) == Some("session_meta") {
        if let Some(payload) = event.get("payload").and_then(Value::as_object) {
          if session_id.is_empty() {
            session_id = payload.get("id").and_then(Value::as_str).unwrap_or("").trim().to_string();
          }
          if provider.is_empty() {
            provider = payload.get("model_provider").and_then(Value::as_str).unwrap_or("").trim().to_string();
          }
          if cwd.is_empty() {
            cwd = payload.get("cwd").and_then(Value::as_str).unwrap_or("").trim().to_string();
          }
          let session_model = payload.get("model").and_then(Value::as_str).unwrap_or("").trim().to_string();
          if !session_model.is_empty() { current_model = session_model; }
        }
        continue;
      }

      // Extract model from turn_context (most reliable source)
      if event.get("type").and_then(Value::as_str) == Some("turn_context") {
        if let Some(payload) = event.get("payload").and_then(Value::as_object) {
          let turn_model = payload.get("model").and_then(Value::as_str).unwrap_or("").trim().to_string();
          if !turn_model.is_empty() { current_model = turn_model; }
        }
        continue;
      }

      let payload = event.get("payload").and_then(Value::as_object);
      if event.get("type").and_then(Value::as_str) != Some("event_msg")
        || payload.and_then(|item| item.get("type")).and_then(Value::as_str) != Some("token_count") {
        continue;
      }

      let ts_raw = event.get("timestamp").and_then(Value::as_str).unwrap_or("");
      let Ok(ts) = chrono::DateTime::parse_from_rfc3339(ts_raw) else { continue; };
      let ts_utc = ts.with_timezone(&chrono::Utc);
      if ts_utc < window_start {
        continue;
      }

      let usage = payload
        .and_then(|item| item.get("info"))
        .and_then(Value::as_object)
        .and_then(|info| info.get("last_token_usage").or_else(|| info.get("total_token_usage")));
      let Some(usage) = usage else { continue; };

      add_codex_usage_totals(&mut totals, usage);

      let day_key = ts_utc.format("%Y-%m-%d").to_string();
      add_codex_usage_totals(by_day.entry(day_key).or_default(), usage);

      let provider_key = if provider.trim().is_empty() { "unknown".to_string() } else { provider.clone() };
      let provider_stat = by_provider.entry(provider_key.clone()).or_insert_with(|| CodexUsageProviderStat {
        provider: provider_key.clone(),
        totals: CodexUsageTotals::default(),
        events: 0,
      });
      add_codex_usage_totals(&mut provider_stat.totals, usage);
      provider_stat.events += 1;

      let model_key = if current_model.trim().is_empty() { "unknown".to_string() } else { current_model.clone() };
      let model_stat = by_model.entry(model_key.clone()).or_insert_with(|| CodexUsageModelStat {
        model: model_key.clone(),
        totals: CodexUsageTotals::default(),
        events: 0,
      });
      add_codex_usage_totals(&mut model_stat.totals, usage);
      model_stat.events += 1;

      let session_key = if session_id.trim().is_empty() {
        file_path.file_stem().and_then(|name| name.to_str()).unwrap_or("unknown").to_string()
      } else {
        session_id.clone()
      };
      let updated_at = ts_utc.to_rfc3339();
      let session_stat = by_session.entry(session_key.clone()).or_insert_with(|| CodexUsageSessionStat {
        session_id: session_key.clone(),
        provider: provider_key.clone(),
        model: model_key.clone(),
        cwd: cwd.clone(),
        totals: CodexUsageTotals::default(),
        updated_at_ms: ts_utc.timestamp_millis(),
        updated_at: updated_at.clone(),
      });
      if session_stat.model == "unknown" && !current_model.trim().is_empty() {
        session_stat.model = current_model.clone();
      }
      add_codex_usage_totals(&mut session_stat.totals, usage);
      if ts_utc.timestamp_millis() > session_stat.updated_at_ms {
        session_stat.updated_at_ms = ts_utc.timestamp_millis();
        session_stat.updated_at = updated_at;
      }
      if session_stat.cwd.is_empty() && !cwd.is_empty() {
        session_stat.cwd = cwd.clone();
      }
      if session_stat.provider.is_empty() {
        session_stat.provider = provider_key;
      }
    }
  }

  let daily = by_day
    .into_iter()
    .map(|(date, totals)| json!({
      "date": date,
      "input": totals.input,
      "cachedInput": totals.cached_input,
      "output": totals.output,
      "reasoning": totals.reasoning,
      "total": totals.total,
    }))
    .collect::<Vec<_>>();

  let mut providers = by_provider.into_values().collect::<Vec<_>>();
  providers.sort_by(|left, right| right.totals.total.cmp(&left.totals.total));

  let mut models = by_model.into_values().collect::<Vec<_>>();
  models.sort_by(|left, right| right.totals.total.cmp(&left.totals.total));

  let mut sessions = by_session.into_values().collect::<Vec<_>>();
  sessions.sort_by(|left, right| right.updated_at_ms.cmp(&left.updated_at_ms));
  sessions.truncate(12);

  let payload = json!({
    "ok": true,
    "days": day_count,
    "generatedAt": chrono::Utc::now().to_rfc3339(),
    "source": sessions_root.to_string_lossy().to_string(),
    "sourceType": "sessions",
    "totals": {
      "input": totals.input,
      "cachedInput": totals.cached_input,
      "output": totals.output,
      "reasoning": totals.reasoning,
      "total": totals.total,
    },
    "daily": daily,
    "providers": providers,
    "models": models,
    "sessions": sessions.into_iter().map(|item| json!({
      "sessionId": item.session_id,
      "provider": item.provider,
      "model": item.model,
      "cwd": item.cwd,
      "updatedAt": item.updated_at,
      "input": item.totals.input,
      "cachedInput": item.totals.cached_input,
      "output": item.totals.output,
      "reasoning": item.totals.reasoning,
      "total": item.totals.total,
    })).collect::<Vec<_>>(),
  });
  write_codex_usage_cache(&cache_path, &sessions_root, day_count, file_count, latest_mtime_ms, &payload);
  Ok(payload)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::time::Instant;

  #[test]
  fn probe_codex_usage_metrics_runtime() {
    let started = Instant::now();
    let result = get_codex_usage_metrics(&json!({ "days": "30" })).expect("metrics");
    let first_elapsed = started.elapsed().as_millis();
    let cached_started = Instant::now();
    let cached_result = get_codex_usage_metrics(&json!({ "days": "30" })).expect("cached metrics");
    let second_elapsed = cached_started.elapsed().as_millis();
    eprintln!(
      "probe_codex_usage_metrics_runtime first_elapsed_ms={} second_elapsed_ms={} total={} daily={} sessions={}",
      first_elapsed,
      second_elapsed,
      result.get("totals").and_then(|v| v.get("total")).and_then(Value::as_u64).unwrap_or(0),
      result.get("daily").and_then(Value::as_array).map(|v| v.len()).unwrap_or(0),
      result.get("sessions").and_then(Value::as_array).map(|v| v.len()).unwrap_or(0),
    );
    assert!(cached_result.get("generatedAt").and_then(Value::as_str).is_some());
    assert!(second_elapsed < first_elapsed);
  }

  #[test]
  fn probe_claude_telemetry_usage_runtime() {
    let usage = read_claude_telemetry_usage(30, true, false);
    eprintln!(
      "probe_claude_telemetry_usage_runtime total={} input={} output={} cacheRead={} models={} dailyModelTokens={}",
      usage.get("totals").and_then(|v| v.get("total")).and_then(Value::as_u64).unwrap_or(0),
      usage.get("totals").and_then(|v| v.get("input")).and_then(Value::as_u64).unwrap_or(0),
      usage.get("totals").and_then(|v| v.get("output")).and_then(Value::as_u64).unwrap_or(0),
      usage.get("totals").and_then(|v| v.get("cacheRead")).and_then(Value::as_u64).unwrap_or(0),
      usage.get("models").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0),
      usage.get("dailyModelTokens").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0),
    );
    // Print model details
    if let Some(models) = usage.get("models").and_then(Value::as_array) {
      for m in models {
        let name = m.get("model").and_then(Value::as_str).unwrap_or("?");
        let total = m.get("totals").and_then(|t| t.get("total")).and_then(Value::as_u64).unwrap_or(0);
        let input = m.get("totals").and_then(|t| t.get("input")).and_then(Value::as_u64).unwrap_or(0);
        let output = m.get("totals").and_then(|t| t.get("output")).and_then(Value::as_u64).unwrap_or(0);
        let source = m.get("source").and_then(Value::as_str).unwrap_or("?");
        eprintln!("  model={} total={} input={} output={} source={}", name, total, input, output, source);
      }
    }
    assert!(usage.get("totals").and_then(|v| v.get("total")).and_then(Value::as_u64).unwrap_or(0) > 0);
    assert!(usage.get("models").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0) > 0, "models should not be empty");
  }
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
  let codex_binary = find_codex_binary_with_options(cfg!(target_os = "windows"));
  let codex_installed = codex_binary.get("installed").and_then(Value::as_bool).unwrap_or(false);

  // 4. Check config files
  let global_config_path = codex_home.join("config.toml");
  let global_env_path = codex_home.join(".env");
  let auth_content = read_text(&codex_home.join("auth.json"))?;
  let auth_json = serde_json::from_str::<Value>(&auth_content).unwrap_or_else(|_| json!({}));
  let login = {
    let api_key = auth_json.get("OPENAI_API_KEY").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let tokens = auth_json.get("tokens").and_then(Value::as_object);
    let access_token = tokens.and_then(|item| item.get("access_token")).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let account_id = tokens.and_then(|item| item.get("account_id")).and_then(Value::as_str).unwrap_or("").trim().to_string();
    if !access_token.is_empty() {
      json!({ "loggedIn": true, "method": "chatgpt", "email": "", "plan": "", "accountId": account_id })
    } else if !api_key.is_empty() {
      json!({ "loggedIn": true, "method": "api_key", "email": "", "plan": "", "accountId": "" })
    } else {
      json!({ "loggedIn": false, "method": "", "email": "", "plan": "", "accountId": "" })
    }
  };
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

  let has_login = login.get("loggedIn").and_then(Value::as_bool).unwrap_or(false);
  let needs_setup = !codex_installed || (!config_exists && !has_login) || (!has_providers && !has_login);

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
      "hasLogin": has_login,
      "configPath": global_config_path.to_string_lossy().to_string(),
      "envPath": global_env_path.to_string_lossy().to_string(),
    },
    "login": login,
    "needsSetup": needs_setup,
    "codexHome": codex_home.to_string_lossy().to_string(),
  }))
}
use crate::{
  app_home, compare_versions, default_codex_home, extract_version, home_dir, npm_command,
  parse_json_object, parse_toml_config, read_text, OPENAI_CODEX_PACKAGE,
  claude_code_home, effective_claude_code_home, openclaw_home, opencode_config_home, opencode_data_home, write_text, ensure_dir, backups_root, CLAUDE_CODE_PACKAGE,
  OPENCODE_PACKAGE, OPENCLAW_PACKAGE,
};
use crate::oauth_profiles::{migrate_auth_json_env_to_codex_env, write_switch_backup};
use crate::provider::get_string;

/* ═══════════════  Multi-tool support  ═══════════════ */

fn find_tool_binary(binary_name: &str) -> Value {
  find_tool_binary_with_options(binary_name, false)
}

fn find_tool_binary_with_options(binary_name: &str, passive: bool) -> Value {
  apply_discovery_path_env(passive);
  let mut candidate_paths: Vec<PathBuf> = which::which_all(binary_name)
    .map(|items| items.collect::<Vec<_>>())
    .unwrap_or_default();

  if cfg!(target_os = "windows") {
    candidate_paths.extend(windows_common_tool_candidate_paths(binary_name));
  }

  if binary_name.eq_ignore_ascii_case("opencode") {
    if let Ok(home) = home_dir() {
      let unix_candidates = [
        std::env::var("OPENCODE_INSTALL_DIR").ok().filter(|value| !value.trim().is_empty()).map(|value| PathBuf::from(value).join("opencode")),
        std::env::var("XDG_BIN_DIR").ok().filter(|value| !value.trim().is_empty()).map(|value| PathBuf::from(value).join("opencode")),
        Some(home.join(".opencode").join("bin").join("opencode")),
        Some(home.join("bin").join("opencode")),
        Some(PathBuf::from("/opt/homebrew/bin/opencode")),
        Some(PathBuf::from("/usr/local/bin/opencode")),
        Some(PathBuf::from("/usr/bin/opencode")),
      ];
      candidate_paths.extend(unix_candidates.into_iter().flatten().filter(|candidate| candidate.exists()));

      if cfg!(target_os = "windows") {
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
          candidate_paths.extend(windows_binary_candidates_from_dir(
            &PathBuf::from(&user_profile).join("scoop").join("shims"),
            "opencode",
          ));
        }
        if let Ok(program_data) = std::env::var("ProgramData") {
          candidate_paths.extend(windows_binary_candidates_from_dir(
            &PathBuf::from(&program_data).join("chocolatey").join("bin"),
            "opencode",
          ));
        }
      }
    }
  }

  collect_detected_binary_candidates(candidate_paths, binary_name, passive)
}

pub(crate) fn list_tools() -> Result<Value, String> {
  let passive_windows = cfg!(target_os = "windows");
  let codex_binary = find_codex_binary_with_options(passive_windows);
  let claude_binary = find_tool_binary_with_options("claude", passive_windows);
  let opencode_binary = find_tool_binary_with_options("opencode", passive_windows);
  let openclaw_binary = find_tool_binary_with_options("openclaw", passive_windows);

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
      "id": "opencode",
      "name": "OpenCode",
      "description": "开放式 AI 编程助手 CLI",
      "supported": true,
      "configFormat": "json",
      "installMethod": "auto",
      "npmPackage": OPENCODE_PACKAGE,
      "installMethods": if cfg!(target_os = "windows") {
        json!(["auto", "domestic", "npm", "scoop", "choco"])
      } else {
        json!(["auto", "domestic", "script", "brew", "npm"])
      },
      "binary": opencode_binary,
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

fn open_target_with_system_shell(target: &str) -> Result<(), String> {
  if target.trim().is_empty() {
    return Err("目标不能为空".to_string());
  }

  let result = if cfg!(target_os = "macos") {
    create_command("open").arg(target).spawn()
  } else if cfg!(target_os = "windows") {
    create_command("cmd").args(["/c", "start", "", target]).spawn()
  } else {
    create_command("xdg-open").arg(target).spawn()
  };

  result.map(|_| ()).map_err(|error| error.to_string())
}

fn codex_app_installation_candidates() -> Vec<PathBuf> {
  let mut candidates = Vec::new();

  if cfg!(target_os = "macos") {
    candidates.push(PathBuf::from("/Applications/Codex.app"));
    if let Ok(home) = home_dir() {
      candidates.push(home.join("Applications").join("Codex.app"));
    }
  } else if cfg!(target_os = "windows") {
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
      candidates.push(PathBuf::from(local_app_data).join("Programs").join("Codex").join("Codex.exe"));
    }
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
      candidates.push(PathBuf::from(user_profile).join("AppData").join("Local").join("Programs").join("Codex").join("Codex.exe"));
    }
  }

  candidates
}

fn find_codex_app_installation() -> Option<PathBuf> {
  codex_app_installation_candidates()
    .into_iter()
    .find(|candidate| candidate.exists())
}

pub(crate) fn get_codex_app_state() -> Result<Value, String> {
  let supported = cfg!(target_os = "macos") || cfg!(target_os = "windows");
  let install_path = find_codex_app_installation();
  let installed = install_path.is_some();
  let platform = if cfg!(target_os = "macos") {
    "macos"
  } else if cfg!(target_os = "windows") {
    "windows"
  } else {
    "unsupported"
  };

  let download_url = if cfg!(target_os = "macos") {
    CODEX_APP_MAC_DOWNLOAD_URL
  } else if cfg!(target_os = "windows") {
    CODEX_APP_WIN_STORE_URL
  } else {
    CODEX_APP_DOCS_URL
  };

  Ok(json!({
    "toolId": "codex-app",
    "platform": platform,
    "supported": supported,
    "installed": installed,
    "installPath": install_path.map(|path| path.to_string_lossy().to_string()),
    "downloadUrl": download_url,
    "docsUrl": CODEX_APP_DOCS_URL,
    "storeUrl": CODEX_APP_WIN_STORE_URL,
  }))
}

pub(crate) fn install_codex_app(_body: &Value) -> Result<Value, String> {
  if cfg!(target_os = "macos") {
    open_target_with_system_shell(CODEX_APP_MAC_DOWNLOAD_URL)?;
    return Ok(json!({
      "ok": true,
      "method": "download",
      "url": CODEX_APP_MAC_DOWNLOAD_URL,
      "message": "已开始下载 Codex App 安装包（dmg）",
    }));
  }

  if cfg!(target_os = "windows") {
    if open_target_with_system_shell(CODEX_APP_WIN_STORE_URI).is_ok() {
      return Ok(json!({
        "ok": true,
        "method": "store",
        "url": CODEX_APP_WIN_STORE_URI,
        "message": "已打开 Microsoft Store，可直接安装 Codex App",
      }));
    }
    open_target_with_system_shell(CODEX_APP_WIN_STORE_URL)?;
    return Ok(json!({
      "ok": true,
      "method": "store-web",
      "url": CODEX_APP_WIN_STORE_URL,
      "message": "已打开 Microsoft Store 网页，请继续安装 Codex App",
    }));
  }

  Err("当前系统暂不支持 Codex App 一键安装".to_string())
}

pub(crate) fn open_codex_app(_body: &Value) -> Result<Value, String> {
  if let Some(path) = find_codex_app_installation() {
    let text = path.to_string_lossy().to_string();
    open_target_with_system_shell(&text)?;
    return Ok(json!({
      "ok": true,
      "opened": true,
      "path": text,
    }));
  }

  install_codex_app(&json!({}))
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


fn claude_json_path_for_home(home: &Path) -> PathBuf {
  let default_home = claude_code_home().ok();
  if default_home.as_ref().map(|path| path == home).unwrap_or(false) {
    if let Ok(dir) = crate::home_dir() {
      return dir.join(".claude.json");
    }
  }
  home.join(".claude.json")
}

fn empty_claude_usage_payload(days: i64, telemetry_root: &Path) -> Value {
  json!({
    "days": days.clamp(1, 90),
    "generatedAt": chrono::Utc::now().to_rfc3339(),
    "source": telemetry_root.to_string_lossy().to_string(),
    "totals": {"input":0,"output":0,"cacheCreation":0,"cacheRead":0,"total":0,"cost":0.0},
    "officialCost": 0.0,
    "officialModels": [],
    "daily": [],
    "sessions": [],
    "models": [],
    "dailyModelTokens": [],
  })
}

fn read_claude_telemetry_usage_for_home(home: &Path, days: i64, force_refresh: bool, cache_only: bool) -> Value {
  let telemetry_root = home.join("projects");
  let cache_path = match codex_usage_cache_path(&home, days) {
    Ok(path) => path,
    Err(_) => return empty_claude_usage_payload(days, &telemetry_root),
  };
  let telemetry_files = match fs::read_dir(&telemetry_root) {
    Ok(entries) => entries
      .filter_map(|entry| entry.ok())
      .filter_map(|entry| entry.file_type().ok().filter(|ft| ft.is_dir()).map(|_| entry.path()))
      .flat_map(|dir| {
        fs::read_dir(dir)
          .into_iter()
          .flat_map(|items| items.filter_map(|item| item.ok()))
          .map(|item| item.path())
          .collect::<Vec<_>>()
      })
      .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
      .collect::<Vec<_>>(),
    Err(_) => Vec::new(),
  };
  let file_count = telemetry_files.len() as u64;
  let latest_mtime_ms = telemetry_files.iter().map(|path| file_modified_ms(path)).max().unwrap_or(0);
  if !force_refresh {
    if let Some(payload) = read_claude_usage_cache(&cache_path, &telemetry_root, days.clamp(1, 90), file_count, latest_mtime_ms, cache_only) {
      return payload;
    }
  }
  if cache_only {
    return json!({"cacheMiss": true});
  }
  let cutoff = chrono::Utc::now() - chrono::Duration::days(days.clamp(1, 90));
  let mut sessions = Vec::new();
  let mut daily: BTreeMap<String, Value> = BTreeMap::new();
  let mut daily_model_tokens_map: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
  let mut total_input: u64 = 0;
  let mut total_output: u64 = 0;
  let mut total_cache_creation: u64 = 0;
  let mut total_cache_read: u64 = 0;
  let mut total_cost: f64 = 0.0;

  struct ModelBucket {
    input: u64,
    output: u64,
    cache_creation: u64,
    cache_read: u64,
    cost: f64,
    session_count: u64,
  }
  let calc_cost = |model: &str, input: u64, output: u64, cache_read: u64, cache_creation: u64| {
    let lower = model.to_lowercase();
    let (pin, pout, pread, pcreate) = if lower.contains("opus") { (15.0, 75.0, 1.5, 18.75) } else if lower.contains("sonnet") { (3.0, 15.0, 0.3, 3.75) } else if lower.contains("haiku") { (0.8, 4.0, 0.08, 1.0) } else { (15.0, 75.0, 1.5, 18.75) };
    (input as f64 * pin + output as f64 * pout + cache_read as f64 * pread + cache_creation as f64 * pcreate) / 1_000_000.0
  };
  let mut model_map: BTreeMap<String, ModelBucket> = BTreeMap::new();

  for file_path in telemetry_files {
    let Ok(file) = File::open(&file_path) else { continue; };
    let reader = BufReader::new(file);
    let session_id = file_path.file_stem().and_then(|value| value.to_str()).unwrap_or("").to_string();
    let mut usage_entries: BTreeMap<String, (chrono::DateTime<chrono::Utc>, String, u64, u64, u64, u64, u64)> = BTreeMap::new();
    let mut primary_model = String::new();

    for line in reader.lines().map_while(Result::ok) {
      let trimmed = line.trim();
      if trimmed.is_empty() { continue; }
      let Ok(record) = serde_json::from_str::<Value>(trimmed) else { continue; };
      let Some(msg) = record.get("message").and_then(Value::as_object) else { continue; };
      let Some(usage) = msg.get("usage").and_then(Value::as_object) else { continue; };
      let parsed_ts = record.get("timestamp")
        .and_then(Value::as_str)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&chrono::Utc));
      let Some(ts_utc) = parsed_ts else { continue; };
      if ts_utc < cutoff { continue; }

      let input = usage.get("input_tokens").and_then(Value::as_u64).unwrap_or(0);
      let output = usage.get("output_tokens").and_then(Value::as_u64).unwrap_or(0);
      let cache_read = usage.get("cache_read_input_tokens").and_then(Value::as_u64).unwrap_or(0);
      let cache_creation = usage.get("cache_creation_input_tokens").and_then(Value::as_u64).unwrap_or(0);
      let total = input + output + cache_read + cache_creation;
      let model = msg.get("model").and_then(Value::as_str).unwrap_or("").trim().to_string();
      if !model.is_empty() && !model.starts_with('<') {
        primary_model = model.clone();
      }

      let usage_key = msg.get("id").and_then(Value::as_str)
        .or_else(|| record.get("requestId").and_then(Value::as_str))
        .or_else(|| record.get("uuid").and_then(Value::as_str))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("{}:{}:{}:{}", session_id, ts_utc.timestamp_millis(), model, total));
      let replace = usage_entries.get(&usage_key).map(|entry| total >= entry.6).unwrap_or(true);
      if replace {
        usage_entries.insert(usage_key, (ts_utc, model, input, output, cache_read, cache_creation, total));
      }
    }

    if usage_entries.is_empty() { continue; }

    let mut session_input = 0_u64;
    let mut session_output = 0_u64;
    let mut session_cache_creation = 0_u64;
    let mut session_cache_read = 0_u64;
    let mut session_models: BTreeMap<String, (u64, u64, u64, u64)> = BTreeMap::new();
    let mut last_window_ts: Option<chrono::DateTime<chrono::Utc>> = None;

    for (_key, (ts_utc, model, input, output, cache_read, cache_creation, _total)) in usage_entries {
      last_window_ts = Some(last_window_ts.map(|prev| prev.max(ts_utc)).unwrap_or(ts_utc));
      session_input += input;
      session_output += output;
      session_cache_read += cache_read;
      session_cache_creation += cache_creation;

      if !model.is_empty() && !model.starts_with('<') {
        let entry = session_models.entry(model.clone()).or_insert((0, 0, 0, 0));
        entry.0 += input;
        entry.1 += output;
        entry.2 += cache_read;
        entry.3 += cache_creation;
      }

      let date = ts_utc.format("%Y-%m-%d").to_string();
      let bucket = daily.entry(date.clone()).or_insert_with(|| json!({"date": date, "input": 0, "output": 0, "cacheCreation": 0, "cacheRead": 0, "total": 0, "cost": 0.0}));
      bucket["input"] = json!(bucket.get("input").and_then(Value::as_u64).unwrap_or(0) + input);
      bucket["output"] = json!(bucket.get("output").and_then(Value::as_u64).unwrap_or(0) + output);
      bucket["cacheCreation"] = json!(bucket.get("cacheCreation").and_then(Value::as_u64).unwrap_or(0) + cache_creation);
      bucket["cacheRead"] = json!(bucket.get("cacheRead").and_then(Value::as_u64).unwrap_or(0) + cache_read);
      bucket["total"] = json!(bucket.get("total").and_then(Value::as_u64).unwrap_or(0) + input + output + cache_read + cache_creation);
      bucket["cost"] = json!(bucket.get("cost").and_then(Value::as_f64).unwrap_or(0.0) + calc_cost(&model, input, output, cache_read, cache_creation));
      if !model.is_empty() && !model.starts_with('<') {
        let day_models = daily_model_tokens_map.entry(date).or_default();
        *day_models.entry(model).or_insert(0) += input + output + cache_read + cache_creation;
      }
    }

    let Some(last_window_ts) = last_window_ts else { continue; };
    if session_input == 0 && session_output == 0 && session_cache_read == 0 && session_cache_creation == 0 { continue; }
    let mut session_cost = 0.0;
    for (model, (input, output, cache_read, cache_creation)) in &session_models {
      let cost = calc_cost(model, *input, *output, *cache_read, *cache_creation);
      session_cost += cost;
      let bucket = model_map.entry(model.clone()).or_insert_with(|| ModelBucket { input: 0, output: 0, cache_creation: 0, cache_read: 0, cost: 0.0, session_count: 0 });
      bucket.input += *input;
      bucket.output += *output;
      bucket.cache_read += *cache_read;
      bucket.cache_creation += *cache_creation;
      bucket.cost += cost;
      bucket.session_count += 1;
    }

    total_input += session_input;
    total_output += session_output;
    total_cache_creation += session_cache_creation;
    total_cache_read += session_cache_read;
    total_cost += session_cost;
    sessions.push(json!({"sessionId": session_id, "model": primary_model, "updatedAt": last_window_ts.to_rfc3339(), "input": session_input, "output": session_output, "cacheCreation": session_cache_creation, "cacheRead": session_cache_read, "total": session_input + session_output + session_cache_read + session_cache_creation, "cost": session_cost}));
  }

  sessions.sort_by(|left, right| {
    right.get("updatedAt").and_then(Value::as_str).unwrap_or("")
      .cmp(left.get("updatedAt").and_then(Value::as_str).unwrap_or(""))
  });
  sessions.truncate(12);

  // ── Build models array from JSONL usage ──
  let mut models_from_telemetry: Vec<Value> = model_map.into_iter().map(|(model, bucket)| {
    let total = bucket.input + bucket.output + bucket.cache_read + bucket.cache_creation;
    json!({
      "model": model,
      "totals": {
        "input": bucket.input,
        "output": bucket.output,
        "cacheCreation": bucket.cache_creation,
        "cacheRead": bucket.cache_read,
        "total": total,
        "cost": bucket.cost,
      },
      "sessionCount": bucket.session_count,
      "source": "projects-jsonl",
    })
  }).collect();
  models_from_telemetry.sort_by(|a, b| {
    let at = a.get("totals").and_then(|t| t.get("total")).and_then(Value::as_u64).unwrap_or(0);
    let bt = b.get("totals").and_then(|t| t.get("total")).and_then(Value::as_u64).unwrap_or(0);
    bt.cmp(&at)
  });

  let stats_cache_path = home.join("stats-cache.json");
  let mut stats_models: Vec<Value> = Vec::new();
  let mut daily_model_tokens: Vec<Value> = daily_model_tokens_map.into_iter().map(|(date, tokens_by_model)| json!({"date": date, "tokensByModel": tokens_by_model})).collect();
  if let Ok(stats_content) = read_text(&stats_cache_path) {
    if let Ok(stats) = serde_json::from_str::<Value>(stats_content.trim()) {
      // modelUsage: { "model-name": { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD } }
      if let Some(model_usage) = stats.get("modelUsage").and_then(Value::as_object) {
        for (model_name, usage) in model_usage {
          let input = usage.get("inputTokens").and_then(Value::as_u64).unwrap_or(0);
          let output = usage.get("outputTokens").and_then(Value::as_u64).unwrap_or(0);
          let cache_read = usage.get("cacheReadInputTokens").and_then(Value::as_u64).unwrap_or(0);
          let cache_creation = usage.get("cacheCreationInputTokens").and_then(Value::as_u64).unwrap_or(0);
          let cost_usd = usage.get("costUSD").and_then(Value::as_f64).unwrap_or(0.0);
          let total = input + output + cache_read + cache_creation;
          stats_models.push(json!({
            "model": model_name,
            "totals": {
              "input": input,
              "output": output,
              "cacheRead": cache_read,
              "cacheCreation": cache_creation,
              "total": total,
              "cost": cost_usd,
            },
            "source": "stats-cache",
          }));
        }
        stats_models.sort_by(|a, b| {
          let at = a.get("totals").and_then(|t| t.get("total")).and_then(Value::as_u64).unwrap_or(0);
          let bt = b.get("totals").and_then(|t| t.get("total")).and_then(Value::as_u64).unwrap_or(0);
          bt.cmp(&at)
        });
      }
      if daily_model_tokens.is_empty() {
        if let Some(dmt) = stats.get("dailyModelTokens").and_then(Value::as_array) {
          for entry in dmt {
            daily_model_tokens.push(entry.clone());
          }
        }
      }
    }
  }

  // Prefer stats-cache models if richer, otherwise use telemetry models
  let models = if !stats_models.is_empty() { stats_models } else { models_from_telemetry };

  let mut official_cost = 0.0;
  let mut official_models: Vec<Value> = Vec::new();
  if let Ok(claude_json) = read_json_file(&claude_json_path_for_home(home)) {
    if let Some(projects) = claude_json.get("projects").and_then(Value::as_object) {
      for project in projects.values() {
        official_cost += project.get("lastCost").and_then(Value::as_f64).unwrap_or(0.0);
        if let Some(model_usage) = project.get("lastModelUsage").and_then(Value::as_object) {
          for (model_name, usage) in model_usage {
            if model_name.starts_with('<') { continue; }
            official_models.push(json!({"model": model_name, "costUSD": usage.get("costUSD").and_then(Value::as_f64).unwrap_or(0.0), "inputTokens": usage.get("inputTokens").and_then(Value::as_u64).unwrap_or(0), "outputTokens": usage.get("outputTokens").and_then(Value::as_u64).unwrap_or(0), "cacheReadInputTokens": usage.get("cacheReadInputTokens").and_then(Value::as_u64).unwrap_or(0), "cacheCreationInputTokens": usage.get("cacheCreationInputTokens").and_then(Value::as_u64).unwrap_or(0)}));
          }
        }
      }
    }
  }

  let payload = json!({
    "days": days.clamp(1, 90),
    "generatedAt": chrono::Utc::now().to_rfc3339(),
    "source": telemetry_root.to_string_lossy().to_string(),
    "totals": {
      "input": total_input,
      "output": total_output,
      "cacheCreation": total_cache_creation,
      "cacheRead": total_cache_read,
      "total": total_input + total_output + total_cache_read + total_cache_creation,
      "cost": total_cost,
    },
    "officialCost": official_cost,
    "officialModels": official_models,
    "daily": daily.into_values().collect::<Vec<_>>(),
    "sessions": sessions,
    "models": models,
    "dailyModelTokens": daily_model_tokens,
  });
  write_claude_usage_cache(&cache_path, &telemetry_root, days.clamp(1, 90), file_count, latest_mtime_ms, &payload);
  payload
}

fn merge_claude_usage_payloads(days: i64, payloads: Vec<Value>, source_label: &str) -> Value {
  let day_count = days.clamp(1, 90);
  if payloads.iter().any(|payload| payload.get("cacheMiss").and_then(Value::as_bool).unwrap_or(false)) {
    return json!({ "cacheMiss": true });
  }

  let mut total_input: u64 = 0;
  let mut total_output: u64 = 0;
  let mut total_cache_creation: u64 = 0;
  let mut total_cache_read: u64 = 0;
  let mut total_cost: f64 = 0.0;
  let mut official_cost: f64 = 0.0;
  let mut generated_at = String::new();

  let mut daily_map: BTreeMap<String, Value> = BTreeMap::new();
  let mut sessions: Vec<Value> = Vec::new();
  let mut model_map: BTreeMap<String, Value> = BTreeMap::new();
  let mut daily_model_tokens_map: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
  let mut official_model_map: BTreeMap<String, Value> = BTreeMap::new();

  for payload in payloads {
    let payload_generated = payload.get("generatedAt").and_then(Value::as_str).unwrap_or("");
    if payload_generated > generated_at.as_str() {
      generated_at = payload_generated.to_string();
    }

    let totals = payload.get("totals").cloned().unwrap_or_else(|| json!({}));
    total_input += totals.get("input").and_then(Value::as_u64).unwrap_or(0);
    total_output += totals.get("output").and_then(Value::as_u64).unwrap_or(0);
    total_cache_creation += totals.get("cacheCreation").and_then(Value::as_u64).unwrap_or(0);
    total_cache_read += totals.get("cacheRead").and_then(Value::as_u64).unwrap_or(0);
    total_cost += totals.get("cost").and_then(Value::as_f64).unwrap_or(0.0);
    official_cost += payload.get("officialCost").and_then(Value::as_f64).unwrap_or(0.0);

    if let Some(entries) = payload.get("daily").and_then(Value::as_array) {
      for entry in entries {
        let date = entry.get("date").and_then(Value::as_str).unwrap_or("").to_string();
        if date.is_empty() { continue; }
        let bucket = daily_map.entry(date.clone()).or_insert_with(|| json!({
          "date": date,
          "input": 0_u64,
          "output": 0_u64,
          "cacheCreation": 0_u64,
          "cacheRead": 0_u64,
          "total": 0_u64,
          "cost": 0.0_f64,
        }));
        bucket["input"] = json!(bucket.get("input").and_then(Value::as_u64).unwrap_or(0) + entry.get("input").and_then(Value::as_u64).unwrap_or(0));
        bucket["output"] = json!(bucket.get("output").and_then(Value::as_u64).unwrap_or(0) + entry.get("output").and_then(Value::as_u64).unwrap_or(0));
        bucket["cacheCreation"] = json!(bucket.get("cacheCreation").and_then(Value::as_u64).unwrap_or(0) + entry.get("cacheCreation").and_then(Value::as_u64).unwrap_or(0));
        bucket["cacheRead"] = json!(bucket.get("cacheRead").and_then(Value::as_u64).unwrap_or(0) + entry.get("cacheRead").and_then(Value::as_u64).unwrap_or(0));
        bucket["total"] = json!(bucket.get("total").and_then(Value::as_u64).unwrap_or(0) + entry.get("total").and_then(Value::as_u64).unwrap_or(0));
        bucket["cost"] = json!(bucket.get("cost").and_then(Value::as_f64).unwrap_or(0.0) + entry.get("cost").and_then(Value::as_f64).unwrap_or(0.0));
      }
    }

    if let Some(entries) = payload.get("sessions").and_then(Value::as_array) {
      sessions.extend(entries.iter().cloned());
    }

    if let Some(entries) = payload.get("models").and_then(Value::as_array) {
      for entry in entries {
        let model = entry.get("model").and_then(Value::as_str).unwrap_or("").to_string();
        if model.is_empty() { continue; }
        let bucket = model_map.entry(model.clone()).or_insert_with(|| json!({
          "model": model,
          "totals": {
            "input": 0_u64,
            "output": 0_u64,
            "cacheCreation": 0_u64,
            "cacheRead": 0_u64,
            "total": 0_u64,
            "cost": 0.0_f64,
          },
          "sessionCount": 0_u64,
          "source": "aggregated",
        }));
        let src_totals = entry.get("totals").cloned().unwrap_or_else(|| json!({}));
        bucket["totals"]["input"] = json!(bucket["totals"].get("input").and_then(Value::as_u64).unwrap_or(0) + src_totals.get("input").and_then(Value::as_u64).unwrap_or(0));
        bucket["totals"]["output"] = json!(bucket["totals"].get("output").and_then(Value::as_u64).unwrap_or(0) + src_totals.get("output").and_then(Value::as_u64).unwrap_or(0));
        bucket["totals"]["cacheCreation"] = json!(bucket["totals"].get("cacheCreation").and_then(Value::as_u64).unwrap_or(0) + src_totals.get("cacheCreation").and_then(Value::as_u64).unwrap_or(0));
        bucket["totals"]["cacheRead"] = json!(bucket["totals"].get("cacheRead").and_then(Value::as_u64).unwrap_or(0) + src_totals.get("cacheRead").and_then(Value::as_u64).unwrap_or(0));
        bucket["totals"]["total"] = json!(bucket["totals"].get("total").and_then(Value::as_u64).unwrap_or(0) + src_totals.get("total").and_then(Value::as_u64).unwrap_or(0));
        bucket["totals"]["cost"] = json!(bucket["totals"].get("cost").and_then(Value::as_f64).unwrap_or(0.0) + src_totals.get("cost").and_then(Value::as_f64).unwrap_or(0.0));
        bucket["sessionCount"] = json!(bucket.get("sessionCount").and_then(Value::as_u64).unwrap_or(0) + entry.get("sessionCount").and_then(Value::as_u64).unwrap_or(0));
      }
    }

    if let Some(entries) = payload.get("dailyModelTokens").and_then(Value::as_array) {
      for entry in entries {
        let date = entry.get("date").and_then(Value::as_str).unwrap_or("").to_string();
        if date.is_empty() { continue; }
        let bucket = daily_model_tokens_map.entry(date).or_default();
        if let Some(tokens_by_model) = entry.get("tokensByModel").and_then(Value::as_object) {
          for (model, value) in tokens_by_model {
            *bucket.entry(model.clone()).or_insert(0) += value.as_u64().unwrap_or(0);
          }
        }
      }
    }

    if let Some(entries) = payload.get("officialModels").and_then(Value::as_array) {
      for entry in entries {
        let model = entry.get("model").and_then(Value::as_str).unwrap_or("").to_string();
        if model.is_empty() { continue; }
        let bucket = official_model_map.entry(model.clone()).or_insert_with(|| json!({
          "model": model,
          "costUSD": 0.0_f64,
          "inputTokens": 0_u64,
          "outputTokens": 0_u64,
          "cacheReadInputTokens": 0_u64,
          "cacheCreationInputTokens": 0_u64,
        }));
        bucket["costUSD"] = json!(bucket.get("costUSD").and_then(Value::as_f64).unwrap_or(0.0) + entry.get("costUSD").and_then(Value::as_f64).unwrap_or(0.0));
        bucket["inputTokens"] = json!(bucket.get("inputTokens").and_then(Value::as_u64).unwrap_or(0) + entry.get("inputTokens").and_then(Value::as_u64).unwrap_or(0));
        bucket["outputTokens"] = json!(bucket.get("outputTokens").and_then(Value::as_u64).unwrap_or(0) + entry.get("outputTokens").and_then(Value::as_u64).unwrap_or(0));
        bucket["cacheReadInputTokens"] = json!(bucket.get("cacheReadInputTokens").and_then(Value::as_u64).unwrap_or(0) + entry.get("cacheReadInputTokens").and_then(Value::as_u64).unwrap_or(0));
        bucket["cacheCreationInputTokens"] = json!(bucket.get("cacheCreationInputTokens").and_then(Value::as_u64).unwrap_or(0) + entry.get("cacheCreationInputTokens").and_then(Value::as_u64).unwrap_or(0));
      }
    }
  }

  sessions.sort_by(|left, right| {
    right.get("updatedAt").and_then(Value::as_str).unwrap_or("")
      .cmp(left.get("updatedAt").and_then(Value::as_str).unwrap_or(""))
  });
  sessions.truncate(12);

  let mut models = model_map.into_values().collect::<Vec<_>>();
  models.sort_by(|left, right| {
    let l = left.get("totals").and_then(|totals| totals.get("total")).and_then(Value::as_u64).unwrap_or(0);
    let r = right.get("totals").and_then(|totals| totals.get("total")).and_then(Value::as_u64).unwrap_or(0);
    r.cmp(&l)
  });

  let daily = daily_map.into_values().collect::<Vec<_>>();
  let daily_model_tokens = daily_model_tokens_map.into_iter()
    .map(|(date, tokens_by_model)| json!({ "date": date, "tokensByModel": tokens_by_model }))
    .collect::<Vec<_>>();

  let mut official_models = official_model_map.into_values().collect::<Vec<_>>();
  official_models.sort_by(|left, right| {
    let left_total =
      left.get("inputTokens").and_then(Value::as_u64).unwrap_or(0) +
      left.get("outputTokens").and_then(Value::as_u64).unwrap_or(0) +
      left.get("cacheReadInputTokens").and_then(Value::as_u64).unwrap_or(0) +
      left.get("cacheCreationInputTokens").and_then(Value::as_u64).unwrap_or(0);
    let right_total =
      right.get("inputTokens").and_then(Value::as_u64).unwrap_or(0) +
      right.get("outputTokens").and_then(Value::as_u64).unwrap_or(0) +
      right.get("cacheReadInputTokens").and_then(Value::as_u64).unwrap_or(0) +
      right.get("cacheCreationInputTokens").and_then(Value::as_u64).unwrap_or(0);
    right_total.cmp(&left_total)
  });

  json!({
    "days": day_count,
    "generatedAt": if generated_at.is_empty() { chrono::Utc::now().to_rfc3339() } else { generated_at },
    "source": source_label,
    "totals": {
      "input": total_input,
      "output": total_output,
      "cacheCreation": total_cache_creation,
      "cacheRead": total_cache_read,
      "total": total_input + total_output + total_cache_read + total_cache_creation,
      "cost": total_cost,
    },
    "officialCost": official_cost,
    "officialModels": official_models,
    "daily": daily,
    "sessions": sessions,
    "models": models,
    "dailyModelTokens": daily_model_tokens,
  })
}

#[cfg(test)]
fn read_claude_telemetry_usage(days: i64, force_refresh: bool, cache_only: bool) -> Value {
  let home = match claude_code_home() {
    Ok(path) => path,
    Err(_) => return json!({"days": days, "generatedAt": chrono::Utc::now().to_rfc3339(), "source": "", "totals": {"input":0,"output":0,"cacheCreation":0,"cacheRead":0,"total":0,"cost":0.0}, "daily": [], "sessions": [], "models": [], "dailyModelTokens": []}),
  };
  read_claude_telemetry_usage_for_home(&home, days, force_refresh, cache_only)
}

pub(crate) fn load_claudecode_state(query: &Value) -> Result<Value, String> {
  let query_object = parse_json_object(query);
  let force_usage_refresh = matches!(get_string(&query_object, "forceUsageRefresh").as_str(), "1" | "true" | "yes");
  let cache_only = matches!(get_string(&query_object, "cacheOnly").as_str(), "1" | "true" | "yes");
  let default_home = claude_code_home()?;
  let home = effective_claude_code_home()?;
  let settings_path = home.join("settings.json");
  let settings = read_json_file(&settings_path)?;
  let binary = find_tool_binary_with_options("claude", cfg!(target_os = "windows"));

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
  let claude_json_path = claude_json_path_for_home(&home);
  let claude_json = read_json_file(&claude_json_path).unwrap_or(json!({}));
  let default_claude_json = if home == default_home {
    claude_json.clone()
  } else {
    read_json_file(&claude_json_path_for_home(&default_home)).unwrap_or(json!({}))
  };

  let has_completed_onboarding = claude_json.get("hasCompletedOnboarding")
    .and_then(Value::as_bool)
    .unwrap_or(false);

  // Login status — only expose oauth / api_key to UI
  let oauth = claude_json.get("oauthAccount");
  let mut login_info = if let Some(account) = oauth.and_then(Value::as_object) {
    json!({
      "loggedIn": true,
      "method": "oauth",
      "email": account.get("emailAddress").and_then(Value::as_str).or_else(|| account.get("email").and_then(Value::as_str)).unwrap_or(""),
      "orgName": account.get("orgName").and_then(Value::as_str).or_else(|| account.get("organizationName").and_then(Value::as_str)).unwrap_or(""),
      "plan": account.get("accountPlan").and_then(Value::as_str).unwrap_or(""),
    })
  } else if has_api_key {
    json!({
      "loggedIn": true,
      "method": "api_key",
      "email": "",
      "apiKeySource": effective_key_source,
    })
  } else if has_keychain_auth && has_completed_onboarding {
    json!({
      "loggedIn": true,
      "method": "api_key",
      "email": "",
      "apiKeySource": "keychain",
    })
  } else {
    json!({
      "loggedIn": false,
      "method": "",
      "email": "",
    })
  };

  fn has_claude_usage_artifacts(config_home: &Path) -> bool {
    config_home.join("projects").exists() || config_home.join("stats-cache.json").exists()
  }

  let requested_usage_scope = get_string(&query_object, "usageScope");
  let profiles_state = crate::claudecode_oauth_profiles::list_claudecode_oauth_profiles(&json!({}))
    .unwrap_or_else(|_| json!({ "active": "", "profiles": [], "defaultPlan": {} }));
  let active_profile_id = profiles_state.get("active").and_then(Value::as_str).unwrap_or("").to_string();
  let default_plan = profiles_state.get("defaultPlan").cloned().unwrap_or_else(|| json!({}));
  let default_email = default_plan.get("email").and_then(Value::as_str).unwrap_or("").trim().to_string();
  let default_org = default_plan.get("organizationName").and_then(Value::as_str).unwrap_or("").trim().to_string();
  let default_plan_label = default_plan.get("plan").and_then(Value::as_str).unwrap_or("").trim().to_string();
  let default_scope_label = {
    let base = if !default_email.is_empty() {
      default_email.clone()
    } else if !default_org.is_empty() {
      default_org.clone()
    } else {
      "默认账号".to_string()
    };
    if default_plan_label.is_empty() {
      base
    } else {
      format!("{} · {}", base, default_plan_label)
    }
  };
  let default_scope_visible = default_claude_json.get("oauthAccount").and_then(Value::as_object).is_some()
    || !default_email.is_empty()
    || !default_plan_label.is_empty()
    || has_claude_usage_artifacts(&default_home)
    || active_profile_id.is_empty();

  let mut available_scopes = Vec::new();
  if default_scope_visible {
    available_scopes.push(json!({
      "scopeId": "default",
      "id": "",
      "kind": "default",
      "label": default_scope_label,
      "configDir": default_home.to_string_lossy().to_string(),
      "email": default_email,
      "organizationName": default_org,
      "plan": default_plan_label,
    }));
  }

  let mut active_profile = json!({
    "scopeId": "default",
    "id": "",
    "kind": "default",
    "label": default_scope_label,
    "configDir": default_home.to_string_lossy().to_string(),
    "email": default_email,
    "organizationName": default_org,
    "plan": default_plan_label,
  });

  if let Some(profiles) = profiles_state.get("profiles").and_then(Value::as_array) {
    for profile in profiles {
      let id = profile.get("id").and_then(Value::as_str).unwrap_or("").trim().to_string();
      if id.is_empty() { continue; }
      let config_dir = profile.get("configDir").and_then(Value::as_str).unwrap_or("").trim().to_string();
      if config_dir.is_empty() { continue; }
      let has_tokens = profile.get("hasTokens").and_then(Value::as_bool).unwrap_or(false);
      let is_stale = profile.get("isStale").and_then(Value::as_bool).unwrap_or(false);
      let include = (has_tokens || has_claude_usage_artifacts(&PathBuf::from(&config_dir)) || id == active_profile_id) && !is_stale;
      if !include { continue; }

      let name = profile.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
      let email = profile.get("email").and_then(Value::as_str).unwrap_or("").trim().to_string();
      let org_name = profile.get("organizationName").and_then(Value::as_str).unwrap_or("").trim().to_string();
      let plan = profile.get("plan").and_then(Value::as_str).unwrap_or("").trim().to_string();
      let short_id = id.trim_start_matches("prof_");
      let short_id = &short_id[..short_id.len().min(8)];
      let mut base = if !name.is_empty() {
        name.clone()
      } else if !email.is_empty() {
        email.clone()
      } else if !org_name.is_empty() {
        org_name.clone()
      } else {
        format!("Claude 账号 #{}", short_id)
      };
      if !email.is_empty() && !name.is_empty() && name != email {
        base = format!("{} · {}", name, email);
      }
      let label = if plan.is_empty() { base } else { format!("{} · {}", base, plan) };
      let scope = json!({
        "scopeId": id,
        "id": id,
        "kind": "profile",
        "label": label,
        "configDir": config_dir,
        "email": email,
        "organizationName": org_name,
        "plan": plan,
      });
      if scope.get("id").and_then(Value::as_str).unwrap_or("") == active_profile_id {
        active_profile = scope.clone();
      }
      available_scopes.push(scope);
    }
  }

  if matches!(login_info.get("method").and_then(Value::as_str), Some("oauth")) {
    if let Some(obj) = login_info.as_object_mut() {
      if obj.get("email").and_then(Value::as_str).unwrap_or("").trim().is_empty() {
        obj.insert("email".to_string(), active_profile.get("email").cloned().unwrap_or_else(|| json!("")));
      }
      if obj.get("orgName").and_then(Value::as_str).unwrap_or("").trim().is_empty() {
        obj.insert("orgName".to_string(), active_profile.get("organizationName").cloned().unwrap_or_else(|| json!("")));
      }
      if obj.get("plan").and_then(Value::as_str).unwrap_or("").trim().is_empty() {
        obj.insert("plan".to_string(), active_profile.get("plan").cloned().unwrap_or_else(|| json!("")));
      }
    }
  }

  let scope_exists = |scope_id: &str| {
    available_scopes.iter().any(|scope| scope.get("scopeId").and_then(Value::as_str).unwrap_or("") == scope_id)
  };
  let normalized_usage_scope = if requested_usage_scope == "all" {
    "all".to_string()
  } else if requested_usage_scope == "default" && scope_exists("default") {
    "default".to_string()
  } else if !requested_usage_scope.is_empty() && scope_exists(&requested_usage_scope) {
    requested_usage_scope.clone()
  } else {
    "active".to_string()
  };
  let effective_scope_id = match normalized_usage_scope.as_str() {
    "all" => "all".to_string(),
    "active" => {
      if active_profile_id.is_empty() || !scope_exists(&active_profile_id) {
        "default".to_string()
      } else {
        active_profile_id.clone()
      }
    }
    other => other.to_string(),
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

  let usage = if effective_scope_id == "all" {
    let homes = available_scopes.iter()
      .filter_map(|scope| scope.get("configDir").and_then(Value::as_str))
      .map(PathBuf::from)
      .collect::<Vec<_>>();
    let payloads = homes.iter()
      .map(|scope_home| read_claude_telemetry_usage_for_home(scope_home, 30, force_usage_refresh, cache_only))
      .collect::<Vec<_>>();
    merge_claude_usage_payloads(30, payloads, "all")
  } else if effective_scope_id == "default" {
    read_claude_telemetry_usage_for_home(&default_home, 30, force_usage_refresh, cache_only)
  } else {
    let scope_home = available_scopes.iter()
      .find(|scope| scope.get("scopeId").and_then(Value::as_str).unwrap_or("") == effective_scope_id)
      .and_then(|scope| scope.get("configDir").and_then(Value::as_str))
      .map(PathBuf::from)
      .unwrap_or_else(|| home.clone());
    read_claude_telemetry_usage_for_home(&scope_home, 30, force_usage_refresh, cache_only)
  };

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
    "usageScope": normalized_usage_scope,
    "availableScopes": available_scopes,
    "activeProfile": active_profile,
    "usedModels": used_models.into_iter().collect::<Vec<_>>(),
    "usage": usage,
  }))
}

pub(crate) fn save_claudecode_config(body: &Value) -> Result<Value, String> {
  let home = effective_claude_code_home()?;
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

// Delete one of the user-saved Claude Code provider profiles we maintain
// under ~/.claude/settings.json :: easyaiconfig.providers.<key>. If the
// deleted provider was the active one, fall back to any other remaining
// provider or clear the activeProvider pointer.
pub(crate) fn delete_claudecode_provider(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let provider_key = get_string(&object, "providerKey");
  if provider_key.trim().is_empty() {
    return Err("providerKey is required".to_string());
  }

  let home = effective_claude_code_home()?;
  let settings_path = home.join("settings.json");
  let mut settings = read_json_file(&settings_path)?;

  let mut removed = false;
  let mut fallback_active: Option<String> = None;
  if let Some(obj) = settings.as_object_mut() {
    if let Some(easy) = obj.get_mut("easyaiconfig").and_then(Value::as_object_mut) {
      // Snapshot the active-provider value before mutably borrowing `providers`.
      let was_active = easy
        .get("activeProvider")
        .and_then(Value::as_str)
        .map(|s| s == provider_key)
        .unwrap_or(false);

      if let Some(providers) = easy.get_mut("providers").and_then(Value::as_object_mut) {
        removed = providers.remove(&provider_key).is_some();
        if was_active {
          if let Some((next_key, _)) = providers.iter().find(|(_, v)| v.is_object()) {
            fallback_active = Some(next_key.clone());
          }
        }
      }

      if let Some(next) = fallback_active {
        easy.insert("activeProvider".to_string(), json!(next));
      } else if was_active {
        easy.remove("activeProvider");
      }
    }
  }

  if !removed {
    return Err(format!("未找到 provider: {}", provider_key));
  }

  write_json_file(&settings_path, &settings)?;
  Ok(json!({
    "ok": true,
    "providerKey": provider_key,
    "settingsPath": settings_path.to_string_lossy().to_string(),
  }))
}

pub(crate) fn save_claudecode_raw_config(body: &Value) -> Result<Value, String> {
  let home = effective_claude_code_home()?;
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
    let cwd_arg = normalize_windows_cmd_path(&cwd.to_string_lossy());
    create_command("cmd.exe")
      .args(["/c", "start", "", "/d", &cwd_arg, "cmd.exe", "/d", "/k"])
      .arg(command_text)
      .spawn()
      .map_err(|error| error.to_string())?;
    return Ok(format!("{} 已通过 CMD（命令提示符）新窗口启动", tool_label));
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

fn quote_windows_cmd_arg(value: &str) -> String {
  format!("\"{}\"", value.replace('"', "\"\""))
}

fn normalize_windows_cmd_path(raw: &str) -> String {
  let trimmed = raw.trim();
  let unwrapped = if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
    &trimmed[1..trimmed.len() - 1]
  } else {
    trimmed
  };
  if let Some(stripped) = unwrapped.strip_prefix("\\\\?\\UNC\\") {
    return format!("\\\\{}", stripped);
  }
  if let Some(stripped) = unwrapped.strip_prefix("\\\\?\\") {
    return stripped.to_string();
  }
  unwrapped.to_string()
}

fn build_windows_binary_command(binary_path: &str, args: &[String], fallback_binary: &str) -> String {
  let normalized = normalize_windows_cmd_path(binary_path);
  let lower = normalized.to_ascii_lowercase();

  if !fallback_binary.trim().is_empty() && command_exists(fallback_binary).is_some() {
    let mut parts = vec![fallback_binary.to_string()];
    parts.extend(args.iter().map(|arg| quote_windows_cmd_arg(arg)));
    return parts.join(" ");
  }

  if normalized.trim().is_empty() {
    let mut parts = vec![fallback_binary.to_string()];
    parts.extend(args.iter().map(|arg| quote_windows_cmd_arg(arg)));
    return parts.join(" ");
  }

  if lower.ends_with(".ps1") {
    let mut parts = vec![
      "powershell.exe".to_string(),
      "-NoProfile".to_string(),
      "-NonInteractive".to_string(),
      "-ExecutionPolicy".to_string(),
      "Bypass".to_string(),
      "-File".to_string(),
      quote_windows_cmd_arg(&normalized),
    ];
    parts.extend(args.iter().map(|arg| quote_windows_cmd_arg(arg)));
    return parts.join(" ");
  }

  let mut parts = Vec::new();
  if lower.ends_with(".cmd") || lower.ends_with(".bat") {
    parts.push("call".to_string());
  }
  parts.push(quote_windows_cmd_arg(&normalized));
  parts.extend(args.iter().map(|arg| quote_windows_cmd_arg(arg)));
  parts.join(" ")
}


fn launch_terminal_for_tool(cwd: &Path, binary_path: &str, tool_label: &str, fallback_binary: &str) -> Result<String, String> {
  if cfg!(target_os = "windows") {
    let empty_args: Vec<String> = Vec::new();
    let command_text = build_windows_binary_command(binary_path, &empty_args, fallback_binary);
    return launch_terminal_command(cwd, &command_text, tool_label);
  }
  launch_terminal_command(cwd, binary_path, tool_label)
}

fn probe_openclaw_gateway(gateway_url: &str) -> (bool, bool) {
  let http_ok = reqwest::blocking::Client::builder()
    .connect_timeout(std::time::Duration::from_millis(500))
    .timeout(std::time::Duration::from_millis(4500))
    .redirect(reqwest::redirect::Policy::none())
    .build()
    .ok()
    .and_then(|client| client.get(gateway_url).send().ok())
    .map(|response| response.status().as_u16() > 0)
    .unwrap_or(false);
  if http_ok {
    return (true, true);
  }

  let port_listening = reqwest::Url::parse(gateway_url)
    .ok()
    .and_then(|url| {
      let host = url.host_str()?.to_string();
      let port = url.port_or_known_default()?;
      std::net::TcpStream::connect_timeout(
        &(host.as_str(), port).to_socket_addrs().ok()?.next()?,
        std::time::Duration::from_millis(1500),
      ).ok()
    })
    .is_some();
  (false, port_listening)
}

fn parse_windows_csv_line(line: &str) -> Vec<String> {
  let mut values = Vec::new();
  let mut current = String::new();
  let mut in_quotes = false;
  let chars: Vec<char> = line.chars().collect();
  let mut index = 0usize;
  while index < chars.len() {
    let ch = chars[index];
    if ch == '"' {
      if in_quotes && index + 1 < chars.len() && chars[index + 1] == '"' {
        current.push('"');
        index += 2;
        continue;
      }
      in_quotes = !in_quotes;
      index += 1;
      continue;
    }
    if ch == ',' && !in_quotes {
      values.push(current.trim().to_string());
      current.clear();
      index += 1;
      continue;
    }
    current.push(ch);
    index += 1;
  }
  values.push(current.trim().to_string());
  values
}

fn inspect_openclaw_port_occupants(port: &str) -> Vec<Value> {
  if !cfg!(target_os = "windows") {
    return Vec::new();
  }

  let output = match create_command("netstat").args(["-ano", "-p", "tcp"]).output() {
    Ok(out) => out,
    Err(_) => return Vec::new(),
  };
  let stdout = String::from_utf8_lossy(&output.stdout);
  let mut seen = HashSet::new();
  let mut items = Vec::new();
  for line in stdout.lines() {
    let text = line.trim();
    if !text.contains("LISTENING") {
      continue;
    }
    let parts = text.split_whitespace().collect::<Vec<_>>();
    if parts.len() < 5 {
      continue;
    }
    let local_addr = parts[1];
    let pid = parts[4];
    if !local_addr.ends_with(&format!(":{}", port)) || !seen.insert(pid.to_string()) {
      continue;
    }

    let mut name = String::from("未知进程");
    let mut command_line = String::new();

    let ps_script = format!("$p = Get-CimInstance Win32_Process -Filter \"ProcessId = {}\" | Select-Object ProcessId,Name,CommandLine; if ($p) {{ $p | ConvertTo-Json -Compress }}", pid);
    if let Ok(ps_out) = create_command("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &ps_script]).output() {
      let ps_text = String::from_utf8_lossy(&ps_out.stdout).trim().to_string();
      if !ps_text.is_empty() {
        if let Ok(parsed) = serde_json::from_str::<Value>(&ps_text) {
          name = parsed.get("Name").and_then(Value::as_str).unwrap_or("未知进程").to_string();
          command_line = parsed.get("CommandLine").and_then(Value::as_str).unwrap_or("").to_string();
        }
      }
    }

    if name == "未知进程" {
      if let Ok(task_out) = create_command("tasklist").args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"]).output() {
        if let Some(first_line) = String::from_utf8_lossy(&task_out.stdout).lines().find(|line| !line.trim().is_empty() && !line.trim().starts_with("INFO:")) {
          let cols = parse_windows_csv_line(first_line);
          if let Some(first) = cols.first() {
            name = first.to_string();
          }
        }
      }
    }

    let likely_openclaw = format!("{} {}", name, command_line).to_lowercase().contains("openclaw");
    items.push(json!({
      "pid": pid.parse::<u32>().unwrap_or(0),
      "name": name,
      "commandLine": command_line,
      "likelyOpenClaw": likely_openclaw,
      "label": format!("{} (PID {})", if name.is_empty() { "未知进程" } else { &name }, pid),
    }));
  }
  items
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

fn extract_openclaw_gateway_token(text: &str) -> Option<String> {
  text.split_whitespace()
    .find(|part| part.starts_with("oc_"))
    .map(|part| part.trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_').to_string())
    .filter(|token| !token.is_empty())
}

fn normalize_openclaw_dashboard_bootstrap_url(raw_url: &str, gateway_token: &str) -> String {
  let input = raw_url.trim();
  if input.is_empty() {
    return String::new();
  }
  let mut url = reqwest::Url::parse(input).unwrap_or_else(|_| reqwest::Url::parse("http://127.0.0.1:18789/").unwrap());
  url.set_fragment(None);
  if !gateway_token.trim().is_empty() {
    url.query_pairs_mut().clear().append_pair("token", gateway_token).finish();
  }
  url.to_string()
}

// macOS-only: wrapper invoked by Claude CLI's openBrowser when BROWSER is set.
// Claude CLI calls it as `execa(browser, [url])` with no shell, so BROWSER must
// point at a single executable. This script dispatches to the right `open`
// invocation based on CLAUDE_OAUTH_BROWSER_CHOICE, falling back to the system
// default when the chosen browser isn't installed.
#[cfg(target_os = "macos")]
const CLAUDE_OAUTH_BROWSER_SH: &str = r#"#!/bin/sh
URL="$1"
CHOICE="${CLAUDE_OAUTH_BROWSER_CHOICE:-default}"

case "$CHOICE" in
  chrome-incognito)
    open -na "Google Chrome" --args --incognito --new-window "$URL" && exit 0
    ;;
  edge-inprivate)
    open -na "Microsoft Edge" --args --inprivate --new-window "$URL" && exit 0
    ;;
  firefox-private)
    open -na "Firefox" --args -private-window "$URL" && exit 0
    ;;
  chrome-normal)
    open -a "Google Chrome" "$URL" && exit 0
    ;;
esac

open "$URL"
"#;

#[cfg(target_os = "macos")]
fn ensure_claude_oauth_browser_wrapper() -> Result<PathBuf, String> {
  use std::os::unix::fs::PermissionsExt;
  let path = crate::app_home()?.join("claude-oauth-browser.sh");
  if let Some(parent) = path.parent() {
    let _ = std::fs::create_dir_all(parent);
  }
  let needs_write = match std::fs::read_to_string(&path) {
    Ok(existing) => existing != CLAUDE_OAUTH_BROWSER_SH,
    Err(_) => true,
  };
  if needs_write {
    std::fs::write(&path, CLAUDE_OAUTH_BROWSER_SH)
      .map_err(|error| format!("写入 browser wrapper 失败：{}", error))?;
  }
  let mut perms = std::fs::metadata(&path)
    .map_err(|error| error.to_string())?
    .permissions();
  if perms.mode() & 0o777 != 0o755 {
    perms.set_mode(0o755);
    std::fs::set_permissions(&path, perms).map_err(|error| error.to_string())?;
  }
  Ok(path)
}

#[cfg(target_os = "macos")]
fn normalize_oauth_browser_choice(value: &str) -> Option<&'static str> {
  match value.trim() {
    "chrome-incognito" => Some("chrome-incognito"),
    "edge-inprivate" => Some("edge-inprivate"),
    "firefox-private" => Some("firefox-private"),
    "chrome-normal" => Some("chrome-normal"),
    _ => None,
  }
}

#[cfg(target_os = "macos")]
fn with_oauth_browser_env(command_text: &str, choice: &str) -> String {
  let Some(choice) = normalize_oauth_browser_choice(choice) else {
    return command_text.to_string();
  };
  let wrapper = match ensure_claude_oauth_browser_wrapper() {
    Ok(path) => path,
    Err(_) => return command_text.to_string(),
  };
  format!(
    "BROWSER={} CLAUDE_OAUTH_BROWSER_CHOICE={} {}",
    shell_single_quote(&wrapper.to_string_lossy()),
    shell_single_quote(choice),
    command_text,
  )
}

#[cfg(not(target_os = "macos"))]
fn with_oauth_browser_env(command_text: &str, _choice: &str) -> String {
  command_text.to_string()
}

// Build a platform-correct shell command prefix that exports CLAUDE_CONFIG_DIR
// just for the following command (so it doesn't bleed into the user's shell).
//   - Unix (bash/zsh): CLAUDE_CONFIG_DIR="path" <cmd>
//   - Windows cmd.exe: set "CLAUDE_CONFIG_DIR=path" && <cmd>
fn with_claude_config_dir(command_text: &str, dir: Option<&Path>) -> String {
  let Some(dir) = dir else { return command_text.to_string(); };
  let text = dir.to_string_lossy();
  if cfg!(target_os = "windows") {
    // cmd.exe tolerates trailing spaces in `set` values so we quote aggressively.
    format!("set \"CLAUDE_CONFIG_DIR={}\" && {}", text.replace('"', "\"\""), command_text)
  } else {
    // Single-word export inline — standard POSIX shell syntax.
    format!("CLAUDE_CONFIG_DIR={} {}", shell_single_quote(&text), command_text)
  }
}

fn shell_single_quote(value: &str) -> String {
  // POSIX-safe single-quote escape: 'a'\''b' for a value containing '
  let mut out = String::with_capacity(value.len() + 2);
  out.push('\'');
  for ch in value.chars() {
    if ch == '\'' {
      out.push_str("'\\''");
    } else {
      out.push(ch);
    }
  }
  out.push('\'');
  out
}

// Resolve the CLAUDE_CONFIG_DIR to use, in priority order:
//   1. explicit `profileId` in the request body (add-profile flow needs this
//      before the profile is actually activated);
//   2. explicit `configDir` in the request body (escape hatch for power users);
//   3. whichever profile is currently active in profiles.json;
//   4. None → default ~/.claude/ (no env var injected).
fn resolve_claude_config_dir(object: &serde_json::Map<String, Value>) -> Option<PathBuf> {
  use crate::app_home;
  let profile_id = get_string(object, "profileId");
  if !profile_id.is_empty() {
    let dir = app_home().ok()?.join("claudecode-oauth-profiles").join(&profile_id);
    if dir.exists() { return Some(dir); }
  }
  let explicit = get_string(object, "configDir");
  if !explicit.is_empty() {
    return Some(PathBuf::from(explicit));
  }
  crate::claudecode_oauth_profiles::active_profile_config_dir()
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

  let config_dir = resolve_claude_config_dir(&object);
  if let Some(ref dir) = config_dir {
    // Ensure the profile dir exists so Claude has a place to write state on
    // first launch (empty dir is fine — Claude bootstraps it).
    let _ = std::fs::create_dir_all(dir);
  }

  // If no config dir needs injecting, use the existing tool-launcher path so
  // Windows tool resolution (PATH lookup, .cmd/.bat dispatch) still works.
  if config_dir.is_none() {
    let message = launch_terminal_for_tool(&cwd, bin_path, "Claude Code", "claude")?;
    return Ok(json!({ "ok": true, "cwd": cwd.to_string_lossy().to_string(), "message": message }));
  }

  // With a CONFIG_DIR we need to run Claude inside a shell so the env var
  // export survives across the new terminal hop.
  let base_cmd = if cfg!(target_os = "windows") {
    build_windows_binary_command(bin_path, &[], "claude")
  } else {
    format!("\"{}\"", bin_path.replace('"', "\\\""))
  };
  let command = with_claude_config_dir(&base_cmd, config_dir.as_deref());
  let message = launch_terminal_command(&cwd, &command, "Claude Code")?;
  Ok(json!({ "ok": true, "cwd": cwd.to_string_lossy().to_string(), "message": message }))
}

pub(crate) fn login_claudecode(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let cwd = {
    let input = get_string(&object, "cwd");
    if input.is_empty() { home_dir()? } else { PathBuf::from(input) }
  };
  let binary = find_tool_binary("claude");
  if !binary.get("installed").and_then(Value::as_bool).unwrap_or(false) {
    return Err("Claude Code 尚未安装，请先点击安装".to_string());
  }
  let binary_path = binary
    .get("path")
    .and_then(Value::as_str)
    .filter(|text| !text.trim().is_empty())
    .unwrap_or("claude");

  let config_dir = resolve_claude_config_dir(&object);
  if let Some(ref dir) = config_dir {
    let _ = std::fs::create_dir_all(dir);
  }

  let base_command = if cfg!(target_os = "windows") {
    build_windows_binary_command(binary_path, &["auth".to_string(), "login".to_string()], "claude")
  } else {
    format!("\"{}\" auth login", binary_path.replace('"', "\\\""))
  };
  let command = with_claude_config_dir(&base_command, config_dir.as_deref());
  let browser_choice = get_string(&object, "browserChoice");
  let command = with_oauth_browser_env(&command, &browser_choice);
  let label = if config_dir.is_some() {
    "Claude Code 多账号登录"
  } else {
    "Claude Code OAuth 登录"
  };
  let message = launch_terminal_command(&cwd, &command, label)?;
  Ok(json!({
    "ok": true,
    "cwd": cwd.to_string_lossy().to_string(),
    "configDir": config_dir.map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
    "message": message,
  }))
}

fn strip_json_comments(content: &str) -> String {
  let chars: Vec<char> = content.chars().collect();
  let mut out = String::new();
  let mut in_string = false;
  let mut escaped = false;
  let mut index = 0usize;
  while index < chars.len() {
    let ch = chars[index];
    let next = chars.get(index + 1).copied().unwrap_or('/');
    if in_string {
      out.push(ch);
      if escaped {
        escaped = false;
      } else if ch == '\\' {
        escaped = true;
      } else if ch == '"' {
        in_string = false;
      }
      index += 1;
      continue;
    }
    if ch == '"' {
      in_string = true;
      out.push(ch);
      index += 1;
      continue;
    }
    if ch == '/' && next == '/' {
      index += 2;
      while index < chars.len() && chars[index] != '\n' {
        index += 1;
      }
      if index < chars.len() {
        out.push('\n');
        index += 1;
      }
      continue;
    }
    if ch == '/' && next == '*' {
      index += 2;
      while index + 1 < chars.len() && !(chars[index] == '*' && chars[index + 1] == '/') {
        if chars[index] == '\n' {
          out.push('\n');
        }
        index += 1;
      }
      index = (index + 2).min(chars.len());
      continue;
    }
    out.push(ch);
    index += 1;
  }
  out
}

fn strip_json_trailing_commas(content: &str) -> String {
  let chars: Vec<char> = content.chars().collect();
  let mut out = String::new();
  let mut in_string = false;
  let mut escaped = false;
  let mut index = 0usize;
  while index < chars.len() {
    let ch = chars[index];
    if in_string {
      out.push(ch);
      if escaped {
        escaped = false;
      } else if ch == '\\' {
        escaped = true;
      } else if ch == '"' {
        in_string = false;
      }
      index += 1;
      continue;
    }
    if ch == '"' {
      in_string = true;
      out.push(ch);
      index += 1;
      continue;
    }
    if ch == ',' {
      let mut cursor = index + 1;
      while cursor < chars.len() && chars[cursor].is_whitespace() {
        cursor += 1;
      }
      if cursor < chars.len() && (chars[cursor] == '}' || chars[cursor] == ']') {
        index += 1;
        continue;
      }
    }
    out.push(ch);
    index += 1;
  }
  out
}

fn parse_jsonc_content(content: &str) -> Result<Value, String> {
  let trimmed = content.trim();
  if trimmed.is_empty() {
    return Ok(json!({}));
  }
  serde_json::from_str(&strip_json_trailing_commas(&strip_json_comments(trimmed)))
    .map_err(|error| format!("OpenCode 配置解析失败：{}", error))
}

fn mask_secret(value: &str) -> String {
  let text = value.trim();
  if text.is_empty() {
    return String::new();
  }
  let chars: Vec<char> = text.chars().collect();
  if chars.len() <= 8 {
    let prefix: String = chars.iter().take(2).collect();
    let suffix = chars.last().copied().unwrap_or('*');
    return format!("{}***{}", prefix, suffix);
  }
  let prefix: String = chars.iter().take(4).collect();
  let suffix: String = chars[chars.len().saturating_sub(4)..].iter().collect();
  format!("{}***{}", prefix, suffix)
}

#[derive(Clone)]
struct OpenCodePaths {
  scope: String,
  root_path: PathBuf,
  config_path: PathBuf,
  auth_path: PathBuf,
}

fn first_existing_path(paths: &[PathBuf], fallback: PathBuf) -> PathBuf {
  for candidate in paths {
    if candidate.exists() {
      return candidate.clone();
    }
  }
  fallback
}

fn resolve_opencode_paths(source: &Value) -> Result<OpenCodePaths, String> {
  let object = parse_json_object(source);
  let scope = match get_string(&object, "scope").trim().to_lowercase().as_str() {
    "project" => "project".to_string(),
    _ => "global".to_string(),
  };
  let auth_path = opencode_data_home()?.join("auth.json");
  if scope == "project" {
    let project_path = get_string(&object, "projectPath");
    if project_path.trim().is_empty() {
      return Err("Project path is required for project scope".to_string());
    }
    let root_path = PathBuf::from(project_path.trim());
    return Ok(OpenCodePaths {
      scope,
      root_path: root_path.clone(),
      config_path: first_existing_path(
        &[
          root_path.join(".opencode").join("opencode.jsonc"),
          root_path.join(".opencode").join("opencode.json"),
          root_path.join("opencode.jsonc"),
          root_path.join("opencode.json"),
        ],
        root_path.join("opencode.json"),
      ),
      auth_path,
    });
  }
  let root_path = opencode_config_home()?;
  Ok(OpenCodePaths {
    scope,
    root_path: root_path.clone(),
    config_path: first_existing_path(
      &[
        root_path.join("opencode.jsonc"),
        root_path.join("opencode.json"),
        root_path.join("config.json"),
      ],
      root_path.join("opencode.json"),
    ),
    auth_path,
  })
}

fn normalize_opencode_auth_entry_key(value: &str) -> String {
  value.trim().trim_end_matches('/').to_string()
}

fn normalize_opencode_expiry(value: &Value) -> String {
  let seconds = value.as_f64()
    .or_else(|| value.as_i64().map(|number| number as f64))
    .or_else(|| value.as_u64().map(|number| number as f64));
  let Some(raw_number) = seconds else { return String::new(); };
  if !raw_number.is_finite() || raw_number <= 0.0 {
    return String::new();
  }
  let millis = if raw_number > 1_000_000_000_000.0 {
    raw_number as i64
  } else {
    (raw_number * 1000.0) as i64
  };
  chrono::DateTime::<chrono::Utc>::from_timestamp_millis(millis)
    .map(|time| time.to_rfc3339())
    .unwrap_or_default()
}

fn parse_opencode_auth_json(content: &str) -> Result<Value, String> {
  let trimmed = content.trim();
  if trimmed.is_empty() {
    return Ok(json!({}));
  }
  let parsed = serde_json::from_str::<Value>(trimmed)
    .map_err(|error| format!("OpenCode 鉴权文件解析失败：{}", error))?;
  Ok(if parsed.is_object() { parsed } else { json!({}) })
}

fn summarize_opencode_auth_entries(auth_json: &Value) -> Vec<Value> {
  let mut entries = auth_json
    .as_object()
    .map(|object| {
      object.iter().map(|(key, value)| {
        let entry_type = value.get("type").and_then(Value::as_str).unwrap_or("unknown").trim().to_lowercase();
        let secret = if entry_type == "oauth" {
          value.get("access").and_then(Value::as_str)
            .or_else(|| value.get("refresh").and_then(Value::as_str))
            .unwrap_or("")
            .trim()
            .to_string()
        } else if entry_type == "wellknown" {
          value.get("token").and_then(Value::as_str).unwrap_or("").trim().to_string()
        } else {
          value.get("key").and_then(Value::as_str).unwrap_or("").trim().to_string()
        };
        json!({
          "key": normalize_opencode_auth_entry_key(key),
          "type": if entry_type.is_empty() { "unknown" } else { &entry_type },
          "maskedSecret": mask_secret(&secret),
          "expiresAt": if entry_type == "oauth" { normalize_opencode_expiry(&value["expires"]) } else { String::new() },
          "hasCredential": !secret.is_empty(),
        })
      }).collect::<Vec<_>>()
    })
    .unwrap_or_default();
  entries.sort_by(|left, right| {
    left.get("key").and_then(Value::as_str).unwrap_or("")
      .cmp(right.get("key").and_then(Value::as_str).unwrap_or(""))
  });
  entries
}

fn find_opencode_auth_entry(auth_entries: &[Value], provider_key: &str, base_url: &str) -> Option<Value> {
  let normalized_provider_key = normalize_opencode_auth_entry_key(provider_key);
  let normalized_base_url = normalize_opencode_auth_entry_key(base_url);
  auth_entries.iter().find(|entry| {
    let auth_key = normalize_opencode_auth_entry_key(entry.get("key").and_then(Value::as_str).unwrap_or(""));
    (!normalized_provider_key.is_empty() && auth_key == normalized_provider_key)
      || (!normalized_base_url.is_empty() && auth_key == normalized_base_url)
  }).cloned()
}

fn open_code_provider_from_model(model: &str) -> String {
  model.split_once('/').map(|(provider, _)| provider.to_string()).unwrap_or_default()
}

fn quote_posix_shell_arg(value: &str) -> String {
  format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn can_access_google() -> bool {
  let client = match reqwest::blocking::Client::builder()
    .connect_timeout(std::time::Duration::from_millis(1500))
    .timeout(std::time::Duration::from_millis(2800))
    .redirect(reqwest::redirect::Policy::limited(2))
    .build() {
      Ok(client) => client,
      Err(_) => return false,
    };
  ["https://www.google.com/generate_204", "https://www.gstatic.com/generate_204"]
    .iter()
    .any(|url| {
      client.get(*url)
        .header(reqwest::header::USER_AGENT, "easy-ai-config/1.0")
        .send()
        .map(|response| response.status().is_success() || response.status().is_redirection())
        .unwrap_or(false)
    })
}

fn resolve_opencode_install_method(method: &str) -> String {
  let normalized = method.trim().to_lowercase();
  if cfg!(target_os = "windows") {
    match normalized.as_str() {
      "auto" | "domestic" | "npm" | "scoop" | "choco" => normalized,
      _ => "auto".to_string(),
    }
  } else {
    match normalized.as_str() {
      "auto" | "domestic" | "script" | "brew" | "npm" => normalized,
      _ => "auto".to_string(),
    }
  }
}

fn resolve_opencode_effective_method(method: &str) -> (String, bool) {
  let normalized = resolve_opencode_install_method(method);
  if normalized != "auto" {
    return (normalized, false);
  }
  let google_ok = can_access_google();
  if google_ok {
    if cfg!(target_os = "windows") {
      ("npm".to_string(), true)
    } else {
      ("script".to_string(), true)
    }
  } else {
    ("domestic".to_string(), false)
  }
}

fn open_code_shell_action(command_text: &str) -> Result<Value, String> {
  if cfg!(target_os = "windows") {
    let args = vec![
      "-NoProfile".to_string(),
      "-NonInteractive".to_string(),
      "-ExecutionPolicy".to_string(),
      "Bypass".to_string(),
      "-Command".to_string(),
      command_text.to_string(),
    ];
    let result = run_command_dynamic("powershell.exe", &args, None, None)?;
    return Ok(json!({
      "ok": result.get("ok").and_then(Value::as_bool).unwrap_or(false),
      "code": result.get("code").cloned().unwrap_or(Value::Null),
      "stdout": result.get("stdout").cloned().unwrap_or(Value::String(String::new())),
      "stderr": result.get("stderr").cloned().unwrap_or(Value::String(String::new())),
      "command": format!("powershell -Command {}", command_text),
    }));
  }
  let args = vec!["-lc".to_string(), command_text.to_string()];
  let result = run_command_dynamic("sh", &args, None, None)?;
  Ok(json!({
    "ok": result.get("ok").and_then(Value::as_bool).unwrap_or(false),
    "code": result.get("code").cloned().unwrap_or(Value::Null),
    "stdout": result.get("stdout").cloned().unwrap_or(Value::String(String::new())),
    "stderr": result.get("stderr").cloned().unwrap_or(Value::String(String::new())),
    "command": command_text,
  }))
}

fn open_code_npm_action(mut args: Vec<String>, use_cn_registry: bool) -> Result<Value, String> {
  if use_cn_registry {
    args.push("--registry".to_string());
    args.push(OPENCODE_NPM_REGISTRY_CN.to_string());
  }
  let result = run_command_dynamic(npm_command(), &args, None, None)?;
  Ok(json!({
    "ok": result.get("ok").and_then(Value::as_bool).unwrap_or(false),
    "code": result.get("code").cloned().unwrap_or(Value::Null),
    "stdout": result.get("stdout").cloned().unwrap_or(Value::String(String::new())),
    "stderr": result.get("stderr").cloned().unwrap_or(Value::String(String::new())),
    "command": format!("{} {}", npm_command(), args.join(" ")),
  }))
}

fn open_code_remove_binary_action() -> Result<Value, String> {
  let binary = find_tool_binary("opencode");
  let path = binary.get("path").and_then(Value::as_str).unwrap_or("").trim().to_string();
  if path.is_empty() {
    return Ok(json!({
      "ok": true,
      "code": 0,
      "stdout": "",
      "stderr": "",
      "command": "rm -f <opencode-binary>",
    }));
  }
  if cfg!(target_os = "windows") {
    return open_code_shell_action(&format!("Remove-Item -Force '{}'", path.replace('\'', "''")));
  }
  open_code_shell_action(&format!("rm -f {}", quote_posix_shell_arg(&path)))
}

fn run_opencode_action(kind: &str, body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let requested_method = resolve_opencode_install_method(&get_string(&object, "method"));
  let (effective_method, google_ok) = resolve_opencode_effective_method(&requested_method);
  let use_cn_registry = effective_method == "domestic";
  let latest_package = format!("{}@latest", OPENCODE_PACKAGE);
  let mut result = match kind {
    "install" => match effective_method.as_str() {
      "domestic" => open_code_npm_action(vec!["install".to_string(), "-g".to_string(), latest_package.clone()], true)?,
      "npm" => open_code_npm_action(vec!["install".to_string(), "-g".to_string(), latest_package.clone()], false)?,
      "brew" => open_code_shell_action("brew install anomalyco/tap/opencode")?,
      "scoop" => open_code_shell_action("scoop install opencode")?,
      "choco" => open_code_shell_action("choco install opencode -y")?,
      _ => open_code_shell_action(OPENCODE_INSTALL_SCRIPT_UNIX)?,
    },
    "reinstall" => match effective_method.as_str() {
      "domestic" => open_code_npm_action(vec!["install".to_string(), "-g".to_string(), latest_package.clone(), "--force".to_string()], true)?,
      "npm" => open_code_npm_action(vec!["install".to_string(), "-g".to_string(), latest_package.clone(), "--force".to_string()], false)?,
      "brew" => open_code_shell_action("brew reinstall anomalyco/tap/opencode")?,
      "scoop" => open_code_shell_action("scoop uninstall opencode; scoop install opencode")?,
      "choco" => open_code_shell_action("choco uninstall opencode -y; choco install opencode -y")?,
      _ => open_code_shell_action(OPENCODE_INSTALL_SCRIPT_UNIX)?,
    },
    "update" => match effective_method.as_str() {
      "domestic" => open_code_npm_action(vec!["install".to_string(), "-g".to_string(), latest_package.clone()], true)?,
      "npm" => open_code_npm_action(vec!["install".to_string(), "-g".to_string(), latest_package.clone()], false)?,
      "brew" => open_code_shell_action("brew upgrade anomalyco/tap/opencode || brew install anomalyco/tap/opencode")?,
      "scoop" => open_code_shell_action("scoop update opencode")?,
      "choco" => open_code_shell_action("choco upgrade opencode -y")?,
      _ => open_code_shell_action(OPENCODE_INSTALL_SCRIPT_UNIX)?,
    },
    "uninstall" => match effective_method.as_str() {
      "domestic" | "npm" => open_code_npm_action(vec!["uninstall".to_string(), "-g".to_string(), OPENCODE_PACKAGE.to_string()], false)?,
      "brew" => open_code_shell_action("brew uninstall anomalyco/tap/opencode || brew uninstall opencode")?,
      "scoop" => open_code_shell_action("scoop uninstall opencode")?,
      "choco" => open_code_shell_action("choco uninstall opencode -y")?,
      _ => open_code_remove_binary_action()?,
    },
    _ => return Err("不支持的 OpenCode 操作".to_string()),
  };

  if let Some(result_object) = result.as_object_mut() {
    result_object.insert("requestedMethod".to_string(), json!(requested_method));
    result_object.insert("method".to_string(), json!(effective_method));
    result_object.insert("official".to_string(), json!(effective_method != "domestic"));
    result_object.insert("usedDomesticMirror".to_string(), json!(use_cn_registry));
    result_object.insert("googleReachable".to_string(), json!(google_ok));
  }
  Ok(result)
}

pub(crate) fn load_opencode_state(query: &Value) -> Result<Value, String> {
  let paths = resolve_opencode_paths(query)?;
  let raw_config = read_text(&paths.config_path)?;
  let raw_auth = read_text(&paths.auth_path)?;
  let config = parse_jsonc_content(&raw_config)?;
  let auth_json = parse_opencode_auth_json(&raw_auth)?;
  let auth_entries = summarize_opencode_auth_entries(&auth_json);
  let binary = find_tool_binary_with_options("opencode", cfg!(target_os = "windows"));

  let mut providers = config.get("provider")
    .and_then(Value::as_object)
    .map(|provider_map| {
      provider_map.iter().map(|(key, value)| {
        let base_url = value.get("options").and_then(|item| item.get("baseURL")).and_then(Value::as_str).unwrap_or("").trim().to_string();
        let api_key = value.get("options").and_then(|item| item.get("apiKey")).and_then(Value::as_str).unwrap_or("").trim().to_string();
        let matched_auth = find_opencode_auth_entry(&auth_entries, key, &base_url);
        let model_ids = value.get("models")
          .and_then(Value::as_object)
          .map(|models| models.keys().cloned().collect::<Vec<_>>())
          .unwrap_or_default();
        json!({
          "key": key,
          "name": value.get("name").and_then(Value::as_str).unwrap_or(key),
          "npm": value.get("npm").and_then(Value::as_str).unwrap_or(""),
          "baseUrl": base_url,
          "hasApiKey": !api_key.is_empty(),
          "hasAuth": matched_auth.is_some(),
          "hasCredential": !api_key.is_empty() || matched_auth.is_some(),
          "authType": matched_auth.as_ref().and_then(|entry| entry.get("type")).and_then(Value::as_str).unwrap_or(""),
          "maskedApiKey": mask_secret(&api_key),
          "modelIds": model_ids,
        })
      }).collect::<Vec<_>>()
    })
    .unwrap_or_default();
  providers.sort_by(|left, right| {
    left.get("key").and_then(Value::as_str).unwrap_or("")
      .cmp(right.get("key").and_then(Value::as_str).unwrap_or(""))
  });

  let model = config.get("model").and_then(Value::as_str).unwrap_or("").trim().to_string();
  let small_model = config.get("small_model").and_then(Value::as_str).unwrap_or("").trim().to_string();
  let active_provider_key = open_code_provider_from_model(&model);
  let selected_provider_key = if !active_provider_key.is_empty() {
    active_provider_key.clone()
  } else {
    providers.first().and_then(|item| item.get("key")).and_then(Value::as_str).unwrap_or("").to_string()
  };
  let active_provider = providers.iter().find(|item| item.get("key").and_then(Value::as_str) == Some(selected_provider_key.as_str())).cloned();
  let active_auth = find_opencode_auth_entry(
    &auth_entries,
    &selected_provider_key,
    active_provider.as_ref().and_then(|item| item.get("baseUrl")).and_then(Value::as_str).unwrap_or(""),
  );

  Ok(json!({
    "toolId": "opencode",
    "scope": paths.scope,
    "rootPath": paths.root_path.to_string_lossy().to_string(),
    "configPath": paths.config_path.to_string_lossy().to_string(),
    "authPath": paths.auth_path.to_string_lossy().to_string(),
    "binary": binary,
    "configExists": !raw_config.trim().is_empty(),
    "authExists": !raw_auth.trim().is_empty(),
    "config": config,
    "configJson": if raw_config.trim().is_empty() { serde_json::to_string_pretty(&json!({})).unwrap_or_else(|_| "{}".to_string()) } else { raw_config },
    "model": model,
    "smallModel": small_model,
    "activeProviderKey": selected_provider_key,
    "activeProvider": active_provider,
    "activeAuth": active_auth,
    "authEntries": auth_entries,
    "providers": providers,
  }))
}

pub(crate) fn save_opencode_config(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let raw = get_string(&object, "configJson");
  if raw.trim().is_empty() {
    return Err("OpenCode 配置内容不能为空".to_string());
  }
  let _ = parse_jsonc_content(&raw)?;
  let paths = resolve_opencode_paths(body)?;
  write_text(&paths.config_path, &format!("{}\n", raw.trim_end()))?;
  Ok(json!({
    "saved": true,
    "scope": paths.scope,
    "configPath": paths.config_path.to_string_lossy().to_string(),
  }))
}

pub(crate) fn save_opencode_raw_config(body: &Value) -> Result<Value, String> {
  save_opencode_config(body)
}

pub(crate) fn start_opencode_install_task(body: &Value) -> Result<Value, String> {
  let obj = parse_json_object(body);
  let action = get_string(&obj, "action");
  let normalized_action = match action.trim() {
    "update" => "update",
    "reinstall" => "reinstall",
    "uninstall" => "uninstall",
    _ => "install",
  };
  let method = resolve_opencode_install_method(&get_string(&obj, "method"));
  let task = create_opencode_install_task(normalized_action, &method);
  let response = serde_json::to_value(&task).map_err(|error| error.to_string())?;
  insert_opencode_install_task(task.clone());
  spawn_opencode_install_task_runner(task.task_id.clone());
  Ok(response)
}

pub(crate) fn get_opencode_install_task(query: &Value) -> Result<Value, String> {
  let obj = parse_json_object(query);
  let task_id = obj.get("taskId").and_then(Value::as_str).unwrap_or("").trim();
  if task_id.is_empty() {
    return Err("OpenCode 任务不存在，可能已经过期，请重新开始".to_string());
  }
  let task = get_opencode_install_task_snapshot(task_id)
    .ok_or_else(|| "OpenCode 任务不存在，可能已经过期，请重新开始".to_string())?;
  serde_json::to_value(task).map_err(|error| error.to_string())
}

pub(crate) fn cancel_opencode_install_task(body: &Value) -> Result<Value, String> {
  let obj = parse_json_object(body);
  let task_id = obj.get("taskId").and_then(Value::as_str).unwrap_or("").trim();
  if task_id.is_empty() {
    return Err("OpenCode 任务不存在，可能已经过期，请重新开始".to_string());
  }
  cancel_opencode_install_task_inner(task_id)?;
  let task = get_opencode_install_task_snapshot(task_id)
    .ok_or_else(|| "OpenCode 任务不存在，可能已经过期，请重新开始".to_string())?;
  serde_json::to_value(task).map_err(|error| error.to_string())
}

pub(crate) fn install_opencode(body: &Value) -> Result<Value, String> {
  run_opencode_action("install", body)
}

pub(crate) fn reinstall_opencode(body: &Value) -> Result<Value, String> {
  run_opencode_action("reinstall", body)
}

pub(crate) fn update_opencode(body: &Value) -> Result<Value, String> {
  run_opencode_action("update", body)
}

pub(crate) fn uninstall_opencode(body: &Value) -> Result<Value, String> {
  run_opencode_action("uninstall", body)
}

pub(crate) fn launch_opencode(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let cwd = {
    let input = get_string(&object, "cwd");
    if input.is_empty() { home_dir()? } else { PathBuf::from(input) }
  };
  let binary = find_tool_binary("opencode");
  if !binary.get("installed").and_then(Value::as_bool).unwrap_or(false) {
    return Err("OpenCode 尚未安装，请先点击安装".to_string());
  }
  let bin_path = binary.get("path").and_then(Value::as_str).unwrap_or("opencode");
  let message = launch_terminal_for_tool(&cwd, bin_path, "OpenCode", "opencode")?;
  Ok(json!({ "ok": true, "cwd": cwd.to_string_lossy().to_string(), "message": message }))
}

pub(crate) fn login_opencode(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let cwd = {
    let input = get_string(&object, "cwd");
    if input.is_empty() { home_dir()? } else { PathBuf::from(input) }
  };
  let binary = find_tool_binary("opencode");
  if !binary.get("installed").and_then(Value::as_bool).unwrap_or(false) {
    return Err("OpenCode 尚未安装，请先点击安装".to_string());
  }
  let binary_path = binary
    .get("path")
    .and_then(Value::as_str)
    .filter(|text| !text.trim().is_empty())
    .unwrap_or("opencode");
  let provider = get_string(&object, "provider");
  let method = get_string(&object, "method");
  let mut args = vec!["auth".to_string(), "login".to_string()];
  if !provider.trim().is_empty() {
    args.push("--provider".to_string());
    args.push(provider.trim().to_string());
  }
  if !method.trim().is_empty() {
    args.push("--method".to_string());
    args.push(method.trim().to_string());
  }
  let command = if cfg!(target_os = "windows") {
    build_windows_binary_command(binary_path, &args, "opencode")
  } else {
    let mut parts = vec![quote_posix_shell_arg(binary_path), "auth".to_string(), "login".to_string()];
    if !provider.trim().is_empty() {
      parts.push("--provider".to_string());
      parts.push(quote_posix_shell_arg(provider.trim()));
    }
    if !method.trim().is_empty() {
      parts.push("--method".to_string());
      parts.push(quote_posix_shell_arg(method.trim()));
    }
    parts.join(" ")
  };
  let message = launch_terminal_command(&cwd, &command, "OpenCode 登录")?;
  Ok(json!({ "ok": true, "cwd": cwd.to_string_lossy().to_string(), "message": message }))
}

pub(crate) fn remove_opencode_auth(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let provider = normalize_opencode_auth_entry_key(&get_string(&object, "provider"));
  if provider.is_empty() {
    return Err("请先指定要移除的 OpenCode 凭证".to_string());
  }
  let paths = resolve_opencode_paths(body)?;
  let raw_auth = read_text(&paths.auth_path)?;
  let mut auth_json = parse_opencode_auth_json(&raw_auth)?;
  if let Some(auth_object) = auth_json.as_object_mut() {
    auth_object.remove(&provider);
    auth_object.remove(&format!("{}/", provider));
  }
  write_json_file(&paths.auth_path, &auth_json)?;
  Ok(json!({
    "removed": true,
    "provider": provider,
    "authPath": paths.auth_path.to_string_lossy().to_string(),
  }))
}

/* ═══════════════  OpenClaw  ═══════════════ */

pub(crate) fn load_openclaw_state() -> Result<Value, String> {
  let home = openclaw_home()?;
  let config_path = home.join("openclaw.json");
  let binary = find_tool_binary_with_options("openclaw", cfg!(target_os = "windows"));

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
  let (gateway_http_ready, gateway_port_listening) = probe_openclaw_gateway(&gateway_url);
  let gateway_port_occupants = if cfg!(target_os = "windows") {
    Vec::new()
  } else {
    inspect_openclaw_port_occupants(&gateway_port)
  };
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
    "gatewayReachable": gateway_http_ready,
    "gatewayHttpReady": gateway_http_ready,
    "gatewayPortListening": gateway_port_listening,
    "gatewayStatus": if gateway_http_ready { "online" } else if gateway_port_listening { "warming" } else { "offline" },
    "gatewayPortOccupants": gateway_port_occupants.clone(),
    "gatewayPortConflict": gateway_port_occupants.iter().any(|item| !item.get("likelyOpenClaw").and_then(Value::as_bool).unwrap_or(false)),
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
  normalize_openclaw_dashboard_bootstrap_url(url.as_ref(), gateway_token)
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
  let token = state.get("gatewayToken").and_then(Value::as_str).unwrap_or("");
  let url = normalize_openclaw_dashboard_bootstrap_url(&extract_url_from_text(&merged).unwrap_or_else(|| fallback.to_string()), token);
  Ok(json!({ "ok": !url.is_empty(), "url": url, "stdout": stdout.trim(), "stderr": stderr.trim(), "command": format!("{} dashboard --no-open", bin_path) }))
}

pub(crate) fn repair_openclaw_dashboard_auth(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let cwd = {
    let input = object.get("cwd").and_then(Value::as_str).unwrap_or("").to_string();
    if input.is_empty() { home_dir()? } else { PathBuf::from(input) }
  };
  let mut state = load_openclaw_state()?;
  let binary = state.get("binary").cloned().unwrap_or_else(|| json!({}));
  if !binary.get("installed").and_then(Value::as_bool).unwrap_or(false) {
    return Err("OpenClaw 尚未安装".to_string());
  }
  let bin_path = binary.get("path").and_then(Value::as_str).unwrap_or("openclaw").to_string();
  std::env::set_var("PATH", full_path_env());
  let mut notes: Vec<String> = Vec::new();
  let mut token_generated = false;
  let mut restart_required = false;

  let gateway_auth_mode = state.get("gatewayAuthMode").and_then(Value::as_str).unwrap_or("token").to_string();
  let mut gateway_token = state.get("gatewayToken").and_then(Value::as_str).unwrap_or("").to_string();
  if gateway_auth_mode == "token" && gateway_token.is_empty() {
    let doctor = create_command(&bin_path)
      .args(["doctor", "--generate-gateway-token"])
      .current_dir(&cwd)
      .output();
    if let Ok(out) = doctor {
      let stdout = String::from_utf8_lossy(&out.stdout).to_string();
      let stderr = String::from_utf8_lossy(&out.stderr).to_string();
      notes.push(format!("doctor: {}", format!("{}\n{}", stdout.trim(), stderr.trim()).trim()));
    }
    state = load_openclaw_state()?;
    gateway_token = state.get("gatewayToken").and_then(Value::as_str).unwrap_or("").to_string();
    if !gateway_token.is_empty() {
      token_generated = true;
      restart_required = state.get("gatewayReachable").and_then(Value::as_bool).unwrap_or(false)
        || state.get("gatewayPortListening").and_then(Value::as_bool).unwrap_or(false);
    }
  }

  let config_get = create_command(&bin_path)
    .args(["config", "get", "gateway.auth.token"])
    .current_dir(&cwd)
    .output();
  if let Ok(out) = config_get {
    let merged = format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if gateway_token.is_empty() {
      gateway_token = extract_openclaw_gateway_token(&merged).unwrap_or_default();
    }
  }

  if gateway_auth_mode == "token" && gateway_token.is_empty() {
    return Err("Gateway token 仍未就绪，请检查 `openclaw config get gateway.auth.token` 或 `openclaw doctor --generate-gateway-token` 输出".to_string());
  }

  if restart_required {
    let _ = stop_openclaw_gateway();
    std::thread::sleep(Duration::from_millis(800));
  }

  let mut launch = Value::Null;
  state = load_openclaw_state()?;
  if restart_required || (!state.get("gatewayReachable").and_then(Value::as_bool).unwrap_or(false)
    && !state.get("gatewayPortListening").and_then(Value::as_bool).unwrap_or(false)) {
    launch = launch_openclaw(&json!({ "cwd": cwd.to_string_lossy().to_string() }))?;
  } else if state.get("gatewayPortListening").and_then(Value::as_bool).unwrap_or(false)
    && !state.get("gatewayReachable").and_then(Value::as_bool).unwrap_or(false) {
    notes.push("Gateway 端口已监听，正在等待 HTTP 控制面板就绪".to_string());
  }

  if !state.get("gatewayReachable").and_then(Value::as_bool).unwrap_or(false) {
    for _ in 0..30 {
      std::thread::sleep(Duration::from_millis(1000));
      state = load_openclaw_state()?;
      if state.get("gatewayReachable").and_then(Value::as_bool).unwrap_or(false) {
        break;
      }
    }
  }

  let dashboard = get_openclaw_dashboard_url(&json!({ "cwd": cwd.to_string_lossy().to_string() }))?;
  let dashboard_url = normalize_openclaw_dashboard_bootstrap_url(
    dashboard.get("url").and_then(Value::as_str).unwrap_or_else(|| state.get("dashboardUrl").and_then(Value::as_str).unwrap_or("")),
    &gateway_token,
  );
  Ok(json!({
    "ok": true,
    "tokenGenerated": token_generated,
    "restartRequired": restart_required,
    "gatewayReachable": state.get("gatewayReachable").cloned().unwrap_or(Value::Bool(false)),
    "gatewayHttpReady": state.get("gatewayHttpReady").cloned().unwrap_or(Value::Bool(false)),
    "gatewayPortListening": state.get("gatewayPortListening").cloned().unwrap_or(Value::Bool(false)),
    "gatewayStatus": state.get("gatewayStatus").cloned().unwrap_or(json!("offline")),
    "gatewayUrl": state.get("gatewayUrl").cloned().unwrap_or(Value::Null),
    "gatewayToken": if gateway_token.is_empty() { Value::Null } else { json!(gateway_token) },
    "dashboardUrl": dashboard_url,
    "launch": launch,
    "notes": notes,
  }))
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

  if state.get("gatewayPortListening").and_then(Value::as_bool).unwrap_or(false) {
    return Ok(json!({
      "ok": true,
      "cwd": cwd.to_string_lossy().to_string(),
      "mode": "warming",
      "gatewayUrl": state.get("gatewayUrl").cloned().unwrap_or(Value::Null),
      "command": "",
      "background": true,
      "message": "OpenClaw Gateway 正在启动，稍后会自动就绪",
    }));
  }

  let bin_path = binary.get("path").and_then(Value::as_str).unwrap_or("openclaw");
  let command = if cfg!(target_os = "windows") {
    build_windows_binary_command(bin_path, &["gateway".to_string(), "--force".to_string()], "openclaw")
  } else {
    format!("{} gateway --force", bin_path)
  };
  #[cfg(target_os = "windows")]
  {
    let message = launch_windows_background_command(&cwd, &command, "OpenClaw Gateway")?;
    return Ok(json!({
      "ok": true,
      "cwd": cwd.to_string_lossy().to_string(),
      "mode": "gateway",
      "gatewayUrl": state.get("gatewayUrl").cloned().unwrap_or(Value::Null),
      "command": command,
      "message": message,
      "background": true,
    }));
  }
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

  let state = load_openclaw_state()?;
  let gateway_port = state.get("gatewayPort").and_then(Value::as_str).unwrap_or("18789").to_string();
  let mut methods: Vec<String> = Vec::new();
  let mut attempted = false;

  // Try `openclaw gateway stop` first
  let bin = which::which("openclaw").ok();
  if let Some(ref bin_path) = bin {
    let output = create_command(bin_path.to_str().unwrap_or("openclaw"))
      .args(["gateway", "stop"])
      .output();
    if let Ok(out) = output {
      if out.status.success() {
        attempted = true;
        methods.push("gateway stop".to_string());
      }
    }
  }

  if cfg!(target_os = "windows") {
    let netstat_output = create_command("netstat").args(["-ano", "-p", "tcp"]).output();
    if let Ok(output) = netstat_output {
      let stdout = String::from_utf8_lossy(&output.stdout);
      let mut seen = HashSet::new();
      for line in stdout.lines() {
        let text = line.trim();
        if !text.contains("LISTENING") { continue; }
        let parts = text.split_whitespace().collect::<Vec<_>>();
        if parts.len() < 5 { continue; }
        let local_addr = parts[1];
        let pid = parts[4];
        if !local_addr.ends_with(&format!(":{}", gateway_port)) || !seen.insert(pid.to_string()) {
          continue;
        }
        if create_command("taskkill").args(["/F", "/T", "/PID", pid]).output().map(|out| out.status.success()).unwrap_or(false) {
          attempted = true;
          methods.push(format!("taskkill pid {}", pid));
        }
      }
    }

    if !attempted
      && create_command("taskkill").args(["/F", "/T", "/IM", "openclaw.exe"]).output().map(|out| out.status.success()).unwrap_or(false) {
      attempted = true;
      methods.push("taskkill openclaw.exe".to_string());
    }
  } else if Command::new("pkill").args(["-f", "openclaw.*gateway"]).output().map(|out| out.status.success()).unwrap_or(false) {
    attempted = true;
    methods.push("pkill openclaw.*gateway".to_string());
  }

  thread::sleep(Duration::from_millis(900));
  let after = load_openclaw_state()?;
  if !after.get("gatewayReachable").and_then(Value::as_bool).unwrap_or(false)
    && !after.get("gatewayPortListening").and_then(Value::as_bool).unwrap_or(false) {
    let method_text = if methods.is_empty() { "none".to_string() } else { methods.join(" -> ") };
    return Ok(json!({
      "stopped": true,
      "method": method_text,
      "gatewayReachable": false,
      "gatewayUrl": after.get("gatewayUrl").cloned().unwrap_or(Value::Null),
    }));
  }

  if attempted {
    return Err("OpenClaw Gateway 仍在运行，请手动检查 Windows 后台进程".to_string());
  }

  Ok(json!({ "stopped": false, "message": "未找到运行中的 OpenClaw 进程" }))
}

pub(crate) fn kill_openclaw_port_occupants(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let target_pid = object.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32;
  let state = load_openclaw_state()?;
  let occupants = state.get("gatewayPortOccupants").and_then(Value::as_array).cloned().unwrap_or_default();
  let selected = occupants.into_iter().filter(|item| {
    let pid = item.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32;
    target_pid == 0 || pid == target_pid
  }).collect::<Vec<_>>();

  if selected.is_empty() {
    return Ok(json!({
      "ok": true,
      "killed": [],
      "message": format!("未检测到 {} 端口占用进程", state.get("gatewayPort").and_then(Value::as_str).unwrap_or("18789")),
    }));
  }

  let mut killed: Vec<Value> = Vec::new();
  let mut failed: Vec<Value> = Vec::new();
  for item in selected {
    let pid = item.get("pid").and_then(Value::as_u64).unwrap_or(0).to_string();
    let ok = if cfg!(target_os = "windows") {
      create_command("taskkill").args(["/F", "/T", "/PID", &pid]).output().map(|out| out.status.success()).unwrap_or(false)
    } else {
      Command::new("kill").args(["-9", &pid]).output().map(|out| out.status.success()).unwrap_or(false)
    };
    if ok { killed.push(item); } else { failed.push(item); }
  }

  let after = load_openclaw_state()?;
  Ok(json!({
    "ok": failed.is_empty(),
    "killed": killed,
    "failed": failed,
    "gatewayPort": after.get("gatewayPort").cloned().unwrap_or(json!("18789")),
    "gatewayUrl": after.get("gatewayUrl").cloned().unwrap_or(Value::Null),
    "gatewayStatus": after.get("gatewayStatus").cloned().unwrap_or(json!("offline")),
    "gatewayPortOccupants": after.get("gatewayPortOccupants").cloned().unwrap_or(json!([])),
    "message": if failed.is_empty() { "端口占用进程已结束" } else { "部分端口占用进程结束失败" },
  }))
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
