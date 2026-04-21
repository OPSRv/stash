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
use std::ptr;

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
type CFNumberRef = *const Opaque;

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
    fn CFRelease(cf: CFTypeRef);
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFNumberGetTypeID() -> usize;
    fn CFNumberGetValue(n: CFNumberRef, ty: i32, value: *mut c_void) -> bool;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGDisplayUnitNumber(display: u32) -> u32;
    fn CGDisplayIsBuiltin(display: u32) -> u32;
}

const K_CF_STRING_ENCODING_ASCII: u32 = 0x0600;
/// `kCFNumberSInt32Type` per CFNumber.h.
const K_CF_NUMBER_SINT32_TYPE: i32 = 3;

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

fn read_number_i32(service: IoServiceT, key: &str) -> Option<i32> {
    let k = cfstr(key)?;
    let val: CFTypeRef = unsafe {
        IORegistryEntryCreateCFProperty(service, k, kCFAllocatorDefault, 0)
    };
    unsafe { CFRelease(k as CFTypeRef) };
    if val.is_null() {
        return None;
    }
    let ty = unsafe { CFGetTypeID(val) };
    if ty != unsafe { CFNumberGetTypeID() } {
        unsafe { CFRelease(val) };
        return None;
    }
    let mut out: i32 = 0;
    let ok = unsafe {
        CFNumberGetValue(
            val as CFNumberRef,
            K_CF_NUMBER_SINT32_TYPE,
            &mut out as *mut _ as *mut c_void,
        )
    };
    unsafe { CFRelease(val) };
    if ok {
        Some(out)
    } else {
        None
    }
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
    let rc = unsafe {
        IOServiceGetMatchingServices(kIOMainPortDefault, matching, &mut it)
    };
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

/// Find the IOAVService whose framebuffer index matches the given display's
/// `CGDisplayUnitNumber`. Returns a ref-counted `IOAVService` pointer ready
/// for `IOAVServiceWriteI2C`; caller is responsible for releasing it via
/// `CFRelease`.
fn find_av_service(display: u32) -> Option<*const c_void> {
    if unsafe { CGDisplayIsBuiltin(display) } != 0 {
        // Built-in panels don't expose a DDC bus — DisplayServices is the
        // only way and we handle that elsewhere.
        return None;
    }
    let want = unsafe { CGDisplayUnitNumber(display) } as i32;

    // Apple Silicon exposes services under `DCPAVServiceProxy`; Intel/T2
    // under plain `IOAVService`. We look at both and keep the first that
    // advertises a framebuffer index matching our target.
    for class_name in ["DCPAVServiceProxy", "IOAVService"] {
        let candidates = iter_services(class_name, |svc| {
            // Some services lack the key; read_number_i32 returns None.
            // "Framebuffer" / "IOFBIndex" are the names that match display
            // unit number in practice. We try both.
            let idx = read_number_i32(svc, "Framebuffer")
                .or_else(|| read_number_i32(svc, "IOFBIndex"))
                .or_else(|| read_number_i32(svc, "Location"));
            match idx {
                Some(i) => i == want,
                None => false,
            }
        });
        if let Some(&svc) = candidates.first() {
            let av = unsafe { IOAVServiceCreateWithService(kCFAllocatorDefault, svc) };
            // Release everything else we collected.
            for extra in candidates.iter().skip(1) {
                unsafe { IOObjectRelease(*extra) };
            }
            unsafe { IOObjectRelease(svc) };
            if av.is_null() {
                return None;
            }
            return Some(av);
        }
    }
    None
}

/// Assemble and send a VCP SET command over DDC/CI. `vcp` is the opcode
/// (0xD6 = Power Mode, 0x10 = Luminance…); `value` is a 16-bit setting.
/// Packet layout per VESA DDC/CI spec:
///   0x51 [length|0x80] 0x03 <vcp> <valueHi> <valueLo> <checksum>
/// Checksum is XOR of destination address 0x6E with bytes [0..6].
fn write_vcp(display: u32, vcp: u8, value: u16) -> Result<(), String> {
    let svc = find_av_service(display)
        .ok_or_else(|| "DDC service not found for this display".to_string())?;
    let mut pkt = [0u8; 8];
    pkt[0] = 0x51; // source address
    pkt[1] = 0x84; // 0x80 | 4 data bytes
    pkt[2] = 0x03; // VCP set
    pkt[3] = vcp;
    pkt[4] = ((value >> 8) & 0xFF) as u8;
    pkt[5] = (value & 0xFF) as u8;
    let mut checksum: u8 = 0x6E; // destination address
    for b in &pkt[..6] {
        checksum ^= b;
    }
    pkt[6] = checksum;

    // The DDC receiver buffer starts at offset 1 of our packet (the
    // `IOAVServiceWriteI2C` signature wants a pointer to the data portion,
    // not the source address). Length of payload is 6.
    let rc = unsafe { IOAVServiceWriteI2C(svc, 0x37, 0x51, pkt[1..].as_ptr(), 6) };
    unsafe { CFRelease(svc as CFTypeRef) };
    if rc == KERN_SUCCESS {
        Ok(())
    } else {
        Err(format!("IOAVServiceWriteI2C: rc={rc}"))
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

/// True when this display answers our IOAVService lookup. Used by the UI so
/// the brightness slider stays enabled for external panels that don't respond
/// to DisplayServices but do accept DDC writes (most USB-C docks and every
/// HDMI monitor with standard VESA DDC/CI).
pub fn can_control(display: u32) -> bool {
    match find_av_service(display) {
        Some(svc) => {
            unsafe { CFRelease(svc as CFTypeRef) };
            true
        }
        None => false,
    }
}
