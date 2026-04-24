use serde::Serialize;
use std::process::Command;

#[derive(Debug, Clone, Serialize, Default)]
pub struct NetIface {
    pub name: String,
    pub kind: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub is_primary: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct DashboardMetrics {
    /// 0..100, aggregated across all cores.
    pub cpu_percent: f32,
    pub load_1m: f32,
    pub load_5m: f32,
    pub load_15m: f32,
    pub mem_used_bytes: u64,
    pub mem_total_bytes: u64,
    pub mem_pressure_percent: f32,
    pub disk_used_bytes: u64,
    pub disk_total_bytes: u64,
    pub disk_free_bytes: u64,
    pub battery_percent: Option<f32>,
    pub battery_charging: Option<bool>,
    pub uptime_seconds: u64,
    pub process_count: u32,
    pub interfaces: Vec<NetIface>,
    /// Round-trip time to a public anchor in milliseconds. `None` when the
    /// ping fails (captive portal, offline, firewall). We keep the probe
    /// ≤500 ms total so a slow network never stalls a dashboard poll.
    pub ping_ms: Option<f32>,
}

/// Parse `vm_stat` output into (total, free_available) in bytes. The
/// "free_available" bucket mirrors Activity Monitor's "Memory Available"
/// — truly free pages plus inactive and speculative pages that the
/// kernel would hand back to apps instantly. Page size is read from the
/// "page size of N bytes" preamble so we don't hard-code 4K (Apple Silicon
/// uses 16K).
pub fn parse_vm_stat(text: &str, total_bytes: u64) -> (u64, u64) {
    let mut page_size: u64 = 4096;
    let mut free_pages: u64 = 0;
    let mut inactive_pages: u64 = 0;
    let mut speculative_pages: u64 = 0;
    let mut purgeable_pages: u64 = 0;
    for line in text.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("Mach Virtual Memory Statistics: (page size of ") {
            if let Some(num) = rest.split_whitespace().next() {
                if let Ok(v) = num.parse::<u64>() {
                    page_size = v;
                }
            }
            continue;
        }
        // Values end with a period; strip it before parsing.
        let grab = |prefix: &str| -> Option<u64> {
            l.strip_prefix(prefix)
                .and_then(|rest| rest.trim().trim_end_matches('.').parse::<u64>().ok())
        };
        if let Some(v) = grab("Pages free:") {
            free_pages = v;
        } else if let Some(v) = grab("Pages inactive:") {
            inactive_pages = v;
        } else if let Some(v) = grab("Pages speculative:") {
            speculative_pages = v;
        } else if let Some(v) = grab("Pages purgeable:") {
            purgeable_pages = v;
        }
    }
    let available = (free_pages + inactive_pages + speculative_pages + purgeable_pages) * page_size;
    (total_bytes, available.min(total_bytes))
}

fn physical_memsize() -> u64 {
    Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .trim()
                .parse::<u64>()
                .ok()
        })
        .unwrap_or(0)
}

fn memory_stats() -> (
    u64, /* used */
    u64, /* total */
    f32, /* pressure% */
) {
    let total = physical_memsize();
    if total == 0 {
        return (0, 0, 0.0);
    }
    let vm_out = match Command::new("vm_stat").output() {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        _ => return (0, total, 0.0),
    };
    let (_, available) = parse_vm_stat(&vm_out, total);
    let used = total.saturating_sub(available);
    let pressure = (used as f64 / total as f64 * 100.0) as f32;
    (used, total, pressure)
}

