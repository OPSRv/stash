import { useEffect, useRef } from 'react';
import { Button } from '../../shared/ui/Button';
import { CloseIcon } from '../../shared/ui/icons';
import { useFocusTrap } from '../../shared/ui/useFocusTrap';

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

  const lineCount = text.split('\n').length;
  const charCount = text.length;

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
        aria-label="Clipboard preview"
        onClick={(e) => e.stopPropagation()}
        className="pane rounded-xl w-full max-w-[620px] max-h-full flex flex-col overflow-hidden"
      >
        <header className="px-4 py-2.5 flex items-center justify-between border-b hair">
          <div className="t-tertiary text-meta font-mono">
            {charCount.toLocaleString()} chars · {lineCount.toLocaleString()} {lineCount === 1 ? 'line' : 'lines'}
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
      </div>
    </div>
  );
};
