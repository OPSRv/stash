import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { AudioPlayer } from './AudioPlayer';

describe('<AudioPlayer />', () => {
  it('default variant is the waveform display', () => {
    render(<AudioPlayer src="/tmp/a.ogg" />);
    expect(screen.getByTestId('audio-waveform')).toBeInTheDocument();
  });

  it('compact variant renders a slider and play button', () => {
    render(<AudioPlayer src="/tmp/a.ogg" display="compact" />);
    expect(
      screen.getByRole('slider', { name: /audio progress/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /play/i })).toBeInTheDocument();
  });

  it('compact variant rewrites absolute paths through convertFileSrc', () => {
    const { container } = render(
      <AudioPlayer src="/tmp/voice.ogg" display="compact" />,
    );
    const audio = container.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio!.getAttribute('src')).toContain('asset://localhost');
  });

  it('compact variant passes URLs through verbatim when the scheme is set', () => {
    const { container } = render(
      <AudioPlayer src="blob:local/abc" display="compact" />,
    );
    const audio = container.querySelector('audio');
    expect(audio!.getAttribute('src')).toBe('blob:local/abc');
  });

  it('compact variant surfaces the duration hint in the clock before metadata loads', () => {
    render(<AudioPlayer src="/tmp/a.ogg" display="compact" durationHint={62} />);
    // 1:02 at the end of the clock — before metadata it's the hint.
    expect(screen.getByText(/0:00 \/ 1:02/)).toBeInTheDocument();
  });

  it('waveform variant renders the decorative bars container', () => {
    render(
      <AudioPlayer src="/tmp/a.ogg" display="waveform" caption="voice note" />,
    );
    expect(screen.getByTestId('audio-waveform')).toBeInTheDocument();
    expect(screen.getByText(/voice note/i)).toBeInTheDocument();
  });
});
