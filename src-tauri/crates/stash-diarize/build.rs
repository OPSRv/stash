// Sidecar binary for offline speaker diarization. Linked against the
// sherpa-onnx C API dylib at compile time, but the dylib is *not*
// shipped inside the macOS .app bundle — the main app downloads it on
// demand into `$APPLOCALDATA/diarization/lib/` and runs us from
// `$APPLOCALDATA/diarization/bin/`. We add an `@loader_path/../lib`
// rpath so dyld finds the dylib relative to the binary's own location,
// no matter where the user installed it.
//
// A second rpath points at the active sherpa-rs cache so `cargo run`
// works in dev without the staged install layout.
fn main() {
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path/../lib");
        if let Some(cache) = sherpa_cache_lib_dir() {
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", cache.display());
            println!("cargo:rerun-if-changed={}", cache.display());
        }
    }
}

#[cfg(target_os = "macos")]
fn sherpa_cache_lib_dir() -> Option<std::path::PathBuf> {
    let root = dirs_next::cache_dir()?.join("sherpa-rs");
    if !root.exists() {
        return None;
    }
    // Newest extracted `sherpa-onnx-*-shared/lib` wins, matching the
    // logic in the main app's build.rs.
    let mut latest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    walk(&root, &mut |p| {
        let is_release = p
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with("sherpa-onnx-") && n.ends_with("-shared"))
            .unwrap_or(false);
        if !is_release || !p.is_dir() {
            return;
        }
        let lib = p.join("lib");
        if !lib.is_dir() {
            return;
        }
        let mtime = std::fs::metadata(&lib)
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        if latest.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
            latest = Some((mtime, lib));
        }
    });
    latest.map(|(_, p)| p)
}

#[cfg(target_os = "macos")]
fn walk(root: &std::path::Path, f: &mut impl FnMut(&std::path::Path)) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        f(&p);
        if p.is_dir() {
            walk(&p, f);
        }
    }
}
