import type { Meta, StoryObj } from '@storybook/react-vite';
import { GlobeLoader } from './GlobeLoader';

const meta = {
  title: 'Feedback/GlobeLoader',
  component: GlobeLoader,
  tags: ['autodocs'],
  argTypes: {
    scale: { control: { type: 'range', min: 0.25, max: 1, step: 0.05 } },
    fill: { control: 'boolean' },
    caption: { control: 'text' },
    detail: { control: 'text' },
  },
  args: {
    scale: 0.6,
    fill: false,
    caption: 'Connecting to your devices…',
    detail: 'v 1.0 · 3 of 4 services ready',
  },
} satisfies Meta<typeof GlobeLoader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Bare: Story = {
  args: { caption: undefined, detail: undefined },
};

export const FullSize: Story = {
  args: { scale: 1, caption: 'Loading workspace…', detail: undefined },
};

export const Tiny: Story = {
  args: { scale: 0.35, caption: 'Loading…', detail: undefined },
};

export const FillsParent: Story = {
  args: { fill: true, scale: 0.5, caption: 'Opening Notes…' },
  decorators: [
    (Story) => (
      <div
        style={{ width: 520, height: 360 }}
        className="pane rounded-2xl overflow-hidden"
      >
        <Story />
      </div>
    ),
  ],
};
