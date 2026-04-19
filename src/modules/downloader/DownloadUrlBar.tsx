import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { LinkIcon } from '../../shared/ui/icons';
import { Button } from '../../shared/ui/Button';
import { Input } from '../../shared/ui/Input';
import { Spinner } from '../../shared/ui/Spinner';

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
  const pasteFromClipboard = async () => {
    try {
      const text = await readText();
      if (text) {
        onUrlChange(text);
        onDetect();
      }
    } catch (e) {
      console.error('paste failed', e);
    }
  };

  return (
    <div className="px-4 py-3 flex items-center gap-2 border-b hair">
      <Input
        leadingIcon={<LinkIcon />}
        type="text"
        value={url}
        onChange={(e) => onUrlChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onDetect();
        }}
        placeholder="Paste a YouTube / TikTok / Instagram / X / Reddit URL"
        className="flex-1"
      />
      <Button onClick={pasteFromClipboard}>Paste</Button>
      {detecting ? (
        <Button
          variant="soft"
          tone="danger"
          onClick={onCancel}
          leadingIcon={<Spinner size={12} />}
          title="Cancel"
        >
          Cancel · {elapsedSec}s
        </Button>
      ) : (
        <Button
          variant="solid"
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
