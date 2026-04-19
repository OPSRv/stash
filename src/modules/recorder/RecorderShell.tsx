import { useCallback, useEffect, useRef, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  recDelete,
  recList,
  recProbePermissions,
  recStart,
  recStatus,
  recStop,
  recTrim,
  type Recording,
  type RecorderEvent,
  type RecorderMode,
  type RecorderStatus,
} from './api';
import { VideoPlayer } from '../../shared/ui/VideoPlayer';
import { Button } from '../../shared/ui/Button';
import { SegmentedControl } from '../../shared/ui/SegmentedControl';
import { TrimDialog } from './TrimDialog';

const modes: { id: RecorderMode; label: string; available: boolean }[] = [
  { id: 'screen', label: 'Screen', available: true },
  { id: 'screen+cam', label: 'Screen + Cam', available: false },
  { id: 'cam', label: 'Camera only', available: false },
];

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
  const [mode, setMode] = useState<RecorderMode>('screen');
  const [mic, setMic] = useState(false);
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

  const reloadStatus = useCallback(() => {
    recStatus()
      .then(setStatus)
      .catch((e) => setError(String(e)));
    recList()
      .then(setHistory)
      .catch(() => {});
  }, []);

  useEffect(() => {
    reloadStatus();
  }, [reloadStatus]);

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
    // Ask the helper for permission status on mount (best effort).
    recProbePermissions().catch(() => {});
  }, []);

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
      await recStart({ mode, mic });
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
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4">
        <div className="text-[96px] font-semibold t-primary tabular-nums">
          {countdown}
        </div>
        <Button variant="soft" tone="danger" onClick={cancelCountdown}>
          Cancel · Esc
        </Button>
      </div>
    );
  }

  if (isRecording) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3">
        <div className="flex items-center gap-3 rounded-full px-5 py-2" style={{ background: 'rgba(235,72,72,0.14)', border: '1px solid rgba(235,72,72,0.35)' }}>
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#FF5454', boxShadow: '0 0 0 0 rgba(255,84,84,0.8)', animation: 'rec-pulse 1.3s ease-out infinite' }} />
          <span className="t-primary text-heading font-mono tabular-nums">
            {formatElapsed(elapsed)}
          </span>
          <Button className="ml-2" size="sm" variant="soft" onClick={stop}>
            Stop
          </Button>
        </div>
        <div className="t-tertiary text-meta">Screen recording in progress…</div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-y-auto nice-scroll px-6 py-5 flex flex-col gap-5">
        <section>
          <div className="t-tertiary text-meta uppercase tracking-wider mb-2">Mode</div>
          <SegmentedControl
            ariaLabel="Recording mode"
            value={mode}
            onChange={setMode}
            options={modes.map((m) => ({
              value: m.id,
              label: m.label,
              disabled: !m.available,
              title: m.available ? m.label : 'Coming soon',
            }))}
          />
        </section>

        <section>
          <div className="t-tertiary text-meta uppercase tracking-wider mb-2">Audio</div>
          <label className="flex items-center gap-2 t-primary text-body cursor-pointer">
            <input
              type="checkbox"
              checked={mic}
              onChange={(e) => setMic(e.currentTarget.checked)}
            />
            <span>Record microphone</span>
            {permissions?.microphone === false && (
              <span className="t-tertiary text-meta">(permission required)</span>
            )}
          </label>
        </section>

        {permissions && permissions.screen === false && (
          <PermissionBanner
            pane="screen-recording"
            label="Screen recording permission is off."
          />
        )}
        {permissions && mic && permissions.microphone === false && (
          <PermissionBanner
            pane="microphone"
            label="Microphone permission is off — recording will have no audio."
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
            <div className="t-tertiary text-meta uppercase tracking-wider mb-2">
              Recordings · {history.length}
            </div>
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
      <footer className="px-6 py-4 border-t hair flex items-center justify-end gap-2">
        <Button size="lg" variant="solid" tone="danger" onClick={beginCountdown}>
          Record
        </Button>
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

const PermissionBanner = ({
  pane,
  label,
}: {
  pane: 'screen-recording' | 'microphone' | 'camera';
  label: string;
}) => (
  <div
    className="rounded-md px-3 py-2 text-meta flex items-center justify-between gap-3"
    style={{ background: 'rgba(235,72,72,0.08)', color: '#FF9B9B' }}
  >
    <span>{label}</span>
    <Button
      size="sm"
      variant="soft"
      onClick={() => invoke('open_system_settings', { pane }).catch(() => {})}
    >
      Open Settings
    </Button>
  </div>
);
