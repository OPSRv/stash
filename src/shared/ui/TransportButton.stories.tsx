import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { TransportButton } from './TransportButton';
import { PauseIcon, PlayIcon } from './icons';

const meta: Meta<typeof TransportButton> = {
  title: 'shared/TransportButton',
  component: TransportButton,
  tags: ['autodocs'],
  argTypes: {
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] },
    tone: { control: 'inline-radio', options: ['accent', 'neutral', 'danger'] },
    active: { control: 'boolean' },
    disabled: { control: 'boolean' },
    title: { control: 'text' },
    onClick: { action: 'click' },
  },
  args: {
    size: 'md',
    tone: 'accent',
    active: false,
    disabled: false,
    title: 'Play',
    children: <PlayIcon size={14} />,
  },
};
export default meta;

type Story = StoryObj<typeof TransportButton>;

export const Idle: Story = {};

export const PlayingPulse: Story = {
  args: {
    active: true,
    title: 'Pause',
    children: <PauseIcon size={14} />,
  },
};

export const Large: Story = {
  args: {
    size: 'lg',
    children: <PlayIcon size={18} />,
  },
};

export const Disabled: Story = {
  args: { disabled: true },
};

export const Danger: Story = {
  args: {
    tone: 'danger',
    title: 'Stop',
    children: <span style={{ fontSize: 9, fontWeight: 700 }}>■</span>,
  },
};

export const ToggleDemo = () => {
  const [playing, setPlaying] = useState(false);
  return (
    <TransportButton
      size="lg"
      active={playing}
      title={playing ? 'Pause' : 'Play'}
      onClick={() => setPlaying((p) => !p)}
    >
      {playing ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
    </TransportButton>
  );
};
