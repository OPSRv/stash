import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { CopyIcon, PinIcon, TrashIcon, ExternalIcon } from './icons';

const meta = {
  title: 'Overlays/ContextMenu',
  component: ContextMenu,
  tags: ['autodocs'],
  parameters: { surface: 'plain', layout: 'fullscreen' },
} satisfies Meta<typeof ContextMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

const Demo = ({ items }: { items: ContextMenuItem[] }) => {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  return (
    <div
      style={{
        position: 'relative',
        width: 640,
        height: 420,
        background: '#14141a',
        borderRadius: 12,
        overflow: 'hidden',
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setPos({ x: e.clientX, y: e.clientY });
      }}
    >
      <p
        className="t-tertiary text-[12px]"
        style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}
      >
        Клац правою кнопкою в межах цього прямокутника
      </p>
      {pos && (
        <ContextMenu
          open
          x={pos.x}
          y={pos.y}
          items={items}
          onClose={() => setPos(null)}
          label="Demo menu"
        />
      )}
    </div>
  );
};

export const Basic: Story = {
  render: () => (
    <Demo
      items={[
        { kind: 'action', label: 'Скопіювати', shortcut: '⌘C', icon: <CopyIcon size={12} />, onSelect: () => {} },
        { kind: 'action', label: 'Відкрити у вкладці', icon: <ExternalIcon size={12} />, onSelect: () => {} },
        { kind: 'action', label: 'Запінити', icon: <PinIcon size={12} />, onSelect: () => {} },
      ]}
    />
  ),
};

export const WithSeparatorAndDanger: Story = {
  render: () => (
    <Demo
      items={[
        { kind: 'action', label: 'Скопіювати', shortcut: '⌘C', icon: <CopyIcon size={12} />, onSelect: () => {} },
        { kind: 'action', label: 'Відкрити у вкладці', icon: <ExternalIcon size={12} />, onSelect: () => {} },
        { kind: 'separator' },
        { kind: 'action', label: 'Заархівувати', onSelect: () => {} },
        { kind: 'action', label: 'Disabled action', onSelect: () => {}, disabled: true },
        { kind: 'separator' },
        { kind: 'action', label: 'Видалити', tone: 'danger', icon: <TrashIcon size={12} />, shortcut: '⌫', onSelect: () => {} },
      ]}
    />
  ),
};
