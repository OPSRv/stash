import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { NotesShell } from './NotesShell';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
const mockInvoke = vi.mocked(invoke);

// NotesShell reads a sidebar-collapsed flag from localStorage on mount; the
// test-runner's jsdom instance doesn't ship a working storage shim, so stub it.
const storageStub = (() => {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
})();
Object.defineProperty(window, 'localStorage', { value: storageStub, configurable: true });

const existing = {
  id: 1,
  title: 'Existing note',
  preview: 'Hello world',
  created_at: 100,
  updated_at: 100,
  audio_path: null,
  audio_duration_ms: null,
  pinned: false,
};

const fullExisting = {
  id: 1,
  title: 'Existing note',
  body: 'Hello world\nwith some body',
  created_at: 100,
  updated_at: 100,
  audio_path: null,
  audio_duration_ms: null,
  pinned: false,
};

// The segmented control labels each option with a title attr ("Preview only",
// "Editor only"), so we look up checked state via the title attribute. Using
// role+accessible-name breaks when the label is an sr-only span.
const segOption = (title: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[title="${title}"]`);
  if (!el) throw new Error(`segmented option not found: ${title}`);
  return el;
};

describe('NotesShell view-mode defaults', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'notes_list' || cmd === 'notes_search') return [existing];
      if (cmd === 'notes_get') return fullExisting;
      if (cmd === 'notes_create') return 42;
      return undefined;
    });
  });

  it('opens an existing note in preview mode', async () => {
    render(<NotesShell />);
    await waitFor(() =>
      expect(segOption('Preview only')).toHaveAttribute('aria-checked', 'true'),
    );
  });

  it('creating a new note switches to edit mode', async () => {
    const user = userEvent.setup();
    render(<NotesShell />);
    await screen.findByText('Existing note');

    await user.click(screen.getAllByTitle('New note (⌘N)')[0]!);

    await waitFor(() =>
      expect(segOption('Editor only')).toHaveAttribute('aria-checked', 'true'),
    );
  });

  it('clicking an existing row after editing resets to preview', async () => {
    mockInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'notes_list' || cmd === 'notes_search')
        return [existing, { ...existing, id: 2, title: 'Another', preview: 'more' }];
      if (cmd === 'notes_get') {
        const { id } = args as { id: number };
        return { ...fullExisting, id, title: id === 2 ? 'Another' : 'Existing note' };
      }
      if (cmd === 'notes_create') return 42;
      return undefined;
    });

    const user = userEvent.setup();
    render(<NotesShell />);
    await screen.findByText('Existing note');

    await user.click(screen.getAllByTitle('New note (⌘N)')[0]!);
    await waitFor(() =>
      expect(segOption('Editor only')).toHaveAttribute('aria-checked', 'true'),
    );

    await user.click(screen.getByText('Another'));
    await waitFor(() =>
      expect(segOption('Preview only')).toHaveAttribute('aria-checked', 'true'),
    );
  });
});
