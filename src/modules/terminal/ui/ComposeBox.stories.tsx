import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import type { UseVoiceRecorder, VoicePhase } from '../../../shared/hooks/useVoiceRecorder';
import { ComposeBox } from './ComposeBox';

const voiceStub = (phase: VoicePhase, error = ''): UseVoiceRecorder => ({
  phase,
  error,
  busy: phase === 'transcribing',
  toggle: () => {},
  start: async () => {},
  stop: () => {},
});

const meta = {
  title: 'Terminal/ComposeBox',
  component: ComposeBox,
  tags: ['autodocs'],
  args: {
    value: '',
    onChange: () => {},
    onSend: () => {},
    onFileAttach: () => {},
    onEscape: () => {},
    voice: voiceStub('idle'),
    compact: false,
  },
  argTypes: {
    compact: { control: 'boolean' },
  },
  decorators: [
    (Story, ctx) => {
      const width = (ctx.parameters as { paneWidth?: number }).paneWidth ?? 720;
      return (
        <div
          style={{
            width,
            background: 'var(--color-bg-canvas, #0b0b0e)',
            border: '1px solid var(--color-border-hair, rgba(255,255,255,0.08))',
            borderRadius: 6,
          }}
        >
          <Story />
        </div>
      );
    },
  ],
} satisfies Meta<typeof ComposeBox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = { parameters: { paneWidth: 720 } };

export const WithText: Story = {
  args: { value: 'review the attached screenshot and propose a fix' },
  parameters: { paneWidth: 720 },
};

export const CompactMode: Story = {
  args: { compact: true, value: 'compact prompt' },
  parameters: { paneWidth: 300 },
};

export const Recording: Story = {
  args: { voice: voiceStub('recording') },
  parameters: { paneWidth: 720 },
};

export const Transcribing: Story = {
  args: { voice: voiceStub('transcribing') },
  parameters: { paneWidth: 720 },
};

export const MicError: Story = {
  args: { voice: voiceStub('error', 'microphone: permission denied') },
  parameters: { paneWidth: 720 },
};

/// Smoke playground — controlled value so typing works in the iframe.
export const Interactive: Story = {
  render: (args) => {
    const [val, setVal] = useState('');
    return (
      <ComposeBox
        {...args}
        value={val}
        onChange={setVal}
        onSend={() => setVal('')}
      />
    );
  },
  parameters: { paneWidth: 720 },
};
