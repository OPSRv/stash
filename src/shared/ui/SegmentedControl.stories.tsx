import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useState } from 'react';
import { SegmentedControl } from './SegmentedControl';

const meta = {
  title: 'Primitives/SegmentedControl',
  component: SegmentedControl,
  tags: ['autodocs'],
} satisfies Meta<typeof SegmentedControl>;

export default meta;
type Story = StoryObj<typeof meta>;

type View = 'list' | 'grid' | 'kanban';

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const grid = await canvas.findByRole('radio', { name: 'Grid' });
    await expect(grid).toHaveAttribute('aria-checked', 'true');
    const list = canvas.getByRole('radio', { name: 'List' });
    await userEvent.click(list);
    await expect(list).toHaveAttribute('aria-checked', 'true');
    await expect(grid).toHaveAttribute('aria-checked', 'false');
  },
  render: () => {
    const Demo = () => {
      const [v, setV] = useState<View>('grid');
      return (
        <SegmentedControl<View>
          ariaLabel="View mode"
          value={v}
          onChange={setV}
          options={[
            { value: 'list', label: 'List' },
            { value: 'grid', label: 'Grid' },
            { value: 'kanban', label: 'Kanban' },
          ]}
        />
      );
    };
    return <Demo />;
  },
};

export const WithDisabled: Story = {
  render: () => {
    const Demo = () => {
      const [v, setV] = useState<View>('list');
      return (
        <SegmentedControl<View>
          size="sm"
          value={v}
          onChange={setV}
          options={[
            { value: 'list', label: 'List' },
            { value: 'grid', label: 'Grid' },
            { value: 'kanban', label: 'Soon', disabled: true },
          ]}
        />
      );
    };
    return <Demo />;
  },
};
