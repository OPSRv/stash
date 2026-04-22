import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { GlobalSearch } from './GlobalSearch';
import { Button } from './Button';

const meta = {
  title: 'Overlays/GlobalSearch',
  component: GlobalSearch,
  tags: ['autodocs'],
  parameters: { surface: 'plain', layout: 'fullscreen' },
} satisfies Meta<typeof GlobalSearch>;

export default meta;
type Story = StoryObj<typeof meta>;

const Stage = () => {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        position: 'relative',
        width: 760,
        height: 520,
        background: '#0b0b0e',
        borderRadius: 12,
        overflow: 'hidden',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <Button tone="accent" onClick={() => setOpen(true)}>
        Відкрити глобальний пошук
      </Button>
      <GlobalSearch
        open={open}
        onClose={() => setOpen(false)}
        onNavigate={() => setOpen(false)}
      />
    </div>
  );
};

export const Playground: Story = {
  render: () => <Stage />,
};
