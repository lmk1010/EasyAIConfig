use serde_json::{json, Value};
use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// Resolve the user's full shell PATH.
/// On macOS / Linux, .app bundles don't inherit the login shell PATH,
/// so we run `$SHELL -lc 'echo $PATH'` to capture it.
fn full_path_env() -> String {
  static CACHED: OnceLock<String> = OnceLock::new();
  CACHED
    .get_or_init(|| {
      let current = std::env::var("PATH").unwrap_or_default();

      // On Windows the PATH is usually fine
      if cfg!(target_os = "windows") {
        return current;
      }

      // Try to get PATH from user's login shell
      let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
      let shell_path = Command::new(&shell)
        .args(["-lc", "echo $PATH"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

      // Build comprehensive PATH with common locations
      let home = dirs::home_dir()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|| "/Users/unknown".to_string());

      let extra_paths = [
        format!("{}/.nvm/versions/node/*/bin", home),  // placeholder, expanded below
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

      // Also try to find nvm node paths
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
      // Sort nvm paths in reverse so the latest version comes first
      nvm_paths.sort();
      nvm_paths.reverse();

      let mut all_parts: Vec<String> = Vec::new();
      // shell_path first (highest priority)
      for p in shell_path.split(':') {
        if !p.is_empty() {
          all_parts.push(p.to_string());
        }
      }
      // nvm paths
      all_parts.extend(nvm_paths);
      // current PATH
      for p in current.split(':') {
        if !p.is_empty() {
          all_parts.push(p.to_string());
        }
      }
      // extra common paths
      all_parts.extend(extra_paths.into_iter().filter(|p| !p.contains('*')));

      // Deduplicate while preserving order
      let mut seen = std::collections::HashSet::new();
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

fn command_exists(command: &str) -> Option<String> {
  // Set PATH before using which
  std::env::set_var("PATH", full_path_env());
  which::which(command).ok().map(|path| path.to_string_lossy().to_string())
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

fn launch_terminal_command(cwd: &Path) -> Result<String, String> {
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
  let message = launch_terminal_command(&cwd)?;
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
use crate::provider::get_string;
use crate::{
  compare_versions, default_codex_home, extract_version, home_dir, npm_command,
  parse_json_object, parse_toml_config, read_text, OPENAI_CODEX_PACKAGE,
  claude_code_home, write_text, ensure_dir, CLAUDE_CODE_PACKAGE,
};

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
      "description": "开源 AI 编程代理",
      "supported": false,
      "configFormat": "json",
      "installMethod": "npm",
      "npmPackage": Value::Null,
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

fn launch_terminal_for_tool(cwd: &Path, binary_path: &str, tool_label: &str) -> Result<String, String> {
  let cwd_text = cwd.to_string_lossy().to_string();

  if cfg!(target_os = "macos") {
    let script = [
      "tell application \"Terminal\"",
      "activate",
      &format!(
        "do script \"cd {} && {}\"",
        escape_applescript(&cwd_text),
        escape_applescript(binary_path)
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
        &format!("cd /d \"{}\" && \"{}\"", cwd_text, binary_path),
      ])
      .spawn()
      .map_err(|error| error.to_string())?;
    return Ok(format!("{} 已在新命令窗口中启动", tool_label));
  }

  let terminals = vec![
    ("x-terminal-emulator", vec!["-e".to_string(), format!("bash -lc \"cd '{}' && '{}'\"", cwd_text, binary_path)]),
    ("gnome-terminal", vec!["--".to_string(), "bash".to_string(), "-lc".to_string(), format!("cd '{}' && '{}'", cwd_text, binary_path)]),
    ("konsole", vec!["-e".to_string(), "bash".to_string(), "-lc".to_string(), format!("cd '{}' && '{}'", cwd_text, binary_path)]),
  ];

  for (command, args) in terminals {
    if command_exists(command).is_none() { continue; }
    create_command(command).args(args).spawn().map_err(|error| error.to_string())?;
    return Ok(format!("{} 已在新终端中启动", tool_label));
  }

  Err(format!("没有找到可用终端，请先手动运行 {}", binary_path))
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
