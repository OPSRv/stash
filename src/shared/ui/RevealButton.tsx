import { Button, type ButtonSize, type ButtonVariant } from './Button';
import { revealFile } from '../util/revealFile';

type RevealButtonProps = {
  path: string;
  label?: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
  disabled?: boolean;
  /// Set when the button sits inside a clickable row — prevents the reveal
  /// click from triggering the parent row's selection handler.
  stopPropagation?: boolean;
};

/// Standard "Reveal in Finder" button used across every system panel and
/// the downloader's completed-row list. Encapsulates the lazy opener
/// import + swallowed rejection so each call site just passes the path.
export const RevealButton = ({
  path,
  label = 'Показати',
  size = 'sm',
  variant = 'ghost',
  disabled,
  stopPropagation,
}: RevealButtonProps) => (
  <Button
    size={size}
    variant={variant}
    disabled={disabled}
    stopPropagation={stopPropagation}
    onClick={() => {
      void revealFile(path);
    }}
  >
    {label}
  </Button>
);
