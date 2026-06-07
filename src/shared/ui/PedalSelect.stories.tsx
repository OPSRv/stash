import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { PedalSelect } from './PedalSelect';

const TUNINGS = [
  { value: 0, label: 'Standard E' },
  { value: 1, label: 'Drop D' },
  { value: 2, label: 'Half-step down' },
  { value: 3, label: 'Open G' },
  { value: 4, label: 'DADGAD' },
];

const meta = {
  title: 'Inputs/PedalSelect',
  component: PedalSelect,
  tags: ['autodocs'],
  parameters: {
    backgrounds: { default: 'dark' },
  },
  args: {
    value: 0,
    onChange: () => {},
    options: TUNINGS,
  },
  argTypes: {
    disabled: { control: 'boolean' },
    placeholder: { control: 'text' },
  },
} satisfies Meta<typeof PedalSelect>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const Demo = () => {
      const [v, setV] = useState(0);
      return (
        <div style={{ width: 240 }}>
          <PedalSelect value={v} onChange={setV} options={TUNINGS} />
        </div>
      );
    };
    return <Demo />;
  },
};

export const Disabled: Story = {
  args: { disabled: true },
  render: (args) => (
    <div style={{ width: 240 }}>
      <PedalSelect {...args} />
    </div>
  ),
};

export const Empty: Story = {
  args: { value: -1, options: [], placeholder: 'No devices' },
  render: (args) => (
    <div style={{ width: 240 }}>
      <PedalSelect {...args} />
    </div>
  ),
};

// Anchored near the bottom of the viewport — the popup flips above the trigger
// instead of overflowing, and (being portaled + fixed) is never clipped by an
// `overflow: hidden` ancestor.
export const FlipsUp: Story = {
  render: () => {
    const Demo = () => {
      const [v, setV] = useState(0);
      return (
        <div style={{ height: '90vh', display: 'flex', alignItems: 'flex-end' }}>
          <div style={{ width: 240 }}>
            <PedalSelect value={v} onChange={setV} options={TUNINGS} />
          </div>
        </div>
      );
    };
    return <Demo />;
  },
};
