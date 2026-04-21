import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildTrayMenuItems, pushTrayMenu, type TrayModuleInput } from './trayMenu';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
import { invoke } from '@tauri-apps/api/core';

const mods: TrayModuleInput[] = [
  { id: 'clipboard', title: 'Clipboard', tabShortcutDigit: 1 },
  { id: 'notes', title: 'Notes', tabShortcutDigit: 3 },
  { id: 'ghost', title: 'No Shortcut' },
];

describe('buildTrayMenuItems', () => {
  it('preserves module order', () => {
    const items = buildTrayMenuItems(mods, {});
    expect(items.map((i) => i.id)).toEqual(['clipboard', 'notes', 'ghost']);
  });

  it('maps tabShortcutDigit to a CmdOrCtrl+Alt accelerator', () => {
    const items = buildTrayMenuItems(mods, {});
    expect(items[0].accelerator).toBe('CmdOrCtrl+Alt+1');
    expect(items[1].accelerator).toBe('CmdOrCtrl+Alt+3');
  });

  it('omits the accelerator when tabShortcutDigit is missing', () => {
    const items = buildTrayMenuItems(mods, {});
    expect(items[2].accelerator).toBeNull();
  });

  it('forwards icon bytes when provided, null otherwise', () => {
    const items = buildTrayMenuItems(mods, { clipboard: [1, 2, 3] });
    expect(items[0].icon_png).toEqual([1, 2, 3]);
    expect(items[1].icon_png).toBeNull();
  });
});

describe('pushTrayMenu', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
  });

  it('invokes tray_set_menu with the assembled items payload', async () => {
    await pushTrayMenu([{ id: 'clipboard', title: 'Clipboard', tabShortcutDigit: 1 }]);
    expect(invoke).toHaveBeenCalledWith('tray_set_menu', {
      items: [
        expect.objectContaining({
          id: 'clipboard',
          title: 'Clipboard',
          accelerator: 'CmdOrCtrl+Alt+1',
        }),
      ],
    });
  });

  it('swallows invoke errors so a tray failure never crashes the popup boot', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('no tray'));
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(pushTrayMenu(mods)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
