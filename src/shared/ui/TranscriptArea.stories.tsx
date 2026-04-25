import type { Meta, StoryObj } from '@storybook/react-vite';

import { TranscriptArea } from './TranscriptArea';

const meta = {
  title: 'Content/TranscriptArea',
  component: TranscriptArea,
  tags: ['autodocs'],
  parameters: { surface: 'pane' },
  args: {
    transcript: null,
    transcribing: false,
    failed: false,
  },
  argTypes: {
    transcript: { control: 'text' },
    transcribing: { control: 'boolean' },
    failed: { control: 'boolean' },
    onRetry: { control: false },
    onTranscribe: { control: false },
    onEdit: { control: false },
    labels: { control: 'object' },
  },
} satisfies Meta<typeof TranscriptArea>;

export default meta;
type Story = StoryObj<typeof meta>;

const Stage = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{ width: 420, padding: 16, background: 'rgba(255,255,255,0.04)', borderRadius: 8 }}
  >
    {children}
  </div>
);

export const Idle: Story = {
  render: (args) => (
    <Stage>
      <TranscriptArea {...args} transcript={null} onTranscribe={() => {}} />
    </Stage>
  ),
};

export const Transcribing: Story = {
  render: (args) => (
    <Stage>
      <TranscriptArea {...args} transcript={null} transcribing />
    </Stage>
  ),
};

export const Failed: Story = {
  render: (args) => (
    <Stage>
      <TranscriptArea {...args} transcript={null} failed onRetry={() => {}} />
    </Stage>
  ),
};

export const FailedNoRetry: Story = {
  name: 'Failed (no retry)',
  render: (args) => (
    <Stage>
      <TranscriptArea {...args} transcript={null} failed />
    </Stage>
  ),
};

export const ReadOnly: Story = {
  render: (args) => (
    <Stage>
      <TranscriptArea
        {...args}
        transcript="Привіт, включи метроном на 120 ударів за хвилину."
      />
    </Stage>
  ),
};

export const Editable: Story = {
  render: (args) => (
    <Stage>
      <TranscriptArea
        {...args}
        transcript="Привіт, включи метроном на 120 ударів за хвилину."
        onEdit={() => {}}
      />
    </Stage>
  ),
};
