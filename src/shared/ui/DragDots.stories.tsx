import type { Meta, StoryObj } from '@storybook/react-vite';

import { DragDots } from './DragDots';

const meta = {
  title: 'Feedback/DragDots',
  component: DragDots,
  tags: ['autodocs'],
  args: { dot: 2, gap: 2, opacity: 0.6 },
  argTypes: {
    dot: { control: { type: 'number', min: 1, max: 6 } },
    gap: { control: { type: 'number', min: 0, max: 6 } },
    opacity: { control: { type: 'number', min: 0, max: 1, step: 0.05 } },
  },
} satisfies Meta<typeof DragDots>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Bigger: Story = {
  args: { dot: 3, gap: 3 },
};

export const InHandle: Story = {
  render: (args) => (
    <button
      type="button"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 24,
        borderRadius: 4,
        border: 'none',
        background: 'rgba(255,255,255,0.06)',
        color: 'rgba(255,255,255,0.55)',
        cursor: 'grab',
      }}
      title="Drag me"
    >
      <DragDots {...args} />
    </button>
  ),
};

export const TonedBlue: Story = {
  render: (args) => (
    <span style={{ color: '#4a8bea' }}>
      <DragDots {...args} opacity={1} />
    </span>
  ),
};
