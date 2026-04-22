import type { Meta, StoryObj } from '@storybook/react-vite';
import { ListItemRow } from './ListItemRow';
import { Checkbox } from './Checkbox';
import { Button } from './Button';
import { Badge } from './Badge';

const meta = {
  title: 'Surfaces/ListItemRow',
  component: ListItemRow,
  tags: ['autodocs'],
  parameters: { surface: 'pane' },
  args: {
    title: '~/Projects/stash/node_modules',
    meta: '842.1 MB · 23 417 файлів',
  },
} satisfies Meta<typeof ListItemRow>;

export default meta;
type Story = StoryObj<typeof meta>;

const List = ({ children }: { children: React.ReactNode }) => (
  <ul className="pane rounded-xl py-1" style={{ width: 460 }}>
    {children}
  </ul>
);

export const Default: Story = {
  render: (args) => (
    <List>
      <ListItemRow {...args} />
    </List>
  ),
};

export const Interactive: Story = {
  render: (args) => (
    <List>
      <ListItemRow {...args} onClick={() => {}} />
      <ListItemRow {...args} title="Selected item" onClick={() => {}} selected />
      <ListItemRow {...args} title="Another entry" onClick={() => {}} />
    </List>
  ),
};

export const WithLeadingAndTrailing: Story = {
  render: (args) => (
    <List>
      <ListItemRow
        {...args}
        leading={<Checkbox checked={false} onChange={() => {}} ariaLabel="select" />}
        trailing={
          <>
            <Badge tone="warning">stale</Badge>
            <Button size="xs" variant="ghost">Open</Button>
          </>
        }
        onClick={() => {}}
      />
      <ListItemRow
        {...args}
        title="Short"
        meta={null}
        leading={<Checkbox checked onChange={() => {}} ariaLabel="select" />}
        trailing={<Badge tone="success">ok</Badge>}
        onClick={() => {}}
        selected
      />
    </List>
  ),
};
