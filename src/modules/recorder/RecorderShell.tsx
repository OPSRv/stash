import React, { useCallback, useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { availableMonitors } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import {
  camPipHide,
  camPipShow,
  CAMERA_PIP_TITLE,
  recDelete,
  recList,
  recListDevices,
  recProbePermissions,
  recStart,
  recStatus,
  recStop,
  recTrim,
  type CamOverlay,
  type DevicesList,
  type DisplayDevice,
  type Recording,
  type RecorderEvent,
  type RecorderMode,
  type RecorderStatus,
} from './api';
import { VideoPlayer } from '../../shared/ui/VideoPlayer';
import { Button } from '../../shared/ui/Button';
import { SegmentedControl } from '../../shared/ui/SegmentedControl';
import { Select } from '../../shared/ui/Select';
import { TrimDialog } from './TrimDialog';
import { LevelMeter } from './LevelMeter';
import { AudioSourceRow } from './AudioSourceRow';
import { PermissionBanner } from './PermissionBanner';
import { RecordPill } from './RecordPill';
import { SectionHeader } from './SectionHeader';
import { CamIcon, ScreenCamIcon, ScreenIcon } from './icons';

const modes: { id: RecorderMode; label: string; Icon: () => React.ReactNode }[] = [
  { id: 'screen', label: 'Screen', Icon: ScreenIcon },
  { id: 'screen+cam', label: 'Screen + Cam', Icon: ScreenCamIcon },
  { id: 'cam', label: 'Camera only', Icon: CamIcon },
];

type OverlayShape = 'rect' | 'circle';

const SYSTEM_SOURCE_ID = 'system';
const micSourceId = (deviceId: string) => `mic:${deviceId}`;

/// Read the camera PIP window's current position/size from the OS and
/// express it as a `CamOverlay` in the pixel space of `display`. Returns
/// null when the PIP is gone or on a different monitor than the one being
/// recorded — the caller treats that as "no overlay".
const captureOverlayFromPip = async (
  display: DisplayDevice | undefined,
  shape: OverlayShape,
): Promise<CamOverlay | null> => {
  if (!display) return null;
  const pip = await WebviewWindow.getByLabel('camera-pip');
  if (!pip) return null;
  const pos = await pip.outerPosition();
  const size = await pip.outerSize();
  const monitors = await availableMonitors();
  const mon = monitors.find(
    (m) => m.size.width === display.width && m.size.height === display.height,
  );
  if (!mon) return null;
  return {
    x: pos.x - mon.position.x,
    y: pos.y - mon.position.y,
    w: size.width,
    h: size.height,
    shape,
  };
};

const formatBytes = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const formatElapsed = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

export const RecorderShell = () => {
  const [devices, setDevices] = useState<DevicesList>({
    displays: [],
    cameras: [],
    microphones: [],
  });
  const [devicesError, setDevicesError] = useState<string | null>(null);

  const [mode, setMode] = useState<RecorderMode>('screen');
  const [displayId, setDisplayId] = useState<string>('');
  const [cameraId, setCameraId] = useState<string>('');
  const [micIds, setMicIds] = useState<string[]>([]);
  const [systemAudio, setSystemAudio] = useState(false);
  const [overlayShape, setOverlayShape] = useState<OverlayShape>('circle');
  const [gains, setGains] = useState<Record<string, number>>({});
  const [muted, setMuted] = useState<Set<string>>(new Set());

  const [status, setStatus] = useState<RecorderStatus | null>(null);
  const [permissions, setPermissions] = useState<{
    screen?: boolean;
    microphone?: boolean;
    camera?: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState<string | null>(null);
  const [trimTarget, setTrimTarget] = useState<string | null>(null);
  const [history, setHistory] = useState<Recording[]>([]);
  const countdownRef = useRef<number | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [pipDismissed, setPipDismissed] = useState(false);

  const reloadStatus = useCallback(() => {
    recStatus()
      .then(setStatus)
      .catch((e) => setError(String(e)));
    recList()
      .then(setHistory)
      .catch(() => {});
  }, []);

  const reloadDevices = useCallback(async () => {
    try {
      const list = await recListDevices();
      setDevices(list);
      setDevicesError(null);
      setDisplayId((cur) => {
        if (cur && list.displays.some((d) => d.id === cur)) return cur;
        return list.displays.find((d) => d.primary)?.id ?? list.displays[0]?.id ?? '';
      });
      setCameraId((cur) => {
        if (cur && list.cameras.some((c) => c.id === cur)) return cur;
        return list.cameras[0]?.id ?? '';
      });
      setMicIds((cur) => {
        const valid = cur.filter((id) => list.microphones.some((m) => m.id === id));
        if (valid.length) return valid;
        return list.microphones[0] ? [list.microphones[0].id] : [];
      });
    } catch (e) {
      setDevicesError(String(e));
    }
  }, []);

  useEffect(() => {
    reloadStatus();
  }, [reloadStatus]);

  useEffect(() => {
    if (status?.available) reloadDevices();
  }, [status?.available, reloadDevices]);

  useEffect(() => {
    const unlisten = listen<RecorderEvent>('recorder:event', (e) => {
      const ev = e.payload;
      switch (ev.event) {
        case 'recording_started':
          setStartedAt(Date.now());
          setError(null);
          reloadStatus();
          break;
        case 'stopped':
          setStartedAt(null);
          setElapsed(0);
          setLevels({});
          reloadStatus();
          break;
        case 'error':
          setError(ev.message ?? 'unknown error');
          setStartedAt(null);
          break;
        case 'permissions':
          setPermissions({
            screen: ev.screen,
            microphone: ev.microphone,
            camera: ev.camera,
          });
          break;
        case 'audio_level':
          if (ev.source_id && typeof ev.rms === 'number') {
            const id = ev.source_id;
            const rms = ev.rms;
            setLevels((prev) =>
              prev[id] === rms ? prev : { ...prev, [id]: rms }
            );
          }
          break;
      }
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [reloadStatus]);

  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      500
    );
    return () => clearInterval(t);
  }, [startedAt]);

  useEffect(() => {
    recProbePermissions().catch(() => {});
  }, []);

  const selectedDisplay = devices.displays.find((d) => d.id === displayId);
  const selectedCamera = devices.cameras.find((c) => c.id === cameraId);
  const needsPip = mode === 'cam' || mode === 'screen+cam';

  useEffect(() => {
    setPipDismissed(false);
  }, [mode, cameraId]);

  useEffect(() => {
    const unlisten = listen('camera-pip:closed', () => setPipDismissed(true));
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (needsPip && selectedCamera && !pipDismissed) {
        try {
          await camPipHide();
          if (cancelled) return;
          await camPipShow({
            cameraLabel: selectedCamera.name,
            shape: overlayShape,
          });
        } catch (e) {
          setError(String(e));
        }
      } else {
        camPipHide().catch(() => {});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [needsPip, selectedCamera, overlayShape, pipDismissed]);

  useEffect(() => {
    return () => {
      camPipHide().catch(() => {});
    };
  }, []);

  const toggleMic = (id: string) => {
    setMicIds((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    );
  };

  const toggleMute = (sourceId: string) => {
    setMuted((cur) => {
      const next = new Set(cur);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  };

  const setGain = (sourceId: string, value: number) => {
    setGains((cur) => ({ ...cur, [sourceId]: value }));
  };

  const beginCountdown = () => {
    setError(null);
    setCountdown(3);
    const step = () => {
      setCountdown((c) => {
        if (c === null) return null;
        if (c <= 1) {
          countdownRef.current = null;
          startRecording();
          return null;
        }
        countdownRef.current = window.setTimeout(step, 1000);
        return c - 1;
      });
    };
    countdownRef.current = window.setTimeout(step, 1000);
  };

  const cancelCountdown = () => {
    if (countdownRef.current) {
      window.clearTimeout(countdownRef.current);
      countdownRef.current = null;
    }
    setCountdown(null);
  };

  const startRecording = async () => {
    try {
      if ((mode === 'cam' || mode === 'screen+cam') && !cameraId) {
        setError('Select a camera first');
        return;
      }
      if (mode !== 'cam' && !displayId) {
        setError('Select a display first');
        return;
      }
      let overlay: CamOverlay | undefined;
      if (mode === 'screen+cam') {
        const snapshot = await captureOverlayFromPip(selectedDisplay, overlayShape);
        if (!snapshot) {
          setError(
            'Camera preview is not on the selected display — drag it onto ' +
              (selectedDisplay?.name ?? 'the selected display') +
              ' before recording.',
          );
          return;
        }
        overlay = snapshot;
      }
      // Materialise gains/mute in the source-id space the Swift helper
      // expects. Omit unity/absent gains so the default path stays cheap.
      const sourceGains: Record<string, number> = {};
      for (const id of micIds) {
        const g = gains[micSourceId(id)];
        if (g !== undefined && g !== 1) sourceGains[micSourceId(id)] = g;
      }
      if (systemAudio) {
        const g = gains[SYSTEM_SOURCE_ID];
        if (g !== undefined && g !== 1) sourceGains[SYSTEM_SOURCE_ID] = g;
      }
      const mutedSources: string[] = [];
      for (const id of micIds) {
        if (muted.has(micSourceId(id))) mutedSources.push(micSourceId(id));
      }
      if (systemAudio && muted.has(SYSTEM_SOURCE_ID)) {
        mutedSources.push(SYSTEM_SOURCE_ID);
      }
      await recStart({
        mode,
        displayId: mode === 'cam' ? null : displayId,
        cameraId: mode === 'screen' ? null : cameraId,
        micIds,
        systemAudio: mode === 'cam' ? false : systemAudio,
        camOverlay: overlay,
        excludedWindowTitles:
          mode === 'screen+cam' ? [CAMERA_PIP_TITLE] : undefined,
        sourceGains: Object.keys(sourceGains).length ? sourceGains : undefined,
        mutedSources: mutedSources.length ? mutedSources : undefined,
      });
    } catch (e) {
      setError(String(e));
    }
  };

  const stop = async () => {
    try {
      await recStop();
    } catch (e) {
      setError(String(e));
    }
  };

  const isRecording = Boolean(startedAt);

  if (status && !status.available) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 text-center">
        <div className="t-primary text-heading font-medium mb-2">Recorder helper not installed</div>
        <div className="t-tertiary text-meta mb-3 max-w-md">
          Build the Swift helper with <code>swift build -c release</code> in
          <code className="mx-1">helpers/recorder-swift</code> or drop{' '}
          <code>stash-recorder</code> into the app's data directory <code>bin/</code> folder.
        </div>
        <Button variant="soft" onClick={reloadStatus}>
          Check again
        </Button>
      </div>
    );
  }

  if (countdown !== null) {
    const sub =
      mode === 'cam'
        ? selectedCamera?.name
        : mode === 'screen+cam'
          ? `${selectedDisplay?.name ?? 'Display'} · ${selectedCamera?.name ?? 'camera'}`
          : selectedDisplay?.name ?? 'Display';
    return (
      <div className="h-full flex items-center justify-center">
        <div className="pane rounded-2xl px-4 py-3 flex items-center gap-4" style={{ width: 360 }}>
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center text-white text-[22px] font-medium"
            style={{
              background: '#EB4848',
              boxShadow: '0 0 0 3px rgba(235,72,72,0.18)',
            }}
          >
            {countdown}
          </div>
          <div className="flex-1 min-w-0">
            <div className="t-primary text-body font-medium">Starting in {countdown}…</div>
            <div className="t-tertiary text-meta truncate">{sub}</div>
          </div>
          <button
            onClick={cancelCountdown}
            className="t-secondary hover:t-primary px-2 py-1 rounded-md text-meta"
            style={{ background: 'rgba(255,255,255,0.05)' }}
          >
            <span className="kbd mr-1">Esc</span>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (isRecording) {
    const primaryLevel = Math.max(0, ...Object.values(levels));
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4">
        <div
          className="pane rounded-full pl-2 pr-1 py-1 flex items-center gap-2"
          style={{ width: 260 }}
        >
          <span
            className="w-2.5 h-2.5 rounded-full rec-dot ml-1"
            style={{ background: '#EB4848' }}
          />
          <span className="t-primary text-body font-mono tabular-nums">
            {formatElapsed(elapsed)}
          </span>
          {(micIds.length > 0 || systemAudio) && (
            <LevelMeter level={primaryLevel} height={12} bars={5} />
          )}
          <div className="flex-1" />
          <button
            onClick={stop}
            aria-label="Stop recording"
            className="w-7 h-7 rounded-full flex items-center justify-center text-white"
            style={{ background: '#EB4848' }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
              <rect x="5" y="5" width="14" height="14" rx="1" />
            </svg>
          </button>
        </div>
        <div className="t-tertiary text-meta">
          {mode === 'cam'
            ? 'Camera recording'
            : mode === 'screen+cam'
              ? 'Screen + camera recording'
              : 'Screen recording'}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-y-auto nice-scroll px-6 py-5 flex flex-col gap-5">
        <section>
          <SectionHeader>Mode</SectionHeader>
          <SegmentedControl
            ariaLabel="Recording mode"
            value={mode}
            onChange={setMode}
            options={modes.map((m) => ({
              value: m.id,
              label: m.label,
              icon: <m.Icon />,
            }))}
          />
        </section>

        {mode !== 'cam' && (
          <section>
            <SectionHeader>Display</SectionHeader>
            {devices.displays.length === 0 ? (
              <div className="t-tertiary text-meta">No displays detected.</div>
            ) : (
              <Select
                label="Display"
                value={displayId}
                onChange={setDisplayId}
                options={devices.displays.map((d) => ({
                  value: d.id,
                  label: `${d.name} · ${d.width}×${d.height}${d.primary ? ' · primary' : ''}`,
                }))}
              />
            )}
          </section>
        )}

        {mode !== 'screen' && (
          <section>
            <SectionHeader>Camera</SectionHeader>
            {devices.cameras.length === 0 ? (
              <div className="t-tertiary text-meta">No cameras detected.</div>
            ) : (
              <div className="flex items-center gap-2">
                <Select
                  label="Camera"
                  value={cameraId}
                  onChange={setCameraId}
                  options={devices.cameras.map((c) => ({ value: c.id, label: c.name }))}
                />
                {pipDismissed && (
                  <Button
                    size="sm"
                    variant="soft"
                    onClick={() => setPipDismissed(false)}
                  >
                    Show preview
                  </Button>
                )}
              </div>
            )}
          </section>
        )}

        {mode === 'screen+cam' && (
          <section className="flex flex-col gap-2">
            <SectionHeader>Camera overlay</SectionHeader>
            <div className="flex items-center gap-3 flex-wrap">
              <SegmentedControl
                ariaLabel="Overlay shape"
                value={overlayShape}
                onChange={setOverlayShape}
                options={[
                  { value: 'rect', label: 'Rect' },
                  { value: 'circle', label: 'Circle' },
                ]}
              />
              <span className="t-tertiary text-meta">
                Drag and resize the camera preview. Where it sits on Record is where it lands in the file.
              </span>
            </div>
          </section>
        )}

        <section>
          <div className="flex items-baseline justify-between mb-2">
            <SectionHeader>Audio mixer</SectionHeader>
            {mode !== 'cam' && !systemAudio && (
              <button
                onClick={() => setSystemAudio(true)}
                className="t-tertiary text-meta hover:t-secondary"
              >
                + Add system audio
              </button>
            )}
          </div>
          {devices.microphones.length === 0 && !systemAudio ? (
            <div className="t-tertiary text-meta">No microphones detected.</div>
          ) : (
            <div className="flex flex-col gap-1">
              {devices.microphones.map((m) => {
                const sourceId = micSourceId(m.id);
                const enabled = micIds.includes(m.id);
                return (
                  <AudioSourceRow
                    key={m.id}
                    name={m.name}
                    enabled={enabled}
                    onToggle={() => toggleMic(m.id)}
                    muted={muted.has(sourceId)}
                    onMuteToggle={() => toggleMute(sourceId)}
                    gain={gains[sourceId] ?? 1}
                    onGain={(v) => setGain(sourceId, v)}
                    level={levels[sourceId] ?? 0}
                  />
                );
              })}
              {mode !== 'cam' && systemAudio && (
                <AudioSourceRow
                  name="System audio"
                  enabled={systemAudio}
                  onToggle={() => setSystemAudio(false)}
                  muted={muted.has(SYSTEM_SOURCE_ID)}
                  onMuteToggle={() => toggleMute(SYSTEM_SOURCE_ID)}
                  gain={gains[SYSTEM_SOURCE_ID] ?? 1}
                  onGain={(v) => setGain(SYSTEM_SOURCE_ID, v)}
                  level={levels[SYSTEM_SOURCE_ID] ?? 0}
                  removable
                />
              )}
            </div>
          )}
        </section>

        {devicesError && (
          <div
            className="rounded-md px-3 py-2 text-meta"
            style={{ background: 'rgba(235,72,72,0.08)', color: '#FF9B9B' }}
          >
            Failed to enumerate devices: {devicesError}
          </div>
        )}

        {permissions && permissions.screen === false && mode !== 'cam' && (
          <PermissionBanner
            pane="screen-recording"
            label="Screen recording permission is off."
          />
        )}
        {permissions && micIds.length > 0 && permissions.microphone === false && (
          <PermissionBanner
            pane="microphone"
            label="Microphone permission is off — audio tracks will be silent."
          />
        )}
        {permissions && mode !== 'screen' && permissions.camera === false && (
          <PermissionBanner
            pane="camera"
            label="Camera permission is off."
          />
        )}

        {error && (
          <div
            className="rounded-md px-3 py-2 text-meta"
            style={{ background: 'rgba(235,72,72,0.08)', color: '#FF9B9B' }}
          >
            {error}
          </div>
        )}

        {history.length > 0 && (
          <section>
            <SectionHeader>Recordings · {history.length}</SectionHeader>
            <div className="divide-y divide-white/5">
              {history.map((r) => (
                <div key={r.path} className="flex items-center gap-3 py-2">
                  <div
                    className="w-[80px] h-[45px] rounded-md overflow-hidden bg-black/50 shrink-0 cursor-pointer"
                    onClick={() => setPlaying(r.path)}
                  >
                    {r.thumbnail ? (
                      <img
                        src={convertFileSrc(r.thumbnail)}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center t-tertiary text-[10px]">
                        no preview
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="t-primary text-body truncate">
                      {r.path.split('/').pop()}
                    </div>
                    <div className="t-tertiary text-meta font-mono">
                      {formatBytes(r.bytes)}
                    </div>
                  </div>
                  <Button size="sm" variant="soft" tone="accent" onClick={() => setPlaying(r.path)}>
                    Play
                  </Button>
                  <Button size="sm" variant="soft" onClick={() => setTrimTarget(r.path)}>
                    Trim
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    tone="danger"
                    shape="square"
                    aria-label="Delete recording"
                    title="Delete recording"
                    onClick={async () => {
                      await recDelete(r.path);
                      reloadStatus();
                    }}
                  >
                    ×
                  </Button>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
      <footer className="px-6 py-4 border-t hair flex items-center justify-between gap-2">
        <div className="t-tertiary text-meta truncate">
          {recorderMetaLine(mode, selectedDisplay, selectedCamera)}
        </div>
        <RecordPill onClick={beginCountdown} />
      </footer>
      {playing && <VideoPlayer src={playing} onClose={() => setPlaying(null)} />}
      {trimTarget && (
        <TrimDialog
          source={trimTarget}
          onClose={() => setTrimTarget(null)}
          onTrimmed={async () => {
            setTrimTarget(null);
            await reloadStatus();
          }}
          onRun={(start, end) => recTrim(trimTarget, start, end)}
        />
      )}
    </div>
  );
};

const recorderMetaLine = (
  mode: RecorderMode,
  display: DisplayDevice | undefined,
  camera: { name: string } | undefined,
): string => {
  const parts: string[] = [];
  if (mode !== 'cam' && display) parts.push(`${display.width}p`);
  if (mode !== 'screen' && camera) parts.push(camera.name);
  parts.push('60 fps', 'H.264');
  return parts.join(' · ');
};
