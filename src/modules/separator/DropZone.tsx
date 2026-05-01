import { useCallback, useState, type DragEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Button } from '../../shared/ui/Button';
import { isSupportedAudio, SUPPORTED_EXTENSIONS } from './api';

type DropZoneProps = {
  onPick: (path: string) => void;
  /** When the user navigated here from another module with a file
   *  pre-selected, surface it as a `data-pending-file` attr so a
   *  selector can drive Playwright. */
  pendingFile?: string | null;
};

export function DropZone({ onPick, pendingFile }: DropZoneProps) {
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

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setOver(true);
  }, []);
  const handleDragLeave = useCallback(() => setOver(false), []);
  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setOver(false);
      setError(null);
      const f = e.dataTransfer.files?.[0];
      if (!f) return;
      // Tauri's webview attaches `path` on dropped File objects; pure
      // browser drops only have `name`. We need the absolute path so
      // the sidecar can read the file — fall back to `name` so test
      // doubles still flow through but flag a clear error.
      const path = (f as unknown as { path?: string }).path ?? f.name;
      if (!isSupportedAudio(path)) {
        const ext = path.split('.').pop() ?? '';
        setError(`Unsupported format: .${ext}`);
        return;
      }
      onPick(path);
    },
    [onPick],
  );

  return (
    <div
      data-testid="separator-dropzone"
      data-pending-file={pendingFile ?? undefined}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`flex flex-col items-center gap-3 rounded-md border border-dashed p-8 text-center transition-colors ${
        over ? 'border-white/40 bg-white/5' : 'border-white/15'
      }`}
    >
      <p className="text-body opacity-80">Drop an audio file here</p>
      <p className="text-meta opacity-60">
        mp3, m4a, flac, ogg, wav, aac, aiff, opus
      </p>
      <Button onClick={pickFile} variant="soft">
        Or pick a file…
      </Button>
      {error && (
        <p role="alert" className="text-meta text-red-300/80">
          {error}
        </p>
      )}
    </div>
  );
}
