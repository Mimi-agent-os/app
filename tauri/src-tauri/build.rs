fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["notify", "push_token", "quit_app", "open_link", "apps_attach", "app_body", "app_respond"]),
        ),
    )
    .expect("could not build the desktop command permissions");
}
