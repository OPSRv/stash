import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { PanelHeader } from '../../shared/ui/PanelHeader';
import { Spinner } from '../../shared/ui/Spinner';
import { useToast } from '../../shared/ui/Toast';
import {
  deleteTmSnapshot,
  deleteUnavailableSimulators,
  dockerPrune,
  dockerStatus,
  emptyTrash,
  listCaches,
  listIosBackups,
  listScreenshots,
  listTmSnapshots,
  listXcodeSimulators,
  trashPath,
} from './api';
import { formatBytes } from './format';

type Bucket = {
  id: string;
  label: string;
  description: string;
  gradient: [string, string];
  size: number;
  runClean: () => Promise<number /* freed */>;
  enabled: boolean;
  selected: boolean;
};

const SCREENSHOTS_OLDER_THAN_DAYS = 30;

export const SmartScanPanel = () => {
  const [buckets, setBuckets] = useState<Bucket[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const { toast } = useToast();

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const [caches, screenshots, tmSnaps, sims, docker] = await Promise.all([
        listCaches().catch(() => []),
        listScreenshots().catch(() => []),
        listTmSnapshots().catch(() => []),
        listXcodeSimulators().catch(() => []),
        dockerStatus().catch(() => null),
      ]);

      // Old screenshots only (>30d) — don't nuke yesterday's screenshot.
      const cutoff = Math.floor(Date.now() / 1000) - SCREENSHOTS_OLDER_THAN_DAYS * 86400;
      const oldShots = screenshots.filter((s) => s.created_secs && s.created_secs < cutoff);
      const unavailableSims = sims.filter((s) => !s.available);

      const cachesTotal = caches.reduce((a, c) => a + c.size_bytes, 0);
      const shotsTotal = oldShots.reduce((a, s) => a + s.size_bytes, 0);
      const simsTotal = unavailableSims.reduce((a, s) => a + s.size_bytes, 0);
      const dockerReclaimable =
        docker?.running
          ? docker.items.reduce((a, i) => a + i.reclaimable_bytes, 0)
          : 0;
      // iOS backups — surface but DON'T auto-clean (each backup is 10–50 GB
      // and personal; we show the number but the user clicks the dedicated
      // panel to inspect/delete).
      const iosTotal = await listIosBackups()
        .then((xs) => xs.reduce((a, i) => a + i.size_bytes, 0))
        .catch(() => 0);

      const next: Bucket[] = [
        {
          id: 'caches',
          label: 'Кеші',
          description: `${caches.length} categories: Xcode, npm, pnpm, Yarn, browsers…`,
          gradient: ['#5ee2c4', '#2aa3ff'],
          size: cachesTotal,
          enabled: cachesTotal > 0,
          selected: cachesTotal > 0,
          runClean: async () => {
            let freed = 0;
            for (const c of caches) {
              try {
                await trashPath(c.path);
                freed += c.size_bytes;
              } catch {
                /* skip */
              }
            }
            return freed;
          },
        },
        {
          id: 'screenshots',
          label: `Скріншоти старше ${SCREENSHOTS_OLDER_THAN_DAYS} днів`,
          description: `${oldShots.length} файлів на Desktop`,
          gradient: ['#ffd86b', '#ff914d'],
          size: shotsTotal,
          enabled: shotsTotal > 0,
          selected: shotsTotal > 0,
          runClean: async () => {
            let freed = 0;
            for (const s of oldShots) {
              try {
                await trashPath(s.path);
                freed += s.size_bytes;
              } catch {
                /* skip */
              }
            }
            return freed;
          },
        },
        {
          id: 'tm',
          label: 'Локальні Time Machine snapshots',
          description: `${tmSnaps.length} знімків займають місце на SSD`,
          gradient: ['#d08cff', '#7a4bff'],
          size: 0, // tmutil не віддає розмір; буде визначено по факту
          enabled: tmSnaps.length > 0,
          selected: tmSnaps.length > 0,
          runClean: async () => {
            for (const s of tmSnaps) {
              try {
                await deleteTmSnapshot(s.name);
              } catch {
                /* skip */
              }
            }
            return 0;
          },
        },
        {
          id: 'sims',
          label: 'Недоступні Xcode симулятори',
          description: `${unavailableSims.length} симуляторів без SDK`,
          gradient: ['#8ec5ff', '#5561ff'],
          size: simsTotal,
          enabled: unavailableSims.length > 0,
          selected: unavailableSims.length > 0,
          runClean: async () => {
            try {
              await deleteUnavailableSimulators();
              return simsTotal;
            } catch {
              return 0;
            }
          },
        },
        {
          id: 'trash',
          label: 'Очистити кошики',
          description: 'Усі томи · незворотно',
          gradient: ['#ff8a5b', '#ff3a6f'],
          size: 0, // не знаємо заздалегідь (Finder рахує на запит)
          enabled: true,
          selected: false,
          runClean: async () => {
            try {
              await emptyTrash();
              return 0;
            } catch {
              return 0;
            }
          },
        },
      ];
      if (docker?.running && dockerReclaimable > 0) {
        next.push({
          id: 'docker',
          label: 'Docker невикористане',
          description: 'Образи, контейнери, volumes, build cache',
          gradient: ['#0ea5e9', '#5ee2c4'],
          size: dockerReclaimable,
          enabled: true,
          selected: true,
          runClean: async () => {
            try {
              const r = await dockerPrune();
              return r.reclaimed_bytes;
            } catch {
              return 0;
            }
          },
        });
      }
      if (iosTotal > 0) {
        next.push({
          id: 'ios-note',
          label: `iOS бекапи: ${formatBytes(iosTotal)}`,
          description: 'Відкрий вкладку «Важке на диску» щоб видалити вибіркові',
          gradient: ['#6b7280', '#374151'],
          size: 0,
          enabled: false,
          selected: false,
          runClean: async () => 0,
        });
      }
      setBuckets(next);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    scan();
  }, [scan]);

  const toggle = (id: string) =>
    setBuckets((prev) =>
      prev ? prev.map((b) => (b.id === id ? { ...b, selected: !b.selected } : b)) : prev,
    );

  const totalSelected = useMemo(
    () => (buckets ?? []).filter((b) => b.selected).reduce((a, b) => a + b.size, 0),
    [buckets],
  );
  const selectedCount = (buckets ?? []).filter((b) => b.selected).length;

  const cleanAll = useCallback(async () => {
    if (!buckets) return;
    const targets = buckets.filter((b) => b.selected && b.enabled);
    setCleaning(true);
    setProgress({ done: 0, total: targets.length });
    let freed = 0;
    for (let i = 0; i < targets.length; i += 1) {
      try {
        freed += await targets[i].runClean();
      } catch {
        /* skip */
      }
      setProgress({ done: i + 1, total: targets.length });
    }
    setProgress(null);
    setCleaning(false);
    toast({
      title: `Очищено ${targets.length} категорій`,
      description: `Звільнено приблизно ${formatBytes(freed)}`,
      variant: 'success',
    });
    scan();
  }, [buckets, scan, toast]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <PanelHeader
        gradient={['#ffd86b', '#ff3a6f']}
        icon={
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
          </svg>
        }
        title="Розумне прибирання"
        description="Один клік — перевіряємо все що можна почистити й trash-ємо разом."
        trailing={
          <div className="text-right">
            <div className="t-tertiary text-[10px] uppercase tracking-wider">
              Обрано
            </div>
            <div className="t-primary text-title font-semibold tabular-nums">
              {formatBytes(totalSelected)}
            </div>
            <div className="t-tertiary text-meta">{selectedCount} категорій</div>
          </div>
        }
      />

      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-2">
        {scanning && !buckets && (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <Spinner />
            <div className="t-tertiary text-meta">
              Сканую весь сміттєвий хвіст macOS…
            </div>
          </div>
        )}
        {buckets && buckets.map((b) => (
          <button
            key={b.id}
            type="button"
            disabled={!b.enabled}
            onClick={() => toggle(b.id)}
            className={`w-full text-left rounded-2xl p-3 flex items-center gap-3 transition-all ${
              b.selected
                ? 'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]'
                : 'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]'
            } ${b.enabled ? 'hover:brightness-110' : 'opacity-60 cursor-default'}`}
            style={{
              background: b.selected
                ? `linear-gradient(135deg, ${b.gradient[0]}26, ${b.gradient[1]}3a)`
                : `linear-gradient(135deg, ${b.gradient[0]}10, ${b.gradient[1]}18)`,
            }}
          >
            <input
              type="checkbox"
              checked={b.selected}
              onChange={() => toggle(b.id)}
              onClick={(e) => e.stopPropagation()}
              disabled={!b.enabled}
              className="ring-focus shrink-0"
            />
            <div
              aria-hidden
              className="w-10 h-10 rounded-xl shrink-0 inline-flex items-center justify-center"
              style={{
                background: `linear-gradient(135deg, ${b.gradient[0]}, ${b.gradient[1]})`,
                boxShadow: `0 6px 18px -6px ${b.gradient[1]}, inset 0 0 0 1px rgba(255,255,255,0.2)`,
              }}
            />
            <div className="min-w-0 flex-1">
              <div className="t-primary text-body font-semibold">{b.label}</div>
              <div className="t-tertiary text-meta truncate">{b.description}</div>
            </div>
            {b.size > 0 && (
              <div className="t-primary tabular-nums font-semibold">
                {formatBytes(b.size)}
              </div>
            )}
          </button>
        ))}
      </div>

      <div className="px-4 py-3 border-t hair flex items-center justify-between">
        <Button size="sm" variant="ghost" onClick={scan} disabled={scanning || cleaning}>
          Пересканувати
        </Button>
        {progress ? (
          <span className="t-tertiary text-meta tabular-nums">
            Очищаю {progress.done} з {progress.total}…
          </span>
        ) : (
          <Button
            size="md"
            variant="solid"
            tone="accent"
            disabled={selectedCount === 0 || cleaning}
            loading={cleaning}
            onClick={cleanAll}
          >
            Почистити обране
          </Button>
        )}
      </div>
    </div>
  );
};
