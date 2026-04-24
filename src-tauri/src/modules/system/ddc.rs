//! DDC/CI over IOAVService — the same private-but-stable-for-a-decade API
//! BetterDisplay, Lunar and MonitorControl use to reach external monitors.
//!
//! On macOS an external monitor exposes an I²C DDC channel at 7-bit address
//! 0x37; we send a VCP command through that and the monitor interprets it
//! the same way it would if the user pressed its physical power button. No
//! private entitlements, no kext, no root — just the IOKit frameworks that
//! ship with every Mac.
//!
//! We match a `CGDirectDisplayID` to the right IOAVService by walking the
//! `IOAVService` (Intel) and `DCPAVServiceProxy` (Apple Silicon) iterators
//! and comparing the service's registry-entry "Location" / "Framebuffer"
//! index against `CGDisplayUnitNumber`. If we can't find a match we bail
//! gracefully — callers fall back to a software hide.

#![cfg(target_os = "macos")]

use std::ffi::{c_void, CString};

type IoObjectT = u32;
type IoServiceT = IoObjectT;
type IoIteratorT = IoObjectT;
type KernReturnT = i32;
type MachPortT = u32;

const KERN_SUCCESS: KernReturnT = 0;

#[repr(C)]
struct Opaque {
    _priv: [u8; 0],
}
type CFAllocatorRef = *const Opaque;
type CFStringRef = *const Opaque;
type CFTypeRef = *const Opaque;

#[link(name = "IOKit", kind = "framework")]
extern "C" {
    static kIOMainPortDefault: MachPortT;

    fn IOServiceMatching(name: *const i8) -> *mut Opaque;
    fn IOServiceGetMatchingServices(
        main_port: MachPortT,
        matching: *mut Opaque,
        iterator: *mut IoIteratorT,
    ) -> KernReturnT;
    fn IOIteratorNext(iter: IoIteratorT) -> IoObjectT;
    fn IOObjectRelease(obj: IoObjectT) -> KernReturnT;

    fn IORegistryEntryCreateCFProperty(
        entry: IoServiceT,
        key: CFStringRef,
        allocator: CFAllocatorRef,
        options: u32,
    ) -> CFTypeRef;

    fn IOAVServiceCreateWithService(
        allocator: CFAllocatorRef,
        service: IoServiceT,
    ) -> *const c_void;
    fn IOAVServiceWriteI2C(
        service: *const c_void,
        chip_address: u32,
        data_address: u32,
        input_buffer: *const u8,
        input_buffer_size: u32,
    ) -> KernReturnT;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFAllocatorDefault: CFAllocatorRef;

    fn CFStringCreateWithCString(
        alloc: CFAllocatorRef,
        c_str: *const i8,
        encoding: u32,
    ) -> CFStringRef;
    fn CFStringGetCString(
        s: CFStringRef,
        buffer: *mut i8,
        buffer_size: isize,
        encoding: u32,
    ) -> bool;
    fn CFRelease(cf: CFTypeRef);
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFStringGetTypeID() -> usize;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGDisplayIsBuiltin(display: u32) -> u32;
    fn CGGetActiveDisplayList(
        max_displays: u32,
        active_displays: *mut u32,
        display_count: *mut u32,
    ) -> i32;
}

// ---- Intel Mac DDC path: IOFramebufferI2CInterface + IOI2C ----
//
// On Apple Silicon we reach the monitor through IOAVService. On Intel Macs
// that class isn't registered at all — instead every AppleIntelFramebuffer
// exposes an `IOFramebufferI2CInterface` child that talks to the monitor's
// DDC bus via the old IOKit I²C API. This is what ddcctl and pre-M1
// MonitorControl use.
//
// Matching a CGDirectDisplayID to the right framebuffer on modern macOS
// (10.15+) is non-trivial without the deprecated `CGDisplayIOServicePort`.
// Since a typical Intel Mac mini has only one external monitor at a time
// and unused framebuffers silently drop the write, we broadcast to every
// IOFramebufferI2CInterface. The monitor that owns the path responds; the
// rest are no-ops.

#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOI2CInterfaceOpen(
        interface: IoServiceT,
        options: u32,
        connect: *mut *mut c_void,
    ) -> KernReturnT;
    fn IOI2CInterfaceClose(connect: *mut c_void, options: u32) -> KernReturnT;
    fn IOI2CSendRequest(
        connect: *mut c_void,
        options: u32,
        request: *mut IOI2CRequest,
    ) -> KernReturnT;
}

