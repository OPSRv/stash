import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Button } from '../../../../shared/ui/Button';
import { IconButton } from '../../../../shared/ui/IconButton';
import { SegmentedControl } from '../../../../shared/ui/SegmentedControl';
import { Textarea } from '../../../../shared/ui/Textarea';
import { CopyIcon, CheckIcon } from '../../../../shared/ui/icons';
import { copyText } from '../../../../shared/util/clipboard';
import { JsonTreeDiff } from './JsonTreeDiff';
import {
  type CompareOptions,
  type LineCell,
  type Seg,
  type SplitRow,
  detectKind,
  diffJson,
  diffLines,
  diffWords,
  statsFromRows,
  toSplitRows,
  tryParseJson,
  unifiedText,
} from './diff';

type View = 'tree' | 'split' | 'unified';

const prettyJson = (s: string): string => {
  const parsed = tryParseJson(s);
  return parsed.ok ? JSON.stringify(parsed.value, null, 2) : s;
};

// ── Line rendering ────────────────────────────────────────────────────

const CELL_BG: Record<LineCell['type'], string | undefined> = {
  eq: undefined,
  del: 'color-mix(in srgb, var(--color-danger-fg) 10%, transparent)',
  ins: 'color-mix(in srgb, var(--color-success-fg) 10%, transparent)',
  chg: 'color-mix(in srgb, var(--color-warning-fg) 10%, transparent)',
};

/// Token background for the word-level highlight — a touch stronger than
/// the line tint so the changed span pops within an already-tinted line.
const SEG_BG: Record<Seg['type'], string | undefined> = {
  eq: undefined,
  del: 'color-mix(in srgb, var(--color-danger-fg) 30%, transparent)',
  ins: 'color-mix(in srgb, var(--color-success-fg) 30%, transparent)',
};

const SegRun = ({ segs }: { segs: Seg[] }) => (
  <>
    {segs.map((s, i) => (
      <span
        key={i}
        style={s.type === 'eq' ? undefined : { background: SEG_BG[s.type], borderRadius: 2 }}
      >
        {s.text}
      </span>
    ))}
  </>
);

/// Click-to-copy line body that never steals an active text selection
/// (so Cmd-C on a manual selection still wins).
const useLineCopy = (text: string) => {
  const [flash, setFlash] = useState(false);
  const onClick = () => {
    const sel = window.getSelection?.()?.toString() ?? '';
    if (sel.trim().length > 0) return;
    void copyText(text).then((ok) => {
      if (!ok) return;
      setFlash(true);
      window.setTimeout(() => setFlash(false), 600);
    });
  };
  return { flash, onClick };
};

const Gutter = ({ no, sign }: { no: number | null; sign?: string }) => (
  <span
    className="select-none shrink-0 text-right tabular-nums t-tertiary"
    style={{ width: 36, paddingRight: 8 }}
    aria-hidden
  >
    {sign ? <span className="mr-0.5">{sign}</span> : null}
    {no ?? ''}
  </span>
);

const LineCellView = ({
  cell,
  segs,
  sign,
}: {
  cell: LineCell | null;
  segs?: Seg[];
  sign?: string;
}) => {
  const { flash, onClick } = useLineCopy(cell?.text ?? '');
  if (!cell) {
    return <div className="min-w-0" style={{ background: 'var(--bg-pane)' }} />;
  }
  return (
    <div
      className="group flex items-start gap-1 px-2 cursor-pointer hover:brightness-110"
      style={{ background: flash ? 'var(--accent-soft)' : CELL_BG[cell.type] }}
      onClick={onClick}
      title="Click to copy line"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <Gutter no={cell.no} sign={sign} />
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">
        {segs ? <SegRun segs={segs} /> : cell.text === '' ? ' ' : cell.text}
      </span>
    </div>
  );
};

const SplitView = ({ rows, opts }: { rows: SplitRow[]; opts: CompareOptions }) => (
  <div className="font-mono text-meta leading-relaxed">
    {rows.map((row, i) => {
      const chg = row.left?.type === 'chg' && row.right?.type === 'chg';
      const words = chg ? diffWords(row.left!.text, row.right!.text, opts) : null;
      return (
        <div key={i} className="grid" style={{ gridTemplateColumns: '1fr 1fr', columnGap: 1 }}>
          <LineCellView cell={row.left} segs={words?.left} />
          <LineCellView cell={row.right} segs={words?.right} />
        </div>
      );
    })}
  </div>
);

