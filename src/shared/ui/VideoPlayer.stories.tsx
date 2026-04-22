import type { Meta, StoryObj } from '@storybook/react-vite';
import { VideoPlayer } from './VideoPlayer';

const meta = {
  title: 'Media/VideoPlayer',
  component: VideoPlayer,
  tags: ['autodocs'],
  parameters: { surface: 'plain', layout: 'fullscreen' },
  args: {
    src: 'https://cdn.jsdelivr.net/gh/mediaelement/mediaelement-files@master/big_buck_bunny.mp4',
  },
} satisfies Meta<typeof VideoPlayer>;

export default meta;
type Story = StoryObj<typeof meta>;

const Stage = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      position: 'relative',
      width: 640,
      height: 420,
      background: '#000',
      borderRadius: 12,
      overflow: 'hidden',
    }}
  >
    {children}
  </div>
);

export const Playground: Story = {
  render: (args) => (
    <Stage>
      <VideoPlayer {...args} onClose={() => {}} />
    </Stage>
  ),
};
