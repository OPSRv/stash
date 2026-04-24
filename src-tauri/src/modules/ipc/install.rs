//! `stash` CLI installer.
//!
//! The app bundles the CLI binary at `<Resources>/bin/stash`. The user
//! can symlink it onto their PATH either via `/usr/local/bin/stash`
//! (requires admin; typical Homebrew prefix) or `~/.local/bin/stash`
//! (no admin; must already be on the user's PATH to be effective).
//!
//! Uninstall removes the symlink only if it still points at *our*
//! resolved binary — we never blow away a file we don't own.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// Snapshot of install state surfaced to the Settings UI.
#[derive(Debug, Clone, serde::Serialize)]
pub struct StashCliStatus {
    /// `true` if the bundled binary exists (i.e. we have something to install).
    pub binary_available: bool,
    /// Absolute path to the bundled binary, or `None` if missing.
    pub binary_path: Option<String>,
    /// Absolute path of an active symlink that points at our binary.
    /// `None` means the CLI is not installed.
    pub installed_at: Option<String>,
}

/// Locate the bundled `stash` binary.
///
/// Production: `<Resources>/bin/stash` inside `Stash.app`.
/// Development fallback: `target/{release,debug}/stash` next to the
/// manifest — lets the Settings UI smoke-test the install flow before
/// a full app bundle exists.
fn resolve_binary(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        let candidate = res.join("bin").join("stash");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    for dev in [
        "target/release/stash",
        "target/debug/stash",
        "src-tauri/target/release/stash",
        "src-tauri/target/debug/stash",
    ] {
        let p = PathBuf::from(dev);
        if p.exists() {
            if let Ok(abs) = p.canonicalize() {
                return Some(abs);
            }
        }
    }
    None
}

/// Is `dir` currently listed in the user's `$PATH`? Exact match on
/// canonicalised components — no fuzzy prefix check.
fn path_contains(dir: &Path) -> bool {
    let Ok(path_env) = std::env::var("PATH") else {
        return false;
    };
    let target = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    std::env::split_paths(&path_env).any(|p| {
        let resolved = p.canonicalize().unwrap_or(p);
        resolved == target
    })
}

fn link_candidates() -> Vec<PathBuf> {
    let mut out = vec![PathBuf::from("/usr/local/bin/stash")];
    if let Some(home) = dirs_next::home_dir() {
        out.push(home.join(".local/bin/stash"));
    }
    out
}

fn existing_install(binary: &Path) -> Option<PathBuf> {
    for link in link_candidates() {
        // `read_link` returns the literal target stored in the symlink,
        // which we compare canonically with the binary path to avoid
        // false negatives from relative targets.
        if let Ok(target) = std::fs::read_link(&link) {
            let resolved = if target.is_absolute() {
                target
            } else {
                link.parent().map(|p| p.join(&target)).unwrap_or(target)
            };
            if let (Ok(a), Ok(b)) = (resolved.canonicalize(), binary.canonicalize()) {
                if a == b {
                    return Some(link);
                }
            }
        }
    }
    None
}

#[tauri::command]
pub fn stash_cli_status(app: AppHandle) -> StashCliStatus {
    let binary = resolve_binary(&app);
    let installed_at = binary
        .as_deref()
        .and_then(existing_install)
        .and_then(|p| p.into_os_string().into_string().ok());
    StashCliStatus {
        binary_available: binary.is_some(),
        binary_path: binary
            .clone()
            .and_then(|p| p.into_os_string().into_string().ok()),
        installed_at,
    }
}

/// Install the CLI. Preference order:
/// 1. `/usr/local/bin/stash` via `osascript` with admin privileges.
/// 2. `~/.local/bin/stash` (no admin, created if needed).
///
/// Returns the absolute symlink path that was created.
#[tauri::command]
pub fn stash_cli_install(app: AppHandle) -> Result<String, String> {
    let binary = resolve_binary(&app).ok_or_else(|| {
        "CLI binary not found — build the app or run `cargo build -p stash-cli --release`."
            .to_string()
    })?;
    let binary_str = binary
        .to_str()
        .ok_or_else(|| "binary path is not valid UTF-8".to_string())?;

    // Prefer /usr/local/bin only when it's actually on the user's PATH
    // — otherwise we'd pop an admin prompt to create a symlink the
    // shell can't even find. On Apple Silicon with Homebrew at
    // /opt/homebrew the directory exists but isn't in PATH for most
    // users, so plain `is_dir()` was misleading.
    if Path::new("/usr/local/bin").is_dir() && path_contains(Path::new("/usr/local/bin")) {
        // The literal command we run inside osascript; double quotes
        // around paths guard against spaces in HOME or install dirs.
        let shell = format!(
            "ln -sf \"{}\" \"/usr/local/bin/stash\"",
            binary_str.replace('"', "\\\"")
        );
        let status = std::process::Command::new("osascript")
            .arg("-e")
            .arg(format!(
                "do shell script \"{}\" with administrator privileges",
                shell.replace('\\', "\\\\").replace('"', "\\\"")
            ))
            .status()
            .map_err(|e| format!("spawn osascript: {e}"))?;
        if status.success() {
            return Ok("/usr/local/bin/stash".into());
        }
        // Fall through to ~/.local/bin on osascript failure (user
        // cancelled admin prompt, or it's unavailable).
    }

    let home = dirs_next::home_dir().ok_or_else(|| "no home directory".to_string())?;
    let local_dir = home.join(".local/bin");
    std::fs::create_dir_all(&local_dir)
        .map_err(|e| format!("create {}: {e}", local_dir.display()))?;
    let link = local_dir.join("stash");
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink(&binary, &link)
        .map_err(|e| format!("symlink {}: {e}", link.display()))?;
    link.into_os_string()
        .into_string()
        .map_err(|_| "link path is not valid UTF-8".into())
}

#[tauri::command]
pub fn stash_cli_uninstall(app: AppHandle) -> Result<(), String> {
    let Some(binary) = resolve_binary(&app) else {
        // Nothing to remove — if the binary is gone we can't verify
        // ownership of any existing symlink, so refuse by design.
        return Ok(());
    };
    let Some(link) = existing_install(&binary) else {
        return Ok(());
    };

    // `/usr/local/bin/stash` needs admin to remove; `~/.local/bin/stash`
    // does not. Both are symlinks owned by this user account *to us*,
    // so `rm -f` is safe.
    if link.starts_with("/usr/local/bin") {
        let shell = format!("rm -f \"{}\"", link.display());
        let status = std::process::Command::new("osascript")
            .arg("-e")
            .arg(format!(
                "do shell script \"{}\" with administrator privileges",
                shell.replace('\\', "\\\\").replace('"', "\\\"")
            ))
            .status()
            .map_err(|e| format!("spawn osascript: {e}"))?;
        if !status.success() {
            return Err("uninstall cancelled or failed".into());
        }
    } else {
        std::fs::remove_file(&link).map_err(|e| format!("remove {}: {e}", link.display()))?;
    }
    Ok(())
}
