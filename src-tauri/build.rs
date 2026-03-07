fn export_env(name: &str) {
  println!("cargo:rerun-if-env-changed={name}");
  if let Ok(value) = std::env::var(name) {
    println!("cargo:rustc-env={name}={value}");
  }
}

fn main() {
  export_env("EASYAICONFIG_UPDATER_PUBLIC_KEY");
  export_env("EASYAICONFIG_UPDATER_ENDPOINT");
  export_env("EASYAICONFIG_GITHUB_REPOSITORY");
  tauri_build::build()
}
