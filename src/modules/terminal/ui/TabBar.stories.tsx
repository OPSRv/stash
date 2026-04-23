import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import type { Tab } from '../types';
import { leaf } from '../state/paneTree';
import { TabBar } from './TabBar';

const meta = {
  title: 'Terminal/TabBar',
  component: TabBar,
  tags: ['autodocs'],
  args: {
    tabs: [{ id: 'tab-1', root: leaf('pane-1') }] as Tab[],
    activeId: 'tab-1',
    dropOverTab: '',
    onActivate: () => {},
    onClose: () => {},
    onAdd: () => {},
    onRename: () => {},
    onTabDragStart: () => () => {},
  },
} satisfies Meta<typeof TabBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleTab: Story = {};

export const MultipleTabs: Story = {
  args: {
    tabs: [
      { id: 'tab-1', root: leaf('pane-1') },
      {
        id: 'tab-2',
        root: {
          kind: 'split',
          orientation: 'row',
          ratios: [50, 50],
          children: [leaf('pane-2'), leaf('pane-3')],
        },
      },
      { id: 'tab-3', root: leaf('pane-4'), label: 'Claude' },
    ],
    activeId: 'tab-2',
  },
};

export const MaxCap: Story = {
  args: {
    tabs: Array.from({ length: 8 }, (_, i) => ({
      id: `tab-${i + 1}`,
      root: leaf(`pane-${i + 1}`),
    })),
    activeId: 'tab-3',
  },
};

export const DropTarget: Story = {
  args: {
    tabs: [
      { id: 'tab-1', root: leaf('pane-1') },
      { id: 'tab-2', root: leaf('pane-2') },
    ],
    activeId: 'tab-1',
    dropOverTab: 'tab-2',
  },
};

/// Smoke playground with stateful tab list + rename so Storybook can
/// actually exercise close / add / rename flows.
export const Interactive: Story = {
  render: () => {
    const [tabs, setTabs] = useState<Tab[]>([
      { id: 'tab-1', root: leaf('pane-1') },
    ]);
    const [active, setActive] = useState('tab-1');
    const [nextPane, setNextPane] = useState(2);
    return (
      <TabBar
        tabs={tabs}
        activeId={active}
        dropOverTab=""
        onActivate={setActive}
        onClose={(id) => {
          setTabs((prev) => prev.filter((t) => t.id !== id));
          if (active === id) {
            const remaining = tabs.filter((t) => t.id !== id);
            if (remaining[0]) setActive(remaining[0].id);
          }
        }}
        onAdd={() => {
          const id = `tab-${tabs.length + 1}`;
          setTabs((prev) => [...prev, { id, root: leaf(`pane-${nextPane}`) }]);
          setNextPane((n) => n + 1);
          setActive(id);
        }}
        onRename={(id, label) => {
          setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, label } : t)));
        }}
        onTabDragStart={() => () => {}}
      />
    );
  },
};
