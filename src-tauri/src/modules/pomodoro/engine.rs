use serde::Serialize;
use std::collections::HashSet;

use super::model::{Block, Posture};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Idle,
    Running,
    Paused,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SessionSnapshot {
    pub status: SessionStatus,
    pub blocks: Vec<Block>,
    pub current_idx: usize,
    pub remaining_ms: i64,
    pub started_at: i64,
    pub preset_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EngineEvent {
    BlockChanged {
        from_idx: usize,
        to_idx: usize,
        from_posture: Posture,
        to_posture: Posture,
        block_name: String,
    },
    Nudge {
        block_idx: usize,
        block_name: String,
        text: String,
    },
    SessionDone {
        blocks_completed: usize,
        total_sec: i64,
    },
}

/// Pure pomodoro state machine. Takes wall-clock ms (`now_ms`) from the caller
/// on every mutation so the tick driver, tests, and sleep/wake reconciliation
/// all go through the same API without the core touching `SystemTime`.
#[derive(Debug, Clone)]
pub struct EngineCore {
    status: SessionStatus,
    blocks: Vec<Block>,
    current_idx: usize,
    /// Remaining duration of the *current* block. Frozen while Paused.
    remaining_ms: i64,
    last_tick_ms: i64,
    started_at_sec: i64,
    preset_id: Option<i64>,
    fired_nudges: HashSet<String>,
}

impl EngineCore {
    pub fn new() -> Self {
        Self {
            status: SessionStatus::Idle,
            blocks: Vec::new(),
            current_idx: 0,
            remaining_ms: 0,
            last_tick_ms: 0,
            started_at_sec: 0,
            preset_id: None,
            fired_nudges: HashSet::new(),
        }
    }

    pub fn snapshot(&self) -> SessionSnapshot {
        SessionSnapshot {
            status: self.status,
            blocks: self.blocks.clone(),
            current_idx: self.current_idx,
            remaining_ms: self.remaining_ms.max(0),
            started_at: self.started_at_sec,
            preset_id: self.preset_id,
        }
    }

    pub fn is_idle(&self) -> bool {
        matches!(self.status, SessionStatus::Idle)
    }

    pub fn start(&mut self, blocks: Vec<Block>, preset_id: Option<i64>, now_ms: i64) {
        if blocks.is_empty() {
            self.stop(now_ms);
            return;
        }
        self.blocks = blocks;
        self.current_idx = 0;
        self.remaining_ms = self.blocks[0].duration_sec as i64 * 1000;
        self.status = SessionStatus::Running;
        self.last_tick_ms = now_ms;
        self.started_at_sec = now_ms / 1000;
        self.preset_id = preset_id;
        self.fired_nudges.clear();
    }

    pub fn pause(&mut self, now_ms: i64) {
        if !matches!(self.status, SessionStatus::Running) {
            return;
        }
        // Drain elapsed time up to `now_ms` so `remaining_ms` matches what the
        // user saw on screen at the moment they hit pause. Don't fire events
        // — callers should `advance()` first if they want transitions to land.
        let delta = (now_ms - self.last_tick_ms).max(0);
        self.remaining_ms = (self.remaining_ms - delta).max(0);
        self.last_tick_ms = now_ms;
        self.status = SessionStatus::Paused;
    }

    pub fn resume(&mut self, now_ms: i64) {
        if !matches!(self.status, SessionStatus::Paused) {
            return;
        }
        self.last_tick_ms = now_ms;
        self.status = SessionStatus::Running;
    }

    pub fn stop(&mut self, _now_ms: i64) {
        self.status = SessionStatus::Idle;
        self.blocks.clear();
        self.current_idx = 0;
        self.remaining_ms = 0;
        self.preset_id = None;
        self.fired_nudges.clear();
    }

    pub fn skip_to(&mut self, idx: usize, now_ms: i64) -> Vec<EngineEvent> {
        if self.blocks.is_empty() {
            return Vec::new();
        }
        if idx >= self.blocks.len() {
            // Past the end — emit one SessionDone and go Idle.
            let completed = self.blocks.len();
            let total = (now_ms / 1000) - self.started_at_sec;
            let ev = EngineEvent::SessionDone {
                blocks_completed: completed,
                total_sec: total.max(0),
            };
            self.stop(now_ms);
            return vec![ev];
        }
        let from_idx = self.current_idx;
        let from_posture = self.blocks[from_idx].posture;
        let to_posture = self.blocks[idx].posture;
        let block_name = self.blocks[idx].name.clone();
        self.current_idx = idx;
        self.remaining_ms = self.blocks[idx].duration_sec as i64 * 1000;
        self.last_tick_ms = now_ms;
        if !matches!(self.status, SessionStatus::Paused) {
            self.status = SessionStatus::Running;
        }
        vec![EngineEvent::BlockChanged {
            from_idx,
            to_idx: idx,
            from_posture,
            to_posture,
            block_name,
        }]
    }

    /// Replace the block list in-flight. If the current block's `id` is still
    /// present, keep the cursor on it and preserve `remaining_ms`. Otherwise
    /// snap the cursor to whatever used to be after it, clamped to the new
    /// list length, and reset the block clock.
    pub fn edit_blocks(&mut self, new_blocks: Vec<Block>, now_ms: i64) {
        if new_blocks.is_empty() {
            self.stop(now_ms);
            return;
        }
        if self.is_idle() {
            self.blocks = new_blocks;
            return;
        }
        let current_id = self.blocks.get(self.current_idx).map(|b| b.id.clone());
        let new_idx = current_id
            .as_ref()
            .and_then(|id| new_blocks.iter().position(|b| b.id == *id));
        self.blocks = new_blocks;
        match new_idx {
            Some(idx) => {
                self.current_idx = idx;
            }
            None => {
                self.current_idx = self.current_idx.min(self.blocks.len() - 1);
                self.remaining_ms = self.blocks[self.current_idx].duration_sec as i64 * 1000;
                self.last_tick_ms = now_ms;
            }
        }
    }

    /// Advance the clock to `now_ms`, firing any transitions and nudges that
    /// happen in the elapsed window. Safe across arbitrary deltas — if the
    /// caller slept for minutes, we walk through all intermediate blocks.
    pub fn advance(&mut self, now_ms: i64) -> Vec<EngineEvent> {
        if !matches!(self.status, SessionStatus::Running) {
            // Still update the timestamp so resume-after-sleep doesn't fire a
            // huge delta the moment we resume.
            self.last_tick_ms = now_ms;
            return Vec::new();
        }
        let mut delta = (now_ms - self.last_tick_ms).max(0);
        self.last_tick_ms = now_ms;
        let mut events = Vec::new();
        while delta > 0 && matches!(self.status, SessionStatus::Running) {
            // Check nudge inside the current block before consuming time.
            if let Some(nudge) = self.check_nudge() {
                events.push(nudge);
            }
            if delta < self.remaining_ms {
                self.remaining_ms -= delta;
                // Nudge might land after partial consumption in this tick.
                if let Some(nudge) = self.check_nudge() {
                    events.push(nudge);
                }
                delta = 0;
            } else {
                // Consume the rest of this block and transition.
                delta -= self.remaining_ms;
                self.remaining_ms = 0;
                let from_idx = self.current_idx;
                let from_posture = self.blocks[from_idx].posture;
                let next_idx = from_idx + 1;
                if next_idx >= self.blocks.len() {
                    let total = (now_ms / 1000) - self.started_at_sec;
                    events.push(EngineEvent::SessionDone {
                        blocks_completed: self.blocks.len(),
                        total_sec: total.max(0),
                    });
                    self.stop(now_ms);
                    break;
                } else {
                    let to_block = &self.blocks[next_idx];
                    events.push(EngineEvent::BlockChanged {
                        from_idx,
                        to_idx: next_idx,
                        from_posture,
                        to_posture: to_block.posture,
                        block_name: to_block.name.clone(),
                    });
                    self.current_idx = next_idx;
                    self.remaining_ms = to_block.duration_sec as i64 * 1000;
                }
            }
        }
        events
    }

    /// If the current block has a `mid_nudge_sec` threshold and we've crossed
    /// it without firing yet, return the nudge event.
    fn check_nudge(&mut self) -> Option<EngineEvent> {
        let block = self.blocks.get(self.current_idx)?;
        let nudge_sec = block.mid_nudge_sec?;
        let total_ms = block.duration_sec as i64 * 1000;
        let elapsed_ms = total_ms - self.remaining_ms;
        if elapsed_ms < nudge_sec as i64 * 1000 {
            return None;
        }
        if self.fired_nudges.contains(&block.id) {
            return None;
        }
        self.fired_nudges.insert(block.id.clone());
        Some(EngineEvent::Nudge {
            block_idx: self.current_idx,
            block_name: block.name.clone(),
            text: nudge_text(block.posture),
        })
    }
}

/// Posture-aware nudge copy. Only Sit has a default nudge in the UI, but the
/// engine stays neutral and lets callers attach a nudge to any block.
fn nudge_text(posture: Posture) -> String {
    match posture {
        Posture::Sit => "Розімни спину — випростайся, оглянь вдалину".to_string(),
        Posture::Stand => "Переміни опору ноги".to_string(),
        Posture::Walk => "Тримай темп".to_string(),
    }
}

/// Transition copy fired on `BlockChanged`. Extracted so the Rust driver
/// (which emits system notifications) and the frontend banner share wording.
pub fn transition_text(from: Posture, to: Posture) -> String {
    match (from, to) {
        (Posture::Sit, Posture::Stand) => "Raise your desk — work standing".into(),
        (Posture::Sit, Posture::Walk) => "Start the treadmill".into(),
        (Posture::Stand, Posture::Sit) => "Sit down".into(),
        (Posture::Stand, Posture::Walk) => "Start the treadmill".into(),
        (Posture::Walk, Posture::Sit) => "Step off the treadmill and sit".into(),
        (Posture::Walk, Posture::Stand) => "Step off the treadmill, work standing".into(),
        (a, b) if a == b => format!("Next block — {}", posture_label(b)),
        (_, b) => format!("Transition → {}", posture_label(b)),
    }
}

pub fn posture_label(p: Posture) -> &'static str {
    match p {
        Posture::Sit => "Sit",
        Posture::Stand => "Stand",
        Posture::Walk => "Walk",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(id: &str, dur: u32, posture: Posture, nudge: Option<u32>) -> Block {
        Block {
            id: id.into(),
            name: id.into(),
            duration_sec: dur,
            posture,
            mid_nudge_sec: nudge,
        }
    }

    #[test]
    fn start_populates_snapshot_running_with_first_block_remaining() {
        let mut e = EngineCore::new();
        e.start(vec![b("a", 10, Posture::Sit, None)], None, 1_000);
        let s = e.snapshot();
        assert_eq!(s.status, SessionStatus::Running);
        assert_eq!(s.current_idx, 0);
        assert_eq!(s.remaining_ms, 10_000);
        assert_eq!(s.blocks.len(), 1);
    }

    #[test]
    fn advance_by_one_second_decrements_remaining() {
        let mut e = EngineCore::new();
        e.start(vec![b("a", 10, Posture::Sit, None)], None, 0);
        let ev = e.advance(1_000);
        assert!(ev.is_empty());
        assert_eq!(e.snapshot().remaining_ms, 9_000);
    }

    #[test]
    fn advance_past_block_emits_block_changed() {
        let mut e = EngineCore::new();
        e.start(
            vec![
                b("a", 3, Posture::Sit, None),
                b("b", 5, Posture::Stand, None),
            ],
            None,
            0,
        );
        let ev = e.advance(3_500);
        assert_eq!(ev.len(), 1);
        match &ev[0] {
            EngineEvent::BlockChanged {
                from_idx,
                to_idx,
                from_posture,
                to_posture,
                ..
            } => {
                assert_eq!(*from_idx, 0);
                assert_eq!(*to_idx, 1);
                assert_eq!(*from_posture, Posture::Sit);
                assert_eq!(*to_posture, Posture::Stand);
            }
            _ => panic!("wrong event"),
        }
        assert_eq!(e.snapshot().current_idx, 1);
        assert_eq!(e.snapshot().remaining_ms, 4_500);
    }

    #[test]
    fn advance_past_final_block_emits_session_done_and_goes_idle() {
        let mut e = EngineCore::new();
        e.start(vec![b("a", 1, Posture::Sit, None)], None, 0);
        let ev = e.advance(10_000);
        assert_eq!(ev.len(), 1);
        assert!(matches!(ev[0], EngineEvent::SessionDone { .. }));
        assert!(e.is_idle());
    }

    #[test]
    fn huge_delta_walks_through_all_intermediate_blocks() {
        let mut e = EngineCore::new();
        e.start(
            vec![
                b("a", 60, Posture::Sit, None),
                b("b", 60, Posture::Walk, None),
                b("c", 60, Posture::Sit, None),
            ],
            None,
            0,
        );
        let ev = e.advance(150_000); // 150s — past 'a' and 'b'
        let transitions: Vec<_> = ev
            .iter()
            .filter(|e| matches!(e, EngineEvent::BlockChanged { .. }))
            .collect();
        assert_eq!(transitions.len(), 2);
        assert_eq!(e.snapshot().current_idx, 2);
        assert_eq!(e.snapshot().remaining_ms, 30_000);
    }

    #[test]
    fn pause_freezes_remaining_ms_across_advance_calls() {
        let mut e = EngineCore::new();
        e.start(vec![b("a", 10, Posture::Sit, None)], None, 0);
        e.advance(3_000);
        e.pause(3_000);
        let frozen = e.snapshot().remaining_ms;
        e.advance(10_000); // wall-clock keeps moving
        assert_eq!(e.snapshot().remaining_ms, frozen);
    }

    #[test]
    fn resume_after_pause_resumes_from_frozen_remaining() {
        let mut e = EngineCore::new();
        e.start(vec![b("a", 10, Posture::Sit, None)], None, 0);
        e.advance(3_000);
        e.pause(3_000);
        e.resume(100_000); // long pause — resume at a different wall-clock
        let ev = e.advance(101_000);
        assert!(ev.is_empty());
        assert_eq!(e.snapshot().remaining_ms, 6_000);
    }

    #[test]
    fn skip_to_switches_block_and_resets_clock() {
        let mut e = EngineCore::new();
        e.start(
            vec![
                b("a", 60, Posture::Sit, None),
                b("b", 60, Posture::Stand, None),
            ],
            None,
            0,
        );
        let ev = e.skip_to(1, 10_000);
        assert_eq!(ev.len(), 1);
        assert_eq!(e.snapshot().current_idx, 1);
        assert_eq!(e.snapshot().remaining_ms, 60_000);
    }

    #[test]
    fn edit_blocks_keeps_cursor_on_current_block_id() {
        let mut e = EngineCore::new();
        e.start(
            vec![
                b("a", 60, Posture::Sit, None),
                b("b", 60, Posture::Stand, None),
            ],
            None,
            0,
        );
        e.advance(10_000);
        e.skip_to(1, 10_000);
        // Now we're on 'b' with 60s left. Rearrange so 'b' is first.
        e.edit_blocks(
            vec![
                b("b", 60, Posture::Stand, None),
                b("c", 30, Posture::Walk, None),
            ],
            10_000,
        );
        assert_eq!(e.snapshot().current_idx, 0);
        assert_eq!(e.snapshot().blocks[0].id, "b");
        // remaining_ms preserved because cursor still points at "b"
        assert_eq!(e.snapshot().remaining_ms, 60_000);
    }

    #[test]
    fn edit_blocks_clamps_when_current_block_removed() {
        let mut e = EngineCore::new();
        e.start(
            vec![
                b("a", 60, Posture::Sit, None),
                b("b", 60, Posture::Stand, None),
            ],
            None,
            0,
        );
        e.skip_to(1, 5_000);
        e.edit_blocks(vec![b("new", 30, Posture::Walk, None)], 5_000);
        assert_eq!(e.snapshot().current_idx, 0);
        assert_eq!(e.snapshot().remaining_ms, 30_000);
    }

    #[test]
    fn mid_nudge_fires_once_when_threshold_crossed() {
        let mut e = EngineCore::new();
        e.start(vec![b("a", 100, Posture::Sit, Some(50))], None, 0);
        let before = e.advance(49_000);
        assert!(before
            .iter()
            .all(|e| !matches!(e, EngineEvent::Nudge { .. })));
        let at = e.advance(51_000); // cross 50s
        let nudges: Vec<_> = at
            .iter()
            .filter(|e| matches!(e, EngineEvent::Nudge { .. }))
            .collect();
        assert_eq!(nudges.len(), 1);
        let after = e.advance(60_000);
        assert!(after
            .iter()
            .all(|e| !matches!(e, EngineEvent::Nudge { .. })));
    }

    #[test]
    fn stop_clears_session() {
        let mut e = EngineCore::new();
        e.start(vec![b("a", 10, Posture::Sit, None)], None, 0);
        e.stop(100);
        let s = e.snapshot();
        assert_eq!(s.status, SessionStatus::Idle);
        assert_eq!(s.blocks.len(), 0);
    }

    #[test]
    fn transition_text_is_posture_aware() {
        assert_eq!(
            transition_text(Posture::Sit, Posture::Stand),
            "Raise your desk — work standing"
        );
        assert_eq!(
            transition_text(Posture::Sit, Posture::Walk),
            "Start the treadmill"
        );
        assert_eq!(
            transition_text(Posture::Walk, Posture::Sit),
            "Step off the treadmill and sit"
        );
    }
}
