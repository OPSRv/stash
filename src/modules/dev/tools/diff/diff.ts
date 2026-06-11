/// Pure diff engine for the Compare tool. No dependencies — a compact
/// LCS over lines (and over word/punctuation tokens for intra-line
/// highlighting) keeps the bundle lean in the spirit of the project's
/// "bundle-stub heavy deps" rule. Inputs in a dev tool are small enough
/// that the O(n·m) DP is never a concern.

export type LineType = 'eq' | 'del' | 'ins' | 'chg';

export interface LineOp {
  type: 'eq' | 'del' | 'ins';
  text: string;
  /// 1-based source line number on the A side (`null` for insertions).
  ai: number | null;
  /// 1-based source line number on the B side (`null` for deletions).
  bi: number | null;
}

export interface CompareOptions {
  /// Collapse runs of whitespace to a single space and trim ends before
  /// comparing. Display still uses the original text.
  ignoreWhitespace?: boolean;
  ignoreCase?: boolean;
}

/// Build the comparison key for a line/token. The original string is
/// always kept for rendering — only equality testing uses this.
const makeKey = (opts: CompareOptions) => (s: string): string => {
  let k = s;
  if (opts.ignoreWhitespace) k = k.replace(/\s+/g, ' ').trim();
  if (opts.ignoreCase) k = k.toLowerCase();
  return k;
};

/// Classic LCS table → backtrack into an ordered op list. Generic over
/// the unit (line or token) so both line- and word-diff reuse it.
function lcsOps<T>(
  a: readonly T[],
  b: readonly T[],
  key: (t: T) => string,
): Array<{ type: 'eq' | 'del' | 'ins'; a?: T; b?: T; ai?: number; bi?: number }> {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  const ka = a.map(key);
  const kb = b.map(key);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        ka[i] === kb[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Array<{
    type: 'eq' | 'del' | 'ins';
    a?: T;
    b?: T;
    ai?: number;
    bi?: number;
  }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) {
      out.push({ type: 'eq', a: a[i], b: b[j], ai: i, bi: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', a: a[i], ai: i });
      i++;
    } else {
      out.push({ type: 'ins', b: b[j], bi: j });
      j++;
    }
  }
  while (i < n) out.push({ type: 'del', a: a[i], ai: i++ });
  while (j < m) out.push({ type: 'ins', b: b[j], bi: j++ });
  return out;
}

/// Line-level diff. Returns ops in document order with 1-based source
/// line numbers so each side can render a gutter.
export function diffLines(
  aText: string,
  bText: string,
  opts: CompareOptions = {},
): LineOp[] {
  const a = aText.split('\n');
  const b = bText.split('\n');
  const key = makeKey(opts);
  return lcsOps(a, b, key).map((o) => {
    if (o.type === 'eq') {
      return { type: 'eq', text: o.a as string, ai: (o.ai ?? 0) + 1, bi: (o.bi ?? 0) + 1 };
    }
    if (o.type === 'del') {
      return { type: 'del', text: o.a as string, ai: (o.ai ?? 0) + 1, bi: null };
    }
    return { type: 'ins', text: o.b as string, ai: null, bi: (o.bi ?? 0) + 1 };
  });
}

// ── Split-view alignment ──────────────────────────────────────────────

export interface LineCell {
  no: number;
  text: string;
  type: LineType;
}

export interface SplitRow {
  left: LineCell | null;
  right: LineCell | null;
}

/// Fold the linear op list into aligned left/right rows. Consecutive
/// deletions paired with the following insertions become "changed" rows
/// (same row, both sides present) so word-level highlighting has a
/// counterpart to compare against; the unpaired remainder spills into
/// one-sided rows.
export function toSplitRows(ops: LineOp[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.type === 'eq') {
      rows.push({
        left: { no: op.ai!, text: op.text, type: 'eq' },
        right: { no: op.bi!, text: op.text, type: 'eq' },
      });
      i++;
      continue;
    }
    // Gather the contiguous run of deletions then insertions.
    const dels: LineOp[] = [];
    const inss: LineOp[] = [];
    while (i < ops.length && ops[i].type === 'del') dels.push(ops[i++]);
    while (i < ops.length && ops[i].type === 'ins') inss.push(ops[i++]);
    const pairs = Math.max(dels.length, inss.length);
    for (let p = 0; p < pairs; p++) {
      const d = dels[p];
      const s = inss[p];
      // Both present → a modified line (chg); otherwise a pure add/del.
      const paired = d && s;
      rows.push({
        left: d ? { no: d.ai!, text: d.text, type: paired ? 'chg' : 'del' } : null,
        right: s ? { no: s.bi!, text: s.text, type: paired ? 'chg' : 'ins' } : null,
      });
    }
  }
  return rows;
}

// ── Word/token level diff (intra-line highlight) ──────────────────────

export interface Seg {
  type: 'eq' | 'del' | 'ins';
  text: string;
}

/// Split into words, whitespace runs and single punctuation chars so a
/// rename like `brown` → `red` highlights only that token, and code
/// edits (`foo(bar)` → `foo(baz)`) stay granular.
const tokenize = (s: string): string[] => s.match(/\w+|\s+|[^\w\s]/g) ?? [];

