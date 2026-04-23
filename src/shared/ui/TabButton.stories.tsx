import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { TabButton } from './TabButton';
import { NoteIcon, SearchIcon, TranslateIcon } from './icons';

const meta = {
  title: 'Primitives/TabButton',
  component: TabButton,
  tags: ['autodocs'],
} satisfies Meta<typeof TabButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Row: Story = {
  render: () => {
    const Demo = () => {
      const [active, setActive] = useState('notes');
      const tabs = [
        { id: 'notes', label: 'Notes', icon: <NoteIcon size={12} />, sc: '⌘⌥1' },
        { id: 'search', label: 'Search', icon: <SearchIcon size={12} />, sc: '⌘⌥2' },
        { id: 'translator', label: 'Translator', icon: <TranslateIcon size={12} />, sc: '⌘⌥3' },
      ];
      return (
        <div role="tablist" className="sb-row">
          {tabs.map((t) => (
            <TabButton
              key={t.id}
              label={t.label}
              icon={t.icon}
              shortcutHint={t.sc}
              active={active === t.id}
              onClick={() => setActive(t.id)}
            />
          ))}
        </div>
      );
    };
    return <Demo />;
  },
};

// With an icon present, inactive tabs collapse to icon-only and the active
// tab expands to show its label. This is the mode used by the popup header
// so 10+ modules fit across the width without truncation.
export const IconOnlyInactive: Story = {
  render: () => {
    const Demo = () => {
      const [active, setActive] = useState('search');
      const tabs = [
        { id: 'notes', label: 'Notes', icon: <NoteIcon size={12} />, sc: '⌘⌥1' },
        { id: 'search', label: 'Search', icon: <SearchIcon size={12} />, sc: '⌘⌥2' },
        { id: 'translator', label: 'Translator', icon: <TranslateIcon size={12} />, sc: '⌘⌥3' },
      ];
      return (
        <div role="tablist" className="sb-row">
          {tabs.map((t) => (
            <TabButton
              key={t.id}
              label={t.label}
              icon={t.icon}
              shortcutHint={t.sc}
              active={active === t.id}
              onClick={() => setActive(t.id)}
            />
          ))}
        </div>
      );
    };
    return <Demo />;
  },
};

// Without an icon, the label is always visible — the collapse only kicks in
// when there's something (the icon) to represent the tab in its stead.
export const LabelOnly: Story = {
  render: () => {
    const Demo = () => {
      const [active, setActive] = useState('b');
      const tabs = [
        { id: 'a', label: 'Alpha', sc: '⌘⌥1' },
        { id: 'b', label: 'Bravo', sc: '⌘⌥2' },
        { id: 'c', label: 'Charlie', sc: '⌘⌥3' },
      ];
      return (
        <div role="tablist" className="sb-row">
          {tabs.map((t) => (
            <TabButton
              key={t.id}
              label={t.label}
              shortcutHint={t.sc}
              active={active === t.id}
              onClick={() => setActive(t.id)}
            />
          ))}
        </div>
      );
    };
    return <Demo />;
  },
};
