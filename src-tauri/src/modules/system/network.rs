use serde::Serialize;
use std::process::Command;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NetConnection {
    pub pid: i32,
    pub process: String,
    pub protocol: String,
    pub local: String,
    pub remote: String,
    pub state: String,
}

/// Parse `lsof -i -n -P` output. Columns (space-separated):
///   COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
/// We only care about IPv4/IPv6 socket rows. Non-TCP rows have no state
/// in parens, which we normalise to "UDP" / "".
pub fn parse_lsof(stdout: &str) -> Vec<NetConnection> {
    let mut out = Vec::new();
    for (idx, line) in stdout.lines().enumerate() {
        if idx == 0 {
            continue;
        }
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 9 {
            continue;
        }
        let protocol = cols[7].to_string();
        if protocol != "TCP" && protocol != "UDP" {
            continue;
        }
        let pid: i32 = cols[1].parse().unwrap_or(0);
        // NAME may span remaining columns when the remote has spaces (rare).
        let name = cols[8..].join(" ");
        let (local, remote, state) = parse_name(&name, &protocol);
        out.push(NetConnection {
            pid,
            process: cols[0].to_string(),
            protocol,
            local,
            remote,
            state,
        });
    }
    out.sort_by(|a, b| a.process.to_lowercase().cmp(&b.process.to_lowercase()));
    out
}

fn parse_name(name: &str, protocol: &str) -> (String, String, String) {
    // "10.0.0.2:54321->192.168.1.1:443 (ESTABLISHED)" or "*:80 (LISTEN)".
    let (pair, state) = if let Some((p, s)) = name.split_once(" (") {
        (p.to_string(), s.trim_end_matches(')').to_string())
    } else {
        (name.to_string(), String::new())
    };
    if let Some((local, remote)) = pair.split_once("->") {
        (local.to_string(), remote.to_string(), state)
    } else {
        let state_final = if state.is_empty() && protocol == "UDP" {
            "UDP".into()
        } else {
            state
        };
        (pair, String::new(), state_final)
    }
}

pub fn list_connections() -> Result<Vec<NetConnection>, String> {
    let out = Command::new("lsof")
        .args(["-i", "-n", "-P"])
        .output()
        .map_err(|e| format!("lsof: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(parse_lsof(&String::from_utf8_lossy(&out.stdout)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_lsof_groups_known_rows() {
        let sample = "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\n\
                      firefox 12345 alice   86u  IPv4 0xabc      0t0  TCP 10.0.0.2:54321->1.2.3.4:443 (ESTABLISHED)\n\
                      node    54321 alice   10u  IPv4 0xdef      0t0  UDP *:5353\n";
        let rows = parse_lsof(sample);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].process, "firefox");
        assert_eq!(rows[0].protocol, "TCP");
        assert_eq!(rows[0].state, "ESTABLISHED");
        assert_eq!(rows[1].protocol, "UDP");
        assert_eq!(rows[1].state, "UDP");
    }
}
