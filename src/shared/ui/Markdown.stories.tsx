import type { Meta, StoryObj } from '@storybook/react-vite';
import { Markdown } from './Markdown';

const meta = {
  title: 'Typography/Markdown',
  component: Markdown,
  tags: ['autodocs'],
  parameters: { surface: 'pane' },
} satisfies Meta<typeof Markdown>;

export default meta;
type Story = StoryObj<typeof meta>;

const Stage = ({ children }: { children: React.ReactNode }) => (
  <div style={{ width: 560 }}>{children}</div>
);

const richSample = `# Заголовок

Абзац з **жирним**, *курсивом* та \`inline code\`. Також посилання: [Tauri](https://tauri.app).

- пункт один
- пункт **два** з наголосом
- пункт три

1. нумерований
2. список

> Блок-цитата для наочності.

| Колонка | Значення |
| --- | --- |
| Rust  | 🦀 |
| TypeScript | 📘 |

\`\`\`ts
export const greet = (name: string): string => \`Hello, \${name}!\`;
\`\`\`

\`\`\`rust
fn main() {
    println!("Hello, stash!");
}
\`\`\`
`;

export const Rich: Story = {
  render: () => (
    <Stage>
      <Markdown source={richSample} />
    </Stage>
  ),
};

export const PlainParagraph: Story = {
  render: () => (
    <Stage>
      <Markdown source="Просто один абзац без жодного форматування." />
    </Stage>
  ),
};

export const Checklist: Story = {
  render: () => (
    <Stage>
      <Markdown
        source={`Задачі на сьогодні:\n\n- [x] написати сторі\n- [ ] оновити документацію\n- [ ] запустити storybook білд`}
      />
    </Stage>
  ),
};

export const CodeHeavy: Story = {
  render: () => (
    <Stage>
      <Markdown
        source={"Приклад bash:\n\n```bash\nnpm run build-storybook\n```\n\nі JSON:\n\n```json\n{\n  \"name\": \"stash\",\n  \"version\": \"0.1.0\"\n}\n```\n"}
      />
    </Stage>
  ),
};
