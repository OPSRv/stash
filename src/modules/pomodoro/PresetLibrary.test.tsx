import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { PresetLibrary } from './PresetLibrary';
import type { Preset } from './api';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const mockInvoke = vi.mocked(invoke);

const presets: Preset[] = [
  {
    id: 1,
    name: 'Daily',
    updated_at: 100,
    blocks: [
      { id: 'a', name: 'Focus', duration_sec: 1500, posture: 'sit', mid_nudge_sec: null },
      { id: 'b', name: 'Walk', duration_sec: 600, posture: 'walk', mid_nudge_sec: null },
    ],
  },
];

describe('PresetLibrary', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'pomodoro_list_presets') return presets;
      return undefined;
    });
  });

  it('lists presets on mount', async () => {
    render(<PresetLibrary onStart={() => {}} onEdit={() => {}} onNew={() => {}} />);
    await waitFor(() => expect(screen.getByText('Daily')).toBeInTheDocument());
    expect(screen.getByText(/2 blocks/)).toBeInTheDocument();
  });

  it('shows empty state when there are no presets', async () => {
    mockInvoke.mockImplementation(async () => []);
    render(<PresetLibrary onStart={() => {}} onEdit={() => {}} onNew={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText(/No presets yet/i)).toBeInTheDocument(),
    );
  });

  it('Start button invokes onStart with the preset', async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    render(<PresetLibrary onStart={onStart} onEdit={() => {}} onNew={() => {}} />);
    await screen.findByText('Daily');
    await user.click(screen.getByRole('button', { name: /^start$/i }));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ name: 'Daily' }));
  });

  it('Delete flow confirms and invokes pomodoro_delete_preset', async () => {
    const user = userEvent.setup();
    render(<PresetLibrary onStart={() => {}} onEdit={() => {}} onNew={() => {}} />);
    await screen.findByText('Daily');
    await user.click(screen.getByRole('button', { name: /delete preset/i }));
    await screen.findByText(/Delete "Daily"/);
    const deleteBtns = screen
      .getAllByRole('button', { name: /delete/i })
      .filter((b) => b.textContent === 'Delete');
    await user.click(deleteBtns[0]!);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('pomodoro_delete_preset', { id: 1 });
    });
  });
});
