import type { MouseEvent, ReactNode } from 'react';
import { Tooltip } from './Tooltip';

type IconButtonProps = {
  onClick: (e: MouseEvent<HTMLElement>) => void;
  children: ReactNode;
  title?: string;
  tone?: 'default' | 'danger';
  /** Renders a subtle accent highlight — use for toggle-on / pressed state. */
  active?: boolean;
  stopPropagation?: boolean;
  disabled?: boolean;
  /** Tooltip placement relative to the button. Defaults to `bottom` because
   *  most icon buttons live near the top of a scroll container, and a
   *  top-placed tooltip would clip behind the tabs bar above. */
  tooltipSide?: 'top' | 'bottom' | 'left' | 'right';
  'data-testid'?: string;
};

/** Refresh-2026-04 chrome:
 *  - 28 × 28 (was 24) — denser hit-target without bumping into icon-only `Button`.
 *  - Radius `--r-lg` (7 px) instead of Tailwind `rounded-md` (12 px).
 *  - Default state: fully transparent. Hover lifts to `var(--bg-hover)` and
 *    foreground bumps from `--fg-mute` to `--fg`.
 *  - `active` (toggle-on): `var(--accent-fog)` background + accent foreground.
 *  - `tone="danger"`: only colours on hover (red foreground); no red background.
 *
 *  Inline styles are used for the bg / colour swaps because the new tokens
 *  live as CSS variables — Tailwind arbitrary classes for `var(...)` would
 *  read worse. Hover/focus visuals stay in classNames so :hover / :focus
 *  pseudo-classes work without extra JS state.
 */
export const IconButton = ({
  onClick,
  children,
  title,
  tone = 'default',
  active = false,
  stopPropagation = true,
  disabled = false,
  tooltipSide = 'bottom',
  'data-testid': dataTestId,
}: IconButtonProps) => {
  const stateClass = active
    ? 'icon-btn-active'
    : tone === 'danger'
      ? 'icon-btn-default icon-btn-danger'
      : 'icon-btn-default';
  return (
    <Tooltip label={title} side={tooltipSide}>
      <button
        type="button"
        aria-label={title}
        aria-pressed={active}
        disabled={disabled}
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          onClick(e);
        }}
        data-testid={dataTestId}
        className={`icon-btn ring-focus ${stateClass}`}
      >
        {children}
      </button>
    </Tooltip>
  );
};
