//! Valeton GP-5 transport bridge.
//!
//! WKWebView exposes neither Web MIDI nor Web Bluetooth, so the raw byte I/O
//! for the `valeton-editor` frontend module lives here. This layer is a dumb
//! pipe: it knows nothing about the GP-5 sysex protocol (that all stays in the
//! frontend). It only:
//!   * opens a USB-MIDI port whose name contains `GP-5` (via `midir`), or a
//!     BLE-MIDI GATT characteristic (via `btleplug`),
//!   * forwards fully-framed outgoing messages verbatim (`valeton_send`),
//!   * emits incoming bytes to the frontend as `valeton:rx` events.
//!
//! USB sysex is reassembled byte-wise (F0…F7) before emitting, since CoreMIDI
//! may split a long dump across packets. BLE notifications are forwarded as-is
//! (each notification already carries one logical BLE-MIDI message).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use btleplug::api::{
    Central, Characteristic, Manager as _, Peripheral as _, ScanFilter, WriteType,
};
use btleplug::platform::{Manager, Peripheral};
use futures_util::StreamExt;
use midir::{MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

/// BLE-MIDI service / characteristic UUIDs (Valeton GP-5 — standard
/// MIDI-over-Bluetooth-LE service).
const SERVICE_UUID: Uuid = Uuid::from_u128(0x03b80e5a_ede8_4b33_a751_6ce34ec4c700);
const CHARACTERISTIC_UUID: Uuid = Uuid::from_u128(0x7772e5db_3868_4112_a1a9_f2669d106bf3);

/// Substring identifying a GP-5 CoreMIDI endpoint (USB or the persistent
/// Bluetooth-MIDI port macOS keeps around).
const GP5_PORT_MARKER: &str = "GP-5";

/// How often the USB watcher re-enumerates CoreMIDI ports.
const USB_WATCH_INTERVAL_MS: u64 = 2000;
/// Consecutive misses before declaring the USB device gone (tolerates a
/// transient enumeration hiccup — ~`MISSES × INTERVAL` of grace).
const USB_WATCH_MISSES: u8 = 2;

fn is_gp5_port_name(name: &str) -> bool {
    name.contains(GP5_PORT_MARKER)
}

/// Is a GP-5 input port currently present in CoreMIDI? Used by the watcher to
/// detect unplug. Errors enumerating are treated as "still present" so a
/// momentary failure never triggers a false disconnect.
fn gp5_usb_port_present() -> bool {
    let Ok(midi_in) = MidiInput::new("stash-valeton-probe") else {
        return true;
    };
    midi_in.ports().iter().any(|p| {
        midi_in
            .port_name(p)
            .map(|n| is_gp5_port_name(&n))
            .unwrap_or(false)
    })
}

/// Poll CoreMIDI on a background thread; emit `valeton:disconnected` once the
/// GP-5 port disappears. `midir` exposes no unplug callback, so this is how a
/// mid-session USB unplug is noticed. Exits when `running` is cleared (on
/// disconnect) or after it has fired.
fn spawn_usb_watcher(app: AppHandle, running: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut misses: u8 = 0;
        while running.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(USB_WATCH_INTERVAL_MS));
            if !running.load(Ordering::Relaxed) {
                break;
            }
            if gp5_usb_port_present() {
                misses = 0;
                continue;
            }
            misses += 1;
            if misses >= USB_WATCH_MISSES {
                let _ = app.emit("valeton:disconnected", ());
                break;
            }
        }
    });
}

#[derive(Clone, serde::Serialize)]
struct RxEvent {
    transport: String,
    bytes: Vec<u8>,
}

struct UsbConn {
    /// Kept alive so the input callback keeps firing; never read directly.
    _input: MidiInputConnection<Vec<u8>>,
    output: MidiOutputConnection,
    /// Cleared on disconnect to stop the unplug watcher thread.
    watcher_running: Arc<AtomicBool>,
}

