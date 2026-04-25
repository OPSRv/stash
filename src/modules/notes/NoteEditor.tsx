import { useCallback, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { IconButton } from '../../shared/ui/IconButton';
import { Spinner } from '../../shared/ui/Spinner';
import { Textarea } from '../../shared/ui/Textarea';
import {
  BoldIcon,
  BulletListIcon,
  ChecklistIcon,
  CodeBlockIcon,
  CodeIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  HorizontalRuleIcon,
  ItalicIcon,
  LinkIcon,
  OrderedListIcon,
  QuoteIcon,
  StrikethroughIcon,
  TableIcon,
  TranslateIcon,
} from '../../shared/ui/icons';
import { translateForNote } from './noteTranslate';

export type NotesViewMode = 'edit' | 'split' | 'preview';

type Props = {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  /** Called after a translation lands so the parent can surface a toast. */
  onTranslateResult?: (result: { ok: boolean; message?: string }) => void;
  /** ISO target language for the Translate button. Defaults to Ukrainian. */
  translateTarget?: string;
  /** Called when the user presses ⌘Z — delegate to the parent's undo stack. */
  onUndo?: () => void;
  /** Called when the user presses ⌘⇧Z — delegate to the parent's redo stack. */
  onRedo?: () => void;
};

type Action =
  | { kind: 'wrap'; before: string; after: string; placeholder: string }
  | { kind: 'line-prefix'; prefix: string }
  | { kind: 'insert-block'; block: string }
  | { kind: 'link'; url: string; placeholder: string };

const wrap = (before: string, after: string, placeholder: string): Action => ({
  kind: 'wrap',
  before,
  after,
  placeholder,
});

const linePrefix = (prefix: string): Action => ({ kind: 'line-prefix', prefix });

const insertBlock = (block: string): Action => ({ kind: 'insert-block', block });

const linkAction = (url: string, placeholder = 'link text'): Action => ({
  kind: 'link',
  url,
  placeholder,
});

/** Markdown table starter — 3 columns, 2 body rows. Users usually edit the
 *  headers first, so the cursor lands on the first cell. */
const TABLE_TEMPLATE =
  '| Column 1 | Column 2 | Column 3 |\n' +
  '| --- | --- | --- |\n' +
  '|  |  |  |\n' +
  '|  |  |  |\n';

/** Pad `before`/`after` with blank-line separators so an inserted block
 *  ends up on its own paragraph regardless of the surrounding text. */
const framedInsertion = (
  source: string,
  at: number,
  block: string
): { next: string; selStart: number; selEnd: number } => {
  const clamped = Math.max(0, Math.min(at, source.length));
  const before = source.slice(0, clamped);
  const after = source.slice(clamped);
  const beforeNl = before.length === 0 || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const afterNl = after.length === 0 || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const composed = `${before}${beforeNl}${block}${afterNl}${after}`;
  const cursor = before.length + beforeNl.length + block.length;
  return { next: composed, selStart: cursor, selEnd: cursor };
};

const applyAction = (
  el: HTMLTextAreaElement,
  source: string,
  action: Action,
): { next: string; selStart: number; selEnd: number } => {
  const { selectionStart, selectionEnd } = el;
  if (action.kind === 'wrap') {
    const selected = source.slice(selectionStart, selectionEnd);
    const middle = selected || action.placeholder;
    const next =
      source.slice(0, selectionStart) +
      action.before +
      middle +
      action.after +
      source.slice(selectionEnd);
    const newStart = selectionStart + action.before.length;
    const newEnd = newStart + middle.length;
    return { next, selStart: newStart, selEnd: newEnd };
  }
  if (action.kind === 'insert-block') {
    return framedInsertion(source, selectionEnd, action.block);
  }
  if (action.kind === 'link') {
    // If text is selected, use it as the link label; otherwise drop in a
    // placeholder that's pre-selected so the user can type the label.
    const selected = source.slice(selectionStart, selectionEnd);
    const label = selected || action.placeholder;
    const urlHref = action.url.trim() || 'https://';
    const snippet = `[${label}](${urlHref})`;
    const next = source.slice(0, selectionStart) + snippet + source.slice(selectionEnd);
    const labelStart = selectionStart + 1;
    const labelEnd = labelStart + label.length;
    return { next, selStart: labelStart, selEnd: labelEnd };
  }
  const lineStart = source.lastIndexOf('\n', selectionStart - 1) + 1;
  const endBoundary = source.indexOf('\n', selectionEnd);
  const lineEnd = endBoundary === -1 ? source.length : endBoundary;
  const slab = source.slice(lineStart, lineEnd);
  // Matches any list prefix so clicking a list button on a line that already
  // has a DIFFERENT list type replaces the marker rather than prepending to it.
  const anyListPrefixRe = /^(\s*)(- \[ \] |- \[x\] |- |\* |\d+\. )/i;
  // For ordered prefixes (`1. `) accept any `\d+. ` as "already has it".
  const isOrdered = /^\d+\. $/.test(action.prefix);
  const hasPrefix = (l: string) => isOrdered ? /^\d+\. /.test(l) : l.startsWith(action.prefix);
  const lines = slab.split('\n');
  const allHave = lines.every(hasPrefix);
  const updatedLines = lines.map((line) => {
    if (allHave) {
      const m = anyListPrefixRe.exec(line);
      return m ? m[1] + line.slice(m[0].length) : line;
    }
    if (hasPrefix(line)) return line;
    const m = anyListPrefixRe.exec(line);
    if (m) return m[1] + action.prefix + line.slice(m[0].length);
    return action.prefix + line;
  });
  const updated = updatedLines.join('\n');
  const next = source.slice(0, lineStart) + updated + source.slice(lineEnd);
  const delta = updated.length - slab.length;
  const firstLineDelta = updatedLines[0].length - lines[0].length;
  return {
    next,
    selStart: Math.max(lineStart, selectionStart + firstLineDelta),
    selEnd: selectionEnd + delta,
  };
};

/** Two-space indent/outdent across the selected lines. Textareas normally
 *  consume Tab to advance focus — we intercept it so list bullets nest
 *  without the user fighting the keyboard. */
const indentLines = (
  el: HTMLTextAreaElement,
  source: string,
  outdent: boolean
): { next: string; selStart: number; selEnd: number } => {
  const { selectionStart, selectionEnd } = el;
  const lineStart = source.lastIndexOf('\n', selectionStart - 1) + 1;
  const endBoundary = source.indexOf('\n', selectionEnd === selectionStart ? selectionEnd : selectionEnd - 1);
  const lineEnd = endBoundary === -1 ? source.length : endBoundary;
  const slab = source.slice(lineStart, lineEnd);
  const lines = slab.split('\n');
  let firstDelta = 0;
  let totalDelta = 0;
  const updated = lines
    .map((line, i) => {
      if (outdent) {
        const m = /^( {1,2}|\t)/.exec(line);
        if (!m) return line;
        const removed = m[0].length;
        if (i === 0) firstDelta = -removed;
        totalDelta -= removed;
        return line.slice(removed);
      }
      if (i === 0) firstDelta = 2;
      totalDelta += 2;
      return '  ' + line;
    })
    .join('\n');
  const next = source.slice(0, lineStart) + updated + source.slice(lineEnd);
  return {
    next,
    selStart: Math.max(lineStart, selectionStart + firstDelta),
    selEnd: selectionEnd + totalDelta,
  };
};

export const NoteEditor = ({
  value,
  onChange,
  placeholder,
  textareaRef,
  onTranslateResult,
  translateTarget = 'uk',
  onUndo,
  onRedo,
}: Props) => {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const ref = textareaRef ?? localRef;
  const [translating, setTranslating] = useState(false);

  const translate = useCallback(async () => {
    const el = ref.current;
    if (!el || translating) return;
    const { selectionStart, selectionEnd } = el;
    setTranslating(true);
    try {
      const out = await translateForNote(
        value,
        selectionStart,
        selectionEnd,
        translateTarget,
      );
      if (out.kind === 'ok') {
        onChange(out.edit.insertion.next);
        const { selStart, selEnd } = out.edit.insertion;
        requestAnimationFrame(() => {
          el.focus();
          el.setSelectionRange(selStart, selEnd);
        });
        onTranslateResult?.({ ok: true });
      } else {
        onTranslateResult?.({
          ok: false,
          message: out.kind === 'error' ? out.message : out.reason,
        });
      }
    } finally {
      setTranslating(false);
    }
  }, [ref, translating, value, onChange, translateTarget, onTranslateResult]);

  const run = useCallback(
    (action: Action) => {
      const el = ref.current;
      if (!el) return;
      const { next, selStart, selEnd } = applyAction(el, value, action);
      onChange(next);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(selStart, selEnd);
      });
    },
    [ref, value, onChange],
  );

  /** Prompt for a URL and wrap the selection (or a placeholder label) in
   *  `[label](url)`. `window.prompt` is the pragmatic choice — a modal dialog
   *  adds UI weight disproportionate to the feature, and prompts live
   *  outside the editor focus so nothing steals the selection away. */
  const insertLink = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const url = window.prompt('Link URL:', 'https://');
    if (url == null) return;
    run(linkAction(url));
  }, [ref, run]);

  const indent = useCallback(
    (outdent: boolean) => {
      const el = ref.current;
      if (!el) return;
      const { next, selStart, selEnd } = indentLines(el, value, outdent);
      if (next === value) return;
      onChange(next);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(selStart, selEnd);
      });
    },
    [ref, value, onChange]
  );

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.metaKey || e.ctrlKey) {
      const key = e.key.toLowerCase();
      if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) onRedo?.();
        else onUndo?.();
        return;
      }
      if (key === 'b') {
        e.preventDefault();
        run(wrap('**', '**', 'bold'));
        return;
      }
      if (key === 'i') {
        e.preventDefault();
        run(wrap('*', '*', 'italic'));
        return;
      }
      if (e.shiftKey && key === 'x') {
        e.preventDefault();
        run(wrap('~~', '~~', 'strikethrough'));
        return;
      }
      if (key === 'k') {
        e.preventDefault();
        insertLink();
        return;
      }
      if (e.shiftKey && key === 'c') {
        e.preventDefault();
        run(linePrefix('- [ ] '));
        return;
      }
      if (key === 'l') {
        e.preventDefault();
        run(linePrefix('- '));
        return;
      }
    }

    // Tab / Shift-Tab: indent (or outdent) the selected lines with two
    // spaces — the canonical way markdown parsers read nested lists.
    if (e.key === 'Tab') {
      e.preventDefault();
      indent(e.shiftKey);
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      const el = ref.current;
      if (!el) return;
      const { selectionStart } = el;
      if (selectionStart !== el.selectionEnd) return;
      const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
      const currentLine = value.slice(lineStart, selectionStart);
      const match = /^(\s*)(- \[ \] |- \[x\] |- |\* |\d+\. )/i.exec(currentLine);
      if (!match) return;
      const rest = currentLine.slice(match[0].length);
      if (rest.length === 0) {
        e.preventDefault();
        const next =
          value.slice(0, lineStart) + value.slice(lineStart + currentLine.length);
        onChange(next);
        requestAnimationFrame(() => {
          el.focus();
          el.setSelectionRange(lineStart, lineStart);
        });
        return;
      }
      e.preventDefault();
      let prefix = match[0];
      const ordered = /^(\s*)(\d+)\.\s$/.exec(prefix);
      if (ordered) {
        const n = Number(ordered[2]) + 1;
        prefix = `${ordered[1]}${n}. `;
      } else {
        prefix = prefix.replace('[x]', '[ ]').replace('[X]', '[ ]');
      }
      const insertion = `\n${prefix}`;
      const next =
        value.slice(0, selectionStart) + insertion + value.slice(el.selectionEnd);
      onChange(next);
      const cursor = selectionStart + insertion.length;
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(cursor, cursor);
      });
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-5 py-2 flex items-center gap-2 border-b hair">
        <div
          className="flex flex-wrap items-center gap-y-1 gap-x-0.5 min-w-0"
          role="toolbar"
          aria-label="Markdown formatting"
        >
          <IconButton onClick={() => run(linePrefix('# '))} title="Heading 1" stopPropagation={false}>
            <Heading1Icon />
          </IconButton>
          <IconButton onClick={() => run(linePrefix('## '))} title="Heading 2" stopPropagation={false}>
            <Heading2Icon />
          </IconButton>
          <IconButton onClick={() => run(linePrefix('### '))} title="Heading 3" stopPropagation={false}>
            <Heading3Icon />
          </IconButton>
          <div className="w-px h-4 bg-white/10 mx-1" />
          <IconButton onClick={() => run(wrap('**', '**', 'bold'))} title="Bold (⌘B)" stopPropagation={false}>
            <BoldIcon />
          </IconButton>
          <IconButton onClick={() => run(wrap('*', '*', 'italic'))} title="Italic (⌘I)" stopPropagation={false}>
            <ItalicIcon />
          </IconButton>
          <IconButton onClick={() => run(wrap('~~', '~~', 'strikethrough'))} title="Strikethrough (⇧⌘X)" stopPropagation={false}>
            <StrikethroughIcon />
          </IconButton>
          <IconButton onClick={() => run(wrap('`', '`', 'code'))} title="Inline code" stopPropagation={false}>
            <CodeIcon size={12} />
          </IconButton>
          <IconButton onClick={() => run(wrap('\n```\n', '\n```\n', 'code block'))} title="Code block" stopPropagation={false}>
            <CodeBlockIcon size={12} />
          </IconButton>
          <IconButton onClick={insertLink} title="Link (⌘K)" stopPropagation={false}>
            <LinkIcon size={12} />
          </IconButton>
          <div className="w-px h-4 bg-white/10 mx-1" />
          <IconButton onClick={() => run(linePrefix('- '))} title="Bulleted list (⌘L)" stopPropagation={false}>
            <BulletListIcon />
          </IconButton>
          <IconButton onClick={() => run(linePrefix('1. '))} title="Numbered list" stopPropagation={false}>
            <OrderedListIcon />
          </IconButton>
          <IconButton onClick={() => run(linePrefix('- [ ] '))} title="Checklist (⇧⌘C)" stopPropagation={false}>
            <ChecklistIcon />
          </IconButton>
          <IconButton onClick={() => run(linePrefix('> '))} title="Quote" stopPropagation={false}>
            <QuoteIcon />
          </IconButton>
          <div className="w-px h-4 bg-white/10 mx-1" />
          <IconButton onClick={() => run(insertBlock('---'))} title="Horizontal rule" stopPropagation={false}>
            <HorizontalRuleIcon />
          </IconButton>
          <IconButton onClick={() => run(insertBlock(TABLE_TEMPLATE.trimEnd()))} title="Table" stopPropagation={false}>
            <TableIcon />
          </IconButton>
          <div className="w-px h-4 bg-white/10 mx-1" />
          <IconButton
            onClick={translate}
            title={`Translate to ${translateTarget.toUpperCase()} — selection if any, else whole note`}
            stopPropagation={false}
            disabled={translating || value.trim().length === 0}
          >
            {translating ? <Spinner size={12} /> : <TranslateIcon size={13} />}
          </IconButton>
        </div>
      </div>
      <Textarea
        bare
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="flex-1 resize-none px-5 py-5 t-primary text-body font-mono leading-relaxed min-h-0"
        spellCheck={false}
      />
    </div>
  );
};
