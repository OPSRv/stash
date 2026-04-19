import { Select } from '../shared/ui/Select';
import { Toggle } from '../shared/ui/Toggle';
import { TARGET_LANGUAGES } from '../modules/translator/languages';
import { SettingRow } from './SettingRow';
import { TranslatorTestRow } from './TranslatorTestRow';
import type { Settings } from './store';

interface ClipboardTabProps {
  settings: Settings;
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

export const ClipboardTab = ({ settings, onChange }: ClipboardTabProps) => (
  <div className="divide-y divide-white/5">
    <SettingRow
      title="Max history items"
      description="Older unpinned items are trimmed automatically."
      control={
        <input
          aria-label="Max history items"
          type="number"
          min={10}
          max={10000}
          value={settings.maxHistoryItems}
          onChange={(e) =>
            onChange('maxHistoryItems', Math.max(10, Number(e.currentTarget.value) || 0))
          }
          className="input-field rounded-md px-2 py-1 w-24 text-body"
        />
      }
    />
    <SettingRow
      title="Auto-translate foreign clips"
      description="When you copy text in another script (e.g. English), translate it and show a popup with the result."
      control={
        <Toggle
          checked={settings.translateEnabled}
          onChange={(v) => onChange('translateEnabled', v)}
          label="Auto-translate"
        />
      }
    />
    {settings.translateEnabled && (
      <>
        <SettingRow
          title="Translate into"
          description="Target language. Source is detected automatically."
          control={
            <Select
              label="Translate into"
              value={settings.translateTarget}
              onChange={(v) => onChange('translateTarget', v)}
              options={TARGET_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
            />
          }
        />
        <SettingRow
          title="Minimum length"
          description="Skip very short clips so single words don't spam the banner."
          control={
            <input
              aria-label="Minimum translate length"
              type="number"
              min={1}
              max={200}
              value={settings.translateMinChars}
              onChange={(e) =>
                onChange(
                  'translateMinChars',
                  Math.max(1, Math.min(200, Number(e.currentTarget.value) || 1)),
                )
              }
              className="input-field rounded-md px-2 py-1 w-20 text-body"
            />
          }
        />
        <SettingRow
          title="Show system notification"
          description="Also send a native notification so translations reach you when the popup is hidden."
          control={
            <Toggle
              checked={settings.translateShowNotification}
              onChange={(v) => onChange('translateShowNotification', v)}
              label="Notification on translation"
            />
          }
        />
        <TranslatorTestRow target={settings.translateTarget} />
      </>
    )}
  </div>
);
