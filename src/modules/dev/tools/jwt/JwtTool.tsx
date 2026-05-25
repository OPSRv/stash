import {
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
  type UIEvent,
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '../../../../shared/ui/Button';
import { IconButton } from '../../../../shared/ui/IconButton';
import { CopyIcon, CheckIcon } from '../../../../shared/ui/icons';
import { copyText } from '../../../../shared/util/clipboard';
import {
  DEV_OPEN_TOOL_EVENT,
  takePendingDevTool,
} from '../../pendingTool';
import { decodeJwt, stripBearer } from './jwt';
import { JsonTree } from './JsonTree';

/// jwt.io-style palette, hand-picked for our dark surface and light
/// theme alike. The same hue plays the role of "header segment colour"
/// in the encoded token *and* the small dot next to the decoded card,
/// so the eye can follow a segment across the two panes.
const SEGMENT_COLOR = {
  header: '#f87171',    // soft red — matches Tailwind red-400
  payload: '#c084fc',   // soft purple — Tailwind purple-400
  signature: '#22d3ee', // cyan — Tailwind cyan-400
} as const;

type SegmentKey = keyof typeof SEGMENT_COLOR;

/// A coloured, read-only mirror of the token sitting under a
/// transparent textarea. Together they form a single editable surface
/// where each base64url segment glows in its own colour — same trick
/// jwt.io uses. The mirror has no pointer events and gets its
/// scrollTop synced from the textarea so the rendering stays aligned
/// as the user scrolls a long token.
function HighlightedTokenInput({
  value,
  onChange,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  invalid: boolean;
}) {
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const parts = value.split('.');
  const has3 = parts.length === 3;

  const onScroll = (e: UIEvent<HTMLTextAreaElement>) => {
    const m = mirrorRef.current;
    if (!m) return;
    m.scrollTop = (e.target as HTMLTextAreaElement).scrollTop;
    m.scrollLeft = (e.target as HTMLTextAreaElement).scrollLeft;
  };

  // Shared style ensures the mirror's wrapping matches the textarea's
  // exactly — same font metrics, same padding, same break rules.
  // Without this the caret position drifts as the user types.
  const sharedStyle = {
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: '12px',
    lineHeight: '1.55',
    padding: '12px 14px',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all' as const,
  };

  return (
    <div
      className="relative flex-1 min-h-0 rounded-lg border bg-[color:var(--bg-pane)]"
      style={{
        borderColor: invalid
          ? 'var(--color-danger-fg)'
          : 'var(--hairline)',
      }}
    >
      <div
        ref={mirrorRef}
        aria-hidden
        className="absolute inset-0 overflow-hidden pointer-events-none select-none"
        style={sharedStyle}
      >
        {value === '' ? (
          <span style={{ color: 'var(--fg-mute)' }}>
            Paste a JWT here…
          </span>
        ) : has3 ? (
          <Fragment>
            <span style={{ color: SEGMENT_COLOR.header }}>{parts[0]}</span>
            <span style={{ color: 'var(--fg-mute)' }}>.</span>
            <span style={{ color: SEGMENT_COLOR.payload }}>{parts[1]}</span>
            <span style={{ color: 'var(--fg-mute)' }}>.</span>
            <span style={{ color: SEGMENT_COLOR.signature }}>{parts[2]}</span>
          </Fragment>
        ) : (
          <span style={{ color: 'var(--fg)' }}>{value}</span>
        )}
        {/* Trailing newline keeps the mirror's last line height in sync
            with the textarea when the user types a Return at the end. */}
        {'\n'}
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
        onScroll={onScroll}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        className="relative w-full h-full bg-transparent outline-none resize-none caret-[color:var(--fg)]"
        style={{
          ...sharedStyle,
          color: 'transparent',
        }}
        aria-label="JWT token"
      />
    </div>
  );
}

/// Pretty-print a decoded segment for the "Copy raw" button. Header
/// and payload come in as JSON strings; we re-indent so paste-targets
/// (Slack, code editor) get a readable blob instead of the original
/// jammed-onto-one-line form.
const prettyJson = (raw: string): string => {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
};

interface DecodedSectionProps {
  /// One of `header` / `payload` / `signature` — drives the colour dot
  /// and copy-label.
  kind: SegmentKey;
  label: string;
  /// Decoded value to render in the tree. `null` falls back to the
  /// raw text block (used for the signature).
  value: unknown | null;
  /// Text handed to the clipboard when the user hits Copy raw.
  rawCopy: string;
  /// `primary` always-expanded card that grows (Payload). `collapsible`
  /// renders a slim disclosure row that expands inline on click — used
  /// for Header / Signature so Payload keeps maximum vertical space.
  /// Collapsible-section open state is owned by the parent so it can
  /// decide whether the bottom block claims its 30 % of the right
  /// column.
  emphasis?: 'primary' | 'collapsible';
  emptyHint?: string;
  open?: boolean;
  onToggle?: () => void;
}

const DecodedSection = ({
  kind,
  label,
  value,
  rawCopy,
  emphasis = 'primary',
  emptyHint,
  open: openProp,
  onToggle,
}: DecodedSectionProps) => {
  const [copied, setCopied] = useState(false);
  const isCollapsible = emphasis === 'collapsible';
  const open = isCollapsible ? Boolean(openProp) : true;
  const onCopy = async (e?: ReactMouseEvent) => {
    e?.stopPropagation();
    const ok = await copyText(rawCopy);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  const showBody = !isCollapsible || open;
  return (
    <section
      className={`rounded-xl border bg-[color:var(--bg-elev)] flex flex-col min-h-0 ${
        emphasis === 'primary'
          ? 'flex-1'
          : open
            ? 'flex-1 min-h-0'
            : 'shrink-0'
      }`}
      style={{ borderColor: 'var(--hairline)' }}
    >
      <header
        className={`flex items-center justify-between px-3 py-1.5 shrink-0 ${
          showBody ? 'border-b' : ''
        } ${isCollapsible ? 'cursor-pointer select-none' : ''}`}
        style={{ borderColor: 'var(--hairline)' }}
        onClick={isCollapsible ? onToggle : undefined}
        role={isCollapsible ? 'button' : undefined}
        aria-expanded={isCollapsible ? open : undefined}
        tabIndex={isCollapsible ? 0 : undefined}
        onKeyDown={
          isCollapsible
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onToggle?.();
                }
              }
            : undefined
        }
      >
        <div className="flex items-center gap-2 min-w-0">
          {isCollapsible && (
            <svg
              width="9"
              height="9"
              viewBox="0 0 9 9"
              aria-hidden
              className="shrink-0 t-tertiary transition-transform"
              style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
            >
              <path
                d="M2 1.5 L6 4.5 L2 7.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ background: SEGMENT_COLOR[kind] }}
            aria-hidden
          />
          <span className="text-meta t-tertiary uppercase tracking-wider">
            {label}
          </span>
        </div>
        <IconButton
          onClick={onCopy}
          title={copied ? 'Copied' : `Copy ${label.toLowerCase()}`}
          tooltipSide="left"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </IconButton>
      </header>
      {showBody && (
        <div
          className="flex-1 min-h-0 overflow-auto nice-scroll px-3 py-2"
        >
          {value !== null ? (
            <JsonTree value={value} />
          ) : (
            <div
              className="font-mono text-meta break-all whitespace-pre-wrap"
              style={{ color: SEGMENT_COLOR[kind] }}
            >
              {rawCopy || (
                <span
                  className="t-tertiary italic"
                  style={{ color: 'var(--fg-mute)' }}
                >
                  {emptyHint ?? '—'}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
};

/// Pull a `token` field out of the pending-dev-tool slot, if it's
/// addressed to us. Defensive: the slot is shared across tools and
/// could carry any shape — we only honour ours.
const tokenFromPending = (): string | null => {
  const pending = takePendingDevTool();
  if (!pending || pending.toolId !== 'jwt') return null;
  const payload = pending.payload as { token?: unknown } | undefined;
  return typeof payload?.token === 'string' ? payload.token : null;
};

export function JwtTool() {
  const [token, setToken] = useState<string>(() => tokenFromPending() ?? '');
  const [headerOpen, setHeaderOpen] = useState(false);
  const [signatureOpen, setSignatureOpen] = useState(false);
  const anyMetaOpen = headerOpen || signatureOpen;

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { toolId?: string; payload?: { token?: unknown } }
        | undefined;
      if (!detail || detail.toolId !== 'jwt') return;
      const next = detail.payload?.token;
      if (typeof next === 'string' && next.trim()) setToken(next);
    };
    window.addEventListener(DEV_OPEN_TOOL_EVENT, handler);
    return () => window.removeEventListener(DEV_OPEN_TOOL_EVENT, handler);
  }, []);

  const result = useMemo(() => decodeJwt(token), [token]);
  const cleanable = token !== '' && stripBearer(token) !== token.trim();

  return (
    <div
      className="h-full grid gap-4 p-4"
      style={{
        gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 7fr)',
        gridTemplateRows: 'minmax(0, 1fr)',
      }}
    >
      {/* LEFT — encoded token, jwt.io-style 3-colour highlight */}
      <section
        className="rounded-xl border bg-[color:var(--bg-elev)] flex flex-col min-h-0"
        style={{ borderColor: 'var(--hairline)' }}
      >
        <header
          className="flex items-center justify-between px-3 py-2 border-b shrink-0"
          style={{ borderColor: 'var(--hairline)' }}
        >
          <span className="text-meta t-tertiary uppercase tracking-wider">
            Encoded
          </span>
          <div className="flex items-center gap-1">
            {cleanable && (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setToken(stripBearer(token))}
                title="Strip Bearer / Authorization prefix and wrapping quotes"
              >
                Clean
              </Button>
            )}
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setToken('')}
              disabled={!token}
            >
              Clear
            </Button>
          </div>
        </header>
        <div className="flex-1 min-h-0 p-3 flex flex-col">
          <HighlightedTokenInput
            value={token}
            onChange={setToken}
            invalid={!result.ok && token.trim().length > 0}
          />
          {!result.ok && token.trim().length > 0 && (
            <p
              role="alert"
              className="mt-2 text-meta shrink-0"
              style={{ color: 'var(--color-danger-fg)' }}
            >
              {result.error}
            </p>
          )}
          {/* Legend that pairs the segment colour with its name. Kept
              compact so it doesn't compete with the token itself. */}
          <div className="mt-2 flex flex-wrap items-center gap-3 text-meta t-tertiary shrink-0">
            <LegendDot color={SEGMENT_COLOR.header} label="header" />
            <LegendDot color={SEGMENT_COLOR.payload} label="payload" />
            <LegendDot color={SEGMENT_COLOR.signature} label="signature" />
          </div>
        </div>
      </section>

      {/* RIGHT — decoded panes. Payload takes 70 % of the column, the
          Header + Signature drawer claims the remaining 30 % once
          either of them is expanded; while both are closed the
          drawer shrinks to its two title rows and gives the extra
          space back to Payload. */}
      <div className="flex flex-col gap-3 min-h-0">
        {result.ok ? (
          <>
            <div
              className="flex flex-col min-h-0"
              style={{ flex: '7 1 0%' }}
            >
              <DecodedSection
                kind="payload"
                label="Payload"
                value={result.decoded.payload}
                rawCopy={prettyJson(result.decoded.raw.payload)}
                emphasis="primary"
              />
            </div>
            <div
              className="flex flex-col gap-2 min-h-0"
              style={anyMetaOpen ? { flex: '3 1 0%' } : { flex: '0 0 auto' }}
            >
              <DecodedSection
                kind="header"
                label="Header"
                value={result.decoded.header}
                rawCopy={prettyJson(result.decoded.raw.header)}
                emphasis="collapsible"
                open={headerOpen}
                onToggle={() => setHeaderOpen((v) => !v)}
              />
              <DecodedSection
                kind="signature"
                label="Signature"
                value={null}
                rawCopy={result.decoded.signature}
                emphasis="collapsible"
                emptyHint="No signature (alg: none)"
                open={signatureOpen}
                onToggle={() => setSignatureOpen((v) => !v)}
              />
            </div>
          </>
        ) : (
          <div
            className="rounded-xl border p-6 text-center t-tertiary text-meta flex-1 flex items-center justify-center"
            style={{ borderColor: 'var(--hairline)' }}
          >
            {token.trim().length === 0 ? (
              <span>
                Paste a JWT on the left to decode it. <br />
                <span className="block mt-2 t-secondary">
                  Click any value to copy it. Drag to select.
                </span>
              </span>
            ) : (
              <span>{result.error}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const LegendDot = ({ color, label }: { color: string; label: string }) => (
  <span className="inline-flex items-center gap-1.5">
    <span
      className="inline-block w-1.5 h-1.5 rounded-full"
      style={{ background: color }}
      aria-hidden
    />
    {label}
  </span>
);

export default JwtTool;
