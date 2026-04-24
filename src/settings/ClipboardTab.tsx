import { NumberInput } from '../shared/ui/NumberInput';
import { Select } from '../shared/ui/Select';
import { Toggle } from '../shared/ui/Toggle';
import { TARGET_LANGUAGES } from '../modules/translator/languages';
import { SettingRow } from './SettingRow';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import { TranslatorTestRow } from './TranslatorTestRow';
import type { Settings } from './store';

interface ClipboardTabProps {
  settings: Settings;
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

export const ClipboardTab = ({ settings, onChange }: ClipboardTabProps) => (
  <div className="max-w-[560px] mx-auto space-y-6">
    <section>
      <SettingsSectionHeader label="HISTORY" />
      <div className="divide-y divide-white/5">
        <SettingRow
          title="Max history items"
          description="Older unpinned items are trimmed automatically."
          control={
            <NumberInput
              size="sm"
              ariaLabel="Max history items"
              min={10}
              max={10000}
              value={settings.maxHistoryItems}
              onChange={(v) =>
                onChange(
                  'maxHistoryItems',
                  Math.max(10, Math.min(10000, v ?? 10)),
                )
              }
              className="w-24"
            />
          }
        />
      </div>
    </section>

    <section>
      <SettingsSectionHeader label="AUTO-TRANSLATE" />
      <div className="divide-y divide-white/5">
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
                <NumberInput
                  size="sm"
                  ariaLabel="Minimum translate length"
                  min={1}
                  max={200}
                  value={settings.translateMinChars}
                  onChange={(v) =>
                    onChange(
                      'translateMinChars',
                      Math.max(1, Math.min(200, v ?? 1)),
                    )
                  }
                  className="w-20"
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
    </section>
  </div>
);