const UnifiedView = ({ rows, opts }: { rows: SplitRow[]; opts: CompareOptions }) => (
  <div className="font-mono text-meta leading-relaxed">
    {rows.flatMap((row, i) => {
      if (row.left?.type === 'eq' && row.right) {
        return [<LineCellView key={`e${i}`} cell={row.left} sign=" " />];
      }
      const chg = row.left?.type === 'chg' && row.right?.type === 'chg';
      const words = chg ? diffWords(row.left!.text, row.right!.text, opts) : null;
      const out: ReactElement[] = [];
      if (row.left) out.push(<LineCellView key={`d${i}`} cell={row.left} segs={words?.left} sign="−" />);
      if (row.right) out.push(<LineCellView key={`i${i}`} cell={row.right} segs={words?.right} sign="+" />);
      return out;
    })}
  </div>
);

// ── Toolbar bits ──────────────────────────────────────────────────────

const SwapIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M7 4 L3 8 L7 12" />
    <path d="M3 8 H21" />
    <path d="M17 20 L21 16 L17 12" />
    <path d="M21 16 H3" />
  </svg>
);

const Toggle = ({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: ReactNode; title: string }) => (
  <Button
    size="xs"
    variant={on ? 'soft' : 'ghost'}
    tone={on ? 'accent' : 'neutral'}
    onClick={onClick}
    title={title}
    aria-pressed={on}
  >
    {children}
  </Button>
);

