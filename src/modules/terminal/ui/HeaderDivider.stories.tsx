import type { Meta, StoryObj } from '@storybook/react-vite';

import { HeaderDivider } from './HeaderDivider';

const meta = {
  title: 'Terminal/HeaderDivider',
  component: HeaderDivider,
  tags: ['autodocs'],
} satisfies Meta<typeof HeaderDivider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 10px',
        background: 'var(--color-bg-elev, #2a2a30)',
        borderRadius: 6,
        color: 'var(--color-text-tertiary, rgba(255,255,255,0.55))',
        fontSize: 12,
      }}
    >
      <span>Terminal</span>
      <HeaderDivider />
      <span>$SHELL</span>
      <HeaderDivider />
      <span>Compose</span>
    </div>
  ),
};
