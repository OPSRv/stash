import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ComposeBox, type ComposeBoxProps } from './ComposeBox';
import type { UseVoiceRecorder } from '../../../shared/hooks/useVoiceRecorder';

const voiceIdle: UseVoiceRecorder = {
  phase: 'idle',
  error: '',
  busy: false,
  toggle: () => {},
  start: async () => {},
  stop: () => {},
};

const baseProps = (over: Partial<ComposeBoxProps> = {}): ComposeBoxProps => ({
  value: '',
  onChange: () => {},
  onSend: () => {},
  onFileAttach: () => {},
  onEscape: () => {},
  voice: voiceIdle,
  compact: false,
  ...over,
});

describe('<ComposeBox />', () => {
  it('renders a close button when onClose is provided and calls it on click', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ComposeBox {...baseProps({ onClose })} />);
    await user.click(screen.getByRole('button', { name: /close compose/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hides the close button when onClose is omitted', () => {
    render(<ComposeBox {...baseProps()} />);
    expect(
      screen.queryByRole('button', { name: /close compose/i }),
    ).not.toBeInTheDocument();
  });

  it('routes Escape to onClose when present, otherwise to onEscape', () => {
    const onClose = vi.fn();
    const onEscape = vi.fn();
    const { rerender } = render(
      <ComposeBox {...baseProps({ onClose, onEscape })} />,
    );
    const ta = screen.getByPlaceholderText(/Message/);
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onEscape).not.toHaveBeenCalled();

    rerender(<ComposeBox {...baseProps({ onEscape })} />);
    fireEvent.keyDown(screen.getByPlaceholderText(/Message/), { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('exposes a resize grip with the right ARIA role and orientation', () => {
    render(<ComposeBox {...baseProps()} />);
    const grip = screen.getByTestId('terminal-compose-resize');
    expect(grip).toHaveAttribute('role', 'separator');
    expect(grip).toHaveAttribute('aria-orientation', 'horizontal');
  });

  it('grows textarea height when the grip is dragged upward', () => {
    render(<ComposeBox {...baseProps()} />);
    const ta = screen.getByPlaceholderText(/Message/) as HTMLTextAreaElement;
    const initial = parseFloat(ta.style.height || '0');
    expect(initial).toBeGreaterThan(0);

    const grip = screen.getByTestId('terminal-compose-resize');
    fireEvent.pointerDown(grip, { clientY: 400 });
    // Drag upward — clientY decreases, compose should grow.
    fireEvent.pointerMove(window, { clientY: 200 });
    fireEvent.pointerUp(window);

    const after = parseFloat(ta.style.height || '0');
    expect(after).toBeGreaterThan(initial);
  });
});
