import type { Meta, StoryObj } from '@storybook/react-vite';

import { TranscribeButton } from './TranscribeButton';

const meta = {
  title: 'Content/TranscribeButton',
  component: TranscribeButton,
  tags: ['autodocs'],
  args: {
    status: 'idle',
    hasTranscript: false,
    onClick: () => {},
  },
  argTypes: {
    status: { control: 'inline-radio', options: ['idle', 'running', 'error'] },
    hasTranscript: { control: 'boolean' },
    title: { control: 'text' },
    'data-testid': { control: false },
  },
} satisfies Meta<typeof TranscribeButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {};

export const IdleWithTranscript: Story = {
  name: 'Idle (has transcript)',
  args: { hasTranscript: true },
};

export const Running: Story = {
  args: { status: 'running' },
};

export const Error: Story = {
  args: { status: 'error' },
};

export const CustomTitle: Story = {
  args: { title: 'Transcribe audio' },
};
