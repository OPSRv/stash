import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { SearchInput } from './SearchInput';

const meta = {
  title: 'Inputs/SearchInput',
  component: SearchInput,
  tags: ['autodocs'],
} satisfies Meta<typeof SearchInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const Demo = () => {
      const [v, setV] = useState('');
      return (
        <div className="pane rounded-xl" style={{ width: 360 }}>
          <SearchInput value={v} onChange={setV} placeholder="Search…" shortcutHint="⌘K" />
        </div>
      );
    };
    return <Demo />;
  },
};

export const Compact: Story = {
  render: () => {
    const Demo = () => {
      const [v, setV] = useState('auth');
      return (
        <div className="pane rounded-xl" style={{ width: 320 }}>
          <SearchInput compact value={v} onChange={setV} placeholder="Quick find" />
        </div>
      );
    };
    return <Demo />;
  },
};
