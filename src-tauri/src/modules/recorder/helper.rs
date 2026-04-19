use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

/// Incoming events emitted by the Swift helper.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelperEvent {
    pub event: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub recording: Option<bool>,
    #[serde(default)]
    pub pid: Option<i64>,
    #[serde(default)]
    pub screen: Option<bool>,
    #[serde(default)]
    pub microphone: Option<bool>,
    #[serde(default)]
    pub camera: Option<bool>,
}

/// One running helper process. Holds stdin for sending commands and a shared
/// "latest event" buffer filled by a background reader thread. The shared
/// buffer is also optionally forwarded to a callback so Tauri can re-emit
/// events to the frontend.
#[allow(dead_code)]
pub struct Helper {
    child: Child,
    stdin: Mutex<ChildStdin>,
    last_event: Arc<Mutex<Option<HelperEvent>>>,
    recording_path: Arc<Mutex<Option<String>>>,
}

#[allow(dead_code)]

impl Helper {
    /// Launch `binary_path` and start draining its stdout on a background
    /// thread. Each decoded event is passed to `on_event` for re-emission
    /// and cached so `status()` queries can answer without another round-trip.
    pub fn spawn<F>(binary_path: &Path, on_event: F) -> Result<Self, String>
    where
        F: Fn(&HelperEvent) + Send + 'static,
    {
        let mut child = Command::new(binary_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn recorder helper: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "no stdin on helper".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "no stdout on helper".to_string())?;
        let stderr = child.stderr.take();

        let last_event: Arc<Mutex<Option<HelperEvent>>> = Arc::new(Mutex::new(None));
        let recording_path: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let last_event_for_thread = Arc::clone(&last_event);
        let recording_path_for_thread = Arc::clone(&recording_path);
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<HelperEvent>(trimmed) {
                    Ok(ev) => {
                        // Keep track of current recording path so cancellation
                        // and completion handlers can locate the output file.
                        match ev.event.as_str() {
                            "recording_started" => {
                                if let Some(p) = ev.path.clone() {
                                    *recording_path_for_thread.lock().unwrap() = Some(p);
                                }
                            }
                            "stopped" => {
                                *recording_path_for_thread.lock().unwrap() = None;
                            }
                            _ => {}
                        }
                        on_event(&ev);
                        *last_event_for_thread.lock().unwrap() = Some(ev);
                    }
                    Err(e) => eprintln!("[recorder] bad event json: {e} ({trimmed})"),
                }
            }
        });

        if let Some(stderr) = stderr {
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    eprintln!("[recorder/stderr] {line}");
                }
            });
        }

        Ok(Self {
            child,
            stdin: Mutex::new(stdin),
            last_event,
            recording_path,
        })
    }

    fn write_command(&self, json: &str) -> Result<(), String> {
        let mut stdin = self.stdin.lock().unwrap();
        stdin
            .write_all(json.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .map_err(|e| format!("write helper stdin: {e}"))
    }

    pub fn start(
        &self,
        output: &Path,
        mode: &str,
        mic: bool,
        fps: u32,
    ) -> Result<(), String> {
        let json = serde_json::json!({
            "cmd": "start",
            "mode": mode,
            "mic": mic,
            "fps": fps,
            "output": output.display().to_string(),
        })
        .to_string();
        self.write_command(&json)
    }

    pub fn stop(&self) -> Result<(), String> {
        self.write_command(r#"{"cmd":"stop"}"#)
    }

    pub fn status(&self) -> Result<(), String> {
        self.write_command(r#"{"cmd":"status"}"#)
    }

    pub fn probe_permissions(&self) -> Result<(), String> {
        self.write_command(r#"{"cmd":"probe_permissions"}"#)
    }

    pub fn last_event(&self) -> Option<HelperEvent> {
        self.last_event.lock().unwrap().clone()
    }

    pub fn current_recording_path(&self) -> Option<PathBuf> {
        self.recording_path
            .lock()
            .unwrap()
            .as_deref()
            .map(PathBuf::from)
    }

    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn shutdown(mut self) {
        let _ = self.write_command(r#"{"cmd":"quit"}"#);
        let _ = self.child.wait();
    }
}

/// Return the first usable helper binary: either `~/Movies/Stash/bin/stash-recorder`
/// (ad-hoc installed) or the SwiftPM `release` build inside the repo (dev mode).
pub fn resolve_helper(bin_dir: &Path) -> Option<PathBuf> {
    let installed = bin_dir.join("stash-recorder");
    if installed.exists() {
        return Some(installed);
    }
    // Dev fallback: if the Swift package has been built in the repo, use it.
    if let Ok(cwd) = std::env::current_dir() {
        // `src-tauri` is the cwd during `tauri dev` — the helper lives two up.
        let repo_root = cwd
            .ancestors()
            .find(|p| p.join("helpers/recorder-swift").is_dir())?
            .to_path_buf();
        let candidate = repo_root
            .join("helpers/recorder-swift/.build/release/stash-recorder");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}
