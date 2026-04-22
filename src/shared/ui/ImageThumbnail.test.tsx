import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ImageThumbnail } from './ImageThumbnail';

describe('<ImageThumbnail />', () => {
  it('renders an img with the converted asset source for absolute paths', () => {
    render(<ImageThumbnail src="/tmp/cat.png" alt="cat" />);
    const img = screen.getByAltText('cat');
    expect(img.getAttribute('src')).toContain('asset://localhost');
    expect(img.getAttribute('src')).toContain('/tmp/cat.png');
  });

  it('passes URLs through verbatim when a scheme is set', () => {
    render(<ImageThumbnail src="https://example.com/a.png" alt="example" />);
    expect(screen.getByAltText('example').getAttribute('src')).toBe(
      'https://example.com/a.png',
    );
  });

  it('click opens a lightbox dialog, Esc closes it', async () => {
    const user = userEvent.setup();
    render(<ImageThumbnail src="/tmp/cat.png" alt="cat" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: /open cat/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('surfaces the caption under the thumbnail', () => {
    render(<ImageThumbnail src="/tmp/cat.png" caption="morning photo" />);
    expect(screen.getByText(/morning photo/)).toBeInTheDocument();
  });
});
