import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Select } from './Select';
import { RangeSlider } from './RangeSlider';
import { MicIcon } from './icons';

const meta = {
  title: 'Inputs/Select',
  component: Select,
  tags: ['autodocs'],
  argTypes: {
    size: { control: 'inline-radio', options: ['sm', 'md'] },
    placement: { control: 'inline-radio', options: ['bottom', 'top', 'auto'] },
    disabled: { control: 'boolean' },
  },
} satisfies Meta<typeof Select>;

export default meta;
type Story = StoryObj<typeof meta>;

type Lang = 'uk' | 'en' | 'de' | 'pl';

export const Default: Story = {
  render: () => {
    const Demo = () => {
      const [v, setV] = useState<Lang>('uk');
      return (
        <div style={{ width: 240 }}>
          <Select<Lang>
            label="Target language"
            value={v}
            onChange={setV}
            options={[
              { value: 'uk', label: 'Ukrainian' },
              { value: 'en', label: 'English' },
              { value: 'de', label: 'German' },
              { value: 'pl', label: 'Polish' },
            ]}
          />
        </div>
      );
    };
    return <Demo />;
  },
};

export const Small: Story = {
  render: () => {
    const Demo = () => {
      const [v, setV] = useState<Lang>('uk');
      return (
        <div style={{ width: 160 }}>
          <Select<Lang>
            label="Target language"
            value={v}
            onChange={setV}
            size="sm"
            options={[
              { value: 'uk', label: 'Ukrainian' },
              { value: 'en', label: 'English' },
              { value: 'de', label: 'German' },
              { value: 'pl', label: 'Polish' },
            ]}
          />
        </div>
      );
    };
    return <Demo />;
  },
};

export const Disabled: Story = {
  render: () => (
    <div style={{ width: 240 }}>
      <Select<Lang>
        value="uk"
        onChange={() => {}}
        disabled
        options={[{ value: 'uk', label: 'Ukrainian' }]}
      />
    </div>
  ),
};

// Icon-only trigger — the selection is conveyed via tooltip. Used where
// horizontal space is tight (e.g. the recorder source picker).
export const IconOnly: Story = {
  render: () => {
    const Demo = () => {
      const [v, setV] = useState('builtin');
      return (
        <Select
          label="Input source"
          icon={<MicIcon size={15} />}
          value={v}
          onChange={setV}
          placement="auto"
          options={[
            { value: 'builtin', label: 'Built-in Microphone' },
            { value: 'gp5', label: 'GP-5 Audio' },
            { value: 'usb', label: 'USB Interface' },
          ]}
        />
      );
    };
    return <Demo />;
  },
};

// Footer slot — an auxiliary control pinned below the options list, inside the
// same popup but outside the listbox. Mirrors the recorder's input picker,
// where the input-gain slider sits under the mic list.
export const WithFooter: Story = {
  render: () => {
    const Demo = () => {
      const [v, setV] = useState('builtin');
      const [gain, setGain] = useState(1);
      return (
        <Select
          label="Input source"
          icon={<MicIcon size={15} />}
          value={v}
          onChange={setV}
          placement="auto"
          options={[
            { value: 'builtin', label: 'Built-in Microphone' },
            { value: 'gp5', label: 'GP-5 Audio' },
            { value: 'usb', label: 'USB Interface' },
          ]}
          footer={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="t-tertiary text-meta">Gain</span>
              <RangeSlider label="Input gain" min={0} max={2} step={0.05} value={gain} onChange={setGain} />
              <span className="t-secondary text-meta tabular-nums">{Math.round(gain * 100)}%</span>
            </div>
          }
        />
      );
    };
    return <Demo />;
  },
};
