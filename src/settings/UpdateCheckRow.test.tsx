import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn().mockResolvedValue('0.1.0'),
}));

// The updater plugin's `check()` is the primary path. Each test stubs the
// dynamic import with `vi.doMock` so it can decide whether the plugin says
// "update available", "no update", or "throws".
const mockUpdater = (impl: () => unknown) => {
  vi.doMock('@tauri-apps/plugin-updater', () => ({
    check: impl,
  }));
};

const mockProcess = () => {
  vi.doMock('@tauri-apps/plugin-process', () => ({
    relaunch: vi.fn().mockResolvedValue(undefined),
  }));
};

const originalFetch = globalThis.fetch;
const mockFetch = (body: unknown, ok = true, status = 200) =>
  vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response);

describe('UpdateCheckRow', () => {
  beforeEach(() => {
    vi.resetModules();
    globalThis.fetch = originalFetch;
    mockProcess();
  });

  it('reports up-to-date when plugin returns null and GitHub agrees', async () => {
    mockUpdater(() => Promise.resolve(null));
    globalThis.fetch = mockFetch({ tag_name: 'v0.1.0' }) as unknown as typeof fetch;
    const { UpdateCheckRow: Row } = await import('./UpdateCheckRow');
    render(<Row />);
    fireEvent.click(screen.getByRole('button', { name: /check for updates/i }));
    await waitFor(() => expect(screen.getByText(/latest build/i)).toBeInTheDocument());
    expect(screen.getByText(/v0\.1\.0/)).toBeInTheDocument();
  });

  it('offers Install & restart when the plugin sees a signed update', async () => {
    mockUpdater(() =>
      Promise.resolve({
        version: '0.2.0',
        downloadAndInstall: vi.fn().mockResolvedValue(undefined),
      }),
    );
    globalThis.fetch = mockFetch({ tag_name: 'v0.2.0' }) as unknown as typeof fetch;
    const { UpdateCheckRow: Row } = await import('./UpdateCheckRow');
    render(<Row />);
    fireEvent.click(screen.getByRole('button', { name: /check for updates/i }));
    await waitFor(() => expect(screen.getByText(/v0\.2\.0 is out/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /install & restart/i })).toBeInTheDocument();
  });

  it('falls back to manual download when plugin returns null but GitHub has a newer tag', async () => {
    mockUpdater(() => Promise.resolve(null));
    globalThis.fetch = mockFetch({ tag_name: 'v0.2.0' }) as unknown as typeof fetch;
    const { UpdateCheckRow: Row } = await import('./UpdateCheckRow');
    render(<Row />);
    fireEvent.click(screen.getByRole('button', { name: /check for updates/i }));
    await waitFor(() => expect(screen.getByText(/v0\.2\.0 is out/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /download \.dmg/i })).toBeInTheDocument();
  });

  it('does not prompt for update when the current build carries a nightly suffix', async () => {
    mockUpdater(() => Promise.resolve(null));
    const { getVersion } = await import('@tauri-apps/api/app');
    vi.mocked(getVersion).mockResolvedValueOnce('0.1.0-nightly+abc123');
    globalThis.fetch = mockFetch({ tag_name: 'v0.1.0' }) as unknown as typeof fetch;
    const { UpdateCheckRow: Row } = await import('./UpdateCheckRow');
    render(<Row />);
    fireEvent.click(screen.getByRole('button', { name: /check for updates/i }));
    await waitFor(() => expect(screen.getByText(/latest build/i)).toBeInTheDocument());
  });

  it('surfaces an error when both plugin and GitHub fail', async () => {
    mockUpdater(() => Promise.reject(new Error('updater offline')));
    globalThis.fetch = mockFetch({}, false, 503) as unknown as typeof fetch;
    const { UpdateCheckRow: Row } = await import('./UpdateCheckRow');
    render(<Row />);
    fireEvent.click(screen.getByRole('button', { name: /check for updates/i }));
    await waitFor(() => expect(screen.getByText(/update failed/i)).toBeInTheDocument());
  });
});
