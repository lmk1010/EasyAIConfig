// Claude Code OAuth profile manager.
//
// Unlike Codex (which stores OAuth tokens plainly in ~/.codex/auth.json so we
// had to copy files around ourselves), Claude Code has a native mechanism:
//
//   - `CLAUDE_CONFIG_DIR=/some/path` → Claude Code reads/writes all state
//     (including .claude.json and .credentials.json) under that directory.
//   - The Keychain service name is automatically namespaced per config dir
//     (`Claude Code-credentials-<8-char-sha256>`), so tokens for each profile
//     live in their own macOS Keychain entry and never collide.
//
// So our "profile" is literally a CLAUDE_CONFIG_DIR under our own home.
// Switching = telling the launcher which one to point CLAUDE_CONFIG_DIR at.
// We never read or write Keychain ourselves, never copy tokens, never touch
// the user's default ~/.claude/. That means:
//   - No plaintext tokens on disk that we manage.
//   - No risk of corrupting the user's existing login.
//   - Account switching is invisible at the protocol level (Claude Code
//     client sends no device fingerprint — verified against source).
//
// Layout:
//   ~/.codex-config-ui/claudecode-oauth-profiles/
//     profiles.json              — { version, active, lastSwitchAt, profiles: [...] }
//     <id>/                      — this directory IS CLAUDE_CONFIG_DIR for the profile
//       .claude.json             — Claude writes oauthAccount here after login
//       .credentials.json        — (Linux/Windows only; macOS uses Keychain)
//       ...                      — Claude manages the rest

use chrono::Utc;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use uuid::Uuid;

use crate::provider::get_string;
use crate::{app_home, ensure_dir, parse_json_object, read_text};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn process_command(program: &str) -> Command {
  #[cfg(target_os = "windows")]
  {
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
  }
  #[cfg(not(target_os = "windows"))]
  {
    Command::new(program)
  }
}

// 探测当前系统里是否有活跃的 claude 进程。切换/删除 profile 前调用一次:
// 已启动的 claude 进程继承的是启动时的 CLAUDE_CONFIG_DIR env,后续更改
// profile 指针不影响它 —— 用户会以为切到新号了,但那个进程还在吃旧号的额度,
// 最坏情况下 session 文件写到旧目录还删到一半。所以切换前要告诉用户。
//
// 识别策略(故意保守,偏漏报而非误报):
//   1. 命令行精确命中 "@anthropic-ai/claude-code" 或 "claude/cli.js"
//      —— Claude Code 的 Node 入口,不会误伤
//   2. 命令行以 "claude" 为 argv[0] 的 basename 开头(Unix)/ claude.exe (Windows)
//      —— 兜底覆盖本地 bun/pnpm 安装的快捷入口
// 过滤:跳过包含 "config-ui"/"easyaiconfig" 的进程(我们自己),否则我们 UI
// 在跑就会自己误判。
//
// 返回的是命中的进程数(0 = 没有)。未知平台直接返回 0,不挡用户操作。
fn count_running_claude_processes() -> usize {
  #[cfg(unix)]
  {
    // `ps -axo command=` 在 macOS / Linux 都可用(BSD 写法)
    let output = process_command("ps")
      .args(["-axo", "command="])
      .output();
    let Ok(out) = output else { return 0; };
    if !out.status.success() { return 0; }
    let stdout = String::from_utf8_lossy(&out.stdout);
    return stdout
      .lines()
      .filter(|line| {
        let lower = line.to_ascii_lowercase();
        if lower.contains("config-ui") || lower.contains("easyaiconfig") { return false; }
        if lower.contains("@anthropic-ai/claude-code") { return true; }
        if lower.contains("claude/cli.js") { return true; }
        // argv[0] basename == "claude" — 取第一个 token 的最后一段
        let first = line.split_ascii_whitespace().next().unwrap_or("");
        let base = first.rsplit('/').next().unwrap_or(first);
        base == "claude"
      })
      .count();
  }
  #[cfg(windows)]
  {
    // tasklist /V /FO CSV 会给每行 CSV,字段含进程名但不含完整命令行;
    // 改用 PowerShell Get-CimInstance 拿 CommandLine 字段,覆盖 claude.exe
    // 和 node.exe + claude-code 两种场景。
    let output = process_command("powershell")
      .args([
        "-NoProfile","-NonInteractive","-Command",
        "Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine",
      ])
      .output();
    let Ok(out) = output else { return 0; };
    if !out.status.success() { return 0; }
    let stdout = String::from_utf8_lossy(&out.stdout);
    return stdout
      .lines()
      .filter(|line| {
        let lower = line.to_ascii_lowercase();
        if lower.contains("config-ui") || lower.contains("easyaiconfig") { return false; }
        if lower.contains("@anthropic-ai\\claude-code") || lower.contains("@anthropic-ai/claude-code") { return true; }
        if lower.contains("claude\\cli.js") || lower.contains("claude/cli.js") { return true; }
        lower.contains("\\claude.exe") || lower.ends_with("claude.exe")
      })
      .count();
  }
  #[allow(unreachable_code)]
  0
}

