import { useCallback, useEffect, useRef, useState } from 'react';

import { Spinner } from '../shared/ui/Spinner';
import { useToast } from '../shared/ui/Toast';
import { accent } from '../shared/theme/accent';
import * as api from './api';
import { useRecorder } from './useRecorder';

type Status = 'idle' | 'recording' | 'transcribing' | 'thinking' | 'reply';

/// Claude-style floating voice capsule. One big mic button in the
/// middle, transcript + reply stack above. Tap to start, tap (or VAD
/// timeout if enabled in settings) to stop. `Esc` dismisses. The
/// window is invisible until backend `voice_popup_show` raises it,
/// so the popup stays out of `Cmd-Tab` and the Dock.
export const VoicePopup = () => {
  const { toast } = useToast();
  const [status, setStatus] = useState<Status>('idle');
  const [transcript, setTranscript] = useState('');
  const [reply, setReply] = useState('');
  const [silenceMs, setSilenceMs] = useState<number | null>(null);
  const askInFlightRef = useRef(false);

  // Pull the user's autostop preference once on mount and after each
  // window show — flipping the setting in Stash's main popup
  // shouldn't require a relaunch of this one.
  const refreshSettings = useCallback(async () => {
    try {
      const s = await api.getVoiceSettings();
      setSilenceMs(s.autostop_enabled ? s.autostop_silence_ms : null);
    } catch {
      setSilenceMs(null);
    }
  }, []);

  useEffect(() => {
    void refreshSettings();
    const onFocus = () => void refreshSettings();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshSettings]);

  const recorder = useRecorder({ silenceMs });

  // Esc closes the popup — covers click-outside too, since the
  // backend hides the window on blur. Cancelling any active record
  // first so the next open starts clean.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (recorder.phase !== 'idle') recorder.cancel();
        setTranscript('');
        setReply('');
        setStatus('idle');
        void api.hidePopup();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder.phase]);

  const runFullTurn = useCallback(async () => {
    if (askInFlightRef.current) return;
    askInFlightRef.current = true;
    try {
      setTranscript('');
      setReply('');
      setStatus('recording');
      const rec = await recorder.start();
      setStatus('transcribing');
      const text = (await api.transcribe(rec.bytes, rec.extension)).trim();
      if (!text) {
        toast({ title: 'Нічого не почув', variant: 'error' });
        setStatus('idle');
        return;
      }
      setTranscript(text);
      setStatus('thinking');
      const answer = await api.ask(text);
      setReply(answer.trim());
      setStatus('reply');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== 'cancelled') {
        toast({
          title: 'Помилка асистента',
          description: msg,
          variant: 'error',
        });
      }
      setStatus('idle');
    } finally {
      askInFlightRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onMicClick = () => {
    if (status === 'recording') {
      recorder.stop();
    } else if (status === 'idle' || status === 'reply') {
      void runFullTurn();
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Voice assistant"
      className="h-screen w-screen flex flex-col items-center justify-end px-4 pb-4"
      style={{ background: 'transparent' }}
    >
      {/* History stack — transcript above, reply below the mic. We
          render them inside a transparent column so the capsule itself
          stays small and only the message bubbles take space. */}
      <div className="w-full max-w-[480px] flex flex-col gap-2 mb-3">
        {transcript && (
          <Bubble side="user" text={transcript} />
        )}
        {status === 'thinking' && (
          <div className="self-start flex items-center gap-2 t-secondary text-meta px-3 py-1.5 pane rounded-lg">
            <Spinner size={12} />
            <span>Думаю…</span>
          </div>
        )}
        {reply && <Bubble side="assistant" text={reply} />}
      </div>

      <Capsule
        status={status}
        level={recorder.level}
        onMicClick={onMicClick}
      />
    </div>
  );
};

const Bubble = ({
  side,
  text,
}: {
  side: 'user' | 'assistant';
  text: string;
}) => {
  const align = side === 'user' ? 'self-end' : 'self-start';
  const tint =
    side === 'user'
      ? { background: accent(0.18), color: 'rgb(var(--stash-accent-rgb))' }
      : undefined;
  return (
    <div
      className={`${align} max-w-[85%] rounded-2xl px-3.5 py-2 text-body whitespace-pre-wrap pane shadow-lg`}
      style={tint}
    >
      {text}
    </div>
  );
};

type CapsuleProps = {
  status: Status;
  level: number;
  onMicClick: () => void;
};

/// The capsule itself: 360×88 frosted bar with a circular mic in
/// the centre. The ring around the mic pulses with the live audio
/// level when recording, mirroring Claude's voice surface.
const Capsule = ({ status, level, onMicClick }: CapsuleProps) => {
  const recording = status === 'recording';
  const busy = status === 'transcribing' || status === 'thinking';
  const ringScale = 1 + Math.min(level * 1.6, 0.4);
  const label =
    status === 'idle' || status === 'reply'
      ? 'Tap to talk'
      : status === 'recording'
        ? 'Listening… tap to stop'
        : status === 'transcribing'
          ? 'Transcribing…'
          : 'Thinking…';

  return (
    <div
      className="pane rounded-full px-5 py-2.5 flex items-center gap-4 shadow-2xl backdrop-blur-md"
      style={{
        width: 'min(380px, calc(100vw - 32px))',
      }}
    >
      <button
        type="button"
        onClick={onMicClick}
        disabled={busy}
        aria-label={label}
        className="relative w-14 h-14 rounded-full flex items-center justify-center shrink-0 disabled:opacity-50 transition-transform"
        style={{
          backgroundColor: recording ? accent(0.6) : accent(0.22),
          color: 'rgb(var(--stash-accent-rgb))',
        }}
      >
        {/* Pulsing ring driven by live RMS so the user gets immediate
            feedback that the mic is hearing them. */}
        {recording && (
          <span
            aria-hidden
            className="absolute inset-0 rounded-full"
            style={{
              boxShadow: `0 0 0 4px ${accent(0.35)}`,
              transform: `scale(${ringScale})`,
              transition: 'transform 80ms linear',
            }}
          />
        )}
        {busy ? (
          <Spinner size={18} />
        ) : recording ? (
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden
          >
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        ) : (
          <MicIcon />
        )}
      </button>
      <div className="flex-1 min-w-0">
        <div className="t-primary text-body font-medium leading-tight">
          {label}
        </div>
        <div className="t-tertiary text-meta tabular-nums">
          ⌘⇧A · Esc to dismiss
        </div>
      </div>
    </div>
  );
};

const MicIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M12 18v3" />
  </svg>
);
