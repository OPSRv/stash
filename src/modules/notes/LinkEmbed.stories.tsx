import type { Meta, StoryObj } from '@storybook/react-vite';
import { LinkEmbed } from './LinkEmbed';
import {
  __resetLinkPreviewCache,
  __seedLinkPreviewCache,
} from '../clipboard/useLinkPreview';
import type { LinkPreview } from '../clipboard/api';

/// Seed the in-memory preview cache so a story renders fully populated
/// without firing off real IPC. `useLinkPreview` reads synchronously
/// from this map on mount when a hit is already present.
const seed = (url: string, preview: LinkPreview | null) => {
  __resetLinkPreviewCache();
  __seedLinkPreviewCache(url, preview);
};

const meta = {
  title: 'Notes/LinkEmbed',
  component: LinkEmbed,
  tags: ['autodocs'],
  parameters: { surface: 'pane' },
} satisfies Meta<typeof LinkEmbed>;

export default meta;
type Story = StoryObj<typeof meta>;

const Stage = ({ children }: { children: React.ReactNode }) => (
  <div style={{ width: 460, padding: 8 }}>{children}</div>
);

export const TelegramStyle: Story = {
  render: () => {
    seed('https://tauri.app/v2/guide', {
      url: 'https://tauri.app/v2/guide',
      image: 'https://tauri.app/og.png',
      title: 'Tauri 2.0 — Build secure, fast desktop apps',
      description:
        'Tauri is a framework for building tiny, fast binaries for all major desktop and mobile platforms.',
      site_name: 'Tauri',
    });
    return (
      <Stage>
        <LinkEmbed href="https://tauri.app/v2/guide" />
      </Stage>
    );
  },
};

export const NoOgImage: Story = {
  render: () => {
    seed('https://example.com/article', {
      url: 'https://example.com/article',
      image: null,
      title: 'How we shipped a hundred features in a week',
      description: 'A breakdown of the team workflow with code samples.',
      site_name: 'Example Blog',
    });
    return (
      <Stage>
        <LinkEmbed href="https://example.com/article" />
      </Stage>
    );
  },
};

export const NoMetadataAtAll: Story = {
  render: () => {
    seed('https://opaque.example.org/x', null);
    return (
      <Stage>
        <LinkEmbed href="https://opaque.example.org/x" />
      </Stage>
    );
  },
};

export const YouTubePlayer: Story = {
  render: () => (
    <Stage>
      <LinkEmbed href="https://youtu.be/dQw4w9WgXcQ" />
    </Stage>
  ),
};
