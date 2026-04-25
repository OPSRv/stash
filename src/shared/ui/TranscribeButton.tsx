import { IconButton } from './IconButton';
import { MicIcon } from './icons';
import { Spinner } from './Spinner';

export interface TranscribeButtonProps {
  status: 'idle' | 'running' | 'error';
  hasTranscript: boolean;
  onClick: () => void;
  /** Tooltip/aria override; defaults to localised 'Транскрибувати' / 'Перетранскрибувати'. */
  title?: string;
  'data-testid'?: string;
}

/// Small icon button for inline use inside rows, e.g. next to an audio
/// player. Renders a microphone icon in idle/error state and a spinner
/// while running. The tooltip flips to "Перетранскрибувати" once a
/// transcript exists.
export const TranscribeButton = ({
  status,
  hasTranscript,
  onClick,
  title,
  'data-testid': dataTestId,
}: TranscribeButtonProps) => {
  const defaultTitle = hasTranscript ? 'Перетранскрибувати' : 'Транскрибувати';
  const resolvedTitle = title ?? defaultTitle;

  return (
    <IconButton
      onClick={onClick}
      title={resolvedTitle}
      disabled={status === 'running'}
      data-testid={dataTestId}
    >
      {status === 'running' ? <Spinner size={12} /> : <MicIcon size={14} />}
    </IconButton>
  );
};
