use serde_json::{json, Value};

use crate::codex::{
  check_setup_environment, codex_npm_action, get_codex_release_info, launch_codex,
  login_codex, get_codex_usage_metrics, list_codex_sessions, get_codex_session_detail,
  list_codex_session_homes, migrate_codex_sessions,
  resume_codex_session, fork_codex_session, export_codex_session,
  get_codex_app_state, install_codex_app, open_codex_app,
  list_tools, load_claudecode_state, model_eval_claudecode_provider, save_claudecode_config, save_claudecode_raw_config,
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
  read_config_file, restore_backup, save_config, save_raw_config, save_settings, set_default_model,
  test_saved_provider, model_eval_saved_provider, use_oauth_config, write_config_file,
};

use crate::oauth_profiles::{
  create_oauth_profile, delete_oauth_profile, list_oauth_profiles, rename_oauth_profile,
  save_current_oauth_profile, switch_oauth_profile,
};
use crate::claudecode_oauth_profiles::{
  create_claudecode_oauth_profile, delete_claudecode_oauth_profile, list_claudecode_oauth_profiles,
  rename_claudecode_oauth_profile, switch_claudecode_oauth_profile,
};
use crate::app_settings::{load_app_settings, save_app_settings};
use crate::shell_integration::{
  disable_shell_integration, enable_shell_integration, shell_integration_status,
};
use crate::network::{
  get_network_latency, get_network_status, list_network_ip_history, refresh_network_status,
};
use crate::processes::{kill_process, list_processes};
use crate::provider::detect_provider;
use crate::provider_router::{
  probe_provider_router, query_provider_router_status, start_provider_router, stop_provider_router,
};
use crate::provider_remote_usage::{
  delete_provider_remote_usage_credential, get_provider_remote_usage_credential,
  query_saved_provider_remote_usage, save_provider_remote_usage_credential,
};
use crate::provider_remote_usage_cache::{
  list_provider_remote_usage_cache, save_provider_remote_usage_cache,
};
use crate::codex_oauth_usage::query_codex_oauth_usage;
use crate::usage_stats::{claudecode_local_usage, codex_session_stats};
use crate::updater::{get_app_update_info, get_app_update_progress, install_app_update};
use crate::terminal::{terminal_close, terminal_create, terminal_list, terminal_read, terminal_resize, terminal_write};
use crate::{fail, ok, OPENAI_CODEX_PACKAGE, CLAUDE_CODE_PACKAGE, OPENCLAW_PACKAGE};

