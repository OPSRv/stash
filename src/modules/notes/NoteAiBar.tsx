import { useCallback, useEffect, useRef, useState } from 'react';
import { streamText } from 'ai';

import { Button } from '../../shared/ui/Button';
import { IconButton } from '../../shared/ui/IconButton';
import { Textarea } from '../../shared/ui/Textarea';
import { CloseIcon } from '../../shared/ui/icons';
import { useToast } from '../../shared/ui/Toast';
import { buildModel } from '../ai/provider';
import { useAiSettings } from '../ai/useAiSettings';

type Props = {
  noteTitle: string;
  body: string;
  onBodyChange: (next: string) => void;
  onClose: () => void;
  onStreamingChange?: (streaming: boolean) => void;
};

const SYSTEM_PROMPT = [
  'You edit the user\'s markdown note in-place.',
  'Output ONLY the complete revised note body in markdown — no commentary, no explanations, no code fences, no preamble.',
  'Preserve any section the user did not ask to change verbatim, including whitespace, headings, lists, and embeds like ![…](…).',
  'If the user asks to rewrite a specific paragraph, replace only that paragraph and keep the rest byte-identical.',
  'If the note is empty, produce a coherent note body that answers the user\'s instruction.',
].join(' ');

const buildUserMessage = (title: string, body: string, instruction: string): string => {
  const header = title.trim() ? `Title: ${title.trim()}\n\n` : '';
  const current = body.length > 0 ? body : '(empty note)';
  return `${header}Current note body:\n---\n${current}\n---\n\nInstruction: ${instruction}`;
};

export const NoteAiBar = ({
  noteTitle,
  body,
  onBodyChange,
  onClose,
  onStreamingChange,
}: Props) => {
  const settings = useAiSettings();
  const { toast } = useToast();
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Latest body kept in a ref so the abort handler can revert even after
  // many re-renders during streaming.
  const originalRef = useRef<string>(body);

  useEffect(() => {
    onStreamingChange?.(isStreaming);
  }, [isStreaming, onStreamingChange]);

  // Focus the textarea when the bar opens so the user can start typing
  // immediately after hitting the magic-wand button.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Abort any in-flight stream on unmount so navigating away from Notes
  // does not keep charging tokens in the background.
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
        // User pressed Stop → restore the pre-stream body so a partial
        // rewrite doesn't leave the note in a broken state.
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

    setIsStreaming(false);
    abortRef.current = null;
  }, [
    aiReady,
    body,
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
      className="border-t hair px-3 py-2 flex items-end gap-2"
      style={{ background: 'var(--color-surface)' }}
      data-testid="note-ai-bar"
    >
      <Textarea
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
        rows={1}
        maxLength={8000}
        placeholder={
          aiReady
            ? 'Tell AI how to rewrite this note — e.g. "rewrite paragraph 2"'
            : 'Configure AI in Settings → AI first'
        }
        disabled={!aiReady || isStreaming}
        className="flex-1 resize-none nice-scroll"
        style={{ minHeight: 36, maxHeight: 120 }}
        aria-label="AI instruction for this note"
      />
      {isStreaming ? (
        <Button
          aria-label="Stop and revert"
          title="Stop and revert (Esc)"
          onClick={stop}
          variant="soft"
          tone="danger"
          shape="square"
          size="sm"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <rect x="3" y="3" width="8" height="8" rx="1" fill="currentColor" />
          </svg>
        </Button>
      ) : (
        <Button
          aria-label="Send"
          title="Send (Enter)"
          onClick={() => void send()}
          disabled={!aiReady || !input.trim()}
          variant="soft"
          tone="accent"
          shape="square"
          size="sm"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M2 2 L12 7 L2 12 L5 7 Z"
              fill="currentColor"
              stroke="currentColor"
              strokeLinejoin="round"
            />
          </svg>
        </Button>
      )}
      <IconButton onClick={onClose} title="Close AI bar" stopPropagation={false}>
        <CloseIcon size={13} />
      </IconButton>
    </div>
  );
};
