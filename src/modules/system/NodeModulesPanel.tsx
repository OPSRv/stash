import { useCallback, useMemo, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { EmptyState } from '../../shared/ui/EmptyState';
import { ListItemRow } from '../../shared/ui/ListItemRow';
import { PanelHeader } from '../../shared/ui/PanelHeader';
import { RevealButton } from '../../shared/ui/RevealButton';
import { Spinner } from '../../shared/ui/Spinner';
import { useToast } from '../../shared/ui/Toast';
import { useSetSelection } from '../../shared/hooks/useSetSelection';
import { cancelScan, scanNodeModules, trashPath, type NodeModulesEntry } from './api';
import { pickFolder } from './pickFolder';
import { formatBytes } from './format';

const formatDate = (secs: number): string => {
  if (!secs) return '—';
  return new Date(secs * 1000).toLocaleDateString();
};

export const NodeModulesPanel = () => {
  const [root, setRoot] = useState<string | null>(null);
  const [entries, setEntries] = useState<NodeModulesEntry[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { selected, size: selectedSize, toggleOne, toggleAll, clear } =
    useSetSelection<string>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { toast } = useToast();

  const chooseFolder = useCallback(async () => {
    const picked = await pickFolder();
    if (!picked) return;
    setRoot(picked);
    setEntries(null);
    clear();
    setScanning(true);
    setError(null);
    try {
      const list = await scanNodeModules(picked);
      setEntries(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }, [clear]);

  const onToggleAll = useCallback(() => {
    if (!entries) return;
    toggleAll(entries.map((e) => e.path));
  }, [entries, toggleAll]);

  const totalAll = useMemo(
    () => (entries ?? []).reduce((acc, e) => acc + e.size_bytes, 0),
    [entries],
  );
  const totalSelected = useMemo(
    () =>
      (entries ?? [])
        .filter((e) => selected.has(e.path))
        .reduce((acc, e) => acc + e.size_bytes, 0),
    [entries, selected],
  );

  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const bulkDelete = useCallback(async () => {
    if (!entries) return;
    setConfirmOpen(false);
    const targets = entries.filter((e) => selected.has(e.path));
    let freed = 0;
    let failed = 0;
    setProgress({ done: 0, total: targets.length });
    for (let i = 0; i < targets.length; i += 1) {
      const t = targets[i];
      try {
        await trashPath(t.path);
        freed += t.size_bytes;
      } catch {
        failed += 1;
      }
      setProgress({ done: i + 1, total: targets.length });
    }
    setProgress(null);
    if (failed === 0) {
      toast({
        title: `Видалено ${targets.length} node_modules`,
        description: `Звільнено ${formatBytes(freed)}`,
        variant: 'success',
      });
    } else {
      toast({
        title: `Частково видалено (${failed} помилок)`,
        description: `Звільнено ${formatBytes(freed)}`,
        variant: 'error',
      });
    }
    // Re-scan to reflect the filesystem state.
    if (root) {
      setScanning(true);
      try {
        setEntries(await scanNodeModules(root));
        clear();
      } finally {
        setScanning(false);
      }
    }
  }, [entries, selected, root, toast, clear]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <PanelHeader
        gradient={['#5ee2c4', '#17b26a']}
        icon={
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 7l9-4 9 4v10l-9 4-9-4z" />
            <path d="M3 7l9 4 9-4M12 11v10" />
          </svg>
        }
        title="node_modules"
        description={root ?? 'Оберіть папку — знайдемо всі node_modules рекурсивно'}
        trailing={
          <>
            {entries && (
              <div className="t-primary font-semibold text-title tabular-nums">
                {formatBytes(totalAll)}
              </div>
            )}
            <div className="flex items-center gap-1">
              {scanning && (
                <Button
                  size="sm"
                  variant="soft"
                  tone="danger"
                  onClick={() => cancelScan('node_modules').catch(() => undefined)}
                >
                  Зупинити
                </Button>
              )}
              <Button
                size="sm"
                variant="solid"
                tone="accent"
                onClick={chooseFolder}
                loading={scanning}
              >
                {root ? 'Інша папка' : 'Обрати папку'}
              </Button>
            </div>
          </>
        }
      />

      {entries && entries.length > 0 && (
        <div className="px-4 py-1.5 border-b hair flex items-center justify-between t-secondary text-meta">
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={selectedSize === entries.length}
              onChange={onToggleAll}
              className="ring-focus"
            />
            Обрати все ({entries.length})
          </label>
          <div className="flex items-center gap-3">
            <span>
              Обрано <span className="t-primary font-medium">{formatBytes(totalSelected)}</span>
            </span>
            {progress ? (
              <span className="t-tertiary text-meta tabular-nums">
                {progress.done} з {progress.total}…
              </span>
            ) : (
              <Button
                size="sm"
                variant="soft"
                tone="danger"
                disabled={selectedSize === 0}
                onClick={() => setConfirmOpen(true)}
              >
                У кошик
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {error && <div className="p-4 t-danger text-body">Помилка: {error}</div>}
        {!error && scanning && (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <Spinner />
            <div className="t-tertiary text-meta">Скануємо {root}…</div>
          </div>
        )}
        {!error && !scanning && !entries && (
          <EmptyState
            title="Готово до сканування"
            description="Натисніть «Обрати папку». Скануємо лише верхні node_modules — не спускаємось у вкладені."
          />
        )}
        {!error && entries && entries.length === 0 && (
          <EmptyState title="Жодного node_modules не знайдено" />
        )}
        {!error && entries && entries.length > 0 && (
          <ul className="divide-y hair">
            {entries.map((e) => {
              const checked = selected.has(e.path);
              return (
                <ListItemRow
                  key={e.path}
                  selected={checked}
                  onClick={() => toggleOne(e.path)}
                  leading={
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleOne(e.path)}
                      onClick={(ev) => ev.stopPropagation()}
                      className="ring-focus"
                    />
                  }
                  title={
                    <span title={e.path}>
                      {e.project.split('/').slice(-2).join('/')}
                    </span>
                  }
                  meta={<span title={e.path}>{e.project}</span>}
                  trailing={
                    <>
                      <div className="text-right shrink-0">
                        <div className="t-primary tabular-nums font-medium">
                          {formatBytes(e.size_bytes)}
                        </div>
                        <div className="t-tertiary text-[11px]">{formatDate(e.last_modified)}</div>
                      </div>
                      <RevealButton path={e.path} stopPropagation />
                    </>
                  }
                />
              );
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Перемістити обрані node_modules у кошик?"
        description={`Буде переміщено ${selectedSize} node_modules (${formatBytes(totalSelected)}). Виконайте npm install / pnpm install щоб відновити.`}
        confirmLabel="У кошик"
        tone="danger"
        onConfirm={bulkDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
};
