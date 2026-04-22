import type { Meta, StoryObj } from '@storybook/react-vite';
import * as Icons from './icons';

const meta = {
  title: 'Typography/Icons',
  tags: ['autodocs'],
  parameters: { surface: 'plain', layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

type IconComp = (props: { size?: number }) => JSX.Element;

const entries = (Object.entries(Icons) as [string, IconComp][])
  .filter(([name]) => name.endsWith('Icon'))
  .sort(([a], [b]) => a.localeCompare(b));

export const Gallery: Story = {
  render: () => (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
        gap: 8,
        minWidth: 640,
      }}
    >
      {entries.map(([name, Icon]) => (
        <div
          key={name}
          className="pane pane-elev rounded-md"
          style={{
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <div className="t-primary" style={{ display: 'inline-flex' }}>
            <Icon size={18} />
          </div>
          <div className="t-tertiary" style={{ fontSize: 10, fontFamily: 'var(--font-mono)' }}>
            {name}
          </div>
        </div>
      ))}
    </div>
  ),
};
