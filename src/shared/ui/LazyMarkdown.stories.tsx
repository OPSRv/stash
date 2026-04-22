import type { Meta, StoryObj } from '@storybook/react-vite';
import { LazyMarkdown } from './LazyMarkdown';

const meta = {
  title: 'Typography/LazyMarkdown',
  component: LazyMarkdown,
  tags: ['autodocs'],
  parameters: { surface: 'pane' },
} satisfies Meta<typeof LazyMarkdown>;

export default meta;
type Story = StoryObj<typeof meta>;

const Stage = ({ children }: { children: React.ReactNode }) => (
  <div style={{ width: 560 }}>{children}</div>
);

export const Default: Story = {
  render: () => (
    <Stage>
      <LazyMarkdown
        source={`## Lazy markdown\n\nТой самий рендер, що й \`Markdown\`, але завантажується через \`React.lazy\` — користь для модулів, які **може** потребуватимуть markdown, але не на першому кадрі.\n\n- пункт один\n- пункт два\n\n\`\`\`ts\nexport const ready = true;\n\`\`\``}
      />
    </Stage>
  ),
};

export const WithCodeCopy: Story = {
  render: () => (
    <Stage>
      <LazyMarkdown
        codeCopy
        source={`\`\`\`bash\nnpm run storybook\n\`\`\`\n\n\`\`\`ts\nconst pi = 3.14159;\n\`\`\``}
      />
    </Stage>
  ),
};
