import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PaneHeader, type PaneHeaderProps } from './PaneHeader';

const baseProps = (over: Partial<PaneHeaderProps> = {}): PaneHeaderProps => ({
  paneId: 'pane-1',
  compact: false,
  ultraCompact: false,
  hideSnippets: false,
  dead: false,
  statusLabel: '$SHELL',
  snippets: [],
  runSnippet: async () => {},
  selection: '',
  composeOpen: false,
  toggleCompose: () => {},
  onFind: () => {},
  onRestart: () => {},
  ...over,
});

describe('<PaneHeader />', () => {
  it('renders the Claude Code launcher when onLaunchClaude is provided', () => {
    render(
      <PaneHeader
        {...baseProps({ onLaunchClaude: () => {}, claudeCommand: 'claude' })}
      />,
    );
    expect(
      screen.getByRole('button', { name: /launch claude code/i }),
    ).toBeInTheDocument();
  });

  it('omits the launcher when no handler is wired', () => {
    render(<PaneHeader {...baseProps()} />);
    expect(
      screen.queryByRole('button', { name: /launch claude code/i }),
    ).not.toBeInTheDocument();
  });

  it('invokes onLaunchClaude on click', async () => {
    const user = userEvent.setup();
    const onLaunchClaude = vi.fn();
    render(
      <PaneHeader
        {...baseProps({ onLaunchClaude, claudeCommand: 'claude' })}
      />,
    );
    await user.click(screen.getByRole('button', { name: /launch claude code/i }));
    expect(onLaunchClaude).toHaveBeenCalledTimes(1);
  });

  it('surfaces the configured command in the tooltip so users see flags before clicking', () => {
    render(
      <PaneHeader
        {...baseProps({
          onLaunchClaude: () => {},
          claudeCommand: 'claude --model opus --dangerously-skip-permissions',
        })}
      />,
    );
    const btn = screen.getByRole('button', { name: /launch claude code/i });
    expect(btn.getAttribute('title')).toContain(
      'claude --model opus --dangerously-skip-permissions',
    );
  });

  it('disables the launcher when the shell has exited', () => {
    render(
      <PaneHeader
        {...baseProps({ dead: true, onLaunchClaude: () => {}, claudeCommand: 'claude' })}
      />,
    );
    expect(
      screen.getByRole('button', { name: /launch claude code/i }),
    ).toBeDisabled();
  });

  it('disables the launcher when claude is already the foreground process', () => {
    render(
      <PaneHeader
        {...baseProps({
          onLaunchClaude: () => {},
          claudeCommand: 'claude',
          claudeRunning: true,
        })}
      />,
    );
    const btn = screen.getByRole('button', { name: /launch claude code/i });
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('title')).toMatch(/already running/i);
  });
});
