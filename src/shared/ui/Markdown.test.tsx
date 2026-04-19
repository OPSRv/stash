import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { Markdown } from './Markdown';

describe('Markdown', () => {
  test('renders bold, lists, links', () => {
    render(
      <Markdown
        source={'**hi** and *emph*\n\n- one\n- two\n\n[go](https://example.com)'}
      />,
    );
    expect(screen.getByText('hi').tagName).toBe('STRONG');
    const items = screen.getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual(['one', 'two']);
    const link = screen.getByRole('link', { name: 'go' });
    expect(link.getAttribute('href')).toBe('https://example.com');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
  });

  test('renders fenced code with language class and copy button when enabled', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      'clipboard',
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    try {
      render(<Markdown source={'```ts\nconst x = 1;\n```'} codeCopy />);
      const btn = screen.getByRole('button', { name: 'Copy code' });
      fireEvent.click(btn);
      expect(writeText).toHaveBeenCalledWith('const x = 1;');
    } finally {
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard);
      }
    }
  });

  test('does not render copy button when codeCopy is off', () => {
    render(<Markdown source={'```ts\nconst x = 1;\n```'} />);
    expect(screen.queryByRole('button', { name: 'Copy code' })).toBeNull();
  });

  test('empty source renders nothing', () => {
    const { container } = render(<Markdown source={''} />);
    expect(container.firstChild).toBeNull();
  });
});

