//! Tracking of launched npm scripts: running state, listening ports, stop.
//!
//! ## How "running" is decided
//!
//! Every launch gets a run id from `terminal::commands::queue_run`; the
//! Terminal tab reports which pane (PTY) it picked via `terminal_bind_run`.
//! A monitor thread then looks at that pane's PTY every `TICK`:
//!
//! - the PTY's foreground process group (`tcgetpgrp` on the master) equals
//!   the shell pid while the shell sits at its prompt; while `npm run …`
//!   executes, the shell (job control) puts it in its own process group and
//!   makes that group the foreground. So "foreground pgid ≠ shell pid" means
//!   a job is running. This deliberately ignores background children of the
//!   shell (e.g. powerlevel10k's `gitstatusd`), which a plain "does the
//!   shell have descendants" check would mistake for the script.
//! - a job pgid must be seen on two consecutive ticks before the run counts
//!   as started, so a short-lived prompt hook can't be mistaken for it;
//! - once started, the run ends when the shell is back in the foreground
//!   (or another job replaced it), when the pane's PTY is closed or its
//!   shell exits / restarts (shell pid changed). A run that never starts
//!   within `START_GRACE` is dropped.
//!
//! The job's process tree = members of its process group + all their
//! descendants (one `ps -Ao pid=,ppid=,pgid=` per tick). Ports = TCP LISTEN
//! sockets owned by any of those pids (one `lsof … -p <pids>` per tick).
//!
//! The monitor only exists while at least one run is tracked, and the tray
//! menu is rebuilt only when the visible running set / ports change.
//!
//! ## Stop
//!
//! Ctrl+C (`\x03`) is written into the pane, so the TTY sends SIGINT to the
//! foreground job exactly as if the user pressed it. If any process of the
//! job's tree is still alive after `INT_GRACE`, SIGTERM goes to those pids
//! (never to the shell, so the terminal tab stays usable), then SIGKILL
//! after `TERM_GRACE`. The waiting happens on a worker thread.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::procs::{self, ProcRow};
use super::state::NpmScriptsState;
use crate::modules::terminal::commands::{self as terminal, RunPane};

const TICK: Duration = Duration::from_secs(2);
const START_GRACE: Duration = Duration::from_secs(60);
const INT_GRACE: Duration = Duration::from_secs(3);
const TERM_GRACE: Duration = Duration::from_secs(2);
const STOP_POLL: Duration = Duration::from_millis(500);

#[derive(Debug, Clone)]
pub struct TrackedRun {
    pub run_id: u64,
    pub project_path: String,
    pub script: String,
    queued_at: Instant,
    /// Shell pid of the bound pane, pinned on first sight so a pane
    /// restart (new shell, same pane id) ends the run.
    shell_pid: Option<u32>,
    /// Foreground job pgid seen on the previous tick, awaiting confirmation.
    candidate_pgid: Option<u32>,
    /// Confirmed job pgid — `Some` means the script is running.
    job_pgid: Option<u32>,
    pids: Vec<u32>,
    ports: Vec<u16>,
    stopping: bool,
}

impl TrackedRun {
    fn new(run_id: u64, project_path: String, script: String) -> Self {
        Self {
            run_id,
            project_path,
            script,
            queued_at: Instant::now(),
            shell_pid: None,
            candidate_pgid: None,
            job_pgid: None,
            pids: Vec::new(),
            ports: Vec::new(),
            stopping: false,
        }
    }
}

/// A started run as shown in the tray / reported to the assistant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunView {
    pub run_id: u64,
    pub project_path: String,
    pub script: String,
    pub ports: Vec<u16>,
    pub stopping: bool,
}

/// What one tick saw for a run's pane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Observed {
    Gone,
    Unbound,
    Live { shell_pid: u32, fg_pgid: Option<i32> },
}

fn observe(app: &AppHandle, run_id: u64) -> Observed {
    match terminal::run_pane(app, run_id) {
        RunPane::Gone => Observed::Gone,
        RunPane::Unbound => Observed::Unbound,
        RunPane::Live {
            shell_pid, fg_pgid, ..
        } => Observed::Live { shell_pid, fg_pgid },
    }
}

