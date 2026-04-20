import { useEffect, useMemo, useRef, useState } from 'react';
import { IconButton } from '../../shared/ui/IconButton';
import { Button } from '../../shared/ui/Button';
import {
  CopyIcon,
  MagicWandIcon,
  PauseIcon,
  PlayIcon,
  TrashIcon,
  WaveformIcon,
} from '../../shared/ui/icons';
import { useToast } from '../../shared/ui/Toast';
import { whisperGetActive, whisperTranscribe } from '../whisper/api';
import { useAiSettings } from '../ai/useAiSettings';
import { loadSettings } from '../../settings/store';
import { notesReadAudio, notesUpdate, type Note } from './api';
import { polishTranscript } from './polish';

type Props = {
  note: Note;
  /** Called when the transcript is written back to the note, so the shell
   *  can refresh its list and render the new body. */
  onTranscriptUpdated?: (noteId: number, body: string) => void;
};

/** Map an audio filename back to the MIME type the browser needs to play it.
 *  Recordings land under `appData/notes/audio/<id>.<ext>` so the extension
 *  from the stored `audio_path` is the source of truth. Falling back to
 *  `audio/mp4` handles the common case on WKWebView, where the recorder
 *  currently prefers AAC in an MP4 container. */
const mimeForPath = (path: string | null): string => {
  const ext = path?.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'mp4':
    case 'm4a':
      return 'audio/mp4';
    case 'wav':
      return 'audio/wav';
    case 'ogg':
      return 'audio/ogg';
    case 'mp3':
      return 'audio/mpeg';
    case 'webm':
      return 'audio/webm';
    default:
      return 'audio/mp4';
  }
};