fn parse_top_snapshot(text: &str) -> (f32, f32, f32, f32, u64, u32) {
    // top -l 1 -n 0 emits, in order:
    //   "Processes: …"
    //   "Load Avg: 3.22, 2.11, 1.80"
    //   "CPU usage: 4.65% user, 10.46% sys, 84.88% idle"
    //   "SharedLibs: …"
    //   "MemRegions: …"
    //   "PhysMem: 23G used (1200M wired, 5G compressor), 8G unused."
    let mut cpu = 0.0f32;
    let mut load1 = 0.0f32;
    let mut load5 = 0.0f32;
    let mut load15 = 0.0f32;
    let mut uptime = 0u64;
    let mut procs: u32 = 0;
    for line in text.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("Processes: ") {
            // "550 total, 3 running, …" → grab the first integer.
            if let Some(num) = rest.split_whitespace().next() {
                procs = num.parse().unwrap_or(0);
            }
        } else if let Some(rest) = l.strip_prefix("Load Avg: ") {
            let mut parts = rest.split(',');
            load1 = parts
                .next()
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(0.0);
            load5 = parts
                .next()
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(0.0);
            load15 = parts
                .next()
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(0.0);
        } else if let Some(rest) = l.strip_prefix("CPU usage: ") {
            // `x% user, y% sys, z% idle` → cpu = user + sys.
            let mut user = 0.0f32;
            let mut sys = 0.0f32;
            for part in rest.split(',') {
                let p = part.trim();
                if let Some(v) = p.strip_suffix("% user") {
                    user = v.parse().unwrap_or(0.0);
                } else if let Some(v) = p.strip_suffix("% sys") {
                    sys = v.parse().unwrap_or(0.0);
                }
            }
            cpu = user + sys;
        }
        // Memory intentionally NOT parsed from `top` any more — the PhysMem
        // line embeds commas inside parentheses ("1200M wired, 5G compressor")
        // which broke naïve split-based parsers and produced bogus totals.
        // See `memory_stats()` which uses vm_stat + sysctl instead.
    }
    // Uptime from sysctl is orders of magnitude more reliable than parsing
    // top's header, which changes format between macOS releases.
    if let Ok(out) = Command::new("sysctl")
        .args(["-n", "kern.boottime"])
        .output()
    {
        let s = String::from_utf8_lossy(&out.stdout);
        // { sec = 1700000000, usec = 0 } Mon Nov 13 12:00:00 2023
        if let Some(sec_str) = s.split("sec = ").nth(1) {
            if let Some(end) = sec_str.find(',') {
                if let Ok(boot) = sec_str[..end].parse::<u64>() {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(boot);
                    uptime = now.saturating_sub(boot);
                }
            }
        }
    }
    (cpu, load1, load5, load15, uptime, procs)
}

fn primary_interface() -> Option<String> {
    // `route -n get default` — look for the "interface: enX" line.
    let out = Command::new("route")
        .args(["-n", "get", "default"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    for line in s.lines() {
        if let Some(rest) = line.trim().strip_prefix("interface:") {
            return Some(rest.trim().to_string());
        }
    }
    None
}

/// Classify an interface name into a coarse "kind" so the UI can pick the
/// right glyph/colour. macOS keeps a stable family (en0 usually Wi-Fi on
/// laptops, enX > 0 usually Ethernet/Thunderbolt), but the user can have
/// several — we only care about Wi-Fi vs Ethernet vs other.
fn iface_kind(name: &str) -> &'static str {
    if name.starts_with("en") {
        // Ask networksetup which interface is Wi-Fi. One-shot cache would be
        // nice but the overhead of a single `networksetup` call per poll is
        // acceptable for a menu-bar app.
        if let Ok(out) = Command::new("networksetup")
            .args(["-listallhardwareports"])
            .output()
        {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout);
                let mut current_kind: Option<&str> = None;
                for line in s.lines() {
                    if let Some(rest) = line.strip_prefix("Hardware Port: ") {
                        current_kind = if rest.contains("Wi-Fi") || rest.contains("AirPort") {
                            Some("wifi")
                        } else if rest.contains("Ethernet") || rest.contains("Thunderbolt") {
                            Some("ethernet")
                        } else {
                            Some("other")
                        };
                    } else if let Some(dev) = line.strip_prefix("Device: ") {
                        if dev.trim() == name {
                            return match current_kind.unwrap_or("other") {
                                "wifi" => "wifi",
                                "ethernet" => "ethernet",
                                _ => "other",
                            };
                        }
                    }
                }
            }
        }
        "other"
    } else if name.starts_with("utun") || name.starts_with("ppp") {
        "vpn"
    } else if name == "lo0" {
        "loopback"
    } else {
        "other"
    }
}

