import type { Meta, StoryObj } from '@storybook/react-vite';
import type { DevTool } from './types';
import { TileGrid } from './TileGrid';

const fakeIcon = (
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
    <circle cx="12" cy="12" r="8" />
    <path d="M8 12l3 3 5-6" />
  </svg>
);

const FIXTURE: DevTool[] = [
  {
    id: 'svg-to-image',
    title: 'SVG → Image',
    description: 'Paste SVG markup, download as PNG, JPG or WebP.',
    gradient: ['#22d3ee', '#6366f1'],
    icon: fakeIcon,
    View: () => <div style={{ padding: 24 }}>Tool body</div>,
  },
  {
    id: 'base64',
    title: 'Base64',
    description: 'Encode / decode arbitrary text and files.',
    gradient: ['#fb923c', '#ef4444'],
    icon: fakeIcon,
    View: () => <div style={{ padding: 24 }}>Tool body</div>,
  },
  {
    id: 'jwt',
    title: 'JWT Inspector',
    description: 'Decode header, payload, verify signatures.',
    gradient: ['#10b981', '#0ea5e9'],
    icon: fakeIcon,
    View: () => <div style={{ padding: 24 }}>Tool body</div>,
  },
  {
    id: 'regex',
    title: 'Regex Tester',
    description: 'Live preview matches against a multi-line sample.',
    gradient: ['#a78bfa', '#ec4899'],
    icon: fakeIcon,
    View: () => <div style={{ padding: 24 }}>Tool body</div>,
  },
  {
    id: 'colors',
    title: 'Color Picker',
    description: 'Convert between HEX, RGB, HSL, and OKLCH.',
    gradient: ['#facc15', '#f97316'],
    icon: fakeIcon,
    View: () => <div style={{ padding: 24 }}>Tool body</div>,
  },
];

const meta = {
  title: 'Modules/Dev/TileGrid',
  component: TileGrid,
  tags: ['autodocs'],
  parameters: { surface: 'plain', layout: 'padded' },
  args: {
    tools: FIXTURE,
    onOpenTool: () => {},
    ephemeral: true,
  },
} satisfies Meta<typeof TileGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ width: 820 }}>{children}</div>
);

export const Populated: Story = {
  render: (args) => (
    <Frame>
      <TileGrid {...args} />
    </Frame>
  ),
};

export const SingleTile: Story = {
  args: { tools: FIXTURE.slice(0, 1) },
  render: (args) => (
    <Frame>
      <TileGrid {...args} />
    </Frame>
  ),
};

export const CustomInitialOrder: Story = {
  args: {
    initialOrder: ['regex', 'svg-to-image', 'colors', 'base64', 'jwt'],
  },
  render: (args) => (
    <Frame>
      <TileGrid {...args} />
    </Frame>
  ),
};
