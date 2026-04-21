import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { BackupSection } from './BackupSection';
import { ToastProvider } from '../shared/ui/Toast';

const moduleList = [
  {
    id: 'settings',
    label: 'Settings',
    summary: 'Theme, shortcuts',
    size_bytes: 4096,
    available: true,
  },
  {
    id: 'notes',
    label: 'Notes',
    summary: '22 notes, 4 audio, 12 images',
    size_bytes: 12_000_000,
    available: true,
  },
  {
    id: 'ai',
    label: 'AI chats',
    summary: 'empty',
    size_bytes: 0,
    available: false,
  },
];

const renderUnit = () =>
  render(
    <ToastProvider>
      <BackupSection />
    </ToastProvider>,
  );

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(openDialog).mockReset();
  vi.mocked(saveDialog).mockReset();
});

describe('BackupSection', () => {
  it('renders one row per module and initialises selection to available modules', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'backup_describe') return moduleList;
      return undefined;
    });
    renderUnit();
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
    expect(screen.getByText('Notes')).toBeInTheDocument();
    expect(screen.getByText('AI chats')).toBeInTheDocument();

    const settingsBox = screen.getByLabelText(/Settings/i, { selector: 'input' });
    const aiBox = screen.getByLabelText(/AI chats/i, { selector: 'input' });
    expect(settingsBox).toBeChecked();
    expect(aiBox).not.toBeChecked();
    expect(aiBox).toBeDisabled();
  });

  it('wraps the save dialog with set_popup_auto_hide and invokes backup_export', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'backup_describe') return moduleList;
      if (cmd === 'backup_suggest_filename') return 'stash-backup.zip';
      if (cmd === 'backup_export') {
        return { path: '/tmp/x.zip', size_bytes: 42, modules: ['settings', 'notes'] };
      }
      return undefined;
    });
    vi.mocked(saveDialog).mockResolvedValue('/tmp/x.zip');

    renderUnit();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Notes')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /export backup/i }));

    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('backup_export', expect.any(Object)),
    );
    const calls = vi.mocked(invoke).mock.calls.map((c) => c[0]);
    // auto-hide toggled off before dialog, back on after.
    const autoHideCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([c]) => c === 'set_popup_auto_hide')
      .map(([, arg]) => (arg as { enabled: boolean }).enabled);
    expect(autoHideCalls).toContain(false);
    expect(autoHideCalls).toContain(true);
    expect(calls).toContain('backup_export');
  });

  it('toggling a checkbox changes what ends up in backup_export payload', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'backup_describe') return moduleList;
      if (cmd === 'backup_suggest_filename') return 'stash-backup.zip';
      if (cmd === 'backup_export')
        return { path: '/tmp/x.zip', size_bytes: 1, modules: [] };
      return undefined;
    });
    vi.mocked(saveDialog).mockResolvedValue('/tmp/x.zip');

    renderUnit();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Notes')).toBeInTheDocument());
    // Deselect Notes.
    await user.click(screen.getByLabelText(/Notes/i, { selector: 'input' }));
    await user.click(screen.getByRole('button', { name: /export backup/i }));

    const exportCall = vi
      .mocked(invoke)
      .mock.calls.find(([cmd]) => cmd === 'backup_export');
    expect(exportCall).toBeDefined();
    const options = (exportCall![1] as { options: { modules: string[] } }).options;
    expect(options.modules).toContain('settings');
    expect(options.modules).not.toContain('notes');
  });

  it('import flow inspects first, shows preview, then triggers backup_import on confirm', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'backup_describe') return moduleList;
      if (cmd === 'backup_inspect') {
        return {
          manifest: {
            app_version: '0.1.0',
            backup_format_version: 1,
            created_at: '2026-04-21T00:00:00Z',
            include_media: true,
            include_settings: true,
            modules: { settings: { label: 'Settings', size_bytes: 1 } },
          },
          unknown_modules: [],
          missing_modules: [],
        };
      }
      if (cmd === 'backup_import') return undefined;
      return undefined;
    });
    vi.mocked(openDialog).mockResolvedValue('/tmp/b.zip');

    renderUnit();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText('Notes')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /import backup/i }));
    // Confirm dialog appears.
    await waitFor(() =>
      expect(screen.getByText(/Restore from backup/i)).toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: /Import & Restart/i }));

    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith(
        'backup_import',
        expect.objectContaining({ path: '/tmp/b.zip' }),
      ),
    );
  });
});
