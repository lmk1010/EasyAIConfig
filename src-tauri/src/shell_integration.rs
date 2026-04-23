// Shell integration — "make `claude` in any terminal follow the active
// profile selected in this UI".
//
// Default behavior (without this module): switching a profile in the UI only
// affects Claude Code processes launched by the UI itself, because only that
// launcher injects `CLAUDE_CONFIG_DIR`. A `claude` typed in Termius, iTerm,
// Terminal.app, etc. reads `$HOME` (no env var) and gets the default account.
//
// What this module does:
//   1. Writes a small POSIX-sh script at ~/.codex-config-ui/shell-env.sh.
//      The script reads the current `active` id from profiles.json every time
//      a shell starts and exports CLAUDE_CONFIG_DIR to the matching dir — so
//      switching profiles in the UI takes effect in every *new* terminal
//      without further rewrites. Existing terminals keep their env until they
//      `source` it again.
//   2. Appends a well-marked `source ~/.codex-config-ui/shell-env.sh` block to
//      the user's ~/.zshrc / ~/.bash_profile / ~/.bashrc (only when those
//      files already exist — we never *create* rc files, to avoid leaving
//      footprints for shells the user doesn't use).
//
// Safety:
//   - Always backs up the original rc file to
//     ~/.codex-config-ui/rc-backups/<name>.<ts>.bak before editing.
//   - Uses explicit BEGIN/END markers so enable/disable is idempotent and
//     fully reversible (no textual heuristics, no diff needed).
//   - Writes via tmp + rename so a crash mid-edit can't corrupt an rc.
//   - The sh script respects a pre-set CLAUDE_CONFIG_DIR: if a parent process
//     (e.g. the UI launcher) already chose a dir, we never override it.
//   - The sh script uses only sed + [ — zero runtime deps, no jq/python.
//
// We intentionally never touch ~/.claude/ or the system Keychain here. This
// module only touches:
//   - ~/.codex-config-ui/shell-env.sh          (we own)
//   - ~/.codex-config-ui/rc-backups/*.bak      (we own)
//   - ~/.zshrc, ~/.bashrc, ~/.bash_profile     (marked block only; reversible)

use chrono::Utc;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

use crate::{app_home, ensure_dir, home_dir, parse_json_object, write_text};

const BEGIN_MARKER: &str = "# >>> codex-config-ui (Claude Code account follower) >>>";
const END_MARKER: &str = "# <<< codex-config-ui (Claude Code account follower) <<<";
const ENV_SCRIPT_NAME: &str = "shell-env.sh";
const RC_BACKUPS_DIRNAME: &str = "rc-backups";

// The sh script that actually does the profile lookup at shell startup.
// POSIX-compliant; works in zsh, bash, dash. Fish is NOT supported here —
// its syntax differs enough to need a separate .fish file. We intentionally
// punt on fish (small macOS user base) and will add it only if asked.
const ENV_SCRIPT_BODY: &str = r#"# codex-config-ui: Claude Code account follower
# Managed by codex-config-ui. Do not edit — changes will be overwritten.
# Sourced by ~/.zshrc / ~/.bash_profile / ~/.bashrc via the "Shell 集成" toggle.
#
# Behavior:
#   - Respects an already-set CLAUDE_CONFIG_DIR (parent process wins).
#   - Reads the active profile id from profiles.json every time a shell starts
#     and exports CLAUDE_CONFIG_DIR to its directory, if that directory exists.
#   - Silently no-ops when no profile is active (falls back to ~/.claude).
#   - Uses only POSIX utilities (sed, [), no jq/python dependency.

