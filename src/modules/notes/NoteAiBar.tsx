import { useCallback, useEffect, useRef, useState } from 'react';
import { streamText } from 'ai';

import { Button } from '../../shared/ui/Button';
import { Tooltip } from '../../shared/ui/Tooltip';
import { CloseIcon, SendToAiIcon, StopCircleIcon } from '../../shared/ui/icons';
import { useToast } from '../../shared/ui/Toast';
import { buildModel } from '../ai/provider';
import { useAiSettings } from '../ai/useAiSettings';

type Props = {
  noteTitle: string;
  body: string;
  onBodyChange: (next: string) => void;
  onClose: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Open an undo transaction before the AI stream begins and flush it
   *  after — collapses the whole rewrite into one undoable step. */
  beginTransaction: () => void;
  endTransaction: () => void;
};

const SYSTEM_PROMPT = [
  "You edit the user's markdown note in-place.",
  'Output ONLY the complete revised note body in markdown — no commentary, no explanations, no code fences, no preamble.',
  'Preserve any section the user did not ask to change verbatim, including whitespace, headings, lists, and embeds like ![…](…).',
  'If the user asks to rewrite a specific paragraph, replace only that paragraph and keep the rest byte-identical.',
  "If the note is empty, produce a coherent note body that answers the user's instruction.",
  'If the user asks for a chart, graph, diagram, or data visualisation, use a Mermaid block (```mermaid … ```) with a supported diagram type:',
  'flowchart / graph TD / graph LR, sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, journey, gantt, pie, gitGraph, mindmap, timeline, xychart-beta.',
  'Never invent a custom chart syntax or reach for an external image — the note renderer only understands Mermaid.',
].join(' ');

const buildUserMessage = (title: string, body: string, instruction: string): string => {
  const header = title.trim() ? `Title: ${title.trim()}\n\n` : '';
  const current = body.length > 0 ? body : '(empty note)';
  return `${header}Current note body:\n---\n${current}\n---\n\nInstruction: ${instruction}`;
};

