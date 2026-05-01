import type { Meta, StoryObj } from '@storybook/react-vite';
import { Separator } from './Separator';

const meta = {
  title: 'Primitives/Separator',
  component: Separator,
  tags: ['autodocs'],
  argTypes: {
    orientation: { control: 'inline-radio', options: ['horizontal', 'vertical'] },
    tone: { control: 'inline-radio', options: ['default', 'strong'] },
    size: { control: { type: 'number', min: 4, max: 64 } },
  },
} satisfies Meta<typeof Separator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Horizontal: Story = {
  render: () => (
    <div className="pane rounded-xl p-4" style={{ width: 320 }}>
      <div className="t-primary text-body mb-2">Above</div>
      <Separator />
      <div className="t-primary text-body mt-2">Below</div>
    </div>
  ),
};

export const Vertical: Story = {
  render: () => (
    <div className="pane rounded-xl p-4 inline-flex items-center gap-2">
      <span className="t-primary text-body">Cluster A</span>
      <Separator orientation="vertical" />
      <span className="t-primary text-body">Cluster B</span>
      <Separator orientation="vertical" tone="strong" />
      <span className="t-primary text-body">Cluster C (strong)</span>
    </div>
  ),
};

export const InsideHeaderToolbar: Story = {
  render: () => (
    <div
      className="inline-flex items-center"
      style={{
        gap: 1,
        padding: '4px 6px',
        background: 'var(--bg-elev-flat)',
        border: '0.5px solid var(--hairline)',
        borderRadius: 7,
      }}
    >
      <span className="icon-btn icon-btn-default">A</span>
      <span className="icon-btn icon-btn-default">B</span>
      <Separator orientation="vertical" tone="strong" className="mx-[3px]" />
      <span className="icon-btn icon-btn-default">C</span>
      <span className="icon-btn icon-btn-default">D</span>
    </div>
  ),
};
