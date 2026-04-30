fn main() {
    // `DisplayServices.framework` lives in PrivateFrameworks — the linker
    // doesn't search that directory by default. We add it only on macOS;
    // `cargo:rustc-link-search` with `framework=` signals a framework dir.
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-search=framework=/System/Library/PrivateFrameworks");

    // Note: the pre-3.5 CMake policy bump needed by `audiopus_sys` is
    // set via `.cargo/config.toml`'s [env] block so it propagates to
    // every dependency build script, not just this one.
    //
    // Speaker diarization was previously linked here through `sherpa-rs`;
    // it now lives in the `stash-diarize` sidecar binary, downloaded on
    // demand into `$APPLOCALDATA/diarization/`. The main app no longer
    // ships any sherpa-onnx libraries, so there's nothing to stage and
    // no rpath to register.

    tauri_build::build()
}
