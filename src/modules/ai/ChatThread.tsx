import { useEffect, useRef } from 'react';

import type { Message } from './api';
import { MessageBubble } from './MessageBubble';

type Props = {
  messages: Message[];
  streamingContent: string | null;
  emptyHero?: React.ReactNode;
};

export const ChatThread = ({ messages, streamingContent, emptyHero }: Props) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = distance < 24;
  };

  // Auto-scroll during streaming, but only if the user is already near the
  // bottom. If they scrolled up to read history, don't yank them back.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, streamingContent]);

  const hasAny = messages.length > 0 || streamingContent !== null;

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="flex-1 overflow-y-auto nice-scroll px-4 py-4 flex flex-col gap-3"
      role="log"
      aria-live="polite"
      aria-relevant="additions"
    >
      {!hasAny && emptyHero}
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}
      {streamingContent !== null && (
        <MessageBubble
          key="__streaming__"
          message={{ role: 'assistant', content: streamingContent || '…', stopped: false }}
          showStoppedHint={false}
        />
      )}
    </div>
  );
};
