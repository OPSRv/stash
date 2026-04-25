fn main() {
    // `DisplayServices.framework` lives in PrivateFrameworks — the linker
    // doesn't search that directory by default. We add it only on macOS;
    // `cargo:rustc-link-search` with `framework=` signals a framework dir.
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-search=framework=/System/Library/PrivateFrameworks");

    // Note: the pre-3.5 CMake policy bump needed by `audiopus_sys` is
    // set via `.cargo/config.toml`'s [env] block so it propagates to
    // every dependency build script, not just this one.

    // sherpa-onnx (used by the speaker-diarization module) ships as
    // shared libraries linked through `@rpath/`. We emit two rpaths
    // so the same binary works in dev *and* after `tauri build`:
    //   1. `@executable_path/../Frameworks` — where the bundler will
    //      drop the dylibs (see `tauri.conf.json::bundle.macOS.frameworks`).
    //   2. The absolute path to the per-user sherpa-rs cache —
    //      so `cargo run` / `tauri dev` pick the dylibs up directly,
    //      no manual copy step. Hardcodes a user-specific path into
    //      the dev binary, which is fine: it never ships.
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");

    #[cfg(target_os = "macos")]
    stage_sherpa_dylibs();

    tauri_build::build()
}

/// Copy sherpa-onnx dylibs from the per-user `~/Library/Caches/sherpa-rs`
/// extraction dir into a stable `src-tauri/sherpa-libs/` so Tauri's
/// `bundle.macOS.frameworks` (which expects fixed paths) can find them.
/// No-op when the cache is missing — Cargo orders sherpa-rs-sys's
/// build script ahead of ours via the dependency graph, so by the
/// time we run the cache is populated.
#[cfg(target_os = "macos")]
fn stage_sherpa_dylibs() {
    use std::path::PathBuf;

    let cache_root = match dirs_next::cache_dir() {
        Some(d) => d.join("sherpa-rs"),
        None => return,
    };
    if !cache_root.exists() {
        return;
    }

    // Pick the freshest extracted archive — there's usually one for
    // the host triple, but we don't pin the version so a sherpa-rs
    // bump doesn't strand stale files.
    let mut latest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in walkdir(&cache_root) {
        let is_release_dir = entry
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with("sherpa-onnx-") && n.ends_with("-shared"))
            .unwrap_or(false);
        if !is_release_dir || !entry.is_dir() {
            continue;
        }
        let lib_dir = entry.join("lib");
        if !lib_dir.is_dir() {
            continue;
        }
        let mtime = std::fs::metadata(&lib_dir)
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        if latest.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
            latest = Some((mtime, lib_dir));
        }
    }
    let Some((_, src_lib)) = latest else { return };

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let dest = PathBuf::from(&manifest_dir).join("sherpa-libs");
    if let Err(e) = std::fs::create_dir_all(&dest) {
        eprintln!("cargo:warning=stage_sherpa_dylibs: mkdir {dest:?}: {e}");
        return;
    }
    // libonnxruntime.dylib is a symlink alias to the versioned one;
    // we only stage the real file so the bundler doesn't try to
    // double-sign or follow the link weirdly.
    for name in ["libsherpa-onnx-c-api.dylib", "libonnxruntime.1.17.1.dylib"] {
        let src = src_lib.join(name);
        let dst = dest.join(name);
        if !src.exists() {
            continue;
        }
        if let Err(e) = std::fs::copy(&src, &dst) {
            eprintln!("cargo:warning=stage_sherpa_dylibs: copy {name}: {e}");
        }
    }
    // Add the live cache dir as an rpath so dev binaries can resolve
    // `@rpath/libsherpa-onnx-c-api.dylib` without a Frameworks copy.
    // Release bundles ignore this entry — dyld tries each rpath in
    // order and the bundle's `@executable_path/../Frameworks` hits
    // first when the .app is moved off the dev machine.
    println!(
        "cargo:rustc-link-arg=-Wl,-rpath,{}",
        src_lib.display()
    );
    println!("cargo:rerun-if-changed={}", src_lib.display());
}

#[cfg(target_os = "macos")]
fn walkdir(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path();
        out.push(p.clone());
        if p.is_dir() {
            out.extend(walkdir(&p));
        }
    }
    out
}
