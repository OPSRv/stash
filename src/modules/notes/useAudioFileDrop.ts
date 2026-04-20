import { useEffect, useRef, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';

/** Container extensions we accept. Matches the Rust-side whitelist in
 *  `sanitize_ext` — keep them in sync. */
const AUDIO_EXTENSIONS = new Set([
  'webm',
  'ogg',
  'mp4',
  'm4a',
  'mp3',
  'wav',
  'aac',
  'flac',
  'opus',
  'aiff',
  'aif',
]);

const extensionOf = (path: string): string => {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};

export const isAudioPath = (path: string): boolean => AUDIO_EXTENSIONS.has(extensionOf(path));

type DropState = {
  /** Drag is hovering with at least one recognised audio file. */
  isDragOver: boolean;
  /** Count of audio files the user is currently dragging. Zero means the
   *  payload contains no supported audio — the overlay stays hidden. */
  audioCount: number;
};

/** Subscribes the current webview to Tauri's OS-level drag-drop events and
 *  invokes `onDrop` with any audio paths the user drops. Non-audio paths
 *  are silently ignored so a mixed drop (e.g. an album folder containing
 *  a cover image) still imports the tracks without an error.
 *
 *  Returns live drag state for rendering a drop overlay. */
export const useAudioFileDrop = (
  onDrop: (paths: string[]) => void
): DropState => {
  const [state, setState] = useState<DropState>({ isDragOver: false, audioCount: 0 });
  // Keep the latest `onDrop` in a ref so the Tauri listener is registered
  // exactly once. Otherwise the effect would re-run on every parent render
  // (activeId / body / title change), causing rapid subscribe/unsubscribe
  // churn that races Tauri's internal event bookkeeping and surfaces as
  // "listeners[eventId].handlerId" promise-rejection errors.
  const onDropRef = useRef(onDrop);
  useEffect(() => {
    onDropRef.current = onDrop;
  }, [onDrop]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === 'enter') {
          const audio = p.paths.filter(isAudioPath);
          setState({ isDragOver: audio.length > 0, audioCount: audio.length });
        } else if (p.type === 'leave') {
          setState({ isDragOver: false, audioCount: 0 });
        } else if (p.type === 'drop') {
          const audio = p.paths.filter(isAudioPath);
          setState({ isDragOver: false, audioCount: 0 });
          if (audio.length > 0) onDropRef.current(audio);
        }
        // `over` fires continuously while dragging — we already captured the
        // path list on `enter`, and re-filtering on every mouse move just
        // burns CPU for no visible benefit.
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* Running outside Tauri (e.g. tests, Vite preview) — no-op. */
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return state;
};