// In-memory cache for Keychain plan/tier lookups, keyed by the Keychain
// service name. Every `security find-generic-password` spawns a subprocess
// and blocks, which adds up to a visible ~300–600ms delay on first paint
// when the hub renders multiple profiles. The values we're reading
// (subscriptionType, rateLimitTier) only change when the user upgrades
// their plan or re-logs in, so a 60-second TTL is safe and the hub feels
// instant on repeat renders.
static KEYCHAIN_CACHE: Mutex<Option<HashMap<String, (Instant, (String, String))>>> = Mutex::new(None);
const KEYCHAIN_TTL: Duration = Duration::from_secs(60);

fn cache_get(service: &str) -> Option<(String, String)> {
  let mut guard = KEYCHAIN_CACHE.lock().ok()?;
  let map = guard.get_or_insert_with(HashMap::new);
  let (stamp, value) = map.get(service)?;
  if stamp.elapsed() > KEYCHAIN_TTL {
    map.remove(service);
    return None;
  }
  Some(value.clone())
}

fn cache_put(service: &str, pair: (String, String)) {
  if let Ok(mut guard) = KEYCHAIN_CACHE.lock() {
    let map = guard.get_or_insert_with(HashMap::new);
    map.insert(service.to_string(), (Instant::now(), pair));
  }
}

const PROFILES_DIRNAME: &str = "claudecode-oauth-profiles";
const PROFILES_INDEX: &str = "profiles.json";

fn profiles_root() -> Result<PathBuf, String> {
  Ok(app_home()?.join(PROFILES_DIRNAME))
}

fn profiles_index_path() -> Result<PathBuf, String> {
  Ok(profiles_root()?.join(PROFILES_INDEX))
}

fn profile_dir(id: &str) -> Result<PathBuf, String> {
  if id.trim().is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
    return Err("非法的 profile id".to_string());
  }
  Ok(profiles_root()?.join(id))
}

fn read_profiles_index() -> Result<Value, String> {
  let path = profiles_index_path()?;
  let text = read_text(&path)?;
  if text.trim().is_empty() {
    return Ok(json!({
      "version": 1,
      "active": "",
      "lastSwitchAt": 0,
      "profiles": [],
    }));
  }
  let parsed: Value = serde_json::from_str(&text)
    .map_err(|e| format!("claudecode profiles.json 解析失败: {}", e))?;
  Ok(parsed)
}

// 原子写 profiles.json:先写 <path>.tmp 再 rename,避免写到一半崩溃/并发
// 操作导致 JSON 损坏(switch + delete 同时发生会互相覆盖)。
// rename 在同一 FS 内是原子操作,读者永远看到的是"完整旧版本"或"完整新版本"。
fn write_profiles_index(index: &Value) -> Result<(), String> {
  ensure_dir(&profiles_root()?)?;
  let path = profiles_index_path()?;
  let text = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;

  let tmp_path = path.with_extension("json.tmp");
  fs::write(&tmp_path, &text).map_err(|e| format!("写临时文件失败: {}", e))?;
  fs::rename(&tmp_path, &path).map_err(|e| {
    // rename 失败时保底清理临时文件,不留脏文件
    let _ = fs::remove_file(&tmp_path);
    format!("提交 profiles.json 失败: {}", e)
  })?;
  Ok(())
}

fn get_str_obj(obj: &Map<String, Value>, key: &str) -> String {
  obj.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string()
}

