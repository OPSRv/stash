/* `drums:remote` — the assistant / CLI / Telegram surface. Rust
 * (`drums/agent.rs`) validates and resolves user intent into this payload;
 * the shell applies it with `applyRemote` and acks on `drums:remote:ack`. */

import {
  clampBpm,
  type DrumsState,
  type DrumVoice,
  type ExportFormat,
  normalizeState,
  parseSteps,
  SWING_MAX,
  VOICES,
} from './model';
import { applyPreset, findPreset } from './presets';

export type DrumsRemote = {
  action?: 'start' | 'stop' | 'toggle' | 'status' | null;
  bpm?: number | null;
  bpm_delta?: number | null;
  preset?: string | null;
  meter?: string | null;
  bars?: number | null;
  swing?: number | null;
  steps?: Partial<Record<string, string>> | null;
  clear?: string[] | null;
  mute?: Partial<Record<string, boolean>> | null;
  volume?: Partial<Record<string, number>> | null;
  master_volume?: number | null;
  export?: { format: ExportFormat; bars: number; dir: string } | null;
  ack_id?: number | null;
};

export type DrumsRemoteAck = {
  ack_id: number | null;
  playing: boolean;
  bpm: number;
  preset_id: string | null;
  exported_path?: string;
  error?: string;
};

const isVoice = (v: string): v is DrumVoice => (VOICES as readonly string[]).includes(v);

/** Apply every pattern/mix field of `p` to `s`. Order: preset first (it
 *  resets the groove), then structure (meter/bars), then per-voice edits —
 *  so "funk preset, but no open hat" works in one call. Returns `s` itself
 *  when nothing changed. */
export const applyRemote = (s: DrumsState, p: DrumsRemote): DrumsState => {
  let next = s;
  let edited = false;
  const preset = p.preset ? findPreset(p.preset) : undefined;
  if (preset) next = applyPreset(next, preset);

  const patch: Partial<DrumsState> = {};
  if (typeof p.bpm === 'number') patch.bpm = clampBpm(p.bpm);
  else if (typeof p.bpm_delta === 'number') patch.bpm = clampBpm(next.bpm + p.bpm_delta);
  if (p.meter) patch.meter = p.meter as DrumsState['meter'];
  if (p.bars === 1 || p.bars === 2) patch.bars = p.bars;
  if (typeof p.swing === 'number') patch.swing = Math.max(0, Math.min(SWING_MAX, p.swing));
  if (typeof p.master_volume === 'number') patch.master_volume = p.master_volume;
  if (Object.keys(patch).length > 0) next = normalizeState({ ...next, ...patch }, next);

  const len = next.steps.kick.length;
  const steps = { ...next.steps };
  const mix = { ...next.mix };
  for (const v of p.clear ?? []) {
    if (!isVoice(v)) continue;
    steps[v] = new Array(len).fill(0);
    edited = true;
  }
  for (const [v, str] of Object.entries(p.steps ?? {})) {
    if (!isVoice(v) || typeof str !== 'string') continue;
    // normalizeState tiles/truncates to the pattern length.
    steps[v] = parseSteps(str);
    edited = true;
  }
  for (const [v, muted] of Object.entries(p.mute ?? {})) {
    if (isVoice(v) && typeof muted === 'boolean') mix[v] = { ...mix[v], muted };
  }
  for (const [v, volume] of Object.entries(p.volume ?? {})) {
    if (isVoice(v) && typeof volume === 'number') mix[v] = { ...mix[v], volume };
  }
  if (p.clear || p.steps || p.mute || p.volume) {
    next = normalizeState({ ...next, steps, mix }, next);
  }
  if (edited) next = { ...next, preset_id: null };
  return next;
};
