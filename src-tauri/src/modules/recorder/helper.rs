use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

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
    #[serde(default)]
    pub displays: Option<serde_json::Value>,
    #[serde(default)]
    pub cameras: Option<serde_json::Value>,
    #[serde(default)]
    pub microphones: Option<serde_json::Value>,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub rms: Option<f64>,
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
    pending_devices: Arc<Mutex<Option<SyncSender<HelperEvent>>>>,
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
        let pending_devices: Arc<Mutex<Option<SyncSender<HelperEvent>>>> =
            Arc::new(Mutex::new(None));

        let last_event_for_thread = Arc::clone(&last_event);
        let recording_path_for_thread = Arc::clone(&recording_path);
        let pending_devices_for_thread = Arc::clone(&pending_devices);
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
                            "devices" => {
                                if let Some(tx) =
                                    pending_devices_for_thread.lock().unwrap().take()
                                {
                                    let _ = tx.send(ev.clone());
                                }
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
            pending_devices,
        })
    }

    fn write_command(&self, json: &str) -> Result<(), String> {
        let mut stdin = self.stdin.lock().unwrap();
        stdin
            .write_all(json.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .map_err(|e| format!("write helper stdin: {e}"))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &self,
        output: &Path,
        mode: &str,
        mic: bool,
        fps: u32,
        display_id: Option<&str>,
        mic_ids: &[String],
        system_audio: bool,
        camera_id: Option<&str>,
        cam_overlay: Option<&serde_json::Value>,
        excluded_window_titles: &[String],
        source_gains: Option<&serde_json::Value>,
        muted_sources: &[String],
    ) -> Result<(), String> {
        let json = serde_json::json!({
            "cmd": "start",
            "mode": mode,
            "mic": mic,
            "fps": fps,
            "display_id": display_id,
            "mic_ids": mic_ids,
            "system_audio": system_audio,
            "camera_id": camera_id,
            "cam_overlay": cam_overlay,
            "excluded_window_titles": excluded_window_titles,
            "source_gains": source_gains,
            "muted_sources": muted_sources,
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

    /// Request the current device inventory and block until the helper replies
    /// with a `devices` event. Returns an error if the helper does not respond
    /// within a few seconds.
    pub fn list_devices(&self) -> Result<HelperEvent, String> {
        let (tx, rx) = sync_channel::<HelperEvent>(1);
        *self.pending_devices.lock().unwrap() = Some(tx);
        if let Err(e) = self.write_command(r#"{"cmd":"list_devices"}"#) {
            *self.pending_devices.lock().unwrap() = None;
            return Err(e);
        }
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|_| "list_devices: helper did not respond".to_string())
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
