import { Button } from '../../shared/ui/Button';
import { Modal } from '../../shared/ui/Modal';
import { CloseIcon } from '../../shared/ui/icons';
import { FilePreviewList, type FileSource } from '../../shared/ui/FilePreview';
import { formatBytes } from '../../shared/ui/FileChip';
import { AudioItemTranscript } from './AudioItemTranscript';
import type { ClipboardItem, FileEntry } from './api';

type FilePreviewDialogProps = {
  open: boolean;
  files: FileEntry[];
  onClose: () => void;
  onRevealFirst: (path: string) => void;
  onOpenFirst: (path: string) => void;
  /** When provided and the item is a single-audio-file clip, renders the
   *  transcription section below the preview. */
  audioItem?: Pick<ClipboardItem, 'id' | 'transcription'> | null;
};

/// Space-key preview for `kind='file'` clips. Renders every file via
/// the shared `FilePreviewList` so images/video/audio/code all appear
/// exactly the same as they do in Telegram inbox, note attachments,
/// and any future module — one dispatcher, one look. Wraps `Modal` so
/// focus-trap + Escape handling come from the shared primitive.
export const FilePreviewDialog = ({
  open,
  files,
  onClose,
  onRevealFirst,
  onOpenFirst,
  audioItem = null,
}: FilePreviewDialogProps) => {
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
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="File clip preview"
      maxWidth={720}
      panelClassName="pane rounded-xl w-full max-h-full flex flex-col overflow-hidden"
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
      <div className="flex-1 overflow-auto nice-scroll px-4 py-3 flex flex-col gap-4">
        <FilePreviewList files={sources} />
        {audioItem && (
          <AudioItemTranscript
            itemId={audioItem.id}
            initial={audioItem.transcription}
          />
        )}
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
    </Modal>
  );
};
