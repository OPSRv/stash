import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';

import { FoldersSidebar } from './FoldersSidebar';
import type { NoteFolder } from './api';

const mockFolders = (folders: NoteFolder[]) => {
  let next = folders.slice();
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    switch (cmd) {
      case 'notes_folders_list':
        return next as never;
      case 'notes_folder_create': {
        const a = args as { name: string };
        const id = next.length + 100;
        next = [
          ...next,
          { id, name: a.name, sort_order: next.length, created_at: 0 },
        ];
        return id as never;
      }
      case 'notes_folder_rename': {
        const a = args as { id: number; name: string };
        next = next.map((f) => (f.id === a.id ? { ...f, name: a.name } : f));
        return undefined as never;
      }
      case 'notes_folder_delete': {
        const a = args as { id: number };
        next = next.filter((f) => f.id !== a.id);
        return undefined as never;
      }
      default:
        return [] as never;
    }
  });
};

describe('<FoldersSidebar />', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('lists pre-existing folders alongside All / Unfiled rows', async () => {
    mockFolders([
      { id: 1, name: 'Work', sort_order: 0, created_at: 0 },
      { id: 2, name: 'Personal', sort_order: 1, created_at: 0 },
    ]);
    render(<FoldersSidebar selected="all" onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByText('Work')).toBeInTheDocument());
    expect(screen.getByText('All notes')).toBeInTheDocument();
    expect(screen.getByText('Unfiled')).toBeInTheDocument();
    expect(screen.getByText('Personal')).toBeInTheDocument();
  });

  it('creates a new folder and selects it', async () => {
    mockFolders([]);
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<FoldersSidebar selected="all" onSelect={onSelect} />);
    await user.click(screen.getByLabelText('New folder'));
    const input = screen.getByLabelText('New folder name');
    await user.type(input, 'Inbox{enter}');
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('notes_folder_create', { name: 'Inbox' });
    });
    expect(onSelect).toHaveBeenCalledWith(100);
  });

  it('selecting a folder invokes onSelect with that folder id', async () => {
    mockFolders([{ id: 5, name: 'Recipes', sort_order: 0, created_at: 0 }]);
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<FoldersSidebar selected="all" onSelect={onSelect} />);
    const row = await screen.findByText('Recipes');
    await user.click(row);
    expect(onSelect).toHaveBeenCalledWith(5);
  });

  it('selecting Unfiled invokes onSelect with "unfiled"', async () => {
    mockFolders([]);
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<FoldersSidebar selected="all" onSelect={onSelect} />);
    await user.click(screen.getByText('Unfiled'));
    expect(onSelect).toHaveBeenCalledWith('unfiled');
  });

  it('right-click on a folder opens a context menu with Rename and Delete', async () => {
    mockFolders([{ id: 3, name: 'Work', sort_order: 0, created_at: 0 }]);
    const user = userEvent.setup();
    render(<FoldersSidebar selected="all" onSelect={() => {}} />);
    const folderRow = (await screen.findByText('Work')).closest('[role="button"]') as HTMLElement;
    await user.pointer({ keys: '[MouseRight>]', target: folderRow });
    const menu = await screen.findByRole('menu');
    expect(menu).toHaveAccessibleName('Actions for folder Work');
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('right-click never opens a menu on All notes / Unfiled', async () => {
    mockFolders([]);
    const user = userEvent.setup();
    render(<FoldersSidebar selected="all" onSelect={() => {}} />);
    const all = screen.getByText('All notes').closest('[role="button"]') as HTMLElement;
    await user.pointer({ keys: '[MouseRight>]', target: all });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('Rename in the context menu enters inline edit mode', async () => {
    mockFolders([{ id: 3, name: 'Work', sort_order: 0, created_at: 0 }]);
    const user = userEvent.setup();
    render(<FoldersSidebar selected="all" onSelect={() => {}} />);
    const folderRow = (await screen.findByText('Work')).closest('[role="button"]') as HTMLElement;
    await user.pointer({ keys: '[MouseRight>]', target: folderRow });
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = await screen.findByDisplayValue('Work');
    await user.clear(input);
    await user.type(input, 'Personal{enter}');
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('notes_folder_rename', {
        id: 3,
        name: 'Personal',
      });
    });
  });
});
