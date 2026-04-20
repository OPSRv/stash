import { useCallback, useEffect, useRef, useState } from 'react';
import { streamText } from 'ai';

import type { AiSettings } from './useAiSettings';
import { aiAppendMessage, aiListMessages, aiRenameSession, type Message } from './api';
import { buildModel } from './provider';

export type ChatSendError =
  | { kind: 'no-model' }
  | { kind: 'no-api-key' }
  | { kind: 'model-invalid'; message: string }
  | { kind: 'stream-failed'; message: string };

/** What the hook can ask the host to do — resolving or creating the backing
 *  session stays with the caller so per-feature ownership (per-note /
 *  per-clipboard-item / …) doesn't leak into a generic chat driver. */
type EnsureSession = () => Promise<{ id: string } | null>;

type Options = {
  /** Existing session id, or `null` if none has been created yet. The hook
   *  will ask `ensureSession` on first send when null. */
  sessionId: string | null;
  settings: AiSettings;
  /** Create-or-fetch the session on first send. Allows lazy creation so an
   *  empty chat pane doesn't spawn a session until the user types. */
  ensureSession: EnsureSession;
  /** Invoked after a fresh session gets its auto-title from the first user
   *  prompt, so the host can update its local sessions list without
   *  refetching. */
  onSessionTitled?: (sessionId: string, title: string) => void;
  /** Fired with a structured error so the host can render a toast with
   *  phrasing that fits its context — the hook stays UI-agnostic. */
  onError?: (err: ChatSendError) => void;
};

export type UseAiChat = {
  messages: Message[];
  streamingContent: string | null;
  isStreaming: boolean;
  send: (prompt: string) => Promise<void>;
  stop: () => void;
  /** Force-reload messages from disk — useful when the host knows the
   *  session changed out of band (e.g. deleted in another tab). */
  reload: () => Promise<void>;
};

const autoTitleFrom = (prompt: string): string => {
  const first = prompt.trim().split('\n')[0] ?? '';
  return first.slice(0, 40) || 'New chat';
};

/** Shared chat-driver logic. Manages message loading for a given session,
 *  streaming an assistant response, and persisting both sides. Used by the
 *  main AI tab (via `AiShell`'s future adoption) and by per-feature chat
 *  panels like the notes sidebar. */
export const useAiChat = ({
  sessionId,
  settings,
  ensureSession,
  onSessionTitled,
  onError,
}: Options): UseAiChat => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
    try {
      const msgs = await aiListMessages(sessionId);
      setMessages(msgs);
    } catch (e) {
      // Session may have been deleted elsewhere — clear locally so the
      // host can surface the state without an unbounded spinner.
      console.error('[useAiChat] load messages failed', e);
      setMessages([]);
    }
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    if (!sessionId) {
      setMessages([]);
      return;
    }
    aiListMessages(sessionId)
      .then((msgs) => {
        if (!cancelled) setMessages(msgs);
      })
      .catch((e) => {
        if (!cancelled) {
          console.error('[useAiChat] load messages failed', e);
          setMessages([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const send = useCallback(
    async (raw: string) => {
      const prompt = raw.trim();
      if (!prompt || isStreaming) return;

      if (!settings.aiModel.trim()) {
        onError?.({ kind: 'no-model' });
        return;
      }

      const session = sessionId ? { id: sessionId } : await ensureSession();
      if (!session) return;

      const userMsg = await aiAppendMessage({
        sessionId: session.id,
        role: 'user',
        content: prompt,
      });
      setMessages((m) => [...m, userMsg]);

      // First message in a brand-new session: auto-title from the prompt.
      // We detect "first message" via the prior-messages list length rather
      // than a session-creation flag so retrying a never-titled session
      // still gets one on the next send.
      const isFirstMessage = messages.length === 0;
      if (isFirstMessage) {
        const title = autoTitleFrom(prompt);
        aiRenameSession(session.id, title).catch(() => {});
        onSessionTitled?.(session.id, title);
      }

      const key = settings.aiApiKeys[settings.aiProvider];
      if (!key) {
        onError?.({ kind: 'no-api-key' });
        return;
      }

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
        onError?.({
          kind: 'model-invalid',
          message: e instanceof Error ? e.message : String(e),
        });
        return;
      }

      const abort = new AbortController();
      abortRef.current = abort;
      setIsStreaming(true);
      setStreamingContent('');

      let acc = '';
      try {
        const result = streamText({
          model,
          system: settings.aiSystemPrompt || undefined,
          messages: [...messages, userMsg].map((m) => ({
            role: m.role,
            content: m.content,
          })),
          abortSignal: abort.signal,
        });
        for await (const chunk of result.textStream) {
          acc += chunk;
          setStreamingContent(acc);
        }
      } catch (e) {
        if (!abort.signal.aborted) {
          onError?.({
            kind: 'stream-failed',
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }

      const stopped = abort.signal.aborted;
      if (acc.length > 0) {
        const persisted = await aiAppendMessage({
          sessionId: session.id,
          role: 'assistant',
          content: acc,
          stopped,
        }).catch(() => null);
        if (persisted) setMessages((m) => [...m, persisted]);
      }

      setIsStreaming(false);
      setStreamingContent(null);
      abortRef.current = null;
    },
    [
      ensureSession,
      isStreaming,
      messages,
      onError,
      onSessionTitled,
      sessionId,
      settings.aiApiKeys,
      settings.aiBaseUrl,
      settings.aiModel,
      settings.aiProvider,
      settings.aiSystemPrompt,
    ],
  );

  return { messages, streamingContent, isStreaming, send, stop, reload };
};
