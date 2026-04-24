import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TabContent } from './TabContent';
import { leaf } from './state/paneTree';
import type { PaneNode, Tab } from './types';

const split = (orientation: 'row' | 'column', children: PaneNode[]): PaneNode => ({
  kind: 'split',
  orientation,
  ratios: children.map(() => 100 / children.length),
  children,
});

type PaneProps = {
  id: string;
  initialCwd?: string | null;
  onSplit?: (orientation: 'row' | 'column', sourceCwd: string) => void;
};

const paneProps: PaneProps[] = [];

vi.mock('./TerminalPane', () => ({
  TerminalPane: (props: PaneProps) => {
    paneProps.push(props);
    return <div data-testid={`pane-${props.id}`} />;
  },
}));

const renderContent = (overrides: Partial<React.ComponentProps<typeof TabContent>> = {}) => {
  const tab: Tab = { id: 'tab-1', root: split('row', [leaf('pane-1'), leaf('pane-2')]) };
  const props: React.ComponentProps<typeof TabContent> = {
    tab,
    visible: true,
    focusedPane: 'pane-1',
    setFocusedPane: vi.fn(),
    onSplit: vi.fn(),
    onClosePane: vi.fn(),
    onRatios: vi.fn(),
    onPaneDragStart: () => () => {},
    maximizedPane: null,
    onToggleMaximize: vi.fn(),
    revision: 0,
    getInitialCwd: () => undefined,
    fontSize: 12,
    ...overrides,
  };
  return { ...render(<TabContent {...props} />), props };
};

describe('TabContent', () => {
  it('forwards getInitialCwd result to each TerminalPane as initialCwd', () => {
    paneProps.length = 0;
    const cwds: Record<string, string> = { 'pane-2': '/Users/me/work' };
    renderContent({ getInitialCwd: (id) => cwds[id] });

    const p1 = paneProps.find((p) => p.id === 'pane-1');
    const p2 = paneProps.find((p) => p.id === 'pane-2');
    expect(p1?.initialCwd).toBeUndefined();
    expect(p2?.initialCwd).toBe('/Users/me/work');
  });

  it('threads sourceCwd from pane onSplit up to onSplit(paneId, orientation, cwd)', () => {
    paneProps.length = 0;
    const onSplit = vi.fn();
    renderContent({ onSplit });

    const p1 = paneProps.find((p) => p.id === 'pane-1');
    p1?.onSplit?.('row', '/Users/me/work');
    expect(onSplit).toHaveBeenCalledWith('pane-1', 'row', '/Users/me/work');
  });
});
