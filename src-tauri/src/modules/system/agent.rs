//! Agent surface for the System tab: `/sys` hub card, `/proc`, `/docker`,
//! `/trash`, `/lock`, `/dns` slash commands + `system_*` LLM tools that
//! expose the rest of the tab (displays, storage scans, launch agents,
//! apps/leftovers, network, battery health…). Lives next to the module it
//! drives; `lib.rs` / `assistant.rs` call `register_commands` /
//! `register_tools`.
//!
//! The quick system commands (/battery, /volume, /screenshot, /display,
//! /sleep, /shutdown, /focus, /weather, /app) and the `get_battery` /
//! `volume_control` tools live in the "quick system commands" section
//! below; `/keepawake` lives in `keepawake/agent.rs`. The hub links to them.
//!
//! Destructive LLM tools are listed in `telegram::confirm::DANGEROUS_TOOLS`;
//! destructive slash-command args opt in via `CommandHandler::dangerous`.
//! In-card destructive buttons (kill, empty trash, docker rm/prune) are
//! two-tap: the first tap re-renders the card with a confirm row.

use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::docker::{self, ContainerAction, DockerContainer, DockerStatus};
use super::processes::{self, ProcessInfo};
use super::{
    battery, caches, dashboard, disk_hogs, displays, duplicates, large_files, launch_agents,
    network, node_modules, privacy, quick_actions, trash_bins, uninstaller,
};
use crate::modules::telegram::commands_registry::{
    CommandHandler, Ctx, InlineButton, InlineKeyboard, Reply,
};
use crate::modules::telegram::state::TelegramState;
use crate::modules::telegram::tools::{Tool, ToolCtx, ToolRegistry};

// ───────────────────────── helpers ─────────────────────────

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("join: {e}"))?
}

fn home() -> Result<PathBuf, String> {
    dirs_next::home_dir().ok_or_else(|| "no home dir".to_string())
}

/// Binary-unit size, e.g. `1.5 GB`.
pub fn fmt_bytes(b: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = b as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{b} B")
    } else if v >= 100.0 {
        format!("{v:.0} {}", UNITS[i])
    } else {
        format!("{v:.1} {}", UNITS[i])
    }
}

/// Compact uptime: `3д 4г`, `4г 12хв`, `12хв`.
pub fn fmt_uptime(secs: u64) -> String {
    let d = secs / 86_400;
    let h = (secs % 86_400) / 3600;
    let m = (secs % 3600) / 60;
    if d > 0 {
        format!("{d}д {h}г")
    } else if h > 0 {
        format!("{h}г {m}хв")
    } else {
        format!("{m}хв")
    }
}

/// 10-cell usage bar.
pub fn bar(pct: f32) -> String {
    let filled = ((pct.clamp(0.0, 100.0) / 10.0).round()) as usize;
    format!("{}{}", "▓".repeat(filled), "░".repeat(10 - filled))
}

fn pct_of(used: u64, total: u64) -> f32 {
    if total == 0 {
        0.0
    } else {
        used as f32 * 100.0 / total as f32
    }
}

/// Char-safe truncation with an ellipsis, also stripping backticks so
/// names can sit inside inline code.
fn short(s: &str, max: usize) -> String {
    let clean = s.replace('`', "'");
    if clean.chars().count() <= max {
        clean
    } else {
        let mut out: String = clean.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

fn back_row() -> Vec<InlineButton> {
    vec![InlineButton::new("⬅ Система", "refresh:sys:")]
}

// ───────────────────────── /sys hub ─────────────────────────

pub fn hub_text(m: &dashboard::DashboardMetrics) -> String {
    let mem_pct = pct_of(m.mem_used_bytes, m.mem_total_bytes);
    let disk_pct = pct_of(m.disk_used_bytes, m.disk_total_bytes);
    let mut s = String::from("🖥 Система\n");
    s.push_str(&format!(
        "CPU  {} {:.0}% · load {:.1}/{:.1}/{:.1}\n",
        bar(m.cpu_percent),
        m.cpu_percent,
        m.load_1m,
        m.load_5m,
        m.load_15m
    ));
    s.push_str(&format!(
        "RAM  {} {} / {} (тиск {:.0}%)\n",
        bar(mem_pct),
        fmt_bytes(m.mem_used_bytes),
        fmt_bytes(m.mem_total_bytes),
        m.mem_pressure_percent
    ));
    s.push_str(&format!(
        "Disk {} {} / {} · вільно {}\n",
        bar(disk_pct),
        fmt_bytes(m.disk_used_bytes),
        fmt_bytes(m.disk_total_bytes),
        fmt_bytes(m.disk_free_bytes)
    ));
    let mut tail = Vec::new();
    if let Some(p) = m.battery_percent {
        let plug = if m.battery_charging == Some(true) { " ⚡" } else { "" };
        tail.push(format!("🔋 {p:.0}%{plug}"));
    }
    tail.push(format!("⏱ {}", fmt_uptime(m.uptime_seconds)));
    tail.push(format!("⚙️ {} процесів", m.process_count));
    match m.ping_ms {
        Some(p) => tail.push(format!("📶 {p:.0} ms")),
        None => tail.push("📶 offline".into()),
    }
    s.push_str(&tail.join(" · "));
    s
}

pub fn hub_keyboard() -> InlineKeyboard {
    InlineKeyboard {
        rows: vec![
            vec![
                InlineButton::new("⚙️ Процеси", "refresh:proc:"),
                InlineButton::new("🐳 Docker", "refresh:docker:"),
                InlineButton::new("🗑 Кошик", "refresh:trash:"),
            ],
            vec![
                InlineButton::new("🔅", "refresh:sys:bright down"),
                InlineButton::new("🔆", "refresh:sys:bright up"),
                InlineButton::new("🖥 Дисплеї", "refresh:sys:displays"),
            ],
            vec![
                InlineButton::new("🔒 Lock", "refresh:sys:lock"),
                InlineButton::new("🌐 Flush DNS", "refresh:sys:dns"),
                InlineButton::new("🔋 Battery", "battery"),
            ],
            vec![InlineButton::new("🔄 Оновити", "refresh:sys:")],
        ],
    }
}

async fn hub(flash: Option<String>) -> Reply {
    let text = match blocking(|| Ok(dashboard::metrics())).await {
        Ok(m) => hub_text(&m),
        Err(e) => format!("⚠️ Метрики недоступні: {e}"),
    };
    Reply {
        text: match flash {
            Some(f) => format!("{f}\n\n{text}"),
            None => text,
        },
        keyboard: Some(hub_keyboard()),
        ..Default::default()
    }
}

fn result_line(ok: &str, res: Result<(), String>) -> String {
    match res {
        Ok(()) => ok.to_string(),
        Err(e) => format!("⚠️ {e}"),
    }
}

pub fn displays_text(list: &[displays::DisplayDevice]) -> String {
    if list.is_empty() {
        return "🖥 Дисплеї не знайдено.".into();
    }
    let mut s = String::from("🖥 Дисплеї\n");
    for d in list {
        let tag = if d.is_main { " (main)" } else { "" };
        let b = match d.brightness {
            Some(v) if d.supports_brightness => format!("{:.0}%", v * 100.0),
            _ => "—".into(),
        };
        s.push_str(&format!(
            "• {}{tag} {}×{} · яскравість {b}\n",
            short(&d.name, 32),
            d.width_px,
            d.height_px
        ));
    }
    s.trim_end().to_string()
}

pub fn displays_keyboard(list: &[displays::DisplayDevice]) -> InlineKeyboard {
    let mut rows: Vec<Vec<InlineButton>> = list
        .iter()
        .filter(|d| d.supports_brightness)
        .take(4)
        .map(|d| {
            let cur = (d.brightness.unwrap_or(0.7) * 100.0).round() as i32;
            let down = (cur - 10).clamp(0, 100);
            let up = (cur + 10).clamp(0, 100);
            let label = short(&d.name, 12);
            vec![
                InlineButton::new(format!("🔅 {label}"), format!("refresh:sys:disp {} {down}", d.id)),
                InlineButton::new(format!("🔆 {label}"), format!("refresh:sys:disp {} {up}", d.id)),
            ]
        })
        .collect();
    rows.push(vec![
        InlineButton::new("🔄", "refresh:sys:displays"),
        InlineButton::new("⬅ Система", "refresh:sys:"),
    ]);
    InlineKeyboard { rows }
}

async fn displays_card(flash: Option<String>) -> Reply {
    let list = blocking(|| Ok(displays::list_hardware_displays()))
        .await
        .unwrap_or_default();
    let body = displays_text(&list);
    Reply {
        text: match flash {
            Some(f) => format!("{f}\n\n{body}"),
            None => body,
        },
        keyboard: Some(displays_keyboard(&list)),
        ..Default::default()
    }
}

pub struct SysCmd;

const SYS_USAGE: &str =
    "/sys [lock | dns | bright up|down | displays | disp <id> <0-100> | spotlight]";

#[async_trait]
impl CommandHandler for SysCmd {
    fn name(&self) -> &'static str {
        "sys"
    }
    fn description(&self) -> &'static str {
        "Система: CPU/RAM/диск/uptime з кнопками (процеси, Docker, кошик, дисплеї, lock, DNS)"
    }
    fn usage(&self) -> &'static str {
        SYS_USAGE
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        let mut it = args.split_whitespace();
        let verb = it.next().unwrap_or("").to_ascii_lowercase();
        match verb.as_str() {
            "" | "status" => hub(None).await,
            "lock" => hub(Some(result_line(
                "🔒 Екран заблоковано.",
                blocking(quick_actions::lock_screen).await,
            )))
            .await,
            "dns" => hub(Some(result_line(
                "🌐 DNS-кеш очищено.",
                blocking(quick_actions::flush_dns).await,
            )))
            .await,
            "spotlight" => hub(Some(result_line(
                "🔎 Spotlight переіндексовується у фоні.",
                blocking(quick_actions::reindex_spotlight).await,
            )))
            .await,
            "bright" | "brightness" => {
                let up = !matches!(
                    it.next().unwrap_or("up").to_ascii_lowercase().as_str(),
                    "down" | "-" | "dim"
                );
                let msg = if up { "🔆 Яскравість +" } else { "🔅 Яскравість −" };
                hub(Some(result_line(
                    msg,
                    blocking(move || displays::adjust_brightness(up)).await,
                )))
                .await
            }
            "displays" => displays_card(None).await,
            "disp" => {
                let id = it.next().and_then(|s| s.parse::<u32>().ok());
                let pct = it.next().and_then(|s| s.parse::<f32>().ok());
                let flash = match (id, pct) {
                    (Some(id), Some(p)) => {
                        let p = p.clamp(0.0, 100.0);
                        result_line(
                            &format!("🔆 Яскравість {p:.0}%"),
                            blocking(move || displays::set_display_brightness(id, p / 100.0))
                                .await,
                        )
                    }
                    _ => format!("❓ {SYS_USAGE}"),
                };
                displays_card(Some(flash)).await
            }
            _ => hub(Some(format!("❓ Використання: {SYS_USAGE}"))).await,
        }
    }
}

// ───────────────────────── /lock, /dns ─────────────────────────

pub struct LockCmd;

#[async_trait]
impl CommandHandler for LockCmd {
    fn name(&self) -> &'static str {
        "lock"
    }
    fn description(&self) -> &'static str {
        "Заблокувати екран Mac (⌃⌘Q)"
    }
    fn usage(&self) -> &'static str {
        "/lock"
    }
    async fn handle(&self, _ctx: Ctx, _args: &str) -> Reply {
        Reply::text(result_line(
            "🔒 Екран заблоковано.",
            blocking(quick_actions::lock_screen).await,
        ))
    }
}

pub struct DnsCmd;

#[async_trait]
impl CommandHandler for DnsCmd {
    fn name(&self) -> &'static str {
        "dns"
    }
    fn description(&self) -> &'static str {
        "Очистити DNS-кеш macOS"
    }
    fn usage(&self) -> &'static str {
        "/dns"
    }
    async fn handle(&self, _ctx: Ctx, _args: &str) -> Reply {
        Reply::text(result_line(
            "🌐 DNS-кеш очищено.",
            blocking(quick_actions::flush_dns).await,
        ))
    }
}

// ───────────────────────── /proc ─────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcSort {
    Cpu,
    Mem,
}

impl ProcSort {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "cpu" => Some(Self::Cpu),
            "mem" | "ram" | "memory" => Some(Self::Mem),
            _ => None,
        }
    }
    pub fn key(self) -> &'static str {
        match self {
            Self::Cpu => "cpu",
            Self::Mem => "mem",
        }
    }
}

