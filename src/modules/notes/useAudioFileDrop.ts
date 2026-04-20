import { useEffect, useRef, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';

/** Container extensions we accept for audio embeds. Matches the Rust-side
 *  whitelist in `sanitize_ext` — keep them in sync. */
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

/** Image formats accepted by the inline image embed path. Mirrors the
 *  Rust-side `ALLOWED_IMAGE_EXT`. */
const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'heic',
  'heif',
]);

const extensionOf = (path: string): string => {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};

export const isAudioPath = (path: string): boolean => AUDIO_EXTENSIONS.has(extensionOf(path));
export const isImagePath = (path: string): boolean => IMAGE_EXTENSIONS.has(extensionOf(path));

/** Split a raw list of dropped paths into the two accepted categories, in
 *  original order so the caller can reconstruct the drop sequence if it
 *  ever matters (e.g. a mixed audio+image drop that wants embeds laid out
 *  in the same order the user let go of the mouse). */
const classify = (paths: string[]): { audio: string[]; image: string[] } => {
  const audio: string[] = [];
  const image: string[] = [];
  for (const p of paths) {
    if (isAudioPath(p)) audio.push(p);
    else if (isImagePath(p)) image.push(p);
  }
  return { audio, image };
};

type DropState = {
  /** Drag is hovering with at least one recognised audio or image file. */
  isDragOver: boolean;
  /** Count of audio files the user is currently dragging. */
  audioCount: number;
  /** Count of image files the user is currently dragging. */
  imageCount: number;
};

type DropPaths = {
  audio: string[];
  image: string[];
};

/** Subscribes the current webview to Tauri's OS-level drag-drop events and
 *  invokes `onDrop` with any media paths the user drops, split by type.
 *  Non-media paths are silently ignored so a mixed drop (e.g. a folder with
 *  a PDF alongside tracks) still imports the recognised media.
 *
 *  Returns live drag state for rendering a drop overlay. */
export const useAudioFileDrop = (onDrop: (paths: DropPaths) => void): DropState => {
  const [state, setState] = useState<DropState>({
    isDragOver: false,
    audioCount: 0,
    imageCount: 0,
  });
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
          const { audio, image } = classify(p.paths);
          const total = audio.length + image.length;
          setState({
            isDragOver: total > 0,
            audioCount: audio.length,
            imageCount: image.length,
          });
        } else if (p.type === 'leave') {
          setState({ isDragOver: false, audioCount: 0, imageCount: 0 });
        } else if (p.type === 'drop') {
          const buckets = classify(p.paths);
          setState({ isDragOver: false, audioCount: 0, imageCount: 0 });
          if (buckets.audio.length + buckets.image.length > 0) onDropRef.current(buckets);
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
