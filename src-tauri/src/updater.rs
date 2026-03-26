fn updater_runtime_var(name: &str, compile_time: Option<&'static str>) -> String {
  std::env::var(name)
    .ok()
    .filter(|value| !value.trim().is_empty())
    .or_else(|| compile_time.map(|value| value.to_string()).filter(|value| !value.trim().is_empty()))
    .unwrap_or_default()
}

static APP_UPDATE_PROGRESS: OnceLock<Mutex<Value>> = OnceLock::new();

fn app_update_progress_store() -> &'static Mutex<Value> {
  APP_UPDATE_PROGRESS.get_or_init(|| Mutex::new(json!({
    "status": "idle",
    "message": "",
    "version": "",
    "downloadedBytes": 0,
    "totalBytes": 0,
    "percent": 0,
    "error": "",
  })))
}

fn set_app_update_progress(
  status: &str,
  message: &str,
  version: &str,
  downloaded_bytes: u64,
  total_bytes: u64,
  error: &str,
) {
  let percent = if total_bytes > 0 {
    ((downloaded_bytes as f64 / total_bytes as f64) * 100.0).clamp(0.0, 100.0)
  } else if status == "installing" || status == "done" {
    100.0
  } else {
    0.0
  };
  if let Ok(mut state) = app_update_progress_store().lock() {
    *state = json!({
      "status": status,
      "message": message,
      "version": version,
      "downloadedBytes": downloaded_bytes,
      "totalBytes": total_bytes,
      "percent": percent,
      "error": error,
    });
  }
}

fn decorate_install_error(error_text: &str) -> String {
  let lower = error_text.to_ascii_lowercase();
  if lower.contains("signature") || lower.contains("verify") {
    return format!("更新包签名校验失败：{error_text}。请稍后重试，或手动下载最新安装包覆盖安装。");
  }
  if lower.contains("permission denied") || lower.contains("operation not permitted") {
    return format!("更新安装被系统权限拦截：{error_text}。请检查系统权限后重试。");
  }
  if lower.contains("no space left") || lower.contains("disk full") {
    return format!("磁盘空间不足，无法完成更新：{error_text}。请释放空间后重试。");
  }
  if looks_like_network_issue(error_text) {
    return format!("更新下载失败（网络异常）：{error_text}。请确认网络可访问更新源（R2/GitHub）后重试。");
  }
  format!("更新下载或安装失败：{error_text}")
}

fn updater_repository() -> String {
  let from_env = updater_runtime_var("EASYAICONFIG_GITHUB_REPOSITORY", option_env!("EASYAICONFIG_GITHUB_REPOSITORY"));
  if !from_env.is_empty() {
    return from_env;
  }
  // Fallback: infer from the endpoint in tauri.conf.json
  "lmk1010/EasyAIConfig".to_string()
}

fn updater_public_key() -> String {
  let from_env = updater_runtime_var("EASYAICONFIG_UPDATER_PUBLIC_KEY", option_env!("EASYAICONFIG_UPDATER_PUBLIC_KEY"));
  if !from_env.is_empty() {
    return from_env;
  }
  // Fallback: use the pubkey from tauri.conf.json plugins.updater.pubkey
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEZEQkRGQjdGOTdBQkI0ClJXUzBxNWQvKzczOUFEbDFSZ1VRTWxIaitBZ3pMU21EekJud0NCRkw1MWIzbXZ6UWtnUUszaUZFCg==".to_string()
}

fn updater_endpoint() -> String {
  updater_endpoints().first().cloned().unwrap_or_default()
}

fn github_latest_json_endpoint(repository: &str) -> String {
  format!("https://github.com/{repository}/releases/latest/download/latest.json")
}

fn updater_endpoints() -> Vec<String> {
  let explicit = updater_runtime_var(
    "EASYAICONFIG_UPDATER_ENDPOINT",
    option_env!("EASYAICONFIG_UPDATER_ENDPOINT"),
  );
  let github = github_latest_json_endpoint(&updater_repository());
  let mut endpoints = Vec::new();
  if !explicit.is_empty() {
    endpoints.push(explicit);
  }
  if !github.is_empty() && !endpoints.iter().any(|value| value == &github) {
    endpoints.push(github);
  }
  endpoints
}

fn updater_config_state(app: &tauri::AppHandle) -> Value {
  let endpoints = updater_endpoints();
  let endpoint = endpoints.first().cloned().unwrap_or_default();
  let fallback_endpoint = endpoints.get(1).cloned().unwrap_or_default();
  let repository = updater_repository();
  let current_version = app.package_info().version.to_string();
  let public_key_configured = !updater_public_key().is_empty();
  let enabled = public_key_configured && !endpoints.is_empty();
  json!({
    "enabled": enabled,
    "configured": enabled,
    "publicKeyConfigured": public_key_configured,
    "repository": repository,
    "endpoint": endpoint,
    "fallbackEndpoint": fallback_endpoint,
    "endpoints": endpoints,
    "currentVersion": current_version,
  })
}

