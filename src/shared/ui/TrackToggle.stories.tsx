import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { TrackToggle, type TrackToggleProps } from './TrackToggle';

const meta: Meta<typeof TrackToggle> = {
  title: 'shared/TrackToggle',
  component: TrackToggle,
  tags: ['autodocs'],
  argTypes: {
    tone: {
      control: 'inline-radio',
      options: ['mute', 'solo', 'neutral'],
    },
    active: { control: 'boolean' },
    disabled: { control: 'boolean' },
    colorRgb: {
      control: 'text',
      description: 'CSS RGB triple, e.g. "236, 72, 153" (only honoured when tone=solo).',
    },
    children: { control: 'text' },
    onClick: { action: 'click' },
    title: { control: 'text' },
  },
  args: {
    children: 'M',
    title: 'Mute',
    tone: 'mute',
    active: false,
    disabled: false,
  },
};
export default meta;

type Story = StoryObj<typeof TrackToggle>;

export const Mute: Story = {};

export const MuteActive: Story = {
  args: { active: true },
};

export const Solo: Story = {
  args: { children: 'S', title: 'Solo', tone: 'solo' },
};

export const SoloActiveVocals: Story = {
  args: {
    children: 'S',
    title: 'Solo',
    tone: 'solo',
    active: true,
    colorRgb: '236, 72, 153',
  },
};

export const SoloActiveDrums: Story = {
  args: {
    children: 'S',
    title: 'Solo',
    tone: 'solo',
    active: true,
    colorRgb: '244, 114, 22',
  },
};

export const Neutral: Story = {
  args: { children: 'R', title: 'Record', tone: 'neutral' },
};

export const Disabled: Story = {
  args: { disabled: true },
};

/// All three tones side-by-side for a quick visual diff.
export const Showcase = (args: TrackToggleProps) => {
  const [mute, setMute] = useState(false);
  const [solo, setSolo] = useState(false);
  const [neutral, setNeutral] = useState(false);
  return (
    <div className="flex items-center gap-3">
      <TrackToggle
        {...args}
        tone="mute"
        active={mute}
        onClick={() => setMute((v) => !v)}
        title="Mute"
      >
        M
      </TrackToggle>
      <TrackToggle
        {...args}
        tone="solo"
        colorRgb="34, 197, 94"
        active={solo}
        onClick={() => setSolo((v) => !v)}
        title="Solo"
      >
        S
      </TrackToggle>
      <TrackToggle
        {...args}
        tone="neutral"
        active={neutral}
        onClick={() => setNeutral((v) => !v)}
        title="Record arm"
      >
        R
      </TrackToggle>
    </div>
  );
};
