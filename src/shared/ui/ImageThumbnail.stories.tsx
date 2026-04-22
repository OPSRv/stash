import type { Meta, StoryObj } from '@storybook/react-vite';
import { ImageThumbnail } from './ImageThumbnail';

const SAMPLE = 'https://picsum.photos/seed/stash/640/400';

const meta = {
  title: 'Media/ImageThumbnail',
  component: ImageThumbnail,
  tags: ['autodocs'],
  parameters: { surface: 'pane' },
  args: { src: SAMPLE, alt: 'demo image' },
} satisfies Meta<typeof ImageThumbnail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithCaption: Story = {
  args: {
    src: 'https://picsum.photos/seed/stash-2/640/400',
    caption: 'Скріншот з Telegram-каналу',
  },
};

export const BrokenSource: Story = {
  args: { src: 'about:invalid', alt: 'broken' },
};
