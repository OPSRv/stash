import { useState } from 'react';

import { Markdown } from '../../shared/ui/Markdown';

import type { Message } from './api';

type Props = {
  message: Pick<Message, 'role' | 'content' | 'stopped'>;
  /** When true, show a "(stopped)" suffix for partial assistant replies. */
  showStoppedHint?: boolean;
};

export const MessageBubble = ({ message, showStoppedHint = true }: Props) => {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // ignore
    }
  };

  return (
    <div className={`flex w-full ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`relative group max-w-[85%] rounded-2xl px-3 py-2 text-body ${
          isUser ? 't-primary' : 't-primary'
        }`}
        style={{
          background: isUser
            ? 'rgba(var(--stash-accent-rgb), 0.14)'
            : 'var(--color-surface-muted)',
        }}
      >
        <Markdown source={message.content} codeCopy={!isUser} className="t-primary text-body" />
        {message.stopped && showStoppedHint && (
          <div className="t-tertiary text-meta italic mt-1">(stopped)</div>
        )}
        <button
          type="button"
          onClick={onCopy}
          aria-label="Copy message"
          className="absolute -top-2 -right-2 text-meta px-2 py-0.5 rounded-md opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          style={{ background: 'rgba(0,0,0,0.45)', color: 'white' }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
};
