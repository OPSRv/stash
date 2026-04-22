import type { Meta, StoryObj } from '@storybook/react-vite';
import { Kbd } from './Kbd';

const meta = {
  title: 'Typography/Kbd',
  component: Kbd,
  tags: ['autodocs'],
  args: { children: '⌘K' },
} satisfies Meta<typeof Kbd>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Shortcuts: Story = {
  render: () => (
    <div className="sb-row">
      <Kbd>⌘</Kbd>
      <Kbd>⌥</Kbd>
      <Kbd>⇧</Kbd>
      <Kbd>⌃</Kbd>
      <Kbd>⎋</Kbd>
      <Kbd>↵</Kbd>
      <Kbd>⌘⇧V</Kbd>
      <Kbd>⌘⌥1</Kbd>
    </div>
  ),
};