fn build_updater(app: &tauri::AppHandle, endpoint: &str) -> Result<tauri_plugin_updater::Updater, String> {
  let pubkey = updater_public_key();
  if endpoint.is_empty() || pubkey.is_empty() {
    return Err("自动更新尚未配置：请先在 GitHub Actions Secrets 中设置签名公钥与发布端点。".to_string());
  }

  let endpoint_url = Url::parse(endpoint).map_err(|error| error.to_string())?;
  let updater = app
    .updater_builder()
    .pubkey(pubkey)
    .endpoints(vec![endpoint_url])
    .map_err(|error| error.to_string())?
    .timeout(Duration::from_secs(180))
    .build()
    .map_err(|error| error.to_string())?;

  Ok(updater)
}

fn is_github_update_endpoint(endpoint: &str) -> bool {
  Url::parse(endpoint)
    .ok()
    .and_then(|url| url.host_str().map(|host| host.to_ascii_lowercase()))
    .map(|host| host.contains("github.com") || host.contains("githubusercontent.com"))
    .unwrap_or_else(|| endpoint.to_ascii_lowercase().contains("github.com"))
}

fn looks_like_network_issue(error: &str) -> bool {
  let lower = error.to_ascii_lowercase();
  [
    "dns",
    "failed to lookup",
    "failed to connect",
    "connection refused",
    "connection reset",
    "network",
    "timed out",
    "timeout",
    "unreachable",
    "tls",
    "certificate",
    "invalid peer certificate",
    "could not resolve host",
    "host not found",
    "request failed",
  ]
  .iter()
  .any(|needle| lower.contains(needle))
}

pub(crate) async fn get_app_update_info(app: tauri::AppHandle) -> Result<Value, String> {
  let base = updater_config_state(&app);
  if !base.get("enabled").and_then(Value::as_bool).unwrap_or(false) {
    return Ok(json!({
      "enabled": false,
      "configured": false,
      "available": false,
      "currentVersion": base.get("currentVersion").cloned().unwrap_or(Value::Null),
      "endpoint": base.get("endpoint").cloned().unwrap_or(Value::Null),
      "fallbackEndpoint": base.get("fallbackEndpoint").cloned().unwrap_or(Value::Null),
      "repository": base.get("repository").cloned().unwrap_or(Value::Null),
      "publicKeyConfigured": base.get("publicKeyConfigured").cloned().unwrap_or(Value::Bool(false)),
    }));
  }

  let current_version = app.package_info().version.to_string();
  let repository = updater_repository();
  let endpoints = updater_endpoints();
  let mut last_error = "检查更新失败，请稍后重试。".to_string();
  let mut last_endpoint = updater_endpoint();

  for (index, endpoint) in endpoints.iter().enumerate() {
    let updater = match build_updater(&app, endpoint) {
      Ok(value) => value,
      Err(error) => {
        last_error = error;
        last_endpoint = endpoint.clone();
        if index + 1 < endpoints.len() {
          continue;
        }
        break;
      }
    };

    let github_endpoint = is_github_update_endpoint(endpoint);
    match updater.check().await {
      Ok(Some(update)) => {
        return Ok(json!({
          "enabled": true,
          "configured": true,
          "available": true,
          "currentVersion": current_version,
          "version": update.version,
          "body": update.body,
          "date": update.date.map(|value| value.to_string()),
          "target": update.target,
          "downloadUrl": update.download_url.to_string(),
          "endpoint": endpoint,
          "repository": repository,
          "rawJson": update.raw_json,
          "githubEndpoint": github_endpoint,
          "fallbackUsed": index > 0,
          "networkIssue": false,
          "networkBlocked": false,
        }));
      }
      Ok(None) => {
        return Ok(json!({
          "enabled": true,
          "configured": true,
          "available": false,
          "currentVersion": current_version,
          "endpoint": endpoint,
          "repository": repository,
          "githubEndpoint": github_endpoint,
          "fallbackUsed": index > 0,
          "networkIssue": false,
          "networkBlocked": false,
        }));
      }
      Err(error) => {
        last_error = error.to_string();
        last_endpoint = endpoint.clone();
        if index + 1 < endpoints.len() {
          continue;
        }
      }
    }
  }

  let github_endpoint = is_github_update_endpoint(&last_endpoint);
  let network_issue = looks_like_network_issue(&last_error);
  let network_blocked = github_endpoint && network_issue;
  let status_message = if network_blocked {
    "你的网络可能无法访问 GitHub 更新源，暂时无法检查更新。"
  } else if endpoints.len() > 1 {
    "主更新源不可用，备用更新源也检查失败。"
  } else {
    "检查更新失败，请稍后重试。"
  };

  Ok(json!({
    "enabled": true,
    "configured": true,
    "available": false,
    "currentVersion": current_version,
    "endpoint": last_endpoint,
    "repository": repository,
    "githubEndpoint": github_endpoint,
    "networkIssue": network_issue,
    "networkBlocked": network_blocked,
    "statusMessage": status_message,
    "error": last_error,
  }))
}

