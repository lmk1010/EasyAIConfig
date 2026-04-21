// Lightweight process listing for the console page.
//
// Lists OS processes whose command line contains a given needle (e.g. "codex"
// or "claude"), with CPU / memory / elapsed-time metrics. Read-only; we never
// expose a "kill" endpoint — users should use their OS tools for that.
//
// Platform notes:
// - macOS / Linux: shell out to `ps -axo pid,pcpu,pmem,etime,command` which
//   is present on every POSIX host we care about.
// - Windows: `tasklist /fo csv /v` has CPU time + memory but not %CPU. We do a
//   best-effort extraction there; %CPU will read as blank.

use serde_json::{json, Value};

use crate::parse_json_object;
use crate::provider::get_string;

// Does this `ps` line really represent the tool we're looking for?
//
// Naïve substring match is wrong: the user's own repo path ("codex-config-ui")
// contains "codex", our Tauri dev build is typically launched from that path,
// and any shell with the project as cwd will match too. We need a stricter
// check: look at the command binary's basename (or the script filename, for
// node-wrapped CLIs like Claude Code).
fn filter_matches(line: &str, needle: &str, self_pid: u32) -> bool {
  let raw = line.trim_start();
  if raw.is_empty() { return false; }

  // Early reject: our own things.
  let lower = raw.to_ascii_lowercase();
  if lower.contains("grep ") || lower.starts_with("grep") { return false; }
  if lower.contains("easy_ai_config") { return false; }
  if lower.contains("easyaiconfig") { return false; }
  if lower.contains("codex-config-ui") { return false; }   // our dev repo path
  if lower.contains("config-editor") { return false; }      // our sub-dirs

  // Column layout from ps -axo pid,pcpu,pmem,etime,command is:
  //   <pid>  <cpu>  <mem>  <etime>  <command...>
  let parts: Vec<&str> = raw.split_whitespace().collect();
  if parts.len() < 5 { return false; }
  let pid: u32 = parts[0].parse().unwrap_or(0);
  if pid > 0 && pid == self_pid { return false; }

  let cmd_argv0 = parts[4];
  let basename = cmd_argv0.rsplit('/').next().unwrap_or(cmd_argv0).to_ascii_lowercase();
  let needle_l = needle.to_ascii_lowercase();

  // Case 1: the binary's basename IS the needle (e.g. `/usr/local/bin/codex`).
  if basename == needle_l { return true; }

  // Case 2: node / bun / deno / npx wrapper invoking a JS CLI. The needle
  // should then appear as a path segment OR filename later in argv.
  let is_interp = matches!(basename.as_str(), "node" | "bun" | "deno" | "npx" | "pnpm" | "yarn");
  if is_interp {
    let rest = parts[5..].join(" ");
    let rest_l = rest.to_ascii_lowercase();
    // Match the canonical install paths / package names.
    let codex_markers = ["@openai/codex", "openai-codex", "/codex/bin/", "/codex.js", "/codex-cli"];
    let claude_markers = ["@anthropic-ai/claude", "claude-code", "/claude/bin/", "/cli.js"];
    let opencode_markers = ["opencode-ai", "/opencode/bin/", "opencode.js"];
    let openclaw_markers = ["openclaw", "/openclaw/bin/"];
    let markers: &[&str] = match needle_l.as_str() {
      "codex" => &codex_markers,
      "claude" | "claudecode" => &claude_markers,
      "opencode" => &opencode_markers,
      "openclaw" => &openclaw_markers,
      _ => &[],
    };
    if markers.iter().any(|m| rest_l.contains(m)) { return true; }
    return false;
  }

  // Case 3: binary basename starts with the needle (e.g. `codex-rpc`), but NOT
  // when it's a parent-path collision (e.g. "node_modules/foo/bar/codex-..." —
  // we've already exited through Case 2 if it's node-wrapped).
  basename.starts_with(&needle_l)
}

