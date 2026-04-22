import { useState } from 'react';

import { accent } from '../../shared/theme/accent';
import { LazyMarkdown } from '../../shared/ui/LazyMarkdown';
import { copyText } from '../../shared/util/clipboard';

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
    if (!(await copyText(message.content))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className={`flex w-full ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`relative group max-w-[85%] min-w-0 rounded-2xl px-3 py-2 text-body ${
          isUser ? 't-primary' : 't-primary'
        }`}
        style={{
          background: isUser
            ? accent(0.14)
            : 'var(--color-surface-muted)',
          // Break long URLs and unbroken tokens so bubbles in narrow
          // sidebars (notes chat @ 340-400 px) don't push content past
          // their own rounded edge.
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
        }}
      >
        <LazyMarkdown source={message.content} codeCopy={!isUser} className="t-primary text-body" />
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