/// Token diff for one changed line. `side` selects which segments to
/// keep: the left cell shows eq+del, the right shows eq+ins.
export function diffWords(
  aLine: string,
  bLine: string,
  opts: CompareOptions = {},
): { left: Seg[]; right: Seg[] } {
  const a = tokenize(aLine);
  const b = tokenize(bLine);
  const key = makeKey(opts);
  const ops = lcsOps(a, b, key);
  const left: Seg[] = [];
  const right: Seg[] = [];
  for (const o of ops) {
    if (o.type === 'eq') {
      left.push({ type: 'eq', text: o.a as string });
      right.push({ type: 'eq', text: o.b as string });
    } else if (o.type === 'del') {
      left.push({ type: 'del', text: o.a as string });
    } else {
      right.push({ type: 'ins', text: o.b as string });
    }
  }
  return { left, right };
}

// ── Stats ─────────────────────────────────────────────────────────────

export interface DiffStats {
  added: number;
  removed: number;
  changed: number;
}

export function statsFromRows(rows: SplitRow[]): DiffStats {
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const r of rows) {
    if (r.left?.type === 'chg' || r.right?.type === 'chg') {
      changed++;
      continue;
    }
    if (r.right?.type === 'ins') added++;
    if (r.left?.type === 'del') removed++;
  }
  return { added, removed, changed };
}

/// Plain unified-diff text for the "Copy diff" action. Equal lines get a
/// leading space, deletions `-`, insertions `+` — paste-ready into a
/// review comment.
export function unifiedText(ops: LineOp[]): string {
  return ops
    .map((o) => `${o.type === 'del' ? '-' : o.type === 'ins' ? '+' : ' '}${o.text}`)
    .join('\n');
}

// ── Content kind detection + JSON tree diff ───────────────────────────

export type Json =
  | null
  | string
  | number
  | boolean
  | Json[]
  | { [key: string]: Json };

export interface ParsedJson {
  ok: boolean;
  value?: Json;
}

export const tryParseJson = (s: string): ParsedJson => {
  const t = s.trim();
  if (!t) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(t) as Json };
  } catch {
    return { ok: false };
  }
};

/// Both sides must be valid JSON for the structural tree to make sense.
export function detectKind(a: string, b: string): 'json' | 'text' {
  return tryParseJson(a).ok && tryParseJson(b).ok ? 'json' : 'text';
}

export type JsonNodeKind = 'object' | 'array' | 'primitive';
export type JsonStatus = 'eq' | 'add' | 'del' | 'chg';

export interface JsonDiffNode {
  /// Object key or array index; `null` only for the root.
  key: string | number | null;
  kind: JsonNodeKind;
  status: JsonStatus;
  /// Present for primitives (and for changed primitives, both sides).
  oldVal?: Json;
  newVal?: Json;
  /// The value to drill into for containers (the surviving/new side).
  oldRaw?: Json;
  newRaw?: Json;
  children?: JsonDiffNode[];
}

const jsonKind = (v: Json): JsonNodeKind =>
  Array.isArray(v) ? 'array' : v !== null && typeof v === 'object' ? 'object' : 'primitive';

const MISSING = Symbol('missing');
type Maybe = Json | typeof MISSING;

const equalJson = (a: Json, b: Json): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/// Recursively diff two JSON values. Object members are matched by key
/// name (stable under reordering); arrays are matched positionally.
function diffNode(key: string | number | null, a: Maybe, b: Maybe): JsonDiffNode {
  // Presence on only one side → whole subtree added or removed.
  if (a === MISSING) {
    const bv = b as Json;
    return { key, kind: jsonKind(bv), status: 'add', newVal: bv, newRaw: bv };
  }
  if (b === MISSING) {
    const av = a as Json;
    return { key, kind: jsonKind(av), status: 'del', oldVal: av, oldRaw: av };
  }
  const av = a as Json;
  const bv = b as Json;
  const ak = jsonKind(av);
  const bk = jsonKind(bv);

  // Type changed (e.g. object → string) → treat as a changed leaf.
  if (ak !== bk) {
    return { key, kind: bk, status: 'chg', oldVal: av, newVal: bv, oldRaw: av, newRaw: bv };
  }

  if (ak === 'primitive') {
    const same = equalJson(av, bv);
    return {
      key,
      kind: 'primitive',
      status: same ? 'eq' : 'chg',
      oldVal: av,
      newVal: bv,
    };
  }

  if (ak === 'array') {
    const aa = av as Json[];
    const ba = bv as Json[];
    const len = Math.max(aa.length, ba.length);
    const children: JsonDiffNode[] = [];
    for (let idx = 0; idx < len; idx++) {
      const ae: Maybe = idx < aa.length ? aa[idx] : MISSING;
      const be: Maybe = idx < ba.length ? ba[idx] : MISSING;
      children.push(diffNode(idx, ae, be));
    }
    const status: JsonStatus = equalJson(av, bv) ? 'eq' : 'chg';
    return { key, kind: 'array', status, oldRaw: av, newRaw: bv, children };
  }

  // Object: union of keys, A order first then B-only keys appended.
  const ao = av as { [k: string]: Json };
  const bo = bv as { [k: string]: Json };
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const k of Object.keys(ao)) {
    keys.push(k);
    seen.add(k);
  }
  for (const k of Object.keys(bo)) if (!seen.has(k)) keys.push(k);
  const children: JsonDiffNode[] = keys.map((k) =>
    diffNode(k, k in ao ? ao[k] : MISSING, k in bo ? bo[k] : MISSING),
  );
  const status: JsonStatus = equalJson(av, bv) ? 'eq' : 'chg';
  return { key, kind: 'object', status, oldRaw: av, newRaw: bv, children };
}

export function diffJson(a: Json, b: Json): JsonDiffNode {
  return diffNode(null, a, b);
}
