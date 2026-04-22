import type { Meta, StoryObj } from '@storybook/react-vite';
import { Spinner } from './Spinner';
import { CenterSpinner } from './CenterSpinner';

const meta = {
  title: 'Feedback/Spinner',
  component: Spinner,
  tags: ['autodocs'],
} satisfies Meta<typeof Spinner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Sizes: Story = {
  render: () => (
    <div className="sb-row">
      <Spinner size={10} />
      <Spinner size={12} />
      <Spinner size={16} />
      <Spinner size={24} />
    </div>
  ),
};

export const InlineCenter: StoryObj = {
  render: () => (
    <div style={{ width: 320, height: 120 }} className="pane rounded-xl">
      <CenterSpinner fit="fill" />
    </div>
  ),
};