pub(crate) fn get_app_update_progress() -> Result<Value, String> {
  let state = app_update_progress_store()
    .lock()
    .map_err(|_| "读取更新进度失败".to_string())?;
  Ok(state.clone())
}

pub(crate) async fn install_app_update(app: tauri::AppHandle) -> Result<Value, String> {
  set_app_update_progress("checking", "正在检查更新包", "", 0, 0, "");
  let endpoints = updater_endpoints();
  if endpoints.is_empty() || updater_public_key().is_empty() {
    let text = "自动更新尚未配置：请先在 GitHub Actions Secrets 中设置签名公钥与发布端点。".to_string();
    set_app_update_progress("error", "检查更新失败", "", 0, 0, &text);
    return Err(text);
  }

  let mut maybe_update = None;
  let mut selected_endpoint = String::new();
  let mut fallback_used = false;
  for (index, endpoint) in endpoints.iter().enumerate() {
    let updater = match build_updater(&app, endpoint) {
      Ok(value) => value,
      Err(error) => {
        if index + 1 < endpoints.len() {
          set_app_update_progress("checking", "主更新源不可用，正在切换备用源", "", 0, 0, "");
          continue;
        }
        let text = decorate_install_error(&error);
        set_app_update_progress("error", "检查更新失败", "", 0, 0, &text);
        return Err(text);
      }
    };

    match updater.check().await {
      Ok(update) => {
        maybe_update = update;
        selected_endpoint = endpoint.clone();
        fallback_used = index > 0;
        break;
      }
      Err(error) => {
        let error_text = error.to_string();
        if index + 1 < endpoints.len() {
          set_app_update_progress("checking", "主更新源不可用，正在切换备用源", "", 0, 0, "");
          continue;
        }
        let text = decorate_install_error(&error_text);
        set_app_update_progress("error", "检查更新失败", "", 0, 0, &text);
        return Err(text);
      }
    }
  }

  let Some(update) = maybe_update else {
    set_app_update_progress("done", "当前已是最新版本", "", 0, 0, "");
    return Ok(json!({
      "installed": false,
      "available": false,
      "endpoint": selected_endpoint,
      "fallbackUsed": fallback_used,
    }));
  };

  let version = update.version.clone();
  set_app_update_progress("downloading", "正在下载更新包", &version, 0, 0, "");
  let downloaded_bytes = Arc::new(AtomicU64::new(0));
  let total_bytes = Arc::new(AtomicU64::new(0));
  let downloaded_for_chunk = Arc::clone(&downloaded_bytes);
  let total_for_chunk = Arc::clone(&total_bytes);
  let total_for_install = Arc::clone(&total_bytes);
  let version_for_chunk = version.clone();
  let version_for_install = version.clone();
  update
    .download_and_install(
      |chunk_length, content_length| {
        let downloaded = downloaded_for_chunk
          .fetch_add(chunk_length as u64, Ordering::Relaxed)
          .saturating_add(chunk_length as u64);
        if let Some(total) = content_length {
          total_for_chunk.store(total, Ordering::Relaxed);
        }
        let total = total_for_chunk.load(Ordering::Relaxed);
        set_app_update_progress(
          "downloading",
          "正在下载更新包",
          &version_for_chunk,
          downloaded,
          total,
          "",
        );
      },
      || {
        let total = total_for_install.load(Ordering::Relaxed);
        set_app_update_progress("installing", "下载完成，正在安装", &version_for_install, total, total, "");
      },
    )
    .await
    .map_err(|error| {
      let text = decorate_install_error(&error.to_string());
      let downloaded = downloaded_bytes.load(Ordering::Relaxed);
      let total = total_bytes.load(Ordering::Relaxed);
      set_app_update_progress("error", "更新失败", &version, downloaded, total, &text);
      text
    })?;

  let total = total_bytes.load(Ordering::Relaxed);
  set_app_update_progress("done", "更新完成，应用即将重启", &version, total, total, "");

  let handle = app.clone();
  std::thread::spawn(move || {
    std::thread::sleep(Duration::from_millis(800));
    handle.request_restart();
  });

  Ok(json!({
    "installed": true,
    "available": true,
    "version": version,
    "endpoint": selected_endpoint,
    "fallbackUsed": fallback_used,
    "restarting": true,
  }))
}
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri_plugin_updater::UpdaterExt;
use url::Url;
