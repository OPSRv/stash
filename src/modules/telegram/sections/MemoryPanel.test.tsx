import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryPanel } from './MemoryPanel';

const invokeMock = vi.mocked(invoke);

describe('MemoryPanel', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('lists facts returned by telegram_list_memory', async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === 'telegram_list_memory') {
        return [
          { id: 2, fact: 'works from Kyiv', created_at: 2 },
          { id: 1, fact: 'likes tea', created_at: 1 },
        ];
      }
      return null;
    });

    render(<MemoryPanel />);
    await screen.findByText('works from Kyiv');
    expect(screen.getByText('likes tea')).toBeInTheDocument();
  });

  it('shows an empty-state hint when no facts are stored', async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === 'telegram_list_memory') return [];
      return null;
    });
    render(<MemoryPanel />);
    await screen.findByText(/No facts yet/);
  });

  it('deletes a fact optimistically on button click', async () => {
    let rows = [
      { id: 2, fact: 'works from Kyiv', created_at: 2 },
      { id: 1, fact: 'likes tea', created_at: 1 },
    ];
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === 'telegram_list_memory') return rows;
      if (cmd === 'telegram_delete_memory') {
        const id = (args as { id: number }).id;
        rows = rows.filter((r) => r.id !== id);
        return true;
      }
      return null;
    });

    render(<MemoryPanel />);
    await screen.findByText('likes tea');
    const btn = screen.getByRole('button', { name: /Delete fact 1/ });
    await userEvent.click(btn);
    await waitFor(() => {
      expect(screen.queryByText('likes tea')).toBeNull();
    });
    expect(invokeMock).toHaveBeenCalledWith('telegram_delete_memory', {
      id: 1,
    });
  });

  it('surfaces a load error without crashing', async () => {
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === 'telegram_list_memory') throw new Error('db busy');
      return null;
    });
    render(<MemoryPanel />);
    // Loader never advances — error lives alongside null rows.
    await waitFor(() => {
      expect(screen.queryByText(/Loading facts/)).toBeInTheDocument();
    });
  });
});