/// Sort + optional case-insensitive name/command filter + cap.
pub fn top_processes(
    mut list: Vec<ProcessInfo>,
    sort: ProcSort,
    query: Option<&str>,
    limit: usize,
) -> Vec<ProcessInfo> {
    if let Some(q) = query.map(str::to_lowercase).filter(|q| !q.is_empty()) {
        list.retain(|p| p.name.to_lowercase().contains(&q) || p.command.to_lowercase().contains(&q));
    }
    match sort {
        ProcSort::Cpu => list.sort_by(|a, b| b.cpu_percent.total_cmp(&a.cpu_percent)),
        ProcSort::Mem => list.sort_by(|a, b| b.rss_bytes.cmp(&a.rss_bytes)),
    }
    list.truncate(limit);
    list
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcArgs {
    List { sort: ProcSort, query: Option<String> },
    /// First tap on ✖ — show the confirm row. `tok` is the identity token
    /// (see [`processes::identity_token`]) of the process the card showed.
    Ask { sort: ProcSort, pid: i32, tok: Option<u32> },
    Kill { sort: ProcSort, pid: i32, force: bool, tok: Option<u32> },
    Usage,
}

pub fn parse_proc_args(args: &str) -> ProcArgs {
    let toks: Vec<&str> = args.split_whitespace().collect();
    let Some(first) = toks.first() else {
        return ProcArgs::List { sort: ProcSort::Cpu, query: None };
    };
    let first = first.to_ascii_lowercase();
    if let Some(sort) = ProcSort::parse(&first) {
        return ProcArgs::List { sort, query: None };
    }
    // `<verb> [sort] <pid> [tok]`
    let sort_pid = |rest: &[&str]| -> Option<(ProcSort, i32, Option<u32>)> {
        let (sort, rest) = match rest.first().and_then(|s| ProcSort::parse(s)) {
            Some(sort) => (sort, &rest[1..]),
            None => (ProcSort::Cpu, rest),
        };
        match rest {
            [pid] => Some((sort, pid.parse().ok()?, None)),
            [pid, tok] => Some((sort, pid.parse().ok()?, Some(tok.parse().ok()?))),
            _ => None,
        }
    };
    match first.as_str() {
        "find" | "grep" | "search" if toks.len() > 1 => ProcArgs::List {
            sort: ProcSort::Cpu,
            query: Some(toks[1..].join(" ")),
        },
        "ask" => sort_pid(&toks[1..])
            .map(|(sort, pid, tok)| ProcArgs::Ask { sort, pid, tok })
            .unwrap_or(ProcArgs::Usage),
        "kill" | "term" | "force" | "kill9" => sort_pid(&toks[1..])
            .map(|(sort, pid, tok)| ProcArgs::Kill {
                sort,
                pid,
                force: matches!(first.as_str(), "force" | "kill9"),
                tok,
            })
            .unwrap_or(ProcArgs::Usage),
        _ => ProcArgs::Usage,
    }
}

const PROC_ROWS: usize = 10;

pub fn proc_text(list: &[ProcessInfo], sort: ProcSort, query: Option<&str>) -> String {
    let title = match (sort, query) {
        (_, Some(q)) => format!("⚙️ Процеси «{}»", short(q, 24)),
        (ProcSort::Cpu, None) => "⚙️ Топ процесів за CPU".into(),
        (ProcSort::Mem, None) => "⚙️ Топ процесів за RAM".into(),
    };
    if list.is_empty() {
        return format!("{title}\nНічого не знайдено.");
    }
    let mut s = format!("{title}\n");
    for (i, p) in list.iter().enumerate() {
        s.push_str(&format!(
            "{}. `{}` — {:.1}% · {} · pid {}\n",
            i + 1,
            short(&p.name, 28),
            p.cpu_percent,
            fmt_bytes(p.rss_bytes),
            p.pid
        ));
    }
    s.trim_end().to_string()
}

/// ` <tok>` suffix for a kill/ask callback, empty when the start time is unknown.
fn tok_suffix(tok: Option<u32>) -> String {
    tok.map(|t| format!(" {t}")).unwrap_or_default()
}

fn proc_token(p: &ProcessInfo) -> Option<u32> {
    (p.start_secs > 0).then(|| processes::identity_token(p.start_secs))
}

/// The process behind `pid` is still the one the card showed (`tok`).
/// No token (typed by hand) → nothing to compare, accept.
fn same_process(tok: Option<u32>, current: Option<u32>) -> bool {
    tok.is_none() || tok == current
}

const PROC_CHANGED: &str = "⚠️ Процес змінився — онови список";

/// `me`: current user (only own processes get a kill button); `own_pid`:
/// Stash itself, never offered. `asking`: pid + identity token under confirm.
pub fn proc_keyboard(
    list: &[ProcessInfo],
    sort: ProcSort,
    me: &str,
    own_pid: i32,
    asking: Option<(i32, Option<u32>)>,
) -> InlineKeyboard {
    let mut rows: Vec<Vec<InlineButton>> = Vec::new();
    let k = sort.key();
    if let Some((pid, tok)) = asking {
        let t = tok_suffix(tok);
        rows.push(vec![
            InlineButton::new("✅ Завершити", format!("refresh:proc:kill {k} {pid}{t}")),
            InlineButton::new("💀 Force", format!("refresh:proc:force {k} {pid}{t}")),
            InlineButton::new("✖ Ні", format!("refresh:proc:{k}")),
        ]);
    } else {
        let killable: Vec<InlineButton> = list
            .iter()
            .enumerate()
            .filter(|(_, p)| p.pid > 1 && p.pid != own_pid && (me.is_empty() || p.user == me))
            .map(|(i, p)| {
                InlineButton::new(
                    format!("✖ {} {}", i + 1, short(&p.name, 14)),
                    format!("refresh:proc:ask {k} {}{}", p.pid, tok_suffix(proc_token(p))),
                )
            })
            .collect();
        for chunk in killable.chunks(2) {
            rows.push(chunk.to_vec());
        }
    }
    let mark = |s: ProcSort, label: &str| {
        if s == sort {
            format!("• {label}")
        } else {
            label.to_string()
        }
    };
    rows.push(vec![
        InlineButton::new(mark(ProcSort::Cpu, "CPU"), "refresh:proc:cpu"),
        InlineButton::new(mark(ProcSort::Mem, "RAM"), "refresh:proc:mem"),
        InlineButton::new("🔄", format!("refresh:proc:{k}")),
    ]);
    rows.push(back_row());
    InlineKeyboard { rows }
}

async fn proc_card(
    sort: ProcSort,
    query: Option<String>,
    asking: Option<(i32, Option<u32>)>,
    flash: Option<String>,
) -> Reply {
    let all = match blocking(processes::list_processes).await {
        Ok(l) => l,
        Err(e) => return Reply::text(format!("⚠️ Не вдалося отримати процеси: {e}")),
    };
    let mut list = top_processes(all.clone(), sort, query.as_deref(), PROC_ROWS);
    // A stale card: the pid now belongs to another process (or is gone).
    let (asking, flash) = match asking {
        Some((pid, tok))
            if !same_process(tok, all.iter().find(|p| p.pid == pid).and_then(proc_token)) =>
        {
            (None, Some(PROC_CHANGED.to_string()))
        }
        a => (a, flash),
    };
    // Keep the target visible in the confirm view even if it fell off the top.
    if let Some((pid, _)) = asking {
        if !list.iter().any(|p| p.pid == pid) {
            if let Some(p) = all.iter().find(|p| p.pid == pid) {
                list.push(p.clone());
            }
        }
    }
    let me = processes::current_user();
    let mut text = proc_text(&list, sort, query.as_deref());
    if let Some((pid, _)) = asking {
        let name = all
            .iter()
            .find(|p| p.pid == pid)
            .map(|p| short(&p.name, 28))
            .unwrap_or_else(|| "?".into());
        text.push_str(&format!(
            "\n\n⚠️ Завершити `{name}` (pid {pid})? Натисни ✅ ще раз, щоб підтвердити."
        ));
    }
    if let Some(f) = flash {
        text = format!("{f}\n\n{text}");
    }
    Reply {
        text,
        keyboard: Some(proc_keyboard(&list, sort, &me, std::process::id() as i32, asking)),
        ..Default::default()
    }
}

pub struct ProcCmd;

const PROC_USAGE: &str = "/proc [cpu|mem] | /proc find <назва> | /proc kill [cpu|mem] <pid> | /proc force <pid>";

#[async_trait]
impl CommandHandler for ProcCmd {
    fn name(&self) -> &'static str {
        "proc"
    }
    fn description(&self) -> &'static str {
        "Топ процесів за CPU/RAM з кнопками завершення (двоетапне підтвердження)"
    }
    fn usage(&self) -> &'static str {
        PROC_USAGE
    }
    fn dangerous(&self, args: &str) -> bool {
        matches!(parse_proc_args(args), ProcArgs::Kill { .. })
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        match parse_proc_args(args) {
            ProcArgs::List { sort, query } => proc_card(sort, query, None, None).await,
            ProcArgs::Ask { sort, pid, tok } => {
                proc_card(sort, None, Some((pid, tok)), None).await
            }
            ProcArgs::Kill { sort, pid, force, tok } => {
                let res = blocking(move || {
                    if !same_process(tok, processes::current_token(pid)) {
                        return Ok(false);
                    }
                    processes::kill_process(pid, force).map(|_| true)
                })
                .await;
                let flash = match res {
                    Ok(false) => PROC_CHANGED.to_string(),
                    res => {
                        let sig = if force { "SIGKILL" } else { "SIGTERM" };
                        result_line(&format!("✅ {sig} → pid {pid}"), res.map(|_| ()))
                    }
                };
                proc_card(sort, None, None, Some(flash)).await
            }
            ProcArgs::Usage => Reply::text(format!("⚙️ {PROC_USAGE}")),
        }
    }
}

// ───────────────────────── /docker ─────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DockerArgs {
    Show,
    Launch,
    Act { action: ContainerAction, id: String },
    /// First tap on a disruptive container button (stop/restart/rm) —
    /// render the confirm row.
    Ask { action: ContainerAction, id: String },
    AskPrune,
    Prune,
    Usage,
}

pub fn parse_docker_args(args: &str) -> DockerArgs {
    let toks: Vec<&str> = args.split_whitespace().collect();
    match toks.as_slice() {
        [] => DockerArgs::Show,
        [v] if v.eq_ignore_ascii_case("launch") || v.eq_ignore_ascii_case("open") => {
            DockerArgs::Launch
        }
        [v] if v.eq_ignore_ascii_case("askprune") => DockerArgs::AskPrune,
        [v] if v.eq_ignore_ascii_case("prune") => DockerArgs::Prune,
        [v, id]
            if v.get(..3).is_some_and(|p| p.eq_ignore_ascii_case("ask"))
                && docker::is_valid_container_ref(id) =>
        {
            match ContainerAction::parse(&v[3..]) {
                Some(action) if action != ContainerAction::Start => {
                    DockerArgs::Ask { action, id: id.to_string() }
                }
                _ => DockerArgs::Usage,
            }
        }
        [v, id] if docker::is_valid_container_ref(id) => match ContainerAction::parse(v) {
            Some(action) => DockerArgs::Act { action, id: id.to_string() },
            None => DockerArgs::Usage,
        },
        _ => DockerArgs::Usage,
    }
}

pub fn docker_text(st: &DockerStatus, containers: &[DockerContainer]) -> String {
    if !st.installed {
        return "🐳 Docker не встановлено.".into();
    }
    let ver = st.version.as_deref().unwrap_or("?");
    if !st.running {
        return format!("🐳 Docker {ver} · не запущено");
    }
    let mut s = format!("🐳 Docker {ver} · запущено\n");
    for it in &st.items {
        s.push_str(&format!(
            "• {} {} ({} акт.) · {} · звільнити {}\n",
            it.kind,
            it.total,
            it.active,
            fmt_bytes(it.size_bytes),
            fmt_bytes(it.reclaimable_bytes)
        ));
    }
    if containers.is_empty() {
        s.push_str("\nКонтейнерів немає.");
    } else {
        s.push_str("\nКонтейнери:\n");
        for c in containers.iter().take(DOCKER_ROWS) {
            let dot = if c.is_running() { "🟢" } else { "⚪" };
            s.push_str(&format!(
                "{dot} `{}` ({}) — {}\n",
                short(&c.name, 24),
                short(&c.image, 24),
                short(&c.status, 32)
            ));
        }
        if containers.len() > DOCKER_ROWS {
            s.push_str(&format!("…і ще {}\n", containers.len() - DOCKER_ROWS));
        }
    }
    s.trim_end().to_string()
}

const DOCKER_ROWS: usize = 8;

/// Callback verb for a container action (`ContainerAction::parse` round-trips it).
fn docker_cmd(a: ContainerAction) -> &'static str {
    match a {
        ContainerAction::Start => "start",
        ContainerAction::Stop => "stop",
        ContainerAction::Restart => "restart",
        ContainerAction::Remove => "rm",
    }
}

