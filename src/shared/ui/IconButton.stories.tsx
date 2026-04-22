import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { IconButton } from './IconButton';
import { CopyIcon, PinIcon, TrashIcon } from './icons';

const meta = {
  title: 'Primitives/IconButton',
  component: IconButton,
  tags: ['autodocs'],
  args: {
    onClick: fn(),
    title: 'Copy',
    children: <CopyIcon size={12} />,
  },
} satisfies Meta<typeof IconButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Gallery: Story = {
  render: (args) => (
    <div className="sb-row">
      <IconButton {...args} title="Copy"><CopyIcon size={12} /></IconButton>
      <IconButton {...args} title="Pin"><PinIcon size={12} /></IconButton>
      <IconButton {...args} title="Delete" tone="danger"><TrashIcon size={12} /></IconButton>
      <IconButton {...args} title="Disabled" disabled><CopyIcon size={12} /></IconButton>
    </div>
  ),
};
