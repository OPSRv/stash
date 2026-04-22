import type { Meta, StoryObj } from '@storybook/react-vite';
import { Tooltip } from './Tooltip';
import { Button } from './Button';

const meta = {
  title: 'Overlays/Tooltip',
  component: Tooltip,
  tags: ['autodocs'],
  argTypes: {
    side: { control: 'inline-radio', options: ['top', 'bottom'] },
  },
  args: { label: 'Copies the URL', side: 'top' },
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (a) => (
    <div style={{ paddingBlock: 40 }}>
      <Tooltip {...a}>
        <Button variant="soft">Hover me</Button>
      </Tooltip>
    </div>
  ),
};
