import { useCallback, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { IconButton } from '../../shared/ui/IconButton';
import { Spinner } from '../../shared/ui/Spinner';
import {
  BoldIcon,
  BulletListIcon,
  ChecklistIcon,
  CodeBlockIcon,
  CodeIcon,
  Heading1Icon,
  Heading2Icon,
  ItalicIcon,
  OrderedListIcon,
  QuoteIcon,
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
};

type Action =
  | { kind: 'wrap'; before: string; after: string; placeholder: string }
  | { kind: 'line-prefix'; prefix: string };

const wrap = (before: string, after: string, placeholder: string): Action => ({
  kind: 'wrap',
  before,
  after,
  placeholder,
});

const linePrefix = (prefix: string): Action => ({ kind: 'line-prefix', prefix });

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
  const lineStart = source.lastIndexOf('\n', selectionStart - 1) + 1;
  const endBoundary = source.indexOf('\n', selectionEnd);
  const lineEnd = endBoundary === -1 ? source.length : endBoundary;
  const slab = source.slice(lineStart, lineEnd);
  const updated = slab
    .split('\n')
    .map((line) => (line.startsWith(action.prefix) ? line : action.prefix + line))
    .join('\n');
  const next = source.slice(0, lineStart) + updated + source.slice(lineEnd);
  const delta = updated.length - slab.length;
  return {
    next,
    selStart: selectionStart + action.prefix.length,
    selEnd: selectionEnd + delta,
  };
};

export const NoteEditor = ({
  value,
  onChange,
  placeholder,
  textareaRef,
  onTranslateResult,
  translateTarget = 'uk',
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

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.metaKey || e.ctrlKey) {
      const key = e.key.toLowerCase();
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
      <div className="px-3 py-1.5 flex items-center gap-2 border-b hair">
        <div className="flex items-center gap-0.5" role="toolbar" aria-label="Markdown formatting">
          <IconButton onClick={() => run(linePrefix('# '))} title="Heading 1" stopPropagation={false}>
            <Heading1Icon />
          </IconButton>
          <IconButton onClick={() => run(linePrefix('## '))} title="Heading 2" stopPropagation={false}>
            <Heading2Icon />
          </IconButton>
          <div className="w-px h-4 bg-white/10 mx-1" />
          <IconButton onClick={() => run(wrap('**', '**', 'bold'))} title="Bold (⌘B)" stopPropagation={false}>
            <BoldIcon />
          </IconButton>
          <IconButton onClick={() => run(wrap('*', '*', 'italic'))} title="Italic (⌘I)" stopPropagation={false}>
            <ItalicIcon />
          </IconButton>
          <IconButton onClick={() => run(wrap('`', '`', 'code'))} title="Inline code" stopPropagation={false}>
            <CodeIcon size={12} />
          </IconButton>
          <IconButton onClick={() => run(wrap('\n```\n', '\n```\n', 'code block'))} title="Code block" stopPropagation={false}>
            <CodeBlockIcon size={12} />
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
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="flex-1 bg-transparent outline-none resize-none px-5 py-4 t-primary text-body font-mono leading-relaxed min-h-0"
        spellCheck={false}
      />
    </div>
  );
};
