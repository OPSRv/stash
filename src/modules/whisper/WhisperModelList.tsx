import { useCallback, useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Button } from '../../shared/ui/Button';
import { ProgressBar } from '../../shared/ui/ProgressBar';
import { Badge } from '../../shared/ui/Badge';
import { TrashIcon } from '../../shared/ui/icons';
import { useToast } from '../../shared/ui/Toast';
import {
  type DownloadEvent,
  type ModelRow,
  whisperDeleteModel,
  whisperDownloadModel,
  whisperListModels,
  whisperSetActive,
} from './api';

const formatMB = (bytes: number): string => {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${Math.round(bytes / 1000)} KB`;
};

const accuracyLabel = (a: number): string =>
  ['', 'basic', 'fair', 'good', 'very good', 'best'][a] ?? `tier ${a}`;

const speedLabel = (rt: number): string => {
  if (rt >= 8) return 'Blazing';
  if (rt >= 3) return 'Fast';
  if (rt >= 1.5) return 'Moderate';
  if (rt >= 0.7) return 'Slow';
  return 'Very slow';
};

const speedDetail = (rt: number): string => {
  const secs = 60 / rt;
  if (secs < 60) return `~${Math.round(secs)} s per minute of audio`;
  const mins = secs / 60;
  return `~${mins.toFixed(1)} min per minute of audio`;
};

type Props = {
  /** When `false`, the component pauses all its subscriptions — used inside
   *  tabbed settings panels so the list doesn't listen when the user is on
   *  a different tab. Defaults to `true`. */
  active?: boolean;
};

/** Pure list of Whisper models with download/use/delete actions. Renders no
 *  chrome of its own so it can be embedded in a settings section, a modal,
 *  or anywhere a panel is appropriate. */
export const WhisperModelList = ({ active = true }: Props) => {
  const [rows, setRows] = useState<ModelRow[]>([]);
  const [downloading, setDownloading] = useState<
    Record<string, { received: number; total: number } | undefined>
  >({});
  const { toast } = useToast();

  const reload = useCallback(async () => {
    const fresh = await whisperListModels();
    setRows(fresh);
  }, []);

  useEffect(() => {
    if (!active) return;
    reload().catch((e) =>
      toast({ title: 'Couldn\u2019t list models', description: String(e), variant: 'error' }),
    );
  }, [active, reload, toast]);

  useEffect(() => {
    if (!active) return;
    let unlisten: (() => void) | null = null;
    listen<DownloadEvent>('whisper:download', (ev) => {
      const p = ev.payload;
      setDownloading((prev) => {
        if (p.done) {
          const { [p.id]: _gone, ...rest } = prev;
          return rest;
        }
        return { ...prev, [p.id]: { received: p.received, total: p.total } };
      });
      if (p.done) void reload();
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      unlisten?.();
    };
  }, [active, reload]);

  const download = async (id: string) => {
    setDownloading((prev) => ({ ...prev, [id]: { received: 0, total: 0 } }));
    try {
      await whisperDownloadModel(id);
      toast({ title: 'Model downloaded', description: id, variant: 'success' });
    } catch (e) {
      setDownloading((prev) => {
        const { [id]: _gone, ...rest } = prev;
        return rest;
      });
      toast({ title: 'Download failed', description: String(e), variant: 'error' });
    }
  };

  const useModel = async (id: string) => {
    try {
      await whisperSetActive(id);
      toast({ title: 'Active model set', description: id, variant: 'success' });
      await reload();
    } catch (e) {
      toast({ title: 'Couldn\u2019t activate', description: String(e), variant: 'error' });
    }
  };

  const remove = async (id: string) => {
    try {
      await whisperDeleteModel(id);
      const wasActive = rows.find((r) => r.id === id)?.active;
      if (wasActive) await whisperSetActive(null);
      await reload();
    } catch (e) {
      toast({ title: 'Couldn\u2019t delete', description: String(e), variant: 'error' });
    }
  };

  const grouped = useMemo(() => {
    const multi = rows.filter((r) => r.language !== 'en').sort((a, b) => a.size_bytes - b.size_bytes);
    const en = rows.filter((r) => r.language === 'en').sort((a, b) => a.size_bytes - b.size_bytes);
    return [...multi, ...en];
  }, [rows]);
  const firstEnglishId = useMemo(() => grouped.find((r) => r.language === 'en')?.id, [grouped]);

  return (
    <div className="rounded-md" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
      {grouped.map((row) => {
        const prog = downloading[row.id];
        const inFlight = Boolean(prog);
        const progress = prog && prog.total > 0 ? prog.received / prog.total : 0;
        const showEnglishHeader = row.id === firstEnglishId;
        return (
          <div key={row.id}>
            {showEnglishHeader && (
              <div className="px-4 pt-3 pb-1 t-tertiary text-meta uppercase tracking-wider">
                English-only — won't transcribe Ukrainian
              </div>
            )}
            <div
              className={`px-4 py-3 border-t hair first:border-t-0 flex items-center gap-3 ${
                row.active ? '[background:var(--bg-hover)]' : ''
              }`}
              data-testid={`model-row-${row.id}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="t-primary text-body font-medium">{row.label}</span>
                  {row.recommended_intel && <Badge tone="accent">Recommended</Badge>}
                  {row.active && <Badge tone="success">Active</Badge>}
                  {row.quantized && <Badge tone="neutral">q5</Badge>}
                </div>
                <div className="t-tertiary text-meta mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  <span>{formatMB(row.size_bytes)}</span>
                  <span>· RAM ~{(row.ram_mb / 1024).toFixed(1)} GB</span>
                  <span>
                    · {speedLabel(row.realtime_intel_2018)} ({speedDetail(row.realtime_intel_2018)})
                  </span>
                  <span>· Accuracy: {accuracyLabel(row.accuracy)}</span>
                  <span>· {row.language === 'en' ? 'English-only' : 'Multilingual'}</span>
                </div>
                {inFlight && (
                  <div className="mt-2">
                    <ProgressBar
                      value={progress}
                      size="sm"
                      ariaLabel={`Downloading ${row.label}`}
                    />
                    <span className="t-tertiary text-meta mt-1 block">
                      {formatMB(prog!.received)} / {formatMB(prog!.total || row.size_bytes)}
                    </span>
                  </div>
                )}
              </div>
              <div className="shrink-0 flex items-center gap-1.5">
                {row.downloaded ? (
                  <>
                    {!row.active && (
                      <Button
                        size="sm"
                        variant="soft"
                        tone="accent"
                        onClick={() => useModel(row.id)}
                        data-testid={`model-use-${row.id}`}
                      >
                        Use
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      tone="danger"
                      onClick={() => remove(row.id)}
                      leadingIcon={<TrashIcon size={12} />}
                      data-testid={`model-delete-${row.id}`}
                    >
                      Delete
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="soft"
                    tone="accent"
                    onClick={() => download(row.id)}
                    disabled={inFlight}
                    data-testid={`model-download-${row.id}`}
                  >
                    {inFlight ? 'Downloading…' : 'Download'}
                  </Button>
                )}
              </div>
            </div>
          </div>
        );
      })}
      {grouped.length === 0 && (
        <div className="p-8 t-tertiary text-meta text-center">Loading models…</div>
      )}
    </div>
  );
};
