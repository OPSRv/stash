import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MarkdownPreview } from './MarkdownPreview';

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

  it('applies syntax-highlight classes to fenced code blocks', () => {
    const src = '```js\nconst x = 1;\n```';
    const { container } = render(<MarkdownPreview source={src} />);
    const code = container.querySelector('pre code');
    expect(code?.className).toMatch(/hljs/);
    expect(code?.className).toMatch(/language-js/);
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

  it('shows placeholder on empty source', () => {
    render(<MarkdownPreview source="   " />);
    expect(screen.getByText(/Empty/)).toBeInTheDocument();
  });
});
