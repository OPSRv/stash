import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { VideoPlayer } from './VideoPlayer';

describe('VideoPlayer', () => {
  it('renders a <video> element with the converted asset source', () => {
    const { container } = render(<VideoPlayer src="/tmp/a.mp4" onClose={() => {}} />);
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    // Mocked convertFileSrc returns asset://localhost/<path>
    expect(video?.getAttribute('src')).toContain('/tmp/a.mp4');
  });

  it('calls onClose when the close button is pressed', async () => {
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
