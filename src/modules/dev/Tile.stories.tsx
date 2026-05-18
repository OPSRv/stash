import type { Meta, StoryObj } from '@storybook/react-vite';
import { Tile } from './Tile';

const sampleIcon = (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <path d="M8 13l3 3 5-6" />
  </svg>
);

const meta = {
  title: 'Modules/Dev/Tile',
  component: Tile,
  tags: ['autodocs'],
  parameters: { surface: 'plain', layout: 'padded' },
  args: {
    id: 'svg-to-image',
    title: 'SVG → Image',
    description: 'Paste SVG markup, download as PNG, JPG or WebP.',
    gradient: ['#22d3ee', '#6366f1'],
    icon: sampleIcon,
    onOpen: () => {},
    onDragStart: () => {},
    dragging: false,
    dropIndicator: null,
  },
  argTypes: {
    dragging: { control: 'boolean' },
    dropIndicator: {
      control: 'inline-radio',
      options: [null, 'before', 'after'],
    },
  },
} satisfies Meta<typeof Tile>;

export default meta;
type Story = StoryObj<typeof meta>;

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ width: 220 }}>{children}</div>
);

export const Default: Story = {
  render: (args) => (
    <Frame>
      <Tile {...args} />
    </Frame>
  ),
};

export const Dragging: Story = {
  args: { dragging: true },
  render: (args) => (
    <Frame>
      <Tile {...args} />
    </Frame>
  ),
};

export const DropBefore: Story = {
  args: { dropIndicator: 'before' },
  render: (args) => (
    <Frame>
      <Tile {...args} />
    </Frame>
  ),
};

export const DropAfter: Story = {
  args: { dropIndicator: 'after' },
  render: (args) => (
    <Frame>
      <Tile {...args} />
    </Frame>
  ),
};

export const Palette: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
        gap: 12,
        width: 720,
      }}
    >
      <Tile
        id="t1"
        title="SVG → Image"
        description="Paste SVG markup, download as PNG, JPG or WebP."
        gradient={['#22d3ee', '#6366f1']}
        icon={sampleIcon}
        onOpen={() => {}}
        onDragStart={() => {}}
      />
      <Tile
        id="t2"
        title="Base64"
        description="Encode and decode arbitrary text or files."
        gradient={['#fb923c', '#ef4444']}
        icon={sampleIcon}
        onOpen={() => {}}
        onDragStart={() => {}}
      />
      <Tile
        id="t3"
        title="JWT Inspector"
        description="Decode header, payload, and verify signatures."
        gradient={['#10b981', '#0ea5e9']}
        icon={sampleIcon}
        onOpen={() => {}}
        onDragStart={() => {}}
      />
      <Tile
        id="t4"
        title="Regex Tester"
        description="Live preview matches against a multi-line sample."
        gradient={['#a78bfa', '#ec4899']}
        icon={sampleIcon}
        onOpen={() => {}}
        onDragStart={() => {}}
      />
    </div>
  ),
};
