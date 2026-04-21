import { Toggle } from '../shared/ui/Toggle';
import { BackupSection } from './BackupSection';
import { SettingRow } from './SettingRow';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import { StashCliRow } from './StashCliRow';

interface GeneralTabProps {
  autostartOn: boolean;
  onToggleAutostart: (next: boolean) => void;
}

export const GeneralTab = ({ autostartOn, onToggleAutostart }: GeneralTabProps) => (
  <div className="max-w-[560px] mx-auto space-y-6">
    <section>
      <SettingsSectionHeader label="STARTUP" />
      <div className="divide-y divide-white/5">
        <SettingRow
          title="Launch at login"
          description="Starts Stash quietly in the menubar when you log in."
          control={
            <Toggle
              checked={autostartOn}
              onChange={onToggleAutostart}
              label="Launch at login"
            />
          }
        />
      </div>
    </section>

    <section>
      <SettingsSectionHeader label="INTEGRATIONS" />
      <div className="divide-y divide-white/5">
        <StashCliRow />
      </div>
    </section>

    <BackupSection />
  </div>
);
