import { useCallback, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { Spinner } from '../../shared/ui/Spinner';
import { SegmentedControl } from '../../shared/ui/SegmentedControl';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { EmptyState } from '../../shared/ui/EmptyState';
import { RevealButton } from '../../shared/ui/RevealButton';
import { useToast } from '../../shared/ui/Toast';
import {
  cancelScan,
  scanLargeFiles,
  trashPath,
  type LargeFile,
  type ScanSummary,
} from './api';
import { pickFolder } from './pickFolder';
import { formatBytes } from './format';

type Threshold = '100' | '500' | '1000';
const THRESHOLDS: Record<Threshold, number> = {
  '100': 100 * 1024 * 1024,
  '500': 500 * 1024 * 1024,
  '1000': 1024 * 1024 * 1024,
};

const basename = (path: string): string => {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(idx + 1) : path;
};

const dirname = (path: string): string => {
  const idx = path.lastIndexOf('/');
  return idx > 0 ? path.slice(0, idx) : path;
};

const formatDate = (secs: number): string => {
  if (!secs) return '—';
  const d = new Date(secs * 1000);
  return d.toLocaleDateString();
};

export const LargeFilesPanel = () => {
  const [threshold, setThreshold] = useState<Threshold>('500');
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<ScanSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<LargeFile | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const { toast } = useToast();

  const runScan = useCallback(
    async (rootOverride?: string | null) => {
      setScanning(true);
      setError(null);
      try {
        const next = await scanLargeFiles(
          THRESHOLDS[threshold],
          rootOverride ?? root ?? undefined,
        );
        setResult(next);
      } catch (e) {
        setError(String(e));
      } finally {
        setScanning(false);
      }
    },
    [threshold, root],
  );

  const chooseFolder = useCallback(async () => {
    const picked = await pickFolder();
    if (!picked) return;
    setRoot(picked);
    runScan(picked);
  }, [runScan]);

  const stopScan = useCallback(async () => {
    try {
      await cancelScan('large_files');
    } catch {
      /* non-fatal */
    }
  }, []);

  const handleTrash = useCallback(
    async (file: LargeFile) => {
      setPending(null);
      try {
        await trashPath(file.path);
        setResult((prev) =>
          prev
            ? { ...prev, files: prev.files.filter((f) => f.path !== file.path) }
            : prev,
        );
        toast({
          title: 'Переміщено в кошик',
          description: `Звільнено ${formatBytes(file.size_bytes)}`,
          variant: 'success',
        });
      } catch (e) {
        toast({
          title: 'Не вдалося видалити',
          description: String(e),
          variant: 'error',
        });
      }
    },
    [toast],
  );

  const totalFreed = result
    ? result.files.reduce((acc, f) => acc + f.size_bytes, 0)
    : 0;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header
        className="px-4 py-3 relative overflow-hidden"
        style={{
          background:
            'linear-gradient(135deg, rgba(255,216,107,0.12), rgba(255,145,77,0.18))',
          boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.06)',
        }}
      >
        <div
          aria-hidden
          className="absolute -top-10 -right-6 w-36 h-36 rounded-full"
          style={{
            background: 'radial-gradient(closest-side, rgba(255,145,77,0.35), transparent)',
            filter: 'blur(10px)',
          }}
        />
        <div className="relative flex items-center gap-4">
          <div
            aria-hidden
            className="w-14 h-14 rounded-2xl inline-flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg,#ffd86b,#ff914d)',
              boxShadow: '0 8px 24px -8px rgba(255,145,77,0.55), inset 0 0 0 1px rgba(255,255,255,0.2)',
            }}
          >
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
              <path d="M14 3v6h6M9 13h6M9 17h4" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="t-primary text-title font-semibold">Великі файли</div>
            <div className="t-tertiary text-meta truncate">
              {root ?? 'Домашня папка · пропускаються node_modules, кеші, контейнери'}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <SegmentedControl<Threshold>
              size="sm"
              value={threshold}
              onChange={setThreshold}
              ariaLabel="Мінімальний розмір файлу"
              options={[
                { value: '100', label: '≥100 MB' },
                { value: '500', label: '≥500 MB' },
                { value: '1000', label: '≥1 GB' },
              ]}
            />
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={chooseFolder}>
                {root ? 'Інша папка' : 'Обрати папку'}
              </Button>
              {scanning ? (
                <Button size="sm" variant="soft" tone="danger" onClick={stopScan}>
                  Зупинити
                </Button>
              ) : (
                <Button
                  variant="solid"
                  tone="accent"
                  size="sm"
                  onClick={() => runScan()}
                >
                  {result ? 'Повторити' : 'Сканувати'}
                </Button>
              )}
            </div>
          </div>
        </div>
      </header>

      {result && (
        <div className="px-4 py-1.5 border-b hair t-secondary text-meta flex items-center justify-between">
          <div>
            Знайдено <span className="t-primary font-medium">{result.files.length}</span> файлів на{' '}
            <span className="t-primary font-medium">{formatBytes(totalFreed)}</span>
          </div>
          <div className="t-tertiary">{result.scanned.toLocaleString()} переглянуто</div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {error && <div className="p-4 t-danger text-body">Помилка: {error}</div>}
        {!error && scanning && !result && (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <Spinner />
            <div className="t-tertiary text-meta">Сканування домашньої папки…</div>
          </div>
        )}
        {!error && !scanning && !result && (
          <EmptyState
            title="Готово до сканування"
            description="Оберіть поріг і натисніть «Сканувати». Нічого не видаляється автоматично — лише показується перелік."
          />
        )}
        {!error && result && result.files.length === 0 && (
          <EmptyState
            title="Великих файлів не знайдено"
            description="Вітаю — нічого не перевищує обраний поріг."
          />
        )}
        {!error && result && result.files.length > 0 && (
          <ul className="divide-y hair">
            {result.files.map((f) => (
              <li
                key={f.path}
                className="px-4 py-2 flex items-center gap-3 hover:bg-white/[0.03]"
              >
                <div
                  aria-hidden
                  className="shrink-0 w-8 h-8 rounded-lg inline-flex items-center justify-center"
                  style={{
                    background: 'linear-gradient(135deg, rgba(255,216,107,0.25), rgba(255,145,77,0.35))',
                    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.1)',
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ffb067" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                    <path d="M14 3v6h6" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="t-primary text-body font-medium truncate" title={f.path}>
                    {basename(f.path)}
                  </div>
                  <div className="t-tertiary text-meta truncate" title={f.path}>
                    {dirname(f.path)}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="t-primary tabular-nums font-medium">
                    {formatBytes(f.size_bytes)}
                  </div>
                  <div className="t-tertiary text-[11px]">{formatDate(f.modified_secs)}</div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <RevealButton path={f.path} />
                  <Button
                    size="sm"
                    variant="soft"
                    tone="danger"
                    onClick={() => setPending(f)}
                  >
                    У кошик
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={pending !== null}
        title="Перемістити у кошик?"
        description={
          pending
            ? `${basename(pending.path)} (${formatBytes(pending.size_bytes)})\n\nФайл можна буде відновити з кошика macOS.`
            : undefined
        }
        confirmLabel="У кошик"
        tone="danger"
        onConfirm={() => pending && handleTrash(pending)}
        onCancel={() => setPending(null)}
      />
    </div>
  );
};
