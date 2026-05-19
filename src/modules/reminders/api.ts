import { invoke } from '@tauri-apps/api/core';

/// Wire-format reminder row mirroring `ReminderDto` on the Rust side.
/// Times come through as unix seconds (UTC) — the renderer derives
/// local calendar grids from there.
export interface Reminder {
  id: number;
  text: string;
  /// Unix seconds, UTC. Treat as authoritative — local-time strings
  /// are reconstructed in the view (so a Mac waking from sleep at
  /// the wrong tz still renders cells correctly the first frame).
  due_at: number;
  sent: boolean;
  cancelled: boolean;
}

/// List every still-active reminder (not sent, not cancelled), sorted
/// by due_at ascending. Used by the "Active" list pane on first load.
export const remindersList = async (): Promise<Reminder[]> =>
  invoke<Reminder[]>('reminders_list');

/// Range query for the calendar grid. `[startSec, endSec)` half-open
/// — caller passes the unix-seconds bounds of the visible month. The
/// backend includes already-fired / cancelled rows too so the grid
/// can dim them; the list view filters them out on its own.
export const remindersListRange = async (
  startSec: number,
  endSec: number,
): Promise<Reminder[]> => invoke<Reminder[]>('reminders_list_range', { startSec, endSec });

/// Create a reminder. `when` follows the same parser the Telegram
/// `/remind` handler uses: `10m`, `1h30m`, `14:30`, `tomorrow 9:00`,
/// `YYYY-MM-DD HH:MM`. The backend pre-validates and surfaces a
/// parser error verbatim — toast it.
export const remindersCreate = async (
  text: string,
  when: string,
): Promise<Reminder> => invoke<Reminder>('reminders_create', { text, when });

/// Cancel a reminder by id. Returns `true` if the row transitioned
/// from active → cancelled, `false` if it was already gone (already
/// fired or already cancelled).
export const remindersCancel = async (id: number): Promise<boolean> =>
  invoke<boolean>('reminders_cancel', { id });
