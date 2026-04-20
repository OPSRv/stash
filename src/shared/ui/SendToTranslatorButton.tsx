import { IconButton } from './IconButton';
import { TranslateIcon } from './icons';

type Props = {
  /** Text to hand to the translator composer. A function lets callers compute
   *  lazily (e.g. read the current row value only when clicked). */
  text: string | (() => string);
  disabled?: boolean;
  title?: string;
  size?: number;
};

/** Hand `text` to the Translator tab and switch to it. The Translator owns
 *  the listener; we just dispatch. */
export const sendToTranslator = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return;
  window.dispatchEvent(
    new CustomEvent('stash:translator-prefill', { detail: trimmed }),
  );
  window.dispatchEvent(new CustomEvent('stash:navigate', { detail: 'translator' }));
};

export const SendToTranslatorButton = ({
  text,
  disabled,
  title = 'Send to Translator',
  size = 12,
}: Props) => {
  const resolve = () => (typeof text === 'function' ? text() : text);
  const handle = () => {
    const resolved = resolve();
    if (!resolved.trim()) return;
    sendToTranslator(resolved);
  };
  return (
    <IconButton
      onClick={handle}
      disabled={disabled}
      title={disabled ? 'Nothing to translate yet' : title}
      stopPropagation={false}
    >
      <TranslateIcon size={size} />
    </IconButton>
  );
};
