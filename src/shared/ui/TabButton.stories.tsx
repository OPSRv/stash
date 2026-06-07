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
        { id: 'notes', label: 'Notes', icon: <NoteIcon size={12} />  },
        { id: 'search', label: 'Search', icon: <SearchIcon size={12} />  },
        { id: 'translator', label: 'Translator', icon: <TranslateIcon size={12} />  },
      ];
      return (
        <div role="tablist" className="sb-row">
          {tabs.map((t) => (
            <TabButton
              key={t.id}
              label={t.label}
              icon={t.icon}
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

// With icons present, every tab shows icon + label at all times (active or
// not). This is the mode used by the popup header; when the tabs overflow,
// the header pans horizontally via flanking arrow buttons rather than
// collapsing labels or showing a scrollbar.
export const WithIcons: Story = {
  render: () => {
    const Demo = () => {
      const [active, setActive] = useState('search');
      const tabs = [
        { id: 'notes', label: 'Notes', icon: <NoteIcon size={12} />  },
        { id: 'search', label: 'Search', icon: <SearchIcon size={12} />  },
        { id: 'translator', label: 'Translator', icon: <TranslateIcon size={12} />  },
      ];
      return (
        <div role="tablist" className="sb-row">
          {tabs.map((t) => (
            <TabButton
              key={t.id}
              label={t.label}
              icon={t.icon}
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

// Text-only tabs — no icon, just the label.
export const LabelOnly: Story = {
  render: () => {
    const Demo = () => {
      const [active, setActive] = useState('b');
      const tabs = [
        { id: 'a', label: 'Alpha'  },
        { id: 'b', label: 'Bravo'  },
        { id: 'c', label: 'Charlie'  },
      ];
      return (
        <div role="tablist" className="sb-row">
          {tabs.map((t) => (
            <TabButton
              key={t.id}
              label={t.label}
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
