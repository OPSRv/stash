import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { modules } from '../modules/registry';
import { TabButton } from '../shared/ui/TabButton';

export const PopupShell = () => {
  const [activeId, setActiveId] = useState(modules[0]?.id ?? '');
  const active = modules.find((m) => m.id === activeId);
  const Popup = active?.PopupView;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        getCurrentWindow()
          .hide()
          .catch(() => {});
        return;
      }
      // ⌘⌥1/2/3 switch modules (leaves ⌘1-4 free for clipboard filters)
      if (e.metaKey && e.altKey && /^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        if (modules[idx]) {
          e.preventDefault();
          setActiveId(modules[idx].id);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="pane h-full w-full rounded-2xl overflow-hidden flex flex-col">
      <header className="flex items-center gap-1 px-2 py-1.5 border-b hair">
        {modules.map((m, i) => (
          <TabButton
            key={m.id}
            label={m.title}
            shortcutHint={`⌘⌥${i + 1}`}
            active={m.id === activeId}
            onClick={() => setActiveId(m.id)}
          />
        ))}
      </header>
      <main className="flex-1 overflow-hidden">
        {Popup ? <Popup /> : <div className="p-4 t-tertiary text-meta">No view.</div>}
      </main>
    </div>
  );
};
