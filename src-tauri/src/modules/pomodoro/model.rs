use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Posture {
    Sit,
    Stand,
    Walk,
}

/// A single named timer block within a pomodoro session. `id` is a stable
/// string so the in-flight engine can preserve the current-block pointer when
/// the user edits the surrounding plan (see `EngineCore::edit_blocks`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Block {
    pub id: String,
    pub name: String,
    pub duration_sec: u32,
    pub posture: Posture,
    /// Seconds of elapsed time into the block at which to fire a soft nudge.
    /// `None` = no nudge.
    pub mid_nudge_sec: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PresetKind {
    /// One self-contained run (e.g. "Quick focus — 25m"). Typically 1-2 blocks.
    Session,
    /// A longer multi-block plan covering a working block of the day.
    Daily,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Preset {
    pub id: i64,
    pub name: String,
    pub kind: PresetKind,
    pub blocks: Vec<Block>,
    pub updated_at: i64,
}

/// Append-only row describing an executed (or abandoned) session. Kept as a
/// denormalized projection so future stats can be computed without joining
/// back to `pomodoro_presets` (which may have been edited since).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionRow {
    pub id: i64,
    pub preset_id: Option<i64>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub blocks: Vec<Block>,
    pub completed_idx: usize,
}
