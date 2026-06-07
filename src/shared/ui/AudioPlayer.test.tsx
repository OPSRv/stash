import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { AudioPlayer } from './AudioPlayer';

// jsdom doesn't implement pointer capture; the drag handles call it on
// pointerdown/up. No-op stubs keep fireEvent.pointer* from throwing.
beforeAll(() => {
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

/// Override the media element's playback clock — jsdom reports
/// `duration: NaN` and won't really play, so the loop wrap logic (which
/// reads `audio.duration`/`audio.currentTime`) needs a stand-in.
const stubClock = (audio: HTMLAudioElement, duration: number, current: number) => {
  let ct = current;
  Object.defineProperty(audio, 'duration', { configurable: true, get: () => duration });
  Object.defineProperty(audio, 'currentTime', {
    configurable: true,
    get: () => ct,
    set: (v: number) => {
      ct = v;
    },
  });
  return () => ct;
};

// Drive the unified waveform surface. getBoundingClientRect is stubbed
// to width 600 (see test/setup), so clientX maps directly to a fraction:
// x=0 → 0%, x=300 → 50%, x=600 → 100%.
const surfaceDrag = (fromX: number, toX: number) => {
  const el = screen.getByTestId('waveform-surface');
  fireEvent.pointerDown(el, { pointerId: 1, clientX: fromX });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: toX });
  fireEvent.pointerUp(el, { pointerId: 1, clientX: toX });
};

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

  describe('A–B loop', () => {
    it('hides the loop control unless abLoop is set', () => {
      render(<AudioPlayer src="/tmp/a.ogg" display="waveform" durationHint={30} />);
      expect(
        screen.queryByRole('button', { name: /loop region/i }),
      ).not.toBeInTheDocument();
    });

    it('shows the loop toggle but no region handles until toggled on', () => {
      render(
        <AudioPlayer src="/tmp/a.ogg" display="waveform" durationHint={30} abLoop />,
      );
      expect(
        screen.getByRole('button', { name: /loop region/i }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('slider', { name: /loop a marker/i }),
      ).not.toBeInTheDocument();
    });

    it('reveals A (0%) and B (100%) handles spanning the whole track on toggle', () => {
      render(
        <AudioPlayer src="/tmp/a.ogg" display="waveform" durationHint={30} abLoop />,
      );
      fireEvent.click(screen.getByRole('button', { name: /loop region/i }));
      expect(
        screen.getByRole('slider', { name: /loop a marker/i }),
      ).toHaveAttribute('aria-valuenow', '0');
      expect(
        screen.getByRole('slider', { name: /loop b marker/i }),
      ).toHaveAttribute('aria-valuenow', '100');
    });

    it('grabbing near B drags it to narrow the region', () => {
      render(
        <AudioPlayer src="/tmp/a.ogg" display="waveform" durationHint={30} abLoop />,
      );
      fireEvent.click(screen.getByRole('button', { name: /loop region/i }));
      // Press at the far right (near B@100%), drag to the middle (50%).
      surfaceDrag(600, 300);
      expect(
        screen.getByRole('slider', { name: /loop b marker/i }),
      ).toHaveAttribute('aria-valuenow', '50');
    });

    it('keeps a minimum gap so A cannot cross past B', () => {
      render(
        <AudioPlayer src="/tmp/a.ogg" display="waveform" durationHint={30} abLoop />,
      );
      fireEvent.click(screen.getByRole('button', { name: /loop region/i }));
      surfaceDrag(600, 300); // grab B → 50%
      surfaceDrag(0, 420); // grab A → drag to 70%, clamped
      // Clamped to loopEnd - MIN_LOOP_GAP (0.5 - 0.02 = 0.48).
      expect(
        screen.getByRole('slider', { name: /loop a marker/i }),
      ).toHaveAttribute('aria-valuenow', '48');
    });

    it('nudges a marker with the arrow keys', () => {
      render(
        <AudioPlayer src="/tmp/a.ogg" display="waveform" durationHint={30} abLoop />,
      );
      fireEvent.click(screen.getByRole('button', { name: /loop region/i }));
      const a = screen.getByRole('slider', { name: /loop a marker/i });
      fireEvent.keyDown(a, { key: 'ArrowRight' }); // +1%
      fireEvent.keyDown(a, { key: 'ArrowRight', shiftKey: true }); // +5%
      expect(a).toHaveAttribute('aria-valuenow', '6');
    });

    it('clicking the strip away from the markers seeks', () => {
      const { container } = render(
        <AudioPlayer src="/tmp/a.ogg" display="waveform" durationHint={30} abLoop />,
      );
      const audio = container.querySelector('audio')!;
      const now = stubClock(audio, 30, 0);
      // Loop off → no markers, the whole strip seeks. x=300 → 50% → 15s.
      surfaceDrag(300, 300);
      expect(now()).toBe(15);
    });

    it('wraps the playhead from B back to A while looping', () => {
      const { container } = render(
        <AudioPlayer src="/tmp/a.ogg" display="waveform" durationHint={30} abLoop />,
      );
      fireEvent.click(screen.getByRole('button', { name: /loop region/i }));
      surfaceDrag(600, 300); // B → 50% → 15s
      const audio = container.querySelector('audio')!;
      const now = stubClock(audio, 30, 16); // past B (15s)
      fireEvent.timeUpdate(audio);
      expect(now()).toBe(0); // jumped back to A (0%)
    });

    it('restarts from A on ended when the region reaches the track end', () => {
      const { container } = render(
        <AudioPlayer src="/tmp/a.ogg" display="waveform" durationHint={30} abLoop />,
      );
      fireEvent.click(screen.getByRole('button', { name: /loop region/i })); // A=0, B=end
      const audio = container.querySelector('audio')!;
      const play = vi.fn().mockResolvedValue(undefined);
      audio.play = play;
      const now = stubClock(audio, 30, 30);
      fireEvent.ended(audio);
      expect(now()).toBe(0);
      expect(play).toHaveBeenCalled();
    });

    it('does not restart on ended when looping is off', () => {
      const { container } = render(
        <AudioPlayer src="/tmp/a.ogg" display="waveform" durationHint={30} abLoop />,
      );
      const audio = container.querySelector('audio')!;
      const play = vi.fn().mockResolvedValue(undefined);
      audio.play = play;
      stubClock(audio, 30, 30);
      fireEvent.ended(audio);
      expect(play).not.toHaveBeenCalled();
    });
  });
});
