//! Validate optional GitHub OAuth configuration and declare the Tauri IPC permissions.

fn check_github_client_id() {
    println!("cargo:rerun-if-env-changed=GITMINI_GITHUB_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=VITE_GITMINI_GITHUB_LOGIN");
    println!("cargo:rerun-if-env-changed=GITMINI_REQUIRE_CLIENT_ID");
    if std::env::var("VITE_GITMINI_GITHUB_LOGIN").as_deref() != Ok("1") {
        return;
    }
    let provided = std::env::var("GITMINI_GITHUB_CLIENT_ID").is_ok_and(|id| !id.trim().is_empty());
    if provided {
        return;
    }
    if std::env::var("GITMINI_REQUIRE_CLIENT_ID").as_deref() == Ok("1") {
        eprintln!("error: GitHub login is enabled but GITMINI_GITHUB_CLIENT_ID is missing");
        std::process::exit(1);
    }
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        println!(
            "cargo:warning=GitHub login has no OAuth client ID; configure it before distributing an enabled build"
        );
    }
}

fn main() {
    check_github_client_id();

    println!("cargo:rerun-if-changed=commands.txt");
    // `AppManifest::commands` requires `&'static str`: the build script is a short process, we let it leak.
    let list: &'static str = Box::leak(
        std::fs::read_to_string("commands.txt")
            .expect("commands.txt")
            .into_boxed_str(),
    );
    let commands: &'static [&'static str] = Box::leak(
        list.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .into_boxed_slice(),
    );
    let attrs = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(commands));
    tauri_build::try_build(attrs).expect("tauri-build");
}