/// Ukrainian infinitive for the confirm button / prompt.
fn docker_verb(a: ContainerAction) -> &'static str {
    match a {
        ContainerAction::Start => "Запустити",
        ContainerAction::Stop => "Зупинити",
        ContainerAction::Restart => "Перезапустити",
        ContainerAction::Remove => "Видалити",
    }
}

pub fn docker_keyboard(
    st: &DockerStatus,
    containers: &[DockerContainer],
    confirm: Option<&DockerArgs>,
) -> InlineKeyboard {
    let mut rows: Vec<Vec<InlineButton>> = Vec::new();
    match confirm {
        Some(DockerArgs::Ask { action, id }) => rows.push(vec![
            InlineButton::new(
                format!("✅ {}", docker_verb(*action)),
                format!("refresh:docker:{} {id}", docker_cmd(*action)),
            ),
            InlineButton::new("✖ Ні", "refresh:docker:"),
        ]),
        Some(DockerArgs::AskPrune) => rows.push(vec![
            InlineButton::new("✅ Prune усе", "refresh:docker:prune"),
            InlineButton::new("✖ Ні", "refresh:docker:"),
        ]),
        _ => {}
    }
    if confirm.is_none() {
        if st.installed && !st.running {
            rows.push(vec![InlineButton::new("▶ Запустити Docker", "refresh:docker:launch")]);
        }
        for c in containers.iter().take(DOCKER_ROWS) {
            let label = short(&c.name, 14);
            rows.push(if c.is_running() {
                vec![
                    InlineButton::new(format!("⏹ {label}"), format!("refresh:docker:askstop {}", c.id)),
                    InlineButton::new("🔄", format!("refresh:docker:askrestart {}", c.id)),
                ]
            } else {
                vec![
                    InlineButton::new(format!("▶ {label}"), format!("refresh:docker:start {}", c.id)),
                    InlineButton::new("🗑", format!("refresh:docker:askrm {}", c.id)),
                ]
            });
        }
        let mut tail = vec![InlineButton::new("🔄 Оновити", "refresh:docker:")];
        if st.running {
            tail.insert(0, InlineButton::new("🧹 Prune", "refresh:docker:askprune"));
        }
        rows.push(tail);
    }
    rows.push(back_row());
    InlineKeyboard { rows }
}

async fn docker_card(confirm: Option<DockerArgs>, flash: Option<String>) -> Reply {
    let (st, containers) = blocking(|| {
        let st = docker::status();
        let cs = if st.running {
            docker::list_containers().unwrap_or_default()
        } else {
            Vec::new()
        };
        Ok((st, cs))
    })
    .await
    .unwrap_or_default();
    let mut text = docker_text(&st, &containers);
    match &confirm {
        Some(DockerArgs::Ask { action, id }) => {
            let name = containers
                .iter()
                .find(|c| &c.id == id)
                .map(|c| short(&c.name, 24))
                .unwrap_or_else(|| id.clone());
            let tail = if *action == ContainerAction::Remove { " Це незворотно." } else { "" };
            text.push_str(&format!(
                "\n\n⚠️ {} контейнер `{name}`?{tail}",
                docker_verb(*action)
            ));
        }
        Some(DockerArgs::AskPrune) => text.push_str(
            "\n\n⚠️ Prune видалить усі зупинені контейнери, невикористані образи, томи та build cache.",
        ),
        _ => {}
    }
    if let Some(f) = flash {
        text = format!("{f}\n\n{text}");
    }
    Reply {
        keyboard: Some(docker_keyboard(&st, &containers, confirm.as_ref())),
        text,
        ..Default::default()
    }
}

fn launch_docker_desktop() -> Result<(), String> {
    let out = std::process::Command::new("open")
        .args(["-a", "Docker"])
        .output()
        .map_err(|e| format!("open: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

pub struct DockerCmd;

const DOCKER_USAGE: &str = "/docker [start|stop|restart|rm <id> | prune | launch]";

#[async_trait]
impl CommandHandler for DockerCmd {
    fn name(&self) -> &'static str {
        "docker"
    }
    fn description(&self) -> &'static str {
        "Docker: використання диска, контейнери з кнопками start/stop/restart, prune"
    }
    fn usage(&self) -> &'static str {
        DOCKER_USAGE
    }
    fn dangerous(&self, args: &str) -> bool {
        match parse_docker_args(args) {
            DockerArgs::Prune => true,
            DockerArgs::Act { action, .. } => {
                matches!(action, ContainerAction::Stop | ContainerAction::Remove)
            }
            _ => false,
        }
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        match parse_docker_args(args) {
            DockerArgs::Show => docker_card(None, None).await,
            a @ (DockerArgs::Ask { .. } | DockerArgs::AskPrune) => {
                docker_card(Some(a), None).await
            }
            DockerArgs::Launch => {
                let flash = result_line(
                    "▶ Docker Desktop запускається — онови за хвилину.",
                    blocking(launch_docker_desktop).await,
                );
                docker_card(None, Some(flash)).await
            }
            DockerArgs::Act { action, id } => {
                let label = match action {
                    ContainerAction::Start => "▶ Запущено",
                    ContainerAction::Stop => "⏹ Зупинено",
                    ContainerAction::Restart => "🔄 Перезапущено",
                    ContainerAction::Remove => "🗑 Видалено",
                };
                let target = id.clone();
                let res = blocking(move || docker::container_action(&target, action)).await;
                docker_card(None, Some(result_line(&format!("{label}: {id}"), res))).await
            }
            DockerArgs::Prune => {
                let flash = match blocking(docker::prune).await {
                    Ok(r) => format!("🧹 Prune: звільнено {}", fmt_bytes(r.reclaimed_bytes)),
                    Err(e) => format!("⚠️ {e}"),
                };
                docker_card(None, Some(flash)).await
            }
            DockerArgs::Usage => Reply::text(format!("🐳 {DOCKER_USAGE}")),
        }
    }
}

// ───────────────────────── /trash ─────────────────────────

pub fn trash_text(bins: &[trash_bins::TrashBin]) -> String {
    let total: u64 = bins.iter().map(|b| b.size_bytes).sum();
    let items: u64 = bins.iter().map(|b| b.item_count).sum();
    let mut s = format!("🗑 Кошик: {} · {items} об'єктів\n", fmt_bytes(total));
    for b in bins.iter().filter(|b| b.item_count > 0 || b.size_bytes > 0) {
        s.push_str(&format!(
            "• {} — {} ({})\n",
            short(&b.volume, 24),
            fmt_bytes(b.size_bytes),
            b.item_count
        ));
    }
    s.trim_end().to_string()
}

pub fn trash_keyboard(asking: bool, empty: bool) -> InlineKeyboard {
    let mut rows = Vec::new();
    if asking {
        rows.push(vec![
            InlineButton::new("✅ Так, очистити", "refresh:trash:empty"),
            InlineButton::new("✖ Ні", "refresh:trash:"),
        ]);
    } else {
        let mut r = vec![InlineButton::new("🔄", "refresh:trash:")];
        if !empty {
            r.insert(0, InlineButton::new("🗑 Очистити", "refresh:trash:ask"));
        }
        rows.push(r);
    }
    rows.push(back_row());
    InlineKeyboard { rows }
}

async fn trash_card(asking: bool, flash: Option<String>) -> Reply {
    let bins = match home() {
        Ok(h) => blocking(move || Ok(trash_bins::list_bins(&h))).await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let empty = bins.iter().all(|b| b.item_count == 0 && b.size_bytes == 0);
    let mut text = trash_text(&bins);
    if asking {
        text.push_str("\n\n⚠️ Очистити кошик на всіх томах? Це незворотно.");
    }
    if let Some(f) = flash {
        text = format!("{f}\n\n{text}");
    }
    Reply {
        text,
        keyboard: Some(trash_keyboard(asking, empty)),
        ..Default::default()
    }
}

pub struct TrashCmd;

#[async_trait]
impl CommandHandler for TrashCmd {
    fn name(&self) -> &'static str {
        "trash"
    }
    fn description(&self) -> &'static str {
        "Розмір кошика на всіх томах і очищення (з підтвердженням)"
    }
    fn usage(&self) -> &'static str {
        "/trash [empty]"
    }
    fn dangerous(&self, args: &str) -> bool {
        args.trim().eq_ignore_ascii_case("empty")
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        match args.trim().to_ascii_lowercase().as_str() {
            "ask" => trash_card(true, None).await,
            "empty" => {
                let flash = result_line("✅ Кошик очищено.", blocking(trash_bins::empty_all).await);
                trash_card(false, Some(flash)).await
            }
            _ => trash_card(false, None).await,
        }
    }
}

// ───────────────────────── LLM tools ─────────────────────────

/// All System operations are synchronous shell-outs / syscalls, so every
/// tool is a plain fn run on the blocking pool.
type RunFn = fn(&Value) -> Result<Value, String>;

pub struct SysTool {
    name: &'static str,
    description: &'static str,
    schema: fn() -> Value,
    timeout_secs: u64,
    run: RunFn,
}

#[async_trait]
impl Tool for SysTool {
    fn name(&self) -> &'static str {
        self.name
    }
    fn description(&self) -> &'static str {
        self.description
    }
    fn schema(&self) -> Value {
        (self.schema)()
    }
    fn timeout(&self) -> Option<Duration> {
        Some(Duration::from_secs(self.timeout_secs))
    }
    async fn invoke(&self, _ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let run = self.run;
        blocking(move || run(&args)).await
    }
}

fn arg_str<'a>(a: &'a Value, k: &str) -> Option<&'a str> {
    a.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn arg_u64(a: &Value, k: &str) -> Option<u64> {
    a.get(k).and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f.max(0.0) as u64)))
}

fn limit_arg(a: &Value, default: usize, max: usize) -> usize {
    arg_u64(a, "limit").map(|n| n as usize).unwrap_or(default).clamp(1, max)
}

fn empty_schema() -> Value {
    json!({ "type": "object", "properties": {}, "additionalProperties": false })
}

fn to_json<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

fn ok_done() -> Result<Value, String> {
    Ok(json!({ "ok": true }))
}

/// Case-insensitive substring filter helper.
fn matches_q(q: Option<&str>, fields: &[&str]) -> bool {
    match q {
        None => true,
        Some(q) => {
            let q = q.to_lowercase();
            fields.iter().any(|f| f.to_lowercase().contains(&q))
        }
    }
}

fn run_metrics(_: &Value) -> Result<Value, String> {
    let m = dashboard::metrics();
    let summary = hub_text(&m);
    let mut v = to_json(m)?;
    v["summary"] = json!(summary);
    Ok(v)
}

fn run_processes(a: &Value) -> Result<Value, String> {
    let sort = arg_str(a, "sort").and_then(ProcSort::parse).unwrap_or(ProcSort::Cpu);
    let list = top_processes(
        processes::list_processes()?,
        sort,
        arg_str(a, "query"),
        limit_arg(a, 10, 50),
    );
    let rows: Vec<Value> = list
        .iter()
        .map(|p| {
            json!({
                "pid": p.pid, "name": p.name, "user": p.user,
                "cpu_percent": p.cpu_percent, "rss_bytes": p.rss_bytes,
                "rss": fmt_bytes(p.rss_bytes),
                "command": short(&p.command, 200),
            })
        })
        .collect();
    Ok(json!({ "sort": sort.key(), "processes": rows }))
}

fn run_kill(a: &Value) -> Result<Value, String> {
    let pid = a.get("pid").and_then(Value::as_i64).ok_or("missing `pid`")? as i32;
    let force = a.get("force").and_then(Value::as_bool).unwrap_or(false);
    // Optional identity check: the pid may have been reused since the model
    // listed processes. `kill_process` itself refuses Stash's own pid.
    if let Some(expected) = arg_str(a, "name").filter(|n| !n.trim().is_empty()) {
        let list = processes::list_processes()?;
        let actual = list.iter().find(|p| p.pid == pid).map(|p| p.name.as_str());
        if !name_matches(expected, actual) {
            return Err(format!(
                "pid {pid} is now `{}`, not `{expected}` — list processes again",
                actual.unwrap_or("gone")
            ));
        }
    }
    processes::kill_process(pid, force)?;
    Ok(json!({ "ok": true, "pid": pid, "signal": if force { "SIGKILL" } else { "SIGTERM" } }))
}

/// Case-insensitive match of a model-supplied process name against the live one.
fn name_matches(expected: &str, actual: Option<&str>) -> bool {
    let e = expected.trim().to_lowercase();
    actual.is_some_and(|a| {
        let a = a.to_lowercase();
        a == e || a.contains(&e) || e.contains(&a)
    })
}