/// macOS surfaces a dozen internal/virtual interfaces that users never
/// think of as "the network": AirDrop, Wi-Fi hotspot bridge, Thunderbolt
/// bridges for unused ports, IPSec helpers, etc. We hide them outright —
/// showing a row of empty tiles is worse than showing nothing.
fn is_internal_iface(name: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "awdl", // AirDrop / AirPlay Wireless Direct Link
        "llw",  // low-latency WLAN (Sidecar)
        "anpi", // Apple Network Probe Interface
        "ipsec", "gif", "stf", "ap", // Wi-Fi hotspot bridge (ap1, ap0)
        "bridge",
        "utun", // Continuity / iCloud Private Relay — always present,
                // almost never the user's conscious "VPN". Real consumer
                // VPNs usually expose a separate `ppp*` or `tun*` or take
                // over as the primary interface, which our "primary +
                // has-traffic" logic already surfaces.
    ];
    PREFIXES.iter().any(|p| name.starts_with(p))
}

/// Query `ifconfig` once for the full set of interfaces. macOS reports
/// `status: active` only on physical links that are plugged in / associated.
/// We return the set of names whose status line says "active" — that's the
/// most reliable "currently usable for Internet" signal without going to
/// the SystemConfiguration framework.
fn active_interface_set() -> std::collections::HashSet<String> {
    let out = match Command::new("ifconfig").output() {
        Ok(o) if o.status.success() => o,
        _ => return std::collections::HashSet::new(),
    };
    let s = String::from_utf8_lossy(&out.stdout);
    let mut active = std::collections::HashSet::new();
    let mut current: Option<String> = None;
    for line in s.lines() {
        // Each interface block starts with "<name>: flags=..." at column 0;
        // property lines are indented with a tab.
        if !line.starts_with(char::is_whitespace) {
            if let Some(name) = line.split(':').next() {
                current = Some(name.to_string());
            }
            continue;
        }
        let trimmed = line.trim_start();
        if trimmed.starts_with("status: active") {
            if let Some(name) = &current {
                active.insert(name.clone());
            }
        }
    }
    active
}

