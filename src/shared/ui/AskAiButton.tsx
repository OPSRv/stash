import { IconButton } from './IconButton';
import { MagicWandIcon } from './icons';

type Props = {
  /** Text to hand to the AI composer. A function lets callers compute lazily
   *  (e.g. read the current editor value only when the button is clicked). */
  text: string | (() => string);
  /** Disable when there is nothing meaningful to ask about. */
  disabled?: boolean;
  /** Custom tooltip — defaults to the canonical phrasing. */
  title?: string;
  /** Icon size. Row contexts use 12, title bars use 13. */
  size?: number;
};

/** Shared "Ask AI" action used by Clipboard, Notes, the voice-note transcript,
 *  and Translator rows. Opens a fresh AI chat (so an ongoing conversation
 *  doesn't pollute the new one) and pre-fills the composer with the given
 *  text. The AI tab owns both event listeners — we just dispatch. */
export const askAiWithText = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return;
  window.dispatchEvent(
    new CustomEvent('stash:ai-prefill', {
      detail: { text: trimmed, newSession: true },
    }),
  );
  window.dispatchEvent(new CustomEvent('stash:navigate', { detail: 'ai' }));
};

export const AskAiButton = ({
  text,
  disabled,
  title = 'Ask AI (opens a new chat)',
  size = 12,
}: Props) => {
  const resolve = () => (typeof text === 'function' ? text() : text);
  const handle = () => {
    const resolved = resolve();
    if (!resolved.trim()) return;
    askAiWithText(resolved);
  };
  return (
    <IconButton
      onClick={handle}
      disabled={disabled}
      title={disabled ? 'Nothing to ask AI about yet' : title}
      stopPropagation={false}
    >
      <MagicWandIcon size={size} />
    </IconButton>
  );
};