const UndoIcon = ({ size = 13 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h11a5 5 0 0 1 0 10h-4" />
  </svg>
);

const RedoIcon = ({ size = 13 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H9a5 5 0 0 0 0 10h4" />
  </svg>
);

export const NoteAiBar = ({
  noteTitle,
  body,
  onBodyChange,
  onClose,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  beginTransaction,
  endTransaction,
}: Props) => {
  const settings = useAiSettings();
  const { toast } = useToast();
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const originalRef = useRef<string>(body);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const aiReady =
    Boolean(settings.aiModel.trim()) &&
    Boolean(settings.aiApiKeys[settings.aiProvider]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const send = useCallback(async () => {
    const instruction = input.trim();
    if (!instruction || isStreaming) return;

    if (!aiReady) {
      toast({
        title: !settings.aiModel.trim() ? 'Set a model in Settings → AI' : 'No API key',
        description: 'Configure the AI provider before rewriting notes.',
        variant: 'error',
      });
      return;
    }

    const key = settings.aiApiKeys[settings.aiProvider] ?? '';
    let model;
    try {
      model = await buildModel(
        {
          provider: settings.aiProvider,
          model: settings.aiModel,
          baseUrl: settings.aiBaseUrl,
        },
        key,
      );
    } catch (e) {
      toast({
        title: 'Model error',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      });
      return;
    }

    const abort = new AbortController();
    abortRef.current = abort;
    originalRef.current = body;
    // Whole rewrite collapses into one undo entry.
    beginTransaction();
    setIsStreaming(true);
    setInput('');

    let acc = '';
    try {
      const result = streamText({
        model,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserMessage(noteTitle, body, instruction) }],
        abortSignal: abort.signal,
      });
      for await (const chunk of result.textStream) {
        acc += chunk;
        onBodyChange(acc);
      }
    } catch (e) {
      if (abort.signal.aborted) {
        onBodyChange(originalRef.current);
      } else {
        onBodyChange(originalRef.current);
        toast({
          title: 'AI rewrite failed',
          description: e instanceof Error ? e.message : String(e),
          variant: 'error',
        });
      }
    }

    endTransaction();
    setIsStreaming(false);
    abortRef.current = null;
  }, [
    aiReady,
    beginTransaction,
    body,
    endTransaction,
    input,
    isStreaming,
    noteTitle,
    onBodyChange,
    settings.aiApiKeys,
    settings.aiBaseUrl,
    settings.aiModel,
    settings.aiProvider,
    toast,
  ]);

  return (
    <div
      className="border-t hair flex flex-col gap-1.5 px-3 py-2 shrink-0 relative"
      style={{
        // Frosted glass to match Terminal's ComposeBox — the bar reads as
        // chrome over the editor instead of a flat slab.
        background: 'rgba(16, 18, 22, 0.6)',
        backdropFilter: 'blur(18px) saturate(1.4)',
        WebkitBackdropFilter: 'blur(18px) saturate(1.4)',
      }}
      data-testid="note-ai-bar"
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="t-tertiary text-meta shrink-0 select-none">AI rewrite</span>
        {isStreaming && (
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: 'var(--stash-accent)',
              animation: 'pulse 1.1s ease-in-out infinite',
            }}
          />
        )}
        <div className="flex-1" />
        <div className="flex items-center gap-0.5 shrink-0">
          <Tooltip label="Undo (note body)">
            <Button
              size="xs"
              variant="ghost"
              onClick={onUndo}
              disabled={!canUndo || isStreaming}
              aria-label="Undo"
            >
              <UndoIcon size={13} />
            </Button>
          </Tooltip>
          <Tooltip label="Redo (note body)">
            <Button
              size="xs"
              variant="ghost"
              onClick={onRedo}
              disabled={!canRedo || isStreaming}
              aria-label="Redo"
            >
              <RedoIcon size={13} />
            </Button>
          </Tooltip>
          {isStreaming ? (
            <Tooltip label="Stop and revert (Esc)">
              <Button
                size="xs"
                variant="soft"
                tone="danger"
                onClick={stop}
                aria-label="Stop and revert"
              >
                <StopCircleIcon size={13} />
              </Button>
            </Tooltip>
          ) : (
            <Tooltip label="Send (Enter)">
              <Button
                size="xs"
                variant="soft"
                tone="accent"
                onClick={() => void send()}
                disabled={!aiReady || !input.trim()}
                aria-label="Send"
              >
                <SendToAiIcon size={13} />
              </Button>
            </Tooltip>
          )}
          <Tooltip label="Close AI bar (Esc)">
            <Button
              size="xs"
              variant="ghost"
              onClick={onClose}
              aria-label="Close AI bar"
            >
              <CloseIcon size={13} />
            </Button>
          </Tooltip>
        </div>
      </div>
      <textarea
        ref={textareaRef}
        value={input}
        onChange={(e) => setInput(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (!e.metaKey && !e.ctrlKey && !e.altKey) {
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            if (isStreaming) stop();
            else onClose();
            return;
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (!isStreaming) void send();
          }
        }}
        placeholder={
          aiReady
            ? 'Tell AI how to rewrite this note · ⏎ send · ⇧⏎ newline · Esc close'
            : 'Configure AI in Settings → AI first'
        }
        disabled={!aiReady || isStreaming}
        rows={2}
        maxLength={8000}
        className="w-full resize-none rounded-md px-2 py-1.5 text-body outline-none t-primary nice-scroll"
        style={{
          // Dark recess matching Terminal's compose textarea.
          background: 'rgba(0, 0, 0, 0.28)',
          border: '1px solid var(--color-border-hair, rgba(255,255,255,0.08))',
          minHeight: 48,
          maxHeight: 160,
        }}
        aria-label="AI instruction for this note"
        spellCheck={false}
      />
    </div>
  );
};
