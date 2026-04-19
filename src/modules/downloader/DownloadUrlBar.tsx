import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { LinkIcon } from '../../shared/ui/icons';
import { Spinner } from '../../shared/ui/Spinner';

interface DownloadUrlBarProps {
  url: string;
  detecting: boolean;
  elapsedSec: number;
  onUrlChange: (next: string) => void;
  onDetect: () => void;
  onCancel: () => void;
}

const pasteButtonStyle = {
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.06)',
} as const;

const primaryButtonStyle = { background: 'rgba(255,255,255,0.06)' } as const;

const cancelButtonStyle = {
  background: 'rgba(235,72,72,0.15)',
  color: '#FF7878',
} as const;

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
      <div className="input-field rounded-lg flex-1 flex items-center gap-2 px-3 py-2">
        <LinkIcon className="t-tertiary" />
        <input
          type="text"
          value={url}
          onChange={(e) => onUrlChange(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onDetect();
          }}
          placeholder="Paste a YouTube / TikTok / Instagram / X / Reddit URL"
          className="flex-1 bg-transparent outline-none text-body t-primary"
        />
      </div>
      <button
        onClick={pasteFromClipboard}
        className="px-3 py-2 rounded-lg t-secondary text-body flex items-center gap-1.5"
        style={pasteButtonStyle}
      >
        Paste
      </button>
      {detecting ? (
        <button
          onClick={onCancel}
          className="px-3 py-2 rounded-lg t-primary text-body flex items-center gap-1.5"
          style={cancelButtonStyle}
          title="Cancel"
        >
          <Spinner />
          <span>Cancel · {elapsedSec}s</span>
        </button>
      ) : (
        <button
          onClick={onDetect}
          disabled={!url.trim()}
          className="px-3 py-2 rounded-lg t-primary text-body"
          style={primaryButtonStyle}
        >
          Detect
        </button>
      )}
    </div>
  );
};