// Decode a hex string (Claude Code stores the Keychain JSON blob as hex).
// Returns None on any malformed input so callers can silently fall through.
fn hex_decode(hex: &str) -> Option<Vec<u8>> {
  let trimmed = hex.trim();
  if trimmed.len() % 2 != 0 { return None; }
  let mut out = Vec::with_capacity(trimmed.len() / 2);
  let bytes = trimmed.as_bytes();
  let mut i = 0;
  while i < bytes.len() {
    let hi = match bytes[i] { b'0'..=b'9' => bytes[i] - b'0', b'a'..=b'f' => bytes[i] - b'a' + 10, b'A'..=b'F' => bytes[i] - b'A' + 10, _ => return None };
    let lo = match bytes[i + 1] { b'0'..=b'9' => bytes[i + 1] - b'0', b'a'..=b'f' => bytes[i + 1] - b'a' + 10, b'A'..=b'F' => bytes[i + 1] - b'A' + 10, _ => return None };
    out.push((hi << 4) | lo);
    i += 2;
  }
  Some(out)
}

// Compute the Keychain service suffix the way Claude Code does it:
//   sha256(configDir_utf8_NFC).hex()[0..8]
// Returns the 8-char lowercase hex prefix.
fn keychain_hash_suffix(dir: &std::path::Path) -> String {
  use sha2::{Digest, Sha256};
  let text = dir.to_string_lossy();
  let mut hasher = Sha256::new();
  hasher.update(text.as_bytes());
  let digest = hasher.finalize();
  let mut hex = String::with_capacity(16);
  for b in digest.iter().take(4) {
    hex.push_str(&format!("{:02x}", b));
  }
  hex
}

// Pull the stored OAuth blob for a given profile dir. Tries Keychain first on
// macOS, then falls back to <dir>/.credentials.json (the Linux/Windows
// plaintext fallback that Claude Code also uses on macOS when Keychain is
// unavailable).
//
// Keychain payload format note: current Claude Code stores the blob as plain
// JSON (verified against `security -w` output). Older / staging builds may
// store it hex-encoded. We try plain JSON first and fall back to hex-decode.
//
// Returns `(subscriptionType, rateLimitTier)`. Both empty when unreadable.
fn read_profile_plan_tier(dir: &std::path::Path) -> (String, String) {
  #[cfg(target_os = "macos")]
  {
    let suffix = keychain_hash_suffix(dir);
    let service = format!("Claude Code-credentials-{}", suffix);
    if let Some(pair) = read_keychain_plan_tier(&service) {
      return pair;
    }
  }

  // Plaintext fallback — <dir>/.credentials.json.
  let plain = dir.join(".credentials.json");
  if let Ok(text) = std::fs::read_to_string(&plain) {
    if let Ok(v) = serde_json::from_str::<Value>(&text) {
      return extract_plan_tier(&v);
    }
  }

  (String::new(), String::new())
}

#[cfg(target_os = "macos")]
fn read_keychain_plan_tier(service: &str) -> Option<(String, String)> {
  // Fast path: return cached value if still fresh.
  if let Some(cached) = cache_get(service) {
    if !cached.0.is_empty() || !cached.1.is_empty() {
      return Some(cached);
    }
  }

  let user = std::env::var("USER").unwrap_or_default();
  if user.is_empty() { return None; }

  let out = process_command("security")
    .args(["find-generic-password", "-a", &user, "-s", service, "-w"])
    .output()
    .ok()?;
  if !out.status.success() { return None; }

  let raw = String::from_utf8_lossy(&out.stdout);
  let trimmed = raw.trim();
  if trimmed.is_empty() { return None; }

  // Strategy 1: current Claude Code format — plain JSON written by `security -X`.
  if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
    let (s, t) = extract_plan_tier(&v);
    if !s.is_empty() || !t.is_empty() {
      cache_put(service, (s.clone(), t.clone()));
      return Some((s, t));
    }
  }

  // Strategy 2: legacy hex-encoded JSON (seen in older builds / docs).
  if let Some(bytes) = hex_decode(trimmed) {
    if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
      let (s, t) = extract_plan_tier(&v);
      if !s.is_empty() || !t.is_empty() {
        cache_put(service, (s.clone(), t.clone()));
        return Some((s, t));
      }
    }
  }

  None
}

fn extract_plan_tier(blob: &Value) -> (String, String) {
  let oauth = match blob.get("claudeAiOauth").and_then(Value::as_object) {
    Some(o) => o,
    None => return (String::new(), String::new()),
  };
  let sub = get_str_obj(oauth, "subscriptionType");
  let tier = get_str_obj(oauth, "rateLimitTier");
  (sub, tier)
}

