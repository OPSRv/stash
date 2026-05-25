import { useState } from 'react';
import { IconButton } from '../../../../shared/ui/IconButton';
import { CopyIcon } from '../../../../shared/ui/icons';
import { CheckIcon } from '../../../../shared/ui/icons';
import { copyText } from '../../../../shared/util/clipboard';
import { TIMESTAMP_CLAIMS, formatTimestamp } from './jwt';

type Json =
  | null
  | string
  | number
  | boolean
  | Json[]
  | { [key: string]: Json };

interface NodeProps {
  /// `null` for the root node (no key label rendered).
  k: string | number | null;
  v: unknown;
  depth: number;
  /// Whether this node sits inside an array — switches the
  /// timestamp annotation off (array indices are never claims).
  inArray?: boolean;
}

/// Pretty-prints a value for the "copy" payload. Primitives are
/// copied as their raw string form (numbers without quotes, strings
/// unquoted) — that matches the user's mental model of "I just want
/// this value, not its JSON encoding". Objects/arrays get JSON.
const valueForCopy = (v: unknown): string => {
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v, null, 2);
};

const CopyValueButton = ({ value }: { value: unknown }) => {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    const ok = await copyText(valueForCopy(value));
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <IconButton
      onClick={onCopy}
      title={copied ? 'Copied' : 'Copy value'}
      tooltipSide="left"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </IconButton>
  );
};

const PrimitivePreview = ({
  v,
  claim,
}: {
  v: unknown;
  claim: string | null;
}) => {
  if (v === null) return <span className="t-tertiary italic">null</span>;
  if (typeof v === 'string') {
    return (
      <span className="text-[color:var(--color-success-fg)] break-all">
        &quot;{v}&quot;
      </span>
    );
  }
  if (typeof v === 'number') {
    // Annotate well-known timestamp claims with a human-readable date.
    const ts = claim && TIMESTAMP_CLAIMS.has(claim) ? formatTimestamp(v) : null;
    return (
      <span className="text-[color:var(--color-warning-fg)] tabular-nums">
        {String(v)}
        {ts && (
          <span className="ml-2 t-tertiary text-meta">· {ts}</span>
        )}
      </span>
    );
  }
  if (typeof v === 'boolean') {
    return (
      <span className="text-[color:var(--color-danger-fg)]">
        {String(v)}
      </span>
    );
  }
  return <span className="t-secondary">{String(v)}</span>;
};

const Chevron = ({ open }: { open: boolean }) => (
  <svg
    width="10"
    height="10"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    style={{
      transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
      transition: 'transform 120ms ease',
    }}
  >
    <path d="M9 6l6 6-6 6" />
  </svg>
);

/// Some JWT producers stash whole objects as a stringified JSON value
/// (Slottica's `AuthInfo`, AWS Cognito's `cognito:groups` quirks, …).
/// Try to parse strings that look like JSON so the tree can drill in.
/// We only re-parse strings that start with `{` or `[` to avoid
/// surprising "12" → 12 conversions on numeric-looking ids.
const tryParseJsonString = (s: string): unknown | null => {
  const t = s.trim();
  if (!t) return null;
  const first = t[0];
  if (first !== '{' && first !== '[') return null;
  try {
    const parsed = JSON.parse(t);
    // Only treat as nested if it actually decoded into a container —
    // a bare `"null"` or `"42"` shouldn't replace the string view.
    if (parsed !== null && typeof parsed === 'object') return parsed;
  } catch {
    // Not JSON after all — fall through to the plain string render.
  }
  return null;
};

const TreeNode = ({ k, v, depth, inArray = false }: NodeProps) => {
  // Auto-detect strings that carry an embedded JSON object/array and
  // promote them so the user can expand + copy each inner value.
  const embedded = typeof v === 'string' ? tryParseJsonString(v) : null;
  const effectiveValue = embedded ?? v;
  const isObject = effectiveValue !== null && typeof effectiveValue === 'object';
  const isArray = Array.isArray(effectiveValue);
  // Default open for the first two depths so the user sees the whole
  // payload without clicking. Deeper nesting starts collapsed to keep
  // wall-of-text Cognito tokens scannable.
  const [open, setOpen] = useState(depth < 2);

  const keyLabel = k === null
    ? null
    : inArray
      ? String(k)
      : String(k);

  if (!isObject) {
    return (
      <PrimitiveRow
        v={v}
        depth={depth}
        keyLabel={keyLabel}
        inArray={inArray}
      />
    );
  }

  return (
    <ContainerRow
      v={v}
      effectiveValue={effectiveValue}
      embedded={embedded}
      isArray={isArray}
      keyLabel={keyLabel}
      depth={depth}
      open={open}
      setOpen={setOpen}
    />
  );
};

