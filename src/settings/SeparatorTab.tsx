import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Button } from '../shared/ui/Button';
import { ProgressBar } from '../shared/ui/ProgressBar';
import { ConfirmDialog } from '../shared/ui/ConfirmDialog';
import { formatBytes } from '../shared/format/bytes';
import {
  status as fetchStatus,
  download as runDownload,
  remove as runRemove,
  type SeparatorAssetKind,
  type SeparatorDownloadEvent,
  type SeparatorStatus,
} from '../modules/separator/api';
import { SettingRow } from './SettingRow';
import { SettingsSection, SettingsTab } from './SettingsLayout';

type AssetProgress = {
  received: number;
  total: number;
  done: boolean;
};

/** Settings → Separator: install / uninstall the Demucs+BeatNet sidecar
 *  and (optionally) the htdemucs_ft fine-tuned model pack.
 *
 *  Mirrors the diarization/whisper install UX — per-asset progress bars
 *  driven by `separator:download` events, with the "Status" row giving
 *  a single primary action that flips between Download / Delete based on
 *  what's already on disk. */
export const SeparatorTab = () => {
  const [status, setStatus] = useState<SeparatorStatus | null>(null);
  const [progress, setProgress] = useState<Record<string, AssetProgress>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [confirmDeleteFt, setConfirmDeleteFt] = useState(false);

  const refresh = useCallback(() => {
    fetchStatus()
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    refresh();
    const off = listen<SeparatorDownloadEvent>('separator:download', (e) => {
      const id = e.payload.id;
      setProgress((prev) => ({
        ...prev,
        [id]: {
          received: e.payload.received,
          total: e.payload.total,
          done: e.payload.done,
        },
      }));
      if (e.payload.done) refresh();
    });
    return () => {
      off.then((f) => f()).catch(() => undefined);
    };
  }, [refresh]);

  const downloadCore = async () => {
    setBusy(true);
    setError(null);
    try {
      await runDownload(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const downloadFt = async () => {
    setBusy(true);
    setError(null);
    try {
      // `with_ft = true` re-downloads any missing required asset too,
      // so a partial install converges with a single click.
      await runDownload(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteAll = async () => {
    setConfirmDeleteAll(false);
    setBusy(true);
    setError(null);
    try {
      await runRemove(false);
      setProgress({});
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const deleteFt = async () => {
    setConfirmDeleteFt(false);
    setBusy(true);
    setError(null);
    try {
      await runRemove(true);
      setProgress((prev) => {
        const next = { ...prev };
        for (const k of [
          'htdemucs_ft_vocals',
          'htdemucs_ft_drums',
          'htdemucs_ft_bass',
          'htdemucs_ft_other',
        ] as SeparatorAssetKind[]) {
          delete next[k];
        }
        return next;
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  if (!status) {
    return (
      <SettingsTab>
        <p className="text-meta opacity-60">Завантаження…</p>
      </SettingsTab>
    );
  }

  return (
    <SettingsTab>
      <SettingsSection label="STEM SEPARATION + BPM">
        <SettingRow
          title="Стан"
          description={
            status.ready
              ? 'Demucs + BeatNet встановлено. Розкладка треку доступна на табі Stems.'
              : 'Не встановлено. ~360 МБ для 6-стемного htdemucs_6s + сидекар.'
          }
          control={
            status.ready ? (
              <Button
                size="sm"
                variant="soft"
                tone="danger"
                onClick={() => setConfirmDeleteAll(true)}
                disabled={busy}
              >
                Видалити
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                onClick={downloadCore}
                disabled={busy}
              >
                {busy ? 'Завантажую…' : 'Завантажити'}
              </Button>
            )
          }
        />
        <SettingRow
          title="High-quality 4-stem"
          description="htdemucs_ft — чотири моделі, кожна спеціалізована на одному стемі. +320 МБ. Без guitar / piano стемів — для них залишається 6-стемна модель."
          control={
            status.ft_ready ? (
              <Button
                size="sm"
                variant="soft"
                tone="danger"
                onClick={() => setConfirmDeleteFt(true)}
                disabled={busy}
              >
                Прибрати
              </Button>
            ) : (
              <Button
                size="sm"
                variant="soft"
                onClick={downloadFt}
                disabled={busy || !status.ready}
                title={
                  !status.ready
                    ? 'Спочатку встановіть базовий пакет'
                    : undefined
                }
              >
                Завантажити
              </Button>
            )
          }
        />
        <SettingRow
          title="Папка для стемів"
          description={status.default_output_dir}
          control={null}
        />
      </SettingsSection>
      <SettingsSection label="ASSETS" divided={false}>
        <ul
          className="flex flex-col gap-2 text-meta"
          data-testid="separator-asset-list"
        >
          {status.assets.map((a) => {
            const p = progress[a.kind];
            const done = a.downloaded || p?.done;
            const ratio = p && p.total > 0 ? p.received / p.total : 0;
            return (
              <li
                key={a.kind}
                className="flex items-center gap-3"
                data-testid={`asset-${a.kind}`}
              >
                <span className="flex-1 truncate t-primary">{a.label}</span>
                <span className="opacity-60 font-mono">
                  {formatBytes(a.size_bytes, { empty: '—' })}
                </span>
                {p && !p.done && (
                  <ProgressBar
                    value={ratio}
                    size="sm"
                    className="w-32"
                    ariaLabel={`${a.label} ${Math.round(ratio * 100)}%`}
                  />
                )}
                {done && (
                  <span className="opacity-60" aria-label="installed">
                    ✓
                  </span>
                )}
                {a.optional && !done && (
                  <span className="opacity-40">опційно</span>
                )}
              </li>
            );
          })}
        </ul>
      </SettingsSection>
      {error && (
        <p role="alert" className="text-meta text-red-300/80">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirmDeleteAll}
        title="Видалити все?"
        description="Сидекар, моделі та fine-tuned пакет (~700 МБ) будуть видалені. Згодом можна буде знову завантажити."
        confirmLabel="Видалити"
        tone="danger"
        onConfirm={deleteAll}
        onCancel={() => setConfirmDeleteAll(false)}
      />
      <ConfirmDialog
        open={confirmDeleteFt}
        title="Прибрати htdemucs_ft?"
        description="Будуть видалені 4 файли вагою ~320 МБ. 6-стемна модель і сидекар залишаться на місці."
        confirmLabel="Прибрати"
        tone="danger"
        onConfirm={deleteFt}
        onCancel={() => setConfirmDeleteFt(false)}
      />
    </SettingsTab>
  );
};
