import type { Meta, StoryObj } from '@storybook/react-vite';
import { Input } from './Input';
import { Kbd } from './Kbd';
import { SearchIcon } from './icons';

const meta = {
  title: 'Inputs/Input',
  component: Input,
  tags: ['autodocs'],
  argTypes: {
    size: { control: 'inline-radio', options: ['sm', 'md'] },
    tone: { control: 'inline-radio', options: ['default', 'danger'] },
    invalid: { control: 'boolean' },
    disabled: { control: 'boolean' },
  },
  args: {
    placeholder: 'Type something…',
    size: 'md',
  },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Bare: Story = {};

export const WithLeadingIcon: Story = {
  args: {
    leadingIcon: <SearchIcon size={14} />,
    placeholder: 'Search notes',
  },
};

export const WithTrailing: Story = {
  args: {
    leadingIcon: <SearchIcon size={14} />,
    trailing: <Kbd>⌘K</Kbd>,
    placeholder: 'Global search',
  },
};

export const Invalid: Story = {
  args: { invalid: true, defaultValue: 'nope@' },
};

export const Disabled: Story = {
  args: { disabled: true, defaultValue: 'read only' },
};

export const Sizes: Story = {
  render: (args) => (
    <div className="sb-col" style={{ width: 260 }}>
      <Input {...args} size="sm" placeholder="sm" />
      <Input {...args} size="md" placeholder="md" />
    </div>
  ),
};
