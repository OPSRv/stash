import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { NowPlayingBar } from './NowPlayingBar';

const basePlaying = {
  playing: true,
  title: 'Song Title',
  artist: 'Some Artist',
  artwork: 'https://example.com/art.jpg',
};

describe('NowPlayingBar', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
  });

  it('shows title and artist', () => {
    render(<NowPlayingBar state={basePlaying} onOpen={() => {}} onClose={() => {}} onOptimistic={() => {}} />);
    expect(screen.getByText('Song Title')).toBeInTheDocument();
    expect(screen.getByText('Some Artist')).toBeInTheDocument();
  });

  it('renders the artwork when present', () => {
    const { container } = render(
      <NowPlayingBar state={basePlaying} onOpen={() => {}} onClose={() => {}} onOptimistic={() => {}} />,
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', 'https://example.com/art.jpg');
  });

  it('falls back to placeholder text when artwork is missing', () => {
    const { container } = render(
      <NowPlayingBar state={{ ...basePlaying, artwork: '' }} onOpen={() => {}} onClose={() => {}} onOptimistic={() => {}} />,
    );
    expect(container.querySelector('img')).toBeNull();
  });

  it('clicking the bar opens the Music tab', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<NowPlayingBar state={basePlaying} onOpen={onOpen} onClose={() => {}} onOptimistic={() => {}} />);
    await user.click(screen.getByRole('button', { name: /now playing/i }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  // IconButton exposes its label via `aria-label` (the HTML `title`
  // attribute moved to a Tooltip wrapper), so reach the buttons by
  // accessible name rather than the raw title.
  it('transport buttons invoke the Rust bridge without opening Music tab', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<NowPlayingBar state={basePlaying} onOpen={onOpen} onClose={() => {}} onOptimistic={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(invoke).toHaveBeenCalledWith('music_play_pause');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(invoke).toHaveBeenCalledWith('music_next');
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(invoke).toHaveBeenCalledWith('music_prev');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('dismiss button calls onClose without opening Music tab', async () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <NowPlayingBar
        state={basePlaying}
        onOpen={onOpen}
        onClose={onClose}
        onOptimistic={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('flips play/pause optimistically before the Rust call resolves', async () => {
    const onOptimistic = vi.fn();
    const user = userEvent.setup();
    render(
      <NowPlayingBar
        state={basePlaying}
        onOpen={() => {}}
        onClose={() => {}}
        onOptimistic={onOptimistic}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(onOptimistic).toHaveBeenCalledWith({ playing: false });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(onOptimistic).toHaveBeenLastCalledWith({ playing: true });
  });

  it('toggles the play icon based on playing state', () => {
    const { rerender } = render(
      <NowPlayingBar state={basePlaying} onOpen={() => {}} onClose={() => {}} onOptimistic={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    rerender(
      <NowPlayingBar
        state={{ ...basePlaying, playing: false }}
        onOpen={() => {}} onClose={() => {}} onOptimistic={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  });
});
