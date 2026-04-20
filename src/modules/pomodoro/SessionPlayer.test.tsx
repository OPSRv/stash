import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { SessionPlayer } from './SessionPlayer';
import type { SessionSnapshot } from './api';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const mockInvoke = vi.mocked(invoke);

const base: SessionSnapshot = {
  status: 'running',
  blocks: [
    { id: 'a', name: 'Focus', duration_sec: 1500, posture: 'sit', mid_nudge_sec: null },
    { id: 'b', name: 'Walk', duration_sec: 600, posture: 'walk', mid_nudge_sec: null },
  ],
  current_idx: 0,
  remaining_ms: 900_000,
  started_at: 100,
  preset_id: null,
};

describe('SessionPlayer', () => {
  beforeEach(() => mockInvoke.mockReset());

  it('formats the remaining time as mm:ss', () => {
    render(<SessionPlayer snapshot={base} banner={null} onDismissBanner={() => {}} />);
    expect(screen.getByText('15:00')).toBeInTheDocument();
  });

  it('shows the posture transition banner when provided', () => {
    render(
      <SessionPlayer
        snapshot={base}
        banner={{ from: 'sit', to: 'walk', block: 'Walk' }}
        onDismissBanner={() => {}}
      />,
    );
    expect(screen.getByText(/Стартуй доріжку/)).toBeInTheDocument();
  });

  it('Pause button invokes pomodoro_pause while running', async () => {
    mockInvoke.mockResolvedValue(base);
    const user = userEvent.setup();
    render(<SessionPlayer snapshot={base} banner={null} onDismissBanner={() => {}} />);
    await user.click(screen.getByRole('button', { name: /pause/i }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('pomodoro_pause'));
  });

  it('Resume button appears when paused and invokes pomodoro_resume', async () => {
    mockInvoke.mockResolvedValue(base);
    const user = userEvent.setup();
    render(
      <SessionPlayer
        snapshot={{ ...base, status: 'paused' }}
        banner={null}
        onDismissBanner={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /resume/i }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('pomodoro_resume'));
  });

  it('Skip to next invokes pomodoro_skip_to with current_idx + 1', async () => {
    mockInvoke.mockResolvedValue(base);
    const user = userEvent.setup();
    render(<SessionPlayer snapshot={base} banner={null} onDismissBanner={() => {}} />);
    await user.click(screen.getByRole('button', { name: /skip to next/i }));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('pomodoro_skip_to', { idx: 1 }),
    );
  });

  it('Stop flow asks for confirmation then invokes pomodoro_stop', async () => {
    mockInvoke.mockResolvedValue(base);
    const user = userEvent.setup();
    render(<SessionPlayer snapshot={base} banner={null} onDismissBanner={() => {}} />);
    await user.click(screen.getByRole('button', { name: /stop session/i }));
    await screen.findByText(/Stop this session/);
    const confirm = screen
      .getAllByRole('button', { name: /^stop$/i })
      .pop();
    await user.click(confirm!);
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('pomodoro_stop'));
  });

  it('renaming the current block invokes pomodoro_edit_blocks', async () => {
    mockInvoke.mockResolvedValue(base);
    const user = userEvent.setup();
    render(<SessionPlayer snapshot={base} banner={null} onDismissBanner={() => {}} />);
    await user.click(screen.getByRole('button', { name: /Focus/ }));
    const input = screen.getByLabelText(/Rename current block/i);
    await user.clear(input);
    await user.type(input, 'Deep work');
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        'pomodoro_edit_blocks',
        expect.objectContaining({
          blocks: expect.arrayContaining([
            expect.objectContaining({ id: 'a', name: 'Deep work' }),
          ]),
        }),
      );
    });
  });

  it('renders up-next strip with remaining blocks', () => {
    render(<SessionPlayer snapshot={base} banner={null} onDismissBanner={() => {}} />);
    expect(screen.getByText(/Up next/i)).toBeInTheDocument();
    expect(screen.getByText('10m')).toBeInTheDocument();
  });
});
