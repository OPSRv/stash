import { useState } from 'react';
import { IconButton } from '../../../../shared/ui/IconButton';
import { CopyIcon, CheckIcon } from '../../../../shared/ui/icons';
import { copyText } from '../../../../shared/util/clipboard';
import type { Json, JsonDiffNode, JsonStatus } from './diff';

/// Structural JSON diff renderer. Mirrors the JWT tool's JsonTree
/// affordances (click-to-copy values, hover copy button, expand/collapse)
/// but layers add/del/changed status colours on top, matched by key name
/// so reordered object members don't read as edits.

const STATUS_STYLE: Record<JsonStatus, { bar: string; bg?: string }> = {
  eq: { bar: 'transparent' },
  add: { bar: 'var(--color-success-fg)', bg: 'color-mix(in srgb, var(--color-success-fg) 12%, transparent)' },
  del: { bar: 'var(--color-danger-fg)', bg: 'color-mix(in srgb, var(--color-danger-fg) 12%, transparent)' },
  chg: { bar: 'var(--color-warning-fg)', bg: 'color-mix(in srgb, var(--color-warning-fg) 12%, transparent)' },
};

const SIGN: Record<JsonStatus, string> = { eq: '', add: '+', del: '−', chg: '~' };

const valueForCopy = (v: Json | undefined): string => {
  if (v === undefined || v === null) return v === null ? 'null' : '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v, null, 2);
};

const Primitive = ({ v, muted }: { v: Json | undefined; muted?: boolean }) => {
  if (v === undefined) return null;
  if (v === null) return <span className="t-tertiary italic">null</span>;
  if (typeof v === 'string') {
    return (
      <span className={muted ? 't-tertiary line-through break-all' : 'text-[color:var(--color-success-fg)] break-all'}>
        &quot;{v}&quot;
      </span>
    );
  }
  return (
    <span className={`tabular-nums ${muted ? 't-tertiary line-through' : 'text-[color:var(--color-warning-fg)]'}`}>
      {String(v)}
    </span>
  );
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
    style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 120ms ease' }}
  >
    <path d="M9 6l6 6-6 6" />
  </svg>
);

const CopyValueButton = ({ value }: { value: string }) => {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (!(await copyText(value))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <IconButton onClick={onCopy} title={copied ? 'Copied' : 'Copy value'} tooltipSide="left">
      {copied ? <CheckIcon /> : <CopyIcon />}
    </IconButton>
  );
};

const KeyLabel = ({ k }: { k: string | number | null }) =>
  k === null ? null : (
    <span className="t-secondary shrink-0">
      {String(k)}
      <span className="t-tertiary">:</span>
    </span>
  );

/// Status gutter bar — a coloured rail down the left of every non-equal
/// row, the same language the line-diff uses, so the eye reads structure
/// and edits identically across both views.
const rowStyle = (status: JsonStatus, depth: number) => ({
  paddingLeft: 8 + depth * 14,
  background: STATUS_STYLE[status].bg,
  boxShadow: status === 'eq' ? undefined : `inset 3px 0 0 0 ${STATUS_STYLE[status].bar}`,
});

const Node = ({ node, depth }: { node: JsonDiffNode; depth: number }) => {
  const [flash, setFlash] = useState(false);
  const isContainer = node.kind !== 'primitive';
  // Default-open the first two depths and anything that actually changed,
  // so a small edit deep in a large blob doesn't stay hidden.
  const [open, setOpen] = useState(depth < 2 || node.status !== 'eq');

  if (isContainer) {
    const raw = node.newRaw ?? node.oldRaw;
    const count = node.children?.length ?? 0;
    const summary = node.kind === 'array' ? `[${count}]` : `{${count}}`;
    return (
      <div>
        <div
          className="group flex items-center gap-2 py-0.5 pr-1 rounded cursor-pointer hover:bg-[color:var(--bg-hover)]"
          style={rowStyle(node.status, depth)}
          onClick={() => setOpen((o) => !o)}
          role="button"
          aria-expanded={open}
        >
          <span className="shrink-0 t-tertiary">
            <Chevron open={open} />
          </span>
          {node.status !== 'eq' && (
            <span className="shrink-0 font-mono text-meta" style={{ color: STATUS_STYLE[node.status].bar }}>
              {SIGN[node.status]}
            </span>
          )}
          <KeyLabel k={node.key} />
          <span className="t-tertiary text-meta shrink-0">{summary}</span>
          <span className="flex-1" />
          <span
            className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            <CopyValueButton value={valueForCopy(raw)} />
          </span>
        </div>
        {open && node.children && (
          <div>
            {node.children.map((c, i) => (
              <Node key={`${String(c.key)}-${i}`} node={c} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  // Primitive leaf — click row to copy the (new, or surviving) value.
  const copyVal = valueForCopy(node.status === 'del' ? node.oldVal : node.newVal);
  const onClickRow = () => {
    const sel = window.getSelection?.()?.toString() ?? '';
    if (sel.trim().length > 0) return;
    void copyText(copyVal).then((ok) => {
      if (!ok) return;
      setFlash(true);
      window.setTimeout(() => setFlash(false), 900);
    });
  };

  return (
    <div
      className="group relative flex items-center gap-2 py-0.5 pr-2 rounded cursor-pointer transition-colors hover:bg-[color:var(--bg-hover)]"
      style={rowStyle(node.status, depth)}
      onClick={onClickRow}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClickRow();
        }
      }}
      aria-label="Click to copy value"
    >
      <span className="w-[10px] inline-block shrink-0" />
      {node.status !== 'eq' && (
        <span className="shrink-0 font-mono text-meta" style={{ color: STATUS_STYLE[node.status].bar }}>
          {SIGN[node.status]}
        </span>
      )}
      <KeyLabel k={node.key} />
      <span className="min-w-0 flex-1 break-all font-mono text-meta">
        {node.status === 'chg' ? (
          <>
            <Primitive v={node.oldVal} muted />
            <span className="mx-1.5 t-tertiary">→</span>
            <Primitive v={node.newVal} />
          </>
        ) : (
          <Primitive v={node.status === 'del' ? node.oldVal : node.newVal} muted={node.status === 'del'} />
        )}
      </span>
      <span
        className={`shrink-0 text-meta px-1.5 py-0.5 rounded-md font-medium pointer-events-none transition-opacity duration-150 ${
          flash ? 'opacity-100' : 'opacity-0'
        }`}
        style={{ background: 'var(--accent-soft)', color: 'rgb(var(--stash-accent-rgb))' }}
        aria-live="polite"
      >
        Copied
      </span>
      <span
        className={`shrink-0 transition-opacity ${
          flash ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <CopyValueButton value={copyVal} />
      </span>
    </div>
  );
};

export const JsonTreeDiff = ({ root }: { root: JsonDiffNode }) => (
  <div className="font-mono text-meta py-1">
    <Node node={root} depth={0} />
  </div>
);
