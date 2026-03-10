fn updater_runtime_var(name: &str, compile_time: Option<&'static str>) -> String {
  std::env::var(name)
    .ok()
    .filter(|value| !value.trim().is_empty())
    .or_else(|| compile_time.map(|value| value.to_string()).filter(|value| !value.trim().is_empty()))
    .unwrap_or_default()
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
  let explicit = updater_runtime_var("EASYAICONFIG_UPDATER_ENDPOINT", option_env!("EASYAICONFIG_UPDATER_ENDPOINT"));
  if !explicit.is_empty() {
    return explicit;
  }
  let repository = updater_repository();
  if repository.is_empty() {
    String::new()
  } else {
    format!("https://github.com/{repository}/releases/latest/download/latest.json")
  }
}

fn updater_config_state(app: &tauri::AppHandle) -> Value {
  let endpoint = updater_endpoint();
  let repository = updater_repository();
  let current_version = app.package_info().version.to_string();
  let public_key_configured = !updater_public_key().is_empty();
  let enabled = public_key_configured && !endpoint.is_empty();
  json!({
    "enabled": enabled,
    "configured": enabled,
    "publicKeyConfigured": public_key_configured,
    "repository": repository,
    "endpoint": endpoint,
    "currentVersion": current_version,
  })
}

fn build_updater(app: &tauri::AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
  let endpoint = updater_endpoint();
  let pubkey = updater_public_key();
  if endpoint.is_empty() || pubkey.is_empty() {
    return Err("自动更新尚未配置：请先在 GitHub Actions Secrets 中设置签名公钥与发布端点。".to_string());
  }

  let endpoint_url = Url::parse(&endpoint).map_err(|error| error.to_string())?;
  let updater = app
    .updater_builder()
    .pubkey(pubkey)
    .endpoints(vec![endpoint_url])
    .map_err(|error| error.to_string())?
    .timeout(Duration::from_secs(20))
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
      "repository": base.get("repository").cloned().unwrap_or(Value::Null),
      "publicKeyConfigured": base.get("publicKeyConfigured").cloned().unwrap_or(Value::Bool(false)),
    }));
  }

  let updater = build_updater(&app)?;
  let current_version = app.package_info().version.to_string();
  let endpoint = updater_endpoint();
  let repository = updater_repository();
  let github_endpoint = is_github_update_endpoint(&endpoint);

  match updater.check().await {
    Ok(Some(update)) => Ok(json!({
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
      "networkIssue": false,
      "networkBlocked": false,
    })),
    Ok(None) => Ok(json!({
      "enabled": true,
      "configured": true,
      "available": false,
      "currentVersion": current_version,
      "endpoint": endpoint,
      "repository": repository,
      "githubEndpoint": github_endpoint,
      "networkIssue": false,
      "networkBlocked": false,
    })),
    Err(error) => {
      let error_text = error.to_string();
      let network_issue = looks_like_network_issue(&error_text);
      let network_blocked = github_endpoint && network_issue;
      let status_message = if network_blocked {
        "你的网络可能无法访问 GitHub 更新源，暂时无法检查更新。"
      } else {
        "检查更新失败，请稍后重试。"
      };
      Ok(json!({
        "enabled": true,
        "configured": true,
        "available": false,
        "currentVersion": current_version,
        "endpoint": endpoint,
        "repository": repository,
        "githubEndpoint": github_endpoint,
        "networkIssue": network_issue,
        "networkBlocked": network_blocked,
        "statusMessage": status_message,
        "error": error_text,
      }))
    }
  }
}

pub(crate) async fn install_app_update(app: tauri::AppHandle) -> Result<Value, String> {
  let updater = build_updater(&app)?;
  let maybe_update = updater.check().await.map_err(|error| error.to_string())?;
  let Some(update) = maybe_update else {
    return Ok(json!({ "installed": false, "available": false }));
  };

  let version = update.version.clone();
  update
    .download_and_install(|_, _| {}, || {})
    .await
    .map_err(|error| error.to_string())?;

  let handle = app.clone();
  std::thread::spawn(move || {
    std::thread::sleep(Duration::from_millis(800));
    handle.request_restart();
  });

  Ok(json!({
    "installed": true,
    "available": true,
    "version": version,
    "restarting": true,
  }))
}
use serde_json::{json, Value};
use std::time::Duration;
use tauri_plugin_updater::UpdaterExt;
use url::Url;

