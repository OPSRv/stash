import { accent } from '../../shared/theme/accent';
import { Button } from '../../shared/ui/Button';
import { IconButton } from '../../shared/ui/IconButton';
import { CloseIcon } from '../../shared/ui/icons';
import { copyText } from '../../shared/util/clipboard';

interface TranslationBannerProps {
  original: string;
  translated: string;
  to: string;
  onDismiss: () => void;
}

const bannerStyle = {
  background: accent(0.08),
  border: `1px solid ${accent(0.25)}`,
} as const;

const pillStyle = {
  background: accent(0.22),
} as const;

export const TranslationBanner = ({
  original,
  translated,
  to,
  onDismiss,
}: TranslationBannerProps) => {
  const copyTranslation = () => {
    void copyText(translated);
  };

  return (
    <div
      className="p-2.5 rounded-lg flex items-start gap-2"
      style={bannerStyle}
    >
      <span
        className="px-1.5 py-0.5 rounded tracking-wider t-primary shrink-0 uppercase"
        style={{ ...pillStyle, font: 'var(--t-label)' }}
      >
        → {to}
      </span>
      <div className="flex-1 min-w-0">
        <div className="t-primary text-body leading-snug break-words">
          {translated}
        </div>
        <div className="t-tertiary text-meta truncate mt-0.5">{original}</div>
      </div>
      <Button
        size="xs"
        variant="ghost"
        onClick={copyTranslation}
        title="Copy translation to clipboard"
      >
        Copy
      </Button>
      <IconButton onClick={onDismiss} title="Dismiss">
        <CloseIcon size={12} />
      </IconButton>
    </div>
  );
};
