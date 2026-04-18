import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { modules } from '../modules/registry';

export const PopupShell = () => {
  const active = modules[0];
  const Popup = active?.PopupView;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        getCurrentWindow()
          .hide()
          .catch(() => {});
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="pane h-full w-full rounded-2xl overflow-hidden flex flex-col">
      {Popup ? <Popup /> : <div className="p-4 t-tertiary text-meta">No popup view.</div>}
    </div>
  );
};
