import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { ProgressBar } from './ProgressBar';

const meta = {
  title: 'Feedback/ProgressBar',
  component: ProgressBar,
  tags: ['autodocs'],
  argTypes: {
    value: { control: { type: 'range', min: 0, max: 1, step: 0.01 } },
    paused: { control: 'boolean' },
    size: { control: 'inline-radio', options: ['xs', 'sm'] },
  },
  args: { value: 0.4, paused: false, size: 'xs' },
} satisfies Meta<typeof ProgressBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Static: Story = {
  render: (a) => <div style={{ width: 260 }}><ProgressBar {...a} ariaLabel="Progress" /></div>,
};

export const Live: Story = {
  render: () => {
    const Demo = () => {
      const [v, setV] = useState(0);
      useEffect(() => {
        const id = window.setInterval(() => setV((p) => (p >= 1 ? 0 : p + 0.02)), 80);
        return () => window.clearInterval(id);
      }, []);
      return (
        <div style={{ width: 260 }} className="sb-col">
          <ProgressBar value={v} size="sm" ariaLabel="Loading" />
          <div className="t-tertiary text-meta">{Math.round(v * 100)}%</div>
        </div>
      );
    };
    return <Demo />;
  },
};

export const Paused: Story = { args: { value: 0.6, paused: true } };
