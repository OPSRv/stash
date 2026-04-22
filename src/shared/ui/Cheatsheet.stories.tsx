import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Cheatsheet } from './Cheatsheet';
import { Button } from './Button';

const meta = {
  title: 'Overlays/Cheatsheet',
  component: Cheatsheet,
  tags: ['autodocs'],
  parameters: { surface: 'plain', layout: 'fullscreen' },
} satisfies Meta<typeof Cheatsheet>;

export default meta;
type Story = StoryObj<typeof meta>;

const Stage = ({ tab }: { tab?: string }) => {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        position: 'relative',
        width: 720,
        height: 520,
        background: '#0b0b0e',
        borderRadius: 12,
        overflow: 'hidden',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <Button tone="accent" onClick={() => setOpen(true)}>
        Відкрити cheatsheet
      </Button>
      <Cheatsheet open={open} onClose={() => setOpen(false)} tab={tab} />
    </div>
  );
};

export const AllTabs: Story = {
  render: () => <Stage />,
};

export const ClipboardOnly: Story = {
  render: () => <Stage tab="clipboard" />,
};

export const WebOnly: Story = {
  render: () => <Stage tab="web" />,
};

export const DownloadsOnly: Story = {
  render: () => <Stage tab="downloads" />,
};
