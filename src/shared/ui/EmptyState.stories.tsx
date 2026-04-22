import type { Meta, StoryObj } from '@storybook/react-vite';
import { EmptyState } from './EmptyState';
import { Button } from './Button';
import { NoteIcon, SearchIcon } from './icons';

const meta = {
  title: 'Feedback/EmptyState',
  component: EmptyState,
  tags: ['autodocs'],
  parameters: { surface: 'plain' },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="pane rounded-xl" style={{ width: 420 }}>
      <EmptyState
        icon={<NoteIcon size={24} />}
        title="No notes yet"
        description="Start capturing your thoughts — drafts autosave as you type."
        action={<Button tone="accent">Create a note</Button>}
      />
    </div>
  ),
};

export const Compact: Story = {
  render: () => (
    <div className="pane rounded-xl" style={{ width: 360 }}>
      <EmptyState
        variant="compact"
        icon={<SearchIcon size={20} />}
        title="Nothing matches"
        description="Try a different keyword."
      />
    </div>
  ),
};
