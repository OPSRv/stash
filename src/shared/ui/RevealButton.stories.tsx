import type { Meta, StoryObj } from '@storybook/react-vite';
import { RevealButton } from './RevealButton';

const meta = {
  title: 'Primitives/RevealButton',
  component: RevealButton,
  tags: ['autodocs'],
  args: {
    path: '/Users/demo/Downloads/stash-demo.mp4',
    label: 'Показати',
    size: 'sm',
    variant: 'ghost',
  },
  argTypes: {
    size: { control: 'inline-radio', options: ['xs', 'sm', 'md', 'lg'] },
    variant: { control: 'inline-radio', options: ['solid', 'soft', 'ghost', 'outline'] },
    disabled: { control: 'boolean' },
  },
} satisfies Meta<typeof RevealButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Disabled: Story = {
  args: { disabled: true },
};

export const CustomLabel: Story = {
  args: { label: 'Reveal in Finder', variant: 'soft' },
};
