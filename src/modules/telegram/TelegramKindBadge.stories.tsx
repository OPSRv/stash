import type { Meta, StoryObj } from '@storybook/react-vite';
import { Badge } from '../../shared/ui/Badge';

/// Mirrors the KIND_META map used in `InboxPanel.tsx` so the palette stays
/// in one visible place for design review.
const KIND_META: Record<string, { label: string; color: string }> = {
  text: { label: 'Text', color: 'rgba(255,255,255,0.45)' },
  voice: { label: 'Voice', color: '#4A8BEA' },
  photo: { label: 'Photo', color: '#7B54E8' },
  video: { label: 'Video', color: '#EA8B4A' },
  document: { label: 'Doc', color: '#5BC88A' },
  sticker: { label: 'Sticker', color: '#EAD24A' },
};

const KindBadge = ({ kind }: { kind: string }) => {
  const meta = KIND_META[kind] ?? { label: kind, color: 'rgba(255,255,255,0.45)' };
  return (
    <Badge color={meta.color} bg={`${meta.color}1a`} className="uppercase tracking-wider">
      {meta.label}
    </Badge>
  );
};

const meta = {
  title: 'Modules/Telegram/KindBadge',
  component: KindBadge,
  tags: ['autodocs'],
} satisfies Meta<typeof KindBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllKinds: Story = {
  render: () => (
    <div className="sb-row">
      {Object.keys(KIND_META).map((k) => (
        <KindBadge key={k} kind={k} />
      ))}
    </div>
  ),
};

export const InboxRow: Story = {
  render: () => (
    <div className="pane rounded-xl p-3" style={{ width: 420 }}>
      <div className="flex items-center gap-3">
        <KindBadge kind="voice" />
        <div className="flex-1 min-w-0">
          <div className="t-primary text-body truncate">Voice note from Olha</div>
          <div className="t-tertiary text-meta">0:42 • 2 min ago</div>
        </div>
      </div>
    </div>
  ),
};
