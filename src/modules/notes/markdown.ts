// Tiny, purpose-built markdown renderer. Handles the subset a note editor
// needs: headings, lists, checklists, blockquotes, fenced code, inline code,
// bold/italic, links. Everything else falls through as plain text. Kept in
// plain TS (no JSX) so it can be imported by tests.

export type Inline =
  | { kind: 'text'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'italic'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'link'; value: string; href: string };

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; inline: Inline[] }
  | { kind: 'paragraph'; inline: Inline[] }
  | { kind: 'blockquote'; inline: Inline[] }
  | { kind: 'code'; value: string }
  | { kind: 'hr' }
  | {
      kind: 'list';
      ordered: boolean;
      items: { inline: Inline[]; checked: boolean | null; line: number }[];
    };

const INLINE_PATTERNS: Array<{
  re: RegExp;
  build: (m: RegExpExecArray) => Inline;
}> = [
  { re: /\*\*([^*]+)\*\*/, build: (m) => ({ kind: 'bold', value: m[1] }) },
  { re: /__([^_]+)__/, build: (m) => ({ kind: 'bold', value: m[1] }) },
  { re: /\*([^*]+)\*/, build: (m) => ({ kind: 'italic', value: m[1] }) },
  { re: /_([^_]+)_/, build: (m) => ({ kind: 'italic', value: m[1] }) },
  { re: /`([^`]+)`/, build: (m) => ({ kind: 'code', value: m[1] }) },
  {
    re: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/,
    build: (m) => ({ kind: 'link', value: m[1], href: m[2] }),
  },
];

export const parseInline = (raw: string): Inline[] => {
  const out: Inline[] = [];
  let rest = raw;
  // Greedy-earliest match loop. Each step picks the pattern whose next
  // occurrence starts earliest; everything before it becomes a text node.
  while (rest.length > 0) {
    let bestIndex = Infinity;
    let bestMatch: RegExpExecArray | null = null;
    let bestPattern: (typeof INLINE_PATTERNS)[number] | null = null;
    for (const p of INLINE_PATTERNS) {
      const m = p.re.exec(rest);
      if (m && m.index < bestIndex) {
        bestIndex = m.index;
        bestMatch = m;
        bestPattern = p;
      }
    }
    if (!bestMatch || !bestPattern) {
      out.push({ kind: 'text', value: rest });
      break;
    }
    if (bestMatch.index > 0) {
      out.push({ kind: 'text', value: rest.slice(0, bestMatch.index) });
    }
    out.push(bestPattern.build(bestMatch));
    rest = rest.slice(bestMatch.index + bestMatch[0].length);
  }
  return out;
};

export const parseBlocks = (source: string): Block[] => {
  const lines = source.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.trimEnd();

    // Fenced code block.
    if (/^```/.test(stripped)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // consume closing fence
      blocks.push({ kind: 'code', value: body.join('\n') });
      continue;
    }

    // Horizontal rule.
    if (/^-{3,}\s*$/.test(stripped) || /^\*{3,}\s*$/.test(stripped)) {
      blocks.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    // Heading.
    const h = /^(#{1,3})\s+(.*)$/.exec(stripped);
    if (h) {
      blocks.push({
        kind: 'heading',
        level: h[1].length as 1 | 2 | 3,
        inline: parseInline(h[2]),
      });
      i += 1;
      continue;
    }

    // Blockquote.
    if (/^>\s?/.test(stripped)) {
      blocks.push({
        kind: 'blockquote',
        inline: parseInline(stripped.replace(/^>\s?/, '')),
      });
      i += 1;
      continue;
    }

    // List (unordered, ordered, or checklist).
    const listRe = /^\s*([-*+]|\d+\.)\s+(.*)$/;
    if (listRe.test(stripped)) {
      const items: { inline: Inline[]; checked: boolean | null; line: number }[] = [];
      const ordered = /^\s*\d+\.\s+/.test(stripped);
      while (i < lines.length) {
        const m = listRe.exec(lines[i]);
        if (!m) break;
        const rest = m[2];
        const checkbox = /^\[( |x|X)\]\s+(.*)$/.exec(rest);
        if (checkbox) {
          items.push({
            inline: parseInline(checkbox[2]),
            checked: checkbox[1].toLowerCase() === 'x',
            line: i,
          });
        } else {
          items.push({ inline: parseInline(rest), checked: null, line: i });
        }
        i += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    // Blank line.
    if (stripped === '') {
      i += 1;
      continue;
    }

    // Paragraph — accumulate until blank or new block-level construct.
    const paragraph: string[] = [stripped];
    i += 1;
    while (i < lines.length) {
      const next = lines[i].trimEnd();
      if (
        next === '' ||
        /^#{1,3}\s+/.test(next) ||
        /^```/.test(next) ||
        /^>\s?/.test(next) ||
        /^\s*([-*+]|\d+\.)\s+/.test(next) ||
        /^-{3,}\s*$/.test(next)
      ) {
        break;
      }
      paragraph.push(next);
      i += 1;
    }
    blocks.push({
      kind: 'paragraph',
      inline: parseInline(paragraph.join(' ')),
    });
  }
  return blocks;
};

/// Toggle a checkbox on a given source line. Returns the updated source, or
/// the original if the line does not contain a checklist marker.
export const toggleCheckboxAtLine = (source: string, line: number): string => {
  const lines = source.split('\n');
  if (line < 0 || line >= lines.length) return source;
  const re = /^(\s*([-*+]|\d+\.)\s+)\[( |x|X)\](\s+.*)$/;
  const m = re.exec(lines[line]);
  if (!m) return source;
  const next = m[3] === ' ' ? 'x' : ' ';
  lines[line] = `${m[1]}[${next}]${m[4]}`;
  return lines.join('\n');
};
