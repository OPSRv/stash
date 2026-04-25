import type { Meta, StoryObj } from '@storybook/react-vite';
import { MermaidBlock } from './MermaidBlock';

const meta = {
  title: 'Content/MermaidBlock',
  component: MermaidBlock,
  tags: ['autodocs'],
  argTypes: {
    source: { control: 'text' },
  },
} satisfies Meta<typeof MermaidBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    source: ['flowchart TD', '  A[Start] --> B[Process]', '  B --> C[End]'].join('\n'),
  },
};

export const Sequence: Story = {
  args: {
    source: [
      'sequenceDiagram',
      '  participant A as Alice',
      '  participant B as Bob',
      '  A->>B: Hi Bob',
      '  B-->>A: Hi Alice',
    ].join('\n'),
  },
};

export const LongDiagram: Story = {
  args: {
    source: [
      'flowchart TD',
      '  A[Input] --> B{Validate}',
      '  B -- ok --> C[Process]',
      '  B -- fail --> D[Error]',
      '  C --> E[Transform]',
      '  E --> F[Persist]',
      '  F --> G[Notify]',
      '  G --> H[Done]',
      '  D --> I[Log]',
      '  I --> J[Return]',
    ].join('\n'),
  },
};

export const Invalid: Story = {
  args: {
    source: 'this is not valid mermaid @@@ syntax ???',
  },
};
