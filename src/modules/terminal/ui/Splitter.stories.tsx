import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { Splitter } from './Splitter';

const meta = {
  title: 'Terminal/Splitter',
  component: Splitter,
  tags: ['autodocs'],
} satisfies Meta<typeof Splitter>;

export default meta;
type Story = StoryObj<typeof meta>;

/// Two-pane playground. The splitter reads its immediate flex parent's
/// rect on drag; the story pipes the reported percent straight into
/// local state so the layout tracks the pointer.
const Playground = ({ orientation }: { orientation: 'row' | 'column' }) => {
  const [ratio, setRatio] = useState(50);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: orientation,
        width: 360,
        height: 180,
        background: 'var(--color-bg-canvas, #0b0b0e)',
        border: '1px solid var(--color-border-hair, rgba(255,255,255,0.08))',
        borderRadius: 6,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          flex: `${ratio} 1 0`,
          display: 'grid',
          placeItems: 'center',
          color: 'var(--color-text-primary, #e7e7ea)',
          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
          fontSize: 12,
        }}
      >
        Pane A · {Math.round(ratio)}%
      </div>
      <Splitter
        orientation={orientation}
        onDrag={(pct) => setRatio(Math.max(10, Math.min(90, pct)))}
      />
      <div
        style={{
          flex: `${100 - ratio} 1 0`,
          display: 'grid',
          placeItems: 'center',
          color: 'var(--color-text-primary, #e7e7ea)',
          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
          fontSize: 12,
        }}
      >
        Pane B · {Math.round(100 - ratio)}%
      </div>
    </div>
  );
};

export const Horizontal: Story = {
  render: () => <Playground orientation="row" />,
};

export const Vertical: Story = {
  render: () => <Playground orientation="column" />,
};