fn run_quick_action(a: &Value) -> Result<Value, String> {
    match arg_str(a, "action").ok_or("missing `action`")? {
        "lock_screen" => quick_actions::lock_screen()?,
        "flush_dns" => quick_actions::flush_dns()?,
        "reindex_spotlight" => quick_actions::reindex_spotlight()?,
        "purge_memory" => quick_actions::empty_memory_pressure()?,
        "sleep_displays" => displays::sleep_displays()?,
        other => return Err(format!("unknown action `{other}`")),
    }
    ok_done()
}

fn main_display_id(list: &[displays::DisplayDevice]) -> Option<u32> {
    list.iter().find(|d| d.is_main).or(list.first()).map(|d| d.id)
}

fn run_displays(a: &Value) -> Result<Value, String> {
    match arg_str(a, "action").unwrap_or("list") {
        "list" => {
            let list = displays::list_hardware_displays();
            let arrangement = displays::list_displays().unwrap_or_default();
            Ok(json!({ "displays": to_json(list)?, "arrangement": to_json(arrangement)? }))
        }
        "set_brightness" => {
            let pct = a
                .get("percent")
                .and_then(Value::as_f64)
                .ok_or("missing `percent` (0-100)")?
                .clamp(0.0, 100.0) as f32;
            let id = match arg_u64(a, "display_id") {
                Some(id) => id as u32,
                None => main_display_id(&displays::list_hardware_displays())
                    .ok_or("no displays found")?,
            };
            displays::set_display_brightness(id, pct / 100.0)?;
            Ok(json!({ "ok": true, "display_id": id, "percent": pct }))
        }
        "brighter" => displays::adjust_brightness(true).and_then(|_| ok_done()),
        "dimmer" => displays::adjust_brightness(false).and_then(|_| ok_done()),
        other => Err(format!("unknown action `{other}`")),
    }
}

fn run_display_power(a: &Value) -> Result<Value, String> {
    let id = arg_u64(a, "display_id").ok_or("missing `display_id`")? as u32;
    let master = || -> Result<u32, String> {
        match arg_u64(a, "master_id") {
            Some(m) => Ok(m as u32),
            None => displays::list_hardware_displays()
                .iter()
                .find(|d| d.is_main && d.id != id)
                .map(|d| d.id)
                .ok_or_else(|| "missing `master_id`".to_string()),
        }
    };
    match arg_str(a, "action").ok_or("missing `action`")? {
        "hide" => displays::set_display_hidden(id, master()?, true)?,
        "show" => displays::set_display_hidden(id, master()?, false)?,
        "power_off" => displays::power_off_display(id, master()?)?,
        "power_on" => displays::power_on_display(id)?,
        other => return Err(format!("unknown action `{other}`")),
    }
    ok_done()
}

fn run_trash_status(_: &Value) -> Result<Value, String> {
    let bins = trash_bins::list_bins(&home()?);
    let total: u64 = bins.iter().map(|b| b.size_bytes).sum();
    Ok(json!({ "total_bytes": total, "total": fmt_bytes(total), "bins": to_json(bins)? }))
}

fn run_empty_trash(_: &Value) -> Result<Value, String> {
    trash_bins::empty_all()?;
    ok_done()
}

fn run_docker(_: &Value) -> Result<Value, String> {
    let st = docker::status();
    let containers = if st.running {
        docker::list_containers().unwrap_or_default()
    } else {
        Vec::new()
    };
    Ok(json!({ "status": to_json(st)?, "containers": to_json(containers)? }))
}

fn run_docker_container(a: &Value) -> Result<Value, String> {
    let target = arg_str(a, "container").ok_or("missing `container`")?;
    let action = arg_str(a, "action")
        .and_then(ContainerAction::parse)
        .ok_or("`action` must be start|stop|restart|remove")?;
    docker::container_action(target, action)?;
    ok_done()
}

fn run_docker_prune(_: &Value) -> Result<Value, String> {
    let r = docker::prune()?;
    Ok(json!({ "reclaimed_bytes": r.reclaimed_bytes, "reclaimed": fmt_bytes(r.reclaimed_bytes) }))
}

/// Every `system_storage_scan` row carries `size_bytes`; sort + cap.
fn top_by_size(mut rows: Vec<Value>, limit: usize) -> Value {
    rows.sort_by_key(|r| std::cmp::Reverse(r["size_bytes"].as_u64().unwrap_or(0)));
    let total: u64 = rows.iter().filter_map(|r| r["size_bytes"].as_u64()).sum();
    let count = rows.len();
    rows.truncate(limit);
    json!({ "count": count, "total_bytes": total, "total": fmt_bytes(total), "items": rows })
}

fn rows_of<T: serde::Serialize>(v: Vec<T>) -> Result<Vec<Value>, String> {
    v.into_iter().map(to_json).collect()
}

fn run_storage_scan(a: &Value) -> Result<Value, String> {
    let kind = arg_str(a, "kind").ok_or("missing `kind`")?;
    let limit = limit_arg(a, 20, 100);
    let h = home()?;
    let root = || arg_str(a, "root").map(PathBuf::from).unwrap_or_else(|| h.clone());
    let min_mb = arg_u64(a, "min_mb");
    let rows = match kind {
        "caches" => rows_of(caches::list_caches(&h))?,
        "large_files" => {
            let min = min_mb.unwrap_or(500) * 1024 * 1024;
            let s = large_files::scan(&root(), min, limit);
            let mut v = top_by_size(rows_of(s.files)?, limit);
            v["scanned"] = json!(s.scanned);
            return Ok(v);
        }
        "node_modules" => rows_of(node_modules::scan(&root()))?,
        "duplicates" => {
            let min = min_mb.map(|m| m * 1024 * 1024).unwrap_or(1024 * 1024);
            let groups = duplicates::find(&root(), min);
            // Rank groups by wasted space (all copies but one).
            let rows: Vec<Value> = groups
                .into_iter()
                .map(|g| {
                    let wasted = g.size_bytes * (g.paths.len().saturating_sub(1) as u64);
                    json!({ "size_bytes": wasted, "file_size": g.size_bytes, "paths": g.paths })
                })
                .collect();
            rows
        }
        "screenshots" => rows_of(disk_hogs::list_screenshots(&h))?,
        "ios_backups" => rows_of(disk_hogs::list_ios_backups(&h))?,
        "mail_attachments" => rows_of(disk_hogs::list_mail_attachments(&h))?,
        "xcode_simulators" => rows_of(disk_hogs::list_xcode_simulators(&h))?,
        "privacy" => rows_of(privacy::list_privacy(&h))?,
        "tm_snapshots" => {
            let snaps = disk_hogs::list_tm_snapshots();
            return Ok(json!({ "count": snaps.len(), "items": to_json(snaps)? }));
        }
        other => return Err(format!("unknown kind `{other}`")),
    };
    Ok(top_by_size(rows, limit))
}

fn run_move_to_trash(a: &Value) -> Result<Value, String> {
    let path = arg_str(a, "path").ok_or("missing `path`")?;
    large_files::move_to_trash(path)?;
    ok_done()
}

fn run_storage_cleanup(a: &Value) -> Result<Value, String> {
    match arg_str(a, "action").ok_or("missing `action`")? {
        "delete_tm_snapshot" => {
            disk_hogs::delete_tm_snapshot(arg_str(a, "name").ok_or("missing `name`")?)?
        }
        "delete_unavailable_simulators" => disk_hogs::delete_unavailable_simulators()?,
        other => return Err(format!("unknown action `{other}`")),
    }
    ok_done()
}

fn run_launch_agents(a: &Value) -> Result<Value, String> {
    let q = arg_str(a, "query");
    let list: Vec<_> = launch_agents::list_agents(&home()?)
        .into_iter()
        .filter(|ag| matches_q(q, &[&ag.label, &ag.path]))
        .take(limit_arg(a, 50, 200))
        .collect();
    Ok(json!({ "agents": to_json(list)? }))
}

fn run_toggle_launch_agent(a: &Value) -> Result<Value, String> {
    let path = arg_str(a, "path").ok_or("missing `path`")?;
    let enable = a.get("enable").and_then(Value::as_bool).ok_or("missing `enable`")?;
    launch_agents::toggle_agent(path, enable)?;
    ok_done()
}

fn run_apps(a: &Value) -> Result<Value, String> {
    let h = home()?;
    let q = arg_str(a, "query");
    let mut apps: Vec<_> = uninstaller::list_apps(&h)
        .into_iter()
        .filter(|ap| matches_q(q, &[&ap.name, ap.bundle_id.as_deref().unwrap_or("")]))
        .collect();
    apps.sort_by_key(|ap| std::cmp::Reverse(ap.size_bytes));
    apps.truncate(limit_arg(a, 20, 200));
    let with_leftovers = a.get("include_leftovers").and_then(Value::as_bool) == Some(true);
    let rows: Vec<Value> = apps
        .iter()
        .enumerate()
        .map(|(i, ap)| {
            let mut v = json!({
                "name": ap.name, "path": ap.path, "bundle_id": ap.bundle_id,
                "size_bytes": ap.size_bytes, "size": fmt_bytes(ap.size_bytes),
            });
            // Leftover scans are slow — only for the top few matches.
            if with_leftovers && i < 3 {
                let lo = uninstaller::find_leftovers(&h, ap.bundle_id.as_deref(), &ap.name);
                v["leftovers"] = serde_json::to_value(lo).unwrap_or(Value::Null);
            }
            v
        })
        .collect();
    Ok(json!({ "apps": rows }))
}

fn run_connections(a: &Value) -> Result<Value, String> {
    let q = arg_str(a, "query");
    let list: Vec<_> = network::list_connections()?
        .into_iter()
        .filter(|c| matches_q(q, &[&c.process, &c.remote, &c.local, &c.state]))
        .take(limit_arg(a, 30, 200))
        .collect();
    Ok(json!({ "connections": to_json(list)? }))
}

fn run_battery_health(_: &Value) -> Result<Value, String> {
    to_json(battery::read_health())
}

fn run_frontmost(_: &Value) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(match super::frontmost::current() {
            Some(f) => json!({ "name": f.name, "bundle_id": f.bundle_id, "pid": f.pid }),
            None => Value::Null,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(Value::Null)
    }
}

fn sch_processes() -> Value {
    json!({
        "type": "object",
        "properties": {
            "sort": { "type": "string", "enum": ["cpu", "mem"] },
            "query": { "type": "string", "description": "Filter by process name / command substring." },
            "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
        },
        "additionalProperties": false
    })
}

fn sch_kill() -> Value {
    json!({
        "type": "object",
        "properties": {
            "pid": { "type": "integer" },
            "name": {
                "type": "string",
                "description": "Expected process name from system_processes; the kill is refused if the pid now belongs to another process. Always pass it."
            },
            "force": { "type": "boolean", "description": "SIGKILL instead of SIGTERM." }
        },
        "required": ["pid"],
        "additionalProperties": false
    })
}

fn sch_quick_action() -> Value {
    json!({
        "type": "object",
        "properties": {
            "action": { "type": "string", "enum": ["lock_screen", "flush_dns", "reindex_spotlight", "purge_memory", "sleep_displays"] }
        },
        "required": ["action"],
        "additionalProperties": false
    })
}

fn sch_displays() -> Value {
    json!({
        "type": "object",
        "properties": {
            "action": { "type": "string", "enum": ["list", "set_brightness", "brighter", "dimmer"] },
            "display_id": { "type": "integer", "description": "From `list`; omit for the main display." },
            "percent": { "type": "number", "minimum": 0, "maximum": 100 }
        },
        "additionalProperties": false
    })
}

fn sch_display_power() -> Value {
    json!({
        "type": "object",
        "properties": {
            "action": { "type": "string", "enum": ["hide", "show", "power_off", "power_on"] },
            "display_id": { "type": "integer" },
            "master_id": { "type": "integer", "description": "Display to mirror onto; defaults to the main display." }
        },
        "required": ["action", "display_id"],
        "additionalProperties": false
    })
}

fn sch_docker_container() -> Value {
    json!({
        "type": "object",
        "properties": {
            "container": { "type": "string", "description": "Container id or name." },
            "action": { "type": "string", "enum": ["start", "stop", "restart", "remove"] }
        },
        "required": ["container", "action"],
        "additionalProperties": false
    })
}

fn sch_storage_scan() -> Value {
    json!({
        "type": "object",
        "properties": {
            "kind": { "type": "string", "enum": [
                "caches", "large_files", "node_modules", "duplicates", "screenshots",
                "ios_backups", "mail_attachments", "xcode_simulators", "tm_snapshots", "privacy"
            ] },
            "root": { "type": "string", "description": "Folder for large_files / node_modules / duplicates; defaults to home." },
            "min_mb": { "type": "integer", "description": "Size threshold (large_files default 500, duplicates default 1)." },
            "limit": { "type": "integer", "minimum": 1, "maximum": 100 }
        },
        "required": ["kind"],
        "additionalProperties": false
    })
}

