import { useState } from 'react';
import { modules } from '../modules/registry';
import { TabButton } from '../shared/ui/TabButton';

export const PopupShell = () => {
  const [activeId, setActiveId] = useState(modules[0]?.id ?? '');
  const active = modules.find((m) => m.id === activeId);
  const Popup = active?.PopupView;

  return (
    <div className="pane rounded-2xl overflow-hidden flex flex-col" style={{ width: 560, height: 480 }}>
      <header className="flex items-center gap-1 px-2 py-1.5 border-b hair">
        {modules.map((m, i) => (
          <TabButton
            key={m.id}
            label={m.title}
            shortcutHint={`⌘${i + 1}`}
            active={m.id === activeId}
            onClick={() => setActiveId(m.id)}
          />
        ))}
      </header>
      <main className="flex-1 overflow-hidden nice-scroll">
        {Popup ? <Popup /> : <div className="p-4 t-tertiary text-meta">No popup view.</div>}
      </main>
    </div>
  );
};
