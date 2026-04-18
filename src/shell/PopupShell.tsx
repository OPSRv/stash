import { useState } from 'react';
import { modules } from '../modules/registry';

export function PopupShell() {
  const [activeId, setActiveId] = useState(modules[0]?.id ?? '');
  const active = modules.find((m) => m.id === activeId);
  const Popup = active?.PopupView;

  return (
    <div className="pane rounded-2xl overflow-hidden flex flex-col" style={{ width: 560, height: 480 }}>
      <header className="flex items-center gap-1 px-2 py-1.5 border-b hair">
        {modules.map((m, i) => (
          <button
            key={m.id}
            onClick={() => setActiveId(m.id)}
            className={`px-2 py-1 rounded-md text-meta font-medium flex items-center gap-1.5 ${
              m.id === activeId ? 't-primary' : 't-secondary'
            }`}
            style={m.id === activeId ? { background: 'rgba(255,255,255,0.06)' } : undefined}
          >
            <span className="kbd">⌘{i + 1}</span>
            {m.title}
          </button>
        ))}
      </header>
      <main className="flex-1 overflow-hidden nice-scroll">
        {Popup ? <Popup /> : <div className="p-4 t-tertiary text-meta">No popup view.</div>}
      </main>
    </div>
  );
}
