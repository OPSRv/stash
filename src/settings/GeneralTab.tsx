import { Input } from '../shared/ui/Input';
import { Toggle } from '../shared/ui/Toggle';
import { SettingRow } from './SettingRow';
import type { Settings } from './store';

interface GeneralTabProps {
  autostartOn: boolean;
  onToggleAutostart: (next: boolean) => void;
  settings: Settings;
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

export const GeneralTab = ({
  autostartOn,
  onToggleAutostart,
  settings,
  onChange,
}: GeneralTabProps) => (
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
    <SettingRow
      title="Claude Code command"
      description="Exact line the Terminal's Claude Code button writes to the shell. Include any flags you normally use."
      control={
        <Input
          aria-label="Claude Code command"
          placeholder="claude"
          value={settings.claudeCodeCommand}
          onChange={(e) => onChange('claudeCodeCommand', e.currentTarget.value)}
          className="w-[360px]"
        />
      }
    />
  </div>
);
