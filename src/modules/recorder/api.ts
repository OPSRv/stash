import { invoke } from '@tauri-apps/api/core';

export type RecorderMode = 'screen' | 'screen+cam' | 'cam';

export type RecorderStatus = {
  available: boolean;
  recording: boolean;
  last_saved: string | null;
};

export type RecorderEvent = {
  event:
    | 'ready'
    | 'recording_started'
    | 'stopped'
    | 'error'
    | 'status'
    | 'permissions'
    | 'audio_level';
  path?: string;
  message?: string;
  recording?: boolean;
  screen?: boolean;
  microphone?: boolean;
  camera?: boolean;
  source_id?: string;
  rms?: number;
};

export type CamOverlay = {
  x: number;
  y: number;
  w: number;
  h: number;
  shape?: 'rect' | 'circle';
};

export const recStart = (args: {
  mode?: RecorderMode;
  mic?: boolean;
  fps?: number;
  filename?: string;
  displayId?: string | null;
  /** AVCaptureDevice unique IDs to record as parallel audio tracks. */
  micIds?: string[];
  /** Capture desktop audio via SCStream (macOS 13+) as its own track. */
  systemAudio?: boolean;
  /** Required for `cam` and `screen+cam` modes. */
  cameraId?: string | null;
  /** Position/size/shape of the camera overlay for `screen+cam`. */
  camOverlay?: CamOverlay;
  /** Window titles SCStream should exclude from capture (e.g. camera PIP). */
  excludedWindowTitles?: string[];
  /** Per-source gain, keyed by "mic:<uniqueID>" or "system". Unity = 1.0. */
  sourceGains?: Record<string, number>;
  /** Sources that should be silent (still exist as tracks; contain silence). */
  mutedSources?: string[];
}): Promise<string> => {
  const {
    displayId,
    micIds,
    systemAudio,
    cameraId,
    camOverlay,
    excludedWindowTitles,
    sourceGains,
    mutedSources,
    ...rest
  } = args;
  return invoke('rec_start', {
    ...rest,
    display_id: displayId ?? null,
    mic_ids: micIds ?? null,
    system_audio: systemAudio ?? null,
    camera_id: cameraId ?? null,
    cam_overlay: camOverlay ?? null,
    excluded_window_titles: excludedWindowTitles ?? null,
    source_gains: sourceGains ?? null,
    muted_sources: mutedSources ?? null,
  });
};

export const recStop = (): Promise<void> => invoke('rec_stop');
export const recStatus = (): Promise<RecorderStatus> => invoke('rec_status');
export const recProbePermissions = (): Promise<void> => invoke('rec_probe_permissions');
export const recSetOutputDir = (path: string | null): Promise<void> =>
  invoke('rec_set_output_dir', { path });

export type Recording = {
  path: string;
  created_at: number;
  bytes: number;
  thumbnail: string | null;
};

export const recList = (): Promise<Recording[]> => invoke('rec_list');

export type DisplayDevice = {
  id: string;
  name: string;
  width: number;
  height: number;
  primary: boolean;
};

export type CaptureDevice = {
  id: string;
  name: string;
};

export type DevicesList = {
  displays: DisplayDevice[];
  cameras: CaptureDevice[];
  microphones: CaptureDevice[];
};

export const recListDevices = (): Promise<DevicesList> =>
  invoke('rec_list_devices');

/// Title of the camera PIP window — Swift filters SCStream windows by this
/// exact title, so it must round-trip unchanged between Rust and the helper.
export const CAMERA_PIP_TITLE = 'Stash Camera';

export const camPipShow = (args: {
  cameraLabel?: string;
  shape?: 'rect' | 'circle';
}): Promise<void> =>
  invoke('cam_pip_show', {
    cameraLabel: args.cameraLabel ?? null,
    shape: args.shape ?? null,
  });

export const camPipHide = (): Promise<void> => invoke('cam_pip_hide');


export const recDelete = (path: string): Promise<void> =>
  invoke('rec_delete', { path });
export const recTrim = (
  source: string,
  start: number,
  end: number
): Promise<string> => invoke('rec_trim', { source, start, end });
