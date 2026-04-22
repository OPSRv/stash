import { useEffect, useRef } from 'react';
import { Button } from '../../shared/ui/Button';
import { CloseIcon } from '../../shared/ui/icons';
import { FilePreviewList, type FileSource } from '../../shared/ui/FilePreview';
import { useFocusTrap } from '../../shared/ui/useFocusTrap';
import { formatBytes } from '../../shared/ui/FileChip';
import type { FileEntry } from './api';

type FilePreviewDialogProps = {
  open: boolean;
  files: FileEntry[];
  onClose: () => void;
  onRevealFirst: (path: string) => void;
  onOpenFirst: (path: string) => void;
};

/// Space-key preview for `kind='file'` clips. Renders every file via
/// the shared `FilePreviewList` so images/video/audio/code all appear
/// exactly the same as they do in Telegram inbox, note attachments,
/// and any future module — one dispatcher, one look. Focus-trapped
/// and Esc-closable to match the text-preview dialog.
export const FilePreviewDialog = ({
  open,
  files,
  onClose,
  onRevealFirst,
  onOpenFirst,
}: FilePreviewDialogProps) => {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(panelRef, open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const totalBytes = files.reduce((s, f) => s + (f.size ?? 0), 0);
  const summary = `${files.length} ${files.length === 1 ? 'file' : 'files'}${
    totalBytes > 0 ? ` · ${formatBytes(totalBytes)}` : ''
  }`;
  const sources: FileSource[] = files.map((f) => ({
    src: f.path,
    name: f.name,
    mime: f.mime,
    sizeBytes: f.size,
  }));
  const first = files[0];

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="File clip preview"
        onClick={(e) => e.stopPropagation()}
        className="pane rounded-xl w-full max-w-[720px] max-h-full flex flex-col overflow-hidden"
      >
        <header className="px-4 py-2.5 flex items-center justify-between border-b hair">
          <div className="t-tertiary text-meta font-mono">{summary}</div>
          <Button
            size="sm"
            variant="ghost"
            shape="square"
            onClick={onClose}
            aria-label="Close preview"
            title="Close (Esc)"
          >
            <CloseIcon size={12} />
          </Button>
        </header>
        <div className="flex-1 overflow-auto nice-scroll px-4 py-3">
          <FilePreviewList files={sources} />
        </div>
        <footer className="px-4 py-2.5 border-t hair flex items-center justify-end gap-2">
          {first && (
            <>
              <Button variant="ghost" size="sm" onClick={() => onRevealFirst(first.path)}>
                Reveal in Finder
              </Button>
              <Button variant="soft" tone="accent" size="sm" onClick={() => onOpenFirst(first.path)}>
                Open
              </Button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
};
