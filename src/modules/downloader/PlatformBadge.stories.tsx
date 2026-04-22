import type { Meta, StoryObj } from '@storybook/react-vite';
import { PlatformBadge } from './PlatformBadge';
import type { Platform } from './api';

const PLATFORMS: Platform[] = [
  'youtube',
  'instagram',
  'tiktok',
  'twitter',
  'reddit',
  'vimeo',
  'twitch',
  'facebook',
  'generic',
];

const meta = {
  title: 'Domain/PlatformBadge',
  component: PlatformBadge,
  tags: ['autodocs'],
  argTypes: {
    platform: { control: 'inline-radio', options: PLATFORMS },
  },
  args: { platform: 'youtube' },
} satisfies Meta<typeof PlatformBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const AllPlatforms: Story = {
  render: () => (
    <div className="sb-row">
      {PLATFORMS.map((p) => (
        <PlatformBadge key={p} platform={p} />
      ))}
    </div>
  ),
};

export const UnknownFallback: Story = {
  args: { platform: 'bandcamp' },
};
