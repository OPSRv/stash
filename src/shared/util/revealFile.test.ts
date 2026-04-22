import { afterEach, describe, expect, it, vi } from 'vitest';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { revealFile } from './revealFile';

vi.mock('@tauri-apps/plugin-opener', () => ({
  revealItemInDir: vi.fn(),
}));

const mockedReveal = vi.mocked(revealItemInDir);

describe('revealFile', () => {
  afterEach(() => {
    mockedReveal.mockReset();
  });

  it('delegates to revealItemInDir with the given path', async () => {
    mockedReveal.mockResolvedValue(undefined);
    await revealFile('/tmp/example.txt');
    expect(mockedReveal).toHaveBeenCalledWith('/tmp/example.txt');
  });

  it('resolves to undefined when the underlying call rejects', async () => {
    mockedReveal.mockRejectedValue(new Error('no access'));
    await expect(revealFile('/tmp/missing')).resolves.toBeUndefined();
  });
});
