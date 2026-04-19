import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  recDelete,
  recList,
  recListDevices,
  recProbePermissions,
  recSetOutputDir,
  recStart,
  recStatus,
  recStop,
  recTrim,
} from './api';

describe('recorder/api', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined as never);
  });

  it('recStart passes through mode/mic/fps/filename/displayId', async () => {
    vi.mocked(invoke).mockResolvedValue('/tmp/out.mov' as never);
    const p = await recStart({
      mode: 'screen',
      mic: true,
      fps: 30,
      filename: 'x.mov',
      displayId: '69733378',
    });
    expect(p).toBe('/tmp/out.mov');
    expect(invoke).toHaveBeenCalledWith('rec_start', {
      mode: 'screen',
      mic: true,
      fps: 30,
      filename: 'x.mov',
      display_id: '69733378',
      mic_ids: null,
      system_audio: null,
      camera_id: null,
      cam_overlay: null,
      excluded_window_titles: null,
      source_gains: null,
      muted_sources: null,
    });
  });

  it('recStart defaults display_id / mic_ids / system_audio to null when omitted', async () => {
    vi.mocked(invoke).mockResolvedValue('/tmp/out.mov' as never);
    await recStart({ mode: 'screen' });
    expect(invoke).toHaveBeenCalledWith('rec_start', {
      mode: 'screen',
      display_id: null,
      mic_ids: null,
      system_audio: null,
      camera_id: null,
      cam_overlay: null,
      excluded_window_titles: null,
      source_gains: null,
      muted_sources: null,
    });
  });

  it('recStart forwards micIds + systemAudio as snake-case', async () => {
    vi.mocked(invoke).mockResolvedValue('/tmp/out.mov' as never);
    await recStart({
      mode: 'screen',
      micIds: ['BuiltInMic', 'USBMic'],
      systemAudio: true,
    });
    expect(invoke).toHaveBeenCalledWith('rec_start', {
      mode: 'screen',
      display_id: null,
      mic_ids: ['BuiltInMic', 'USBMic'],
      system_audio: true,
      camera_id: null,
      cam_overlay: null,
      excluded_window_titles: null,
      source_gains: null,
      muted_sources: null,
    });
  });

  it('recStart forwards cameraId + camOverlay for screen+cam', async () => {
    vi.mocked(invoke).mockResolvedValue('/tmp/out.mov' as never);
    await recStart({
      mode: 'screen+cam',
      cameraId: 'FaceTime',
      camOverlay: { x: 100, y: 100, w: 320, h: 240, shape: 'circle' },
    });
    expect(invoke).toHaveBeenCalledWith('rec_start', {
      mode: 'screen+cam',
      display_id: null,
      mic_ids: null,
      system_audio: null,
      camera_id: 'FaceTime',
      cam_overlay: { x: 100, y: 100, w: 320, h: 240, shape: 'circle' },
      excluded_window_titles: null,
      source_gains: null,
      muted_sources: null,
    });
  });

  it('recStop / recStatus / recProbePermissions are argument-less', async () => {
    await recStop();
    await recStatus();
    await recProbePermissions();
    expect(invoke).toHaveBeenCalledWith('rec_stop');
    expect(invoke).toHaveBeenCalledWith('rec_status');
    expect(invoke).toHaveBeenCalledWith('rec_probe_permissions');
  });

  it('recSetOutputDir forwards { path }', async () => {
    await recSetOutputDir('/tmp/recs');
    await recSetOutputDir(null);
    expect(invoke).toHaveBeenCalledWith('rec_set_output_dir', { path: '/tmp/recs' });
    expect(invoke).toHaveBeenCalledWith('rec_set_output_dir', { path: null });
  });

  it('recList is argument-less', async () => {
    await recList();
    expect(invoke).toHaveBeenCalledWith('rec_list');
  });

  it('recDelete forwards path', async () => {
    await recDelete('/tmp/x.mov');
    expect(invoke).toHaveBeenCalledWith('rec_delete', { path: '/tmp/x.mov' });
  });

  it('recListDevices invokes rec_list_devices and returns typed devices', async () => {
    const payload = {
      displays: [{ id: '1', name: 'Studio', width: 5120, height: 2880, primary: true }],
      cameras: [{ id: 'c1', name: 'FaceTime HD' }],
      microphones: [{ id: 'm1', name: 'Built-in' }],
    };
    vi.mocked(invoke).mockResolvedValue(payload as never);
    const out = await recListDevices();
    expect(invoke).toHaveBeenCalledWith('rec_list_devices');
    expect(out).toEqual(payload);
  });

  it('recTrim forwards source/start/end', async () => {
    vi.mocked(invoke).mockResolvedValue('/tmp/out.mov' as never);
    const p = await recTrim('/tmp/src.mov', 1.5, 4.2);
    expect(p).toBe('/tmp/out.mov');
    expect(invoke).toHaveBeenCalledWith('rec_trim', {
      source: '/tmp/src.mov',
      start: 1.5,
      end: 4.2,
    });
  });
});
