import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  deletePreset,
  editBlocks,
  getState,
  listHistory,
  listPresets,
  pauseSession,
  resumeSession,
  savePreset,
  skipTo,
  startSession,
  stopSession,
  type Block,
} from './api';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const mockInvoke = vi.mocked(invoke);

const sample: Block = {
  id: 'a',
  name: 'Focus',
  duration_sec: 1500,
  posture: 'sit',
  mid_nudge_sec: null,
};

describe('pomodoro api', () => {
  beforeEach(() => mockInvoke.mockReset());

  it('list_presets maps to pomodoro_list_presets', async () => {
    mockInvoke.mockResolvedValue([]);
    await listPresets();
    expect(mockInvoke).toHaveBeenCalledWith('pomodoro_list_presets');
  });

  it('save_preset forwards name + blocks', async () => {
    mockInvoke.mockResolvedValue({});
    await savePreset('Day', [sample]);
    expect(mockInvoke).toHaveBeenCalledWith('pomodoro_save_preset', {
      name: 'Day',
      blocks: [sample],
    });
  });

  it('delete_preset forwards id', async () => {
    mockInvoke.mockResolvedValue(undefined);
    await deletePreset(7);
    expect(mockInvoke).toHaveBeenCalledWith('pomodoro_delete_preset', { id: 7 });
  });

  it('list_history forwards limit when given', async () => {
    mockInvoke.mockResolvedValue([]);
    await listHistory(10);
    expect(mockInvoke).toHaveBeenCalledWith('pomodoro_list_history', { limit: 10 });
  });

  it('list_history forwards null when limit omitted', async () => {
    mockInvoke.mockResolvedValue([]);
    await listHistory();
    expect(mockInvoke).toHaveBeenCalledWith('pomodoro_list_history', { limit: null });
  });

  it('get_state invokes pomodoro_get_state', async () => {
    mockInvoke.mockResolvedValue({});
    await getState();
    expect(mockInvoke).toHaveBeenCalledWith('pomodoro_get_state');
  });

  it('start_session forwards blocks + presetId', async () => {
    mockInvoke.mockResolvedValue({});
    await startSession([sample], 3);
    expect(mockInvoke).toHaveBeenCalledWith('pomodoro_start', {
      blocks: [sample],
      presetId: 3,
    });
  });

  it('start_session defaults presetId to null when omitted', async () => {
    mockInvoke.mockResolvedValue({});
    await startSession([sample]);
    expect(mockInvoke).toHaveBeenCalledWith('pomodoro_start', {
      blocks: [sample],
      presetId: null,
    });
  });

  it('pause/resume/stop invoke their commands', async () => {
    mockInvoke.mockResolvedValue({});
    await pauseSession();
    await resumeSession();
    await stopSession();
    expect(mockInvoke).toHaveBeenNthCalledWith(1, 'pomodoro_pause');
    expect(mockInvoke).toHaveBeenNthCalledWith(2, 'pomodoro_resume');
    expect(mockInvoke).toHaveBeenNthCalledWith(3, 'pomodoro_stop');
  });

  it('skip_to forwards idx', async () => {
    mockInvoke.mockResolvedValue({});
    await skipTo(2);
    expect(mockInvoke).toHaveBeenCalledWith('pomodoro_skip_to', { idx: 2 });
  });

  it('edit_blocks forwards the new list', async () => {
    mockInvoke.mockResolvedValue({});
    await editBlocks([sample]);
    expect(mockInvoke).toHaveBeenCalledWith('pomodoro_edit_blocks', {
      blocks: [sample],
    });
  });
});
