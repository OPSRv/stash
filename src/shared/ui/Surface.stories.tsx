import type { Meta, StoryObj } from '@storybook/react-vite';
import { Surface } from './Surface';

const meta = {
  title: 'Surfaces/Surface',
  component: Surface,
  tags: ['autodocs'],
  argTypes: {
    elevation: { control: 'inline-radio', options: ['flat', 'raised'] },
    rounded: { control: 'inline-radio', options: ['md', 'lg', 'xl', '2xl', 'full'] },
  },
  args: { elevation: 'flat', rounded: 'xl' },
  parameters: { surface: 'plain' },
} satisfies Meta<typeof Surface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (a) => (
    <Surface {...a} style={{ padding: 24, width: 320 }}>
      <div className="t-primary text-title font-semibold mb-1">Translucent pane</div>
      <div className="t-secondary text-body">
        Uses <code>.pane</code> with backdrop-filter blur.
      </div>
    </Surface>
  ),
};

export const Raised: Story = {
  args: { elevation: 'raised' },
  render: (a) => (
    <Surface {...a} style={{ padding: 24, width: 320 }}>
      <div className="t-primary">Elevated pane (pane-elev)</div>
    </Surface>
  ),
};
