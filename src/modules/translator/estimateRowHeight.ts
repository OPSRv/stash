import type { TranslationRow } from './api';

/// Rough row-height estimate used by react-virtual before the real DOM is
/// measured. Keeps the scrollbar close to the final size so long histories
/// don't jitter as rows measure in. `measureElement` replaces these values
/// as each row mounts; the estimate just bounds the initial overshoot.
const MIN_HEIGHT = 72;
const MAX_HEIGHT = 200;
const CHARS_PER_LINE = 60;
const LINE_HEIGHT = 18;

export const estimateTranslationRowHeight = (row: TranslationRow): number => {
  const lines = Math.ceil(row.translated.length / CHARS_PER_LINE) || 1;
  return Math.min(MAX_HEIGHT, MIN_HEIGHT + lines * LINE_HEIGHT);
};
