import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { UpdateCheckRow } from './UpdateCheckRow';

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn().mockResolvedValue('0.1.0'),
}));

const originalFetch = globalThis.fetch;

const mockFetch = (body: unknown, ok = true, status = 200) =>
  vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response);

describe('UpdateCheckRow', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('reports up-to-date when current matches the latest tag', async () => {
    globalThis.fetch = mockFetch({ tag_name: 'v0.1.0' }) as unknown as typeof fetch;
    render(<UpdateCheckRow />);
    fireEvent.click(screen.getByRole('button', { name: /check for updates/i }));
    await waitFor(() => expect(screen.getByText(/latest build/i)).toBeInTheDocument());
    expect(screen.getByText(/v0\.1\.0/)).toBeInTheDocument();
  });

  it('offers download when a newer tag is available', async () => {
    globalThis.fetch = mockFetch({ tag_name: 'v0.2.0' }) as unknown as typeof fetch;
    render(<UpdateCheckRow />);
    fireEvent.click(screen.getByRole('button', { name: /check for updates/i }));
    await waitFor(() => expect(screen.getByText(/v0\.2\.0 is out/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /download \.dmg/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /release notes/i })).toBeInTheDocument();
  });

  it('does not prompt for update when the current build carries a nightly suffix', async () => {
    const { getVersion } = await import('@tauri-apps/api/app');
    vi.mocked(getVersion).mockResolvedValueOnce('0.1.0-nightly+abc123');
    globalThis.fetch = mockFetch({ tag_name: 'v0.1.0' }) as unknown as typeof fetch;
    render(<UpdateCheckRow />);
    fireEvent.click(screen.getByRole('button', { name: /check for updates/i }));
    await waitFor(() => expect(screen.getByText(/latest build/i)).toBeInTheDocument());
  });

  it('surfaces an error when the GitHub API call fails', async () => {
    globalThis.fetch = mockFetch({}, false, 503) as unknown as typeof fetch;
    render(<UpdateCheckRow />);
    fireEvent.click(screen.getByRole('button', { name: /check for updates/i }));
    await waitFor(() => expect(screen.getByText(/check failed/i)).toBeInTheDocument());
  });
});
