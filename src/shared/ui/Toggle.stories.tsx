import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const sw = await canvas.findByRole('switch', { name: 'Enabled' });
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(sw);
    await expect(sw).toHaveAttribute('aria-checked', 'false');
  },
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
