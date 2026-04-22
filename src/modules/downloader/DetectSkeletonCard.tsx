import { Card } from '../../shared/ui/Card';
import { IconButton } from '../../shared/ui/IconButton';
import { Spinner } from '../../shared/ui/Spinner';
import { CloseIcon } from '../../shared/ui/icons';

interface Props {
  /** Seconds since detect started. Used to escalate the secondary label. */
  elapsedSec: number;
  /** Optional dismiss action. When provided, renders a ✕ in the top-right so
   *  the user can abort a runaway detect without waiting it out. */
  onDismiss?: () => void;
}

const stageFor = (sec: number): string => {
  if (sec < 4) return 'Fetching preview…';
  if (sec < 12) return 'Resolving formats…';
  if (sec < 25) return 'This platform is slow today — still working…';
  return 'Almost there — cold fetches can take up to 40s';
};

/// Placeholder card shown between detect-start and the first signal (oEmbed
/// quick-preview or full detect). Gives the user a concrete "something is
/// happening and here's what" signal instead of a bare spinner in the URL bar.
export const DetectSkeletonCard = ({ elapsedSec, onDismiss }: Props) => (
  <Card
    padding="md"
    rounded="xl"
    className="mx-4 mt-3 flex items-center gap-3 stash-fade-in"
  >
    <div
      className="w-27.5 h-15.5 rounded-md shrink-0 bg-white/[0.05]"
      aria-hidden
    />
    <div className="flex-1 min-w-0">
      <div
        className="h-3 rounded mb-2 bg-white/[0.08] w-2/5"
        aria-hidden
      />
      <div
        className="h-3 rounded bg-white/[0.06] w-3/4"
        aria-hidden
      />
      <div className="t-tertiary text-meta mt-2 flex items-center gap-1.5">
        <Spinner size={10} />
        <span>
          {stageFor(elapsedSec)}
          {elapsedSec >= 4 ? ` · ${elapsedSec}s` : ''}
        </span>
      </div>
    </div>
    {onDismiss && (
      <div className="shrink-0">
        <IconButton
          onClick={onDismiss}
          title="Dismiss"
          tone="danger"
          stopPropagation={false}
        >
          <CloseIcon size={12} />
        </IconButton>
      </div>
    )}
  </Card>
);