const formatClock = (sec: number): string => {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

/** Audio-backed note view. Loads the blob lazily, renders a polished player,
 *  and exposes a placeholder “Transcribe” action that we'll wire up once the
 *  Whisper integration lands. */
export const AudioNoteView = ({ note, onTranscriptUpdated }: Props) => {
  const [url, setUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const [autoTranscribe, setAutoTranscribe] = useState(true);
  const [autoPolish, setAutoPolish] = useState(true);
  const { toast } = useToast();
  const aiSettings = useAiSettings();
  const hasBody = Boolean(note.body.trim());

  // Mirror the two note-automation toggles so we can hide the manual
  // Re-transcribe / Polish buttons when auto-flow is on. Re-reads on the
  // same `stash:settings-changed` bus the AI tab uses.
  useEffect(() => {
    let cancelled = false;
    const read = () => {
      loadSettings()
        .then((s) => {
          if (cancelled) return;
          setAutoTranscribe(s.notesAutoTranscribe);
          setAutoPolish(s.notesAutoPolish);
        })
        .catch(() => {});
    };
    read();
    window.addEventListener('stash:settings-changed', read);
    return () => {
      cancelled = true;
      window.removeEventListener('stash:settings-changed', read);
    };
  }, []);
  const aiReady =
    Boolean(aiSettings.aiModel) &&
    (aiSettings.aiProvider === 'custom' ||
      Boolean(aiSettings.aiApiKeys?.[aiSettings.aiProvider]));
  const [duration, setDuration] = useState(
    note.audio_duration_ms ? note.audio_duration_ms / 1000 : 0,
  );
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;
    setUrl(null);
    setLoadError(null);
    setPlaying(false);
    setCurrentTime(0);
    if (note.audio_duration_ms) setDuration(note.audio_duration_ms / 1000);

    notesReadAudio(note.id)
      .then((bytes) => {
        if (cancelled) return;
        const blob = new Blob([new Uint8Array(bytes)], { type: mimeForPath(note.audio_path) });
        const u = URL.createObjectURL(blob);
        revoke = u;
        setUrl(u);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e));
      });
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [note.id, note.audio_duration_ms]);

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  };

  const onSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Number(e.target.value);
    setCurrentTime(a.currentTime);
  };

  const runPolish = async (raw?: string) => {
    const source = raw ?? note.body;
    if (!source.trim() || polishing) return null;
    setPolishing(true);
    try {
      const result = await polishTranscript(source, aiSettings);
      if (result.kind !== 'ok' || result.text === source.trim()) {
        if (result.kind === 'skipped') {
          toast({ title: 'Nothing to polish', description: result.reason, variant: 'default' });
        } else if (result.kind === 'ok') {
          toast({
            title: 'Already clean',
            description: 'The model didn\u2019t change anything.',
            variant: 'default',
          });
        }
        return null;
      }
      await notesUpdate(note.id, note.title, result.text);
      onTranscriptUpdated?.(note.id, result.text);
      toast({ title: 'Polished', description: 'Transcript corrected.', variant: 'success' });
      return result.text;
    } catch (e) {
      toast({ title: 'Polish failed', description: String(e), variant: 'error' });
      return null;
    } finally {
      setPolishing(false);
    }
  };

  const runTranscribeFlow = async () => {
    if (transcribing) return;
    const active = await whisperGetActive().catch(() => null);
    if (!active) {
      toast({
        title: 'No Whisper model selected',
        description: 'Open Settings → Notes to download and activate a model.',
        variant: 'default',
      });
      return;
    }
    setTranscribing(true);
    try {
      const transcript = await whisperTranscribe(note.id, 'uk');
      onTranscriptUpdated?.(note.id, transcript);
      toast({
        title: 'Transcribed',
        description: transcript.slice(0, 80) || '—',
        variant: 'success',
      });
      // Chain polish when the user has opted in, so this matches the
      // recording-time auto-flow regardless of which setting triggered this.
      const s = await loadSettings().catch(() => null);
      if (s?.notesAutoPolish && transcript.trim()) await runPolish(transcript);
    } catch (e) {
      toast({ title: 'Transcription failed', description: String(e), variant: 'error' });
    } finally {
      setTranscribing(false);
    }
  };

  // Decorative bar spectrum keyed to the playback progress — gives a sense
  // of motion without needing a real peak analysis of the blob.
  const bars = useMemo(() => {
    return Array.from({ length: 48 }, (_, i) => {
      const t = i / 48;
      // A gentle sinusoidal envelope so it looks like a wave, not random noise.
      return 0.35 + 0.55 * Math.abs(Math.sin(t * Math.PI * 4 + note.id));
    });
  }, [note.id]);
  const progress = duration > 0 ? currentTime / duration : 0;

  return (
    <div className="flex-1 flex flex-col min-h-0 px-5 py-6 gap-5 overflow-y-auto nice-scroll">
      <div
        className="rounded-xl p-4 flex items-center gap-4"
        style={{
          background: 'rgba(var(--stash-accent-rgb), 0.08)',
          border: '1px solid rgba(var(--stash-accent-rgb), 0.2)',
        }}
      >
        <div className="shrink-0" data-testid="audio-note-toggle">
          <IconButton
            onClick={togglePlay}
            title={playing ? 'Pause' : 'Play'}
            stopPropagation={false}
          >
            {playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
          </IconButton>
        </div>
        <div className="flex-1 min-w-0 flex flex-col gap-2">
          <div
            className="flex items-end gap-[2px] h-8"
            aria-hidden
            data-testid="audio-note-waveform"
          >
            {bars.map((h, i) => {
              const lit = i / bars.length <= progress;
              return (
                <span
                  key={i}
                  style={{
                    flex: 1,
                    minWidth: 2,
                    height: `${h * 100}%`,
                    background: lit
                      ? 'rgba(var(--stash-accent-rgb), 0.9)'
                      : 'rgba(255,255,255,0.18)',
                    borderRadius: 1,
                    transition: 'background 120ms linear',
                  }}
                />
              );
            })}
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(0.01, duration)}
            step={0.05}
            value={currentTime}
            onChange={onSeek}
            className="w-full"
            aria-label="Seek"
          />
        </div>
        <div
          className="t-secondary text-meta font-mono tabular-nums shrink-0"
          style={{ minWidth: 78, textAlign: 'right' }}
        >
          {formatClock(currentTime)} / {formatClock(duration)}
        </div>
      </div>
      <audio
        ref={audioRef}
        src={url ?? undefined}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDuration(d);
        }}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        className="hidden"
      />
      <div className="flex items-center gap-3">
        {!autoTranscribe && (
          <Button
            variant="soft"
            tone="accent"
            className="gap-2"
            loading={transcribing}
            onClick={() => runTranscribeFlow()}
            data-testid="audio-transcribe"
          >
            <MagicWandIcon size={13} />
            {hasBody ? 'Re-transcribe' : 'Transcribe with Whisper'}
          </Button>
        )}
        {!autoPolish && (
          <Button
            variant="soft"
            tone="neutral"
            className="gap-2"
            loading={polishing}
            disabled={!hasBody || !aiReady || polishing}
            title={
              !hasBody
                ? 'Transcribe first, then polish'
                : !aiReady
                  ? 'Configure an AI provider in Settings → AI'
                  : 'Fix typos and punctuation with the active AI model (temperature 0, no rephrasing)'
            }
            onClick={() => runPolish()}
            data-testid="audio-polish"
          >
            Polish with AI
          </Button>
        )}
        <Button
          variant="ghost"
          tone="danger"
          leadingIcon={<TrashIcon size={12} />}
          disabled={!hasBody || transcribing || polishing}
          onClick={async () => {
            if (!hasBody) return;
            await notesUpdate(note.id, note.title, '');
            onTranscriptUpdated?.(note.id, '');
            toast({ title: 'Transcript cleared', variant: 'default' });
            // If the user opted into auto-flow, Clear means "start over" —
            // immediately kick off a fresh transcription so they don't have
            // to dig through settings to re-run it manually.
            if (autoTranscribe) {
              void runTranscribeFlow();
            }
          }}
          title={
            autoTranscribe
              ? 'Delete the current transcript and re-transcribe (auto-flow enabled)'
              : 'Delete the current transcript (keeps the audio)'
          }
          data-testid="audio-clear-transcript"
        >
          Clear transcript
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 t-secondary text-meta uppercase tracking-wider">
            <WaveformIcon size={12} />
            Transcript
          </div>
          {hasBody && (
            <div className="ml-auto flex items-center gap-1">
              <IconButton
                title="Copy transcript"
                stopPropagation={false}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(note.body);
                    toast({ title: 'Copied', variant: 'default' });
                  } catch (e) {
                    toast({
                      title: 'Copy failed',
                      description: String(e),
                      variant: 'error',
                    });
                  }
                }}
              >
                <CopyIcon size={12} />
              </IconButton>
            </div>
          )}
        </div>
        {hasBody ? (
          <pre className="t-primary text-body whitespace-pre-wrap leading-relaxed font-sans">
            {note.body}
          </pre>
        ) : (
          <p className="t-tertiary text-meta italic">
            No transcript yet. After transcription the text will appear here and become searchable
            alongside your other notes.
          </p>
        )}
      </div>
      {loadError && (
        <div className="t-tertiary text-meta">Couldn't load audio: {loadError}</div>
      )}
    </div>
  );
};
