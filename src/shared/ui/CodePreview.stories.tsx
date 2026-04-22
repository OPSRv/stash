import type { Meta, StoryObj } from '@storybook/react-vite';
import { CodePreview } from './CodePreview';

const meta = {
  title: 'Typography/CodePreview',
  component: CodePreview,
  tags: ['autodocs'],
  parameters: { surface: 'pane' },
  argTypes: {
    language: {
      control: 'select',
      options: [
        'typescript',
        'javascript',
        'rust',
        'python',
        'bash',
        'json',
        'yaml',
        'markdown',
        'plaintext',
      ],
    },
  },
} satisfies Meta<typeof CodePreview>;

export default meta;
type Story = StoryObj<typeof meta>;

const Stage = ({ children }: { children: React.ReactNode }) => (
  <div style={{ width: 560 }}>{children}</div>
);

export const Typescript: Story = {
  render: () => (
    <Stage>
      <CodePreview
        language="typescript"
        filename="math.ts"
        code={`export const add = (a: number, b: number): number => a + b;\n\nconsole.log(add(2, 3));`}
      />
    </Stage>
  ),
};

export const Rust: Story = {
  render: () => (
    <Stage>
      <CodePreview
        language="rust"
        filename="main.rs"
        code={`fn main() {\n    let total: u32 = (1..=10).sum();\n    println!("sum = {total}");\n}`}
      />
    </Stage>
  ),
};

export const BashNoFilename: Story = {
  render: () => (
    <Stage>
      <CodePreview
        language="bash"
        code={`#!/usr/bin/env bash\nset -euo pipefail\nfor f in *.md; do echo "$f"; done`}
      />
    </Stage>
  ),
};

export const JsonLong: Story = {
  render: () => (
    <Stage>
      <CodePreview
        language="json"
        filename="package.json"
        code={JSON.stringify(
          {
            name: 'stash',
            version: '0.1.0',
            scripts: { dev: 'vite', build: 'vite build', test: 'vitest run' },
            dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
          },
          null,
          2,
        )}
      />
    </Stage>
  ),
};
