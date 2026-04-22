import type { Meta, StoryObj } from '@storybook/react-vite';
import { FilePreview, FilePreviewList } from './FilePreview';

const meta = {
  title: 'Media/FilePreview',
  component: FilePreview,
  tags: ['autodocs'],
  parameters: { surface: 'pane' },
} satisfies Meta<typeof FilePreview>;

export default meta;
type Story = StoryObj<typeof meta>;

const Stage = ({ children }: { children: React.ReactNode }) => (
  <div style={{ width: 520 }}>{children}</div>
);

export const Image: Story = {
  render: () => (
    <Stage>
      <FilePreview
        src="https://picsum.photos/seed/stash-preview/640/400"
        name="landscape.jpg"
        mime="image/jpeg"
        caption="Скріншот із Telegram"
        sizeBytes={184_000}
      />
    </Stage>
  ),
};

export const TextSnippet: Story = {
  render: () => (
    <Stage>
      <FilePreview
        text={`# Нотатка\n\nЦе інлайновий текст без src — рендериться напряму без завантаження.`}
        name="note.md"
        mime="text/markdown"
      />
    </Stage>
  ),
};

export const CodeBlock: Story = {
  render: () => (
    <Stage>
      <FilePreview
        text={`export const add = (a: number, b: number) => a + b;\n\nconsole.log(add(2, 3));`}
        name="math.ts"
        mime="text/x-typescript"
      />
    </Stage>
  ),
};

export const UnknownFile: Story = {
  render: () => (
    <Stage>
      <FilePreview
        src="/fake/path/report.pages"
        name="report.pages"
        mime="application/x-iwork-pages-sffpages"
        sizeBytes={3_241_000}
      />
    </Stage>
  ),
};

export const List: Story = {
  render: () => (
    <Stage>
      <FilePreviewList
        files={[
          { src: 'https://picsum.photos/seed/stash-list-1/640/400', name: 'hero.jpg', mime: 'image/jpeg' },
          { text: 'Plain text snippet without a filename.', mime: 'text/plain' },
          { src: '/tmp/unknown.bin', name: 'unknown.bin', sizeBytes: 421_000 },
        ]}
      />
    </Stage>
  ),
};
