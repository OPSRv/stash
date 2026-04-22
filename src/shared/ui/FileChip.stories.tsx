import type { Meta, StoryObj } from '@storybook/react-vite';
import { FileChip, formatBytes } from './FileChip';
import { IconButton } from './IconButton';
import { ExternalIcon, TrashIcon } from './icons';

const meta = {
  title: 'Surfaces/FileChip',
  component: FileChip,
  tags: ['autodocs'],
  parameters: { surface: 'pane' },
  args: {
    name: 'annual-report-2025.pdf',
    mimeType: 'application/pdf',
    size: formatBytes(2_134_000),
  },
} satisfies Meta<typeof FileChip>;

export default meta;
type Story = StoryObj<typeof meta>;

const Stage = ({ children }: { children: React.ReactNode }) => (
  <div style={{ width: 420 }}>{children}</div>
);

export const Default: Story = {
  render: (args) => (
    <Stage>
      <FileChip {...args} />
    </Stage>
  ),
};

export const WithActions: Story = {
  render: (args) => (
    <Stage>
      <FileChip
        {...args}
        actions={
          <>
            <IconButton title="Відкрити" onClick={() => {}}>
              <ExternalIcon size={12} />
            </IconButton>
            <IconButton title="Видалити" tone="danger" onClick={() => {}}>
              <TrashIcon size={12} />
            </IconButton>
          </>
        }
      />
    </Stage>
  ),
};

export const LongName: Story = {
  args: {
    name: 'very-long-file-name-that-should-truncate-because-no-sane-person-writes-this-much.tar.gz',
    mimeType: 'application/gzip',
    size: formatBytes(54_321_000),
  },
  render: (args) => (
    <Stage>
      <FileChip {...args} />
    </Stage>
  ),
};

export const WithCaption: Story = {
  args: {
    name: 'meeting-notes.md',
    mimeType: 'text/markdown',
    size: formatBytes(12_400),
    caption: 'Підпис з Telegram — може бути в кілька рядків і містити емоджі 📎.',
  },
  render: (args) => (
    <Stage>
      <FileChip {...args} />
    </Stage>
  ),
};

export const MinimalNameOnly: Story = {
  args: { name: 'untitled', mimeType: null, size: null },
  render: (args) => (
    <Stage>
      <FileChip {...args} />
    </Stage>
  ),
};
