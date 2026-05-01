import { useCallback, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { EmptyState } from '../../shared/ui/EmptyState';
import { ListItemRow } from '../../shared/ui/ListItemRow';
import { PanelHeader } from '../../shared/ui/PanelHeader';
import { RevealButton } from '../../shared/ui/RevealButton';
import { SegmentedControl } from '../../shared/ui/SegmentedControl';
import { Spinner } from '../../shared/ui/Spinner';
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
          title: 'Moved to trash',
          description: `Freed ${formatBytes(file.size_bytes)}`,
          variant: 'success',
        });
      } catch (e) {
        toast({
          title: 'Failed to delete',
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
      <PanelHeader
        gradient={['#ffd86b', '#ff914d']}
        icon={
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
            <path d="M14 3v6h6M9 13h6M9 17h4" />
          </svg>
        }
        title="Large files"
        description={root ?? 'Home folder · skips node_modules, caches, containers'}
        trailing={
          <>
            <SegmentedControl<Threshold>
              size="sm"
              value={threshold}
              onChange={setThreshold}
              ariaLabel="Minimum file size"
              options={[
                { value: '100', label: '≥100 MB' },
                { value: '500', label: '≥500 MB' },
                { value: '1000', label: '≥1 GB' },
              ]}
            />
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={chooseFolder}>
                {root ? 'Change folder' : 'Choose folder'}
              </Button>
              {scanning ? (
                <Button size="sm" variant="soft" tone="danger" onClick={stopScan}>
                  Stop
                </Button>
              ) : (
                <Button
                  variant="solid"
                  tone="accent"
                  size="sm"
                  onClick={() => runScan()}
                >
                  {result ? 'Rescan' : 'Scan'}
                </Button>
              )}
            </div>
          </>
        }
      />

      {result && (
        <div className="px-4 py-1.5 border-b hair t-secondary text-meta flex items-center justify-between">
          <div>
            Found <span className="t-primary font-medium">{result.files.length}</span> files totalling{' '}
            <span className="t-primary font-medium">{formatBytes(totalFreed)}</span>
          </div>
          <div className="t-tertiary">{result.scanned.toLocaleString()} scanned</div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {error && <div className="p-4 t-danger text-body">Error: {error}</div>}
        {!error && scanning && !result && (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <Spinner />
            <div className="t-tertiary text-meta">Scanning home folder…</div>
          </div>
        )}
        {!error && !scanning && !result && (
          <EmptyState
            title="Ready to scan"
            description="Choose a threshold and click Scan. Nothing is deleted automatically — only the list is shown."
          />
        )}
        {!error && result && result.files.length === 0 && (
          <EmptyState
            title="No large files found"
            description="Nothing exceeds the selected threshold."
          />
        )}
        {!error && result && result.files.length > 0 && (
          <ul className="divide-y hair">
            {result.files.map((f) => (
              <ListItemRow
                key={f.path}
                className="hover:[background:var(--bg-hover)]"
                leading={
                  <div
                    aria-hidden
                    className="w-8 h-8 rounded-lg inline-flex items-center justify-center"
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
                }
                title={<span title={f.path}>{basename(f.path)}</span>}
                meta={<span title={f.path}>{dirname(f.path)}</span>}
                trailing={
                  <>
                    <div className="text-right shrink-0">
                      <div className="t-primary tabular-nums font-medium">
                        {formatBytes(f.size_bytes)}
                      </div>
                      <div className="t-tertiary text-meta">{formatDate(f.modified_secs)}</div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <RevealButton path={f.path} />
                      <Button
                        size="sm"
                        variant="soft"
                        tone="danger"
                        onClick={() => setPending(f)}
                      >
                        Trash
                      </Button>
                    </div>
                  </>
                }
              />
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={pending !== null}
        title="Move to trash?"
        description={
          pending
            ? `${basename(pending.path)} (${formatBytes(pending.size_bytes)})\n\nThe file can be restored from the macOS trash.`
            : undefined
        }
        confirmLabel="Trash"
        tone="danger"
        onConfirm={() => pending && handleTrash(pending)}
        onCancel={() => setPending(null)}
      />
    </div>
  );
};
