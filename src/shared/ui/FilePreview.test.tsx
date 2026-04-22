import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FilePreview, FilePreviewList } from './FilePreview';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const makeTextResponse = (body: string) => ({
  ok: true,
  headers: {
    get: (k: string) =>
      k.toLowerCase() === 'content-length'
        ? String(new TextEncoder().encode(body).length)
        : null,
  },
  text: async () => body,
});

describe('FilePreview binary kinds', () => {
  it('renders an image thumbnail for .png files', () => {
    render(<FilePreview src="/tmp/a.png" name="a.png" />);
    const scope = document.querySelector('[data-file-kind="image"]');
    expect(scope).not.toBeNull();
    const img = scope!.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toContain('asset://localhost//tmp/a.png');
  });

  it('renders an inline video element for .mp4', () => {
    const { container } = render(
      <FilePreview src="/tmp/clip.mp4" name="clip.mp4" />,
    );
    const scope = container.querySelector('[data-file-kind="video"]');
    expect(scope).not.toBeNull();
    expect(scope!.querySelector('video')).not.toBeNull();
  });

  it('routes audio files to the shared AudioPlayer', () => {
    const { container } = render(
      <FilePreview src="/tmp/voice.m4a" name="voice.m4a" />,
    );
    const scope = container.querySelector('[data-file-kind="audio"]');
    expect(scope).not.toBeNull();
    expect(scope!.querySelector('audio')).not.toBeNull();
  });

  it('embeds PDFs via <embed>', () => {
    const { container } = render(
      <FilePreview src="/tmp/book.pdf" name="book.pdf" />,
    );
    const embed = container.querySelector(
      'embed[type="application/pdf"]',
    ) as HTMLEmbedElement | null;
    expect(embed).not.toBeNull();
    expect(embed!.getAttribute('src')).toContain('asset://localhost//tmp/book.pdf');
  });

  it('binary kinds do not trigger a fetch', () => {
    render(<FilePreview src="/tmp/a.png" name="a.png" />);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('FilePreview textual kinds', () => {
  it('renders inline text prop immediately as code with the right language', async () => {
    const { container } = render(
      <FilePreview text={'export const x: number = 1;'} name="x.ts" />,
    );
    const scope = container.querySelector('[data-file-kind="code"]');
    expect(scope).not.toBeNull();
    await waitFor(() => {
      const pre = scope!.querySelector('pre');
      expect(pre?.className ?? '').toContain('language-typescript');
    });
  });

  it('fetches textual content when only src is provided', async () => {
    fetchMock.mockResolvedValueOnce(
      makeTextResponse('{\n  "ok": true\n}\n'),
    );
    const { container } = render(
      <FilePreview src="/tmp/data.json" name="data.json" />,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-file-state="loading"]')).toBeNull(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/tmp/data.json');
    const scope = container.querySelector('[data-file-kind="code"]');
    expect(scope).not.toBeNull();
  });

  it('shows a graceful chip when the file is too large to inline', async () => {
    const big = 'x'.repeat(10);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => String(600 * 1024) },
      text: async () => big,
    });
    const { container } = render(
      <FilePreview src="/tmp/huge.json" name="huge.json" />,
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-file-state="too-large"]'),
      ).not.toBeNull(),
    );
  });

  it('renders an unknown-kind chip for extensions we do not support', () => {
    render(<FilePreview src="/tmp/archive.rar" name="archive.rar" sizeBytes={1024} />);
    const scope = document.querySelector('[data-file-kind="unknown"]');
    expect(scope).not.toBeNull();
    expect(scope!.textContent).toContain('archive.rar');
  });

  it('surfaces fetch errors in the chip caption', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    const { container } = render(
      <FilePreview src="/tmp/data.json" name="data.json" />,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-file-state="error"]')).not.toBeNull(),
    );
    const chip = container.querySelector('[data-file-state="error"]');
    expect(chip!.textContent).toContain('boom');
  });
});

describe('FilePreviewList', () => {
  it('renders one FilePreview per file entry', () => {
    const { container } = render(
      <FilePreviewList
        files={[
          { src: '/tmp/a.png', name: 'a.png' },
          { src: '/tmp/b.mp4', name: 'b.mp4' },
          { name: 'c.rar', src: '/tmp/c.rar' },
        ]}
      />,
    );
    expect(
      container.querySelectorAll('[data-file-kind]').length,
    ).toBe(3);
    expect(container.querySelector('[data-file-kind="image"]')).not.toBeNull();
    expect(container.querySelector('[data-file-kind="video"]')).not.toBeNull();
    expect(container.querySelector('[data-file-kind="unknown"]')).not.toBeNull();
  });

  it('returns nothing for an empty list', () => {
    const { container } = render(<FilePreviewList files={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
