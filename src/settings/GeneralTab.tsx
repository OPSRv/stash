import { BrowserSection } from './BrowserSection';
import { SettingsSection, SettingsTab } from './SettingsLayout';
import { StashCliRow } from './StashCliRow';
import { WindowSection } from './WindowSection';
import type { Settings } from './store';

interface GeneralTabProps {
  settings: Settings;
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  autostartOn: boolean;
  onToggleAutostart: (next: boolean) => void;
}

export const GeneralTab = ({
  settings,
  onChange,
  autostartOn,
  onToggleAutostart,
}: GeneralTabProps) => (
  <SettingsTab>
    <WindowSection autostartOn={autostartOn} onToggleAutostart={onToggleAutostart} />
    <BrowserSection settings={settings} onChange={onChange} />
    <SettingsSection label="INTEGRATIONS">
      <StashCliRow />
    </SettingsSection>
  </SettingsTab>
);
