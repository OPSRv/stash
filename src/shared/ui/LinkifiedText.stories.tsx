import type { Meta, StoryObj } from '@storybook/react-vite';
import { LinkifiedText } from './LinkifiedText';

const meta = {
  title: 'Typography/LinkifiedText',
  component: LinkifiedText,
  tags: ['autodocs'],
  parameters: { surface: 'pane' },
} satisfies Meta<typeof LinkifiedText>;

export default meta;
type Story = StoryObj<typeof meta>;

const Stage = ({ children }: { children: React.ReactNode }) => (
  <div style={{ width: 420 }}>{children}</div>
);

export const PlainText: Story = {
  render: () => (
    <Stage>
      <LinkifiedText content="Просто текст без посилань. Кілька рядків, з переносами\n— друга лінія тут." />
    </Stage>
  ),
};

export const SingleUrl: Story = {
  render: () => (
    <Stage>
      <LinkifiedText content="Документація тут: https://tauri.app/v2/guide — відкривається в браузері." />
    </Stage>
  ),
};

export const MultipleUrls: Story = {
  render: () => (
    <Stage>
      <LinkifiedText
        content={`Корисні ресурси:\n- https://react.dev\n- www.tauri.app/reference\n- https://vitest.dev/guide/cli.html?query=run#run.`}
      />
    </Stage>
  ),
};

export const MessyPunctuation: Story = {
  render: () => (
    <Stage>
      <LinkifiedText content="Глянь (https://example.com/path), або www.stash.dev." />
    </Stage>
  ),
};
