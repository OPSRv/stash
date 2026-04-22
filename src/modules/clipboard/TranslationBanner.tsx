import { accent } from '../../shared/theme/accent';
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
        className="px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wider t-primary shrink-0 uppercase"
        style={pillStyle}
      >
        → {to}
      </span>
      <div className="flex-1 min-w-0">
        <div className="t-primary text-body leading-snug break-words">
          {translated}
        </div>
        <div className="t-tertiary text-meta truncate mt-0.5">{original}</div>
      </div>
      <button
        onClick={copyTranslation}
        className="t-secondary hover:t-primary text-meta px-2 py-0.5 rounded shrink-0"
        style={{ background: 'rgba(255,255,255,0.04)' }}
        title="Copy translation to clipboard"
      >
        Copy
      </button>
      <button
        onClick={onDismiss}
        className="t-tertiary hover:t-primary p-1 shrink-0"
        aria-label="Dismiss"
      >
        <CloseIcon size={12} />
      </button>
    </div>
  );
};
