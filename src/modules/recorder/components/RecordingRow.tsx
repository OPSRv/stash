import { useEffect, useRef, useState } from 'react';
import { AudioPlayer } from '../../../shared/ui/AudioPlayer';
import { IconButton } from '../../../shared/ui/IconButton';
import { Input } from '../../../shared/ui/Input';
import { FolderIcon, PencilIcon, StarIcon, TrashIcon } from '../../../shared/ui/icons';
import { shortDeviceLabel } from '../../../shared/util/deviceLabel';
import { recorderStreamUrl } from '../api';
import type { Recording } from '../recorder.constants';

type Props = {
  rec: Recording;
  /** Plays a one-shot entrance animation — set only on a freshly captured take. */
  justAdded?: boolean;
  onRename: (name: string) => void;
  onToggleFavorite: () => void;
  onReveal: () => void;
  onDelete: () => void;
};

const formatWhen = (epochMs: number): string => {
  const d = new Date(epochMs);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export const RecordingRow = ({
  rec,
  justAdded = false,
  onRename,
  onToggleFavorite,
  onReveal,
  onDelete,
}: Props) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(rec.name);
  const [url, setUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Resolve the loopback stream URL through the shared media server, then hand
  // the ready `http://` URL to AudioPlayer's `url` loader (asset:// can't
  // stream sizeable audio; the media server can).
  useEffect(() => {
    let alive = true;
    recorderStreamUrl(rec.file_path)
      .then((u) => {
        if (alive) setUrl(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [rec.file_path]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== rec.name) onRename(next);
    setEditing(false);
  };

  const cancel = () => {
    setDraft(rec.name);
    setEditing(false);
  };

  const row = (
    <div className="recorder-row-inner group relative flex flex-col gap-1.5 rounded-[8px] px-2 py-2 hover:bg-[var(--bg-hover)]">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          {editing ? (
            <Input
              ref={inputRef}
              size="sm"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  cancel();
                }
              }}
            />
          ) : (
            <>
              <div className="truncate text-body t-primary" title={rec.name}>
                {rec.name}
              </div>
              <div className="truncate text-meta t-tertiary">
                {formatWhen(rec.created_at)}
                {rec.device ? ` · ${shortDeviceLabel(rec.device)}` : ''}
              </div>
            </>
          )}
        </div>

        {/* Favorite stays visible — it conveys state, not just an action. */}
        <IconButton
          onClick={onToggleFavorite}
          title={rec.favorite ? 'Unfavorite' : 'Favorite'}
          active={rec.favorite}
        >
          <StarIcon size={14} filled={rec.favorite} />
        </IconButton>

        {!editing && (
          <div className="flex items-center">
            <IconButton onClick={() => setEditing(true)} title="Rename">
              <PencilIcon size={13} />
            </IconButton>
            <IconButton onClick={onReveal} title="Reveal in Finder">
              <FolderIcon size={14} />
            </IconButton>
            <IconButton onClick={onDelete} title="Delete" tone="danger">
              <TrashIcon size={13} />
            </IconButton>
          </div>
        )}
      </div>

      {url && (
        <AudioPlayer
          src={url}
          loader="url"
          display="waveform"
          durationHint={rec.duration_ms / 1000}
          abLoop
          className="!my-0"
        />
      )}
    </div>
  );

  // A freshly captured take expands its height (0fr → 1fr) while fading in, so
  // the rows below slide down smoothly instead of snapping to make room. The
  // wrapper grid is what makes the collapsible height animatable.
  return justAdded ? <div className="recorder-row-enter">{row}</div> : row;
};
