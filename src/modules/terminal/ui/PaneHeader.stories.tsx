import type { Meta, StoryObj } from '@storybook/react-vite';

import { PaneHeader } from './PaneHeader';

const meta = {
  title: 'Terminal/PaneHeader',
  component: PaneHeader,
  tags: ['autodocs'],
  args: {
    paneId: 'pane-1',
    compact: false,
    ultraCompact: false,
    hideSnippets: false,
    dead: false,
    statusLabel: '$SHELL',
    snippets: [
      { id: 's1', label: 'Claude Code', command: 'claude' },
      { id: 's2', label: 'ls', command: 'ls' },
      { id: 's3', label: 'clear', command: 'clear' },
      { id: 's4', label: 'pwd', command: 'pwd' },
    ],
    runSnippet: async () => {},
    selection: '',
    composeOpen: false,
    toggleCompose: () => {},
    onFind: () => {},
    onRestart: () => {},
    onLaunchClaude: () => {},
    claudeCommand: 'claude',
  },
  argTypes: {
    compact: { control: 'boolean' },
    ultraCompact: { control: 'boolean' },
    hideSnippets: { control: 'boolean' },
    dead: { control: 'boolean' },
    composeOpen: { control: 'boolean' },
  },
  decorators: [
    (Story, ctx) => {
      // Width preset via story parameter so narrow/wide variants read
      // at a glance in the Storybook canvas.
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
} satisfies Meta<typeof PaneHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Wide: Story = { parameters: { paneWidth: 720 } };

export const MediumHidesSnippets: Story = {
  args: { hideSnippets: true },
  parameters: { paneWidth: 440 },
};

export const CompactIconOnly: Story = {
  args: { compact: true, hideSnippets: true },
  parameters: { paneWidth: 300 },
};

export const UltraCompact: Story = {
  args: { compact: true, ultraCompact: true, hideSnippets: true },
  parameters: { paneWidth: 200 },
};

export const Split: Story = {
  args: {
    onSplit: () => {},
    onClosePane: () => {},
  },
  parameters: { paneWidth: 720 },
};

export const DeadShell: Story = {
  args: { dead: true, statusLabel: 'shell exited' },
  parameters: { paneWidth: 720 },
};

export const WithSelection: Story = {
  args: { selection: 'npm run build\n' },
  parameters: { paneWidth: 720 },
};

export const ClaudeCommandWithFlags: Story = {
  args: { claudeCommand: 'claude --model opus --dangerously-skip-permissions' },
  parameters: { paneWidth: 720 },
};

export const ClaudeLauncherDisabledWhenDead: Story = {
  args: { dead: true, statusLabel: 'shell exited' },
  parameters: { paneWidth: 720 },
};

export const ClaudeAlreadyRunning: Story = {
  args: { claudeRunning: true, statusLabel: 'claude' },
  parameters: { paneWidth: 720 },
};
