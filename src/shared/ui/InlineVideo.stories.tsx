import type { Meta, StoryObj } from '@storybook/react-vite';
import { InlineVideo } from './InlineVideo';

const DEMO_MP4 =
  'https://cdn.jsdelivr.net/gh/mediaelement/mediaelement-files@master/big_buck_bunny.mp4';

const meta = {
  title: 'Media/InlineVideo',
  component: InlineVideo,
  tags: ['autodocs'],
  parameters: { surface: 'pane' },
  args: { src: DEMO_MP4 },
} satisfies Meta<typeof InlineVideo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithCaption: Story = {
  args: { caption: 'Короткий кліп з Telegram', durationSec: 12 },
};

export const DurationOnly: Story = {
  args: { durationSec: 48 },
};
