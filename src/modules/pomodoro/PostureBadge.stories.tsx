import type { Meta, StoryObj } from '@storybook/react-vite';
import { PostureBadge } from './PostureBadge';

const meta = {
  title: 'Domain/PostureBadge',
  component: PostureBadge,
  tags: ['autodocs'],
  argTypes: {
    posture: { control: 'inline-radio', options: ['sit', 'stand', 'walk'] },
    size: { control: 'inline-radio', options: ['sm', 'md'] },
  },
  args: { posture: 'sit', size: 'sm' },
} satisfies Meta<typeof PostureBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const AllPostures: Story = {
  render: () => (
    <div className="sb-row">
      <PostureBadge posture="sit" />
      <PostureBadge posture="stand" />
      <PostureBadge posture="walk" />
    </div>
  ),
};

export const Medium: Story = {
  args: { size: 'md' },
  render: (args) => (
    <div className="sb-row">
      <PostureBadge {...args} posture="sit" />
      <PostureBadge {...args} posture="stand" />
      <PostureBadge {...args} posture="walk" />
    </div>
  ),
};
