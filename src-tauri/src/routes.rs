use serde_json::{json, Value};

use crate::codex::{
  check_setup_environment, codex_npm_action, get_codex_release_info, launch_codex,
  login_codex, get_codex_usage_metrics, list_codex_sessions, get_codex_session_detail,
  resume_codex_session, fork_codex_session, export_codex_session,
  get_codex_app_state, install_codex_app, open_codex_app,
  list_tools, load_claudecode_state, save_claudecode_config, save_claudecode_raw_config,
  delete_claudecode_provider,
  launch_claudecode, login_claudecode, load_opencode_state, save_opencode_config,
  save_opencode_raw_config, install_opencode, reinstall_opencode, update_opencode,
  uninstall_opencode, launch_opencode, login_opencode, remove_opencode_auth,
  start_opencode_install_task, get_opencode_install_task, cancel_opencode_install_task,
  load_openclaw_state, launch_openclaw, save_openclaw_config,
  get_system_storage_state, cleanup_system_storage,
  get_openclaw_dashboard_url,
  repair_openclaw_dashboard_auth,
  run_openclaw_install_script, start_openclaw_install_task, get_openclaw_install_task,
  cancel_openclaw_install_task,
  install_openclaw_remote,
  onboard_openclaw, open_url_in_browser, stop_openclaw_gateway, kill_openclaw_port_occupants, uninstall_openclaw,
};
use crate::config::{
  delete_codex_provider, get_provider_secret, list_backups, load_state, pick_directory,
  restore_backup, save_config, save_raw_config, save_settings, test_saved_provider,
};
use crate::oauth_profiles::{
  delete_oauth_profile, list_oauth_profiles, rename_oauth_profile, save_current_oauth_profile,
  switch_oauth_profile,
};
use crate::claudecode_oauth_profiles::{
  create_claudecode_oauth_profile, delete_claudecode_oauth_profile, list_claudecode_oauth_profiles,
  rename_claudecode_oauth_profile, switch_claudecode_oauth_profile,
};
use crate::app_settings::{load_app_settings, save_app_settings};
use crate::network::{
  get_network_latency, get_network_status, list_network_ip_history, refresh_network_status,
};
use crate::processes::{kill_process, list_processes};
use crate::provider::detect_provider;
use crate::usage_stats::{claudecode_local_usage, codex_session_stats};
use crate::updater::{get_app_update_info, get_app_update_progress, install_app_update};
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
    ("/api/config/delete-provider", "POST") => delete_codex_provider(body),
    ("/api/config/raw-save", "POST") => save_raw_config(body),
    ("/api/config/settings-save", "POST") => save_settings(body),
    ("/api/tools", "GET") => list_tools(),
    ("/api/codex/install", "POST") => codex_npm_action(&["install", "-g", OPENAI_CODEX_PACKAGE]),
    ("/api/codex/release", "GET") => get_codex_release_info(),
    ("/api/codex/reinstall", "POST") => codex_npm_action(&["install", "-g", OPENAI_CODEX_PACKAGE, "--force"]),
    ("/api/codex/update", "POST") => codex_npm_action(&["install", "-g", &format!("{}@latest", OPENAI_CODEX_PACKAGE)]),
    ("/api/codex/uninstall", "POST") => codex_npm_action(&["uninstall", "-g", OPENAI_CODEX_PACKAGE]),
    ("/api/codex/launch", "POST") => launch_codex(body),
    ("/api/codex/login", "POST") => login_codex(body),
    ("/api/codex/oauth/profiles", "GET") => list_oauth_profiles(query),
    ("/api/codex/oauth/profiles/save-current", "POST") => save_current_oauth_profile(body),
    ("/api/codex/oauth/profiles/switch", "POST") => switch_oauth_profile(body),
    ("/api/codex/oauth/profiles/rename", "POST") => rename_oauth_profile(body),
    ("/api/codex/oauth/profiles/delete", "POST") => delete_oauth_profile(body),
    ("/api/codex/sessions", "GET") => list_codex_sessions(query),
    ("/api/codex/session-detail", "GET") => get_codex_session_detail(query),
    ("/api/codex/resume", "POST") => resume_codex_session(body),
    ("/api/codex/fork", "POST") => fork_codex_session(body),
    ("/api/codex/session-export", "POST") => export_codex_session(body),
    ("/api/dashboard/codex-usage", "GET") => get_codex_usage_metrics(query),
    ("/api/codex-app/state", "GET") => get_codex_app_state(),
    ("/api/codex-app/install", "POST") => install_codex_app(body),
    ("/api/codex-app/open", "POST") => open_codex_app(body),
    ("/api/claudecode/state", "GET") => load_claudecode_state(query),
    ("/api/claudecode/config-save", "POST") => save_claudecode_config(body),
    ("/api/claudecode/raw-save", "POST") => save_claudecode_raw_config(body),
    ("/api/claudecode/provider-delete", "POST") => delete_claudecode_provider(body),
    ("/api/claudecode/install", "POST") => codex_npm_action(&["install", "-g", CLAUDE_CODE_PACKAGE]),
    ("/api/claudecode/reinstall", "POST") => codex_npm_action(&["install", "-g", CLAUDE_CODE_PACKAGE, "--force"]),
    ("/api/claudecode/update", "POST") => codex_npm_action(&["install", "-g", &format!("{}@latest", CLAUDE_CODE_PACKAGE)]),
    ("/api/claudecode/uninstall", "POST") => codex_npm_action(&["uninstall", "-g", CLAUDE_CODE_PACKAGE]),
    ("/api/claudecode/launch", "POST") => launch_claudecode(body),
    ("/api/claudecode/login", "POST") => login_claudecode(body),
    ("/api/claudecode/oauth/profiles", "GET") => list_claudecode_oauth_profiles(query),
    ("/api/claudecode/oauth/profiles/create", "POST") => create_claudecode_oauth_profile(body),
    ("/api/claudecode/oauth/profiles/switch", "POST") => switch_claudecode_oauth_profile(body),
    ("/api/claudecode/oauth/profiles/rename", "POST") => rename_claudecode_oauth_profile(body),
    ("/api/claudecode/oauth/profiles/delete", "POST") => delete_claudecode_oauth_profile(body),
    ("/api/opencode/state", "GET") => load_opencode_state(query),
    ("/api/opencode/config-save", "POST") => save_opencode_config(body),
    ("/api/opencode/raw-save", "POST") => save_opencode_raw_config(body),
    ("/api/opencode/install/start", "POST") => start_opencode_install_task(body),
    ("/api/opencode/install/status", "GET") => get_opencode_install_task(query),
    ("/api/opencode/install/cancel", "POST") => cancel_opencode_install_task(body),
    ("/api/opencode/install", "POST") => install_opencode(body),
    ("/api/opencode/reinstall", "POST") => reinstall_opencode(body),
    ("/api/opencode/update", "POST") => update_opencode(body),
    ("/api/opencode/uninstall", "POST") => uninstall_opencode(body),
    ("/api/opencode/launch", "POST") => launch_opencode(body),
    ("/api/opencode/login", "POST") => login_opencode(body),
    ("/api/opencode/auth-remove", "POST") => remove_opencode_auth(body),
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
    ("/api/openclaw/port-kill", "POST") => kill_openclaw_port_occupants(body),
    ("/api/system/storage", "GET") => get_system_storage_state(),
    ("/api/system/cleanup", "POST") => cleanup_system_storage(body),
    ("/api/open-url", "POST") => open_url_in_browser(body),
    ("/api/backups", "GET") => list_backups(),
    ("/api/backups/restore", "POST") => restore_backup(body),
    ("/api/network/status", "GET") => get_network_status(query),
    ("/api/network/check", "POST") => refresh_network_status(body),
    ("/api/network/latency", "GET") => get_network_latency(query),
    ("/api/network/ip-history", "GET") => list_network_ip_history(query),
    ("/api/app-settings", "GET") => load_app_settings(query),
    ("/api/app-settings", "POST") => save_app_settings(body),
    ("/api/system/processes", "GET") => list_processes(query),
    ("/api/system/process-kill", "POST") => kill_process(body),
    ("/api/codex/session-stats", "GET") => codex_session_stats(query),
    ("/api/claudecode/local-usage", "GET") => claudecode_local_usage(query),
    ("/api/app/update", "GET") => get_app_update_info(app).await,
    ("/api/app/update", "POST") => install_app_update(app).await,
    ("/api/app/update/progress", "GET") => get_app_update_progress(),
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
