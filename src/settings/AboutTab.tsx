import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { Button } from '../shared/ui/Button';
import { Card } from '../shared/ui/Card';
import { Kbd } from '../shared/ui/Kbd';
import { accent } from '../shared/theme/accent';
import { modules } from '../modules/registry';
import { TAB_ICONS, TAB_ICON_COLORS } from '../shell/tabIcons';
import { SettingsTab } from './SettingsLayout';
import { UpdateCheckRow } from './UpdateCheckRow';
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

/// Pulled from CLAUDE.md / package.json so this card stays honest. The
/// labels stay short — this is a mood line, not an SBOM.
const stack = ['Tauri 2', 'React 19', 'TypeScript', 'Rust'];

const openUrl = (url: string) => {
  import('@tauri-apps/plugin-opener')
    .then(({ openUrl: open }) => open(url))
    .catch((e) => console.error('open url failed', e));
};

const moduleCount = modules.length;

/// Settings is its own gear — listing it again in the module grid would be
/// duplicate noise. Same for `system` (no popup view, only tray actions).
const showcaseModules = modules
  .filter((m) => m.id !== 'settings' && TAB_ICONS[m.id])
  .sort((a, b) => (a.tabShortcutDigit ?? 99) - (b.tabShortcutDigit ?? 99));

export const AboutTab = () => {
  const [version, setVersion] = useState('…');

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  return (
    <SettingsTab>
      <div className="space-y-3">
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
              </div>
            </div>
          </div>
        </Card>

        <div className="grid grid-cols-4 gap-2">
          {[
            { value: String(moduleCount), label: 'модулів' },
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

        <Card padding="md" rounded="md">
          <div className="flex items-baseline justify-between mb-2">
            <div className="t-primary text-meta font-semibold">Модулі</div>
            <div className="t-tertiary text-meta">клік відкриває таб</div>
          </div>
          <div className="grid grid-cols-6 gap-1.5">
            {showcaseModules.map((m) => {
              const tint = TAB_ICON_COLORS[m.id] ?? 'currentColor';
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent('stash:navigate', { detail: m.id }),
                    )
                  }
                  title={
                    m.tabShortcutDigit
                      ? `${m.title} · ⌘⌥${m.tabShortcutDigit}`
                      : m.title
                  }
                  className="group relative flex flex-col items-center gap-1 rounded-md py-2 px-1 hair border transition-colors hover:bg-white/5 [.light_&]:hover:bg-black/5 focus-visible:outline-none"
                >
                  <span
                    className="inline-flex h-5 w-5 items-center justify-center"
                    style={{ color: tint }}
                  >
                    {TAB_ICONS[m.id]}
                  </span>
                  <span className="t-secondary text-meta truncate max-w-full">
                    {m.title}
                  </span>
                  {typeof m.tabShortcutDigit === 'number' && (
                    <span
                      className="absolute top-0.5 right-1 text-meta font-mono tabular-nums"
                      style={{ color: tint, opacity: 0.7 }}
                    >
                      {m.tabShortcutDigit}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </Card>

        <div className="grid grid-cols-3 gap-2">
          {pillars.map((p) => (
            <Card key={p.title} padding="sm" rounded="md">
              <div className="t-primary text-meta font-semibold">{p.title}</div>
              <div className="t-secondary text-meta mt-0.5 leading-snug">{p.body}</div>
            </Card>
          ))}
        </div>

        <Card padding="sm" rounded="md">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="t-tertiary text-meta">Зібрано на</span>
            {stack.map((s) => (
              <span
                key={s}
                className="text-meta rounded px-1.5 py-px font-medium"
                style={{
                  background: accent(0.12),
                  color: 'rgb(var(--stash-accent-rgb))',
                }}
              >
                {s}
              </span>
            ))}
          </div>
        </Card>

        <UpdateCheckRow />

        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <Button size="xs" tone="accent" variant="solid" onClick={() => openUrl(GITHUB_URL)}>
            GitHub
          </Button>
        </div>
      </div>
    </SettingsTab>
  );
};
