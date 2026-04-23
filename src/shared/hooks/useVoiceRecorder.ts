import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { blobToWav16Mono } from '../util/encodeWav';

export type VoicePhase = 'idle' | 'recording' | 'transcribing' | 'error';

export type UseVoiceRecorder = {
  phase: VoicePhase;
  error: string;
  toggle: () => void;
  start: () => Promise<void>;
  stop: () => void;
  /** True while the user cannot meaningfully interact (transcribing). */
  busy: boolean;
};

type Options = {
  /** Called once whisper returns a non-empty transcript. The consumer
   *  decides what to do with it — AI composer pipes it into the text
   *  input so the user can edit before sending. */
  onTranscript: (text: string) => void;
  /** Optional: called when whisper returns empty / no speech detected.
   *  Consumers can surface a hint ("say something") without treating it
   *  as an error. */
  onEmpty?: () => void;
};

const pickMimeType = (): { mime: string; ext: string } => {
  const MR = (globalThis as unknown as { MediaRecorder?: typeof MediaRecorder })
    .MediaRecorder;
  if (!MR || typeof MR.isTypeSupported !== 'function') {
    return { mime: '', ext: 'webm' };
  }
  const candidates: Array<[string, string]> = [
    ['audio/webm;codecs=opus', 'webm'],
    ['audio/webm', 'webm'],
    ['audio/ogg;codecs=opus', 'ogg'],
    ['audio/mp4', 'm4a'],
  ];
  for (const [mime, ext] of candidates) {
    if (MR.isTypeSupported(mime)) return { mime, ext };
  }
  return { mime: '', ext: 'webm' };
};

/**
 * Encapsulates the mic → MediaRecorder → WAV → whisper pipeline. Kept
 * in `shared/` so both the AI chat composer and any future
 * voice-entry surface can share the exact same state machine — no
 * chance of two subtly different implementations drifting apart.
 */
export const useVoiceRecorder = ({ onTranscript, onEmpty }: Options): UseVoiceRecorder => {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [error, setError] = useState('');

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const onTranscriptRef = useRef(onTranscript);
  const onEmptyRef = useRef(onEmpty);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);
  useEffect(() => {
    onEmptyRef.current = onEmpty;
  }, [onEmpty]);

  const cleanupStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  useEffect(() => () => cleanupStream(), [cleanupStream]);

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state === 'inactive') {
      cleanupStream();
      setPhase('idle');
      return;
    }
    // `onstop` fires after the final dataavailable — blob assembly and
    // whisper call happen there. Flipping phase early gives the UI a
    // spinner immediately instead of waiting for the codec to flush.
    setPhase('transcribing');
    rec.stop();
  }, [cleanupStream]);

  const start = useCallback(async () => {
    if (phase === 'recording' || phase === 'transcribing') return;
    setError('');
    const nav = globalThis.navigator;
    if (!nav?.mediaDevices?.getUserMedia) {
      setError('Мікрофон недоступний у цьому середовищі.');
      setPhase('error');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await nav.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      setError(`мікрофон: ${String(e)}`);
      setPhase('error');
      return;
    }
    streamRef.current = stream;
    const { mime } = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
    } catch (e) {
      cleanupStream();
      setError(`recorder: ${String(e)}`);
      setPhase('error');
      return;
    }
    chunksRef.current = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
    };
    recorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, {
        type: recorder.mimeType || 'audio/webm',
      });
      cleanupStream();
      if (blob.size === 0) {
        setError('Порожній запис — нічого не записалось.');
        setPhase('error');
        return;
      }
      try {
        // Browser-side re-encode to 16 kHz mono PCM WAV. symphonia on
        // the Rust side can't decode Opus inside WebM, so we hand it
        // exactly the format whisper already consumes.
        const wav = await blobToWav16Mono(blob);
        const transcript = await invoke<string>('voice_transcribe', {
          audioBytes: Array.from(wav),
          extension: 'wav',
        });
        const trimmed = transcript.trim();
        if (!trimmed) {
          setPhase('idle');
          onEmptyRef.current?.();
          return;
        }
        onTranscriptRef.current(trimmed);
        setPhase('idle');
      } catch (e) {
        setError(`транскрипція: ${String(e)}`);
        setPhase('error');
      }
    };
    recorderRef.current = recorder;
    recorder.start();
    setPhase('recording');
  }, [phase, cleanupStream]);

  const toggle = useCallback(() => {
    if (phase === 'recording') stop();
    else if (phase === 'idle' || phase === 'error') void start();
  }, [phase, start, stop]);

  return {
    phase,
    error,
    toggle,
    start,
    stop,
    busy: phase === 'transcribing',
  };
};
