import { Badge, type BadgeTone } from '../../shared/ui/Badge';

const KIND_META: Record<string, { label: string; tone: BadgeTone }> = {
  text: { label: 'Text', tone: 'neutral' },
  voice: { label: 'Voice', tone: 'accent' },
  photo: { label: 'Photo', tone: 'accent' },
  video: { label: 'Video', tone: 'warning' },
  video_note: { label: 'Video note', tone: 'danger' },
  document: { label: 'Doc', tone: 'success' },
  sticker: { label: 'Sticker', tone: 'warning' },
};

export const TELEGRAM_KINDS = Object.keys(KIND_META);

type Props = { kind: string };

export const TelegramKindBadge = ({ kind }: Props) => {
  const meta = KIND_META[kind] ?? { label: kind, tone: 'neutral' as const };
  return (
    <Badge tone={meta.tone} className="uppercase tracking-wider">
      {meta.label}
    </Badge>
  );
};
