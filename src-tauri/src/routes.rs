use serde_json::{json, Value};

use crate::codex::{
  check_setup_environment, codex_npm_action, get_codex_release_info, launch_codex,
  list_tools, load_claudecode_state, save_claudecode_config, save_claudecode_raw_config,
  launch_claudecode, load_openclaw_state, launch_openclaw, save_openclaw_config,
  get_openclaw_dashboard_url,
  repair_openclaw_dashboard_auth,
  run_openclaw_install_script, start_openclaw_install_task, get_openclaw_install_task,
  cancel_openclaw_install_task,
  install_openclaw_remote,
  onboard_openclaw, open_url_in_browser, stop_openclaw_gateway, uninstall_openclaw,
};
use crate::config::{
  get_provider_secret, list_backups, load_state, pick_directory, restore_backup, save_config,
  save_raw_config, save_settings, test_saved_provider,
};
use crate::provider::detect_provider;
use crate::updater::{get_app_update_info, install_app_update};
use crate::{fail, ok, OPENAI_CODEX_PACKAGE, CLAUDE_CODE_PACKAGE, OPENCLAW_PACKAGE};

async fn dispatch(app: tauri::AppHandle, path: &str, method: &str, query: &Value, body: &Value) -> Result<Value, String> {
  match (path, method) {
    ("/api/setup/check", "GET") => check_setup_environment(query),
    ("/api/state", "GET") => load_state(query),
    ("/api/path/pick-directory", "POST") => pick_directory(app, body),
    ("/api/provider/test", "POST") => detect_provider(body).await,
    ("/api/provider/secret", "POST") => get_provider_secret(body),
    ("/api/provider/test-saved", "POST") => test_saved_provider(body).await,
    ("/api/config/save", "POST") => save_config(body),
    ("/api/config/raw-save", "POST") => save_raw_config(body),
    ("/api/config/settings-save", "POST") => save_settings(body),
    ("/api/tools", "GET") => list_tools(),
    ("/api/codex/install", "POST") => codex_npm_action(&["install", "-g", OPENAI_CODEX_PACKAGE]),
    ("/api/codex/release", "GET") => get_codex_release_info(),
    ("/api/codex/reinstall", "POST") => codex_npm_action(&["install", "-g", OPENAI_CODEX_PACKAGE, "--force"]),
    ("/api/codex/update", "POST") => codex_npm_action(&["install", "-g", &format!("{}@latest", OPENAI_CODEX_PACKAGE)]),
    ("/api/codex/uninstall", "POST") => codex_npm_action(&["uninstall", "-g", OPENAI_CODEX_PACKAGE]),
    ("/api/codex/launch", "POST") => launch_codex(body),
    ("/api/claudecode/state", "GET") => load_claudecode_state(),
    ("/api/claudecode/config-save", "POST") => save_claudecode_config(body),
    ("/api/claudecode/raw-save", "POST") => save_claudecode_raw_config(body),
    ("/api/claudecode/install", "POST") => codex_npm_action(&["install", "-g", CLAUDE_CODE_PACKAGE]),
    ("/api/claudecode/reinstall", "POST") => codex_npm_action(&["install", "-g", CLAUDE_CODE_PACKAGE, "--force"]),
    ("/api/claudecode/update", "POST") => codex_npm_action(&["install", "-g", &format!("{}@latest", CLAUDE_CODE_PACKAGE)]),
    ("/api/claudecode/uninstall", "POST") => codex_npm_action(&["uninstall", "-g", CLAUDE_CODE_PACKAGE]),
    ("/api/claudecode/launch", "POST") => launch_claudecode(body),
    // OpenClaw — wrapped in spawn_blocking because load_openclaw_state uses reqwest::blocking
    // which deadlocks inside Tokio async runtime
    ("/api/openclaw/state", "GET") => {
      tokio::task::spawn_blocking(move || load_openclaw_state())
        .await
        .map_err(|e| format!("spawn_blocking error: {}", e))?
    },
    ("/api/openclaw/config-save", "POST") => save_openclaw_config(body),
    ("/api/openclaw/dashboard-url", "POST") => get_openclaw_dashboard_url(body),
    ("/api/openclaw/repair-dashboard-auth", "POST") => repair_openclaw_dashboard_auth(body),
    ("/api/openclaw/install", "POST") => run_openclaw_install_script(body),
    ("/api/openclaw/install/start", "POST") => start_openclaw_install_task(body),
    ("/api/openclaw/install/status", "GET") => get_openclaw_install_task(query),
    ("/api/openclaw/install/cancel", "POST") => cancel_openclaw_install_task(body),
    ("/api/openclaw/install/remote", "POST") => install_openclaw_remote(body),
    ("/api/openclaw/update", "POST") => codex_npm_action(&["install", "-g", &format!("{}@latest", OPENCLAW_PACKAGE)]),
    ("/api/openclaw/reinstall", "POST") => codex_npm_action(&["install", "-g", OPENCLAW_PACKAGE, "--force"]),
    ("/api/openclaw/uninstall", "POST") => uninstall_openclaw(body),
    ("/api/openclaw/launch", "POST") => {
      let body_clone = body.clone();
      tokio::task::spawn_blocking(move || launch_openclaw(&body_clone))
        .await
        .map_err(|e| format!("spawn_blocking error: {}", e))?
    },
    ("/api/openclaw/onboard", "POST") => onboard_openclaw(body),
    ("/api/openclaw/stop", "POST") => stop_openclaw_gateway(),
    ("/api/open-url", "POST") => open_url_in_browser(body),
    ("/api/backups", "GET") => list_backups(),
    ("/api/backups/restore", "POST") => restore_backup(body),
    ("/api/app/update", "GET") => get_app_update_info(app).await,
    ("/api/app/update", "POST") => install_app_update(app).await,
    _ => Err(format!("Unsupported request: {method} {path}")),
  }
}

#[tauri::command]
pub(crate) async fn backend_request(app: tauri::AppHandle, path: String, method: Option<String>, query: Option<Value>, body: Option<Value>) -> Value {
  let query_value = query.unwrap_or_else(|| json!({}));
  let body_value = body.unwrap_or_else(|| json!({}));
  match dispatch(app, &path, method.as_deref().unwrap_or("GET"), &query_value, &body_value).await {
    Ok(data) => ok(data),
    Err(error) => fail(error),
  }
}
