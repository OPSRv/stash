import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { SelectionHeader } from './SelectionHeader';
import { Checkbox } from './Checkbox';
import { Button } from './Button';
import { TrashIcon } from './icons';

const meta = {
  title: 'Inputs/SelectionHeader',
  component: SelectionHeader,
  tags: ['autodocs'],
  parameters: { surface: 'plain', layout: 'padded' },
} satisfies Meta<typeof SelectionHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithList: Story = {
  render: () => {
    const items = ['Xcode DerivedData', 'Homebrew cache', 'npm cache', 'pip cache', 'CocoaPods'];
    const Demo = () => {
      const [picked, setPicked] = useState<Record<string, boolean>>({
        'Homebrew cache': true,
      });
      const selectedCount = Object.values(picked).filter(Boolean).length;
      const setAll = (on: boolean) => {
        const next: Record<string, boolean> = {};
        items.forEach((i) => (next[i] = on));
        setPicked(next);
      };
      return (
        <div className="pane rounded-xl overflow-hidden" style={{ width: 480 }}>
          <SelectionHeader
            total={items.length}
            selected={selectedCount}
            onToggleAll={setAll}
            label="Caches"
            separated
            trailing={
              selectedCount > 0 ? (
                <Button size="sm" variant="soft" tone="danger" leadingIcon={<TrashIcon size={12} />}>
                  Delete ({selectedCount})
                </Button>
              ) : null
            }
          />
          <ul className="py-1">
            {items.map((i) => (
              <li key={i} className="flex items-center gap-3 px-3 py-2">
                <Checkbox
                  size="sm"
                  checked={!!picked[i]}
                  onChange={(on) => setPicked((p) => ({ ...p, [i]: on }))}
                  ariaLabel={i}
                />
                <span className="t-primary text-body flex-1 min-w-0 truncate">{i}</span>
                <span className="t-tertiary text-meta tabular-nums">
                  {Math.round(Math.random() * 900 + 100)} MB
                </span>
              </li>
            ))}
          </ul>
        </div>
      );
    };
    return <Demo />;
  },
};
