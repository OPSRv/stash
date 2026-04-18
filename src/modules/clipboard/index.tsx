import type { ModuleDefinition } from '../types';

function ClipboardPopup() {
  return (
    <div className="p-4 t-secondary text-body">
      <div className="section-label mb-2">Clipboard</div>
      <div className="t-tertiary text-meta">Phase 1 — implementation pending.</div>
    </div>
  );
}

export const clipboardModule: ModuleDefinition = {
  id: 'clipboard',
  title: 'Clipboard',
  shortcut: 'CmdOrCtrl+Shift+V',
  PopupView: ClipboardPopup,
};
