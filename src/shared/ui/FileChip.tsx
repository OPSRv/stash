import type { ReactNode } from 'react';
import { formatBytes as fmtBytes } from '../format/bytes';
import { accent } from '../theme/accent';
import { DocumentIcon } from './icons';

type FileChipProps = {
  /// Display name (usually the original filename, falling back to the
  /// basename of an absolute path).
  name: string;
  /// Optional MIME hint rendered under the name as a mono-space line.
  /// Long types are allowed to truncate — the full string stays in the
  /// title attribute.
  mimeType?: string | null;
  /// Human-formatted size (caller picks the unit — see `formatBytes`
  /// in `shared/ui/format.ts` if you need one).
  size?: string | null;
  /// Action slot rendered on the right side of the chip — icon buttons
  /// like "Reveal in Finder" or "Remove". Kept as a slot rather than
  /// wired props so each call site can express the exact mix of
  /// actions that makes sense for the context.
  actions?: ReactNode;
  /// Optional caption rendered under the chip (e.g. a Telegram photo
  /// caption attached to a document).
  caption?: string | null;
  className?: string;
};

/// Generic file row. Renders a document icon, the name + mime/size on
/// one column, and an optional action slot on the right. Used across
/// the Telegram inbox (document attachments) and notes attachments
/// (`kind = 'file'`) so a PDF looks the same everywhere.
export const FileChip = ({
  name,
  mimeType,
  size,
  actions,
  caption,
  className,
}: FileChipProps) => (
  <div className={`flex flex-col gap-2 ${className ?? ''}`}>
    <div className="flex items-center gap-3">
      <div
        className="w-9 h-9 rounded-md flex items-center justify-center shrink-0"
        style={{
          backgroundColor: accent(0.10),
          color: 'rgb(var(--stash-accent-rgb))',
        }}
      >
        <DocumentIcon size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-white/92 truncate" title={name}>
          {name}
        </div>
        {(mimeType || size) && (
          <div
            className="text-[11px] text-white/45 truncate font-mono"
            title={mimeType ?? undefined}
          >
            {[mimeType, size].filter(Boolean).join(' · ')}
          </div>
        )}
      </div>
      {actions && <div className="shrink-0 flex items-center gap-0.5">{actions}</div>}
    </div>
    {caption && (
      <p className="text-[13px] leading-[18px] text-white/80 whitespace-pre-wrap">
        {caption}
      </p>
    )}
  </div>
);

/// Re-export of the canonical formatter with FileChip's preset
/// (stops at MB, empty string for null/0/negatives). Call sites in
/// the Telegram inbox and notes attachments expect this exact shape.
export const formatBytes = (n: number | null | undefined): string =>
  fmtBytes(n, { stopAt: 'MB', empty: '' });
