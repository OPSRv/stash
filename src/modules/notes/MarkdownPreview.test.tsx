import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MarkdownPreview } from './MarkdownPreview';

// Force Markdown to load eagerly in tests so Suspense doesn't show its
// placeholder when assertions run synchronously. Production keeps the
// `React.lazy` boundary so the chunk only loads when a render touches it.
vi.mock('../../shared/ui/LazyMarkdown', async () => {
  const { Markdown } = await import('../../shared/ui/Markdown');
  return { LazyMarkdown: Markdown, preloadMarkdown: () => Promise.resolve() };
});

describe('MarkdownPreview', () => {
  it('renders headings, lists, links and inline code', () => {
    render(
      <MarkdownPreview
        source={'# Title\n\nSee [docs](https://example.com) and use `npm`.'}
      />
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByText('npm').tagName).toBe('CODE');
  });

  it('renders GFM tables, strikethrough and autolinks', () => {
    const src = '| a | b |\n|---|---|\n| 1 | 2 |\n\n~~old~~ https://example.org';
    render(<MarkdownPreview source={src} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
    expect(screen.getByText('old').tagName).toBe('DEL');
    expect(screen.getByRole('link', { name: 'https://example.org' })).toHaveAttribute(
      'href',
      'https://example.org'
    );
  });

  it('applies syntax-highlight classes to fenced code blocks', async () => {
    const src = '```js\nconst x = 1;\n```';
    const { container } = render(<MarkdownPreview source={src} />);
    // The hljs grammar bundle is dynamically imported on first sighting of
    // a fenced code block, so the first paint renders the raw `language-js`
    // class and a subsequent re-render upgrades it with `hljs` once the
    // chunk resolves.
    await waitFor(() => {
      const code = container.querySelector('pre code');
      expect(code?.className).toMatch(/hljs/);
      expect(code?.className).toMatch(/language-js/);
    });
  });

  it('toggles checkboxes by line via callback', () => {
    const onToggle = vi.fn();
    const src = '- [ ] one\n- [x] two';
    render(<MarkdownPreview source={src} onToggleCheckbox={onToggle} />);
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(false);
    expect((boxes[1] as HTMLInputElement).checked).toBe(true);
    fireEvent.click(boxes[0]);
    expect(onToggle).toHaveBeenCalledWith(0);
    fireEvent.click(boxes[1]);
    expect(onToggle).toHaveBeenCalledWith(1);
  });

  it('shows an empty-state when the source is blank', () => {
    render(<MarkdownPreview source="   " />);
    expect(screen.getByText(/Nothing to preview yet/i)).toBeInTheDocument();
  });

  it('renders audio-extension image embeds as an inline audio player', () => {
    render(
      <MarkdownPreview
        source={'intro\n\n![voice note](/tmp/rec.mp3)\n\ntail'}
      />
    );
    const embed = screen.getByTestId('audio-waveform');
    expect(embed).toBeInTheDocument();
    // The caption flows through from the alt text.
    expect(embed).toHaveTextContent(/voice note/i);
    // Non-audio paragraphs still render as text around the embed.
    expect(screen.getByText('intro')).toBeInTheDocument();
    expect(screen.getByText('tail')).toBeInTheDocument();
  });

  it('falls through to a regular image for non-audio srcs', () => {
    const { container } = render(
      <MarkdownPreview source={'![logo](/tmp/logo.png)'} />
    );
    expect(container.querySelector('img')).not.toBeNull();
    expect(screen.queryByTestId('audio-waveform')).not.toBeInTheDocument();
  });

  it('embeds a YouTube player for a bare youtu.be URL on its own line', () => {
    const { container } = render(
      <MarkdownPreview source={'before\n\nhttps://youtu.be/dQw4w9WgXcQ\n\nafter'} />
    );
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('src')).toContain('/embed/dQw4w9WgXcQ');
    expect(screen.getByText('before')).toBeInTheDocument();
    expect(screen.getByText('after')).toBeInTheDocument();
    // The bare URL becomes the embed — there should be no plain link with
    // that text floating in the document.
    expect(screen.queryByRole('link', { name: 'https://youtu.be/dQw4w9WgXcQ' })).toBeNull();
  });

  it('keeps inline links alongside text as plain anchors (no embed)', () => {
    const { container } = render(
      <MarkdownPreview source={'see https://example.org for details'} />
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(
      screen.getByRole('link', { name: 'https://example.org' }),
    ).toHaveAttribute('href', 'https://example.org');
  });
});
