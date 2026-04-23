import { useEffect, useRef, useState } from 'react';
import { formatDuration } from '../../../shared/format/duration';
import { IconButton } from '../../../shared/ui/IconButton';
import { CloseIcon, PauseIcon, PlayIcon } from '../../../shared/ui/icons';
import { parseYouTubeId, useYouTubePlayer } from '../hooks/useYouTubePlayer';

type Props = {
  volume: number;
  onVolume: (v: number) => void;
};

const formatTime = (s: number): string =>
  // BackingTrack uses floor for an always-advancing clock; the canonical
  // helper rounds, so we convert to ms to force floor semantics.
  formatDuration(Math.max(0, s) * 1000, { unit: 'ms', includeHours: 'never' });

const YT_CONTAINER_ID = 'metronome-yt-host';

type LocalSource =
  | { kind: 'none' }
  | { kind: 'file'; name: string; url: string }
  | { kind: 'youtube'; videoId: string; title: string };

export const BackingTrack = ({ volume, onVolume }: Props) => {
  const [source, setSource] = useState<LocalSource>({ kind: 'none' });
  const [urlInput, setUrlInput] = useState('');
  const [resolving, setResolving] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [audioState, setAudioState] = useState({ playing: false, time: 0, duration: 0 });
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const yt = useYouTubePlayer(YT_CONTAINER_ID);

  // Local file playback state.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => setAudioState((s) => ({ ...s, time: a.currentTime }));
    const onMeta = () => setAudioState((s) => ({ ...s, duration: a.duration }));
    const onPlay = () => setAudioState((s) => ({ ...s, playing: true }));
    const onPause = () => setAudioState((s) => ({ ...s, playing: false }));
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
    };
  }, [source.kind]);

  // Volume routing.
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
    yt.setVolume(volume);
  }, [volume, yt]);

  const acceptFile = (file: File) => {
    if (!file.type.startsWith('audio/') && !/\.(mp3|wav|m4a|ogg|flac)$/i.test(file.name)) return;
    const url = URL.createObjectURL(file);
    setSource((prev) => {
      if (prev.kind === 'file') URL.revokeObjectURL(prev.url);
      return { kind: 'file', name: file.name, url };
    });
  };

  const acceptUrl = async () => {
    const id = parseYouTubeId(urlInput);
    if (!id) return;
    setResolving(true);
    try {
      await yt.load(id);
      setSource({ kind: 'youtube', videoId: id, title: `YouTube · ${id}` });
      setUrlInput('');
    } finally {
      setResolving(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) acceptFile(file);
  };

  const close = () => {
    if (source.kind === 'file') URL.revokeObjectURL(source.url);
    setSource({ kind: 'none' });
    audioRef.current?.pause();
    yt.pause();
  };

  const playing =
    source.kind === 'file' ? audioState.playing : source.kind === 'youtube' ? yt.state.playing : false;
  const duration =
    source.kind === 'file' ? audioState.duration : source.kind === 'youtube' ? yt.state.duration : 0;
  const currentTime =
    source.kind === 'file' ? audioState.time : source.kind === 'youtube' ? yt.state.currentTime : 0;

  const togglePlay = () => {
    if (source.kind === 'file') {
      const a = audioRef.current;
      if (!a) return;
      if (a.paused) a.play().catch(() => {});
      else a.pause();
    } else if (source.kind === 'youtube') {
      if (yt.state.playing) yt.pause();
      else yt.play();
    }
  };

  const onSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = Number(e.target.value);
    if (source.kind === 'file' && audioRef.current) audioRef.current.currentTime = t;
    if (source.kind === 'youtube') yt.seek(t);
  };

  return (
    <div
      className="border-t hair px-4 py-2"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      data-testid="backing-track"
    >
      {source.kind === 'none' ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="t-secondary hover:t-primary text-meta px-2 py-1 rounded-md hover:bg-white/[0.04]"
          >
            Open file
          </button>
          <span className="t-tertiary text-meta">or</span>
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') acceptUrl();
            }}
            placeholder="paste YouTube link"
            className="input flex-1 text-body rounded-md px-2 py-1"
            data-testid="yt-url-input"
          />
          {urlInput && (
            <button
              type="button"
              onClick={acceptUrl}
              disabled={resolving || !parseYouTubeId(urlInput)}
              className="text-meta px-2 py-1 rounded-md t-primary bg-white/[0.08] hover:bg-white/[0.12] disabled:opacity-40"
            >
              {resolving ? 'Loading…' : 'Load'}
            </button>
          )}
          <span className="t-tertiary text-meta ml-1">drop MP3 anywhere</span>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <IconButton onClick={togglePlay} title={playing ? 'Pause' : 'Play'}>
            {playing ? <PauseIcon size={12} /> : <PlayIcon size={12} />}
          </IconButton>
          <div className="t-secondary text-meta truncate flex-1 min-w-0">
            {source.kind === 'file' ? source.name : source.title}
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(0.01, duration)}
            step={0.1}
            value={currentTime}
            onChange={onSeek}
            className="metro-slider"
            style={{
              flex: '0 0 200px',
              ['--metro-pct' as string]: `${Math.round(
                (currentTime / Math.max(0.01, duration)) * 100,
              )}%`,
            }}
            aria-label="Track position"
          />
          <span className="t-tertiary text-meta font-mono">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(volume * 100)}
            onChange={(e) => onVolume(Number(e.target.value) / 100)}
            className="metro-slider"
            style={{ width: 60, ['--metro-pct' as string]: `${Math.round(volume * 100)}%` }}
            aria-label="Track volume"
          />
          <IconButton onClick={close} title="Close track">
            <CloseIcon size={11} />
          </IconButton>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) acceptFile(file);
          e.target.value = '';
        }}
        className="hidden"
      />
      {source.kind === 'file' && (
        <audio ref={audioRef} src={source.url} preload="auto" loop />
      )}
      {/* Hidden YouTube host. Lives outside the visual flow. */}
      <div
        id={YT_CONTAINER_ID}
        style={{ position: 'absolute', left: -9999, top: -9999, width: 1, height: 1 }}
      />
    </div>
  );
};
