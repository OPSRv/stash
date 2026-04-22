import type { Meta, StoryObj } from '@storybook/react-vite';
import { Row } from './Row';
import { IconButton } from './IconButton';
import { Badge } from './Badge';
import { DocumentIcon, PinIcon, TrashIcon } from './icons';

const meta = {
  title: 'Surfaces/Row',
  component: Row,
  tags: ['autodocs'],
  parameters: { surface: 'pane' },
  argTypes: {
    active: { control: 'boolean' },
    pinned: { control: 'boolean' },
    selected: { control: 'boolean' },
  },
  args: {
    primary: 'Шпаргалка по Rust',
    secondary: '12 нотаток · оновлено 2 год тому',
  },
} satisfies Meta<typeof Row>;

export default meta;
type Story = StoryObj<typeof meta>;

const Stage = ({ children }: { children: React.ReactNode }) => (
  <div className="pane rounded-xl py-2" style={{ width: 420 }}>
    {children}
  </div>
);

export const Default: Story = {
  render: (args) => (
    <Stage>
      <Row {...args} />
    </Stage>
  ),
};

export const WithIcon: Story = {
  render: (args) => (
    <Stage>
      <Row {...args} icon={<DocumentIcon size={14} />} />
    </Stage>
  ),
};

export const WithActionsAndMeta: Story = {
  render: (args) => (
    <Stage>
      <Row
        {...args}
        icon={<DocumentIcon size={14} />}
        meta={<Badge tone="success">saved</Badge>}
        actions={
          <>
            <IconButton title="Pin" onClick={() => {}}><PinIcon size={12} /></IconButton>
            <IconButton title="Delete" tone="danger" onClick={() => {}}><TrashIcon size={12} /></IconButton>
          </>
        }
      />
    </Stage>
  ),
};

export const States: Story = {
  render: (args) => (
    <Stage>
      <Row {...args} primary="Default" />
      <Row {...args} primary="Selected" selected />
      <Row {...args} primary="Active" active />
      <Row {...args} primary="Pinned" pinned icon={<PinIcon size={12} />} />
    </Stage>
  ),
};
