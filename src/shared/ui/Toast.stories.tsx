import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { ToastCard } from './ToastCard';
import type { ToastItem } from './Toast.types';

const base = (over: Partial<ToastItem> = {}): ToastItem => ({
  id: 1,
  title: 'Saved to clipboard',
  description: '3 items copied',
  variant: 'default',
  ...over,
});

const meta = {
  title: 'Feedback/Toast',
  component: ToastCard,
  tags: ['autodocs'],
  args: { onDismiss: fn() },
  parameters: { surface: 'plain' },
} satisfies Meta<typeof ToastCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { toast: base() } };

export const Success: Story = {
  args: { toast: base({ variant: 'success', title: 'Backup complete', description: '42 notes archived' }) },
};

export const ErrorWithAction: Story = {
  args: {
    toast: base({
      id: 2,
      variant: 'error',
      title: 'Sync failed',
      description: 'Network is offline. Retry when you reconnect.',
      action: { label: 'Retry', onClick: () => {} },
    }),
  },
};