// Given (subscriptionType, rateLimitTier), produce the display label the UI
// shows as a plan pill. Mirrors Claude Code's own planModeV2.ts logic.
fn plan_label(subscription_type: &str, rate_limit_tier: &str) -> String {
  match (subscription_type, rate_limit_tier) {
    ("max", "default_claude_max_20x") => "Max 20x".to_string(),
    ("max", "default_claude_max_5x") => "Max 5x".to_string(),
    ("max", _) => "Max".to_string(),
    ("pro", _) => "Pro".to_string(),
    ("team", _) => "Team".to_string(),
    ("enterprise", _) => "Enterprise".to_string(),
    ("free", _) => "Free".to_string(),
    ("", _) => String::new(),
    (s, _) => s.to_string(),
  }
}

// Pull oauthAccount metadata out of a profile's .claude.json. Returns empty
// strings when the file is missing / not yet populated (i.e. user hasn't
// finished the login flow yet).
fn read_profile_metadata(dir: &std::path::Path) -> Value {
  let mut out = json!({
    "accountUuid": "",
    "email": "",
    "organizationName": "",
    "organizationUuid": "",
    "organizationRole": "",
    "displayName": "",
    "plan": "",
    "hasTokens": false,
  });

  let claude_json = read_text(&dir.join(".claude.json")).unwrap_or_default();
  if claude_json.trim().is_empty() {
    return out;
  }
  let parsed: Value = match serde_json::from_str(&claude_json) {
    Ok(v) => v,
    Err(_) => return out,
  };
  let account = match parsed.get("oauthAccount").and_then(Value::as_object) {
    Some(obj) => obj,
    None => return out,
  };

  let account_uuid = get_str_obj(account, "accountUuid");
  let email = get_str_obj(account, "emailAddress");
  let org_name = get_str_obj(account, "organizationName");
  let org_uuid = get_str_obj(account, "organizationUuid");
  let org_role = get_str_obj(account, "organizationRole");
  let display_name = get_str_obj(account, "displayName");
  let billing_type = get_str_obj(account, "billingType");

  // `.claude.json` does not carry the actual plan tier (pro / max / max-20x).
  // Those live in the Keychain blob (or plaintext .credentials.json fallback).
  // Read them best-effort; first macOS Keychain access pops a one-time
  // "Always Allow" dialog, subsequent reads are silent.
  let (subscription_type, rate_limit_tier) = read_profile_plan_tier(dir);
  let plan = plan_label(&subscription_type, &rate_limit_tier);

  if let Some(obj) = out.as_object_mut() {
    obj.insert("accountUuid".to_string(), json!(account_uuid));
    obj.insert("email".to_string(), json!(email));
    obj.insert("organizationName".to_string(), json!(org_name));
    obj.insert("organizationUuid".to_string(), json!(org_uuid));
    obj.insert("organizationRole".to_string(), json!(org_role));
    obj.insert("displayName".to_string(), json!(display_name));
    obj.insert("billingType".to_string(), json!(billing_type));
    obj.insert("subscriptionType".to_string(), json!(subscription_type));
    obj.insert("rateLimitTier".to_string(), json!(rate_limit_tier));
    obj.insert("plan".to_string(), json!(plan));
    obj.insert("hasTokens".to_string(), json!(!account_uuid.is_empty()));
  }
  out
}

