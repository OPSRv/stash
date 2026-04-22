import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { NumberInput } from './NumberInput';

const meta = {
  title: 'Inputs/NumberInput',
  component: NumberInput,
  tags: ['autodocs'],
  argTypes: {
    size: { control: 'inline-radio', options: ['sm', 'md'] },
    tone: { control: 'inline-radio', options: ['default', 'danger'] },
    disabled: { control: 'boolean' },
    hideStepper: { control: 'boolean' },
  },
  args: { size: 'md' },
} satisfies Meta<typeof NumberInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (a) => {
    const Demo = () => {
      const [v, setV] = useState<number | null>(4);
      return (
        <div style={{ width: 200 }}>
          <NumberInput {...a} value={v} onChange={setV} ariaLabel="amount" />
        </div>
      );
    };
    return <Demo />;
  },
};

export const WithRange: Story = {
  render: () => {
    const Demo = () => {
      const [v, setV] = useState<number | null>(12);
      return (
        <div style={{ width: 200 }}>
          <NumberInput value={v} onChange={setV} min={0} max={60} ariaLabel="minutes" suffix="min" />
        </div>
      );
    };
    return <Demo />;
  },
};

export const Decimal: Story = {
  render: () => {
    const Demo = () => {
      const [v, setV] = useState<number | null>(1.5);
      return (
        <div style={{ width: 200 }}>
          <NumberInput
            value={v}
            onChange={setV}
            min={0}
            max={10}
            step={0.1}
            ariaLabel="scale"
            suffix="×"
          />
        </div>
      );
    };
    return <Demo />;
  },
};

export const NoStepper: Story = {
  render: () => {
    const Demo = () => {
      const [v, setV] = useState<number | null>(42);
      return (
        <div style={{ width: 200 }}>
          <NumberInput value={v} onChange={setV} hideStepper ariaLabel="bare" />
        </div>
      );
    };
    return <Demo />;
  },
};

export const Sizes: Story = {
  render: () => {
    const Demo = () => {
      const [a, setA] = useState<number | null>(3);
      const [b, setB] = useState<number | null>(3);
      return (
        <div className="sb-col" style={{ width: 200 }}>
          <NumberInput size="sm" value={a} onChange={setA} ariaLabel="sm" suffix="px" />
          <NumberInput size="md" value={b} onChange={setB} ariaLabel="md" suffix="px" />
        </div>
      );
    };
    return <Demo />;
  },
};

export const Invalid: Story = {
  render: () => {
    const Demo = () => {
      const [v, setV] = useState<number | null>(-3);
      return (
        <div style={{ width: 200 }}>
          <NumberInput value={v} onChange={setV} invalid min={0} ariaLabel="invalid" />
        </div>
      );
    };
    return <Demo />;
  },
};
