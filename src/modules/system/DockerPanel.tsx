import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { Spinner } from '../../shared/ui/Spinner';
import { EmptyState } from '../../shared/ui/EmptyState';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
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
        title: 'Docker очищено',
        description: `Звільнено ${formatBytes(res.reclaimed_bytes)}`,
        variant: 'success',
      });
      refresh();
    } catch (e) {
      toast({
        title: 'Не вдалося очистити',
        description: String(e),
        variant: 'error',
      });
    } finally {
      setBusy(false);
    }
  }, [refresh, toast]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header
        className="px-4 py-3 relative overflow-hidden"
        style={{
          background: 'linear-gradient(135deg, rgba(14,165,233,0.12), rgba(94,226,196,0.14))',
          boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.06)',
        }}
      >
        <div
          aria-hidden
          className="absolute -top-10 -right-6 w-40 h-40 rounded-full"
          style={{
            background: 'radial-gradient(closest-side, rgba(14,165,233,0.4), transparent)',
            filter: 'blur(10px)',
          }}
        />
        <div className="relative flex items-center gap-4">
          <div
            aria-hidden
            className="w-14 h-14 rounded-2xl inline-flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg,#0ea5e9,#5ee2c4)',
              boxShadow: '0 8px 24px -8px rgba(14,165,233,0.55), inset 0 0 0 1px rgba(255,255,255,0.2)',
            }}
          >
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="7" width="4" height="4" rx="0.5" />
              <rect x="8" y="7" width="4" height="4" rx="0.5" />
              <rect x="13" y="7" width="4" height="4" rx="0.5" />
              <rect x="8" y="3" width="4" height="4" rx="0.5" />
              <path d="M2 14h20c0 3-3 6-10 6-6 0-10-3-10-6z" />
            </svg>
          </div>
          <div className="flex-1">
            <div className="t-primary text-title font-semibold">Docker</div>
            <div className="t-tertiary text-meta">
              {status?.installed === false
                ? 'Docker не встановлено'
                : status?.running === false
                ? 'Демон не запущено — відкрийте Docker Desktop'
                : `Запущено ${status?.version ?? ''} · використовує ${formatBytes(totalSize)}`}
            </div>
          </div>
          {status?.running && (
            <div className="text-right">
              <div className="t-tertiary text-[10px] uppercase tracking-wider">
                Можна звільнити
              </div>
              <div className="t-primary text-title font-semibold tabular-nums">
                {formatBytes(reclaimable)}
              </div>
            </div>
          )}
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
        {error && <div className="t-danger">Помилка: {error}</div>}
        {!error && !status && (
          <div className="flex items-center justify-center py-6">
            <Spinner />
          </div>
        )}
        {!error && status && !status.installed && (
          <EmptyState
            title="Docker не знайдено"
            description="Встановіть Docker Desktop або Colima — ми шукаємо docker CLI у стандартних шляхах."
          />
        )}
        {!error && status?.installed && !status.running && (
          <EmptyState
            title="Docker не запущено"
            description="Запустіть Docker Desktop (або ваш runtime) щоб побачити розміри й почистити."
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
                    {it.total} · активних {it.active}
                  </div>
                  <div className="mt-2 h-1.5 rounded-full bg-white/5 overflow-hidden">
                    <div
                      className="h-full"
                      style={{
                        width: `${pctRecl}%`,
                        background: `linear-gradient(90deg, ${tint[0]}, ${tint[1]})`,
                      }}
                    />
                  </div>
                  <div className="t-tertiary text-[10px] mt-1 tabular-nums">
                    можна прибрати {formatBytes(it.reclaimable_bytes)}
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
              Оновити
            </Button>
            <Button
              size="sm"
              variant="solid"
              tone="danger"
              onClick={() => setConfirm(true)}
              loading={busy}
              disabled={reclaimable === 0}
            >
              Почистити невикористане
            </Button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirm}
        title="Очистити невикористане у Docker?"
        description={
          `Буде виконано \`docker system prune -af --volumes\` та \`docker builder prune -af\`:\n\n` +
          `• зупинені контейнери\n` +
          `• не використані образи (включаючи з тегами)\n` +
          `• не використані volumes\n` +
          `• build cache (BuildKit)\n\n` +
          `Приблизно звільниться ${formatBytes(reclaimable)}. Активні контейнери та їхні дані не чіпаються.`
        }
        confirmLabel="Очистити"
        tone="danger"
        onConfirm={prune}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
};
