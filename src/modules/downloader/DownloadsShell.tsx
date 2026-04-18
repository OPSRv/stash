import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { loadSettings } from '../../settings/store';
import { PlatformBadge } from './PlatformBadge';
import {
  cancel,
  clearCompleted,
  deleteJob,
  detect,
  formatBytes,
  formatDuration,
  list,
  start,
  type DetectedVideo,
  type DownloadJob,
  type QualityOption,
} from './api';
import { SectionLabel } from '../../shared/ui/SectionLabel';
import { Kbd } from '../../shared/ui/Kbd';
import { VideoPlayer } from '../../shared/ui/VideoPlayer';

const statusLabel = (s: DownloadJob['status']) =>
  ({
    pending: 'Queued',
    active: 'Downloading',
    paused: 'Paused',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
  })[s];

export const DownloadsShell = () => {
  const [url, setUrl] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [detectStartedAt, setDetectStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [detected, setDetected] = useState<DetectedVideo | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [pickedFormat, setPickedFormat] = useState<QualityOption | null>(null);
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [playing, setPlaying] = useState<string | null>(null);
  const detectEpoch = useRef(0);
  const [dragOver, setDragOver] = useState(false);
  const [view, setView] = useState<'list' | 'grid'>('list');

  // On mount: if clipboard holds a supported URL, auto-fill and detect.
  useEffect(() => {
    (async () => {
      try {
        const text = await readText();
        const t = text?.trim() ?? '';
        if (
          t &&
          /https?:\/\/(www\.)?(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|twitter\.com|x\.com|reddit\.com|vimeo\.com|twitch\.tv|facebook\.com|fb\.watch)/i.test(
            t
          )
        ) {
          setUrl(t);
          runDetect(t);
        }
      } catch (e) {
        console.warn('clipboard read failed on mount', e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = useCallback(() => {
    list().then(setJobs).catch((e) => console.error('list failed', e));
  }, []);

  useEffect(() => {
    reload();
    const notify = async (title: string, body: string) => {
      try {
        const settings = await loadSettings();
        if (!settings.notifyOnDownloadComplete) return;
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === 'granted';
        if (granted) sendNotification({ title, body });
      } catch (e) {
        console.error('notify failed', e);
      }
    };
    const unlisten = Promise.all([
      listen('downloader:progress', reload),
      listen<{ id: number; path: string }>('downloader:completed', (e) => {
        reload();
        const name = e.payload.path.split('/').pop() ?? 'Download';
        notify('Download finished', name);
      }),
      listen<{ id: number }>('downloader:failed', (_) => {
        reload();
        notify('Download failed', 'See Downloads for details.');
      }),
    ]);
    return () => {
      unlisten
        .then((fns) => fns.forEach((f) => f()))
        .catch(() => {});
    };
  }, [reload]);

  const runDetect = useCallback(
    async (u: string) => {
      const trimmed = u.trim();
      if (!trimmed) return;
      setDetecting(true);
      setDetectStartedAt(Date.now());
      setElapsed(0);
      setDetectError(null);
      setDetected(null);
      setPickedFormat(null);
      const myEpoch = ++detectEpoch.current;
      try {
        const result = await detect(trimmed);
        if (detectEpoch.current !== myEpoch) return;
        setDetected(result);
        setPickedFormat(result.qualities[0] ?? null);
      } catch (e) {
        if (detectEpoch.current !== myEpoch) return;
        setDetectError(String(e));
      } finally {
        if (detectEpoch.current === myEpoch) {
          setDetecting(false);
          setDetectStartedAt(null);
        }
      }
    },
    []
  );

  useEffect(() => {
    if (!detectStartedAt) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - detectStartedAt) / 1000)), 200);
    return () => clearInterval(t);
  }, [detectStartedAt]);

  const handlePaste = async () => {
    try {
      const text = await readText();
      if (text) {
        setUrl(text);
        runDetect(text);
      }
    } catch (e) {
      console.error('paste failed', e);
    }
  };

  const handleDownload = async () => {
    if (!detected || !pickedFormat) return;
    try {
      await start({
        url: url.trim(),
        title: detected.info.title,
        thumbnail: detected.info.thumbnail,
        format_id: pickedFormat.format_id,
        kind: pickedFormat.kind,
      });
      setDetected(null);
      setUrl('');
      setPickedFormat(null);
      reload();
    } catch (e) {
      console.error('start failed', e);
    }
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') runDetect(url);
  };

  const { active, completed } = useMemo(() => {
    return {
      active: jobs.filter((j) => j.status === 'active' || j.status === 'pending' || j.status === 'paused'),
      completed: jobs.filter((j) =>
        j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled'
      ),
    };
  }, [jobs]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (text) {
      const t = text.trim();
      setUrl(t);
      runDetect(t);
    }
  };

  return (
    <div
      className="h-full flex flex-col relative"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {/* URL bar */}
      <div className="px-4 py-3 flex items-center gap-2 border-b hair">
        <div className="input-field rounded-lg flex-1 flex items-center gap-2 px-3 py-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="t-tertiary">
            <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5" />
            <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5" />
          </svg>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
            onKeyDown={handleKey}
            placeholder="Paste a YouTube / TikTok / Instagram / X / Reddit URL"
            className="flex-1 bg-transparent outline-none text-body t-primary"
          />
        </div>
        <button
          onClick={handlePaste}
          className="px-3 py-2 rounded-lg t-secondary text-body flex items-center gap-1.5"
          style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          Paste
        </button>
        {detecting ? (
          <button
            onClick={() => {
              detectEpoch.current += 1;
              setDetecting(false);
              setDetectStartedAt(null);
              setDetectError('Cancelled');
            }}
            className="px-3 py-2 rounded-lg t-primary text-body flex items-center gap-1.5"
            style={{ background: 'rgba(235,72,72,0.15)', color: '#FF7878' }}
            title="Cancel"
          >
            <span className="inline-block w-3 h-3 rounded-full border-2 border-white/30 border-t-white/90 animate-spin" />
            <span>Cancel · {elapsed}s</span>
          </button>
        ) : (
          <button
            onClick={() => runDetect(url)}
            disabled={!url.trim()}
            className="px-3 py-2 rounded-lg t-primary text-body"
            style={{ background: 'rgba(255,255,255,0.06)' }}
          >
            Detect
          </button>
        )}
      </div>
      {detecting && elapsed > 8 && (
        <div className="mx-4 mt-1 t-tertiary text-meta">
          YouTube and a few other sites can take 20–40 seconds on the first
          fetch; subsequent detects of the same URL are instant.
        </div>
      )}

      {/* Detected preview */}
      {detected && (
        <div className="mx-4 mt-3 rounded-xl p-3 flex gap-3 items-center" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
          <div className="w-[110px] h-[62px] rounded-md overflow-hidden relative shrink-0 bg-black/60">
            {detected.info.thumbnail && (
              <img src={detected.info.thumbnail} alt="" className="w-full h-full object-cover" />
            )}
            {detected.info.duration && (
              <div className="absolute bottom-1 right-1 text-[10px] font-mono text-white/90 px-1 rounded" style={{ background: 'rgba(0,0,0,0.55)' }}>
                {formatDuration(detected.info.duration)}
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <PlatformBadge platform={detected.platform} />
              {detected.info.uploader && (
                <span className="t-tertiary text-meta">{detected.info.uploader}</span>
              )}
            </div>
            <div className="t-primary text-body font-medium truncate">{detected.info.title}</div>
            <div className="t-tertiary text-meta truncate">
              {detected.qualities.length} quality options
            </div>
          </div>
          <div className="seg flex text-meta font-medium shrink-0">
            {detected.qualities.map((q) => (
              <button
                key={q.format_id}
                onClick={() => setPickedFormat(q)}
                className={`px-2.5 py-1 rounded-md ${pickedFormat?.format_id === q.format_id ? 'on' : ''}`}
              >
                {q.label}
                {q.est_size ? (
                  <span className="t-tertiary text-[10px] ml-1">
                    {formatBytes(q.est_size)}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <button
            onClick={handleDownload}
            disabled={!pickedFormat}
            className="px-3.5 py-2 rounded-lg text-body font-medium text-white flex items-center gap-1.5"
            style={{ background: '#2F7AE5', boxShadow: '0 1px 0 rgba(0,0,0,0.25), inset 0 0.5px 0 rgba(255,255,255,0.18)' }}
          >
            Download <Kbd>↵</Kbd>
          </button>
        </div>
      )}
      {detectError && (
        <div className="mx-4 mt-3 t-tertiary text-meta px-3 py-2 rounded-md" style={{ background: 'rgba(235,72,72,0.08)', color: '#FF7878' }}>
          {detectError}
        </div>
      )}

      {/* Lists */}
      <div className="flex-1 overflow-y-auto nice-scroll">
        {active.length > 0 && (
          <>
            <div className="px-4 pt-3 pb-1 flex items-center justify-between">
              <SectionLabel>Active · {active.length}</SectionLabel>
            </div>
            {active.map((j) => (
              <ActiveRow key={j.id} job={j} onCancel={() => cancel(j.id).then(reload)} />
            ))}
          </>
        )}
        {completed.length > 0 && (
          <>
            <div className="px-4 pt-4 pb-1 flex items-center justify-between">
              <SectionLabel>Completed</SectionLabel>
              <div className="flex items-center gap-2">
                <div className="seg flex text-meta font-medium">
                  <button
                    onClick={() => setView('list')}
                    className={`px-2 py-0.5 rounded-md ${view === 'list' ? 'on' : ''}`}
                  >
                    List
                  </button>
                  <button
                    onClick={() => setView('grid')}
                    className={`px-2 py-0.5 rounded-md ${view === 'grid' ? 'on' : ''}`}
                  >
                    Grid
                  </button>
                </div>
                <button
                  onClick={() => clearCompleted().then(reload)}
                  className="t-tertiary text-meta hover:t-secondary"
                >
                  Clear
                </button>
              </div>
            </div>
            {view === 'list' ? (
              <div className="mx-3 rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.05)' }}>
                {completed.map((j, i) => (
                  <CompletedRow
                    key={j.id}
                    job={j}
                    zebra={i % 2 === 0}
                    onDelete={() => deleteJob(j.id).then(reload)}
                    onPlay={() => j.target_path && setPlaying(j.target_path)}
                  />
                ))}
              </div>
            ) : (
              <div className="mx-3 grid grid-cols-4 gap-2">
                {completed.map((j) => (
                  <CompletedTile
                    key={j.id}
                    job={j}
                    onPlay={() => j.target_path && setPlaying(j.target_path)}
                    onDelete={() => deleteJob(j.id).then(reload)}
                  />
                ))}
              </div>
            )}
          </>
        )}
        {active.length === 0 && completed.length === 0 && !detected && (
          <div className="h-full flex items-center justify-center t-tertiary text-meta pt-24">
            No downloads yet — paste a URL above.
          </div>
        )}
        <div className="h-6" />
      </div>

      {playing && <VideoPlayer src={playing} onClose={() => setPlaying(null)} />}

      {dragOver && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none"
          style={{
            background: 'rgba(47,122,229,0.12)',
            border: '2px dashed rgba(47,122,229,0.6)',
            borderRadius: 14,
          }}
        >
          <div className="t-primary text-title font-medium">Drop URL to download</div>
        </div>
      )}
    </div>
  );
};

const CompletedTile = ({
  job,
  onPlay,
  onDelete,
}: {
  job: DownloadJob;
  onPlay: () => void;
  onDelete: () => void;
}) => {
  const isFail = job.status === 'failed' || job.status === 'cancelled';
  return (
    <div
      className="group relative rounded-lg overflow-hidden cursor-pointer"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}
      onClick={!isFail ? onPlay : undefined}
    >
      <div className="aspect-video bg-black/50 relative">
        {job.thumbnail_url ? (
          <img src={job.thumbnail_url} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center t-tertiary text-meta">
            {isFail ? 'Failed' : 'No preview'}
          </div>
        )}
        {!isFail && (
          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity" style={{ background: 'rgba(0,0,0,0.4)' }}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor" className="text-white">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="absolute top-1 right-1 w-6 h-6 rounded-md items-center justify-center hidden group-hover:flex"
          style={{ background: 'rgba(0,0,0,0.55)' }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-white">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="px-2 py-1.5">
        <div className="flex items-center gap-1 mb-0.5">
          <PlatformBadge platform={job.platform} />
        </div>
        <div className="t-primary text-meta font-medium truncate">
          {job.title ?? (job.target_path?.split('/').pop() ?? job.url)}
        </div>
      </div>
    </div>
  );
};

const ActiveRow = ({ job, onCancel }: { job: DownloadJob; onCancel: () => void }) => {
  const pct = Math.round(job.progress * 100);
  const speed = job.bytes_done && job.bytes_total ? formatBytes(job.bytes_done) : null;
  return (
    <div className="mx-3 my-1 p-3 rounded-xl flex items-center gap-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
      <div className="w-[52px] h-[32px] rounded-md shrink-0 overflow-hidden bg-black/40">
        {job.thumbnail_url && <img src={job.thumbnail_url} alt="" className="w-full h-full object-cover" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <PlatformBadge platform={job.platform} />
          <span className="t-primary text-body truncate font-medium">{job.title ?? job.url}</span>
        </div>
        <div className="h-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
          <div
            className={`h-full rounded-full ${job.status === 'active' ? 'prog-fill' : ''}`}
            style={{ width: `${pct}%`, background: job.status === 'active' ? undefined : 'rgba(255,255,255,0.35)' }}
          />
        </div>
        <div className="flex items-center justify-between mt-1.5">
          <span className="t-secondary text-meta font-mono">
            {pct}% · {speed ?? statusLabel(job.status)}
            {job.bytes_total ? ` / ${formatBytes(job.bytes_total)}` : ''}
          </span>
          <span className="t-tertiary text-meta">{statusLabel(job.status)}</span>
        </div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onCancel();
        }}
        className="t-secondary hover:t-primary p-1.5 rounded-md"
        style={{ background: 'rgba(255,255,255,0.04)' }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
};

const CompletedRow = ({
  job,
  zebra,
  onDelete,
  onPlay,
}: {
  job: DownloadJob;
  zebra: boolean;
  onDelete: () => void;
  onPlay: () => void;
}) => {
  const reveal = async () => {
    if (!job.target_path) return;
    try {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(job.target_path);
    } catch (e) {
      console.error('reveal failed', e);
    }
  };
  const isFail = job.status === 'failed' || job.status === 'cancelled';
  return (
    <div
      className="flex items-center gap-3 px-3 py-2"
      style={zebra ? { background: 'rgba(255,255,255,0.02)' } : undefined}
    >
      <div
        className="w-6 h-6 rounded flex items-center justify-center shrink-0"
        style={{
          background: isFail ? 'rgba(235,72,72,0.14)' : 'rgba(40,200,64,0.14)',
          color: isFail ? '#FF6B6B' : '#43D66B',
        }}
      >
        {isFail ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
        )}
      </div>
      <PlatformBadge platform={job.platform} />
      <span className="t-primary text-body truncate flex-1">
        {job.target_path
          ? job.target_path.split('/').pop()
          : job.title ?? job.url}
      </span>
      {job.bytes_total && (
        <span className="t-tertiary text-meta font-mono">{formatBytes(job.bytes_total)}</span>
      )}
      {job.target_path && !isFail && (
        <button
          onClick={onPlay}
          className="t-primary text-meta px-2 py-1 rounded"
          style={{ background: 'rgba(47,122,229,0.18)' }}
        >
          Play
        </button>
      )}
      {job.target_path && (
        <button
          onClick={reveal}
          className="t-secondary hover:t-primary text-meta px-2 py-1 rounded"
          style={{ background: 'rgba(255,255,255,0.04)' }}
        >
          Reveal
        </button>
      )}
      <button
        onClick={onDelete}
        className="t-secondary hover:text-red-400 text-meta px-2 py-1 rounded"
        style={{ background: 'rgba(255,255,255,0.04)' }}
      >
        ×
      </button>
    </div>
  );
};
