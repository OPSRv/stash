import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { LinkPreview } from './api';
import { __resetLinkPreviewCache, useLinkPreview } from './useLinkPreview';

const preview = (overrides: Partial<LinkPreview> = {}): LinkPreview => ({
  url: 'https://example.com/a',
  image: 'https://cdn/og.png',
  title: 'Hello',
  description: null,
  site_name: null,
  ...overrides,
});

describe('useLinkPreview', () => {
  beforeEach(() => {
    __resetLinkPreviewCache();
    vi.mocked(invoke).mockReset();
  });

  it('returns null on the initial render and then the resolved preview', async () => {
    vi.mocked(invoke).mockResolvedValue(preview() as never);
    const { result } = renderHook(() => useLinkPreview('https://example.com/a'));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current?.title).toBe('Hello'));
  });

  it('caches the result so a second mount resolves synchronously', async () => {
    vi.mocked(invoke).mockResolvedValue(preview() as never);
    const first = renderHook(() => useLinkPreview('https://example.com/a'));
    await waitFor(() => expect(first.result.current?.title).toBe('Hello'));
    const invokeCalls = vi.mocked(invoke).mock.calls.length;

    const second = renderHook(() => useLinkPreview('https://example.com/a'));
    // Cached: no extra invoke, value available immediately.
    expect(second.result.current?.title).toBe('Hello');
    expect(vi.mocked(invoke).mock.calls.length).toBe(invokeCalls);
  });

  it('deduplicates concurrent fetches for the same URL', async () => {
    vi.mocked(invoke).mockResolvedValue(preview() as never);
    renderHook(() => useLinkPreview('https://example.com/a'));
    renderHook(() => useLinkPreview('https://example.com/a'));
    renderHook(() => useLinkPreview('https://example.com/a'));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1));
  });

  it('caches misses as null so a failed URL is not refetched', async () => {
    vi.mocked(invoke).mockResolvedValue(null as never);
    const first = renderHook(() => useLinkPreview('https://example.com/miss'));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1));
    expect(first.result.current).toBeNull();
    renderHook(() => useLinkPreview('https://example.com/miss'));
    // Still one invoke — the cached miss was reused.
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1));
  });

  it('skips fetching when enabled=false', () => {
    renderHook(() => useLinkPreview('https://example.com/a', false));
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  it('skips fetching when url is null', () => {
    renderHook(() => useLinkPreview(null));
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  it('swallows backend errors and returns null', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useLinkPreview('https://example.com/fail'));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });
});