const CopyButton = ({ text, label }: { text: string; label: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={!text}
      leadingIcon={copied ? <CheckIcon /> : <CopyIcon />}
      onClick={async () => {
        if (!(await copyText(text))) return;
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  );
};

// ── Inputs ────────────────────────────────────────────────────────────

const InputPanes = ({
  a,
  b,
  onA,
  onB,
  onSwap,
}: {
  a: string;
  b: string;
  onA: (v: string) => void;
  onB: (v: string) => void;
  onSwap: () => void;
}) => (
  <div className="grid items-stretch gap-2 shrink-0" style={{ gridTemplateColumns: '1fr auto 1fr', height: 120 }}>
    <Textarea
      value={a}
      onChange={(e) => onA(e.target.value)}
      placeholder="Original (A)…"
      spellCheck={false}
      className="h-full resize-none font-mono text-meta"
    />
    <div className="flex items-center">
      <IconButton onClick={onSwap} title="Swap A ↔ B" disabled={!a && !b}>
        <SwapIcon />
      </IconButton>
    </div>
    <Textarea
      value={b}
      onChange={(e) => onB(e.target.value)}
      placeholder="Changed (B)…"
      spellCheck={false}
      className="h-full resize-none font-mono text-meta"
    />
  </div>
);

// ── Main ──────────────────────────────────────────────────────────────

export function DiffTool() {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [view, setView] = useState<View>('split');
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [ignoreCase, setIgnoreCase] = useState(false);
  const [inputsOpen, setInputsOpen] = useState(true);

  const opts: CompareOptions = { ignoreWhitespace, ignoreCase };
  const both = a.trim() !== '' && b.trim() !== '';
  const kind = useMemo(() => (both ? detectKind(a, b) : 'text'), [a, b, both]);

  // For JSON, normalise formatting before the line diff so indentation /
  // key-spacing noise doesn't drown the real changes.
  const aText = kind === 'json' ? prettyJson(a) : a;
  const bText = kind === 'json' ? prettyJson(b) : b;

  const { rows, stats, unified } = useMemo(() => {
    if (!both) return { rows: [] as SplitRow[], stats: { added: 0, removed: 0, changed: 0 }, unified: '' };
    const ops = diffLines(aText, bText, opts);
    const r = toSplitRows(ops);
    return { rows: r, stats: statsFromRows(r), unified: unifiedText(ops) };
  }, [aText, bText, both, ignoreWhitespace, ignoreCase]);

  const jsonRoot = useMemo(() => {
    if (kind !== 'json' || view !== 'tree') return null;
    const pa = tryParseJson(a);
    const pb = tryParseJson(b);
    if (!pa.ok || !pb.ok) return null;
    return diffJson(pa.value!, pb.value!);
  }, [a, b, kind, view]);

  // Tree only exists for JSON; fall back to split when the inputs stop
  // being valid JSON while the user is mid-edit.
  const effectiveView: View = view === 'tree' && kind !== 'json' ? 'split' : view;

  const viewOptions =
    kind === 'json'
      ? ([
          { value: 'tree', label: 'Tree' },
          { value: 'split', label: 'Split' },
          { value: 'unified', label: 'Unified' },
        ] as const)
      : ([
          { value: 'split', label: 'Split' },
          { value: 'unified', label: 'Unified' },
        ] as const);

  const swap = () => {
    setA(b);
    setB(a);
  };

  return (
    <div className="flex h-full flex-col min-h-0 gap-2 p-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 shrink-0">
        <SegmentedControl
          size="sm"
          options={viewOptions as ReadonlyArray<{ value: View; label: string }>}
          value={effectiveView}
          onChange={(v) => setView(v)}
          ariaLabel="Diff view"
        />
        {kind === 'json' && (
          <span className="text-meta px-1.5 py-0.5 rounded border hair t-tertiary" title="Both inputs parsed as JSON">
            JSON
          </span>
        )}
        <Toggle on={ignoreWhitespace} onClick={() => setIgnoreWhitespace((v) => !v)} title="Ignore whitespace differences">
          Ignore WS
        </Toggle>
        <Toggle on={ignoreCase} onClick={() => setIgnoreCase((v) => !v)} title="Ignore case differences">
          Ignore case
        </Toggle>

        <span className="flex-1" />

        {both && (
          <span className="font-mono text-meta tabular-nums flex items-center gap-2" aria-label="diff stats">
            <span style={{ color: 'var(--color-success-fg)' }}>+{stats.added}</span>
            <span style={{ color: 'var(--color-danger-fg)' }}>−{stats.removed}</span>
            <span style={{ color: 'var(--color-warning-fg)' }}>~{stats.changed}</span>
          </span>
        )}
        <CopyButton text={unified} label="Copy diff" />
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setInputsOpen((v) => !v)}
          title={inputsOpen ? 'Hide input panes' : 'Show input panes'}
        >
          {inputsOpen ? 'Hide inputs' : 'Edit'}
        </Button>
      </div>

      {/* Inputs */}
      {inputsOpen && <InputPanes a={a} b={b} onA={setA} onB={setB} onSwap={swap} />}

      {/* Result */}
      <div
        className="flex-1 min-h-0 overflow-auto nice-scroll rounded-lg border hair"
        style={{ background: 'var(--bg-pane)' }}
      >
        {!both ? (
          <div className="h-full flex items-center justify-center text-center t-tertiary text-meta p-6">
            <span>
              Paste text in both panes to compare.
              <br />
              <span className="block mt-2 t-secondary">
                Valid JSON on both sides unlocks the structural Tree view. Click any line to copy it.
              </span>
            </span>
          </div>
        ) : effectiveView === 'tree' && jsonRoot ? (
          <JsonTreeDiff root={jsonRoot} />
        ) : effectiveView === 'unified' ? (
          <UnifiedView rows={rows} opts={opts} />
        ) : (
          <>
            {/* Sticky A / B header with whole-content copy. */}
            <div
              className="sticky top-0 z-10 grid text-meta t-tertiary uppercase tracking-wider border-b hair"
              style={{ gridTemplateColumns: '1fr 1fr', columnGap: 1, background: 'var(--bg-elev)' }}
            >
              <div className="flex items-center justify-between px-2 py-1">
                <span>A · original</span>
                <CopyButton text={aText} label="Copy" />
              </div>
              <div className="flex items-center justify-between px-2 py-1">
                <span>B · changed</span>
                <CopyButton text={bText} label="Copy" />
              </div>
            </div>
            <SplitView rows={rows} opts={opts} />
          </>
        )}
      </div>
    </div>
  );
}

export default DiffTool;