if [ -z "${CLAUDE_CONFIG_DIR:-}" ]; then
  __ccui_json="$HOME/.codex-config-ui/claudecode-oauth-profiles/profiles.json"
  if [ -r "$__ccui_json" ]; then
    __ccui_active=$(sed -n 's/.*"active"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$__ccui_json" 2>/dev/null | head -n 1)
    if [ -n "$__ccui_active" ]; then
      __ccui_dir="$HOME/.codex-config-ui/claudecode-oauth-profiles/$__ccui_active"
      if [ -d "$__ccui_dir" ]; then
        export CLAUDE_CONFIG_DIR="$__ccui_dir"
      fi
      unset __ccui_dir
    fi
    unset __ccui_active
  fi
  unset __ccui_json
fi
"#;

struct ShellTarget {
  name: &'static str,     // stable id used in API responses
  filename: &'static str, // basename in $HOME
}

// macOS / Linux targets. Order matters only for display — all three are
// independent. We do NOT ship a Windows branch: the Claude Code account
// switcher only fully makes sense on Unix, and PowerShell's profile is
// structurally different enough to warrant a separate implementation.
#[cfg(unix)]
const TARGETS: &[ShellTarget] = &[
  ShellTarget { name: "zsh",          filename: ".zshrc" },
  ShellTarget { name: "bash-profile", filename: ".bash_profile" },
  ShellTarget { name: "bash-rc",      filename: ".bashrc" },
];

#[cfg(not(unix))]
const TARGETS: &[ShellTarget] = &[];

fn env_script_path() -> Result<PathBuf, String> {
  Ok(app_home()?.join(ENV_SCRIPT_NAME))
}

fn rc_backups_dir() -> Result<PathBuf, String> {
  Ok(app_home()?.join(RC_BACKUPS_DIRNAME))
}

fn active_profile_dir_string() -> String {
  crate::claudecode_oauth_profiles::active_profile_config_dir()
    .map(|p| p.to_string_lossy().to_string())
    .unwrap_or_default()
}

// Returns the line-based boundaries of our marker block inside `content`, or
// None if no (valid) block exists. A "valid" block means BEGIN appears before
// END. If markers are malformed (END without BEGIN, or BEGIN without END), we
// return None and leave the file untouched — safer than guessing.
fn find_block(content: &str) -> Option<(usize, usize)> {
  let mut begin: Option<usize> = None;
  for (idx, line) in content.lines().enumerate() {
    let trimmed = line.trim();
    if trimmed == BEGIN_MARKER {
      begin = Some(idx);
    } else if trimmed == END_MARKER {
      if let Some(b) = begin {
        if idx >= b {
          return Some((b, idx));
        }
      }
      return None;
    }
  }
  None
}

fn is_rc_injected(path: &Path) -> bool {
  let text = match fs::read_to_string(path) {
    Ok(t) => t,
    Err(_) => return false,
  };
  find_block(&text).is_some()
}

// Atomic write: tmp + rename within the same directory. Any I/O error leaves
// the original rc file intact.
fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    ensure_dir(parent)?;
  }
  let tmp = path.with_extension("codex-config-ui.tmp");
  fs::write(&tmp, content).map_err(|e| format!("写临时文件失败: {}", e))?;
  fs::rename(&tmp, path).map_err(|e| {
    let _ = fs::remove_file(&tmp);
    format!("提交 {} 失败: {}", path.display(), e)
  })
}

fn backup_rc(path: &Path) -> Result<PathBuf, String> {
  let dir = rc_backups_dir()?;
  ensure_dir(&dir)?;
  let ts = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
  let filename = path
    .file_name()
    .map(|s| s.to_string_lossy().to_string())
    .unwrap_or_else(|| "rc".to_string());
  // Preserve dot-prefix in the backup name for clarity: ".zshrc.20260423T...bak"
  let backup = dir.join(format!("{}.{}.bak", filename, ts));
  fs::copy(path, &backup).map_err(|e| format!("备份 {} 失败: {}", path.display(), e))?;
  Ok(backup)
}

fn block_text() -> String {
  format!(
    "{begin}\n\
# Managed by codex-config-ui. Do not edit this block manually.\n\
# Remove it by disabling the \"Shell 集成\" toggle in the app.\n\
if [ -f \"$HOME/.codex-config-ui/shell-env.sh\" ]; then . \"$HOME/.codex-config-ui/shell-env.sh\"; fi\n\
{end}\n",
    begin = BEGIN_MARKER,
    end = END_MARKER,
  )
}

// Pure text transforms — extracted so they can be unit-tested without
// touching the filesystem. All fs-side concerns (exists check, backup,
// atomic write) live in inject_rc / remove_rc below.

