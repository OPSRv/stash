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
    kind: 'daily',
    updated_at: 100,
    blocks: [
      { id: 'a', name: 'Focus', duration_sec: 1500, posture: 'sit', mid_nudge_sec: null },
      { id: 'b', name: 'Walk', duration_sec: 600, posture: 'walk', mid_nudge_sec: null },
    ],
  },
  {
    id: 2,
    name: 'Quick focus',
    kind: 'session',
    updated_at: 50,
    blocks: [
      { id: 'c', name: 'Deep', duration_sec: 1500, posture: 'sit', mid_nudge_sec: null },
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

  it('session filter lists session presets by default', async () => {
    render(<PresetLibrary onStart={() => {}} onEdit={() => {}} onNew={() => {}} />);
    await waitFor(() => expect(screen.getByText('Quick focus')).toBeInTheDocument());
    // The Daily preset is hidden behind the filter; only its Start button
    // would carry the preset's name in text. Absence of that start button is
    // the unambiguous signal (segmented radio "Daily" is always present).
    expect(
      screen.queryByRole('button', { name: /start daily/i }),
    ).toBeNull();
  });

  it('switching filter to Daily reveals daily presets', async () => {
    const user = userEvent.setup();
    render(<PresetLibrary onStart={() => {}} onEdit={() => {}} onNew={() => {}} />);
    await screen.findByText('Quick focus');
    await user.click(screen.getByRole('radio', { name: /daily/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /start daily/i })).toBeInTheDocument(),
    );
  });

  it('shows empty state when current filter has no presets', async () => {
    mockInvoke.mockImplementation(async () => []);
    render(<PresetLibrary onStart={() => {}} onEdit={() => {}} onNew={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText(/No session presets yet/i)).toBeInTheDocument(),
    );
  });

  it('Start button invokes onStart with the preset', async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    render(<PresetLibrary onStart={onStart} onEdit={() => {}} onNew={() => {}} />);
    await screen.findByText('Quick focus');
    await user.click(screen.getByRole('button', { name: /start quick focus/i }));
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Quick focus' }),
    );
  });

  it('Delete flow confirms and invokes pomodoro_delete_preset', async () => {
    const user = userEvent.setup();
    render(<PresetLibrary onStart={() => {}} onEdit={() => {}} onNew={() => {}} />);
    await screen.findByText('Quick focus');
    await user.click(screen.getByRole('button', { name: /delete preset/i }));
    await screen.findByText(/Delete "Quick focus"/);
    const deleteBtns = screen
      .getAllByRole('button', { name: /delete/i })
      .filter((b) => b.textContent === 'Delete');
    await user.click(deleteBtns[0]!);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('pomodoro_delete_preset', { id: 2 });
    });
  });

  it('New button passes current filter to onNew', async () => {
    const user = userEvent.setup();
    const onNew = vi.fn();
    render(<PresetLibrary onStart={() => {}} onEdit={() => {}} onNew={onNew} />);
    await screen.findByText('Quick focus');
    await user.click(screen.getByRole('button', { name: /new session/i }));
    expect(onNew).toHaveBeenCalledWith('session');
  });
});
