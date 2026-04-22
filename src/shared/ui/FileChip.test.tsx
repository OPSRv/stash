import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { FileChip, formatBytes } from './FileChip';

describe('<FileChip />', () => {
  it('shows the name and mime/size line', () => {
    render(<FileChip name="report.pdf" mimeType="application/pdf" size="12 KB" />);
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(screen.getByText(/application\/pdf.*12 KB/)).toBeInTheDocument();
  });

  it('omits the mime/size line when both are absent', () => {
    const { container } = render(<FileChip name="x.bin" />);
    expect(container.querySelector('.font-mono')).toBeNull();
  });

  it('renders the actions slot on the right', () => {
    render(
      <FileChip name="x.bin" actions={<button type="button">Reveal</button>} />,
    );
    expect(screen.getByRole('button', { name: /reveal/i })).toBeInTheDocument();
  });

  it('surfaces the caption block when supplied', () => {
    render(<FileChip name="x.bin" caption="Shared via AirDrop" />);
    expect(screen.getByText(/Shared via AirDrop/)).toBeInTheDocument();
  });
});

describe('formatBytes', () => {
  it('formats bytes, kilobytes, and megabytes', () => {
    expect(formatBytes(0)).toBe('');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MB');
  });
  it('returns empty string for null / undefined / negative', () => {
    expect(formatBytes(null)).toBe('');
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(-1)).toBe('');
  });
});
