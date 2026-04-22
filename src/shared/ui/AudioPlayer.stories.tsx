import type { Meta, StoryObj } from '@storybook/react-vite';
import { AudioPlayer } from './AudioPlayer';

const meta = {
  title: 'Media/AudioPlayer',
  component: AudioPlayer,
  tags: ['autodocs'],
  parameters: { surface: 'pane' },
  args: {
    src: 'https://cdn.jsdelivr.net/gh/anars/blank-audio@11092580af1beaca5d9c0c41aa4e4a0a09900/1-second-of-silence.mp3',
    display: 'compact',
    durationHint: 12,
  },
  argTypes: {
    display: { control: 'inline-radio', options: ['compact', 'waveform'] },
    loader: { control: 'inline-radio', options: ['url', 'bytes'] },
  },
} satisfies Meta<typeof AudioPlayer>;

export default meta;
type Story = StoryObj<typeof meta>;

const Stage = ({ children }: { children: React.ReactNode }) => (
  <div style={{ width: 420 }}>{children}</div>
);

export const Compact: Story = {
  render: (args) => (
    <Stage>
      <AudioPlayer {...args} display="compact" />
    </Stage>
  ),
};

export const Waveform: Story = {
  render: (args) => (
    <Stage>
      <AudioPlayer {...args} display="waveform" caption="Голосове повідомлення" />
    </Stage>
  ),
};

export const LongClip: Story = {
  render: (args) => (
    <Stage>
      <AudioPlayer {...args} display="waveform" durationHint={274} caption="Запис лекції" />
    </Stage>
  ),
};
