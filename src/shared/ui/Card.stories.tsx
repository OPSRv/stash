import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { Card } from './Card';
import { Badge } from './Badge';

const meta = {
  title: 'Surfaces/Card',
  component: Card,
  tags: ['autodocs'],
  argTypes: {
    tone: { control: 'inline-radio', options: ['neutral', 'accent', 'success', 'warning', 'danger'] },
    padding: { control: 'inline-radio', options: ['none', 'sm', 'md', 'lg'] },
    elevation: { control: 'inline-radio', options: ['flat', 'raised'] },
    rounded: { control: 'inline-radio', options: ['md', 'lg', 'xl'] },
  },
  args: { tone: 'neutral', padding: 'md', elevation: 'flat', rounded: 'lg' },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Static: Story = {
  render: (a) => (
    <Card {...a}>
      <div className="t-primary text-title font-semibold mb-1">Project notes</div>
      <div className="t-tertiary text-meta">Updated 3 min ago</div>
    </Card>
  ),
};

export const Interactive: Story = {
  args: { onClick: fn() },
  render: (a) => (
    <Card {...a}>
      <div className="flex items-center gap-3">
        <Badge tone="accent">BETA</Badge>
        <div className="t-primary text-body">Enable AI suggestions</div>
      </div>
    </Card>
  ),
};

export const Tones: Story = {
  render: () => (
    <div className="sb-col" style={{ width: 300 }}>
      <Card tone="accent">Accent card</Card>
      <Card tone="success">Success card</Card>
      <Card tone="warning">Warning card</Card>
      <Card tone="danger">Danger card</Card>
    </div>
  ),
};