// Write onboarding-bypass fields into a profile's .claude.json so Claude
// Code skips its first-run welcome wizard the first time the profile is
// opened in a plain terminal.
//
// Why this exists: Claude Code gates the "Select login method" / theme /
// permission-mode wizard on `hasCompletedOnboarding` in .claude.json, NOT
// on whether a Keychain token exists. So a profile that just finished
// OAuth through this UI still shows the wizard when the user pastes our
// `export CLAUDE_CONFIG_DIR=<dir>` command into a fresh terminal and runs
// `claude` — even though auth is already set up. The wizard's login step
// detects the existing Keychain token and doesn't actually re-auth, but
// the user has to click through theme/permission screens before reaching
// the REPL. We preempt it by writing the flag ourselves.
//
// Called from list() for every profile whose oauthAccount is populated.
// Idempotent: no-ops when the flag is already true, so steady-state list
// renders don't rewrite the file on every Hub paint.
//
// We do NOT patch before oauthAccount lands — doing so would mark a
// not-yet-logged-in profile as "onboarded" and leave it in that state
// forever if login is later abandoned. Once oauth lands we patch exactly
// once.
//
// Atomic write (tmp + rename) — a crash mid-write on this file would
// brick the profile (Claude Code won't start if .claude.json is corrupt),
// so the write has to be all-or-nothing.
fn ensure_onboarding_bypass(dir: &std::path::Path) -> Result<bool, String> {
  let path = dir.join(".claude.json");
  let text = match fs::read_to_string(&path) {
    Ok(t) => t,
    Err(_) => return Ok(false),
  };
  if text.trim().is_empty() {
    return Ok(false);
  }
  let mut parsed: Value = match serde_json::from_str(&text) {
    Ok(v) => v,
    Err(_) => return Ok(false),
  };
  let obj = match parsed.as_object_mut() {
    Some(o) => o,
    None => return Ok(false),
  };
  // Gate on oauthAccount — login hasn't finished yet otherwise.
  if obj.get("oauthAccount").and_then(Value::as_object).is_none() {
    return Ok(false);
  }
  if obj
    .get("hasCompletedOnboarding")
    .and_then(Value::as_bool)
    .unwrap_or(false)
  {
    return Ok(false);
  }

  let (version, theme) = read_default_onboarding_hints();
  obj.insert("hasCompletedOnboarding".to_string(), json!(true));
  obj.insert("lastOnboardingVersion".to_string(), json!(version));
  // Only set theme if the profile doesn't already carry one — respects a
  // user who manually picked a theme inside the profile before we got
  // here.
  if !obj.contains_key("theme") {
    obj.insert("theme".to_string(), json!(theme));
  }

  let out = serde_json::to_string_pretty(&parsed).map_err(|e| e.to_string())?;
  let tmp = path.with_extension("json.tmp");
  fs::write(&tmp, &out).map_err(|e| format!("写临时文件失败: {}", e))?;
  // Match the 0600 perms set elsewhere for OAuth-adjacent files (tightened
  // in 7f8487c). `.claude.json` only carries account metadata (email, org,
  // accountUuid — no token), but the existing posture is to keep anything
  // auth-adjacent user-readable only, and we shouldn't regress it.
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
  }
  fs::rename(&tmp, &path).map_err(|e| {
    let _ = fs::remove_file(&tmp);
    format!("提交 .claude.json 失败: {}", e)
  })?;
  Ok(true)
}

// Pull onboarding-version and theme from the user's default ~/.claude.json
// so a patched profile pins to the version / theme the user has already
// accepted. Prevents Claude Code from deciding the profile is on a stale
// onboarding version and re-running the wizard after an upgrade.
//
// Falls back to "1.0.0" / "dark" if the default config is missing — new
// users who've never run claude at all still get a sane bypass.
fn read_default_onboarding_hints() -> (String, String) {
  let fallback_version = "1.0.0".to_string();
  let fallback_theme = "dark".to_string();

  let Ok(home) = crate::home_dir() else {
    return (fallback_version, fallback_theme);
  };
  let text = match fs::read_to_string(home.join(".claude.json")) {
    Ok(t) => t,
    Err(_) => return (fallback_version, fallback_theme),
  };
  let v: Value = match serde_json::from_str(&text) {
    Ok(v) => v,
    Err(_) => return (fallback_version, fallback_theme),
  };
  let obj = match v.as_object() {
    Some(o) => o,
    None => return (fallback_version, fallback_theme),
  };
  let version = obj
    .get("lastOnboardingVersion")
    .and_then(Value::as_str)
    .map(String::from)
    .unwrap_or(fallback_version);
  let theme = obj
    .get("theme")
    .and_then(Value::as_str)
    .map(String::from)
    .unwrap_or(fallback_theme);
  (version, theme)
}

// Public: expose the active profile's CONFIG_DIR so the launcher can inject
// CLAUDE_CONFIG_DIR. Returns None when no profile is active (i.e. default
// ~/.claude/ should be used — unchanged from previous behavior).
pub(crate) fn active_profile_config_dir() -> Option<PathBuf> {
  let index = read_profiles_index().ok()?;
  let active = index.get("active").and_then(Value::as_str).unwrap_or("");
  if active.is_empty() {
    return None;
  }
  let dir = profile_dir(active).ok()?;
  if !dir.exists() {
    return None;
  }
  Some(dir)
}

// ---- Public routes ----

