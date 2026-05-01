import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { CenterSpinner } from '../../shared/ui/CenterSpinner';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { EmptyState } from '../../shared/ui/EmptyState';
import { PanelHeader } from '../../shared/ui/PanelHeader';
import { useToast } from '../../shared/ui/Toast';
import { dockerPrune, dockerStatus, type DockerStatus } from './api';
import { formatBytes } from './format';

const KIND_TINT: Record<string, [string, string]> = {
  Images: ['#8ec5ff', '#5561ff'],
  Containers: ['#ffd86b', '#ff914d'],
  'Local Volumes': ['#5ee2c4', '#2aa3ff'],
  'Build Cache': ['#d08cff', '#7a4bff'],
};

export const DockerPanel = () => {
  const [status, setStatus] = useState<DockerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    try {
      setStatus(await dockerStatus());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const reclaimable = useMemo(
    () => status?.items.reduce((a, i) => a + i.reclaimable_bytes, 0) ?? 0,
    [status],
  );
  const totalSize = useMemo(
    () => status?.items.reduce((a, i) => a + i.size_bytes, 0) ?? 0,
    [status],
  );

  const prune = useCallback(async () => {
    setConfirm(false);
    setBusy(true);
    try {
      const res = await dockerPrune();
      toast({
        title: 'Docker cleaned',
        description: `Freed ${formatBytes(res.reclaimed_bytes)}`,
        variant: 'success',
      });
      refresh();
    } catch (e) {
      toast({
        title: 'Failed to clean',
        description: String(e),
        variant: 'error',
      });
    } finally {
      setBusy(false);
    }
  }, [refresh, toast]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <PanelHeader
        gradient={['#0ea5e9', '#5ee2c4']}
        icon={
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="7" width="4" height="4" rx="0.5" />
            <rect x="8" y="7" width="4" height="4" rx="0.5" />
            <rect x="13" y="7" width="4" height="4" rx="0.5" />
            <rect x="8" y="3" width="4" height="4" rx="0.5" />
            <path d="M2 14h20c0 3-3 6-10 6-6 0-10-3-10-6z" />
          </svg>
        }
        title="Docker"
        description={
          status?.installed === false
            ? 'Docker not installed'
            : status?.running === false
            ? 'Daemon not running — open Docker Desktop'
            : `Running ${status?.version ?? ''} · using ${formatBytes(totalSize)}`
        }
        trailing={
          status?.running ? (
            <div className="text-right">
              <div className="t-tertiary text-[10px] uppercase tracking-wider">
                Reclaimable
              </div>
              <div className="t-primary text-title font-semibold tabular-nums">
                {formatBytes(reclaimable)}
              </div>
            </div>
          ) : undefined
        }
      />

      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
        {error && <div className="t-danger">Error: {error}</div>}
        {!error && !status && <CenterSpinner fit="inline" />}
        {!error && status && !status.installed && (
          <EmptyState
            title="Docker not found"
            description="Install Docker Desktop or Colima — we look for the docker CLI in standard paths."
          />
        )}
        {!error && status?.installed && !status.running && (
          <EmptyState
            title="Docker not running"
            description="Start Docker Desktop (or your runtime) to see sizes and clean up."
          />
        )}
        {!error && status?.running && status.items.length > 0 && (
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}
          >
            {status.items.map((it) => {
              const tint = KIND_TINT[it.kind] ?? ['#8ec5ff', '#5561ff'];
              const pctRecl = it.size_bytes
                ? Math.round((it.reclaimable_bytes / it.size_bytes) * 100)
                : 0;
              return (
                <div
                  key={it.kind}
                  className="rounded-2xl p-3 relative overflow-hidden"
                  style={{
                    background: `linear-gradient(135deg, ${tint[0]}1e, ${tint[1]}30)`,
                    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.07)',
                  }}
                >
                  <div className="t-tertiary text-[10px] uppercase tracking-wider">
                    {it.kind}
                  </div>
                  <div className="t-primary text-title font-semibold tabular-nums mt-1">
                    {formatBytes(it.size_bytes)}
                  </div>
                  <div className="t-tertiary text-meta tabular-nums">
                    {it.total} · active {it.active}
                  </div>
                  <div className="mt-2 h-1.5 rounded-full [background:var(--bg-hover)] overflow-hidden">
                    <div
                      className="h-full"
                      style={{
                        width: `${pctRecl}%`,
                        background: `linear-gradient(90deg, ${tint[0]}, ${tint[1]})`,
                      }}
                    />
                  </div>
                  <div className="t-tertiary text-[10px] mt-1 tabular-nums">
                    reclaimable {formatBytes(it.reclaimable_bytes)}
                    {pctRecl > 0 && ` · ${pctRecl}%`}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {status?.running && (
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button size="sm" variant="ghost" onClick={refresh} disabled={busy}>
              Refresh
            </Button>
            <Button
              size="sm"
              variant="solid"
              tone="danger"
              onClick={() => setConfirm(true)}
              loading={busy}
              disabled={reclaimable === 0}
            >
              Clean unused
            </Button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirm}
        title="Clean unused Docker data?"
        description={
          `Runs \`docker system prune -af --volumes\` and \`docker builder prune -af\`:\n\n` +
          `• stopped containers\n` +
          `• unused images (including tagged)\n` +
          `• unused volumes\n` +
          `• build cache (BuildKit)\n\n` +
          `Approximately ${formatBytes(reclaimable)} will be freed. Running containers and their data are not touched.`
        }
        confirmLabel="Clean"
        tone="danger"
        onConfirm={prune}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
};
