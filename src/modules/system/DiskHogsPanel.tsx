import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { Spinner } from '../../shared/ui/Spinner';
import { SegmentedControl } from '../../shared/ui/SegmentedControl';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { EmptyState } from '../../shared/ui/EmptyState';
import { useToast } from '../../shared/ui/Toast';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import {
  deleteTmSnapshot,
  deleteUnavailableSimulators,
  listIosBackups,
  listMailAttachments,
  listScreenshots,
  listTmSnapshots,
  listXcodeSimulators,
  trashPath,
  type IosBackup,
  type MailAttachmentsBucket,
  type Screenshot,
  type TmSnapshot,
  type XcodeSimulator,
} from './api';
import { formatBytes } from './format';

type Tab = 'screenshots' | 'ios' | 'mail' | 'xcode' | 'tm';

type Pending =
  | { kind: 'trash'; path: string; size: number; label: string }
  | { kind: 'tm'; name: string }
  | { kind: 'sims-unavailable' };

const fmtDate = (secs: number): string =>
  secs ? new Date(secs * 1000).toLocaleDateString() : '—';

const ScreenshotsTab = ({ onPending }: { onPending: (p: Pending) => void }) => {
  const [list, setList] = useState<Screenshot[] | null>(null);
  useEffect(() => {
    listScreenshots().then(setList).catch(() => setList([]));
  }, []);
  if (!list) return <CenterSpinner />;
  if (list.length === 0)
    return <EmptyState title="Скріншотів на Desktop не знайдено" />;
  return (
    <ul className="divide-y hair">
      {list.map((s) => (
        <li key={s.path} className="px-4 py-2 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="t-primary text-body font-medium truncate">
              {s.path.split('/').pop()}
            </div>
            <div className="t-tertiary text-meta">{fmtDate(s.created_secs)}</div>
          </div>
          <div className="t-primary tabular-nums shrink-0">{formatBytes(s.size_bytes)}</div>
          <Button size="sm" variant="ghost" onClick={() => revealItemInDir(s.path).catch(() => undefined)}>
            Показати
          </Button>
          <Button
            size="sm"
            variant="soft"
            tone="danger"
            onClick={() =>
              onPending({ kind: 'trash', path: s.path, size: s.size_bytes, label: s.path.split('/').pop() ?? s.path })
            }
          >
            У кошик
          </Button>
        </li>
      ))}
    </ul>
  );
};

const IosTab = ({ onPending }: { onPending: (p: Pending) => void }) => {
  const [list, setList] = useState<IosBackup[] | null>(null);
  useEffect(() => {
    listIosBackups().then(setList).catch(() => setList([]));
  }, []);
  if (!list) return <CenterSpinner />;
  if (list.length === 0) return <EmptyState title="iOS-бекапів не знайдено" />;
  return (
    <ul className="divide-y hair">
      {list.map((b) => (
        <li key={b.path} className="px-4 py-2 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="t-primary text-body font-medium truncate">
              {b.device_name ?? b.uuid}
            </div>
            <div className="t-tertiary text-meta truncate" title={b.path}>
              {b.uuid} · {fmtDate(b.last_modified)}
            </div>
          </div>
          <div className="t-primary tabular-nums shrink-0">{formatBytes(b.size_bytes)}</div>
          <Button size="sm" variant="ghost" onClick={() => revealItemInDir(b.path).catch(() => undefined)}>
            Показати
          </Button>
          <Button
            size="sm"
            variant="soft"
            tone="danger"
            onClick={() =>
              onPending({ kind: 'trash', path: b.path, size: b.size_bytes, label: b.device_name ?? b.uuid })
            }
          >
            У кошик
          </Button>
        </li>
      ))}
    </ul>
  );
};

