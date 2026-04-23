import type { Meta, StoryObj } from '@storybook/react-vite';
import { Tooltip } from './Tooltip';
import { Button } from './Button';

const meta = {
  title: 'Overlays/Tooltip',
  component: Tooltip,
  tags: ['autodocs'],
  argTypes: {
    side: { control: 'inline-radio', options: ['top', 'bottom', 'left', 'right'] },
  },
  args: { label: 'Copies the URL', side: 'top' },
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (a) => (
    <div style={{ paddingBlock: 40, paddingInline: 80 }}>
      <Tooltip {...a}>
        <Button variant="soft">Hover me</Button>
      </Tooltip>
    </div>
  ),
};

export const Right: Story = {
  args: { side: 'right', label: 'Expand notes list' },
  render: (a) => (
    <div style={{ paddingBlock: 40, paddingInline: 80 }}>
      <Tooltip {...a}>
        <Button variant="soft">Edge icon</Button>
      </Tooltip>
    </div>
  ),
};

export const Left: Story = {
  args: { side: 'left', label: 'Close' },
  render: (a) => (
    <div style={{ paddingBlock: 40, paddingInline: 80, display: 'flex', justifyContent: 'flex-end' }}>
      <Tooltip {...a}>
        <Button variant="soft">Edge icon</Button>
      </Tooltip>
    </div>
  ),
};