#[cfg(not(target_os = "windows"))]
fn list_posix(needle: &str) -> Vec<Value> {
  use std::process::Command;
  let self_pid = std::process::id();
  let out = match Command::new("ps")
    .args(["-axo", "pid,pcpu,pmem,etime,command"])
    .output()
  {
    Ok(o) => o,
    Err(_) => return Vec::new(),
  };
  if !out.status.success() { return Vec::new(); }
  let text = String::from_utf8_lossy(&out.stdout);

  let mut rows = Vec::new();
  let mut first = true;
  for line in text.lines() {
    if first { first = false; continue; } // header
    let raw = line.trim_start();
    if !filter_matches(raw, needle, self_pid) { continue; }

    // Split into 5 columns: pid, cpu, mem, etime, command (command can have spaces)
    let mut parts = raw.splitn(5, char::is_whitespace).collect::<Vec<_>>();
    // splitn with char::is_whitespace leaves empty strings for runs; collapse:
    parts.retain(|p| !p.is_empty());
    if parts.len() < 5 {
      // Fallback: try 5-way split on runs of whitespace
      let s: Vec<&str> = raw.split_whitespace().collect();
      if s.len() < 5 { continue; }
      let pid: u64 = s[0].parse().unwrap_or(0);
      let cpu: f64 = s[1].parse().unwrap_or(0.0);
      let mem: f64 = s[2].parse().unwrap_or(0.0);
      let etime = s[3].to_string();
      let command = s[4..].join(" ");
      rows.push(json!({
        "pid": pid,
        "cpu": cpu,
        "memPct": mem,
        "elapsed": etime,
        "command": command,
      }));
      continue;
    }
    let pid: u64 = parts[0].parse().unwrap_or(0);
    let cpu: f64 = parts[1].parse().unwrap_or(0.0);
    let mem: f64 = parts[2].parse().unwrap_or(0.0);
    let etime = parts[3].to_string();
    let command = parts[4].trim().to_string();
    rows.push(json!({
      "pid": pid,
      "cpu": cpu,
      "memPct": mem,
      "elapsed": etime,
      "command": command,
    }));
  }

  enrich_with_cwd_and_mem(rows)
}

#[cfg(target_os = "windows")]
fn list_posix(_needle: &str) -> Vec<Value> { Vec::new() }

// Upgrade each row with absolute memory (MB) and cwd when cheaply available.
#[cfg(target_os = "macos")]
fn enrich_with_cwd_and_mem(rows: Vec<Value>) -> Vec<Value> {
  use std::process::Command;
  rows.into_iter().map(|mut row| {
    let pid = row.get("pid").and_then(Value::as_u64).unwrap_or(0);
    if pid == 0 { return row; }

    // RSS in KB via ps (one call per pid is slower but still O(n) for n small)
    if let Ok(out) = Command::new("ps").args(["-o", "rss=", "-p", &pid.to_string()]).output() {
      if out.status.success() {
        let rss_kb: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0);
        if rss_kb > 0 {
          if let Some(obj) = row.as_object_mut() {
            obj.insert("memMB".to_string(), json!(rss_kb / 1024));
          }
        }
      }
    }

    // cwd via lsof (reasonably fast, one subprocess per pid; keep it best-effort)
    if let Ok(out) = Command::new("lsof")
      .args(["-a", "-Fn", "-d", "cwd", "-p", &pid.to_string()])
      .output()
    {
      if out.status.success() {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
          if let Some(rest) = line.strip_prefix('n') {
            if let Some(obj) = row.as_object_mut() {
              obj.insert("cwd".to_string(), json!(rest.to_string()));
            }
            break;
          }
        }
      }
    }
    row
  }).collect()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn enrich_with_cwd_and_mem(rows: Vec<Value>) -> Vec<Value> {
  use std::fs;
  rows.into_iter().map(|mut row| {
    let pid = row.get("pid").and_then(Value::as_u64).unwrap_or(0);
    if pid == 0 { return row; }

    if let Ok(status) = fs::read_to_string(format!("/proc/{}/status", pid)) {
      for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
          let kb: u64 = rest.split_whitespace().next().unwrap_or("0").parse().unwrap_or(0);
          if kb > 0 {
            if let Some(obj) = row.as_object_mut() {
              obj.insert("memMB".to_string(), json!(kb / 1024));
            }
          }
          break;
        }
      }
    }
    if let Ok(link) = fs::read_link(format!("/proc/{}/cwd", pid)) {
      if let Some(obj) = row.as_object_mut() {
        obj.insert("cwd".to_string(), json!(link.to_string_lossy().to_string()));
      }
    }
    row
  }).collect()
}

#[cfg(target_os = "windows")]
fn enrich_with_cwd_and_mem(rows: Vec<Value>) -> Vec<Value> { rows }

