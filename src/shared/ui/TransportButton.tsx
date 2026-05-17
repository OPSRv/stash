import './TransportButton.css';
import type { ReactNode } from 'react';

export type TransportButtonSize = 'sm' | 'md' | 'lg';
export type TransportButtonTone = 'accent' | 'neutral' | 'danger';

export interface TransportButtonProps {
  children: ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
  disabled?: boolean;
  size?: TransportButtonSize;
  tone?: TransportButtonTone;
  'data-testid'?: string;
}

const SIZE_PX: Record<TransportButtonSize, number> = {
  sm: 24,
  md: 30,
  lg: 38,
};

/// Circular transport-style button. Bigger than `IconButton`, with an
/// accent halo and a soft pulse on `active`. Used as the master
/// play/pause of the Stems mixer; expressive enough to read as the
/// primary action without crowding the lane controls.
export const TransportButton = ({
  children,
  onClick,
  title,
  active = false,
  disabled = false,
  size = 'md',
  tone = 'accent',
  'data-testid': dataTestId,
}: TransportButtonProps) => {
  const px = SIZE_PX[size];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={title}
      title={title}
      aria-pressed={active}
      data-active={active ? 'true' : 'false'}
      data-tone={tone}
      data-testid={dataTestId}
      style={{ width: px, height: px }}
      className="stash-transport-btn"
    >
      {children}
    </button>
  );
};