// Refresh each profile's displayed metadata from its .claude.json on every
// list call — cheap enough (single small JSON parse per profile) and means
// token refreshes / org changes propagate without an explicit "refresh meta"
// button.
pub(crate) fn list_claudecode_oauth_profiles(_query: &Value) -> Result<Value, String> {
  let mut index = read_profiles_index()?;
  let active = index.get("active").and_then(Value::as_str).unwrap_or("").to_string();
  let last_switch_at = index.get("lastSwitchAt").and_then(Value::as_i64).unwrap_or(0);

  let profiles_arr = index
    .get_mut("profiles")
    .and_then(Value::as_array_mut)
    .cloned()
    .unwrap_or_default();

  // Read each profile's metadata (which includes a Keychain lookup on macOS)
  // in parallel so N profiles don't take N * ~200ms on cold cache. Cached
  // hits return in microseconds anyway, so this only matters for the first
  // paint after an app restart.
  struct ProfileInput {
    id: String,
    name: String,
    created_at: i64,
    updated_at: i64,
    dir: PathBuf,
  }
  let inputs: Vec<ProfileInput> = profiles_arr
    .iter()
    .filter_map(|p| {
      let id = p.get("id").and_then(Value::as_str).unwrap_or("").to_string();
      if id.is_empty() { return None; }
      let dir = profile_dir(&id).ok()?;
      Some(ProfileInput {
        id: id.clone(),
        name: p.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
        created_at: p.get("createdAt").and_then(Value::as_i64).unwrap_or(0),
        updated_at: p.get("updatedAt").and_then(Value::as_i64).unwrap_or(0),
        dir,
      })
    })
    .collect();

  let metas: Vec<(ProfileInput, Value)> = std::thread::scope(|scope| {
    let handles: Vec<_> = inputs
      .into_iter()
      .map(|input| {
        scope.spawn(move || {
          let meta = read_profile_metadata(&input.dir);
          // Opportunistically patch in onboarding-bypass fields once the
          // profile has an oauthAccount. Idempotent — only writes on the
          // first list() after login completes. Errors swallowed: if we
          // can't write the flag, the user just gets the wizard once,
          // which is the status-quo behavior.
          let _ = ensure_onboarding_bypass(&input.dir);
          (input, meta)
        })
      })
      .collect();
    handles.into_iter().filter_map(|h| h.join().ok()).collect()
  });

  // 孤儿判据:无 token 且 15 分钟前就存在。用户创建 profile 后正常流程 10~30
  // 秒就能拿到 token(等同一次浏览器 OAuth 授权),超过 15 分钟还没有 token
  // 说明登录被放弃/中断/关闭浏览器。这个标记给前端用,前端收到 isStale=true 的
  // profile 会静默调 delete(force, silent) 清理,之后重开 UI 也不会留着脏数据。
  // 后端 list 只打标记不改状态,避免 GET 接口带副作用。
  const STALE_THRESHOLD_SECS: i64 = 15 * 60;
  let now_secs = Utc::now().timestamp();

  let mut enriched = Vec::new();
  for (input, meta) in metas {
    let ProfileInput { id, name, created_at, updated_at, dir } = input;
    let has_tokens = meta.get("hasTokens").and_then(Value::as_bool).unwrap_or(false);
    let is_stale = !has_tokens
      && created_at > 0
      && (now_secs - created_at) > STALE_THRESHOLD_SECS;
    enriched.push(json!({
      "id": id,
      "name": name,
      "configDir": dir.to_string_lossy().to_string(),
      "createdAt": created_at,
      "updatedAt": updated_at,
      "accountUuid": meta.get("accountUuid").cloned().unwrap_or(json!("")),
      "email": meta.get("email").cloned().unwrap_or(json!("")),
      "organizationName": meta.get("organizationName").cloned().unwrap_or(json!("")),
      "organizationRole": meta.get("organizationRole").cloned().unwrap_or(json!("")),
      "displayName": meta.get("displayName").cloned().unwrap_or(json!("")),
      "billingType": meta.get("billingType").cloned().unwrap_or(json!("")),
      "subscriptionType": meta.get("subscriptionType").cloned().unwrap_or(json!("")),
      "rateLimitTier": meta.get("rateLimitTier").cloned().unwrap_or(json!("")),
      "plan": meta.get("plan").cloned().unwrap_or(json!("")),
      "hasTokens": meta.get("hasTokens").cloned().unwrap_or(json!(false)),
      "isStale": is_stale,
    }));
  }

  // Default ~/.claude/ profile — probe its Keychain entry too so the "默认"
  // row in the hub shows a plan pill matching the managed-profile rows. For
  // the default dir Claude Code uses `Claude Code-credentials` with no hash
  // suffix, so we short-circuit: read directly by service name (or plaintext
  // fallback).
  let default_plan = read_default_claude_plan();

  Ok(json!({
    "active": active,
    "lastSwitchAt": last_switch_at,
    "profiles": enriched,
    "defaultPlan": default_plan,
  }))
}

