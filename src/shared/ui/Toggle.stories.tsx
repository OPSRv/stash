import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Toggle } from './Toggle';

const meta = {
  title: 'Primitives/Toggle',
  component: Toggle,
  tags: ['autodocs'],
} satisfies Meta<typeof Toggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const Demo = () => {
      const [on, setOn] = useState(true);
      return (
        <label className="sb-row" style={{ cursor: 'pointer' }}>
          <Toggle checked={on} onChange={setOn} label="Enabled" />
          <span className="t-secondary text-body">Enable feature</span>
        </label>
      );
    };
    return <Demo />;
  },
};

export const Both: Story = {
  render: () => (
    <div className="sb-col">
      <Toggle checked={false} onChange={() => {}} label="Off" />
      <Toggle checked={true} onChange={() => {}} label="On" />
    </div>
  ),
};
