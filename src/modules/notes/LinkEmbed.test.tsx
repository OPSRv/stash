import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

import { LinkEmbed } from './LinkEmbed';
import { __resetLinkPreviewCache } from '../clipboard/useLinkPreview';

const ogPreview = {
  url: 'https://tauri.app/v2/guide',
  image: 'https://cdn.tauri.app/og.png',
  title: 'Tauri 2.0 — Guide',
  description: 'Build smaller, faster, and more secure desktop apps.',
  site_name: 'Tauri',
};

describe('<LinkEmbed />', () => {
  beforeEach(() => {
    __resetLinkPreviewCache();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(ogPreview as never);
  });

  it('renders a YouTube player for a youtu.be link', () => {
    const { container } = render(
      <LinkEmbed href="https://youtu.be/dQw4w9WgXcQ" />,
    );
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('src')).toContain('/embed/dQw4w9WgXcQ');
  });

  it('renders a Telegram-style preview card with og:title, description and site favicon', async () => {
    const { container } = render(<LinkEmbed href="https://tauri.app/v2/guide" />);
    // og metadata flows from the mocked Rust IPC into the card.
    await waitFor(() =>
      expect(screen.getByText('Tauri 2.0 — Guide')).toBeInTheDocument(),
    );
    expect(
      screen.getByText('Build smaller, faster, and more secure desktop apps.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Tauri')).toBeInTheDocument();
    // Favicon comes from Google's s2 service keyed on the domain. Decorative
    // `alt=""` images don't expose the `img` ARIA role, so query the DOM
    // directly.
    const imgs = Array.from(container.querySelectorAll('img'));
    const favicon = imgs.find((img) =>
      img.getAttribute('src')?.includes('s2/favicons'),
    );
    expect(favicon?.getAttribute('src')).toContain('domain=tauri.app');
    // The OG image renders at full card width as the visual headline.
    const og = imgs.find((img) =>
      img.getAttribute('src')?.includes('cdn.tauri.app'),
    );
    expect(og).toBeDefined();
  });

  it('falls back to the hostname when the page exposes no metadata', async () => {
    vi.mocked(invoke).mockResolvedValue(null as never);
    render(<LinkEmbed href="https://example.com/path" />);
    // No title / description metadata — the card still mounts with the
    // hostname surfaced as the title.
    await waitFor(() =>
      expect(screen.getAllByText('example.com').length).toBeGreaterThan(0),
    );
  });

  it('clicking the preview card opens the URL via the Tauri opener plugin', async () => {
    const opener = await import('@tauri-apps/plugin-opener');
    const spy = vi.spyOn(opener, 'openUrl').mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<LinkEmbed href="https://tauri.app/v2/guide" />);
    await user.click(screen.getByRole('button'));
    expect(spy).toHaveBeenCalledWith('https://tauri.app/v2/guide');
  });
});