fn sch_path() -> Value {
    json!({
        "type": "object",
        "properties": { "path": { "type": "string", "description": "Absolute path." } },
        "required": ["path"],
        "additionalProperties": false
    })
}

fn sch_storage_cleanup() -> Value {
    json!({
        "type": "object",
        "properties": {
            "action": { "type": "string", "enum": ["delete_tm_snapshot", "delete_unavailable_simulators"] },
            "name": { "type": "string", "description": "Snapshot name from storage_scan tm_snapshots." }
        },
        "required": ["action"],
        "additionalProperties": false
    })
}

fn sch_query_limit() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": { "type": "string" },
            "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
        },
        "additionalProperties": false
    })
}

fn sch_toggle_agent() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": { "type": "string", "description": "plist path from system_launch_agents." },
            "enable": { "type": "boolean" }
        },
        "required": ["path", "enable"],
        "additionalProperties": false
    })
}

fn sch_apps() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": { "type": "string", "description": "Filter by app name / bundle id." },
            "include_leftovers": { "type": "boolean", "description": "Also list leftover support files for the top 3 matches (slow)." },
            "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
        },
        "additionalProperties": false
    })
}

pub fn system_tools() -> Vec<SysTool> {
    macro_rules! t {
        ($name:literal, $timeout:expr, $schema:expr, $run:expr, $desc:literal) => {
            SysTool {
                name: $name,
                description: $desc,
                schema: $schema,
                timeout_secs: $timeout,
                run: $run,
            }
        };
    }
    vec![
        t!("system_metrics", 10, empty_schema, run_metrics,
           "Live Mac metrics: CPU %, load, RAM used/total + pressure, disk used/free, battery, uptime, process count, network interfaces, ping."),
        t!("system_processes", 10, sch_processes, run_processes,
           "List running processes sorted by CPU or memory, optionally filtered by name. Returns pid/name/user/cpu/rss."),
        t!("system_kill_process", 10, sch_kill, run_kill,
           "Terminate a process by pid (SIGTERM; force=true → SIGKILL). Only the user's own processes. Needs user confirmation."),
        t!("system_quick_action", 60, sch_quick_action, run_quick_action,
           "Mac quick actions: lock_screen, flush_dns, reindex_spotlight, purge_memory (shows an admin password dialog on the Mac), sleep_displays."),
        t!("system_displays", 10, sch_displays, run_displays,
           "Displays: list (ids, resolution, brightness 0..1, mirroring), set_brightness percent for a display (main if omitted), brighter/dimmer step on the built-in display."),
        t!("system_display_power", 15, sch_display_power, run_display_power,
           "Hide/show an external display (mirror onto master) or power it off/on via DDC. Needs user confirmation."),
        t!("system_trash_status", 30, empty_schema, run_trash_status,
           "Size and item count of the Trash on every volume."),
        t!("system_empty_trash", 60, empty_schema, run_empty_trash,
           "Empty the Trash on all volumes (irreversible). Needs user confirmation."),
        t!("system_docker", 20, empty_schema, run_docker,
           "Docker status: installed/running/version, disk usage by type with reclaimable bytes, and all containers (id, name, image, state)."),
        t!("system_docker_container", 60, sch_docker_container, run_docker_container,
           "Start, stop, restart or remove a Docker container. Needs user confirmation."),
        t!("system_docker_prune", 300, empty_schema, run_docker_prune,
           "docker system prune -af --volumes + builder prune (irreversible). Needs user confirmation."),
        t!("system_storage_scan", 180, sch_storage_scan, run_storage_scan,
           "Disk cleanup scans from the System tab: caches, large_files, node_modules, duplicates, screenshots, ios_backups, mail_attachments, xcode_simulators, tm_snapshots, privacy (browser data). Returns biggest items first."),
        t!("system_move_to_trash", 30, sch_path, run_move_to_trash,
           "Move a file or folder to the Trash (e.g. an item found by system_storage_scan). Needs user confirmation."),
        t!("system_storage_cleanup", 120, sch_storage_cleanup, run_storage_cleanup,
           "Delete a local Time Machine snapshot or all unavailable Xcode simulators. Needs user confirmation."),
        t!("system_launch_agents", 15, sch_query_limit, run_launch_agents,
           "List launchd agents/daemons (label, plist path, user/system scope, disabled, pid)."),
        t!("system_toggle_launch_agent", 15, sch_toggle_agent, run_toggle_launch_agent,
           "Enable or disable a launch agent by plist path. Needs user confirmation."),
        t!("system_apps", 120, sch_apps, run_apps,
           "List installed applications with size and bundle id; optionally find leftover support files (uninstaller)."),
        t!("system_network_connections", 15, sch_query_limit, run_connections,
           "Open network connections per process (lsof): protocol, local/remote address, state."),
        t!("system_battery_health", 10, empty_schema, run_battery_health,
           "Battery health: cycle count, condition, max/design/current capacity mAh."),
        t!("system_frontmost_app", 5, empty_schema, run_frontmost,
           "The currently frontmost macOS app (name, bundle id, pid)."),
    ]
}

// ───────────────────────── quick system commands ─────────────────────────
// /battery, /volume, /screenshot, /display, /sleep, /shutdown, /focus,
// /weather, /app + `get_battery` / `volume_control` tools.

use std::sync::Arc;

use crate::modules::telegram::agent_util::{
    apply_volume, now_ms, read_battery, run_slash, volume_bar, BatterySnapshot, VolumeAction,
    VolumeSnapshot,
};

// -------------------- /battery --------------------

pub struct BatteryCmd;

#[async_trait]
impl CommandHandler for BatteryCmd {
    fn name(&self) -> &'static str {
        "battery"
    }
    fn description(&self) -> &'static str {
        "Показати заряд батареї та стан живлення"
    }
    fn usage(&self) -> &'static str {
        "/battery"
    }
    async fn handle(&self, _ctx: Ctx, _args: &str) -> Reply {
        match read_battery() {
            BatterySnapshot::Present { percent, charging } => {
                let icon = if charging { "🔌" } else { "🔋" };
                let status = if charging {
                    "заряджається"
                } else {
                    "від батареї"
                };
                // Below 20% + not plugged in → offer a quick sleep action.
                let low = percent < 20 && !charging;
                let mut rows = Vec::new();
                if low {
                    rows.push(vec![
                        InlineButton::new("💤 Sleep Mac", "sleep:ask"),
                        InlineButton::new("☕ Keep awake off", "keepawake:off"),
                    ]);
                }
                rows.push(crate::modules::telegram::menu::nav_row("refresh:battery"));
                Reply {
                    text: format!("{icon} {percent}% — {status}"),
                    keyboard: Some(InlineKeyboard { rows }),
                    ..Default::default()
                }
            }
            BatterySnapshot::NoBattery => Reply {
                text: "🔌 У цього Mac немає батареї (desktop / під'єднано до мережі).".into(),
                keyboard: Some(crate::modules::telegram::menu::nav_keyboard("refresh:battery")),
                ..Default::default()
            },
            BatterySnapshot::Unknown => Reply {
                text: "🪫 Не вдалося отримати дані про батарею.".into(),
                keyboard: Some(crate::modules::telegram::menu::nav_keyboard("refresh:battery")),
                ..Default::default()
            },
        }
    }
}

// -------------------- /volume --------------------

pub struct VolumeCmd;

#[async_trait]
impl CommandHandler for VolumeCmd {
    fn name(&self) -> &'static str {
        "volume"
    }
    fn description(&self) -> &'static str {
        "Показати або змінити гучність macOS (0–100)"
    }
    fn usage(&self) -> &'static str {
        "/volume [N | up | down | mute | unmute]"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        let action = match parse_volume_action(args) {
            Ok(a) => a,
            Err(other) => {
                return Reply::text(format!(
                    "✍️ Usage: /volume [N | +N | -N | up | down | mute | unmute | toggle]. Got: {other}"
                ));
            }
        };
        let snap = apply_volume(action);
        Reply {
            text: format_volume(&snap),
            keyboard: Some(volume_keyboard(snap.muted)),
            ..Default::default()
        }
    }
}

/// `N` sets the level; signed `+N` / `-N` nudge relative to the current
/// level (so the card's −1/+1 buttons and typed args share one grammar).
fn parse_volume_action(args: &str) -> Result<VolumeAction, String> {
    let raw = args.trim().to_lowercase();
    Ok(match raw.as_str() {
        "" | "status" => VolumeAction::Status,
        "up" | "+" => VolumeAction::Step(10),
        "down" | "-" => VolumeAction::Step(-10),
        "mute" => VolumeAction::Mute(true),
        "unmute" => VolumeAction::Mute(false),
        "toggle" | "togglemute" => VolumeAction::ToggleMute,
        other if other.starts_with('+') || other.starts_with('-') => match other.parse::<i32>() {
            Ok(n) => VolumeAction::Step(n.clamp(-100, 100)),
            Err(_) => return Err(other.to_string()),
        },
        other => match other.parse::<i32>() {
            Ok(n) => VolumeAction::Set(n.clamp(0, 100) as u32),
            Err(_) => return Err(other.to_string()),
        },
    })
}

fn format_volume(s: &VolumeSnapshot) -> String {
    if let Some(e) = &s.error {
        return format!("⚠️ {e}");
    }
    let Some(p) = s.percent else {
        return "🔇 Could not read system volume.".to_string();
    };
    if s.muted {
        return format!("🔇 Muted (was {p}%)");
    }
    let bar = volume_bar(p);
    format!("🔊 {p}% {bar}")
}

/// Live volume card — every button is `refresh:` so the level line updates
/// in place. The 🎵 button swaps this card for the player card.
fn volume_keyboard(muted: bool) -> InlineKeyboard {
    let b = |text: &str, args: &str| InlineButton::new(text, format!("refresh:volume:{args}"));
    InlineKeyboard {
        rows: vec![
            vec![
                b("−10", "-10"),
                b("−1", "-1"),
                if muted { b("🔊", "unmute") } else { b("🔇", "mute") },
                b("+1", "+1"),
                b("+10", "+10"),
            ],
            vec![
                InlineButton::new("🎵 Плеєр", "refresh:music"),
                b("🔄", "status"),
            ],
        ],
    }
}

// -------------------- /screenshot --------------------

pub struct ScreenshotCmd;

#[async_trait]
impl CommandHandler for ScreenshotCmd {
    fn name(&self) -> &'static str {
        "screenshot"
    }
    fn description(&self) -> &'static str {
        "Скрін усіх екранів у PNG (без перекодування). `main` — лише головний."
    }
    fn usage(&self) -> &'static str {
        "/screenshot [main]"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        let sub = args.trim().to_ascii_lowercase();
        let result = tokio::task::spawn_blocking(move || {
            if matches!(sub.as_str(), "main" | "primary" | "1") {
                crate::modules::system::screenshot::capture_main_display().map(|p| vec![p])
            } else {
                crate::modules::system::screenshot::capture_all_displays()
            }
        })
        .await;

        let files = match result {
            Ok(Ok(ps)) => ps,
            Ok(Err(e)) => return Reply::text(format!("⚠️ screenshot: {e}")),
            Err(e) => return Reply::text(format!("⚠️ screenshot: task join: {e}")),
        };

        let paths_block = files
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join("\n");
        let caption = format!("📸 Захоплено екранів: {}\n{}", files.len(), paths_block);
        Reply {
            text: caption,
            documents: files,
            keyboard: Some(InlineKeyboard {
                // Plain `menu` (not `refresh:`) — a document message
                // can't be edited into a text card.
                rows: vec![vec![
                    InlineButton::new("📸 Again", "screenshot"),
                    InlineButton::new("📸 Лише головний", "screenshot:main"),
                    InlineButton::new("☰ Меню", "menu"),
                ]],
            }),
        }
    }
}

// -------------------- /display /sleep /shutdown --------------------

use crate::modules::system::power::{self, PowerKind, PowerTimers};

pub struct DisplayCmd;

#[async_trait]
impl CommandHandler for DisplayCmd {
    fn name(&self) -> &'static str {
        "display"
    }
    fn description(&self) -> &'static str {
        "Погасити екрани (Mac і фонові задачі працюють далі) або змінити яскравість: `up` / `down`."
    }
    fn usage(&self) -> &'static str {
        "/display [off|up|down]"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        let text = match args.trim().to_ascii_lowercase().as_str() {
            "" | "off" | "sleep" => match tokio::task::spawn_blocking(power::display_off).await {
                Ok(Ok(())) => "💤 Екрани погашено (Mac працює далі).".to_string(),
                Ok(Err(e)) => format!("⚠️ display: {e}"),
                Err(e) => format!("⚠️ display: task join: {e}"),
            },
            verb @ ("up" | "+" | "brighter" | "down" | "-" | "dimmer") => {
                let up = matches!(verb, "up" | "+" | "brighter");
                let res = tokio::task::spawn_blocking(move || {
                    crate::modules::system::displays::adjust_brightness(up)
                })
                .await;
                match res {
                    Ok(Ok(())) if up => "🔆 Яскравість + (вбудований дисплей).".to_string(),
                    Ok(Ok(())) => "🔅 Яскравість − (вбудований дисплей).".to_string(),
                    Ok(Err(e)) => format!("⚠️ brightness: {e}"),
                    Err(e) => format!("⚠️ brightness: task join: {e}"),
                }
            }
            other => format!("❓ Невідомо: `{other}`. Використання: {}", self.usage()),
        };
        Reply {
            text,
            keyboard: Some(display_keyboard()),
            ..Default::default()
        }
    }
}

