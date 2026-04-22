import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  LinkifiedText,
  extractUrls,
  openExternalUrl,
} from './LinkifiedText';

describe('<LinkifiedText />', () => {
  it('renders URLs as anchors and plain text as text nodes', () => {
    render(
      <LinkifiedText content="Check https://tauri.app for docs." />,
    );
    const anchor = screen.getByRole('link');
    expect(anchor).toHaveAttribute('href', 'https://tauri.app');
    expect(screen.getByText(/Check/)).toBeInTheDocument();
  });

  it('normalises bare www URLs to https://', () => {
    render(<LinkifiedText content="www.example.com rocks" />);
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      'https://www.example.com',
    );
  });

  it('does not pick up sentence-ending punctuation inside the href', () => {
    render(
      <LinkifiedText content="visit https://tauri.app/guides, it works." />,
    );
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      'https://tauri.app/guides',
    );
  });

  it('anchor click routes through the opener plugin', async () => {
    const opener = await import('@tauri-apps/plugin-opener');
    const spy = vi.spyOn(opener, 'openUrl').mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<LinkifiedText content="see https://example.org" />);
    await user.click(screen.getByRole('link'));
    expect(spy).toHaveBeenCalledWith('https://example.org');
  });

  it('content without URLs renders as plain text', () => {
    render(<LinkifiedText content="just a note" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('just a note')).toBeInTheDocument();
  });
});

describe('extractUrls', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns all URLs in order', () => {
    const out = extractUrls('go https://a.com and https://b.org');
    expect(out).toEqual(['https://a.com', 'https://b.org']);
  });

  it('returns an empty array when the text has no URLs', () => {
    expect(extractUrls('nothing here')).toEqual([]);
  });
});

describe('openExternalUrl', () => {
  it('delegates to plugin-opener', async () => {
    const opener = await import('@tauri-apps/plugin-opener');
    const spy = vi.spyOn(opener, 'openUrl').mockResolvedValue(undefined);
    await openExternalUrl('https://tauri.app');
    expect(spy).toHaveBeenCalledWith('https://tauri.app');
  });
});
