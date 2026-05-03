import { Button } from '../shared/ui/Button';
import { SegmentedControl } from '../shared/ui/SegmentedControl';
import { AppearancePreview } from './AppearancePreview';
import { SettingRow } from './SettingRow';
import { SettingsSection, SettingsTab } from './SettingsLayout';
import { SliderField } from './SliderField';
import { AutoIcon, MoonIcon, SunIcon } from './themeIcons';
import { DEFAULT_SETTINGS, type Settings } from './store';
import { ACCENTS, type AccentKey, type ThemeMode } from './theme';

interface AppearanceTabProps {
  settings: Settings;
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

const themeModeOptions = [
  { value: 'auto' as ThemeMode, label: 'System', icon: <AutoIcon /> },
  { value: 'light' as ThemeMode, label: 'Light', icon: <SunIcon /> },
  { value: 'dark' as ThemeMode, label: 'Dark', icon: <MoonIcon /> },
];

export const AppearanceTab = ({ settings, onChange }: AppearanceTabProps) => {
  const accentKeys = Object.keys(ACCENTS) as AccentKey[];
  const accent = ACCENTS[settings.themeAccent];

  return (
    <SettingsTab>
      <SettingsSection label="PREVIEW" divided={false}>
        <AppearancePreview settings={settings} />
      </SettingsSection>

      <SettingsSection label="THEME">
        <SettingRow
          title="Mode"
          description="Dark, light, or follow the system."
          control={
            <SegmentedControl
              size="sm"
              ariaLabel="Theme mode"
              options={themeModeOptions}
              value={settings.themeMode}
              onChange={(v) => onChange('themeMode', v)}
            />
          }
        />
        <SettingRow
          title="Reset"
          description="Restore Appearance defaults."
          control={
            <Button
              size="sm"
              onClick={() => {
                onChange('themeMode', DEFAULT_SETTINGS.themeMode);
                onChange('themeBlur', DEFAULT_SETTINGS.themeBlur);
                onChange('themePaneOpacity', DEFAULT_SETTINGS.themePaneOpacity);
                onChange('themeAccent', DEFAULT_SETTINGS.themeAccent);
              }}
            >
              Reset
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection label="ACCENT" divided={false}>
        <div className="flex items-center gap-2 flex-wrap" role="radiogroup" aria-label="Accent">
          {accentKeys.map((key) => {
            const swatch = ACCENTS[key];
            const isSelected = settings.themeAccent === key;
            return (
              <Button
                key={key}
                role="radio"
                aria-checked={isSelected}
                onClick={() => onChange('themeAccent', key)}
                title={`Accent ${swatch.label}`}
                aria-label={`Accent ${swatch.label}`}
                className="!w-9 !h-9 !p-0 !rounded-xl !border-0 transition-transform"
                style={{
                  background: swatch.hex,
                  outline: isSelected
                    ? `2px solid ${swatch.hex}`
                    : '1px solid rgba(127,127,127,0.25)',
                  outlineOffset: isSelected ? 2 : 0,
                  transform: isSelected ? 'scale(1.05)' : 'scale(1)',
                  boxShadow: isSelected
                    ? '0 0 0 1.5px var(--color-bg-pane, #1c1c20)'
                    : undefined,
                }}
              />
            );
          })}
        </div>
        <div className="mt-2 t-tertiary text-meta">
          {accent.label} · <span className="font-mono">{accent.hex}</span>
        </div>
      </SettingsSection>

      <SettingsSection label="SURFACE">
        <SliderField
          label="Translucency"
          description="How much of the desktop shows through."
          value={Math.round(settings.themePaneOpacity * 100)}
          min={0}
          max={100}
          step={2}
          onChange={(v) =>
            onChange('themePaneOpacity', Math.max(0, Math.min(1, v / 100)))
          }
          display={`${Math.round(settings.themePaneOpacity * 100)} %`}
        />
        <SliderField
          label="Blur"
          description="Frosted-glass strength behind the popup."
          value={settings.themeBlur}
          min={0}
          max={60}
          step={1}
          onChange={(v) => onChange('themeBlur', Math.max(0, Math.min(60, v)))}
          display={`${settings.themeBlur} px`}
        />
      </SettingsSection>
    </SettingsTab>
  );
};
