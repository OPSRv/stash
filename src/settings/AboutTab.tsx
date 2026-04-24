import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { Button } from '../shared/ui/Button';
import { Card } from '../shared/ui/Card';
import { Kbd } from '../shared/ui/Kbd';
import { ytDlpVersion } from '../modules/downloader/api';
import { accent } from '../shared/theme/accent';
import logoUrl from '../../logo.svg?url';

const GITHUB_URL = 'https://github.com/OPSRv/stash';

const pillars = [
  {
    title: 'UI/UX',
    body: 'Передбачувано, фокус не втрачається, feedback миттєвий.',
  },
  {
    title: 'Модульність',
    body: 'Кожен таб — стендалон зі своїм API, тестами, lazy-поповерхнею.',
  },
  {
    title: 'Перформанс',
    body: 'Lazy tabs, prefetch on hover, bundle-stubs для важкого.',
  },
];

const openUrl = (url: string) => {
  import('@tauri-apps/plugin-opener')
    .then(({ openUrl: open }) => open(url))
    .catch((e) => console.error('open url failed', e));
};

export const AboutTab = () => {
  const [version, setVersion] = useState('…');
  const [ytVersion, setYtVersion] = useState<string | null>(null);
  const [sentReport, setSentReport] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
    ytDlpVersion()
      .then((v) => setYtVersion(v.installed))
      .catch(() => {});
  }, []);

  const openDataFolder = async () => {
    try {
      await invoke('open_data_folder');
    } catch (e) {
      console.error('open data folder failed', e);
    }
  };

  const sendLogs = async () => {
    try {
      const path = await invoke<string>('collect_logs');
      setSentReport(path);
    } catch (e) {
      console.error('collect logs failed', e);
    }
  };

  return (
    <div className="space-y-2.5">
      <Card padding="md" rounded="lg" className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-16 -right-16 h-40 w-40 rounded-full blur-3xl"
          style={{ background: accent(0.22) }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-20 -left-12 h-36 w-36 rounded-full blur-3xl"
          style={{ background: accent(0.1) }}
        />
        <div className="relative flex items-start gap-3">
          <img
            src={logoUrl}
            alt=""
            width={44}
            height={44}
            className="shrink-0 rounded-xl"
            style={{ boxShadow: `0 6px 18px -8px ${accent(0.5)}` }}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <div className="t-primary text-title font-semibold tracking-tight">Stash</div>
              <span
                className="text-meta rounded px-1 py-px"
                style={{
                  background: accent(0.15),
                  color: 'rgb(var(--stash-accent-rgb))',
                }}
              >
                v{version}
              </span>
            </div>
            <div className="t-secondary text-meta mt-0.5">
              macOS menubar multitool — свідомий Франкенштейн для дрібних задач.
            </div>
            <div className="t-tertiary text-meta mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="inline-flex items-center gap-0.5">
                <Kbd>⌘</Kbd>
                <Kbd>⇧</Kbd>
                <Kbd>V</Kbd>
              </span>
              <span>тогл</span>
              <span>·</span>
              <span className="inline-flex items-center gap-0.5">
                <Kbd>⌘</Kbd>
                <Kbd>⌥</Kbd>
                <Kbd>1–7</Kbd>
              </span>
              <span>таби</span>
            </div>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-4 gap-2">
        {[
          { value: '13', label: 'модулів' },
          { value: '100%', label: 'offline' },
          { value: '0', label: 'telemetry' },
          { value: '920×640', label: 'popup' },
        ].map((s) => (
          <Card key={s.label} padding="sm" rounded="md" className="text-center">
            <div className="t-primary text-body font-semibold tabular-nums">{s.value}</div>
            <div className="t-tertiary text-meta">{s.label}</div>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2">
        {pillars.map((p) => (
          <Card key={p.title} padding="sm" rounded="md">
            <div className="t-primary text-meta font-semibold">{p.title}</div>
            <div className="t-secondary text-meta mt-0.5 leading-snug">{p.body}</div>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        <Button size="xs" tone="accent" variant="solid" onClick={() => openUrl(GITHUB_URL)}>
          GitHub
        </Button>
        <Button size="xs" onClick={openDataFolder}>
          Папка даних
        </Button>
        <Button size="xs" onClick={sendLogs}>
          Зібрати логи
        </Button>
        <div className="t-tertiary text-meta ml-auto">
          yt-dlp {ytVersion ?? '—'}
        </div>
      </div>

      {sentReport && (
        <div className="t-tertiary text-meta">Звіт записано у {sentReport}</div>
      )}
    </div>
  );
};