fn read_default_claude_plan() -> Value {
  let (sub, tier) = read_default_plan_tier();

  // Also surface the default login's email / org so the hub's "默认" row
  // can render the identity immediately, without waiting for the separate
  // load_claudecode_state fetch to populate cc.login. Source of truth is
  // ~/.claude.json :: oauthAccount (the global config file Claude CLI writes
  // when CLAUDE_CONFIG_DIR is unset).
  let (email, org_name) = crate::home_dir()
    .ok()
    .and_then(|home| {
      let text = std::fs::read_to_string(home.join(".claude.json")).ok()?;
      let v: Value = serde_json::from_str(&text).ok()?;
      let account = v.get("oauthAccount").and_then(Value::as_object)?;
      Some((
        get_str_obj(account, "emailAddress"),
        get_str_obj(account, "organizationName"),
      ))
    })
    .unwrap_or_default();

  json!({
    "subscriptionType": sub,
    "rateLimitTier": tier,
    "plan": plan_label(&sub, &tier),
    "email": email,
    "organizationName": org_name,
  })
}

fn read_default_plan_tier() -> (String, String) {
  #[cfg(target_os = "macos")]
  {
    if let Some(pair) = read_keychain_plan_tier("Claude Code-credentials") {
      return pair;
    }
  }

  // Plaintext fallback — ~/.claude/.credentials.json (non-mac default) or the
  // mac fallback path when Keychain is unavailable.
  if let Ok(home) = crate::home_dir() {
    let plain = home.join(".claude").join(".credentials.json");
    if let Ok(text) = std::fs::read_to_string(&plain) {
      if let Ok(v) = serde_json::from_str::<Value>(&text) {
        return extract_plan_tier(&v);
      }
    }
  }
  (String::new(), String::new())
}

// Create a new profile *slot*. Doesn't run codex login — caller is expected to
// separately POST /api/claudecode/login with the same profileId so the terminal
// can launch `CLAUDE_CONFIG_DIR=<dir> claude auth login`.
pub(crate) fn create_claudecode_oauth_profile(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let requested_name = get_string(&object, "name");
  let id = format!("prof_{}", Uuid::new_v4().simple());
  let dir = profile_dir(&id)?;
  ensure_dir(&dir)?;

  let now = Utc::now().timestamp();
  let name = if requested_name.is_empty() {
    format!("Claude 账号 #{}", &id[..8.min(id.len())])
  } else {
    requested_name
  };

  let mut index = read_profiles_index()?;
  if let Some(arr) = index.get_mut("profiles").and_then(Value::as_array_mut) {
    arr.push(json!({
      "id": id,
      "name": name,
      "createdAt": now,
      "updatedAt": now,
    }));
  } else if let Some(obj) = index.as_object_mut() {
    obj.insert(
      "profiles".to_string(),
      json!([{
        "id": id,
        "name": name,
        "createdAt": now,
        "updatedAt": now,
      }]),
    );
  }
  write_profiles_index(&index)?;

  Ok(json!({
    "id": id,
    "name": name,
    "configDir": dir.to_string_lossy().to_string(),
  }))
}

