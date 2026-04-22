import type { Meta, StoryObj } from '@storybook/react-vite';
import { AskAiButton } from './AskAiButton';

const meta = {
  title: 'Primitives/AskAiButton',
  component: AskAiButton,
  tags: ['autodocs'],
  args: { text: 'Поясни цей шматок коду', size: 12 },
  argTypes: {
    disabled: { control: 'boolean' },
    size: { control: { type: 'number', min: 10, max: 20, step: 1 } },
  },
} satisfies Meta<typeof AskAiButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Disabled: Story = {
  args: { disabled: true, text: '' },
};

export const BiggerIcon: Story = {
  args: { size: 16 },
};
