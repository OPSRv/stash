import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Lightbox } from './Lightbox';
import { Button } from './Button';

const meta = {
  title: 'Overlays/Lightbox',
  component: Lightbox,
  tags: ['autodocs'],
  parameters: { surface: 'plain', layout: 'fullscreen' },
} satisfies Meta<typeof Lightbox>;

export default meta;
type Story = StoryObj<typeof meta>;

const Demo = ({ src }: { src: string }) => {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        position: 'relative',
        width: 640,
        height: 420,
        background: '#0b0b0e',
        borderRadius: 12,
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <Button tone="accent" onClick={() => setOpen(true)}>
        Відкрити Lightbox
      </Button>
      {open && <Lightbox src={src} alt="demo" onClose={() => setOpen(false)} />}
    </div>
  );
};

export const Playground: Story = {
  render: () => <Demo src="https://picsum.photos/seed/stash-lightbox/1200/800" />,
};

export const Portrait: Story = {
  render: () => <Demo src="https://picsum.photos/seed/stash-portrait/600/900" />,
};