const K_IO_I2C_NO_TRANSACTION_TYPE: u64 = 0;
const K_IO_I2C_SIMPLE_TRANSACTION_TYPE: u64 = 1;

#[repr(C)]
struct IOI2CRequest {
    send_transaction_type: u64,
    reply_transaction_type: u64,
    send_address: u32,
    reply_address: u32,
    send_sub_address: u8,
    reply_sub_address: u8,
    _reserved_a: [u8; 2],
    min_reply_delay: u64,
    result: i32,
    _pad_result: u32,
    send_buffer: usize,
    send_bytes: u32,
    send_flags: u16,
    _reserved_b: u16,
    reply_buffer: usize,
    reply_bytes: u32,
    reply_flags: u16,
    _reserved_c: u16,
    _reserved_d: [u32; 16],
}

fn intel_send_packet(packet: &[u8]) -> Result<(), String> {
    let services = iter_services("IOFramebufferI2CInterface", |_| true);
    if services.is_empty() {
        return Err("no IOFramebufferI2CInterface on this Mac".into());
    }

    let mut any_ok = false;
    let mut last_err: Option<String> = None;

    for svc in services {
        let mut connect: *mut c_void = std::ptr::null_mut();
        let rc = unsafe { IOI2CInterfaceOpen(svc, 0, &mut connect) };
        if rc != KERN_SUCCESS || connect.is_null() {
            last_err = Some(format!("IOI2CInterfaceOpen: rc={rc}"));
            unsafe { IOObjectRelease(svc) };
            continue;
        }

        let mut req = IOI2CRequest {
            send_transaction_type: K_IO_I2C_SIMPLE_TRANSACTION_TYPE,
            reply_transaction_type: K_IO_I2C_NO_TRANSACTION_TYPE,
            send_address: 0x6E,
            reply_address: 0,
            send_sub_address: 0,
            reply_sub_address: 0,
            _reserved_a: [0; 2],
            min_reply_delay: 0,
            result: 0,
            _pad_result: 0,
            send_buffer: packet.as_ptr() as usize,
            send_bytes: packet.len() as u32,
            send_flags: 0,
            _reserved_b: 0,
            reply_buffer: 0,
            reply_bytes: 0,
            reply_flags: 0,
            _reserved_c: 0,
            _reserved_d: [0; 16],
        };
        let rc = unsafe { IOI2CSendRequest(connect, 0, &mut req) };
        unsafe { IOI2CInterfaceClose(connect, 0) };
        unsafe { IOObjectRelease(svc) };

        if rc == KERN_SUCCESS && req.result == KERN_SUCCESS {
            any_ok = true;
        } else {
            last_err = Some(format!("IOI2CSendRequest: rc={rc} result={}", req.result));
        }
    }

    if any_ok {
        Ok(())
    } else {
        Err(last_err.unwrap_or_else(|| "no I2C interface accepted the write".into()))
    }
}

const K_CF_STRING_ENCODING_ASCII: u32 = 0x0600;

fn cfstr(s: &str) -> Option<CFStringRef> {
    let c = CString::new(s).ok()?;
    let r = unsafe {
        CFStringCreateWithCString(kCFAllocatorDefault, c.as_ptr(), K_CF_STRING_ENCODING_ASCII)
    };
    if r.is_null() {
        None
    } else {
        Some(r)
    }
}

