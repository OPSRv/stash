import type { Meta, StoryObj } from '@storybook/react-vite';
import { CenterSpinner } from './CenterSpinner';

const meta = {
  title: 'Feedback/CenterSpinner',
  component: CenterSpinner,
  tags: ['autodocs'],
  argTypes: {
    fit: { control: 'inline-radio', options: ['fill', 'inline'] },
  },
  args: { fit: 'fill' },
} satisfies Meta<typeof CenterSpinner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Fill: Story = {
  args: { fit: 'fill' },
  render: (args) => (
    <div className="pane rounded-xl" style={{ width: 320, height: 180 }}>
      <CenterSpinner {...args} />
    </div>
  ),
};

export const Inline: Story = {
  args: { fit: 'inline' },
  render: (args) => (
    <div className="pane rounded-xl" style={{ width: 320 }}>
      <CenterSpinner {...args} />
    </div>
  ),
};
