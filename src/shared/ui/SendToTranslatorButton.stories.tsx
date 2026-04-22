import type { Meta, StoryObj } from '@storybook/react-vite';
import { SendToTranslatorButton } from './SendToTranslatorButton';

const meta = {
  title: 'Primitives/SendToTranslatorButton',
  component: SendToTranslatorButton,
  tags: ['autodocs'],
  args: { text: 'Hello world', size: 12 },
  argTypes: {
    disabled: { control: 'boolean' },
    size: { control: { type: 'number', min: 10, max: 20, step: 1 } },
  },
} satisfies Meta<typeof SendToTranslatorButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Disabled: Story = {
  args: { disabled: true, text: '' },
};

export const BiggerIcon: Story = {
  args: { size: 16, text: 'Текст для перекладу' },
};