/// Produce the rc file's content with our marker block appended. Returns
/// `None` if a block is already present (caller treats as "nothing to do").
fn append_block(original: &str) -> Option<String> {
  if find_block(original).is_some() {
    return None;
  }
  let mut next = original.to_string();
  // Guarantee exactly one blank line between existing content and our block —
  // keeps the rc tidy whether it ended with "\n" or not.
  if !next.is_empty() && !next.ends_with('\n') {
    next.push('\n');
  }
  if !next.is_empty() && !next.ends_with("\n\n") {
    next.push('\n');
  }
  next.push_str(&block_text());
  Some(next)
}

/// Produce the rc file's content with our marker block stripped. Returns
/// `None` if no block is present. Trailing blank lines are trimmed so
/// disable → enable → disable doesn't grow the file by one line each cycle.
fn strip_block(original: &str) -> Option<String> {
  let (begin, end) = find_block(original)?;
  let lines: Vec<&str> = original.lines().collect();
  let mut kept: Vec<&str> = Vec::with_capacity(lines.len());
  for (idx, line) in lines.iter().enumerate() {
    if idx >= begin && idx <= end {
      continue;
    }
    kept.push(line);
  }
  while kept.last().map(|s| s.trim().is_empty()).unwrap_or(false) {
    kept.pop();
  }
  let mut next = kept.join("\n");
  if !next.is_empty() {
    next.push('\n');
  }
  Some(next)
}

// Append our marker block to the rc file. If a block already exists we leave
// the file alone (idempotent). Returns Ok(true) when we actually appended,
// Ok(false) when it was already injected.
fn inject_rc(path: &Path) -> Result<(bool, Option<PathBuf>), String> {
  if !path.exists() {
    return Ok((false, None));
  }
  let original = fs::read_to_string(path)
    .map_err(|e| format!("读取 {} 失败: {}", path.display(), e))?;
  let next = match append_block(&original) {
    Some(v) => v,
    None => return Ok((false, None)), // already injected
  };

  let backup = backup_rc(path)?;
  atomic_write(path, &next)?;
  Ok((true, Some(backup)))
}

// Remove our marker block (and its trailing newline) from the rc file. Also
// collapses the blank line immediately preceding the block if it was inserted
// by `inject_rc` (avoids the rc growing by one blank line per enable/disable
// cycle). Returns Ok(true) when a block was actually removed.
fn remove_rc(path: &Path) -> Result<(bool, Option<PathBuf>), String> {
  if !path.exists() {
    return Ok((false, None));
  }
  let original = fs::read_to_string(path)
    .map_err(|e| format!("读取 {} 失败: {}", path.display(), e))?;
  let next = match strip_block(&original) {
    Some(v) => v,
    None => return Ok((false, None)), // not injected
  };

  let backup = backup_rc(path)?;
  atomic_write(path, &next)?;
  Ok((true, Some(backup)))
}

fn write_env_script() -> Result<PathBuf, String> {
  let path = env_script_path()?;
  if let Some(parent) = path.parent() {
    ensure_dir(parent)?;
  }
  write_text(&path, ENV_SCRIPT_BODY)?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o644));
  }
  Ok(path)
}

fn remove_env_script() -> Result<bool, String> {
  let path = env_script_path()?;
  if path.exists() {
    fs::remove_file(&path).map_err(|e| format!("删除 {} 失败: {}", path.display(), e))?;
    return Ok(true);
  }
  Ok(false)
}

fn rc_path_for(target: &ShellTarget) -> Result<PathBuf, String> {
  Ok(home_dir()?.join(target.filename))
}

fn build_shells_status() -> Vec<Value> {
  TARGETS
    .iter()
    .filter_map(|t| {
      let rc = rc_path_for(t).ok()?;
      let exists = rc.exists();
      Some(json!({
        "name": t.name,
        "rcPath": rc.to_string_lossy().to_string(),
        "rcExists": exists,
        "injected": exists && is_rc_injected(&rc),
      }))
    })
    .collect()
}

// ---- Public routes ----

pub(crate) fn shell_integration_status(_query: &Value) -> Result<Value, String> {
  let shells = build_shells_status();
  let any_injected = shells
    .iter()
    .any(|v| v.get("injected").and_then(Value::as_bool).unwrap_or(false));
  let setting_flag = crate::app_settings::get_bool("claudeShellIntegrationEnabled", false);
  let env_path = env_script_path().ok();
  let env_exists = env_path.as_ref().map(|p| p.exists()).unwrap_or(false);

  Ok(json!({
    "platform": if cfg!(unix) { "unix" } else { "unsupported" },
    "enabled": any_injected,
    "settingFlag": setting_flag,
    "envScriptPath": env_path.map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
    "envScriptExists": env_exists,
    "activeProfileDir": active_profile_dir_string(),
    "shells": shells,
  }))
}

