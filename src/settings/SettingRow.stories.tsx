import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { SettingRow } from './SettingRow';
import { Toggle } from '../shared/ui/Toggle';
import { Checkbox } from '../shared/ui/Checkbox';
import { NumberInput } from '../shared/ui/NumberInput';
import { SegmentedControl } from '../shared/ui/SegmentedControl';
import { Button } from '../shared/ui/Button';

const meta = {
  title: 'Modules/Settings/SettingRow',
  component: SettingRow,
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
} satisfies Meta<typeof SettingRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AsToggle: Story = {
  render: () => {
    const Demo = () => {
      const [on, setOn] = useState(true);
      return (
        <div className="pane rounded-xl px-4" style={{ width: 520 }}>
          <SettingRow
            title="Launch on login"
            description="Starts minimised in the menubar."
            control={<Toggle checked={on} onChange={setOn} label="Launch on login" />}
          />
        </div>
      );
    };
    return <Demo />;
  },
};

export const Stack: Story = {
  render: () => {
    const Demo = () => {
      const [on, setOn] = useState(true);
      const [notes, setNotes] = useState(true);
      const [threshold, setThreshold] = useState<number | null>(20);
      const [view, setView] = useState<'compact' | 'roomy'>('compact');
      return (
        <div
          className="pane rounded-xl px-4 divide-y"
          style={{ width: 560, borderColor: 'transparent' }}
        >
          <SettingRow
            title="Launch on login"
            description="Starts minimised in the menubar."
            control={<Toggle checked={on} onChange={setOn} label="Launch on login" />}
          />
          <SettingRow
            title="Battery-low threshold"
            description="Charge percentage below which to ping."
            control={
              <NumberInput
                value={threshold}
                onChange={setThreshold}
                min={1}
                max={99}
                suffix="%"
                className="w-[104px]"
                ariaLabel="Battery threshold"
              />
            }
          />
          <SettingRow
            title="Notes density"
            description="Applies to the notes list."
            control={
              <SegmentedControl<'compact' | 'roomy'>
                size="sm"
                value={view}
                onChange={setView}
                options={[
                  { value: 'compact', label: 'Compact' },
                  { value: 'roomy', label: 'Roomy' },
                ]}
              />
            }
          />
          <SettingRow
            title="Include in backup"
            description="Clipboard images + note audio."
            control={<Checkbox checked={notes} onChange={setNotes} ariaLabel="Include media" />}
          />
          <SettingRow
            title="Reset all settings"
            description="Restore factory defaults. Cannot be undone."
            control={<Button tone="danger" variant="soft">Reset…</Button>}
          />
        </div>
      );
    };
    return <Demo />;
  },
};
