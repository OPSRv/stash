import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

import * as api from './api';

describe('telegram api', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('setToken forwards token to telegram_set_token', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await api.setToken('123:abc');
    expect(invoke).toHaveBeenCalledWith('telegram_set_token', { token: '123:abc' });
  });

  it('hasToken unwraps the boolean', async () => {
    vi.mocked(invoke).mockResolvedValue(true);
    await expect(api.hasToken()).resolves.toBe(true);
  });

  it('startPairing returns the pairing status shape', async () => {
    vi.mocked(invoke).mockResolvedValue({
      kind: 'pairing',
      code: '123456',
      expires_at: 1000,
    });
    const s = await api.startPairing();
    expect(s).toEqual({ kind: 'pairing', code: '123456', expires_at: 1000 });
    expect(invoke).toHaveBeenCalledWith('telegram_start_pairing');
  });

  it('unpair calls telegram_unpair', async () => {
    vi.mocked(invoke).mockResolvedValue({ kind: 'token_only' });
    await api.unpair();
    expect(invoke).toHaveBeenCalledWith('telegram_unpair');
  });

  it('listInbox forwards the limit', async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await api.listInbox(50);
    expect(invoke).toHaveBeenCalledWith('telegram_list_inbox', { limit: 50 });
  });

  it('markInboxRouted forwards id and target', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await api.markInboxRouted(7, 'notes');
    expect(invoke).toHaveBeenCalledWith('telegram_mark_inbox_routed', {
      id: 7,
      target: 'notes',
    });
  });

  it('deleteInboxItem forwards id', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await api.deleteInboxItem(9);
    expect(invoke).toHaveBeenCalledWith('telegram_delete_inbox_item', { id: 9 });
  });
});
