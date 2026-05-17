import './TrackToggle.css';
import type { CSSProperties, ReactNode } from 'react';

export type TrackToggleTone = 'mute' | 'solo' | 'neutral';

export interface TrackToggleProps {
  /// Visible glyph — usually a one-letter abbreviation (M / S / R).
  children: ReactNode;
  active: boolean;
  onClick: () => void;
  title: string;
  tone?: TrackToggleTone;
  /// Optional RGB triple (e.g. `"236, 72, 153"`) used when tone='solo'
  /// to tint the active state to the stem's own colour instead of the
  /// global accent. Ignored for other tones.
  colorRgb?: string;
  disabled?: boolean;
  'data-testid'?: string;
}

/// Compact 18×14 chip used for M/S toggles in the Stems mixer (and any
/// future DAW-flavoured surface). Visual rules:
///   - `mute`     – inactive grey, active red glow ("track silenced").
///   - `solo`     – inactive grey, active stem-tinted glow ("only this").
///   - `neutral`  – inactive grey, active accent (rec / cycle / etc.).
/// Always renders as a real `<button>` so keyboard activation works.
export const TrackToggle = ({
  children,
  active,
  onClick,
  title,
  tone = 'neutral',
  colorRgb,
  disabled,
  'data-testid': dataTestId,
}: TrackToggleProps) => {
  // Encode the colour in CSS variables so the markup stays clean and the
  // hover/active rules don't have to recompute the same triple.
  const style: CSSProperties = {};
  if (tone === 'solo' && colorRgb) {
    (style as Record<string, string>)['--tt-rgb'] = colorRgb;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      data-tone={tone}
      data-active={active ? 'true' : 'false'}
      data-testid={dataTestId}
      disabled={disabled}
      style={style}
      className="stash-track-toggle"
    >
      {children}
    </button>
  );
};