fn display_keyboard() -> InlineKeyboard {
    InlineKeyboard {
        rows: vec![vec![
            InlineButton::new("🔅", "refresh:display:down"),
            InlineButton::new("🔆", "refresh:display:up"),
            InlineButton::new("💤 Погасити", "refresh:display:off"),
        ]],
    }
}

pub struct SleepCmd {
    timers: Arc<PowerTimers>,
}

impl SleepCmd {
    pub fn new(timers: Arc<PowerTimers>) -> Self {
        Self { timers }
    }
}

#[async_trait]
impl CommandHandler for SleepCmd {
    fn name(&self) -> &'static str {
        "sleep"
    }
    fn description(&self) -> &'static str {
        "Приспати Mac. Без аргументу — зараз; `15m` / `30s` / `1h` — за таймером. `cancel` / `status`."
    }
    fn usage(&self) -> &'static str {
        "/sleep [<duration>|cancel|status]"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        handle_power_cmd(&self.timers, PowerKind::Sleep, args).await
    }
}

pub struct ShutdownCmd {
    timers: Arc<PowerTimers>,
}

impl ShutdownCmd {
    pub fn new(timers: Arc<PowerTimers>) -> Self {
        Self { timers }
    }
}

#[async_trait]
impl CommandHandler for ShutdownCmd {
    fn name(&self) -> &'static str {
        "shutdown"
    }
    fn description(&self) -> &'static str {
        "Вимкнути Mac. Без аргументу — зараз; `30m` — за таймером. `cancel` / `status`. Незбережені документи можуть блокувати."
    }
    fn usage(&self) -> &'static str {
        "/shutdown [<duration>|cancel|status]"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        handle_power_cmd(&self.timers, PowerKind::Shutdown, args).await
    }
}

// -------------------- /focus --------------------

use crate::modules::system::focus;

pub struct FocusCmd;

#[async_trait]
impl CommandHandler for FocusCmd {
    fn name(&self) -> &'static str {
        "focus"
    }
    fn description(&self) -> &'static str {
        "Керувати macOS Focus: on / off / status. Одноразове налаштування через Shortcuts.app."
    }
    fn usage(&self) -> &'static str {
        "/focus <on|off|status>"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        let text = self.run(args).await;
        Reply {
            text,
            keyboard: Some(focus_keyboard()),
            ..Default::default()
        }
    }
}

impl FocusCmd {
    async fn run(&self, args: &str) -> String {
        let sub = args.trim().to_ascii_lowercase();
        let verb = sub.as_str();
        let status = tokio::task::spawn_blocking(focus::check)
            .await
            .unwrap_or(focus::FocusCheck::ListFailed("internal: task join".into()));
        if verb.is_empty() || verb == "status" {
            return format_focus_status(&status);
        }
        match &status {
            focus::FocusCheck::Ready => {}
            focus::FocusCheck::CliMissing => {
                return "⚠️ `shortcuts` CLI не знайдено. Потрібен macOS 12+.".into();
            }
            focus::FocusCheck::ShortcutsMissing { .. } => {
                return format!(
                    "⚠️ Не знайдено потрібних ярликів.\n{}",
                    focus::setup_instructions()
                );
            }
            focus::FocusCheck::ListFailed(e) => {
                return format!("⚠️ shortcuts list: {e}");
            }
        }
        match verb {
            "on" | "enable" => match tokio::task::spawn_blocking(focus::enable).await {
                Ok(Ok(())) => "🔕 Focus увімкнено.".into(),
                Ok(Err(e)) => format!("⚠️ {e}"),
                Err(e) => format!("⚠️ task join: {e}"),
            },
            "off" | "disable" => match tokio::task::spawn_blocking(focus::disable).await {
                Ok(Ok(())) => "🔔 Focus вимкнено.".into(),
                Ok(Err(e)) => format!("⚠️ {e}"),
                Err(e) => format!("⚠️ task join: {e}"),
            },
            other => format!(
                "❓ Невідомий підкоманда `{other}`.\nВикористання: {}",
                self.usage()
            ),
        }
    }
}

fn focus_keyboard() -> InlineKeyboard {
    InlineKeyboard {
        rows: vec![vec![
            InlineButton::new("🔕 Увімкнути", "refresh:focus:on"),
            InlineButton::new("🔔 Вимкнути", "refresh:focus:off"),
            InlineButton::new("🔄", "refresh:focus:status"),
        ]],
    }
}

fn format_focus_status(s: &focus::FocusCheck) -> String {
    match s {
        focus::FocusCheck::Ready => "🔔 Focus готовий: `/focus on` або `/focus off`.".into(),
        focus::FocusCheck::CliMissing => {
            "⚠️ `shortcuts` CLI не знайдено. Потрібен macOS 12+.".into()
        }
        focus::FocusCheck::ShortcutsMissing { on, off } => {
            let missing = match (on, off) {
                (false, false) => "обидва ярлики",
                (true, false) => "«Stash Focus Off»",
                (false, true) => "«Stash Focus On»",
                (true, true) => unreachable!("Ready should hit other branch"),
            };
            format!("⚠️ Відсутнє: {missing}.\n{}", focus::setup_instructions())
        }
        focus::FocusCheck::ListFailed(e) => format!("⚠️ shortcuts list: {e}"),
    }
}

// -------------------- /weather --------------------

use crate::modules::system::weather;

pub struct WeatherCmd {
    state: Arc<TelegramState>,
}

impl WeatherCmd {
    pub fn new(state: Arc<TelegramState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for WeatherCmd {
    fn name(&self) -> &'static str {
        "weather"
    }
    fn description(&self) -> &'static str {
        "Погода з wttr.in. Без аргумента — з пам'яті (факт `location: <місто>`)."
    }
    fn usage(&self) -> &'static str {
        "/weather [<місто>]"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        let arg = args.trim().to_string();
        let city = if arg.is_empty() {
            // Pull the `location:` fact out of memory. Falling back to IP
            // geolocation would be surprising and wrong when the user
            // asks for "their" weather after saving a city.
            let facts: Vec<String> = match self.state.repo.lock() {
                Ok(r) => match r.memory_list() {
                    Ok(rows) => rows.into_iter().map(|r| r.fact).collect(),
                    Err(e) => return Reply::text(format!("⚠️ пам'ять: {e}")),
                },
                Err(e) => return Reply::text(format!("⚠️ пам'ять: {e}")),
            };
            match weather::location_from_facts(&facts) {
                Some(c) => c,
                None => {
                    return Reply::text(
                        "❓ Місто не збережене. Скажи, наприклад: \
                         `/remember location: Київ` — або `/weather Київ`.",
                    );
                }
            }
        } else {
            arg.clone()
        };
        let for_label = city.clone();
        // Refresh re-asks for the same city when it was typed explicitly
        // and fits in the callback payload; otherwise fall back to the
        // memory-derived default.
        let refresh = if arg.is_empty() {
            "refresh:weather".to_string()
        } else {
            let cb = format!("refresh:weather:{arg}");
            if cb.len() <= 64 {
                cb
            } else {
                "refresh:weather".to_string()
            }
        };
        let text = match weather::fetch_weather(&city).await {
            Ok(body) => format!("🌦 {for_label}\n{body}"),
            Err(e) => format!("⚠️ погода: {e}"),
        };
        Reply {
            text,
            keyboard: Some(crate::modules::telegram::menu::nav_keyboard(&refresh)),
            ..Default::default()
        }
    }
}

// -------------------- /app --------------------

use crate::modules::system::apps_control;

pub struct AppCmd;

#[async_trait]
impl CommandHandler for AppCmd {
    fn name(&self) -> &'static str {
        "app"
    }
    fn description(&self) -> &'static str {
        "Керувати програмами macOS: відкрити, згорнути, закрити, список запущених."
    }
    fn usage(&self) -> &'static str {
        "/app <open|hide|quit> <name> | /app running"
    }
    async fn handle(&self, _ctx: Ctx, args: &str) -> Reply {
        let sub = args.trim();
        if sub.is_empty() {
            return Reply::text(format!("✍️ Використання: {}", self.usage()));
        }
        // Running-list is the only sub without a name argument, so peel it
        // off first before the verb/name split.
        if sub.eq_ignore_ascii_case("running")
            || sub.eq_ignore_ascii_case("list")
            || sub.eq_ignore_ascii_case("ls")
        {
            return match tokio::task::spawn_blocking(apps_control::list_running_apps).await {
                Ok(Ok(names)) if names.is_empty() => {
                    Reply::text("🪟 Нічого переднього плану не запущено.")
                }
                Ok(Ok(names)) => app_running_reply(&names),
                Ok(Err(e)) => Reply::text(format!("⚠️ {e}")),
                Err(e) => Reply::text(format!("⚠️ task join: {e}")),
            };
        }

        let mut parts = sub.splitn(2, char::is_whitespace);
        let verb = parts.next().unwrap_or("").to_ascii_lowercase();
        let name = parts.next().unwrap_or("").trim().to_string();
        if name.is_empty() {
            return Reply::text(format!(
                "✍️ Треба ім'я програми. Використання: {}",
                self.usage()
            ));
        }
        match verb.as_str() {
            "open" | "launch" | "focus" => {
                let n = name.clone();
                let result = tokio::task::spawn_blocking(move || apps_control::open_app(&n)).await;
                match result {
                    Ok(Ok(())) => app_reply(format!("🚀 Відкрив: {name}"), &[("👻 Згорнути", "hide", &name), ("🛑 Закрити", "quitask", &name)]),
                    Ok(Err(e)) => Reply::text(format!("⚠️ {e}")),
                    Err(e) => Reply::text(format!("⚠️ task join: {e}")),
                }
            }
            // "🛑 Закрити" button → confirm in the same card first, so a
            // stray tap can't kill an app with unsaved work.
            "quitask" => app_reply(
                format!("🛑 Закрити {name}?"),
                &[("✅ Так, закрити", "quit", &name), ("✖ Ні", "keep", &name)],
            ),
            "keep" => app_reply(
                format!("🚀 {name}"),
                &[("👻 Згорнути", "hide", &name), ("🛑 Закрити", "quitask", &name)],
            ),
            "hide" | "minimize" => {
                let n = name.clone();
                let result = tokio::task::spawn_blocking(move || apps_control::hide_app(&n)).await;
                match result {
                    Ok(Ok(())) => app_reply(format!("👻 Згорнув: {name}"), &[("🚀 Відкрити", "open", &name)]),
                    Ok(Err(e)) => Reply::text(format!("⚠️ {e}")),
                    Err(e) => Reply::text(format!("⚠️ task join: {e}")),
                }
            }
            "quit" | "close" | "exit" => {
                let n = name.clone();
                let result = tokio::task::spawn_blocking(move || apps_control::quit_app(&n)).await;
                match result {
                    Ok(Ok(apps_control::QuitOutcome::Quit { resolved_name })) => {
                        app_reply(format!("🛑 Закрив: {resolved_name}"), &[("🚀 Відкрити", "open", &resolved_name)])
                    }
                    Ok(Ok(apps_control::QuitOutcome::NotRunning)) => {
                        Reply::text(format!("ℹ️ `{name}` не запущений — нема чого закривати."))
                    }
                    Ok(Ok(apps_control::QuitOutcome::StillRunning { resolved_name })) => {
                        // Most common cause is an unsaved-document dialog
                        // blocking the Quit event. Report honestly so the
                        // assistant doesn't falsely claim success.
                        Reply::text(format!(
                            "⚠️ `{resolved_name}` не закрився (можливо, діалог «зберегти»?). \
                             Натисни `/app quit {resolved_name}` ще раз після відповіді на діалог."
                        ))
                    }
                    Ok(Err(e)) => Reply::text(format!("⚠️ {e}")),
                    Err(e) => Reply::text(format!("⚠️ task join: {e}")),
                }
            }
            other => Reply::text(format!(
                "❓ Невідомий підкоманда `{other}`.\nВикористання: {}",
                self.usage()
            )),
        }
    }
}

/// `app:<verb> <name>` payload, or `None` when the app name would push
/// it past Telegram's 64-byte callback limit.
fn app_cb(verb: &str, name: &str) -> Option<String> {
    let cb = format!("app:{verb} {name}");
    (cb.len() <= 64).then_some(cb)
}