const MailTab = ({ onPending }: { onPending: (p: Pending) => void }) => {
  const [list, setList] = useState<MailAttachmentsBucket[] | null>(null);
  useEffect(() => {
    listMailAttachments().then(setList).catch(() => setList([]));
  }, []);
  if (!list) return <CenterSpinner />;
  if (list.length === 0) return <EmptyState title="Mail-даних не знайдено" />;
  return (
    <ul className="divide-y hair">
      {list.map((m) => (
        <li key={m.path} className="px-4 py-2 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="t-primary text-body font-medium">Mail · {m.version}</div>
            <div className="t-tertiary text-meta truncate">{m.path}</div>
          </div>
          <div className="t-primary tabular-nums shrink-0">{formatBytes(m.size_bytes)}</div>
          <Button size="sm" variant="ghost" onClick={() => revealItemInDir(m.path).catch(() => undefined)}>
            Показати
          </Button>
          <Button
            size="sm"
            variant="soft"
            tone="danger"
            onClick={() =>
              onPending({ kind: 'trash', path: m.path, size: m.size_bytes, label: `Mail ${m.version}` })
            }
          >
            У кошик
          </Button>
        </li>
      ))}
    </ul>
  );
};

const XcodeTab = ({ onPending }: { onPending: (p: Pending) => void }) => {
  const [list, setList] = useState<XcodeSimulator[] | null>(null);
  const refresh = useCallback(() => {
    listXcodeSimulators().then(setList).catch(() => setList([]));
  }, []);
  useEffect(refresh, [refresh]);
  if (!list) return <CenterSpinner />;
  return (
    <div>
      <div className="px-4 py-2 flex items-center justify-between border-b hair">
        <div className="t-tertiary text-meta">
          {list.length} симуляторів · {formatBytes(list.reduce((a, s) => a + s.size_bytes, 0))}
        </div>
        <Button
          size="sm"
          variant="soft"
          tone="accent"
          disabled={list.every((s) => s.available)}
          onClick={() => onPending({ kind: 'sims-unavailable' })}
        >
          Видалити недоступні
        </Button>
      </div>
      {list.length === 0 && <EmptyState title="Симуляторів не знайдено" />}
      <ul className="divide-y hair">
        {list.map((s) => (
          <li key={s.path} className="px-4 py-2 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="t-primary text-body font-medium truncate">{s.name}</span>
                {!s.available && (
                  <span className="text-[10px] px-1 py-px rounded bg-white/5 t-tertiary">
                    unavailable
                  </span>
                )}
              </div>
              <div className="t-tertiary text-meta truncate">{s.path}</div>
            </div>
            <div className="t-primary tabular-nums shrink-0">{formatBytes(s.size_bytes)}</div>
            <Button size="sm" variant="ghost" onClick={() => revealItemInDir(s.path).catch(() => undefined)}>
              Показати
            </Button>
            <Button
              size="sm"
              variant="soft"
              tone="danger"
              onClick={() =>
                onPending({ kind: 'trash', path: s.path, size: s.size_bytes, label: s.name })
              }
            >
              У кошик
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
};

const TmTab = ({ onPending }: { onPending: (p: Pending) => void }) => {
  const [list, setList] = useState<TmSnapshot[] | null>(null);
  useEffect(() => {
    listTmSnapshots().then(setList).catch(() => setList([]));
  }, []);
  if (!list) return <CenterSpinner />;
  if (list.length === 0)
    return <EmptyState title="Локальних TM-снапшотів не знайдено" description="tmutil нічого не повертає — диск чистий." />;
  return (
    <ul className="divide-y hair">
      {list.map((s) => (
        <li key={s.name} className="px-4 py-2 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="t-primary text-body font-medium">{s.created_at}</div>
            <div className="t-tertiary text-meta truncate">{s.name}</div>
          </div>
          <Button
            size="sm"
            variant="soft"
            tone="danger"
            onClick={() => onPending({ kind: 'tm', name: s.name })}
          >
            Видалити
          </Button>
        </li>
      ))}
    </ul>
  );
};

const CenterSpinner = () => (
  <div className="flex items-center justify-center py-10">
    <Spinner />
  </div>
);

export const DiskHogsPanel = () => {
  const [tab, setTab] = useState<Tab>('screenshots');
  const [pending, setPending] = useState<Pending | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const { toast } = useToast();

  const confirm = useCallback(async () => {
    if (!pending) return;
    const p = pending;
    setPending(null);
    try {
      if (p.kind === 'trash') {
        await trashPath(p.path);
        toast({
          title: 'Переміщено в кошик',
          description: `${p.label} (${formatBytes(p.size)})`,
          variant: 'success',
        });
      } else if (p.kind === 'tm') {
        await deleteTmSnapshot(p.name);
        toast({ title: 'Снапшот видалено', description: p.name, variant: 'success' });
      } else if (p.kind === 'sims-unavailable') {
        await deleteUnavailableSimulators();
        toast({ title: 'Недоступні симулятори видалено', variant: 'success' });
      }
    } catch (e) {
      toast({ title: 'Помилка', description: String(e), variant: 'error' });
    }
    setReloadKey((k) => k + 1);
  }, [pending, toast]);

  const body = (() => {
    switch (tab) {
      case 'screenshots':
        return <ScreenshotsTab key={`s${reloadKey}`} onPending={setPending} />;
      case 'ios':
        return <IosTab key={`i${reloadKey}`} onPending={setPending} />;
      case 'mail':
        return <MailTab key={`m${reloadKey}`} onPending={setPending} />;
      case 'xcode':
        return <XcodeTab key={`x${reloadKey}`} onPending={setPending} />;
      case 'tm':
        return <TmTab key={`t${reloadKey}`} onPending={setPending} />;
    }
  })();

  const dialogDescription = (() => {
    if (!pending) return undefined;
    if (pending.kind === 'trash')
      return `${pending.label} (${formatBytes(pending.size)}) буде переміщено у кошик.`;
    if (pending.kind === 'tm')
      return `Локальний TM-снапшот ${pending.name} буде видалено без можливості відновлення.`;
    return 'Буде запущено `xcrun simctl delete unavailable` — видалить усі симулятори, чия iOS більше не встановлена.';
  })();

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header
        className="px-4 py-3 relative overflow-hidden"
        style={{
          background:
            'linear-gradient(135deg, rgba(255,216,107,0.12), rgba(255,58,111,0.18))',
          boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.06)',
        }}
      >
        <div
          aria-hidden
          className="absolute -top-10 -right-6 w-40 h-40 rounded-full"
          style={{
            background: 'radial-gradient(closest-side, rgba(255,58,111,0.35), transparent)',
            filter: 'blur(10px)',
          }}
        />
        <div className="relative flex items-center gap-4">
          <div
            aria-hidden
            className="w-14 h-14 rounded-2xl inline-flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg,#ffd86b,#ff3a6f)',
              boxShadow: '0 8px 24px -8px rgba(255,58,111,0.55), inset 0 0 0 1px rgba(255,255,255,0.2)',
            }}
          >
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </div>
          <div className="flex-1">
            <div className="t-primary text-title font-semibold">Важке на диску</div>
            <div className="t-tertiary text-meta">
              Скріншоти, iOS-бекапи, Mail, Xcode-симулятори, Time Machine snapshots.
            </div>
          </div>
          <SegmentedControl<Tab>
            size="sm"
            value={tab}
            onChange={setTab}
            ariaLabel="Тип важких даних"
            options={[
              { value: 'screenshots', label: 'Screens' },
              { value: 'ios', label: 'iOS' },
              { value: 'mail', label: 'Mail' },
              { value: 'xcode', label: 'Xcode' },
              { value: 'tm', label: 'TM' },
            ]}
          />
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto">{body}</div>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === 'sims-unavailable' ? 'Видалити недоступні симулятори?' : 'Видалити?'}
        description={dialogDescription}
        confirmLabel={pending?.kind === 'sims-unavailable' ? 'Видалити' : 'Видалити'}
        tone="danger"
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      />
    </div>
  );
};
