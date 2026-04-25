import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';

import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { useToast } from './Toast';

type LightboxProps = {
  src: string;
  alt?: string;
  onClose: () => void;
  /// Original filesystem path of the image. Required for the
  /// "Save image as…" / "Copy image" menu items — the asset-protocol
  /// `src` URL can't be unwrapped back into a filesystem path on the
  /// Rust side. When omitted, the context menu still appears but with
  /// the file actions disabled.
  path?: string;
};

const basename = (p: string) => p.replace(/^.*[\\/]/, '');

const extOf = (p: string): string => {
  const m = /\.([a-zA-Z0-9]+)$/.exec(p);
  return m ? m[1].toLowerCase() : 'png';
};

/// Full-popup image viewer. Click-outside or Esc closes. Right-click
/// opens a context menu with "Copy image" and "Save image as…" so the
/// user can yank the bytes out of the popup without leaving Stash.
export const Lightbox = ({ src, alt, onClose, path }: LightboxProps) => {
  const { toast } = useToast();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copyToClipboard = async () => {
    if (!path) return;
    try {
      await invoke('clipboard_copy_image_from_path', { path });
      toast({ title: 'Image copied', variant: 'success' });
    } catch (e) {
      toast({
        title: 'Copy failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      });
    }
  };

  const saveAs = async () => {
    if (!path) return;
    // Suspend the popup auto-hide while the save dialog is on screen,
    // otherwise clicking the dialog blurs Stash and dismisses both.
    await invoke('set_popup_auto_hide', { enabled: false }).catch(() => {});
    try {
      const dst = await saveDialog({
        defaultPath: basename(path),
        filters: [
          { name: 'Image', extensions: [extOf(path)] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      if (!dst) return;
      await invoke('save_file_to', { src: path, dst });
      toast({ title: 'Image saved', description: basename(dst), variant: 'success' });
    } catch (e) {
      toast({
        title: 'Save failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      });
    } finally {
      await invoke('set_popup_auto_hide', { enabled: true }).catch(() => {});
    }
  };

  const items: ContextMenuItem[] = [
    {
      kind: 'action',
      label: 'Copy image',
      shortcut: '⌘C',
      disabled: !path,
      onSelect: () => void copyToClipboard(),
    },
    {
      kind: 'action',
      label: 'Save image as…',
      shortcut: '⌘S',
      disabled: !path,
      onSelect: () => void saveAs(),
    },
  ];

  return (
    <div
      role="dialog"
      aria-label="Image preview"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-6"
    >
      <img
        src={src}
        alt={alt ?? 'image preview'}
        className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="Close preview"
        className="absolute top-4 right-4 w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white/90 flex items-center justify-center transition-colors"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={items}
        onClose={() => setMenu(null)}
        label="Image actions"
      />
    </div>
  );
};