/// Advance one run's state machine. Returns `false` when the run is over
/// and should be dropped. `age` = time since it was queued.
fn advance(run: &mut TrackedRun, obs: Observed, age: Duration) -> bool {
    let (shell_pid, fg_pgid) = match obs {
        Observed::Gone => return false,
        Observed::Unbound => return age < START_GRACE,
        Observed::Live { shell_pid, fg_pgid } => (shell_pid, fg_pgid),
    };
    if *run.shell_pid.get_or_insert(shell_pid) != shell_pid {
        return false;
    }
    let job = fg_pgid
        .filter(|&g| g > 1 && g as u32 != shell_pid)
        .map(|g| g as u32);
    match (run.job_pgid, job) {
        (Some(cur), Some(g)) => cur == g,
        // Shell is back at its prompt: the script finished.
        (Some(_), None) => false,
        (None, Some(g)) => {
            if run.candidate_pgid == Some(g) {
                run.job_pgid = Some(g);
            } else {
                run.candidate_pgid = Some(g);
            }
            true
        }
        (None, None) => {
            run.candidate_pgid = None;
            age < START_GRACE
        }
    }
}

fn view_of(runs: &[TrackedRun]) -> Vec<RunView> {
    runs.iter()
        .filter(|r| r.job_pgid.is_some())
        .map(|r| RunView {
            run_id: r.run_id,
            project_path: r.project_path.clone(),
            script: r.script.clone(),
            ports: r.ports.clone(),
            stopping: r.stopping,
        })
        .collect()
}

/// Pids of `original` that still exist, plus whatever currently belongs to
/// the job's group / tree (children spawned after the snapshot). Never
/// includes the shell or pid ≤ 1.
fn survivors(original: &[u32], rows: &[ProcRow], pgid: u32, shell_pid: u32) -> Vec<u32> {
    let mut out: Vec<u32> = original
        .iter()
        .copied()
        .filter(|p| rows.iter().any(|r| r.pid == *p))
        .collect();
    out.extend(procs::job_pids(rows, pgid));
    out.sort_unstable();
    out.dedup();
    out.retain(|&p| p > 1 && p != shell_pid);
    out
}

fn state(app: &AppHandle) -> Option<tauri::State<'_, Arc<NpmScriptsState>>> {
    app.try_state::<Arc<NpmScriptsState>>()
}

/// Start watching a freshly queued run.
pub fn track(app: &AppHandle, run_id: u64, project_path: String, script: String) {
    let Some(st) = state(app) else { return };
    if let Ok(mut runs) = st.runs.lock() {
        runs.push(TrackedRun::new(run_id, project_path, script));
    }
    ensure_monitor(app);
}

/// Every started run (cheap: reads the cache the monitor maintains).
pub fn running(app: &AppHandle) -> Vec<RunView> {
    let Some(st) = state(app) else {
        return Vec::new();
    };
    let views = st.runs.lock().map(|g| view_of(&g)).unwrap_or_default();
    views
}

fn ensure_monitor(app: &AppHandle) {
    let Some(st) = state(app) else { return };
    if st.monitor_running.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    thread::spawn(move || loop {
        thread::sleep(TICK);
        if refresh(&app) {
            continue;
        }
        let Some(st) = state(&app) else { return };
        st.monitor_running.store(false, Ordering::SeqCst);
        // A run tracked between `refresh` and the store above would have
        // seen the flag still set and not spawned a monitor — reclaim it,
        // unless another monitor already did.
        let pending = st.runs.lock().map(|g| !g.is_empty()).unwrap_or(false);
        if !pending || st.monitor_running.swap(true, Ordering::SeqCst) {
            return;
        }
    });
}

