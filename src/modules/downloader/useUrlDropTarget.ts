import { useCallback, useState, type DragEvent } from 'react';

interface UseUrlDropTargetResult {
  isDragOver: boolean;
  handlers: {
    onDragOver: (e: DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: DragEvent) => void;
  };
}

/// Treat drag-and-drop of a URL onto the container as "paste URL & detect".
/// Reads both `text/uri-list` (native browser drag of a link) and
/// `text/plain` (plain text drop from other sources).
export const useUrlDropTarget = (
  onUrlDropped: (url: string) => void
): UseUrlDropTargetResult => {
  const [isDragOver, setIsDragOver] = useState(false);

  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const onDragLeave = useCallback(() => setIsDragOver(false), []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const text =
        e.dataTransfer.getData('text/uri-list') ||
        e.dataTransfer.getData('text/plain');
      const trimmed = text?.trim();
      if (trimmed) onUrlDropped(trimmed);
    },
    [onUrlDropped]
  );

  return { isDragOver, handlers: { onDragOver, onDragLeave, onDrop } };
};
