import type { ReactNode } from 'react';
import { Kbd } from './Kbd';

type Props = {
  title: ReactNode;
  description?: ReactNode;
  /** Inline icon shown above the title. The refresh-2026-04 layout pairs it
   *  with `glyph: true` to render a 56 × 56 elevated tile as the wrapper. */
  icon?: ReactNode;
  /** Wrap the icon in a 56 × 56 rounded-14 elevated tile. Used by the bundle's
   *  `No note selected` empty state — opt-in so the lighter compact variant
   *  isn't pushed into a card-like shape. */
  glyph?: boolean;
  /** Optional keyboard-shortcut hint row above the action cluster.
   *  E.g. `{ label: 'New note', kbd: '⌘⇧J' }`. */
  kbdHint?: { label: string; kbd: string };
  action?: ReactNode;
  variant?: 'default' | 'compact';
  className?: string;
};

export const EmptyState = ({
  title,
  description,
  icon,
  glyph = false,
  kbdHint,
  action,
  variant = 'default',
  className = '',
}: Props) => {
  const pad = variant === 'compact' ? 'py-6 px-4' : 'py-10 px-6';
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-col items-center justify-center text-center gap-3.5 ${pad} ${className}`}
    >
      {icon ? (
        glyph ? (
          <div
            className="flex items-center justify-center t-tertiary mb-1"
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: 'var(--bg-elev)',
              border: '0.5px solid var(--hairline)',
            }}
          >
            {icon}
          </div>
        ) : (
          <div className="t-tertiary mb-1 flex items-center justify-center opacity-70">
            {icon}
          </div>
        )
      ) : null}
      <div className="t-primary" style={{ font: 'var(--t-display)' }}>
        {title}
      </div>
      {description ? (
        <div className="t-secondary text-body max-w-[320px]">{description}</div>
      ) : null}
      {kbdHint ? (
        <div className="inline-flex items-center gap-1.5 text-meta t-tertiary">
          <span>{kbdHint.label}</span>
          <Kbd>{kbdHint.kbd}</Kbd>
        </div>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
};