/// Single-app result card with follow-up actions that edit it in place.
fn app_reply(text: String, actions: &[(&str, &str, &str)]) -> Reply {
    let row: Vec<InlineButton> = actions
        .iter()
        .filter_map(|(label, verb, name)| {
            app_cb(verb, name).map(|cb| InlineButton::new(*label, format!("refresh:{cb}")))
        })
        .filter(|b| b.callback_data.len() <= 64)
        .collect();
    Reply {
        text,
        keyboard: (!row.is_empty()).then(|| InlineKeyboard { rows: vec![row] }),
        ..Default::default()
    }
}

/// Running-apps list with a "hide" button per app (non-destructive, so a
/// mis-tap is harmless) plus refresh.
fn app_running_reply(names: &[String]) -> Reply {
    let buttons: Vec<InlineButton> = names
        .iter()
        .take(12)
        .filter_map(|n| app_cb("hide", n).map(|cb| InlineButton::new(format!("👻 {n}"), cb)))
        .collect();
    let mut rows: Vec<Vec<InlineButton>> = buttons.chunks(3).map(|c| c.to_vec()).collect();
    rows.push(crate::modules::telegram::menu::nav_row("refresh:app:running"));
    Reply {
        text: format!("🪟 Запущено: {}", names.join(", ")),
        keyboard: Some(InlineKeyboard { rows }),
        ..Default::default()
    }
}

async fn handle_power_cmd(timers: &Arc<PowerTimers>, kind: PowerKind, args: &str) -> Reply {
    let sub = args.trim().to_ascii_lowercase();
    match sub.as_str() {
        "cancel" | "off" | "stop" | "abort" => {
            if timers.cancel(kind) {
                Reply::text(format!("✖️ {} cancelled.", label(kind, true)))
            } else {
                Reply::text(format!("ℹ️ Немає запланованого {}.", label(kind, false)))
            }
        }
        "status" => match timers.pending_fire_at(kind) {
            Some(fire_at_ms) => {
                let now = now_ms();
                let remaining = (fire_at_ms - now).max(0) as u64;
                Reply::text(format!(
                    "⏱ {} через {}",
                    label(kind, true),
                    power::format_duration(std::time::Duration::from_millis(remaining))
                ))
            }
            None => Reply::text(format!("ℹ️ Немає запланованого {}.", label(kind, false))),
        },
        // Typed `/sleep` stays immediate; buttons go through `ask` → `now`.
        "" | "now" => immediate(kind).await,
        "ask" => power_confirm_card(kind),
        "no" => Reply::text(format!("👌 {} скасовано.", label(kind, true))),
        other => match power::parse_duration(other) {
            Ok(delay) => {
                timers.schedule(kind, delay);
                Reply::text(format!(
                    "⏳ {} заплановано через {}.",
                    label(kind, true),
                    power::format_duration(delay)
                ))
            }
            Err(e) => Reply::text(format!("⚠️ {}: {e}", kind_word(kind))),
        },
    }
}

/// Second-tap confirmation for the one-tap power buttons (battery alert,
/// dashboard). Both answers edit this card in place.
fn power_confirm_card(kind: PowerKind) -> Reply {
    let (text, yes) = match kind {
        PowerKind::Sleep => ("💤 Приспати Mac зараз?", "✅ Так, приспати"),
        PowerKind::Shutdown => ("⏻ Вимкнути Mac зараз?", "✅ Так, вимкнути"),
    };
    let cmd = kind_word(kind);
    Reply {
        text: text.to_string(),
        keyboard: Some(InlineKeyboard {
            rows: vec![vec![
                InlineButton::new(yes, format!("refresh:{cmd}:now")),
                InlineButton::new("✖ Ні", format!("refresh:{cmd}:no")),
            ]],
        }),
        ..Default::default()
    }
}

async fn immediate(kind: PowerKind) -> Reply {
    let verb = match kind {
        PowerKind::Sleep => power::sleep_now,
        PowerKind::Shutdown => power::shutdown_now,
    };
    match tokio::task::spawn_blocking(verb).await {
        Ok(Ok(())) => Reply::text(match kind {
            PowerKind::Sleep => "😴 Засинаю…",
            PowerKind::Shutdown => "⏻ Вимикаюсь…",
        }),
        Ok(Err(e)) => Reply::text(format!("⚠️ {}: {e}", kind_word(kind))),
        Err(e) => Reply::text(format!("⚠️ {}: task join: {e}", kind_word(kind))),
    }
}

fn label(kind: PowerKind, caps: bool) -> &'static str {
    match (kind, caps) {
        (PowerKind::Sleep, true) => "Sleep",
        (PowerKind::Sleep, false) => "sleep",
        (PowerKind::Shutdown, true) => "Shutdown",
        (PowerKind::Shutdown, false) => "shutdown",
    }
}

fn kind_word(kind: PowerKind) -> &'static str {
    match kind {
        PowerKind::Sleep => "sleep",
        PowerKind::Shutdown => "shutdown",
    }
}

// ---- quick system LLM tools ----

pub struct GetBattery;

#[async_trait]
impl Tool for GetBattery {
    fn name(&self) -> &'static str {
        "get_battery"
    }
    fn description(&self) -> &'static str {
        "Return the Mac's current battery percentage + charging state. \
         Returns {present:false} on desktop Macs without a battery."
    }
    fn schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }
    async fn invoke(&self, _ctx: &ToolCtx, _args: Value) -> Result<Value, String> {
        Ok(match read_battery() {
            BatterySnapshot::Present { percent, charging } => {
                json!({ "present": true, "percent": percent, "charging": charging })
            }
            BatterySnapshot::NoBattery => {
                json!({ "present": false, "reason": "desktop_mac" })
            }
            BatterySnapshot::Unknown => {
                json!({ "present": false, "reason": "unavailable" })
            }
        })
    }
}

// ---- Volume ----

pub struct VolumeControl;

#[async_trait]
impl Tool for VolumeControl {
    fn name(&self) -> &'static str {
        "volume_control"
    }
    fn description(&self) -> &'static str {
        "Adjust macOS system output volume. Provide at most one of: \
         `level` (absolute 0-100), `delta` (relative change, e.g. 5 or -20), \
         `step` (\"up\" or \"down\" — 10-point nudge), `mute` (boolean), or \
         `toggle_mute` (true flips mute). Pass `{}` to return the current \
         level + mute state."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "level": { "type": "integer", "minimum": 0, "maximum": 100 },
                "delta": { "type": "integer", "minimum": -100, "maximum": 100 },
                "step":  { "type": "string", "enum": ["up", "down"] },
                "mute":  { "type": "boolean" },
                "toggle_mute": { "type": "boolean" }
            },
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let level = args.get("level").and_then(|v| v.as_i64());
        let step = args.get("step").and_then(|v| v.as_str());
        let mute = args.get("mute").and_then(|v| v.as_bool());
        let delta = args.get("delta").and_then(|v| v.as_i64());
        let toggle = args
            .get("toggle_mute")
            .and_then(|v| v.as_bool())
            .filter(|b| *b);
        let count = [
            level.is_some(),
            step.is_some(),
            mute.is_some(),
            delta.is_some(),
            toggle.is_some(),
        ]
        .iter()
        .filter(|&&b| b)
        .count();
        if count > 1 {
            return Err("provide at most one of level/delta/step/mute/toggle_mute".to_string());
        }
        let slash_args = if let Some(n) = level {
            n.clamp(0, 100).to_string()
        } else if let Some(d) = delta {
            format!("{:+}", d.clamp(-100, 100))
        } else if toggle.is_some() {
            "toggle".to_string()
        } else if let Some(s) = step {
            s.to_string()
        } else if let Some(m) = mute {
            if m {
                "mute".to_string()
            } else {
                "unmute".to_string()
            }
        } else {
            // No arg => status query
            String::new()
        };
        run_slash(ctx, "volume", &slash_args).await
    }
}

// ───────────────────────── wiring ─────────────────────────

pub fn register_commands(tg: &Arc<TelegramState>) {
    tg.register_command(BatteryCmd);
    tg.register_command(VolumeCmd);
    tg.register_command(ScreenshotCmd);
    let power_timers = Arc::new(PowerTimers::new());
    tg.register_command(DisplayCmd);
    tg.register_command(SleepCmd::new(Arc::clone(&power_timers)));
    tg.register_command(ShutdownCmd::new(Arc::clone(&power_timers)));
    tg.register_command(AppCmd);
    tg.register_command(FocusCmd);
    tg.register_command(WeatherCmd::new(Arc::clone(tg)));
    tg.register_command(SysCmd);
    tg.register_command(ProcCmd);
    tg.register_command(DockerCmd);
    tg.register_command(TrashCmd);
    tg.register_command(LockCmd);
    tg.register_command(DnsCmd);
}