/// One monitor tick. Returns whether any run is still tracked.
fn refresh(app: &AppHandle) -> bool {
    let Some(st) = state(app) else { return false };
    let mut work: Vec<TrackedRun> = st.runs.lock().map(|g| g.clone()).unwrap_or_default();
    if work.is_empty() {
        return false;
    }
    let before = view_of(&work);

    // Observe without holding our lock (`run_pane` takes the terminal's).
    let now = Instant::now();
    let mut dropped: Vec<u64> = Vec::new();
    work.retain_mut(|run| {
        let obs = observe(app, run.run_id);
        let age = now.duration_since(run.queued_at);
        let keep = advance(run, obs, age);
        if !keep {
            dropped.push(run.run_id);
        }
        keep
    });

    if work.iter().any(|r| r.job_pgid.is_some()) {
        let rows = procs::ps_snapshot();
        for run in work.iter_mut() {
            if let Some(pgid) = run.job_pgid {
                run.pids = procs::job_pids(&rows, pgid);
            }
        }
        let all: Vec<u32> = work.iter().flat_map(|r| r.pids.iter().copied()).collect();
        let listen = procs::listening_ports(&all);
        for run in work.iter_mut() {
            run.ports = procs::ports_for(&listen, &run.pids);
        }
    }

    for id in &dropped {
        terminal::forget_run(app, *id);
    }

    let (after, any) = {
        let Ok(mut runs) = st.runs.lock() else {
            return false;
        };
        runs.retain(|r| !dropped.contains(&r.run_id));
        for r in runs.iter_mut() {
            if let Some(w) = work.iter().find(|w| w.run_id == r.run_id) {
                // `stopping` is owned by `stop` — keep whatever it set meanwhile.
                let stopping = r.stopping;
                *r = w.clone();
                r.stopping = stopping;
            }
        }
        (view_of(&runs), !runs.is_empty())
    };
    if after != before {
        crate::tray::rebuild(app);
    }
    any
}

/// Stop a running script (see the module doc for the signal sequence).
/// Returns immediately; the escalation runs on a worker thread.
pub fn stop(app: &AppHandle, run_id: u64) -> Result<(), String> {
    let st = state(app).ok_or_else(|| "npm scripts state is not initialised".to_string())?;
    let pgid = {
        let mut runs = st.runs.lock().map_err(|_| "npm state poisoned".to_string())?;
        let run = runs
            .iter_mut()
            .find(|r| r.run_id == run_id)
            .ok_or_else(|| "that script is no longer running".to_string())?;
        let pgid = run
            .job_pgid
            .ok_or_else(|| "that script has not started yet".to_string())?;
        if run.stopping {
            return Ok(());
        }
        run.stopping = true;
        pgid
    };
    crate::tray::rebuild(app);
    let app = app.clone();
    thread::spawn(move || {
        stop_sequence(&app, run_id, pgid);
        // If the run survived (or vanished), make sure "Stopping…" doesn't
        // stick; the monitor drops finished runs on its next tick.
        if let Some(st) = state(&app) {
            if let Ok(mut runs) = st.runs.lock() {
                if let Some(r) = runs.iter_mut().find(|r| r.run_id == run_id) {
                    r.stopping = false;
                }
            }
        }
        crate::tray::rebuild(&app);
    });
    Ok(())
}

fn stop_sequence(app: &AppHandle, run_id: u64, pgid: u32) {
    let (pane_id, shell_pid) = match terminal::run_pane(app, run_id) {
        RunPane::Live {
            pane_id, shell_pid, ..
        } => (pane_id, shell_pid),
        _ => return,
    };
    let original = procs::job_pids(&procs::ps_snapshot(), pgid);
    if let Err(err) = terminal::write_to_pane(app, &pane_id, b"\x03") {
        tracing::warn!(error = %err, "npm: failed to send Ctrl+C");
    }
    for (grace, signal) in [(INT_GRACE, libc::SIGTERM), (TERM_GRACE, libc::SIGKILL)] {
        let alive = wait_for_exit(&original, pgid, shell_pid, grace);
        if alive.is_empty() {
            return;
        }
        for pid in alive {
            // Our own children (same user); ESRCH on a just-exited pid is fine.
            unsafe {
                libc::kill(pid as libc::pid_t, signal);
            }
        }
    }
}