fn list_interfaces(primary: Option<&str>) -> Vec<NetIface> {
    // `netstat -ibn` gives a per-interface table with rx/tx byte counts.
    // Columns (space-separated):
    //   Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
    let out = match Command::new("netstat").args(["-ibn"]).output() {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    let s = String::from_utf8_lossy(&out.stdout);
    let mut by_name: std::collections::BTreeMap<String, NetIface> =
        std::collections::BTreeMap::new();
    for (idx, line) in s.lines().enumerate() {
        if idx == 0 {
            continue;
        }
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 10 {
            continue;
        }
        let name = cols[0].to_string();
        if name == "lo0" || is_internal_iface(&name) {
            continue;
        }
        // `-b` emits ONE row per Network per interface — we want the first
        // canonical row per interface (subsequent ones are aliases).
        if by_name.contains_key(&name) {
            continue;
        }
        let rx_bytes: u64 = cols[6].parse().unwrap_or(0);
        let tx_bytes: u64 = cols[9].parse().unwrap_or(0);
        let kind = iface_kind(&name).to_string();
        let is_primary = primary.map(|p| p == name).unwrap_or(false);
        by_name.insert(
            name.clone(),
            NetIface {
                name,
                kind,
                rx_bytes,
                tx_bytes,
                is_primary,
            },
        );
    }

    // Intersect with interfaces whose `ifconfig` reports `status: active`.
    // That trims en0..en5 (built-in + Thunderbolt bridges) down to whatever
    // is actually plugged in, and drops "up but idle" Wi-Fi radios that
    // aren't associated with a network.
    let active = active_interface_set();
    let mut out: Vec<NetIface> = by_name
        .into_values()
        .filter(|i| i.is_primary || active.contains(&i.name))
        .collect();

    // Single-row-per-kind: keep the busiest ethernet / wifi when macOS
    // still hands us duplicates (e.g. a Thunderbolt dock exposing two
    // active ports).
    out.sort_by(|a, b| {
        b.is_primary
            .cmp(&a.is_primary)
            .then_with(|| (b.rx_bytes + b.tx_bytes).cmp(&(a.rx_bytes + a.tx_bytes)))
    });
    let mut seen_kinds: std::collections::HashSet<String> = std::collections::HashSet::new();
    out.retain(|i| {
        let kind = i.kind.clone();
        if matches!(kind.as_str(), "wifi" | "ethernet") {
            if seen_kinds.contains(&kind) {
                return false;
            }
            seen_kinds.insert(kind);
        }
        true
    });

    out
}

/// Probe the network with a single ICMP echo to Cloudflare's 1.1.1.1.
/// BSD ping exposes the RTT as `time=3.142 ms` — we scrape that rather
/// than depend on stats formatting that changes between macOS versions.
pub fn parse_ping_stdout(text: &str) -> Option<f32> {
    for line in text.lines() {
        if let Some(pos) = line.find("time=") {
            let tail = &line[pos + 5..];
            let end = tail
                .char_indices()
                .take_while(|(_, c)| c.is_ascii_digit() || *c == '.')
                .last()
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(tail.len());
            if end == 0 {
                continue;
            }
            if let Ok(v) = tail[..end].parse::<f32>() {
                return Some(v);
            }
        }
    }
    None
}

fn ping_rtt() -> Option<f32> {
    let out = Command::new("ping")
        .args(["-c", "1", "-t", "1", "-W", "500", "1.1.1.1"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_ping_stdout(&String::from_utf8_lossy(&out.stdout))
}

/// Parse a `df -k` row into (used, total, free) in bytes.
///
/// On APFS `df -k /` reports the read-only System volume for Used (~11 GB)
/// while Available is the shared container-level free space (~15 GB on a
/// nearly-full disk). Computing `free = total − used` therefore gives a
/// wildly optimistic number. Instead we take Available as the source of
/// truth for free space and derive used as `total − free` — matches what
/// Finder / "About This Mac" shows.
pub fn parse_df_row(text: &str) -> Option<(u64, u64, u64)> {
    let mut lines = text.lines();
    lines.next()?; // header
    let row = lines.next()?;
    let cols: Vec<&str> = row.split_whitespace().collect();
    if cols.len() < 4 {
        return None;
    }
    let total = cols[1].parse::<u64>().ok()? * 1024;
    let available = cols[3].parse::<u64>().ok()? * 1024;
    let used = total.saturating_sub(available);
    Some((used, total, available))
}

fn disk_usage() -> (u64, u64, u64) {
    // Prefer the Data volume on APFS — its Used reflects user data, which
    // is what people mean by "disk usage". Fall back to `/` if that path
    // isn't present (older macOS / non-APFS).
    for target in ["/System/Volumes/Data", "/"] {
        if let Ok(o) = Command::new("df").args(["-k", target]).output() {
            if o.status.success() {
                let s = String::from_utf8_lossy(&o.stdout);
                if let Some(v) = parse_df_row(&s) {
                    return v;
                }
            }
        }
    }
    (0, 0, 0)
}

fn battery_state() -> (Option<f32>, Option<bool>) {
    // pmset -g batt → "… 85%; charging; … " or "… 76%; discharging; …"
    let out = match Command::new("pmset").args(["-g", "batt"]).output() {
        Ok(o) if o.status.success() => o,
        _ => return (None, None),
    };
    let s = String::from_utf8_lossy(&out.stdout);
    let pct = s
        .split(';')
        .next()
        .and_then(|seg| seg.rsplit('\t').next())
        .and_then(|seg| seg.trim().trim_end_matches('%').split_whitespace().last())
        .and_then(|v| v.trim_end_matches('%').parse::<f32>().ok());
    let charging = s.contains("charging") && !s.contains("discharging");
    (pct, if pct.is_some() { Some(charging) } else { None })
}

pub fn metrics() -> DashboardMetrics {
    let top_out = Command::new("top")
        .args(["-l", "1", "-n", "0"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    let (cpu, load1, load5, load15, uptime, procs) = parse_top_snapshot(&top_out);
    let (mem_used, mem_total, mem_pressure) = memory_stats();
    let (disk_used, disk_total, disk_free) = disk_usage();
    let (bat_pct, bat_charging) = battery_state();
    let primary = primary_interface();
    let interfaces = list_interfaces(primary.as_deref());
    DashboardMetrics {
        cpu_percent: cpu,
        load_1m: load1,
        load_5m: load5,
        load_15m: load15,
        mem_used_bytes: mem_used,
        mem_total_bytes: mem_total,
        mem_pressure_percent: mem_pressure,
        disk_used_bytes: disk_used,
        disk_total_bytes: disk_total,
        disk_free_bytes: disk_free,
        battery_percent: bat_pct,
        battery_charging: bat_charging,
        uptime_seconds: uptime,
        process_count: procs,
        interfaces,
        ping_ms: ping_rtt(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_top_snapshot_reads_cpu_and_load() {
        let text = "Processes: 500 total\n\
                    Load Avg: 3.22, 2.11, 1.80\n\
                    CPU usage: 4.65% user, 10.46% sys, 84.88% idle\n\
                    SharedLibs: foo\n\
                    MemRegions: foo\n\
                    PhysMem: 23G used (1200M wired, 5G compressor), 8G unused.\n";
        let (cpu, l1, l5, l15, _uptime, procs) = parse_top_snapshot(text);
        assert!((cpu - 15.11).abs() < 0.01);
        assert!((l1 - 3.22).abs() < 0.01);
        assert!((l5 - 2.11).abs() < 0.01);
        assert!((l15 - 1.80).abs() < 0.01);
        assert_eq!(procs, 500);
    }

    #[test]
    fn parse_df_row_uses_available_column() {
        // Mimic APFS Data volume where only ~15 GB is free on a ~146 GB
        // container. Our code must report 15 GB free, not 146 − 11 GB.
        let text = "Filesystem   1024-blocks      Used Available Capacity iused     ifree %iused  Mounted on\n\
                    /dev/disk1s5  146485224 114479308 15826024     88% 1346231 158260240    1%   /System/Volumes/Data\n";
        let (used, total, free) = parse_df_row(text).unwrap();
        assert_eq!(total, 146485224u64 * 1024);
        assert_eq!(free, 15826024u64 * 1024);
        assert_eq!(used, total - free);
    }

    #[test]
    fn parse_vm_stat_extracts_available_memory() {
        // Values chosen so the arithmetic is obvious: on a 16K page system
        // with 100 free + 200 inactive + 50 speculative + 10 purgeable
        // = 360 pages available = 360 * 16384 bytes.
        let text = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n\
                    Pages free:                        100.\n\
                    Pages active:                      500.\n\
                    Pages inactive:                    200.\n\
                    Pages speculative:                  50.\n\
                    Pages throttled:                     0.\n\
                    Pages wired down:                  400.\n\
                    Pages purgeable:                    10.\n";
        let total = 2000u64 * 16384;
        let (got_total, got_avail) = parse_vm_stat(text, total);
        assert_eq!(got_total, total);
        assert_eq!(got_avail, 360u64 * 16384);
    }

    #[test]
    fn parse_ping_extracts_rtt() {
        let sample = "PING 1.1.1.1 (1.1.1.1): 56 data bytes\n\
                      64 bytes from 1.1.1.1: icmp_seq=0 ttl=57 time=3.142 ms\n";
        assert!((parse_ping_stdout(sample).unwrap() - 3.142).abs() < 0.01);
        assert!(parse_ping_stdout("no match here").is_none());
    }
}
