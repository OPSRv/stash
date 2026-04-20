import type { Posture } from './api';

export const POSTURE_LABEL: Record<Posture, string> = {
  sit: 'Sit',
  stand: 'Stand',
  walk: 'Walk',
};

/** Matches the Rust `transition_text` copy — keep the two in sync. */
export const transitionText = (from: Posture, to: Posture): string => {
  if (from === 'sit' && to === 'stand') return 'Підніми стіл — працюй стоячи';
  if (from === 'sit' && to === 'walk') return 'Стартуй доріжку';
  if (from === 'stand' && to === 'sit') return 'Сядь';
  if (from === 'stand' && to === 'walk') return 'Стартуй доріжку';
  if (from === 'walk' && to === 'sit') return 'Злізь з доріжки та сядь';
  if (from === 'walk' && to === 'stand') return 'Злізь з доріжки, працюй стоячи';
  if (from === to) return `Наступний блок — ${POSTURE_LABEL[to]}`;
  return `Перехід → ${POSTURE_LABEL[to]}`;
};

export const formatMmSs = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

export const DEFAULT_MID_NUDGE_SEC = 20 * 60;
