import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TranscribeButton } from './TranscribeButton';

describe('TranscribeButton', () => {
  it('renders with default title when no transcript yet', () => {
    render(<TranscribeButton status="idle" hasTranscript={false} onClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Транскрибувати' })).toBeInTheDocument();
  });

  it('renders with re-transcribe title when transcript exists', () => {
    render(<TranscribeButton status="idle" hasTranscript onClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Перетранскрибувати' })).toBeInTheDocument();
  });

  it('uses custom title when provided', () => {
    render(
      <TranscribeButton status="idle" hasTranscript={false} onClick={vi.fn()} title="Custom" />,
    );
    expect(screen.getByRole('button', { name: 'Custom' })).toBeInTheDocument();
  });

  it('fires onClick when idle and clicked', () => {
    const onClick = vi.fn();
    render(<TranscribeButton status="idle" hasTranscript={false} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Транскрибувати' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('is disabled while running', () => {
    render(<TranscribeButton status="running" hasTranscript={false} onClick={vi.fn()} />);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('renders spinner when status is running', () => {
    render(<TranscribeButton status="running" hasTranscript={false} onClick={vi.fn()} />);
    // Spinner renders a span with aria-hidden; verify the mic icon is gone
    // and the button is disabled.
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    // No visible mic SVG path present — spinner occupies the slot
    expect(btn.querySelector('svg[viewBox="0 0 24 24"]')).toBeNull();
  });

  it('is not disabled in error state', () => {
    render(<TranscribeButton status="error" hasTranscript={false} onClick={vi.fn()} />);
    expect(screen.getByRole('button')).not.toBeDisabled();
  });

  it('forwards data-testid', () => {
    render(
      <TranscribeButton
        status="idle"
        hasTranscript={false}
        onClick={vi.fn()}
        data-testid="my-btn"
      />,
    );
    expect(screen.getByTestId('my-btn')).toBeInTheDocument();
  });
});
