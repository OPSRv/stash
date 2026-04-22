import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { CloseIcon, LinkIcon } from '../../shared/ui/icons';
import { Button } from '../../shared/ui/Button';
import { IconButton } from '../../shared/ui/IconButton';
import { Spinner } from '../../shared/ui/Spinner';
import { useToast } from '../../shared/ui/Toast';

interface DownloadUrlBarProps {
  url: string;
  /** URL is non-empty but doesn't look like `http(s)://…`. Drives the
   *  red border + Detect-disabled state; the detect path itself still
   *  re-validates so programmatic entry points can't slip past. */
  invalid?: boolean;
  detecting: boolean;
  elapsedSec: number;
  onUrlChange: (next: string) => void;
  onDetect: () => void;
  onCancel: () => void;
  /** Wipe the URL input AND any queued detect cards. Only rendered when the
   *  user actually has something to clear, so the button doesn't take up
   *  space on an empty bar. */
  onClear?: () => void;
  canClear?: boolean;
}

export const DownloadUrlBar = ({
  url,
  invalid = false,
  detecting,
  elapsedSec,
  onUrlChange,
  onDetect,
  onCancel,
  onClear,
  canClear = false,
}: DownloadUrlBarProps) => {
  const { toast } = useToast();
  const pasteFromClipboard = async () => {
    try {
      const text = (await readText())?.trim();
      if (!text) {
        toast({
          title: 'Clipboard is empty',
          description: 'Copy a video URL first, then press Paste.',
          variant: 'default',
          durationMs: 1600,
        });
        return;
      }
      onUrlChange(text);
      onDetect();
    } catch (e) {
      console.error('paste failed', e);
      toast({
        title: 'Couldn\u2019t read clipboard',
        description: String(e),
        variant: 'error',
      });
    }
  };

  return (
    <div
      className={`flex items-center gap-2.5 px-3 py-2.5 border-b hair transition-colors ${
        invalid ? 'bg-[rgba(220,60,60,0.06)]' : ''
      }`}
    >
      <span
        className={`shrink-0 inline-flex ${invalid ? 'text-[rgb(220,80,80)]' : 't-tertiary'}`}
      >
        <LinkIcon />
      </span>
      <input
        type="url"
        value={url}
        onChange={(e) => onUrlChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onDetect();
        }}
        placeholder="Paste a YouTube / TikTok / Instagram / X / Reddit URL"
        maxLength={2048}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-invalid={invalid || undefined}
        // Tooltip mirrors the field so a long URL that's clipped visually
        // is still fully inspectable on hover.
        title={invalid ? 'Link must start with http:// or https://' : url || undefined}
        className={`flex-1 bg-transparent outline-none text-body min-w-0 ${
          invalid ? 'text-[rgb(220,80,80)]' : 't-primary'
        }`}
      />
      {canClear && onClear && (
        <IconButton
          onClick={onClear}
          title="Clear URL and dismiss all detect cards"
          stopPropagation={false}
        >
          <CloseIcon size={12} />
        </IconButton>
      )}
      <Button size="xs" onClick={pasteFromClipboard}>
        Paste
      </Button>
      {detecting ? (
        <Button
          size="xs"
          variant="ghost"
          tone="danger"
          onClick={onCancel}
          leadingIcon={<Spinner size={12} />}
          title="Cancel the latest detect"
        >
          Cancel · {elapsedSec}s
        </Button>
      ) : (
        <Button
          size="xs"
          variant="ghost"
          tone="accent"
          onClick={onDetect}
          disabled={!url.trim() || invalid}
          title={invalid ? 'Link must start with http:// or https://' : undefined}
        >
          Detect
        </Button>
      )}
    </div>
  );
};
