import type { Meta, StoryObj } from '@storybook/react-vite';

import { PaneContextMenu } from './PaneContextMenu';

const meta = {
  title: 'Terminal/PaneContextMenu',
  component: PaneContextMenu,
  tags: ['autodocs'],
  args: {
    x: 80,
    y: 80,
    hasSelection: false,
    canSplit: true,
    canClosePane: true,
    onAction: () => {},
    onClose: () => {},
  },
  argTypes: {
    hasSelection: { control: 'boolean' },
    canSplit: { control: 'boolean' },
    canClosePane: { control: 'boolean' },
  },
  decorators: [
    (Story) => (
      <div style={{ position: 'relative', width: 360, height: 260 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PaneContextMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const WithSelection: Story = {
  args: { hasSelection: true },
};

export const FullySplit: Story = {
  args: { canSplit: false, hasSelection: true, canClosePane: true },
};

export const SingleShell: Story = {
  args: { canClosePane: false, hasSelection: false },
};
