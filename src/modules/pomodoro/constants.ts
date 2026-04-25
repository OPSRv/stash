import type { Posture } from './api';

export const POSTURE_LABEL: Record<Posture, string> = {
  sit: 'Sit',
  stand: 'Stand',
  walk: 'Walk',
};

/** Matches the Rust `transition_text` copy — keep the two in sync. */
export const transitionText = (from: Posture, to: Posture): string => {
  if (from === 'sit' && to === 'stand') return 'Raise your desk — work standing';
  if (from === 'sit' && to === 'walk') return 'Start the treadmill';
  if (from === 'stand' && to === 'sit') return 'Sit down';
  if (from === 'stand' && to === 'walk') return 'Start the treadmill';
  if (from === 'walk' && to === 'sit') return 'Step off the treadmill and sit';
  if (from === 'walk' && to === 'stand') return 'Step off the treadmill, work standing';
  if (from === to) return `Next block — ${POSTURE_LABEL[to]}`;
  return `Transition → ${POSTURE_LABEL[to]}`;
};

export const formatMmSs = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

export const DEFAULT_MID_NUDGE_SEC = 20 * 60;
