import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { Button } from './Button';

const meta = {
  title: 'Overlays/ConfirmDialog',
  component: ConfirmDialog,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen', surface: 'plain' },
} satisfies Meta<typeof ConfirmDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Neutral: Story = {
  render: () => {
    const Demo = () => {
      const [open, setOpen] = useState(false);
      return (
        <div style={{ minHeight: 320, display: 'grid', placeItems: 'center' }}>
          <Button onClick={() => setOpen(true)}>Open dialog</Button>
          <ConfirmDialog
            open={open}
            title="Rename workspace?"
            description="All existing references will be updated. This cannot be undone automatically."
            confirmLabel="Rename"
            onConfirm={() => setOpen(false)}
            onCancel={() => setOpen(false)}
          />
        </div>
      );
    };
    return <Demo />;
  },
};

export const Danger: Story = {
  render: () => {
    const Demo = () => {
      const [open, setOpen] = useState(true);
      return (
        <div style={{ minHeight: 320, display: 'grid', placeItems: 'center' }}>
          <Button tone="danger" variant="soft" onClick={() => setOpen(true)}>Delete…</Button>
          <ConfirmDialog
            open={open}
            tone="danger"
            title="Delete 3 notes?"
            description="These notes will be moved to trash and permanently removed after 30 days."
            confirmLabel="Delete"
            suppressibleLabel="Don't ask again for this workspace"
            onConfirm={() => setOpen(false)}
            onCancel={() => setOpen(false)}
          />
        </div>
      );
    };
    return <Demo />;
  },
};
