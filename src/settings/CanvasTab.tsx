import { useState } from 'react';
import { Button } from '../shared/ui/Button';
import { SettingRow } from './SettingRow';
import { SettingsSection, SettingsTab } from './SettingsLayout';
import { canvasSetCaptureShortcuts } from '../modules/canvas/api';
import type { Settings } from './store';

interface Props {
  settings: Settings;
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

const DEFAULT_IMAGE = 'CommandOrControl+Shift+S';
const DEFAULT_TEXT = 'CommandOrControl+Shift+O';

/** e.code → the key segment of a Tauri accelerator. */
const codeToKey = (code: string): string | null => {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  const map: Record<string, string> = {
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.',
    Slash: '/', Backslash: '\\', Backquote: '`', Space: 'Space',
  };
  return map[code] ?? null;
};

const toAccel = (e: React.KeyboardEvent): string | null => {
  const key = codeToKey(e.code);
  if (!key) return null;
  const mods: string[] = [];
  if (e.metaKey || e.ctrlKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (!mods.length) return null; // a bare key is too easy to fire by accident
  return [...mods, key].join('+');
};

const pretty = (accel: string): string =>
  accel
    .split('+')
    .map((p) =>
      p === 'CommandOrControl' || p === 'Command' || p === 'Super'
        ? '⌘'
        : p === 'Control'
          ? '⌃'
          : p === 'Shift'
            ? '⇧'
            : p === 'Alt'
              ? '⌥'
              : p,
    )
    .join('');

const ShortcutField = ({
  value,
  onCapture,
}: {
  value: string;
  onCapture: (accel: string) => void;
}) => {
  const [recording, setRecording] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={(e) => {
        if (!recording) return;
        e.preventDefault();
        if (e.key === 'Escape') {
          setRecording(false);
          return;
        }
        const accel = toAccel(e);
        if (accel) {
          onCapture(accel);
          setRecording(false);
        }
      }}
      className="input-field ring-focus-within h-8 w-[150px] rounded-[var(--r-lg)] px-2 text-center font-mono text-body"
      aria-label="Record shortcut"
    >
      {recording ? 'Press keys…' : pretty(value)}
    </button>
  );
};

export const CanvasTab = ({ settings, onChange }: Props) => {
  const apply = (image: string, text: string) =>
    void canvasSetCaptureShortcuts(image, text).catch(() => {});

  const setImage = (accel: string) => {
    onChange('canvasCaptureImageShortcut', accel);
    apply(accel, settings.canvasCaptureTextShortcut);
  };
  const setText = (accel: string) => {
    onChange('canvasCaptureTextShortcut', accel);
    apply(settings.canvasCaptureImageShortcut, accel);
  };
  const reset = () => {
    onChange('canvasCaptureImageShortcut', DEFAULT_IMAGE);
    onChange('canvasCaptureTextShortcut', DEFAULT_TEXT);
    apply(DEFAULT_IMAGE, DEFAULT_TEXT);
  };

  return (
    <SettingsTab>
      <SettingsSection label="GLOBAL CAPTURE SHORTCUTS">
        <SettingRow
          title="Capture region → Canvas"
          description="Grab a screen region anywhere and open it in the Canvas editor for annotation. Click and press a key combo to rebind (a modifier is required)."
          control={<ShortcutField value={settings.canvasCaptureImageShortcut} onCapture={setImage} />}
        />
        <SettingRow
          title="Capture region → OCR text"
          description="Grab a screen region, recognise its text with Apple Vision, and copy it to the clipboard."
          control={<ShortcutField value={settings.canvasCaptureTextShortcut} onCapture={setText} />}
        />
        <SettingRow
          title="Reset to defaults"
          description="⌘⇧S for image capture, ⌘⇧O for text capture. Defaults avoid the native macOS screenshot shortcuts (⌘⇧3/4/5)."
          control={
            <Button size="sm" variant="soft" onClick={reset}>
              Reset
            </Button>
          }
        />
      </SettingsSection>
      <SettingsSection label="EDITOR SHORTCUTS" divided={false}>
        <SettingRow
          title="In-canvas keys"
          description="Tools V/R/O/L/A/P/T/H/C/B/E/X · ⌘Z undo · ⌘D duplicate · ⌘C/⌘V copy-paste · ⌘S save · ⌫ delete · Space-drag pan · ⌘/two-finger zoom. Press ? in the Canvas tab for the full cheatsheet."
          control={<span />}
        />
      </SettingsSection>
    </SettingsTab>
  );
};