struct BleConn {
    peripheral: Peripheral,
    characteristic: Characteristic,
    notify_task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
pub struct ValetonState {
    usb: StdMutex<Option<UsbConn>>,
    ble: AsyncMutex<Option<BleConn>>,
}

impl ValetonState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Reassemble USB-MIDI sysex byte-wise and emit a complete `F0…F7` message.
fn feed_usb(app: &AppHandle, buf: &mut Vec<u8>, msg: &[u8]) {
    for &b in msg {
        if b == 0xF0 {
            buf.clear();
            buf.push(b);
        } else if !buf.is_empty() {
            buf.push(b);
            if b == 0xF7 {
                let bytes = std::mem::take(buf);
                let _ = app.emit(
                    "valeton:rx",
                    RxEvent {
                        transport: "usb".into(),
                        bytes,
                    },
                );
            }
        }
        // status/data bytes outside a sysex frame are ignored — the GP-5
        // editor only acts on sysex over USB.
    }
}

/// Tear down whichever transport is currently open. Safe to call when idle.
async fn disconnect_all(state: &ValetonState) {
    let usb = { state.usb.lock().unwrap().take() };
    if let Some(conn) = &usb {
        conn.watcher_running.store(false, Ordering::Relaxed); // stop the unplug watcher
    }
    drop(usb); // dropping the midir connections closes the ports

    let ble = state.ble.lock().await.take();
    if let Some(conn) = ble {
        conn.notify_task.abort();
        let _ = conn.peripheral.disconnect().await;
    }
}

#[tauri::command]
pub async fn valeton_connect_usb(
    app: AppHandle,
    state: State<'_, ValetonState>,
) -> Result<String, String> {
    disconnect_all(&state).await;

    let midi_in = MidiInput::new("stash-valeton-in").map_err(|e| e.to_string())?;
    let in_port = midi_in
        .ports()
        .into_iter()
        .find(|p| {
            midi_in
                .port_name(p)
                .map(|n| is_gp5_port_name(&n))
                .unwrap_or(false)
        })
        .ok_or_else(|| "No GP-5 detected over USB.".to_string())?;
    let name = midi_in
        .port_name(&in_port)
        .unwrap_or_else(|_| "GP-5".to_string());

    let midi_out = MidiOutput::new("stash-valeton-out").map_err(|e| e.to_string())?;
    let out_port = midi_out
        .ports()
        .into_iter()
        .find(|p| {
            midi_out
                .port_name(p)
                .map(|n| is_gp5_port_name(&n))
                .unwrap_or(false)
        })
        .ok_or_else(|| "No GP-5 MIDI output found.".to_string())?;
    let output = midi_out
        .connect(&out_port, "stash-valeton")
        .map_err(|e| e.to_string())?;

    let app_cb = app.clone();
    let input = midi_in
        .connect(
            &in_port,
            "stash-valeton",
            move |_ts, msg, buf: &mut Vec<u8>| feed_usb(&app_cb, buf, msg),
            Vec::new(),
        )
        .map_err(|e| e.to_string())?;

    let watcher_running = Arc::new(AtomicBool::new(true));
    spawn_usb_watcher(app.clone(), watcher_running.clone());

    *state.usb.lock().unwrap() = Some(UsbConn {
        _input: input,
        output,
        watcher_running,
    });
    Ok(name)
}

#[tauri::command]
pub async fn valeton_connect_ble(
    app: AppHandle,
    state: State<'_, ValetonState>,
) -> Result<String, String> {
    disconnect_all(&state).await;

    let manager = Manager::new().await.map_err(|e| e.to_string())?;
    let central = manager
        .adapters()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .next()
        .ok_or_else(|| "No Bluetooth adapter available.".to_string())?;

    central
        .start_scan(ScanFilter {
            services: vec![SERVICE_UUID],
        })
        .await
        .map_err(|e| e.to_string())?;

    // Poll for a peripheral advertising the BLE-MIDI service (≈8 s).
    let mut found: Option<Peripheral> = None;
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let peripherals = central.peripherals().await.map_err(|e| e.to_string())?;
        for p in peripherals {
            if let Ok(Some(props)) = p.properties().await {
                if props.services.contains(&SERVICE_UUID) {
                    found = Some(p);
                    break;
                }
            }
        }
        if found.is_some() {
            break;
        }
    }
    let _ = central.stop_scan().await;

    let peripheral = found.ok_or_else(|| "No GP-5 found over Bluetooth.".to_string())?;
    let name = peripheral
        .properties()
        .await
        .ok()
        .flatten()
        .and_then(|p| p.local_name)
        .unwrap_or_else(|| "GP5".to_string());

    peripheral.connect().await.map_err(|e| e.to_string())?;
    peripheral
        .discover_services()
        .await
        .map_err(|e| e.to_string())?;

    let characteristic = peripheral
        .characteristics()
        .into_iter()
        .find(|c| c.uuid == CHARACTERISTIC_UUID)
        .ok_or_else(|| "GP-5 MIDI characteristic not found.".to_string())?;