async fn dispatch(app: tauri::AppHandle, path: &str, method: &str, query: &Value, body: &Value) -> Result<Value, String> {
  match (path, method) {
    ("/api/setup/check", "GET") => check_setup_environment(query),
    ("/api/state", "GET") => load_state(query),
    ("/api/path/pick-directory", "POST") => pick_directory(app, body),
    ("/api/provider/test", "POST") => detect_provider(body).await,
    ("/api/provider/secret", "POST") => get_provider_secret(body),
    ("/api/provider/test-saved", "POST") => test_saved_provider(body).await,
    ("/api/provider/remote-usage", "POST") => query_saved_provider_remote_usage(body).await,
    ("/api/provider/remote-usage/cache", "GET") => list_provider_remote_usage_cache(query),
    ("/api/provider/remote-usage/cache", "POST") => save_provider_remote_usage_cache(body),
    ("/api/provider/remote-usage/credential", "GET") => get_provider_remote_usage_credential(query),
    ("/api/provider/remote-usage/credential", "POST") => save_provider_remote_usage_credential(body),
    ("/api/provider/remote-usage/credential", "DELETE") => delete_provider_remote_usage_credential(body),
    ("/api/provider-router/status", "GET") => query_provider_router_status(query),
    ("/api/provider-router/start", "POST") => start_provider_router(body),
    ("/api/provider-router/probe", "POST") => probe_provider_router(body),
    ("/api/provider-router/stop", "POST") => stop_provider_router(body),
    ("/api/provider/model-eval", "POST") => {
      let tool = body.get("tool").and_then(Value::as_str).unwrap_or("codex").trim().to_lowercase();
      if tool == "claudecode" {
        model_eval_claudecode_provider(body).await
      } else {
        model_eval_saved_provider(body).await
      }
    },
    ("/api/config/read-file", "GET") => read_config_file(query),
    ("/api/config/write-file", "POST") => write_config_file(body),
    ("/api/config/save", "POST") => save_config(body),
    ("/api/config/set-default-model", "POST") => set_default_model(body),
    ("/api/config/delete-provider", "POST") => delete_codex_provider(body),
    ("/api/config/use-oauth", "POST") => use_oauth_config(body),
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
    ("/api/codex/oauth/profiles/create", "POST") => create_oauth_profile(body),
    ("/api/codex/oauth/profiles/save-current", "POST") => save_current_oauth_profile(body),
    ("/api/codex/oauth/profiles/switch", "POST") => switch_oauth_profile(body),
    ("/api/codex/oauth/profiles/rename", "POST") => rename_oauth_profile(body),
    ("/api/codex/oauth/profiles/delete", "POST") => delete_oauth_profile(body),
    ("/api/codex/oauth/usage", "POST") => query_codex_oauth_usage(body).await,
    ("/api/provider/probe-history", "GET") => crate::provider_health::get_probe_history(query),
    ("/api/provider/probe-summary", "GET") => crate::provider_health::get_probe_summary(query),
    ("/api/tray/refresh", "POST") => crate::tray::refresh_menu(&app, body),
    ("/api/terminal/token-snapshot", "GET") => crate::terminal::terminal_token_snapshot(query),
    ("/api/terminal/persisted", "GET") => crate::terminal_persist::list_persisted(query),
    ("/api/terminal/persist", "POST") => crate::terminal_persist::persist_session(body),
    ("/api/terminal/forget", "POST") => crate::terminal_persist::forget_session(body),
    ("/api/provider/saved-models", "GET") => crate::provider_models::list_saved_models(query),
    ("/api/provider/saved-models", "POST") => crate::provider_models::save_provider_models(body),
    ("/api/codex/sessions", "GET") => list_codex_sessions(query),
    ("/api/codex/session-detail", "GET") => get_codex_session_detail(query),
    ("/api/codex/resume", "POST") => resume_codex_session(body),
    ("/api/codex/fork", "POST") => fork_codex_session(body),
    ("/api/codex/session-export", "POST") => export_codex_session(body),
    ("/api/codex/session-homes", "GET") => list_codex_session_homes(query),
    ("/api/codex/sessions/migrate", "POST") => migrate_codex_sessions(body),
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
    // Network probes do synchronous blocking HTTP via reqwest::blocking. If
    // we called them directly from this async dispatch they'd risk nesting
    // tokio runtimes and deadlocking (which would look like a timeout to the
    // user — exactly the "无法获取 IP" report). spawn_blocking moves them to
    // a worker thread so the main reactor stays live.
    ("/api/network/status", "GET") => {
      let q = query.clone();
      tokio::task::spawn_blocking(move || get_network_status(&q))
        .await
        .map_err(|e| format!("spawn_blocking: {}", e))?
    },
    ("/api/network/check", "POST") => {
      let b = body.clone();
      tokio::task::spawn_blocking(move || refresh_network_status(&b))
        .await
        .map_err(|e| format!("spawn_blocking: {}", e))?
    },
    ("/api/network/latency", "GET") => {
      let q = query.clone();
      tokio::task::spawn_blocking(move || get_network_latency(&q))
        .await
        .map_err(|e| format!("spawn_blocking: {}", e))?
    },
    ("/api/network/ip-history", "GET") => list_network_ip_history(query),
    ("/api/app-settings", "GET") => load_app_settings(query),
    ("/api/app-settings", "POST") => save_app_settings(body),
    ("/api/terminal/create", "POST") => terminal_create(body),
    ("/api/terminal/list", "GET") => terminal_list(query),
    ("/api/terminal/read", "GET") => terminal_read(query),
    ("/api/terminal/write", "POST") => terminal_write(body),
    ("/api/terminal/resize", "POST") => terminal_resize(body),
    ("/api/terminal/close", "POST") => terminal_close(body),
    ("/api/shell-integration/status", "GET") => shell_integration_status(query),
    ("/api/shell-integration/enable", "POST") => enable_shell_integration(body),
    ("/api/shell-integration/disable", "POST") => disable_shell_integration(body),
    ("/api/system/processes", "GET") => list_processes(query),
    ("/api/system/process-kill", "POST") => kill_process(body),
    ("/api/codex/session-stats", "GET") => codex_session_stats(query),
    ("/api/claudecode/local-usage", "GET") => claudecode_local_usage(query),
    ("/api/app/update", "GET") => get_app_update_info(app).await,
    ("/api/app/update", "POST") => install_app_update(app).await,
    ("/api/app/update/progress", "GET") => get_app_update_progress(),

    // ─── Per-project Provider binding (P0 #3 ⭐) ─────────────────
    ("/api/project-binding", "GET") => crate::project_bindings::get_project_binding(query),
    ("/api/project-binding", "POST") => crate::project_bindings::set_project_binding(body),
    ("/api/project-binding", "DELETE") => crate::project_bindings::remove_project_binding(body),
    ("/api/project-bindings", "GET") => crate::project_bindings::list_project_bindings(query),
    ("/api/project-binding/summary", "GET") => crate::project_bindings::summarize_binding_for_cwd(query),

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
