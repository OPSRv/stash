import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { accent } from '../../shared/theme/accent';
import { UploadIcon, WaveformIcon } from '../../shared/ui/icons';
import { isSupportedAudio, SUPPORTED_EXTENSIONS } from './api';

type DropZoneProps = {
  onPick: (path: string) => void;
  /** When the user navigated here from another module with a file
   *  pre-selected, surface it as a `data-pending-file` attr so a
   *  selector can drive Playwright. */
  pendingFile?: string | null;
  /** When `true`, render a one-line bar (~44px) instead of the centered
   *  hero. Used by the shell when there's already history below — full
   *  hero treatment is only justified on the empty state. */
  compact?: boolean;
};

export function DropZone({ onPick, pendingFile, compact = false }: DropZoneProps) {
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickFile = useCallback(async () => {
    setError(null);
    // The native file picker steals focus; without auto-hide off, the
    // popup's blur handler would dismiss us mid-pick. Mirrors the
    // pattern in `SettingsShell` folder picker.
    await invoke('set_popup_auto_hide', { enabled: false });
    try {
      const sel = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: 'Audio', extensions: SUPPORTED_EXTENSIONS }],
      });
      if (typeof sel === 'string' && sel) onPick(sel);
    } catch (e) {
      setError(String(e));
    } finally {
      await invoke('set_popup_auto_hide', { enabled: true });
    }
  }, [onPick]);

  // Tauri 2 OS-level drag-drop. HTML5 drop events don't carry the
  // absolute path in Tauri — `dataTransfer.files[0].path` is unreliable
  // and undefined under hardened WebView builds. The webview-level
  // `onDragDropEvent` is the only way to get real filesystem paths.
  // Mirrors `notes/useAudioFileDrop.ts`.
  const onPickRef = useRef(onPick);
  useEffect(() => {
    onPickRef.current = onPick;
  }, [onPick]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === 'enter') {
          const audioPaths = p.paths.filter(isSupportedAudio);
          if (audioPaths.length > 0) setOver(true);
        } else if (p.type === 'leave') {
          setOver(false);
        } else if (p.type === 'drop') {
          setOver(false);
          const audioPaths = p.paths.filter(isSupportedAudio);
          if (audioPaths.length === 0) {
            const first = p.paths[0];
            if (first) {
              const ext = first.split('.').pop() ?? '';
              setError(`Unsupported format: .${ext}`);
            }
            return;
          }
          setError(null);
          // First file wins — separator processes one job at a time.
          onPickRef.current(audioPaths[0]);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* outside Tauri (tests, vite preview) — drop is a no-op there */
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Keyboard activation — `role="button"` without Enter / Space handlers
  // is a screen-reader trap. Both stick to the same WAI-ARIA convention.
  const onKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        void pickFile();
      }
    },
    [pickFile],
  );

  const commonProps = {
    'data-testid': 'separator-dropzone',
    'data-pending-file': pendingFile ?? undefined,
    role: 'button' as const,
    tabIndex: 0,
    'aria-label': 'Drop or pick an audio file',
    onClick: pickFile,
    onKeyDown: onKey,
  };

  if (compact) {
    return (
      <div className="flex flex-col gap-1">
        <div
          {...commonProps}
          className="group flex items-center gap-3 rounded-lg border border-dashed px-3 py-2 transition-all duration-150 cursor-pointer ring-focus"
          style={{
            borderColor: over ? 'rgb(var(--stash-accent-rgb))' : 'var(--hairline)',
            background: over ? accent(0.08) : 'transparent',
          }}
        >
          <div
            className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 transition-transform duration-150 group-hover:scale-105"
            style={{
              background: accent(over ? 0.22 : 0.14),
              color: 'rgb(var(--stash-accent-rgb))',
            }}
            aria-hidden
          >
            {over ? <UploadIcon size={14} /> : <WaveformIcon size={14} />}
          </div>
          <span className="t-primary text-meta font-medium truncate">
            {over ? 'Drop to start splitting' : 'Drop an audio file or click to pick'}
          </span>
          <span className="t-tertiary text-meta truncate ml-auto">
            {SUPPORTED_EXTENSIONS.slice(0, 5).join(', ')}…
          </span>
        </div>
        {error && (
          <p
            role="alert"
            className="text-meta px-2 py-0.5 rounded"
            style={{
              color: 'rgba(239, 68, 68, 0.95)',
              background: 'rgba(239, 68, 68, 0.08)',
            }}
          >
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      {...commonProps}
      className="group relative flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center transition-all duration-150 cursor-pointer ring-focus"
      style={{
        borderColor: over
          ? 'rgb(var(--stash-accent-rgb))'
          : 'var(--hairline)',
        background: over ? accent(0.08) : 'transparent',
      }}
    >
      <div
        className="w-12 h-12 rounded-full flex items-center justify-center transition-transform duration-150 group-hover:scale-105"
        style={{
          background: accent(over ? 0.22 : 0.14),
          color: 'rgb(var(--stash-accent-rgb))',
        }}
        aria-hidden
      >
        {over ? <UploadIcon size={20} /> : <WaveformIcon size={20} />}
      </div>
      <div className="flex flex-col gap-1">
        <p className="t-primary text-body font-medium">
          {over ? 'Drop to start splitting' : 'Drop an audio file or click to pick'}
        </p>
        <p className="t-tertiary text-meta">
          {SUPPORTED_EXTENSIONS.join(', ')}
        </p>
      </div>
      {error && (
        <p
          role="alert"
          className="text-meta mt-1 px-2 py-0.5 rounded"
          style={{
            color: 'rgba(239, 68, 68, 0.95)',
            background: 'rgba(239, 68, 68, 0.08)',
          }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
