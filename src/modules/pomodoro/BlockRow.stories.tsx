import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { BlockRow } from './BlockRow';
import type { Block } from './api';

const base: Block = {
  id: 'focus-1',
  name: 'Deep focus',
  duration_sec: 25 * 60,
  posture: 'sit',
  mid_nudge_sec: null,
};

const meta = {
  title: 'Modules/Pomodoro/BlockRow',
  component: BlockRow,
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
} satisfies Meta<typeof BlockRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Editable: Story = {
  render: () => {
    const Demo = () => {
      const [block, setBlock] = useState<Block>(base);
      return (
        <div className="pane rounded-xl p-3" style={{ width: 560 }}>
          <BlockRow block={block} onChange={setBlock} onDelete={() => {}} />
        </div>
      );
    };
    return <Demo />;
  },
};

export const WithNudge: Story = {
  render: () => {
    const Demo = () => {
      const [block, setBlock] = useState<Block>({
        ...base,
        name: 'Long focus',
        duration_sec: 45 * 60,
        mid_nudge_sec: 25 * 60,
      });
      return (
        <div className="pane rounded-xl p-3" style={{ width: 560 }}>
          <BlockRow block={block} onChange={setBlock} onDelete={() => {}} />
        </div>
      );
    };
    return <Demo />;
  },
};

export const ReadOnlyTimeline: Story = {
  render: () => {
    const blocks: Block[] = [
      { ...base, id: '1', name: 'Deep focus', posture: 'sit' },
      { ...base, id: '2', name: 'Stand break', duration_sec: 10 * 60, posture: 'stand' },
      { ...base, id: '3', name: 'Walk', duration_sec: 5 * 60, posture: 'walk' },
    ];
    return (
      <div className="pane rounded-xl p-3 flex flex-col gap-2" style={{ width: 440 }}>
        {blocks.map((b) => (
          <BlockRow key={b.id} block={b} onChange={() => {}} onDelete={() => {}} readOnly />
        ))}
      </div>
    );
  },
};
