import { Badge } from '../../shared/ui/Badge';

/** `hue` is the suffix of the `--kind-<hue>-rgb|fg` tokens in tokens.css;
 *  kinds without one (text, unknown) use the neutral tone. */
const KIND_META: Record<string, { label: string; hue?: string }> = {
  text: { label: 'Text' },
  voice: { label: 'Voice', hue: 'voice' },
  audio: { label: 'Audio', hue: 'audio' },
  photo: { label: 'Photo', hue: 'photo' },
  video: { label: 'Video', hue: 'video' },
  video_note: { label: 'Video note', hue: 'video-note' },
  document: { label: 'Doc', hue: 'document' },
  sticker: { label: 'Sticker', hue: 'sticker' },
};

export const TELEGRAM_KINDS = Object.keys(KIND_META);

type Props = { kind: string };

export const TelegramKindBadge = ({ kind }: Props) => {
  const meta = KIND_META[kind] ?? { label: kind };
  const { hue } = meta;
  return (
    <Badge
      tone="neutral"
      className="uppercase tracking-wider"
      color={hue ? `var(--kind-${hue}-fg)` : undefined}
      bg={hue ? `rgba(var(--kind-${hue}-rgb), 0.16)` : undefined}
    >
      {meta.label}
    </Badge>
  );
};
