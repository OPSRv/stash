import { Button } from '../../shared/ui/Button';
import { IconButton } from '../../shared/ui/IconButton';
import { CopyIcon, ExternalIcon } from '../../shared/ui/icons';
import { useToast } from '../../shared/ui/Toast';
import { revealFile } from '../../shared/util/revealFile';
import { formatDuration } from '../../shared/format/duration';
import { STEM_LABELS, type SeparatorJob } from './api';

type CompletedRowProps = {
  job: SeparatorJob;
  onRemove: (jobId: string) => void;
};

export function CompletedRow({ job, onRemove }: CompletedRowProps) {
  const { toast } = useToast();
  const stems = job.result?.stems ?? {};
  const stemEntries = Object.entries(stems);

  const failed = job.status === 'failed';
  const cancelled = job.status === 'cancelled';

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      toast({
        title: 'Шлях скопійовано',
        description: filename(path),
        variant: 'success',
      });
    } catch (e) {
      toast({
        title: 'Не вдалося скопіювати',
        description: String(e),
        variant: 'error',
      });
    }
  };

  return (
    <div
      data-testid={`done-${job.id}`}
      className={`rounded-md border border-white/10 p-3 ${
        failed ? 'opacity-80' : ''
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="t-primary text-body truncate">{filename(job.input_path)}</div>
          <div className="text-meta opacity-60 flex flex-wrap items-center gap-x-3 gap-y-0.5">
            {job.result?.bpm != null && <span>BPM {job.result.bpm.toFixed(1)}</span>}
            {job.result?.duration_sec != null && (
              <span>{formatDuration(job.result.duration_sec, { empty: '' })}</span>
            )}
            {job.result?.model && <span className="opacity-70">{job.result.model}</span>}
            {job.result?.device && (
              <span className="opacity-50">{job.result.device}</span>
            )}
            {failed && (
              <span className="text-red-300/80" data-testid="job-error">
                Помилка
              </span>
            )}
            {cancelled && <span>Скасовано</span>}
          </div>
        </div>
        {job.result?.stems_dir && (
          <Button
            size="sm"
            variant="soft"
            onClick={() => revealFile(job.result!.stems_dir!)}
          >
            Відкрити папку
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          tone="danger"
          shape="square"
          aria-label="Прибрати з історії"
          title="Прибрати з історії"
          onClick={() => onRemove(job.id)}
        >
          ×
        </Button>
      </div>
      {failed && job.error && (
        <div
          className="text-meta text-red-300/80 mt-2 truncate"
          title={job.error}
        >
          {job.error.split('\n')[0]}
        </div>
      )}
      {stemEntries.length > 0 && (
        <ul className="grid grid-cols-2 gap-2 mt-3 sm:grid-cols-3">
          {stemEntries.map(([name, path]) => (
            <li
              key={name}
              className="group relative rounded bg-white/[0.02] p-2"
              data-testid={`stem-${name}`}
            >
              <div className="text-meta">{STEM_LABELS[name] ?? name}</div>
              <div className="t-tertiary text-meta opacity-50 truncate font-mono">
                {filename(path)}
              </div>
              <div className="absolute right-1 top-1 flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                <IconButton title="Показати у Finder" onClick={() => revealFile(path)}>
                  <ExternalIcon size={12} />
                </IconButton>
                <IconButton title="Скопіювати шлях" onClick={() => copyPath(path)}>
                  <CopyIcon size={12} />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function filename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}