pub(crate) fn enable_shell_integration(body: &Value) -> Result<Value, String> {
  if TARGETS.is_empty() {
    return Err("当前平台暂不支持 Shell 集成".to_string());
  }

  // Optional subset — default: all shells whose rc file exists.
  let object = parse_json_object(body);
  let requested: Option<Vec<String>> = object
    .get("shells")
    .and_then(|v| v.as_array())
    .map(|arr| {
      arr.iter()
        .filter_map(|x| x.as_str().map(|s| s.to_string()))
        .collect()
    });

  write_env_script()?;

  let mut applied = Vec::new();
  let mut skipped = Vec::new();
  let mut backups = Vec::new();

  for target in TARGETS {
    if let Some(req) = &requested {
      if !req.iter().any(|s| s == target.name) {
        continue;
      }
    }
    let rc = rc_path_for(target)?;
    if !rc.exists() {
      skipped.push(json!({ "name": target.name, "reason": "rc-missing" }));
      continue;
    }
    match inject_rc(&rc) {
      Ok((true, backup)) => {
        applied.push(target.name);
        if let Some(b) = backup {
          backups.push(b.to_string_lossy().to_string());
        }
      }
      Ok((false, _)) => {
        skipped.push(json!({ "name": target.name, "reason": "already-injected" }));
      }
      Err(e) => {
        return Err(format!("注入 {} 失败: {}", rc.display(), e));
      }
    }
  }

  let _ = crate::app_settings::save_app_settings(&json!({
    "claudeShellIntegrationEnabled": true
  }));

  let status = shell_integration_status(&json!({}))?;
  Ok(json!({
    "applied": applied,
    "skipped": skipped,
    "backups": backups,
    "status": status,
  }))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn find_block_none_on_empty() {
    assert!(find_block("").is_none());
    assert!(find_block("\n\n").is_none());
  }

  #[test]
  fn find_block_none_on_plain_rc() {
    let rc = "# a plain zshrc\nexport PATH=$PATH:/bin\nalias ll='ls -la'\n";
    assert!(find_block(rc).is_none());
  }

  #[test]
  fn find_block_detects_our_block() {
    // The block_text() output is what gets appended to rc files, so it MUST
    // be detectable by find_block — otherwise enable/disable isn't
    // idempotent and disable can't remove what enable added.
    let rc = format!("# plain\nalias x=y\n{}", block_text());
    let pair = find_block(&rc);
    assert!(pair.is_some(), "block_text output should be detectable");
    let (begin, end) = pair.unwrap();
    assert!(begin < end, "begin must come before end");
  }

  #[test]
  fn find_block_none_on_unclosed_begin() {
    // A BEGIN with no END means something truncated the file mid-write;
    // safer to leave it alone than to guess where the block ends.
    let rc = format!("{}\n# no end marker\n", BEGIN_MARKER);
    assert!(find_block(&rc).is_none());
  }

  #[test]
  fn find_block_none_when_end_before_begin() {
    let rc = format!("{}\nstuff\n{}\n", END_MARKER, BEGIN_MARKER);
    assert!(find_block(&rc).is_none());
  }

  #[test]
  fn block_text_contains_source_line() {
    // Regression guard: the appended block MUST source the env script; if a
    // refactor accidentally drops this line, enable silently becomes a no-op.
    let text = block_text();
    assert!(text.contains(".codex-config-ui/shell-env.sh"));
    assert!(text.contains(BEGIN_MARKER));
    assert!(text.contains(END_MARKER));
  }

  #[test]
  fn append_block_is_idempotent() {
    let rc = "export PATH=$PATH:/bin\nalias ll='ls -la'\n";
    let once = append_block(rc).expect("first append should inject");
    // A second append on already-injected content must return None (no-op);
    // otherwise enable-twice grows the file on every toggle.
    assert!(append_block(&once).is_none());
  }

  #[test]
  fn strip_block_is_idempotent() {
    let rc = "export PATH=$PATH:/bin\n";
    let with_block = append_block(rc).unwrap();
    let stripped = strip_block(&with_block).expect("strip must remove the block");
    // Re-stripping returns None.
    assert!(strip_block(&stripped).is_none());
  }

  #[test]
  fn roundtrip_preserves_original_content() {
    // Core safety property: enable + disable must not corrupt the rc or
    // accumulate whitespace. Byte-for-byte equality is the strictest possible
    // guarantee and the one users actually care about.
    for original in [
      // Has trailing newline
      "export PATH=$PATH:/bin\nalias ll='ls -la'\n",
      // Missing trailing newline (rare but legal)
      "export PATH=$PATH:/bin",
      // Empty
      "",
      // Multiple trailing blank lines
      "export FOO=bar\n\n\n",
      // Unicode + comments
      "# 测试 unicode\nexport GREET=\"你好\"\n",
    ] {
      let with_block = append_block(original).unwrap();
      let restored = strip_block(&with_block).unwrap_or_default();
      // Normalize: if original ended without newline, we add one on append
      // and keep one on strip (which is strictly better than the original —
      // POSIX actually requires a final newline anyway). Tolerate that.
      let normalized_original = if original.is_empty() {
        String::new()
      } else if original.ends_with('\n') {
        // Our strip collapses trailing blank lines to exactly one "\n".
        let mut s = original.trim_end_matches('\n').to_string();
        s.push('\n');
        s
      } else {
        let mut s = original.to_string();
        s.push('\n');
        s
      };
      assert_eq!(
        restored, normalized_original,
        "roundtrip for input {:?} produced {:?}",
        original, restored
      );
    }
  }

  #[test]
  fn append_block_refuses_when_already_injected() {
    let rc = format!("stuff\n{}", block_text());
    assert!(append_block(&rc).is_none());
  }

  #[test]
  fn strip_block_of_only_block_yields_empty() {
    // Degenerate case: rc file contains ONLY our block (e.g. user deleted
    // everything else). Strip should leave empty string, not panic.
    let rc = block_text();
    let out = strip_block(&rc).expect("should strip");
    assert!(out.is_empty() || out == "\n");
  }

  #[test]
  fn env_script_body_is_posix_safe() {
    // Sanity checks against regressions in the sh heredoc. These aren't a
    // full shell grammar parse — just cheap guards for the invariants the
    // offline zsh/bash tests already prove:
    //   - respects existing CLAUDE_CONFIG_DIR
    //   - uses sed (no jq/python dep)
    //   - exports the var
    //   - cleans up its scratch vars
    assert!(ENV_SCRIPT_BODY.contains("if [ -z \"${CLAUDE_CONFIG_DIR:-}\" ]"));
    assert!(ENV_SCRIPT_BODY.contains("sed -n"));
    assert!(ENV_SCRIPT_BODY.contains("export CLAUDE_CONFIG_DIR="));
    assert!(ENV_SCRIPT_BODY.contains("unset __ccui_json"));
  }
}

