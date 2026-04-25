import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { RangeSlider } from './RangeSlider';

const meta = {
  title: 'Inputs/RangeSlider',
  component: RangeSlider,
  tags: ['autodocs'],
  argTypes: {
    min: { control: 'number' },
    max: { control: 'number' },
    step: { control: 'number' },
    label: { control: 'text' },
    showFill: { control: 'boolean' },
    disabled: { control: 'boolean' },
    className: { control: 'text' },
  },
  args: { min: 0, max: 100, step: 1, showFill: true, disabled: false },
} satisfies Meta<typeof RangeSlider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  args: { label: 'value' },
  render: (a) => {
    const Demo = () => {
      const [v, setV] = useState(50);
      return (
        <div style={{ width: 240 }}>
          <RangeSlider {...a} value={v} onChange={setV} />
          <div className="t-tertiary text-meta" style={{ marginTop: 8 }}>
            {v}
          </div>
        </div>
      );
    };
    return <Demo />;
  },
};

export const WithLabel: Story = {
  args: { label: 'Volume' },
  render: (a) => {
    const Demo = () => {
      const [v, setV] = useState(70);
      return (
        <div style={{ width: 240 }}>
          <div className="t-tertiary text-meta" style={{ marginBottom: 4 }}>
            {a.label}: {v}%
          </div>
          <RangeSlider {...a} value={v} onChange={setV} />
        </div>
      );
    };
    return <Demo />;
  },
};

export const CustomRange: Story = {
  args: { min: 0, max: 1, step: 0.01, label: 'Brightness (0–1)' },
  render: (a) => {
    const Demo = () => {
      const [v, setV] = useState(0.5);
      return (
        <div style={{ width: 240 }}>
          <div className="t-tertiary text-meta" style={{ marginBottom: 4 }}>
            {v.toFixed(2)}
          </div>
          <RangeSlider {...a} value={v} onChange={setV} />
        </div>
      );
    };
    return <Demo />;
  },
};

export const Disabled: Story = {
  args: { disabled: true, label: 'disabled' },
  render: (a) => (
    <div style={{ width: 240 }}>
      <RangeSlider {...a} value={40} onChange={() => undefined} />
    </div>
  ),
};

export const NoFill: Story = {
  args: { showFill: false, label: 'no fill track' },
  render: (a) => {
    const Demo = () => {
      const [v, setV] = useState(60);
      return (
        <div style={{ width: 240 }}>
          <RangeSlider {...a} value={v} onChange={setV} />
        </div>
      );
    };
    return <Demo />;
  },
};

export const FullWidth: Story = {
  args: { label: 'full width' },
  render: (a) => {
    const Demo = () => {
      const [v, setV] = useState(30);
      return (
        <div style={{ width: '100%' }}>
          <RangeSlider {...a} value={v} onChange={setV} />
        </div>
      );
    };
    return <Demo />;
  },
};
