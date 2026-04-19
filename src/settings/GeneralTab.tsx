import { Toggle } from '../shared/ui/Toggle';
import { SettingRow } from './SettingRow';

interface GeneralTabProps {
  autostartOn: boolean;
  onToggleAutostart: (next: boolean) => void;
}

export const GeneralTab = ({ autostartOn, onToggleAutostart }: GeneralTabProps) => (
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
);
