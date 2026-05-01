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
  type SeparatorInstallEvent,
  type SeparatorInstallPhase,
  type SeparatorStatus,
} from '../modules/separator/api';
import { SettingRow } from './SettingRow';
import { SettingsSection, SettingsTab } from './SettingsLayout';

type AssetProgress = {
  received: number;
  total: number;
  done: boolean;
};

const PHASE_ORDER: SeparatorInstallPhase[] = [
  'uv',
  'python',
  'venv',
  'packages',
  'models',
  'done',
];

const PHASE_LABEL: Record<SeparatorInstallPhase, string> = {
  uv: 'Завантажую uv',
  python: 'Готую Python 3.11',
  venv: 'Створюю venv',
  packages: 'Ставлю demucs + BeatNet + torch',
  models: 'Завантажую моделі',
  done: 'Готово',
};

/** Settings → Separator: install / uninstall the uv-managed Python
 *  runtime (uv → Python 3.11 → venv → demucs + BeatNet + torch) and
 *  download Demucs model weights (htdemucs_6s + optional htdemucs_ft).
 *
 *  Mirrors the diarization install UX, but the install pipeline has
 *  five phases instead of a flat per-file progress, so we render a
 *  staged card alongside the per-asset list. */
export const SeparatorTab = () => {
  const [status, setStatus] = useState<SeparatorStatus | null>(null);
  const [assetProgress, setAssetProgress] = useState<Record<string, AssetProgress>>({});
  const [installPhase, setInstallPhase] = useState<SeparatorInstallEvent | null>(null);
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
    const offDl = listen<SeparatorDownloadEvent>('separator:download', (e) => {
      const id = e.payload.id;
      setAssetProgress((prev) => ({
        ...prev,
        [id]: {
          received: e.payload.received,
          total: e.payload.total,
          done: e.payload.done,
        },
      }));
      if (e.payload.done) refresh();
    });
    const offInstall = listen<SeparatorInstallEvent>('separator:install', (e) => {
      setInstallPhase(e.payload);
      if (e.payload.phase === 'done') refresh();
    });
    return () => {
      offDl.then((f) => f()).catch(() => undefined);
      offInstall.then((f) => f()).catch(() => undefined);
    };
  }, [refresh]);

  const downloadCore = async () => {
    setBusy(true);
    setError(null);
    setInstallPhase(null);
    try {
      await runDownload(false);
      setInstallPhase({ phase: 'done', message: 'Готово' });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const downloadFt = async () => {
    setBusy(true);
    setError(null);
    try {
      await runDownload(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const deleteAll = async () => {
    setConfirmDeleteAll(false);
    setBusy(true);
    setError(null);
    try {
      await runRemove(false);
      setAssetProgress({});
      setInstallPhase(null);
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
      setAssetProgress((prev) => {
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

  // "Anything on disk" — true when the user has at least started an
  // install, even if it broke partway. We always offer "Видалити все"
  // in that state, so a user who hit a half-built venv (the symptom
  // we landed the demucs.api probe fix for) doesn't have to dig into
  // ~/Library to reset.
  const hasArtifacts =
    status.runtime_ready ||
    status.assets.some((a) => a.downloaded);

  return (
    <SettingsTab>
      <SettingsSection label="STEM SEPARATION + BPM">
        <SettingRow
          title="Стан"
          description={
            status.ready
              ? 'Demucs + BeatNet встановлено. Розкладка треку доступна на табі Stems.'
              : status.runtime_ready
                ? 'Python готовий, лишилось докачати моделі (~80 МБ).'
                : 'Не встановлено. uv підтягне Python 3.11 + demucs + BeatNet локально (~1.5 ГБ за 5–10 хв) та htdemucs_6s модель (~80 МБ).'
          }
          control={
            <div className="flex gap-2">
              {!status.ready && (
                <Button
                  size="sm"
                  variant="solid"
                  onClick={downloadCore}
                  disabled={busy}
                >
                  {busy ? 'Встановлюю…' : 'Завантажити'}
                </Button>
              )}
              {hasArtifacts && (
                <Button
                  size="sm"
                  variant="soft"
                  tone="danger"
                  onClick={() => setConfirmDeleteAll(true)}
                  disabled={busy}
                  title={
                    status.ready
                      ? 'Видалити Python venv + всі моделі'
                      : 'Стерти все і почати з нуля'
                  }
                >
                  Видалити все
                </Button>
              )}
            </div>
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
      {(busy || installPhase) && (
        <SettingsSection label="ВСТАНОВЛЕННЯ" divided={false}>
          <ol
            className="flex flex-col gap-1.5 text-meta"
            data-testid="separator-install-phases"
          >
            {PHASE_ORDER.filter((p) => p !== 'done').map((p) => {
              const currentIdx = installPhase
                ? PHASE_ORDER.indexOf(installPhase.phase)
                : -1;
              const myIdx = PHASE_ORDER.indexOf(p);
              const done = currentIdx > myIdx;
              const active = installPhase?.phase === p;
              const showProgress =
                active && typeof installPhase?.progress === 'number';
              return (
                <li
                  key={p}
                  className={`flex items-center gap-3 ${
                    done ? 'opacity-50' : active ? 'opacity-100' : 'opacity-40'
                  }`}
                  data-testid={`install-phase-${p}`}
                  data-state={done ? 'done' : active ? 'active' : 'pending'}
                >
                  <span className="t-tertiary font-mono w-4">
                    {done ? '✓' : active ? '·' : '·'}
                  </span>
                  <span className="flex-1 t-primary">{PHASE_LABEL[p]}</span>
                  {showProgress && (
                    <ProgressBar
                      value={installPhase!.progress!}
                      size="sm"
                      className="w-32"
                      ariaLabel={`${PHASE_LABEL[p]} ${Math.round(
                        (installPhase!.progress ?? 0) * 100,
                      )}%`}
                    />
                  )}
                </li>
              );
            })}
          </ol>
        </SettingsSection>
      )}
      <SettingsSection label="MODELS" divided={false}>
        <ul
          className="flex flex-col gap-2 text-meta"
          data-testid="separator-asset-list"
        >
          {status.assets.map((a) => {
            const p = assetProgress[a.kind];
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
        description="uv, Python venv, demucs / BeatNet та всі моделі (~2 ГБ) будуть видалені. При наступному встановленні все скачається наново."
        confirmLabel="Видалити"
        tone="danger"
        onConfirm={deleteAll}
        onCancel={() => setConfirmDeleteAll(false)}
      />
      <ConfirmDialog
        open={confirmDeleteFt}
        title="Прибрати htdemucs_ft?"
        description="Будуть видалені 4 файли вагою ~320 МБ. 6-стемна модель та Python-runtime залишаться на місці."
        confirmLabel="Прибрати"
        tone="danger"
        onConfirm={deleteFt}
        onCancel={() => setConfirmDeleteFt(false)}
      />
    </SettingsTab>
  );
};
