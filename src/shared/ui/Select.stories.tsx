import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Select } from './Select';

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
