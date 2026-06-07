import { useEffect, useRef } from 'react';
import { Kbd } from './Kbd';
import { useFocusTrap } from './useFocusTrap';

export type ShortcutGroup = {
  title: string;
  items: { keys: string[]; label: string }[];
};

const globalShortcuts: ShortcutGroup = {
  title: 'Global',
  items: [
    { keys: ['⌘⇧V'], label: 'Toggle Stash popup' },
    { keys: ['⌘⇧J'], label: 'Quick-open Notes' },
    { keys: ['⌘⇧F'], label: 'Global search' },
    { keys: ['⌘⌥1', '⌘⌥2', '⌘⌥3'], label: 'Switch tab' },
    { keys: ['Esc', '⌘W'], label: 'Hide popup' },
    { keys: ['?'], label: 'Open this cheatsheet' },
  ],
};

const clipboardShortcuts: ShortcutGroup = {
  title: 'Clipboard',
  items: [
    { keys: ['↑', '↓'], label: 'Move selection' },
    { keys: ['↵'], label: 'Paste at cursor' },
    { keys: ['⇧↵'], label: 'Copy only (no paste)' },
    { keys: ['Space'], label: 'Preview text / file clip' },
    { keys: ['⌘P'], label: 'Toggle pin' },
    { keys: ['⌫'], label: 'Delete item' },
    { keys: ['⌘K'], label: 'Focus search' },
    { keys: ['⌘1', '⌘2', '⌘3', '⌘4', '⌘5'], label: 'Filter All / Text / Images / Links / Files' },
    { keys: ['Right-click'], label: 'Open row actions menu' },
    { keys: ['⇧Click'], label: 'Extend multi-selection' },
    { keys: ['⌘Click'], label: 'Toggle multi-selection' },
  ],
};

const webShortcuts: ShortcutGroup = {
  title: 'Web',
  items: [
    { keys: ['⌘W'], label: 'Close the active web tab (keeps it in the list)' },
    { keys: ['⌘S'], label: 'Collapse / expand sidebar' },
    { keys: ['⌘⇧C'], label: 'Copy active tab’s URL to clipboard' },
  ],
};

const downloadsShortcuts: ShortcutGroup = {
  title: 'Downloads',
  items: [
    { keys: ['↵'], label: 'Detect URL from input' },
    { keys: ['Space'], label: 'Pause / resume active download' },
    { keys: ['⌫'], label: 'Cancel active download' },
    { keys: ['Drag-drop'], label: 'Drop a link to auto-detect' },
  ],
};

const terminalShortcuts: ShortcutGroup = {
  title: 'Terminal',
  items: [
    { keys: ['⌘T'], label: 'New shell tab' },
    { keys: ['⌘W'], label: 'Close pane (or tab if last pane)' },
    { keys: ['⌘D'], label: 'Split pane right' },
    { keys: ['⌘⇧D'], label: 'Split pane down' },
    { keys: ['⌘E'], label: 'Maximize / restore pane' },
    { keys: ['⌘1', '…', '⌘8'], label: 'Switch to shell tab N' },
    { keys: ['⌘⌥←', '⌘⌥→'], label: 'Cycle focus between panes' },
    { keys: ['⌘K'], label: 'Clear scrollback' },
    { keys: ['⌘F'], label: 'Search scrollback' },
    { keys: ['⌘⇧E'], label: 'Toggle compose prompt' },
    { keys: ['⌘C'], label: 'Copy selection (or ^C if no selection)' },
    { keys: ['⌘V'], label: 'Paste' },
    { keys: ['↵'], label: 'Compose: send + submit' },
    { keys: ['⇧↵'], label: 'Compose: newline' },
    { keys: ['⌥↵'], label: 'Compose: insert without submitting' },
    { keys: ['Esc'], label: 'Compose: back to terminal' },
    { keys: ['Drag pane'], label: 'Drop on edge → tile; on centre → swap' },
  ],
};

export const Cheatsheet = ({
  open,
  onClose,
  tab,
}: {
  open: boolean;
  onClose: () => void;
  tab?: string;
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, open, { initialFocus: 'first' });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const groups: ShortcutGroup[] = [globalShortcuts];
  if (!tab || tab === 'clipboard') groups.push(clipboardShortcuts);
  if (!tab || tab === 'web') groups.push(webShortcuts);
  if (!tab || tab === 'downloads') groups.push(downloadsShortcuts);
  if (!tab || tab === 'terminal') groups.push(terminalShortcuts);

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(8px)' }}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="rounded-xl p-5 max-w-[560px] w-full max-h-full overflow-y-auto nice-scroll"
        style={{ background: 'rgba(30,30,30,0.95)', border: '1px solid rgba(255,255,255,0.04)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="t-primary text-heading font-semibold">Shortcuts</div>
          <button
            onClick={onClose}
            className="t-tertiary hover:t-primary text-meta px-2 py-1"
            aria-label="Close cheatsheet"
          >
            ×
          </button>
        </div>
        <div className="grid grid-cols-1 gap-4">
          {groups.map((g) => (
            <section key={g.title}>
              <div className="t-tertiary text-meta uppercase tracking-wider mb-1.5">
                {g.title}
              </div>
              <div className="divide-y divide-white/5">
                {g.items.map((it) => (
                  <div
                    key={it.label}
                    className="flex items-center justify-between py-1.5"
                  >
                    <span className="t-secondary text-body">{it.label}</span>
                    <span className="flex items-center gap-1">
                      {it.keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
};
