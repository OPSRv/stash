import type { Meta, StoryObj } from '@storybook/react-vite';

import { DragGhost } from './DragGhost';

const meta = {
  title: 'Terminal/DragGhost',
  component: DragGhost,
  tags: ['autodocs'],
  args: { x: 60, y: 80, label: 'Shell 1', zone: 'center', hasTarget: false },
  argTypes: {
    zone: {
      control: 'inline-radio',
      options: ['left', 'right', 'top', 'bottom', 'center'],
    },
    hasTarget: { control: 'boolean' },
  },
  decorators: [
    (Story) => (
      <div
        style={{
          position: 'relative',
          width: 320,
          height: 180,
          background: 'var(--color-bg-canvas, #0b0b0e)',
          border: '1px solid var(--color-border-hair, rgba(255,255,255,0.08))',
          borderRadius: 6,
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DragGhost>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = { args: { hasTarget: false } };

export const OverDropTarget: Story = {
  args: { hasTarget: true, zone: 'center', label: 'Shell 1' },
};

export const OverEdgeZone: Story = {
  args: { hasTarget: true, zone: 'right', label: 'Pane pane-2' },
};

export const LongLabel: Story = {
  args: { label: 'claude-code-long-session-label', hasTarget: true, zone: 'bottom' },
};
