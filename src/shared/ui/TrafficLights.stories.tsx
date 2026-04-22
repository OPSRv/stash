import type { Meta, StoryObj } from '@storybook/react-vite';
import { TrafficLights } from './TrafficLights';

const meta = {
  title: 'Surfaces/TrafficLights',
  component: TrafficLights,
  tags: ['autodocs'],
} satisfies Meta<typeof TrafficLights>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