interface PrimitiveRowProps {
  v: unknown;
  depth: number;
  keyLabel: string | null;
  inArray: boolean;
}

/// Primitive (leaf) row. Whole row is clickable → copies the value;
/// the trailing IconButton repeats the action for keyboard users and
/// renders the "Copied" tick. A brief background flash gives visual
/// confirmation when the user clicks the row body.
const PrimitiveRow = ({ v, depth, keyLabel, inArray }: PrimitiveRowProps) => {
  const [flash, setFlash] = useState(false);
  const doCopy = async () => {
    const ok = await copyText(valueForCopy(v));
    if (!ok) return;
    setFlash(true);
    window.setTimeout(() => setFlash(false), 600);
  };
  // Click-to-copy must not block native text selection. If the user
  // has dragged a selection over part of the row, we skip the
  // auto-copy so Cmd-C still works on exactly that selection.
  const onClickRow = () => {
    const sel = window.getSelection?.()?.toString() ?? '';
    if (sel.trim().length > 0) return;
    doCopy();
  };
  return (
    <div
      className={`group flex items-start gap-2 py-0.5 pr-1 rounded transition-colors cursor-pointer ${
        flash ? '' : 'hover:bg-[color:var(--bg-hover)]'
      }`}
      style={{
        paddingLeft: depth * 14,
        background: flash ? 'var(--accent-fog, var(--bg-hover))' : undefined,
      }}
      onClick={onClickRow}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          doCopy();
        }
      }}
      aria-label="Click to copy value"
    >
      <span className="w-[10px] inline-block shrink-0" />
      {keyLabel !== null && (
        <span className="t-secondary shrink-0">
          {keyLabel}
          <span className="t-tertiary">:</span>
        </span>
      )}
      <span className="min-w-0 flex-1 break-all font-mono text-meta">
        <PrimitivePreview v={v} claim={inArray ? null : keyLabel} />
      </span>
      <span
        className={`shrink-0 transition-opacity ${
          flash ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <CopyValueButton value={v} />
      </span>
    </div>
  );
};

interface ContainerRowProps {
  v: unknown;
  effectiveValue: unknown;
  embedded: unknown | null;
  isArray: boolean;
  keyLabel: string | null;
  depth: number;
  open: boolean;
  setOpen: (cb: (o: boolean) => boolean) => void;
}

const ContainerRow = ({
  v,
  effectiveValue,
  embedded,
  isArray,
  keyLabel,
  depth,
  open,
  setOpen,
}: ContainerRowProps) => {
  const entries = isArray
    ? (effectiveValue as unknown[]).map((item, i) => [i, item] as const)
    : Object.entries(effectiveValue as Record<string, unknown>);
  const summary = isArray
    ? `[${entries.length}]`
    : `{${entries.length}}`;
  // For embedded-JSON strings the copy button hands back the *original*
  // string (so the user can paste it back into the token), but each
  // child still copies its natural decoded value.
  const copyTarget = embedded !== null ? v : effectiveValue;

  return (
    <div>
      <div
        className="group flex items-start gap-2 py-0.5 pr-1 rounded hover:bg-[color:var(--bg-hover)] cursor-pointer"
        style={{ paddingLeft: depth * 14 }}
        onClick={() => setOpen((o) => !o)}
        role="button"
        aria-expanded={open}
      >
        <span className="shrink-0 mt-[3px] t-tertiary">
          <Chevron open={open} />
        </span>
        {keyLabel !== null && (
          <span className="t-secondary shrink-0">
            {keyLabel}
            <span className="t-tertiary">:</span>
          </span>
        )}
        <span className="t-tertiary text-meta shrink-0">{summary}</span>
        {embedded !== null && (
          <span
            className="text-meta t-tertiary px-1.5 rounded shrink-0 border hair"
            title="String value containing embedded JSON"
          >
            json
          </span>
        )}
        <span className="flex-1" />
        <span
          className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <CopyValueButton value={copyTarget} />
        </span>
      </div>
      {open && (
        <div>
          {entries.map(([key, child]) => (
            <TreeNode
              key={String(key)}
              k={key}
              v={child}
              depth={depth + 1}
              inArray={isArray}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/// Render a parsed JSON value as a copy-each-value tree. Object keys
/// and primitive values both get their own hover-revealed copy
/// button; nested objects/arrays can be expanded to drill in.
export const JsonTree = ({ value }: { value: unknown }) => (
  <div className="font-mono text-meta">
    <TreeNode k={null} v={value as Json} depth={0} />
  </div>
);
