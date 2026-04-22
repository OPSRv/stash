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
    { keys: ['⌘⇧N'], label: 'Quick-open Notes' },
    { keys: ['⌘⇧F'], label: 'Global search' },
    { keys: ['⌘⌥1', '⌘⌥2', '⌘⌥3'], label: 'Switch tab' },
    { keys: ['Esc'], label: 'Hide popup' },
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

const metronomeShortcuts: ShortcutGroup = {
  title: 'Metronome',
  items: [
    { keys: ['Space'], label: 'Play / pause' },
    { keys: ['↑', '↓'], label: '±1 BPM (Shift = ±5)' },
    { keys: ['T'], label: 'Tap tempo' },
    { keys: ['1', '2', '3', '4'], label: 'Subdivision' },
    { keys: ['[', ']'], label: 'Cycle time signature' },
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
  if (!tab || tab === 'downloads') groups.push(downloadsShortcuts);
  if (!tab || tab === 'metronome') groups.push(metronomeShortcuts);

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