    peripheral
        .subscribe(&characteristic)
        .await
        .map_err(|e| e.to_string())?;

    let mut stream = peripheral
        .notifications()
        .await
        .map_err(|e| e.to_string())?;
    let app_cb = app.clone();
    let notify_task = tauri::async_runtime::spawn(async move {
        while let Some(n) = stream.next().await {
            let _ = app_cb.emit(
                "valeton:rx",
                RxEvent {
                    transport: "ble".into(),
                    bytes: n.value,
                },
            );
        }
        // Stream ended → the peripheral dropped the link.
        let _ = app_cb.emit("valeton:disconnected", ());
    });

    *state.ble.lock().await = Some(BleConn {
        peripheral,
        characteristic,
        notify_task,
    });
    Ok(name)
}

#[tauri::command]
pub async fn valeton_send(
    state: State<'_, ValetonState>,
    bytes: Vec<u8>,
) -> Result<(), String> {
    // USB path first (synchronous midir send).
    {
        let mut guard = state.usb.lock().unwrap();
        if let Some(conn) = guard.as_mut() {
            return conn.output.send(&bytes).map_err(|e| e.to_string());
        }
    }
    // BLE path (write without response into the MIDI characteristic).
    let guard = state.ble.lock().await;
    if let Some(conn) = guard.as_ref() {
        return conn
            .peripheral
            .write(&conn.characteristic, &bytes, WriteType::WithoutResponse)
            .await
            .map_err(|e| e.to_string());
    }
    Err("Not connected.".to_string())
}

#[tauri::command]
pub async fn valeton_disconnect(state: State<'_, ValetonState>) -> Result<(), String> {
    disconnect_all(&state).await;
    Ok(())
}

/// Write a preset (`.prst`) blob to a path chosen via the native save dialog.
/// WKWebView can't trigger an `<a download>` save, so the bytes are handed to
/// Rust to write.
#[tauri::command]
pub fn valeton_save_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())
}

use super::preset_prompt::PRESET_SPEC;

/// Ask the configured AI assistant to design a Valeton preset from a
/// natural-language request and return the raw JSON. A focused one-shot
/// completion — no tool loop, no chat history, reusing the AI module's
/// provider/key from Settings. The model is told to emit ONLY the JSON object;
/// the frontend still tolerates a stray code fence.
///
/// Shared by the `valeton_generate_preset` command (AI modal in the editor) and
/// the `/valeton tone …` assistant slash-command, so both produce identical
/// presets from the same spec.
pub(crate) async fn generate_preset_json(app: &AppHandle, prompt: &str) -> Result<String, String> {
    use crate::modules::ai::state::AiState;
    use crate::modules::telegram::llm::{self, ChatMessage, LlmRequest};
    use tauri::Manager;

    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("Describe the tone you want first.".into());
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let cfg =
        llm::factory::read_config(&data_dir.join("settings.json")).map_err(|e| e.to_string())?;
    let ai_state = app
        .try_state::<AiState>()
        .ok_or_else(|| "AI module is not initialised — open the AI tab once.".to_string())?;
    let client = llm::factory::build_client(&cfg, &ai_state.secrets).map_err(|e| e.to_string())?;

    let system = format!(
        "{PRESET_SPEC}\n\n=== OUTPUT OVERRIDE FOR THIS INTERFACE ===\n\
         Respond with ONLY a single JSON object matching the schema — no prose, no \
         explanation, no markdown code fence. Put any caveat or approximation in the \
         JSON `note` field, never as text outside the object. The first character must \
         be '{{' and the last must be '}}'."
    );

    let req = LlmRequest {
        messages: vec![ChatMessage::system(system), ChatMessage::user(prompt)],
        tools: Vec::new(),
        // Low temperature: preset design wants consistent, in-spec numbers, not
        // creative variance (which tends to drift params toward generic 50s).
        temperature: 0.35,
        max_tokens: 4096,
    };
    let resp = client.chat(req).await.map_err(|e| e.to_string())?;
    let text = resp.text.trim().to_string();
    if text.is_empty() {
        return Err("The model returned no preset. Try rephrasing the request.".into());
    }
    Ok(text)
}

/// Thin Tauri-command wrapper around [`generate_preset_json`] for the editor's
/// AI modal (the frontend parses + applies the returned JSON).
#[tauri::command]
pub async fn valeton_generate_preset(app: AppHandle, prompt: String) -> Result<String, String> {
    generate_preset_json(&app, &prompt).await
}
