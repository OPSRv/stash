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

#[derive(Clone, serde::Serialize)]
struct RxEvent {
    transport: String,
    bytes: Vec<u8>,
}

struct UsbConn {
    /// Kept alive so the input callback keeps firing; never read directly.
    _input: MidiInputConnection<Vec<u8>>,
    output: MidiOutputConnection,
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
                .map(|n| n.contains("GP-5"))
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
                .map(|n| n.contains("GP-5"))
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

    *state.usb.lock().unwrap() = Some(UsbConn {
        _input: input,
        output,
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
