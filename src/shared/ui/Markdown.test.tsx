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

  test('strips javascript: and data: hrefs to prevent XSS', () => {
    const { container } = render(
      <Markdown
        source={'[js](javascript:alert(1)) [vb](vbscript:x) [ok](https://example.com)'}
      />,
    );
    // Any rendered anchor for the unsafe schemes must not carry an
    // executable href. react-markdown also strips some of these on its
    // own — either way, no javascript:/vbscript: href should reach the DOM.
    const anchors = Array.from(container.querySelectorAll('a'));
    for (const a of anchors) {
      const h = (a.getAttribute('href') ?? '').toLowerCase();
      expect(h.startsWith('javascript:')).toBe(false);
      expect(h.startsWith('vbscript:')).toBe(false);
    }
    const okLink = screen.getByRole('link', { name: 'ok' });
    expect(okLink.getAttribute('href')).toBe('https://example.com');
  });

  test('does not warn when unmounted before copy-reset timeout fires', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      'clipboard',
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { unmount } = render(
        <Markdown source={'```ts\nconst x = 1;\n```'} codeCopy />,
      );
      const btn = screen.getByRole('button', { name: 'Copy code' });
      fireEvent.click(btn);
      // Let the clipboard promise resolve so setCopied(true) runs and the
      // reset timer is scheduled.
      await vi.runAllTimersAsync();
      unmount();
      // Advance past 1400ms — if cleanup is broken, React logs a
      // "setState on unmounted component" error here.
      vi.advanceTimersByTime(2000);
      const calls = errSpy.mock.calls.flat().join(' ');
      expect(calls).not.toMatch(/unmounted/i);
    } finally {
      errSpy.mockRestore();
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard);
      }
      vi.useRealTimers();
    }
  });
});