pub fn register_tools(tools: &mut ToolRegistry) {
    tools.register(GetBattery);
    tools.register(VolumeControl);
    for t in system_tools() {
        tools.register(t);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: i32, name: &str, cpu: f32, rss: u64, user: &str) -> ProcessInfo {
        ProcessInfo {
            pid,
            rss_bytes: rss,
            cpu_percent: cpu,
            user: user.into(),
            name: name.into(),
            command: format!("/bin/{name}"),
            start_secs: 1_761_400_000 + pid as u64,
        }
    }

    fn all_callbacks(kb: &InlineKeyboard) -> Vec<String> {
        kb.rows.iter().flatten().map(|b| b.callback_data.clone()).collect()
    }

    #[test]
    fn formatting() {
        assert_eq!(fmt_bytes(512), "512 B");
        assert_eq!(fmt_bytes(1536), "1.5 KB");
        assert_eq!(fmt_bytes(300 * 1024 * 1024), "300 MB");
        assert_eq!(fmt_uptime(59), "0хв");
        assert_eq!(fmt_uptime(3600 * 5 + 60 * 7), "5г 7хв");
        assert_eq!(fmt_uptime(86_400 * 3 + 3600 * 4), "3д 4г");
        assert_eq!(bar(0.0), "░░░░░░░░░░");
        assert_eq!(bar(55.0).chars().filter(|c| *c == '▓').count(), 6);
        assert_eq!(bar(250.0), "▓▓▓▓▓▓▓▓▓▓");
        assert_eq!(short("abc`def", 10), "abc'def");
        assert_eq!(short("abcdefghij", 5), "abcd…");
    }

    #[test]
    fn top_processes_sorts_filters_and_caps() {
        let list = vec![
            p(10, "a", 1.0, 900, "me"),
            p(11, "Safari", 50.0, 100, "me"),
            p(12, "safaridriver", 5.0, 5000, "me"),
        ];
        let cpu = top_processes(list.clone(), ProcSort::Cpu, None, 2);
        assert_eq!(cpu.iter().map(|p| p.pid).collect::<Vec<_>>(), vec![11, 12]);
        let mem = top_processes(list.clone(), ProcSort::Mem, None, 10);
        assert_eq!(mem[0].pid, 12);
        let q = top_processes(list, ProcSort::Cpu, Some("SAFARI"), 10);
        assert_eq!(q.len(), 2);
    }

    #[test]
    fn kill_name_check() {
        assert!(name_matches("Safari", Some("Safari")));
        assert!(name_matches("chrome", Some("Google Chrome Helper")));
        assert!(!name_matches("Safari", Some("stash")));
        assert!(!name_matches("Safari", None));
    }

    #[test]
    fn same_process_guards_reused_pid() {
        assert!(same_process(None, None));
        assert!(same_process(None, Some(5)));
        assert!(same_process(Some(5), Some(5)));
        assert!(!same_process(Some(5), Some(6)));
        // Gone process with a token → treat as changed.
        assert!(!same_process(Some(5), None));
    }

    #[test]
    fn parse_proc() {
        assert_eq!(parse_proc_args(""), ProcArgs::List { sort: ProcSort::Cpu, query: None });
        assert_eq!(parse_proc_args("ram"), ProcArgs::List { sort: ProcSort::Mem, query: None });
        assert_eq!(
            parse_proc_args("find google chrome"),
            ProcArgs::List { sort: ProcSort::Cpu, query: Some("google chrome".into()) }
        );
        assert_eq!(
            parse_proc_args("ask mem 42"),
            ProcArgs::Ask { sort: ProcSort::Mem, pid: 42, tok: None }
        );
        assert_eq!(
            parse_proc_args("kill 42"),
            ProcArgs::Kill { sort: ProcSort::Cpu, pid: 42, force: false, tok: None }
        );
        assert_eq!(
            parse_proc_args("force mem 42 123456"),
            ProcArgs::Kill { sort: ProcSort::Mem, pid: 42, force: true, tok: Some(123456) }
        );
        assert_eq!(
            parse_proc_args("kill 42 7"),
            ProcArgs::Kill { sort: ProcSort::Cpu, pid: 42, force: false, tok: Some(7) }
        );
        assert_eq!(parse_proc_args("kill mem 42 x"), ProcArgs::Usage);
        assert_eq!(parse_proc_args("kill abc"), ProcArgs::Usage);
        assert_eq!(parse_proc_args("bogus"), ProcArgs::Usage);
        assert!(ProcCmd.dangerous("kill 42"));
        assert!(!ProcCmd.dangerous("ask cpu 42"));
        assert!(!ProcCmd.dangerous("mem"));
    }

    #[test]
    fn proc_keyboard_is_two_tap_and_skips_foreign_and_self() {
        let list = vec![
            p(1, "launchd", 1.0, 1, "root"),
            p(200, "WindowServer", 9.0, 1, "_windowserver"),
            p(300, "Safari", 5.0, 1, "me"),
            p(400, "stash", 1.0, 1, "me"),
        ];
        let kb = proc_keyboard(&list, ProcSort::Cpu, "me", 400, None);
        let cbs = all_callbacks(&kb);
        let asks: Vec<_> = cbs.iter().filter(|c| c.contains(":ask ")).collect();
        assert_eq!(asks, vec!["refresh:proc:ask cpu 300 400300"]);
        // No direct kill without the confirm step.
        assert!(!cbs.iter().any(|c| c.contains(":kill ")));
        let confirm = proc_keyboard(&list, ProcSort::Mem, "me", 400, Some((300, Some(400300))));
        let cbs = all_callbacks(&confirm);
        assert_eq!(cbs[0], "refresh:proc:kill mem 300 400300");
        assert_eq!(cbs[1], "refresh:proc:force mem 300 400300");
        // Worst case still fits Telegram's 64-byte callback limit.
        let worst = proc_keyboard(&list, ProcSort::Mem, "me", 400, Some((i32::MAX, Some(999_999))));
        assert!(all_callbacks(&worst).iter().all(|c| c.len() <= 64));
        for cb in &cbs {
            assert!(cb.len() <= 64, "{cb}");
            if let Some(args) = cb.strip_prefix("refresh:proc:") {
                assert_ne!(parse_proc_args(args), ProcArgs::Usage, "{cb}");
            }
        }
    }

    #[test]
    fn parse_docker() {
        assert_eq!(parse_docker_args(""), DockerArgs::Show);
        assert_eq!(parse_docker_args("prune"), DockerArgs::Prune);
        assert_eq!(
            parse_docker_args("stop 0123456789ab"),
            DockerArgs::Act { action: ContainerAction::Stop, id: "0123456789ab".into() }
        );
        assert_eq!(
            parse_docker_args("askrm web"),
            DockerArgs::Ask { action: ContainerAction::Remove, id: "web".into() }
        );
        assert_eq!(
            parse_docker_args("askstop web"),
            DockerArgs::Ask { action: ContainerAction::Stop, id: "web".into() }
        );
        assert_eq!(
            parse_docker_args("askrestart web"),
            DockerArgs::Ask { action: ContainerAction::Restart, id: "web".into() }
        );
        assert_eq!(parse_docker_args("askstart web"), DockerArgs::Usage);
        assert_eq!(parse_docker_args("askbogus web"), DockerArgs::Usage);
        assert!(!DockerCmd.dangerous("askstop web"));
        assert_eq!(parse_docker_args("stop --all"), DockerArgs::Usage);
        assert!(DockerCmd.dangerous("rm web"));
        assert!(DockerCmd.dangerous("prune"));
        assert!(!DockerCmd.dangerous("start web"));
        assert!(!DockerCmd.dangerous("askprune"));
    }

    #[test]
    fn docker_keyboard_round_trips() {
        let st = DockerStatus { installed: true, running: true, version: Some("27".into()), items: vec![] };
        let cs = vec![
            DockerContainer {
                id: "0123456789ab".into(),
                name: "a-very-long-container-name-here".into(),
                image: "nginx".into(),
                state: "running".into(),
                status: "Up".into(),
            },
            DockerContainer {
                id: "ba9876543210".into(),
                name: "db".into(),
                image: "postgres".into(),
                state: "exited".into(),
                status: "Exited".into(),
            },
        ];
        let kb = docker_keyboard(&st, &cs, None);
        let cbs = all_callbacks(&kb);
        assert!(cbs.contains(&"refresh:docker:askstop 0123456789ab".to_string()));
        assert!(cbs.contains(&"refresh:docker:askrestart 0123456789ab".to_string()));
        assert!(cbs.contains(&"refresh:docker:start ba9876543210".to_string()));
        assert!(cbs.contains(&"refresh:docker:askrm ba9876543210".to_string()));
        // stop/restart/rm/prune only reachable through the confirm step.
        assert!(!cbs.iter().any(|c| {
            ["rm ", "stop ", "restart "].iter().any(|v| c.starts_with(&format!("refresh:docker:{v}")))
                || c == "refresh:docker:prune"
        }));
        let confirm = docker_keyboard(&st, &cs, Some(&DockerArgs::AskPrune));
        assert_eq!(all_callbacks(&confirm)[0], "refresh:docker:prune");
        let stop = docker_keyboard(
            &st,
            &cs,
            Some(&DockerArgs::Ask { action: ContainerAction::Stop, id: "0123456789ab".into() }),
        );
        assert_eq!(all_callbacks(&stop)[0], "refresh:docker:stop 0123456789ab");
        assert_eq!(
            parse_docker_args("stop 0123456789ab"),
            DockerArgs::Act { action: ContainerAction::Stop, id: "0123456789ab".into() }
        );
        for cb in cbs.iter().chain(all_callbacks(&confirm).iter()).chain(all_callbacks(&stop).iter()) {
            assert!(cb.len() <= 64, "{cb}");
            if let Some(args) = cb.strip_prefix("refresh:docker:") {
                assert_ne!(parse_docker_args(args), DockerArgs::Usage, "{cb}");
            }
        }
    }

    #[test]
    fn trash_keyboard_two_tap() {
        let cbs = all_callbacks(&trash_keyboard(false, false));
        assert!(cbs.contains(&"refresh:trash:ask".to_string()));
        assert!(!cbs.contains(&"refresh:trash:empty".to_string()));
        assert!(!all_callbacks(&trash_keyboard(false, true)).contains(&"refresh:trash:ask".to_string()));
        assert_eq!(all_callbacks(&trash_keyboard(true, false))[0], "refresh:trash:empty");
        assert!(TrashCmd.dangerous("empty"));
        assert!(!TrashCmd.dangerous("ask"));
    }

    #[test]
    fn hub_and_display_callbacks_fit() {
        let mut cbs = all_callbacks(&hub_keyboard());
        let d = displays::DisplayDevice {
            id: u32::MAX,
            name: "Some Extremely Long Monitor Name".into(),
            width_px: 3840,
            height_px: 2160,
            is_main: true,
            is_builtin: false,
            brightness: Some(0.95),
            supports_brightness: true,
            vendor_id: 0,
            model_id: 0,
            mirrors: 0,
        };
        let dk = displays_keyboard(std::slice::from_ref(&d));
        cbs.extend(all_callbacks(&dk));
        assert!(cbs.contains(&format!("refresh:sys:disp {} 100", u32::MAX)));
        assert!(cbs.contains(&format!("refresh:sys:disp {} 85", u32::MAX)));
        for cb in cbs {
            assert!(cb.len() <= 64, "{cb}");
        }
    }

    #[test]
    fn tool_names_unique_and_prefixed() {
        let tools = system_tools();
        let mut names: Vec<_> = tools.iter().map(|t| t.name).collect();
        assert!(names.iter().all(|n| n.starts_with("system_")));
        for t in &tools {
            assert_eq!((t.schema)()["type"], "object", "{}", t.name);
        }
        names.sort();
        names.dedup();
        assert_eq!(names.len(), tools.len());
    }

    #[test]
    fn destructive_tools_are_gated() {
        use crate::modules::telegram::confirm::tool_needs_confirmation;
        for name in [
            "system_kill_process",
            "system_display_power",
            "system_empty_trash",
            "system_docker_container",
            "system_docker_prune",
            "system_move_to_trash",
            "system_storage_cleanup",
            "system_toggle_launch_agent",
        ] {
            assert!(tool_needs_confirmation(name, &json!({})), "{name}");
        }
        assert!(!tool_needs_confirmation("system_processes", &json!({})));
    }

    #[test]
    fn storage_rows_ranked_by_size() {
        let v = top_by_size(
            vec![json!({"size_bytes": 1}), json!({"size_bytes": 30}), json!({"size_bytes": 5})],
            2,
        );
        assert_eq!(v["count"], 3);
        assert_eq!(v["total_bytes"], 36);
        assert_eq!(v["items"][0]["size_bytes"], 30);
        assert_eq!(v["items"].as_array().unwrap().len(), 2);
    }
}

#[cfg(test)]
mod quick_cmd_tests {
    use super::*;
    use crate::modules::telegram::agent_util::test_support::{
        all_callbacks, assert_fits, tool_ctx as ctx,
    };

    #[test]
    fn power_buttons_need_a_second_tap() {
        for kind in [PowerKind::Sleep, PowerKind::Shutdown] {
            let kb = power_confirm_card(kind).keyboard.unwrap();
            let cbs: Vec<_> = kb.rows.iter().flatten().map(|b| b.callback_data.as_str()).collect();
            let w = kind_word(kind);
            assert_eq!(cbs, vec![format!("refresh:{w}:now"), format!("refresh:{w}:no")]);
        }
    }

    #[test]
    fn app_open_card_quit_goes_through_confirm() {
        let r = app_reply("x".into(), &[("🛑 Закрити", "quitask", "Safari")]);
        assert_eq!(r.keyboard.unwrap().rows[0][0].callback_data, "refresh:app:quitask Safari");
    }

    #[test]
    fn format_volume_renders_percent() {
        let s = VolumeSnapshot {
            percent: Some(42),
            muted: false,
            error: None,
        };
        let out = format_volume(&s);
        assert!(out.contains("42%"));
        assert!(out.starts_with("🔊"));
    }

    #[test]
    fn format_volume_mute_shows_previous_level() {
        let s = VolumeSnapshot {
            percent: Some(60),
            muted: true,
            error: None,
        };
        let out = format_volume(&s);
        assert!(out.contains("60%"));
        assert!(out.starts_with("🔇"));
    }

    // ---- volume / misc cards ----

    #[test]
    fn volume_action_parser_handles_relative_and_toggle() {
        assert!(matches!(parse_volume_action("").unwrap(), VolumeAction::Status));
        assert!(matches!(parse_volume_action("+1").unwrap(), VolumeAction::Step(1)));
        assert!(matches!(parse_volume_action("-10").unwrap(), VolumeAction::Step(-10)));
        assert!(matches!(parse_volume_action("+").unwrap(), VolumeAction::Step(10)));
        assert!(matches!(parse_volume_action("55").unwrap(), VolumeAction::Set(55)));
        assert!(matches!(parse_volume_action("500").unwrap(), VolumeAction::Set(100)));
        assert!(matches!(parse_volume_action("toggle").unwrap(), VolumeAction::ToggleMute));
        assert!(parse_volume_action("loud").is_err());
    }

    #[test]
    fn app_callbacks_fit_telegram_limit() {
        assert!(app_cb("quit", &"x".repeat(80)).is_none());
        let r = app_reply("t".into(), &[("🛑", "quit", &"Ж".repeat(26))]);
        assert!(r.keyboard.is_none(), "over-long refresh payload must be dropped");
    }

    #[test]
    fn misc_system_keyboards_fit() {
        for kb in [
            volume_keyboard(false),
            volume_keyboard(true),
            display_keyboard(),
            focus_keyboard(),
        ] {
            assert_fits(&kb);
            assert!(all_callbacks(&kb).iter().all(|d| d.starts_with("refresh:")));
        }
        for d in all_callbacks(&volume_keyboard(false)) {
            let args = d.strip_prefix("refresh:volume:").unwrap_or("");
            assert!(parse_volume_action(args).is_ok(), "unparseable: {args}");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn get_battery_returns_present_or_fallback_shape() {
        let out = GetBattery.invoke(&ctx(), json!({})).await.unwrap();
        // Real `pmset` runs on the host; either shape is acceptable —
        // the important invariant is that the tool always returns
        // well-formed JSON with a `present` boolean.
        let present = out.get("present").and_then(|v| v.as_bool());
        assert!(
            present.is_some(),
            "expected a boolean `present` field, got {out}"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn volume_control_rejects_multiple_mutually_exclusive_fields() {
        let err = VolumeControl
            .invoke(&ctx(), json!({ "level": 50, "mute": true }))
            .await
            .unwrap_err();
        assert!(err.contains("at most one"));
    }
}
