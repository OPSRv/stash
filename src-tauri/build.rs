fn main() {
    // `DisplayServices.framework` lives in PrivateFrameworks — the linker
    // doesn't search that directory by default. We add it only on macOS;
    // `cargo:rustc-link-search` with `framework=` signals a framework dir.
    #[cfg(target_os = "macos")]
    println!(
        "cargo:rustc-link-search=framework=/System/Library/PrivateFrameworks"
    );

    tauri_build::build()
}
