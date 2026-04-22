import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Drawer } from './Drawer';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { CloseIcon } from './icons';

const meta = {
  title: 'Overlays/Drawer',
  component: Drawer,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen', surface: 'plain' },
} satisfies Meta<typeof Drawer>;

export default meta;
type Story = StoryObj<typeof meta>;

const Host = ({ side }: { side: 'left' | 'right' }) => {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{ position: 'relative', minHeight: 400, padding: 24 }}
      className="canvas-grid"
    >
      <Button onClick={() => setOpen(true)}>Open {side} drawer</Button>
      <Drawer
        open={open}
        side={side}
        ariaLabel={`${side} drawer`}
        onClose={() => setOpen(false)}
      >
        <div className="flex flex-col h-full">
          <div className="px-3 py-3 flex items-center gap-2 border-b hair">
            <span className="text-title font-medium flex-1">History</span>
            <IconButton onClick={() => setOpen(false)} title="Close (Esc)">
              <CloseIcon size={12} />
            </IconButton>
          </div>
          <div className="flex-1 overflow-auto p-3 t-secondary text-body">
            <p>Any content fits here — a list, a filter form, a secondary view.</p>
            <p className="mt-3 t-tertiary text-meta">
              Escape closes, focus is trapped, clicking the scrim dismisses.
            </p>
          </div>
        </div>
      </Drawer>
    </div>
  );
};

export const Right: Story = { render: () => <Host side="right" /> };
export const Left: Story = { render: () => <Host side="left" /> };