// Switch the active profile — this is *only* a pointer update. No Keychain
// ops, no file copies. All future Claude launches from our app will set
// CLAUDE_CONFIG_DIR=<dir> if active is non-empty, and skip the env var if
// active is empty (user switching back to ~/.claude/ default).
pub(crate) fn switch_claudecode_oauth_profile(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let id = get_string(&object, "id"); // empty string = back to default
  let force = object.get("force").and_then(Value::as_bool).unwrap_or(false);

  let mut index = read_profiles_index()?;
  let now = Utc::now().timestamp();
  let last = index.get("lastSwitchAt").and_then(Value::as_i64).unwrap_or(0);
  let current_active = index.get("active").and_then(Value::as_str).unwrap_or("").to_string();

  // 切换到"自己"是 no-op,直接返回成功避免节流误阻塞
  if id == current_active {
    return Ok(json!({ "active": id, "noop": true }));
  }

  // 60s 节流:防止脚本/恶意调用者快速切换(Anthropic 后端看频繁切账号会怀疑)
  if last > 0 && now - last < 60 {
    return Err(format!(
      "切换太频繁，请在 {} 秒后再试（防风控）",
      60 - (now - last)
    ));
  }

  if !id.is_empty() {
    let dir = profile_dir(&id)?;
    if !dir.exists() {
      return Err("目标 profile 目录不存在".to_string());
    }
  }

  // 活跃进程探测:有 claude 进程在跑时,已启动进程不会感知到切换,会继续吃旧号。
  // 非强制模式返回一个结构化错误,UI 展示"确认后强切"选项。
  if !force {
    let running = count_running_claude_processes();
    if running > 0 {
      return Err(format!(
        "CLAUDE_RUNNING:{}:检测到 {} 个正在运行的 Claude 进程。这些进程会继续使用当前账号直到关闭。\n\n建议先关闭后再切,否则:\n- Dashboard 显示会与运行中进程脱节\n- 运行中进程的用量仍计入旧账号\n\n如已确认要继续,点击再次切换时会强制执行。",
        running, running
      ));
    }
  }

  if let Some(obj) = index.as_object_mut() {
    obj.insert("active".to_string(), json!(id));
    obj.insert("lastSwitchAt".to_string(), json!(now));
  }
  write_profiles_index(&index)?;

  Ok(json!({ "active": id, "forced": force }))
}

pub(crate) fn rename_claudecode_oauth_profile(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let id = get_string(&object, "id");
  let name = get_string(&object, "name");
  if id.is_empty() { return Err("id is required".to_string()); }
  if name.is_empty() { return Err("name is required".to_string()); }

  let mut index = read_profiles_index()?;
  let mut touched = false;
  let now = Utc::now().timestamp();
  if let Some(arr) = index.get_mut("profiles").and_then(Value::as_array_mut) {
    for p in arr.iter_mut() {
      if p.get("id").and_then(Value::as_str).unwrap_or("") == id {
        if let Some(obj) = p.as_object_mut() {
          obj.insert("name".to_string(), json!(name));
          obj.insert("updatedAt".to_string(), json!(now));
        }
        touched = true;
        break;
      }
    }
  }
  if !touched {
    return Err("未找到该 profile".to_string());
  }
  write_profiles_index(&index)?;
  Ok(json!({ "id": id, "name": name }))
}

// Delete the profile's directory. Keychain entries (macOS) are left as
// harmless orphans — reclaim is manual via Keychain Access if a user cares.
// We deliberately don't touch ~/.claude/ or the default Keychain entry.
pub(crate) fn delete_claudecode_oauth_profile(body: &Value) -> Result<Value, String> {
  let object = parse_json_object(body);
  let id = get_string(&object, "id");
  let force = object.get("force").and_then(Value::as_bool).unwrap_or(false);
  if id.is_empty() { return Err("id is required".to_string()); }

  let dir = profile_dir(&id)?;

  // 删 profile 比切换更危险:目录 rm -rf 掉之后,正在使用这个目录的 claude
  // 进程会在写 session/.claude.json 时 I/O 出错直接崩。所以同样做进程探测。
  // 这里不精确到哪个进程在用哪个 dir,保守起见:有任何 claude 进程就警告。
  if !force {
    let running = count_running_claude_processes();
    if running > 0 {
      return Err(format!(
        "CLAUDE_RUNNING:{}:检测到 {} 个正在运行的 Claude 进程。删除 profile 目录可能导致正在使用该目录的进程崩溃(session 写入失败)。\n\n建议先关闭所有 Claude 进程再删。确认无误可强制删除。",
        running, running
      ));
    }
  }

  let mut index = read_profiles_index()?;
  let mut removed = false;
  if let Some(arr) = index.get_mut("profiles").and_then(Value::as_array_mut) {
    let before = arr.len();
    arr.retain(|p| p.get("id").and_then(Value::as_str).unwrap_or("") != id);
    removed = arr.len() != before;
  }
  if !removed {
    return Err("未找到该 profile".to_string());
  }
  if let Some(obj) = index.as_object_mut() {
    let active = obj.get("active").and_then(Value::as_str).unwrap_or("").to_string();
    if active == id {
      obj.insert("active".to_string(), json!(""));
    }
  }
  write_profiles_index(&index)?;

  if dir.exists() {
    let _ = fs::remove_dir_all(&dir);
  }

  Ok(json!({ "id": id }))
}
