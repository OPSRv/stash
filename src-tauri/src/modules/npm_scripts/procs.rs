//! Process-tree and listening-port inspection for running npm scripts.
//!
//! Parsing lives in pure functions (unit-tested below); the two thin
//! wrappers at the bottom shell out to `ps` / `lsof`.

use std::collections::{BTreeSet, HashMap};
use std::process::Command;

/// One row of `ps -Ao pid=,ppid=,pgid=`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcRow {
    pub pid: u32,
    pub ppid: u32,
    pub pgid: u32,
}

/// Parse `ps -Ao pid=,ppid=,pgid=` output. Malformed lines are skipped.
pub fn parse_ps(text: &str) -> Vec<ProcRow> {
    text.lines()
        .filter_map(|line| {
            let mut it = line.split_whitespace().map(|f| f.parse::<u32>().ok());
            let row = ProcRow {
                pid: it.next()??,
                ppid: it.next()??,
                pgid: it.next()??,
            };
            Some(row)
        })
        .collect()
}

/// Every pid belonging to the job whose process group is `pgid`: the
/// group's members plus all their descendants (children that moved to
/// their own group, e.g. via `setsid`, still count). Sorted, deduplicated.
pub fn job_pids(rows: &[ProcRow], pgid: u32) -> Vec<u32> {
    let mut set: BTreeSet<u32> = rows
        .iter()
        .filter(|r| r.pgid == pgid)
        .map(|r| r.pid)
        .collect();
    // Fixed-point walk down the ppid links; the table is small (a few
    // hundred rows) so the quadratic worst case is irrelevant.
    loop {
        let before = set.len();
        for r in rows {
            if set.contains(&r.ppid) {
                set.insert(r.pid);
            }
        }
        if set.len() == before {
            break;
        }
    }
    set.into_iter().collect()
}

/// Parse `lsof -nP -iTCP -sTCP:LISTEN -Fpn` output into pid → listening
/// ports (sorted, deduplicated). `-F` emits one field per line: `p<pid>`
/// starts a process, `f<fd>` a file, `n<addr>:<port>` its name
/// (`*:5173`, `127.0.0.1:3000`, `[::1]:5173`).
pub fn parse_lsof_listen(text: &str) -> HashMap<u32, Vec<u16>> {
    let mut out: HashMap<u32, BTreeSet<u16>> = HashMap::new();
    let mut pid: Option<u32> = None;
    for line in text.lines() {
        let (tag, rest) = match line.chars().next() {
            Some(c) => (c, &line[c.len_utf8()..]),
            None => continue,
        };
        match tag {
            'p' => pid = rest.trim().parse().ok(),
            'n' => {
                let Some(p) = pid else { continue };
                // Drop a `->peer` suffix just in case a non-LISTEN row slips in.
                let local = rest.split("->").next().unwrap_or(rest);
                if let Some(port) = local
                    .rsplit_once(':')
                    .and_then(|(_, port)| port.trim().parse::<u16>().ok())
                {
                    out.entry(p).or_default().insert(port);
                }
            }
            _ => {}
        }
    }
    out.into_iter()
        .map(|(pid, ports)| (pid, ports.into_iter().collect()))
        .collect()
}

/// Union of the ports listened on by any of `pids`. Sorted, deduplicated.
pub fn ports_for(listen: &HashMap<u32, Vec<u16>>, pids: &[u32]) -> Vec<u16> {
    let set: BTreeSet<u16> = pids
        .iter()
        .filter_map(|p| listen.get(p))
        .flatten()
        .copied()
        .collect();
    set.into_iter().collect()
}

/// Snapshot of every process (pid, ppid, pgid). Empty on failure.
pub fn ps_snapshot() -> Vec<ProcRow> {
    Command::new("/bin/ps")
        .args(["-Ao", "pid=,ppid=,pgid="])
        .output()
        .map(|o| parse_ps(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default()
}

/// TCP LISTEN sockets owned by `pids`. Restricting lsof to the given
/// pids (`-a -p`) keeps it fast. lsof exits 1 when nothing matches, so
/// stdout is parsed regardless of the exit status.
pub fn listening_ports(pids: &[u32]) -> HashMap<u32, Vec<u16>> {
    if pids.is_empty() {
        return HashMap::new();
    }
    let list = pids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    Command::new("/usr/sbin/lsof")
        .args(["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", &list, "-Fpn"])
        .output()
        .map(|o| parse_lsof_listen(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pid: u32, ppid: u32, pgid: u32) -> ProcRow {
        ProcRow { pid, ppid, pgid }
    }

    #[test]
    fn parses_ps_rows_and_skips_garbage() {
        let text = "    1     0     1\n  500     1   500\nPID PPID PGID\n\n 612   500   612 extra\n 7 8\n";
        assert_eq!(
            parse_ps(text),
            vec![row(1, 0, 1), row(500, 1, 500), row(612, 500, 612)]
        );
    }

    #[test]
    fn job_pids_collects_group_and_descendants() {
        // 100 = shell, 200 = npm (job leader), 201 = sh -c vite (same
        // group), 300 = esbuild that called setsid (own group, child of
        // 201), 400 = gitstatusd (background child of the shell), 999 =
        // unrelated.
        let rows = vec![
            row(100, 1, 100),
            row(200, 100, 200),
            row(201, 200, 200),
            row(300, 201, 300),
            row(301, 300, 300),
            row(400, 100, 400),
            row(999, 1, 999),
        ];
        assert_eq!(job_pids(&rows, 200), vec![200, 201, 300, 301]);
        assert!(job_pids(&rows, 12345).is_empty());
    }

    #[test]
    fn parses_lsof_field_output() {
        let text = "p4242\nf23\nn*:5173\nf24\nn[::1]:5173\nf25\nn127.0.0.1:24678\np77\nf3\nnlocalhost:3000\np88\n";
        let map = parse_lsof_listen(text);
        assert_eq!(map.get(&4242), Some(&vec![5173, 24678]));
        assert_eq!(map.get(&77), Some(&vec![3000]));
        assert_eq!(map.get(&88), None);
    }

    #[test]
    fn lsof_parser_ignores_bad_names_and_orphan_lines() {
        let text = "n*:80\np1\nf1\nn*:*\nnnot-a-port\nn10.0.0.1:8080->10.0.0.2:5000\n";
        let map = parse_lsof_listen(text);
        assert_eq!(map.get(&1), Some(&vec![8080]));
        assert_eq!(map.len(), 1);
    }

    #[test]
    fn ports_for_unions_selected_pids() {
        let mut map = HashMap::new();
        map.insert(1, vec![3000, 5173]);
        map.insert(2, vec![5173, 9229]);
        map.insert(3, vec![80]);
        assert_eq!(ports_for(&map, &[1, 2, 4]), vec![3000, 5173, 9229]);
        assert!(ports_for(&map, &[]).is_empty());
    }
}