#[cfg(target_os = "windows")]
fn list_windows(needle: &str) -> Vec<Value> {
  use std::process::Command;
  let self_pid = std::process::id();
  let out = match Command::new("tasklist")
    .args(["/fo", "csv", "/nh"])
    .output()
  {
    Ok(o) => o,
    Err(_) => return Vec::new(),
  };
  if !out.status.success() { return Vec::new(); }
  let text = String::from_utf8_lossy(&out.stdout);
  let needle_l = needle.to_ascii_lowercase();
  let mut rows = Vec::new();
  for line in text.lines() {
    let lower = line.to_ascii_lowercase();
    if !lower.contains(&needle_l) { continue; }
    if lower.contains("easy_ai_config") || lower.contains("easyaiconfig") { continue; }
    // CSV fields: "ImageName","PID","SessionName","Session#","MemUsage"
    let parts: Vec<String> = line
      .split("\",\"")
      .map(|s| s.trim_matches('"').to_string())
      .collect();
    if parts.len() < 5 { continue; }
    let pid: u64 = parts[1].parse().unwrap_or(0);
    if pid == self_pid as u64 { continue; }
    let mem_pretty = parts[4].replace(",", "").replace(" K", "").trim().to_string();
    let mem_kb: u64 = mem_pretty.parse().unwrap_or(0);
    rows.push(json!({
      "pid": pid,
      "cpu": 0.0,
      "memPct": 0.0,
      "memMB": mem_kb / 1024,
      "elapsed": "",
      "command": parts[0],
    }));
  }
  rows
}

// Kill a process by PID. Refuses to touch our own PID or PID 1. Accepts an
// optional `signal` field; defaults to SIGTERM (graceful). Frontend offers a
// confirm() before calling.
pub(crate) fn kill_process(body: &Value) -> Result<Value, String> {
  let obj = parse_json_object(body);
  let pid_u64 = obj.get("pid").and_then(Value::as_u64).unwrap_or(0);
  if pid_u64 == 0 { return Err("pid 必填".to_string()); }
  let pid_u32: u32 = pid_u64.try_into().map_err(|_| "pid 越界".to_string())?;
  if pid_u32 == std::process::id() { return Err("不能结束自己".to_string()); }
  if pid_u32 == 1 { return Err("不能结束 init 进程".to_string()); }

  let signal = get_string(&obj, "signal");
  let signal = if signal.is_empty() { "TERM".to_string() } else { signal };
  // Allowlist: TERM / INT / KILL only. Anything else is user mistake.
  if !matches!(signal.as_str(), "TERM" | "INT" | "KILL") {
    return Err(format!("不支持的信号: {}", signal));
  }

  #[cfg(not(target_os = "windows"))]
  {
    use std::process::Command;
    let out = Command::new("kill")
      .args([&format!("-{}", signal), &pid_u32.to_string()])
      .output()
      .map_err(|e| format!("kill 调用失败: {}", e))?;
    if !out.status.success() {
      let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
      return Err(if err.is_empty() { format!("kill 退出码 {}", out.status) } else { err });
    }
  }
  #[cfg(target_os = "windows")]
  {
    use std::process::Command;
    let flag = if signal == "KILL" { "/F" } else { "" };
    let mut args = vec!["/PID".to_string(), pid_u32.to_string()];
    if !flag.is_empty() { args.insert(0, flag.to_string()); }
    let out = Command::new("taskkill").args(&args).output().map_err(|e| format!("taskkill 调用失败: {}", e))?;
    if !out.status.success() {
      let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
      return Err(if err.is_empty() { format!("taskkill 退出码 {}", out.status) } else { err });
    }
  }

  Ok(json!({ "ok": true, "pid": pid_u32, "signal": signal }))
}

pub(crate) fn list_processes(query: &Value) -> Result<Value, String> {
  let obj = parse_json_object(query);
  let needle = get_string(&obj, "needle");
  let tool = get_string(&obj, "tool");

  // Map a known tool name to a safe needle. Unknown tools require an explicit
  // needle; we never accept arbitrary user strings without scrubbing.
  let effective_needle = if !needle.is_empty() {
    // Limit to alnum + dash to avoid shell surprises (even though we don't use a shell).
    let ok = needle.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !ok { return Err("needle 仅允许字母数字 / - / _".to_string()); }
    needle
  } else {
    match tool.as_str() {
      "codex" => "codex".to_string(),
      "claudecode" | "claude" => "claude".to_string(),
      "opencode" => "opencode".to_string(),
      "openclaw" => "openclaw".to_string(),
      _ => return Err("需要 tool 或 needle 参数".to_string()),
    }
  };

  let rows = if cfg!(target_os = "windows") {
    #[cfg(target_os = "windows")]
    { list_windows(&effective_needle) }
    #[cfg(not(target_os = "windows"))]
    { Vec::new() }
  } else {
    list_posix(&effective_needle)
  };

  Ok(json!({
    "tool": tool,
    "needle": effective_needle,
    "rows": rows,
  }))
}
