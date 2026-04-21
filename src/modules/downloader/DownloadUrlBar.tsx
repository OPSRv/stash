import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { LinkIcon } from '../../shared/ui/icons';
import { Button } from '../../shared/ui/Button';
import { Spinner } from '../../shared/ui/Spinner';
import { useToast } from '../../shared/ui/Toast';

interface DownloadUrlBarProps {
  url: string;
  detecting: boolean;
  elapsedSec: number;
  onUrlChange: (next: string) => void;
  onDetect: () => void;
  onCancel: () => void;
}

export const DownloadUrlBar = ({
  url,
  detecting,
  elapsedSec,
  onUrlChange,
  onDetect,
  onCancel,
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
    <div className="flex items-center gap-2.5 px-3 py-2.5 border-b hair">
      <span className="t-tertiary shrink-0 inline-flex">
        <LinkIcon />
      </span>
      <input
        type="text"
        value={url}
        onChange={(e) => onUrlChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onDetect();
        }}
        placeholder="Paste a YouTube / TikTok / Instagram / X / Reddit URL"
        // Tooltip mirrors the field so a long URL that's clipped visually
        // is still fully inspectable on hover.
        title={url || undefined}
        className="flex-1 bg-transparent outline-none text-body t-primary min-w-0"
      />
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
          title="Cancel"
        >
          Cancel · {elapsedSec}s
        </Button>
      ) : (
        <Button
          size="xs"
          variant="ghost"
          tone="accent"
          onClick={onDetect}
          disabled={!url.trim()}
        >
          Detect
        </Button>
      )}
    </div>
  );
};