/// Poll until every process of the job is gone or `grace` elapses; returns
/// the survivors.
fn wait_for_exit(original: &[u32], pgid: u32, shell_pid: u32, grace: Duration) -> Vec<u32> {
    let deadline = Instant::now() + grace;
    loop {
        thread::sleep(STOP_POLL);
        let alive = survivors(original, &procs::ps_snapshot(), pgid, shell_pid);
        if alive.is_empty() || Instant::now() >= deadline {
            return alive;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run() -> TrackedRun {
        TrackedRun::new(1, "/p".into(), "dev".into())
    }

    fn live(shell_pid: u32, fg: i32) -> Observed {
        Observed::Live {
            shell_pid,
            fg_pgid: Some(fg),
        }
    }

    const EARLY: Duration = Duration::from_secs(1);
    const LATE: Duration = Duration::from_secs(120);

    #[test]
    fn waits_for_bind_within_grace() {
        let mut r = run();
        assert!(advance(&mut r, Observed::Unbound, EARLY));
        assert!(!advance(&mut r, Observed::Unbound, LATE));
        assert!(!advance(&mut r, Observed::Gone, EARLY));
    }

    #[test]
    fn starts_after_two_consistent_ticks_and_ends_at_prompt() {
        let mut r = run();
        // Shell still initialising.
        assert!(advance(&mut r, live(100, 100), EARLY));
        assert_eq!(r.job_pgid, None);
        // Job appears: candidate first, confirmed on the next tick.
        assert!(advance(&mut r, live(100, 200), EARLY));
        assert_eq!(r.job_pgid, None);
        assert!(advance(&mut r, live(100, 200), EARLY));
        assert_eq!(r.job_pgid, Some(200));
        // Keeps running long after the start grace.
        assert!(advance(&mut r, live(100, 200), LATE));
        // Shell regains the foreground → finished.
        assert!(!advance(&mut r, live(100, 100), LATE));
    }

    #[test]
    fn short_prompt_hook_is_not_mistaken_for_the_script() {
        let mut r = run();
        assert!(advance(&mut r, live(100, 150), EARLY));
        assert!(advance(&mut r, live(100, 100), EARLY));
        assert_eq!(r.candidate_pgid, None);
        assert!(advance(&mut r, live(100, 200), EARLY));
        assert_eq!(r.job_pgid, None);
    }

    #[test]
    fn ends_on_other_job_shell_restart_or_never_starting() {
        let mut r = run();
        advance(&mut r, live(100, 200), EARLY);
        advance(&mut r, live(100, 200), EARLY);
        assert!(!advance(&mut r.clone(), live(100, 300), EARLY));
        assert!(!advance(&mut r.clone(), live(101, 200), EARLY));
        assert!(!advance(&mut r, Observed::Live { shell_pid: 100, fg_pgid: None }, EARLY));

        let mut idle = run();
        assert!(advance(&mut idle, live(100, 100), EARLY));
        assert!(!advance(&mut idle, live(100, 100), LATE));
    }

    #[test]
    fn view_lists_only_started_runs() {
        let mut started = run();
        started.job_pgid = Some(200);
        started.ports = vec![5173];
        let pending = TrackedRun::new(2, "/p".into(), "build".into());
        let v = view_of(&[started, pending]);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].run_id, 1);
        assert_eq!(v[0].ports, vec![5173]);
    }

    #[test]
    fn survivors_include_escaped_children_but_never_the_shell() {
        let rows = vec![
            ProcRow { pid: 100, ppid: 1, pgid: 100 },
            // 201 was in the job and got reparented to launchd.
            ProcRow { pid: 201, ppid: 1, pgid: 200 },
            ProcRow { pid: 300, ppid: 201, pgid: 300 },
        ];
        // 200 (npm) already exited; 100 must never be signalled.
        assert_eq!(survivors(&[200, 201, 100], &rows, 200, 100), vec![201, 300]);
        assert!(survivors(&[200], &[ProcRow { pid: 100, ppid: 1, pgid: 100 }], 200, 100).is_empty());
    }
}
