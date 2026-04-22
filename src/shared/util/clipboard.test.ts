import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { copyText } from './clipboard';

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: vi.fn(),
}));

const mockedTauri = vi.mocked(writeText);

describe('copyText', () => {
  afterEach(() => {
    mockedTauri.mockReset();
  });

  it('uses the Tauri writer on the happy path', async () => {
    mockedTauri.mockResolvedValue(undefined);
    await expect(copyText('hello')).resolves.toBe(true);
    expect(mockedTauri).toHaveBeenCalledWith('hello');
  });

  it('falls back to navigator.clipboard when Tauri throws', async () => {
    mockedTauri.mockRejectedValue(new Error('no runtime'));
    const browserWrite = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText: browserWrite } });
    await expect(copyText('fallback')).resolves.toBe(true);
    expect(browserWrite).toHaveBeenCalledWith('fallback');
    vi.unstubAllGlobals();
  });

  it('returns false when both writers fail', async () => {
    mockedTauri.mockRejectedValue(new Error('no runtime'));
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(copyText('bad')).resolves.toBe(false);
    errSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});