/// Read a registry property as an ASCII string. Apple Silicon's
/// `DCPAVServiceProxy` uses a string `Location` ("External" / "Embedded")
/// to tag its services — this is what m1ddc / MonitorControl key off.
fn read_string(service: IoServiceT, key: &str) -> Option<String> {
    let k = cfstr(key)?;
    let val: CFTypeRef =
        unsafe { IORegistryEntryCreateCFProperty(service, k, kCFAllocatorDefault, 0) };
    unsafe { CFRelease(k as CFTypeRef) };
    if val.is_null() {
        return None;
    }
    let ty = unsafe { CFGetTypeID(val) };
    if ty != unsafe { CFStringGetTypeID() } {
        unsafe { CFRelease(val) };
        return None;
    }
    let mut buf = [0i8; 128];
    let ok = unsafe {
        CFStringGetCString(
            val as CFStringRef,
            buf.as_mut_ptr(),
            buf.len() as isize,
            K_CF_STRING_ENCODING_ASCII,
        )
    };
    unsafe { CFRelease(val) };
    if !ok {
        return None;
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    let bytes: Vec<u8> = buf[..end].iter().map(|&b| b as u8).collect();
    String::from_utf8(bytes).ok()
}

/// Iterate every IOService of `class_name`, returning matches where the
/// predicate returns true. Caller owns the returned services and must
/// `IOObjectRelease` each one.
fn iter_services<F: FnMut(IoServiceT) -> bool>(class_name: &str, mut keep: F) -> Vec<IoServiceT> {
    let c = match CString::new(class_name) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let matching = unsafe { IOServiceMatching(c.as_ptr()) };
    if matching.is_null() {
        return Vec::new();
    }
    let mut it: IoIteratorT = 0;
    let rc = unsafe { IOServiceGetMatchingServices(kIOMainPortDefault, matching, &mut it) };
    if rc != KERN_SUCCESS || it == 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    loop {
        let svc = unsafe { IOIteratorNext(it) };
        if svc == 0 {
            break;
        }
        if keep(svc) {
            out.push(svc);
        } else {
            unsafe { IOObjectRelease(svc) };
        }
    }
    unsafe { IOObjectRelease(it) };
    out
}

/// Position of `target` among currently-active external displays (0-based).
/// That index maps 1:1 to the order in which Apple Silicon's
/// `DCPAVServiceProxy` publishes its External services — which is how we
/// pair a `CGDirectDisplayID` to an `IOAVService` without relying on the
/// fragile `IOFBIndex` lookup that Apple keeps moving around.
fn external_display_index(target: u32) -> Option<usize> {
    let mut ids = [0u32; 16];
    let mut count: u32 = 0;
    let rc = unsafe { CGGetActiveDisplayList(16, ids.as_mut_ptr(), &mut count) };
    if rc != 0 {
        return None;
    }
    let mut idx = 0usize;
    for &id in &ids[..count as usize] {
        if unsafe { CGDisplayIsBuiltin(id) } != 0 {
            continue;
        }
        if id == target {
            return Some(idx);
        }
        idx += 1;
    }
    None
}

/// Find the IOAVService for this external display. Strategy: ask for the
/// target's position among external displays, then walk
/// `DCPAVServiceProxy` (Apple Silicon) / `IOAVService` (Intel) and return
/// the N-th service whose `Location` property is "External". That ordering
/// is stable across reboots on every Mac I've tested and matches what
/// m1ddc / MonitorControl do in their current builds.
fn find_av_service(display: u32) -> Option<*const c_void> {
    if unsafe { CGDisplayIsBuiltin(display) } != 0 {
        return None;
    }
    let want = external_display_index(display)?;

    for class_name in ["DCPAVServiceProxy", "IOAVService"] {
        let mut external_idx = 0usize;
        let mut matched: Option<IoServiceT> = None;
        let candidates = iter_services(class_name, |svc| {
            let loc = read_string(svc, "Location").unwrap_or_default();
            if loc != "External" {
                return false;
            }
            if matched.is_none() && external_idx == want {
                matched = Some(svc);
                external_idx += 1;
                return true;
            }
            external_idx += 1;
            false
        });
        if let Some(svc) = matched {
            let av = unsafe { IOAVServiceCreateWithService(kCFAllocatorDefault, svc) };
            // Release every service we didn't take.
            for &extra in candidates.iter().filter(|&&x| x != svc) {
                unsafe { IOObjectRelease(extra) };
            }
            unsafe { IOObjectRelease(svc) };
            if av.is_null() {
                return None;
            }
            return Some(av);
        } else {
            // Nothing matched in this class — release everything we collected
            // and try the next class.
            for svc in candidates {
                unsafe { IOObjectRelease(svc) };
            }
        }
    }
    None
}

/// Build the 7-byte DDC/CI Set-VCP packet per VESA MCCS:
///   [0x51, 0x80|N, 0x03, opcode, valHi, valLo, checksum]
/// Checksum is `0x6E XOR` of all preceding bytes (0x6E is the destination
/// address on the 7-bit I²C bus = 0x37<<1).
fn build_vcp_set_packet(vcp: u8, value: u16) -> [u8; 7] {
    let mut pkt = [0u8; 7];
    pkt[0] = 0x51;
    pkt[1] = 0x84;
    pkt[2] = 0x03;
    pkt[3] = vcp;
    pkt[4] = ((value >> 8) & 0xFF) as u8;
    pkt[5] = (value & 0xFF) as u8;
    let mut cs: u8 = 0x6E;
    for b in &pkt[..6] {
        cs ^= b;
    }
    pkt[6] = cs;
    pkt
}

fn write_vcp(display: u32, vcp: u8, value: u16) -> Result<(), String> {
    let pkt = build_vcp_set_packet(vcp, value);

    // Path 1: Apple Silicon. IOAVServiceWriteI2C expects the payload *after*
    // the source-address byte (because dataAddress=0x51 is sent for us).
    if let Some(svc) = find_av_service(display) {
        let rc = unsafe { IOAVServiceWriteI2C(svc, 0x37, 0x51, pkt[1..].as_ptr(), 6) };
        unsafe { CFRelease(svc as CFTypeRef) };
        if rc == KERN_SUCCESS {
            return Ok(());
        }
        // Fall through to Intel path — some Macs expose both.
    }

    // Path 2: Intel Mac via IOFramebufferI2CInterface. The wire-level
    // IOI2CSendRequest wants the *full* 7-byte packet starting with the
    // source address, because it controls the whole I²C transaction.
    intel_send_packet(&pkt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vcp_packet_has_valid_checksum_for_power_off() {
        // VCP 0xD6 = 5 ("hard off"). Checksum must XOR 0x6E with all other
        // bytes — the receiving monitor validates this and drops the packet
        // otherwise, which is exactly what bit us on the user's bug report.
        let pkt = build_vcp_set_packet(0xD6, 5);
        assert_eq!(pkt[..6], [0x51, 0x84, 0x03, 0xD6, 0x00, 0x05]);
        let mut cs: u8 = 0x6E;
        for b in &pkt[..6] {
            cs ^= b;
        }
        assert_eq!(pkt[6], cs);
    }

    #[test]
    fn vcp_packet_for_brightness_mid_value() {
        let pkt = build_vcp_set_packet(0x10, 50);
        assert_eq!(pkt[3], 0x10);
        assert_eq!(pkt[4], 0x00);
        assert_eq!(pkt[5], 50);
        let mut cs: u8 = 0x6E;
        for b in &pkt[..6] {
            cs ^= b;
        }
        assert_eq!(pkt[6], cs);
    }
}

/// VCP 0xD6 — Power Mode.
/// Value 1 = On, 2 = Standby, 3 = Suspend, 4 = Off (Soft), 5 = Off (Hard).
pub fn set_power(display: u32, on: bool) -> Result<(), String> {
    write_vcp(display, 0xD6, if on { 1 } else { 5 })
}

/// VCP 0x10 — Luminance (brightness). Most monitors use 0..100 for the
/// value, a handful report a non-standard max via the Get-VCP response; we
/// clamp to 100 which every tested DDC-CI panel accepts. `percent` is 0..100.
pub fn set_brightness(display: u32, percent: u8) -> Result<(), String> {
    write_vcp(display, 0x10, percent.min(100) as u16)
}

/// True when this display has *some* DDC path we can attempt. On Apple
/// Silicon that's the IOAVService lookup; on Intel it's the presence of at
/// least one IOFramebufferI2CInterface. We treat "path available" as
/// "worth enabling the slider" — the actual write may still fail (cheap
/// HDMI adapters, KVMs, certain USB-C docks strip I²C), but the user should
/// see the attempt.
pub fn can_control(display: u32) -> bool {
    if unsafe { CGDisplayIsBuiltin(display) } != 0 {
        return false;
    }
    if let Some(svc) = find_av_service(display) {
        unsafe { CFRelease(svc as CFTypeRef) };
        return true;
    }
    // Intel fallback: any IOFramebufferI2CInterface means we have a DDC bus
    // we can try. We don't filter to a specific framebuffer here — the
    // slider enable/disable is coarse; the write itself is broadcast.
    let services = iter_services("IOFramebufferI2CInterface", |_| true);
    let any = !services.is_empty();
    for svc in services {
        unsafe { IOObjectRelease(svc) };
    }
    any
}
