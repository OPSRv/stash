import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { usePomodoroEngine } from './usePomodoroEngine';
import type { SessionSnapshot } from '../api';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

type Handler = (ev: { payload: unknown }) => void;

const makeRunningSnap = (remaining_ms: number): SessionSnapshot => ({
  status: 'running',
  blocks: [
    {
      id: 'a',
      name: 'Focus',
      duration_sec: 1500,
      posture: 'sit',
      mid_nudge_sec: null,
    },
  ],
  current_idx: 0,
  remaining_ms,
  started_at: 100,
  preset_id: null,
});

describe('usePomodoroEngine', () => {
  let handlers: Record<string, Handler>;

  beforeEach(() => {
    handlers = {};
    mockInvoke.mockReset();
    mockListen.mockReset();
    mockInvoke.mockResolvedValue(makeRunningSnap(900_000));
    mockListen.mockImplementation(async (name: string, h: unknown) => {
      handlers[name] = h as Handler;
      return () => {
        delete handlers[name];
      };
    });
  });

  it('loads initial snapshot on mount via pomodoro_get_state', async () => {
    const { result } = renderHook(() => usePomodoroEngine());
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('pomodoro_get_state'),
    );
    await waitFor(() => expect(result.current.snapshot.status).toBe('running'));
    expect(result.current.snapshot.remaining_ms).toBe(900_000);
  });

  it('updates remaining_ms from pomodoro:tick events', async () => {
    const { result } = renderHook(() => usePomodoroEngine());
    await waitFor(() => expect(handlers['pomodoro:tick']).toBeDefined());
    act(() => handlers['pomodoro:tick']!({ payload: makeRunningSnap(500_000) }));
    await waitFor(() =>
      expect(result.current.snapshot.remaining_ms).toBe(500_000),
    );
  });

  it('routes block_changed through onTransition callback', async () => {
    const onTransition = vi.fn();
    renderHook(() => usePomodoroEngine({ onTransition }));
    await waitFor(() =>
      expect(handlers['pomodoro:block_changed']).toBeDefined(),
    );
    act(() =>
      handlers['pomodoro:block_changed']!({
        payload: {
          kind: 'block_changed',
          from_idx: 0,
          to_idx: 1,
          from_posture: 'sit',
          to_posture: 'walk',
          block_name: 'Walk',
        },
      }),
    );
    expect(onTransition).toHaveBeenCalledWith(
      expect.objectContaining({ to_posture: 'walk' }),
    );
  });

  it('routes nudge through onNudge callback', async () => {
    const onNudge = vi.fn();
    renderHook(() => usePomodoroEngine({ onNudge }));
    await waitFor(() => expect(handlers['pomodoro:nudge']).toBeDefined());
    act(() =>
      handlers['pomodoro:nudge']!({
        payload: {
          kind: 'nudge',
          block_idx: 0,
          block_name: 'Focus',
          text: 'Розімни спину',
        },
      }),
    );
    expect(onNudge).toHaveBeenCalled();
  });
});
