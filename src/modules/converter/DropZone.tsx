import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { accent } from '../../shared/theme/accent';
import { UploadIcon, SpeakerIcon } from '../../shared/ui/icons';
import { isSupportedMedia, SUPPORTED_EXTENSIONS } from './api';

type DropZoneProps = {
  onPick: (path: string) => void;
  pendingFile?: string | null;
  /// One-line bar variant. Switches on once the user has at least one
  /// pending or completed job — the hero treatment is only justified
  /// on the empty state.
  compact?: boolean;
};

/// Drag-and-drop + file-picker for the converter. Accepts the union of
/// audio and video extensions ffmpeg recognises (see api.ts). Mirrors
/// `modules/separator/DropZone` — the Tauri-2 webview-level drag-drop
/// is the only way to get real filesystem paths under hardened builds.
export function DropZone({ onPick, pendingFile, compact = false }: DropZoneProps) {
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickFile = useCallback(async () => {
    setError(null);
    await invoke('set_popup_auto_hide', { enabled: false });
    try {
      const sel = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: 'Media', extensions: SUPPORTED_EXTENSIONS }],
      });
      if (typeof sel === 'string' && sel) onPick(sel);
    } catch (e) {
      setError(String(e));
    } finally {
      await invoke('set_popup_auto_hide', { enabled: true });
    }
  }, [onPick]);

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
          const accepted = p.paths.filter(isSupportedMedia);
          if (accepted.length > 0) setOver(true);
        } else if (p.type === 'leave') {
          setOver(false);
        } else if (p.type === 'drop') {
          setOver(false);
          const accepted = p.paths.filter(isSupportedMedia);
          if (accepted.length === 0) {
            const first = p.paths[0];
            if (first) {
              const ext = first.split('.').pop() ?? '';
              setError(`Unsupported format: .${ext}`);
            }
            return;
          }
          setError(null);
          // First file wins — converter handles one queue at a time.
          onPickRef.current(accepted[0]);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* outside Tauri */
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

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
    'data-testid': 'converter-dropzone',
    'data-pending-file': pendingFile ?? undefined,
    role: 'button' as const,
    tabIndex: 0,
    'aria-label': 'Drop or pick an audio / video file',
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
            {over ? <UploadIcon size={14} /> : <SpeakerIcon size={14} />}
          </div>
          <span className="t-primary text-meta font-medium truncate">
            {over ? 'Drop to load' : 'Drop a media file or click to pick'}
          </span>
          <span className="t-tertiary text-meta truncate ml-auto">
            audio + video
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
        borderColor: over ? 'rgb(var(--stash-accent-rgb))' : 'var(--hairline)',
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
        {over ? <UploadIcon size={20} /> : <SpeakerIcon size={20} />}
      </div>
      <div className="flex flex-col gap-1">
        <p className="t-primary text-body font-medium">
          {over ? 'Drop to load' : 'Drop an audio or video file'}
        </p>
        <p className="t-tertiary text-meta">
          Convert · extract audio · transcribe · split into stems
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
