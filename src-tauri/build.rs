use std::fs;
use std::path::Path;

fn export_env(name: &str) {
    println!("cargo:rerun-if-env-changed={name}");
    if let Ok(value) = std::env::var(name) {
        if !value.trim().is_empty() {
            println!("cargo:rustc-env={name}={value}");
        }
    }
}

fn embed_r2_endpoint_from_file() {
    let path = Path::new("r2-public-base.url");
    println!("cargo:rerun-if-changed=r2-public-base.url");
    // CI/env 已显式设置时不覆盖
    if std::env::var("EASYAICONFIG_UPDATER_ENDPOINT")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
    {
        return;
    }
    let Ok(raw) = fs::read_to_string(path) else {
        return;
    };
    let base = raw
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .unwrap_or("")
        .trim_end_matches('/');
    if base.is_empty() {
        return;
    }
    let endpoint = if base.ends_with("latest.json") {
        base.to_string()
    } else {
        format!("{base}/latest.json")
    };
    println!("cargo:rustc-env=EASYAICONFIG_UPDATER_ENDPOINT={endpoint}");
}

fn main() {
    export_env("EASYAICONFIG_UPDATER_PUBLIC_KEY");
    export_env("EASYAICONFIG_UPDATER_ENDPOINT");
    export_env("EASYAICONFIG_GITHUB_REPOSITORY");
    embed_r2_endpoint_from_file();
    tauri_build::build();
}
