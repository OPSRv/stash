import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { Checkbox } from './Checkbox';

const meta = {
  title: 'Inputs/Checkbox',
  component: Checkbox,
  tags: ['autodocs'],
  argTypes: {
    size: { control: 'inline-radio', options: ['sm', 'md'] },
    disabled: { control: 'boolean' },
    indeterminate: { control: 'boolean' },
  },
  args: { checked: false, label: 'Launch on login', size: 'md' },
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (a) => {
    const Demo = () => {
      const [v, setV] = useState(a.checked);
      return <Checkbox {...a} checked={v} onChange={setV} />;
    };
    return <Demo />;
  },
};

export const States: Story = {
  render: () => (
    <div className="sb-col">
      <Checkbox checked={false} onChange={() => {}} label="Unchecked" />
      <Checkbox checked onChange={() => {}} label="Checked" />
      <Checkbox checked={false} indeterminate onChange={() => {}} label="Indeterminate" />
      <Checkbox checked onChange={() => {}} disabled label="Disabled (checked)" />
      <Checkbox checked={false} onChange={() => {}} disabled label="Disabled (unchecked)" />
    </div>
  ),
};

export const WithDescription: Story = {
  render: () => (
    <Checkbox
      checked
      onChange={() => {}}
      label="Launch on login"
      description="Starts minimised in the menubar and registers global shortcuts."
    />
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="sb-col">
      <Checkbox size="sm" checked onChange={() => {}} label="sm" />
      <Checkbox size="md" checked onChange={() => {}} label="md" />
    </div>
  ),
};

export const SelectAll: Story = {
  render: () => {
    const Demo = () => {
      const items = ['Screenshots', 'Notes', 'Clipboard', 'Downloads'];
      const [picked, setPicked] = useState<Record<string, boolean>>({ Notes: true });
      const allOn = useMemo(() => items.every((i) => picked[i]), [items, picked]);
      const someOn = useMemo(() => items.some((i) => picked[i]), [items, picked]);
      return (
        <div className="sb-col" style={{ minWidth: 240 }}>
          <Checkbox
            checked={allOn}
            indeterminate={!allOn && someOn}
            onChange={(on) => {
              const next: Record<string, boolean> = {};
              items.forEach((i) => (next[i] = on));
              setPicked(next);
            }}
            label="Select all"
          />
          <div className="hair" style={{ height: 1, width: '100%' }} />
          {items.map((i) => (
            <Checkbox
              key={i}
              checked={!!picked[i]}
              onChange={(on) => setPicked((p) => ({ ...p, [i]: on }))}
              label={i}
            />
          ))}
        </div>
      );
    };
    return <Demo />;
  },
};
