import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { ToastProvider } from '../../shared/ui/Toast';
import { CachesPanel } from './CachesPanel';
import { LaunchAgentsPanel } from './LaunchAgentsPanel';
import { UninstallerPanel } from './UninstallerPanel';

const wrap = (node: React.ReactNode) => render(<ToastProvider>{node}</ToastProvider>);

describe('CachesPanel', () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it('shows caches and totals', async () => {
    vi.mocked(invoke).mockResolvedValue([
      {
        label: 'Xcode DerivedData',
        path: '/u/Library/Developer/Xcode/DerivedData',
        size_bytes: 2_000_000_000,
        kind: 'regeneratable',
      },
      {
        label: 'npm cache',
        path: '/u/.npm',
        size_bytes: 500_000_000,
        kind: 'safe',
      },
    ]);
    wrap(<CachesPanel />);
    await waitFor(() =>
      expect(screen.getByText('Xcode DerivedData')).toBeInTheDocument(),
    );
    expect(screen.getByText('npm cache')).toBeInTheDocument();
    // Header total sums both caches.
    expect(screen.getByText(/2\.33 GB/)).toBeInTheDocument();
  });

  it('sends trash invocations for selected items on confirm', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'system_list_caches') {
        return [
          {
            label: 'Yarn',
            path: '/u/Library/Caches/Yarn',
            size_bytes: 200 * 1024 * 1024,
            kind: 'safe',
          },
        ];
      }
      return undefined;
    });
    wrap(<CachesPanel />);
    await waitFor(() => expect(screen.getByText('Yarn')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Yarn'));
    fireEvent.click(screen.getByRole('button', { name: 'Trash' }));
    // Two "Trash" buttons now exist: the toolbar one is still in the DOM,
    // the dialog confirm was just opened. Take the one inside role=dialog.
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(
      [...dialog.querySelectorAll('button')].find((b) =>
        /Trash/.test(b.textContent ?? ''),
      )!,
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('system_trash_path', {
        path: '/u/Library/Caches/Yarn',
      }),
    );
  });
});

describe('LaunchAgentsPanel', () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it('groups agents by scope and toggles via launchctl', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'system_list_launch_agents') {
        return [
          {
            label: 'com.example.user-agent',
            path: '/u/Library/LaunchAgents/com.example.user-agent.plist',
            scope: 'user',
            disabled: false,
            pid: 1234,
          },
          {
            label: 'com.example.sys-agent',
            path: '/Library/LaunchAgents/com.example.sys-agent.plist',
            scope: 'system',
            disabled: true,
            pid: null,
          },
        ];
      }
      return undefined;
    });
    wrap(<LaunchAgentsPanel />);
    await waitFor(() =>
      expect(screen.getByText('com.example.user-agent')).toBeInTheDocument(),
    );
    expect(screen.getByText(/User \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/System \(1\)/)).toBeInTheDocument();

    const switches = screen.getAllByRole('switch');
    // First agent is loaded (user) — clicking should disable it.
    fireEvent.click(switches[0]);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('system_toggle_launch_agent', {
        path: '/u/Library/LaunchAgents/com.example.user-agent.plist',
        enable: false,
      }),
    );
  });
});

describe('UninstallerPanel', () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it('lists apps and shows leftovers after selection', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'system_list_apps') {
        return [
          {
            name: 'Widget',
            path: '/Applications/Widget.app',
            bundle_id: 'com.example.Widget',
            size_bytes: 50 * 1024 * 1024,
          },
        ];
      }
      if (cmd === 'system_find_leftovers') {
        return [
          {
            path: '/u/Library/Application Support/com.example.Widget',
            size_bytes: 20 * 1024 * 1024,
          },
        ];
      }
      return undefined;
    });
    wrap(<UninstallerPanel />);
    await waitFor(() => expect(screen.getByText('Widget')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Widget'));
    await waitFor(() =>
      expect(
        screen.getByText('/u/Library/Application Support/com.example.Widget'),
      ).toBeInTheDocument(),
    );
  });
});
