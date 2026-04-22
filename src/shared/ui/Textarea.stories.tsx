import type { Meta, StoryObj } from '@storybook/react-vite';
import { Textarea } from './Textarea';

const meta = {
  title: 'Inputs/Textarea',
  component: Textarea,
  tags: ['autodocs'],
  args: { placeholder: 'Write something…', rows: 4 },
} satisfies Meta<typeof Textarea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { render: (a) => <div style={{ width: 360 }}><Textarea {...a} /></div> };
export const Invalid: Story = { args: { invalid: true, defaultValue: 'too short' } };
export const Disabled: Story = { args: { disabled: true, defaultValue: 'locked' } };
