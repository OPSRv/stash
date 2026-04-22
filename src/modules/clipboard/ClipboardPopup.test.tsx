import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ClipboardPopup } from './ClipboardPopup';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const mockInvoke = vi.mocked(invoke);

const items = [
  { id: 1, content: 'pinned link', created_at: 100, pinned: true },
  { id: 2, content: 'recent note', created_at: 200, pinned: false },
  { id: 3, content: 'older note', created_at: 150, pinned: false },
];

describe('ClipboardPopup', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'clipboard_list') return items;
      if (cmd === 'clipboard_search') {
        const q = String((args as { query?: string } | undefined)?.query ?? '').toLowerCase();
        if (!q) return items;
        return items.filter((i) => i.content.toLowerCase().includes(q));
      }
      return undefined;
    });
  });

  it('lists items on mount', async () => {
    render(<ClipboardPopup />);
    await waitFor(() => {
      expect(screen.getByText('pinned link')).toBeInTheDocument();
      expect(screen.getByText('recent note')).toBeInTheDocument();
    });
  });

  it('groups pinned items under a Pinned section', async () => {
    render(<ClipboardPopup />);
    await waitFor(() => expect(screen.getByText('pinned link')).toBeInTheDocument());
    expect(screen.getByText('Pinned')).toBeInTheDocument();
  });

  it('groups unpinned items under a Recent section', async () => {
    render(<ClipboardPopup />);
    await waitFor(() => expect(screen.getByText('recent note')).toBeInTheDocument());
    expect(screen.getByText('Recent')).toBeInTheDocument();
  });

  it('filters items when user types in search', async () => {
    const user = userEvent.setup();
    render(<ClipboardPopup />);
    await waitFor(() => expect(screen.getByText('pinned link')).toBeInTheDocument());

    await user.type(screen.getByRole('searchbox'), 'recent');

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('clipboard_search', { query: 'recent' });
    });
  });

  it('shows empty state when no items match', async () => {
    mockInvoke.mockImplementation(async () => []);
    render(<ClipboardPopup />);
    await waitFor(() => {
      expect(screen.getByText(/nothing copied yet/i)).toBeInTheDocument();
    });
  });

  it('Enter triggers clipboard_paste for active item', async () => {
    const user = userEvent.setup();
    render(<ClipboardPopup />);
    await waitFor(() => expect(screen.getByText('pinned link')).toBeInTheDocument());

    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('clipboard_paste', { id: 1 });
    });
  });

  it('clicking a row copies instead of pasting and keeps the popup open', async () => {
    const user = userEvent.setup();
    render(<ClipboardPopup />);
    await waitFor(() => expect(screen.getByText('recent note')).toBeInTheDocument());

    await user.click(screen.getByText('recent note'));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('clipboard_copy_only', { id: 2 });
    });
    expect(mockInvoke).not.toHaveBeenCalledWith('clipboard_paste', { id: 2 });
  });

  it('Meta+P toggles pin on active item', async () => {
    const user = userEvent.setup();
    render(<ClipboardPopup />);
    await waitFor(() => expect(screen.getByText('pinned link')).toBeInTheDocument());

    await user.keyboard('{Meta>}p{/Meta}');

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('clipboard_toggle_pin', { id: 1 });
    });
  });

  it('Backspace opens a delete confirmation (not immediate delete)', async () => {
    const user = userEvent.setup();
    render(<ClipboardPopup />);
    await waitFor(() => expect(screen.getByText('pinned link')).toBeInTheDocument());

    await user.keyboard('{Backspace}');

    expect(await screen.findByText('Delete this item?')).toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalledWith('clipboard_delete', { id: 1 });
  });

  it('confirming the dialog performs the delete', async () => {
    const user = userEvent.setup();
    render(<ClipboardPopup />);
    await waitFor(() => expect(screen.getByText('pinned link')).toBeInTheDocument());

    await user.keyboard('{Backspace}');
    await screen.findByText('Delete this item?');
    const deleteButtons = screen.getAllByText('Delete').filter((el) => el.tagName === 'BUTTON');
    await user.click(deleteButtons[deleteButtons.length - 1]!);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('clipboard_delete', { id: 1 });
    });
  });

  describe('kind=file rows', () => {
    const fileItems = [
      {
        id: 10,
        kind: 'file',
        content: 'files:abc',
        meta: JSON.stringify({
          files: [
            { path: '/tmp/hello.txt', name: 'hello.txt', size: 42, mime: 'text/plain' },
          ],
        }),
        created_at: 300,
        pinned: false,
      },
      {
        id: 11,
        kind: 'file',
        content: 'files:def',
        meta: JSON.stringify({
          files: [
            { path: '/tmp/a.png', name: 'a.png', size: 10, mime: 'image/png' },
            { path: '/tmp/b.mp4', name: 'b.mp4', size: 20, mime: 'video/mp4' },
            { path: '/tmp/c.txt', name: 'c.txt', size: 30, mime: 'text/plain' },
          ],
        }),
        created_at: 350,
        pinned: false,
      },
    ];

    beforeEach(() => {
      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === 'clipboard_list') return fileItems;
        if (cmd === 'clipboard_search') return fileItems;
        return undefined;
      });
    });

    it('renders the single-file row with its filename as primary', async () => {
      render(<ClipboardPopup />);
      expect(await screen.findByText('hello.txt')).toBeInTheDocument();
    });

    it('summarises multi-file rows as "N files"', async () => {
      render(<ClipboardPopup />);
      expect(await screen.findByText(/^3 files · a\.png/)).toBeInTheDocument();
    });

    it('Reveal button calls the opener plugin', async () => {
      const user = userEvent.setup();
      render(<ClipboardPopup />);
      await screen.findByText('hello.txt');
      const revealBtn = screen.getAllByLabelText('Reveal in Finder')[0];
      await user.click(revealBtn);
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await waitFor(() => {
        expect(revealItemInDir).toHaveBeenCalledWith('/tmp/hello.txt');
      });
    });

    it('Open button calls openPath with the file path', async () => {
      const user = userEvent.setup();
      render(<ClipboardPopup />);
      await screen.findByText('hello.txt');
      const openBtn = screen.getAllByLabelText('Open with default app')[0];
      await user.click(openBtn);
      const { openPath } = await import('@tauri-apps/plugin-opener');
      await waitFor(() => {
        expect(openPath).toHaveBeenCalledWith('/tmp/hello.txt');
      });
    });

    it('Enter on a file row triggers clipboard_paste (the Rust side writes NSPasteboard)', async () => {
      const user = userEvent.setup();
      render(<ClipboardPopup />);
      await screen.findByText('hello.txt');
      await user.keyboard('{Enter}');
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('clipboard_paste', { id: 10 });
      });
    });

    it('Files filter tab restricts the list to file rows, and ⌘5 activates it', async () => {
      const user = userEvent.setup();
      mockInvoke.mockImplementation(async (cmd) => {
        if (cmd === 'clipboard_list')
          return [
            ...fileItems,
            {
              id: 99,
              kind: 'text',
              content: 'plain note',
              meta: null,
              created_at: 400,
              pinned: false,
            },
          ];
        if (cmd === 'clipboard_search') return fileItems;
        return undefined;
      });
      render(<ClipboardPopup />);
      await screen.findByText('plain note');
      await user.keyboard('{Meta>}5{/Meta}');
      // File rows still present…
      expect(screen.getByText('hello.txt')).toBeInTheDocument();
      // …but the text row is filtered out.
      expect(screen.queryByText('plain note')).toBeNull();
    });
  });
});
