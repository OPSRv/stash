import type { Meta, StoryObj } from '@storybook/react-vite';
import { TELEGRAM_KINDS, TelegramKindBadge } from './TelegramKindBadge';

const meta = {
  title: 'Modules/Telegram/KindBadge',
  component: TelegramKindBadge,
  tags: ['autodocs'],
  argTypes: {
    kind: { control: 'select', options: TELEGRAM_KINDS },
  },
  args: { kind: 'voice' },
} satisfies Meta<typeof TelegramKindBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Text: Story = { args: { kind: 'text' } };
export const Voice: Story = { args: { kind: 'voice' } };
export const Photo: Story = { args: { kind: 'photo' } };
export const Video: Story = { args: { kind: 'video' } };
export const VideoNote: Story = { args: { kind: 'video_note' } };
export const Document: Story = { args: { kind: 'document' } };
export const Sticker: Story = { args: { kind: 'sticker' } };

export const AllKinds: Story = {
  render: () => (
    <div className="sb-row">
      {TELEGRAM_KINDS.map((k) => (
        <TelegramKindBadge key={k} kind={k} />
      ))}
    </div>
  ),
};

export const InboxRow: Story = {
  render: () => (
    <div className="pane rounded-xl p-3" style={{ width: 420 }}>
      <div className="flex items-center gap-3">
        <TelegramKindBadge kind="voice" />
        <div className="flex-1 min-w-0">
          <div className="t-primary text-body truncate">Voice note from Olha</div>
          <div className="t-tertiary text-meta">0:42 • 2 min ago</div>
        </div>
      </div>
    </div>
  ),
};
