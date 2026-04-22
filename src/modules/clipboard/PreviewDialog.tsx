import { Button } from '../../shared/ui/Button';
import { Modal } from '../../shared/ui/Modal';
import { CloseIcon } from '../../shared/ui/icons';

type PreviewDialogProps = {
  open: boolean;
  text: string;
  onClose: () => void;
  onCopy: () => void;
  onSaveToNote: () => void;
};

export const PreviewDialog = ({
  open,
  text,
  onClose,
  onCopy,
  onSaveToNote,
}: PreviewDialogProps) => {
  const lineCount = text.split('\n').length;
  const charCount = text.length;

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="Clipboard preview"
      maxWidth={620}
      panelClassName="pane rounded-xl w-full max-h-full flex flex-col overflow-hidden"
    >
      <header className="px-4 py-2.5 flex items-center justify-between border-b hair">
        <div className="t-tertiary text-meta font-mono">
          {charCount.toLocaleString()} chars · {lineCount.toLocaleString()}{' '}
          {lineCount === 1 ? 'line' : 'lines'}
        </div>
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
        <pre className="t-primary text-body whitespace-pre-wrap break-words font-mono leading-relaxed m-0">
          {text}
        </pre>
      </div>
      <footer className="px-4 py-2.5 border-t hair flex items-center justify-end gap-2">
        <Button variant="soft" tone="accent" size="sm" onClick={onSaveToNote}>
          Save to note
        </Button>
        <Button variant="soft" size="sm" onClick={onCopy}>
          Copy
        </Button>
      </footer>
    </Modal>
  );
};