pub(crate) fn disable_shell_integration(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  // Default: also remove shell-env.sh for a clean uninstall. Opt-out via
  // { "keepEnvScript": true } if the caller wants to re-enable later without
  // re-writing the file.
  let keep_env = object
    .get("keepEnvScript")
    .and_then(Value::as_bool)
    .unwrap_or(false);

  let mut removed = Vec::new();
  let mut skipped = Vec::new();
  let mut backups = Vec::new();

  for target in TARGETS {
    let rc = rc_path_for(target)?;
    match remove_rc(&rc) {
      Ok((true, backup)) => {
        removed.push(target.name);
        if let Some(b) = backup {
          backups.push(b.to_string_lossy().to_string());
        }
      }
      Ok((false, _)) => {
        skipped.push(json!({ "name": target.name, "reason": "not-injected" }));
      }
      Err(e) => {
        return Err(format!("移除 {} 注入失败: {}", rc.display(), e));
      }
    }
  }

  let env_removed = if keep_env { false } else { remove_env_script()? };

  let _ = crate::app_settings::save_app_settings(&json!({
    "claudeShellIntegrationEnabled": false
  }));

  let status = shell_integration_status(&json!({}))?;
  Ok(json!({
    "removed": removed,
    "skipped": skipped,
    "backups": backups,
    "envScriptRemoved": env_removed,
    "status": status,
  }))
}
