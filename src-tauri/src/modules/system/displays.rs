use serde::Serialize;
use std::process::Command;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DisplayInfo {
    pub name: String,
    pub resolution: Option<String>,
    pub main: bool,
    pub mirror: bool,
}

// ---------------------------------------------------------------------------
// Hardware-addressable displays via CoreGraphics + the private
// DisplayServices framework. This is how BetterDisplay / MonitorControl
// talk to DDC/CI monitors and the built-in panel alike — no DDC shell
// calls, no key-code simulation.
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod ffi {
    pub type CGDirectDisplayID = u32;

    pub type CGDisplayConfigRef = *mut core::ffi::c_void;

    /// Fed to `CGCompleteDisplayConfiguration`. `Permanently` keeps the
    /// change across reboot; `ForSession` keeps it until logout — we use
    /// SessionOnly so a user who mistakenly hides a display can reboot and
    /// get it back.
    pub const K_CG_CONFIGURE_FOR_SESSION: i32 = 1;
    pub const K_CG_NULL_DIRECT_DISPLAY: CGDirectDisplayID = 0;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        /// Unlike `CGGetActiveDisplayList`, this also reports displays that
        /// are currently mirror-slaves — which is exactly the state we put
        /// a display in when the user "disables" it. Without this, a
        /// disabled display would vanish from our UI and there'd be no way
        /// to re-enable it. Matches what System Settings > Displays does.
        pub fn CGGetOnlineDisplayList(
            max_displays: u32,
            online_displays: *mut CGDirectDisplayID,
            display_count: *mut u32,
        ) -> i32;
        pub fn CGMainDisplayID() -> CGDirectDisplayID;
        pub fn CGDisplayIsMain(display: CGDirectDisplayID) -> u32;
        pub fn CGDisplayIsBuiltin(display: CGDirectDisplayID) -> u32;
        pub fn CGDisplayPixelsHigh(display: CGDirectDisplayID) -> usize;
        pub fn CGDisplayPixelsWide(display: CGDirectDisplayID) -> usize;
        pub fn CGDisplayVendorNumber(display: CGDirectDisplayID) -> u32;
        pub fn CGDisplayModelNumber(display: CGDirectDisplayID) -> u32;
        pub fn CGDisplayMirrorsDisplay(display: CGDirectDisplayID) -> CGDirectDisplayID;
        pub fn CGBeginDisplayConfiguration(config: *mut CGDisplayConfigRef) -> i32;
        pub fn CGConfigureDisplayMirrorOfDisplay(
            config: CGDisplayConfigRef,
            display: CGDirectDisplayID,
            master: CGDirectDisplayID,
        ) -> i32;
        pub fn CGConfigureDisplayOrigin(
            config: CGDisplayConfigRef,
            display: CGDirectDisplayID,
            x: i32,
            y: i32,
        ) -> i32;
        pub fn CGCompleteDisplayConfiguration(config: CGDisplayConfigRef, option: i32) -> i32;
        pub fn CGCancelDisplayConfiguration(config: CGDisplayConfigRef) -> i32;
    }

    // Private framework — present on every macOS 10.15+. BetterDisplay,
    // MonitorControl, LunaDisplay and others rely on this; Apple hasn't
    // shipped a public replacement.
    #[link(name = "DisplayServices", kind = "framework")]
    extern "C" {
        pub fn DisplayServicesGetBrightness(
            display: CGDirectDisplayID,
            brightness: *mut f32,
        ) -> i32;
        pub fn DisplayServicesSetBrightness(display: CGDirectDisplayID, brightness: f32) -> i32;
        pub fn DisplayServicesCanChangeBrightness(display: CGDirectDisplayID) -> bool;
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DisplayDevice {
    /// CGDirectDisplayID — opaque number passed back to `set_brightness`.
    pub id: u32,
    pub name: String,
    pub width_px: u32,
    pub height_px: u32,
    pub is_main: bool,
    pub is_builtin: bool,
    /// 0.0..1.0. `None` means the framework can't read from this display
    /// (happens on HDMI adapters that lack DDC, or some hub-connected monitors).
    pub brightness: Option<f32>,
    pub supports_brightness: bool,
    pub vendor_id: u32,
    pub model_id: u32,
    /// When non-zero, this display currently mirrors another display's
    /// contents — effectively "hidden" from the extended desktop. We use
    /// this both for UI state ("Приховано") and to decide whether the
    /// "Відновити" button should be enabled.
    pub mirrors: u32,
}

#[cfg(target_os = "macos")]
pub fn list_hardware_displays() -> Vec<DisplayDevice> {
    use ffi::*;
    let mut ids: [CGDirectDisplayID; 16] = [0; 16];
    let mut count: u32 = 0;
    let rc = unsafe { CGGetOnlineDisplayList(16, ids.as_mut_ptr(), &mut count) };
    if rc != 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    for &id in &ids[..count as usize] {
        let is_main = unsafe { CGDisplayIsMain(id) } != 0;
        let is_builtin = unsafe { CGDisplayIsBuiltin(id) } != 0;
        let width_px = unsafe { CGDisplayPixelsWide(id) } as u32;
        let height_px = unsafe { CGDisplayPixelsHigh(id) } as u32;
        let vendor_id = unsafe { CGDisplayVendorNumber(id) };
        let model_id = unsafe { CGDisplayModelNumber(id) };
        // Two separate tracks for brightness capability:
        //   - DisplayServices: built-in panels, and many Apple-blessed externals
        //     (Studio Display, LG UltraFine). Accurate getter, smooth setter.
        //   - DDC/CI over IOAVService: "regular" HDMI/DP monitors. No getter
        //     we can trust in <50 ms, but the setter is reliable.
        // We want the UI slider enabled whenever *either* channel works, so
        // users can drive brightness on USB-C docks where DisplayServices
        // lies about support.
        let ds_supports = unsafe { DisplayServicesCanChangeBrightness(id) };
        let ds_brightness = if ds_supports {
            let mut b: f32 = 0.0;
            let rc = unsafe { DisplayServicesGetBrightness(id, &mut b) };
            if rc == 0 {
                Some(b.clamp(0.0, 1.0))
            } else {
                None
            }
        } else {
            None
        };
        let ddc_supports = !is_builtin && super::ddc::can_control(id);
        let supports_brightness = ds_supports || ddc_supports;
        // For DDC-only panels we don't know the current value without doing a
        // slow 5-byte read; show the last value the user set (or 70% default)
        // so the slider isn't stuck at zero.
        let brightness = ds_brightness.or_else(|| {
            if ddc_supports {
                Some(
                    saved_store()
                        .lock()
                        .unwrap()
                        .get(&id)
                        .copied()
                        .unwrap_or(0.7),
                )
            } else {
                None
            }
        });
        // Correlate with system_profiler's human name if possible. We fall
        // back to "Built-in Display" / "External Display" so the UI always
        // has something to show.
        let name = if is_builtin {
            "Built-in Display".to_string()
        } else {
            format!("External Display · {vendor_id:04X}:{model_id:04X}")
        };
        let mirrors = unsafe { CGDisplayMirrorsDisplay(id) };
        out.push(DisplayDevice {
            id,
            name,
            width_px,
            height_px,
            is_main,
            is_builtin,
            brightness,
            supports_brightness,
            vendor_id,
            model_id,
            mirrors,
        });
    }
    // Main display first, then built-in (if not main), then by id.
    out.sort_by(|a, b| {
        b.is_main
            .cmp(&a.is_main)
            .then_with(|| b.is_builtin.cmp(&a.is_builtin))
            .then_with(|| a.id.cmp(&b.id))
    });
    // Try to fold human names from system_profiler into the FFI rows.
    annotate_names(&mut out);
    out
}

#[cfg(not(target_os = "macos"))]
pub fn list_hardware_displays() -> Vec<DisplayDevice> {
    Vec::new()
}

/// Match FFI rows to `system_profiler` entries by (vendor_id, model_id)
/// when both sides publish them. `system_profiler` exposes them as
/// hex strings with a 0x prefix; we canonicalise to u32.
fn annotate_names(out: &mut [DisplayDevice]) {
    let spp = match Command::new("system_profiler")
        .args(["SPDisplaysDataType", "-json"])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return,
    };
    let root: serde_json::Value = match serde_json::from_slice(&spp.stdout) {
        Ok(v) => v,
        Err(_) => return,
    };
    let mut named: Vec<(u32, u32, String)> = Vec::new();
    if let Some(arr) = root.get("SPDisplaysDataType").and_then(|v| v.as_array()) {
        for gpu in arr {
            if let Some(devs) = gpu.get("spdisplays_ndrvs").and_then(|v| v.as_array()) {
                for d in devs {
                    let name = d
                        .get("_name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let vendor = d
                        .get("_spdisplays_display-vendor-id")
                        .and_then(|v| v.as_str())
                        .and_then(|s| u32::from_str_radix(s.trim_start_matches("0x"), 16).ok())
                        .unwrap_or(0);
                    let model = d
                        .get("_spdisplays_display-product-id")
                        .and_then(|v| v.as_str())
                        .and_then(|s| u32::from_str_radix(s.trim_start_matches("0x"), 16).ok())
                        .unwrap_or(0);
                    if !name.is_empty() {
                        named.push((vendor, model, name));
                    }
                }
            }
        }
    }
    for d in out.iter_mut() {
        if let Some((_, _, n)) = named
            .iter()
            .find(|(v, m, _)| *v == d.vendor_id && *m == d.model_id)
        {
            d.name = n.clone();
        }
    }
}

#[cfg(target_os = "macos")]
pub fn set_display_brightness(id: u32, value: f32) -> Result<(), String> {
    let clamped = value.clamp(0.0, 1.0);
    // Remember the value regardless of which channel wins — even the DDC
    // path benefits, since next time we enumerate we can show it instead of
    // defaulting to 70%.
    saved_store().lock().unwrap().insert(id, clamped);

    let ds_supports = unsafe { ffi::DisplayServicesCanChangeBrightness(id) };
    if ds_supports {
        let rc = unsafe { ffi::DisplayServicesSetBrightness(id, clamped) };
        if rc == 0 {
            return Ok(());
        }
        // Some USB-C hubs advertise support but fail the write — fall through
        // to DDC instead of surfacing an error.
    }
    // DDC path. `can_control` returns false for the built-in panel (no DDC
    // bus) and for displays whose IOAVService we couldn't match.
    if super::ddc::can_control(id) {
        let pct = (clamped * 100.0).round().clamp(0.0, 100.0) as u8;
        return super::ddc::set_brightness(id, pct);
    }
    Err(format!(
        "дисплей {id} не підтримує ні DisplayServices, ні DDC/CI"
    ))
}

#[cfg(not(target_os = "macos"))]
pub fn set_display_brightness(_id: u32, _value: f32) -> Result<(), String> {
    Err("brightness control is macOS-only".into())
}

/// "Hide" a display from the extended desktop by mirroring it to a master.
/// macOS then treats the mirrored panel as the same logical space as the
/// master — windows stop being placed there, Spaces stops offering it as
/// a separate target, and menu-bar items stay on the master. The effect
/// is what BetterDisplay calls "Disable"; the only way to actually power
/// the panel off is to unplug the cable.
///
/// `hide == true`  → mirror `secondary` onto `master`.
/// `hide == false` → untether (pass `kCGNullDirectDisplay`).
///
/// We refuse to hide the main display — without it the user has no surface
/// to issue a follow-up "show" command on.
/// Hide `secondary` by mirroring it onto `master`, and — if `promote_master`
/// is set — reposition `master` to origin (0,0) first so macOS treats it as
/// the new main display. That's the trick BetterDisplay uses to "disable"
/// whichever display is currently main: you can't mirror the main onto
/// something else while it's still the main, so we swap main first (all in
/// one begin/complete block so WindowServer sees a consistent layout).
#[cfg(target_os = "macos")]
fn reconfigure_mirror(secondary: u32, master: u32, promote_master: bool) -> Result<(), String> {
    use ffi::*;
    let mut config: CGDisplayConfigRef = std::ptr::null_mut();
    let rc = unsafe { CGBeginDisplayConfiguration(&mut config) };
    if rc != 0 {
        return Err(format!("CGBeginDisplayConfiguration: rc={rc}"));
    }
    if promote_master && master != K_CG_NULL_DIRECT_DISPLAY {
        let rc = unsafe { CGConfigureDisplayOrigin(config, master, 0, 0) };
        if rc != 0 {
            unsafe { CGCancelDisplayConfiguration(config) };
            return Err(format!("CGConfigureDisplayOrigin: rc={rc}"));
        }
    }
    let rc = unsafe { CGConfigureDisplayMirrorOfDisplay(config, secondary, master) };
    if rc != 0 {
        unsafe { CGCancelDisplayConfiguration(config) };
        return Err(format!("CGConfigureDisplayMirrorOfDisplay: rc={rc}"));
    }
    let rc = unsafe { CGCompleteDisplayConfiguration(config, K_CG_CONFIGURE_FOR_SESSION) };
    if rc != 0 {
        return Err(format!("CGCompleteDisplayConfiguration: rc={rc}"));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn set_display_hidden(secondary: u32, master: u32, hide: bool) -> Result<(), String> {
    use ffi::*;
    if hide {
        if master == 0 || secondary == master {
            return Err("потрібен інший дисплей як точка поглинання".into());
        }
        let promote = secondary == unsafe { CGMainDisplayID() };
        return reconfigure_mirror(secondary, master, promote);
    }
    reconfigure_mirror(secondary, K_CG_NULL_DIRECT_DISPLAY, false)
}

#[cfg(not(target_os = "macos"))]
pub fn set_display_hidden(_s: u32, _m: u32, _h: bool) -> Result<(), String> {
    Err("hide/show is macOS-only".into())
}

// Per-display brightness we captured at power-off, keyed by display id, so
// a power-on returns the panel to what the user had before — not to 0% nor
// to 100%. A process restart wipes it; that's fine, the monitor just wakes
// at its own default.
#[cfg(target_os = "macos")]
static SAVED_BRIGHTNESS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<u32, f32>>,
> = std::sync::OnceLock::new();

#[cfg(target_os = "macos")]
fn saved_store() -> &'static std::sync::Mutex<std::collections::HashMap<u32, f32>> {
    SAVED_BRIGHTNESS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Programmatic "power off" using only public CoreGraphics + the already-
/// loaded DisplayServices framework. We:
///   1. Snapshot the current brightness so the on-path can restore it.
///   2. Zero the backlight / DDC brightness — most external monitors enter
///      DPMS sleep at 0, the built-in panel goes fully dark.
///   3. Mirror the display onto `master`, which makes macOS stop treating
///      it as an extended desktop (no more windows getting placed there).
#[cfg(target_os = "macos")]
pub fn power_off_display(secondary: u32, master: u32) -> Result<(), String> {
    use ffi::*;
    if master == 0 || secondary == master {
        return Err("потрібен інший дисплей, на який перенести сеанс".into());
    }
    let promote_master = secondary == unsafe { CGMainDisplayID() };
    // Step 1 — remember the current brightness so power-on can restore it
    // exactly, not reset the monitor to an awkward default.
    if unsafe { DisplayServicesCanChangeBrightness(secondary) } {
        let mut cur: f32 = 0.0;
        let rc = unsafe { DisplayServicesGetBrightness(secondary, &mut cur) };
        if rc == 0 && cur > 0.0 {
            saved_store().lock().unwrap().insert(secondary, cur);
        }
    }

    // Step 2 — the big swing: send the DDC/CI hardware power-off to the
    // panel itself (VCP 0xD6 value 5). On any modern external monitor this
    // actually turns the monitor off — its backlight shuts, status LED
    // flips to standby, exactly as if the user pressed the power button.
    //
    // DDC isn't universally supported though: MacBook built-in panels
    // don't expose a DDC bus at all, some USB-C docks strip the I²C
    // channel, and a few cheap HDMI-over-USB adapters ignore the opcode.
    // Either way we ALSO fall through to the software dim+mirror path
    // below, so the user gets the best result their hardware allows.
    let ddc_power_ok = super::ddc::set_power(secondary, false).is_ok();

    // Step 3 — belt-and-suspenders dim. VCP 0xD6 (power) is optional on
    // many monitors but VCP 0x10 (brightness) is mandatory per DDC/CI, so
    // pushing brightness to 0 gives us a dark panel even when the power
    // opcode was ignored. For built-in panels DisplayServices gets the job.
    if unsafe { DisplayServicesCanChangeBrightness(secondary) } {
        let _ = unsafe { DisplayServicesSetBrightness(secondary, 0.0) };
    }
    let ddc_dim_ok = super::ddc::set_brightness(secondary, 0).is_ok();

    reconfigure_mirror(secondary, master, promote_master)?;

    if !ddc_power_ok && !ddc_dim_ok {
        tracing::info!(
            display = secondary,
            "ddc unavailable; display is mirrored but may remain lit"
        );
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn power_on_display(secondary: u32) -> Result<(), String> {
    use ffi::*;
    // Reverse order: un-mirror first so the restored brightness setting
    // gets sent while the panel is already recognised as a standalone
    // device again; some monitors reject DDC writes while mirrored.
    reconfigure_mirror(secondary, K_CG_NULL_DIRECT_DISPLAY, false)?;

    // DDC hardware on — matches whatever power_off did on this monitor.
    let _ = super::ddc::set_power(secondary, true);

    if unsafe { DisplayServicesCanChangeBrightness(secondary) } {
        let saved = saved_store().lock().unwrap().remove(&secondary);
        let target = saved.unwrap_or(0.7).max(0.05);
        let _ = unsafe { DisplayServicesSetBrightness(secondary, target) };
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn power_off_display(_s: u32, _m: u32) -> Result<(), String> {
    Err("power off is macOS-only".into())
}

#[cfg(not(target_os = "macos"))]
pub fn power_on_display(_s: u32) -> Result<(), String> {
    Err("power on is macOS-only".into())
}

/// Parse the JSON `system_profiler` emits for `SPDisplaysDataType`. We walk
/// every GPU entry's `spdisplays_ndrvs` array — each element is one attached
/// display. `system_profiler` is slow-ish (100–300 ms) so callers should run
/// it off the UI thread.
pub fn parse_displays(json: &str) -> Vec<DisplayInfo> {
    let root: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let gpus = root
        .get("SPDisplaysDataType")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for gpu in gpus {
        let displays = gpu
            .get("spdisplays_ndrvs")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for d in displays {
            let name = d
                .get("_name")
                .and_then(|v| v.as_str())
                .unwrap_or("Display")
                .to_string();
            let resolution = d
                .get("_spdisplays_resolution")
                .or_else(|| d.get("spdisplays_resolution"))
                .or_else(|| d.get("_spdisplays_pixels"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let main = d
                .get("spdisplays_main")
                .and_then(|v| v.as_str())
                .map(|s| s == "spdisplays_yes")
                .unwrap_or(false);
            let mirror = d
                .get("spdisplays_mirror")
                .and_then(|v| v.as_str())
                .map(|s| s != "spdisplays_off")
                .unwrap_or(false);
            out.push(DisplayInfo {
                name,
                resolution,
                main,
                mirror,
            });
        }
    }
    out
}

pub fn list_displays() -> Result<Vec<DisplayInfo>, String> {
    let out = Command::new("system_profiler")
        .args(["SPDisplaysDataType", "-json"])
        .output()
        .map_err(|e| format!("system_profiler: {e}"))?;
    if !out.status.success() {
        return Err(format!("system_profiler exit {}", out.status));
    }
    Ok(parse_displays(&String::from_utf8_lossy(&out.stdout)))
}

/// Immediately put every connected display to sleep. Equivalent to
/// ⌃⇧⏏ / closing the lid while on battery. Screens wake on any user input.
pub fn sleep_displays() -> Result<(), String> {
    let status = Command::new("pmset")
        .arg("displaysleepnow")
        .status()
        .map_err(|e| format!("pmset: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("pmset exit {status}"))
    }
}

/// Simulate a brightness hotkey. Requires Accessibility permission (which
/// the app already prompts for on first run). Only the built-in display
/// responds — external monitors usually ignore the HID event.
#[cfg(target_os = "macos")]
pub fn adjust_brightness(up: bool) -> Result<(), String> {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    let key = if up {
        Key::BrightnessUp
    } else {
        Key::BrightnessDown
    };
    enigo
        .key(key, Direction::Click)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn adjust_brightness(_up: bool) -> Result<(), String> {
    Err("brightness adjustment is macOS-only".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_displays_handles_empty_json() {
        assert!(parse_displays("{}").is_empty());
        assert!(parse_displays("not json").is_empty());
    }

    #[test]
    fn parse_displays_reads_ndrvs() {
        let json = r#"{
          "SPDisplaysDataType": [
            {
              "_name": "Apple M2 GPU",
              "spdisplays_ndrvs": [
                {
                  "_name": "Built-in Retina",
                  "_spdisplays_resolution": "3024 x 1964",
                  "spdisplays_main": "spdisplays_yes",
                  "spdisplays_mirror": "spdisplays_off"
                },
                {
                  "_name": "LG UltraFine",
                  "_spdisplays_resolution": "3840 x 2160",
                  "spdisplays_mirror": "spdisplays_off"
                }
              ]
            }
          ]
        }"#;
        let d = parse_displays(json);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].name, "Built-in Retina");
        assert!(d[0].main);
        assert_eq!(d[1].name, "LG UltraFine");
        assert!(!d[1].main);
        assert_eq!(d[1].resolution.as_deref(), Some("3840 x 2160"));
    }
}
