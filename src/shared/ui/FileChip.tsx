import type { ReactNode } from 'react';

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
          backgroundColor: 'rgba(var(--stash-accent-rgb), 0.10)',
          color: 'rgb(var(--stash-accent-rgb))',
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
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

/// Format a byte count for the `size` slot. Placed in this file so
/// callers only import one thing. Preserves the old `formatBytes`
/// semantics from the inbox MediaItems (B / KB / MB, one-decimal MB).
export const formatBytes = (n: number | null | undefined): string => {
  if (!n || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
};
