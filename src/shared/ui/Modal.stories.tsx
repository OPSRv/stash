import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';

const meta = {
  title: 'Overlays/Modal',
  component: Modal,
  tags: ['autodocs'],
  parameters: { surface: 'plain', layout: 'fullscreen' },
} satisfies Meta<typeof Modal>;

export default meta;
type Story = StoryObj<typeof meta>;

const Stage = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      position: 'relative',
      width: 680,
      height: 460,
      background: '#0b0b0e',
      borderRadius: 12,
      overflow: 'hidden',
      display: 'grid',
      placeItems: 'center',
    }}
  >
    {children}
  </div>
);

const Demo = ({ ...props }: Partial<React.ComponentProps<typeof Modal>>) => {
  const [open, setOpen] = useState(false);
  return (
    <Stage>
      <Button tone="accent" onClick={() => setOpen(true)}>
        Відкрити Modal
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        ariaLabel="Demo dialog"
        maxWidth={420}
        {...props}
      >
        <h3 className="t-primary text-heading font-semibold mb-2">Заголовок</h3>
        <p className="t-secondary text-body mb-4">
          Простий dialog з focus-trap, Esc-закриттям і клік-по-backdrop.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Скасувати
          </Button>
          <Button tone="accent" onClick={() => setOpen(false)}>
            ОК
          </Button>
        </div>
      </Modal>
    </Stage>
  );
};

export const Default: Story = {
  render: () => <Demo />,
};

export const Narrow: Story = {
  render: () => <Demo maxWidth={320} />,
};

export const PersistentBackdrop: Story = {
  render: () => <Demo dismissOnBackdropClick={false} dismissOnEscape={false} />,
};
