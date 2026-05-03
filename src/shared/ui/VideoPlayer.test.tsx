import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { VideoPlayer } from './VideoPlayer';

describe('VideoPlayer', () => {
  it('renders a <video> element fed from the loopback media server', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(
      'http://127.0.0.1:5555/video?path=%2Ftmp%2Fa.mp4&t=tok' as never,
    );
    const { container } = render(<VideoPlayer src="/tmp/a.mp4" onClose={() => {}} />);
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    await waitFor(() => {
      expect(video?.getAttribute('src')).toContain('http://127.0.0.1:');
    });
    expect(video?.getAttribute('src')).toContain('/video?');
  });

  it('does NOT set crossOrigin on the <video> element', () => {
    // WKWebView refuses to play HTTP loopback streams when crossOrigin
    // is set — same constraint as the legacy asset:// path.
    vi.mocked(invoke).mockResolvedValueOnce(
      'http://127.0.0.1:5555/video?path=%2Ftmp%2Fa.mp4&t=tok' as never,
    );
    const { container } = render(<VideoPlayer src="/tmp/a.mp4" onClose={() => {}} />);
    const video = container.querySelector('video');
    expect(video?.getAttribute('crossorigin')).toBeNull();
  });

  it('shows an error fallback when the stream URL cannot be resolved', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('outside roots'));
    render(<VideoPlayer src="/tmp/a.mp4" onClose={() => {}} />);
    expect(await screen.findByText(/Can.+t play this file/i)).toBeInTheDocument();
  });

  it('calls onClose when the close button is pressed', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(
      'http://127.0.0.1:5555/video?path=%2Ftmp%2Fa.mp4&t=tok' as never,
    );
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<VideoPlayer src="/tmp/a.mp4" onClose={onClose} />);
    const closeBtn =
      screen.queryByRole('button', { name: /close/i }) ??
      screen.getByText(/×|✕/);
    await user.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });
});
