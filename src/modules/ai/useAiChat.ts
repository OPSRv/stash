import { useCallback, useEffect, useRef, useState } from 'react';

import type { AiSettings } from './useAiSettings';
import { aiAppendMessage, aiChatSend, aiListMessages, aiRenameSession, type Message } from './api';

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

/** Shared chat-driver logic. Routes every send through the Rust assistant
 *  backend so all Stash tools (battery, metronome, pomodoro, music, …) are
 *  available. Manages message loading for a given session and persisting both
 *  sides. Used by the main AI tab and by per-feature chat panels. */
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
  // Cancellation flag: stop() sets this so we discard a late response.
  const cancelledRef = useRef(false);

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
    cancelledRef.current = true;
    setIsStreaming(false);
    setStreamingContent(null);
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

      // Persist + show user message immediately so the UI feels responsive.
      const userMsg = await aiAppendMessage({
        sessionId: session.id,
        role: 'user',
        content: prompt,
      });
      setMessages((m) => [...m, userMsg]);

      // Auto-title on the first message in a fresh session.
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

      cancelledRef.current = false;
      setIsStreaming(true);
      setStreamingContent(null);

      try {
        // Route through the Rust assistant so tools are available.
        const asstMsg = await aiChatSend(session.id, prompt);
        if (!cancelledRef.current) {
          setMessages((m) => [...m, asstMsg]);
        }
      } catch (e) {
        if (!cancelledRef.current) {
          onError?.({
            kind: 'stream-failed',
            message: e instanceof Error ? e.message : String(e),
          });
        }
      } finally {
        setIsStreaming(false);
        setStreamingContent(null);
        cancelledRef.current = false;
      }
    },
    [
      ensureSession,
      isStreaming,
      messages.length,
      onError,
      onSessionTitled,
      sessionId,
      settings.aiApiKeys,
      settings.aiModel,
      settings.aiProvider,
    ],
  );

  return { messages, streamingContent, isStreaming, send, stop, reload };
};
