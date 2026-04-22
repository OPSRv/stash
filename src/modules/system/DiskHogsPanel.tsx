import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { CenterSpinner } from '../../shared/ui/CenterSpinner';
import { SegmentedControl } from '../../shared/ui/SegmentedControl';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { EmptyState } from '../../shared/ui/EmptyState';
import { ListItemRow } from '../../shared/ui/ListItemRow';
import { PanelHeader } from '../../shared/ui/PanelHeader';
import { RevealButton } from '../../shared/ui/RevealButton';
import { useToast } from '../../shared/ui/Toast';
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
        <ListItemRow
          key={s.path}
          title={s.path.split('/').pop()}
          meta={fmtDate(s.created_secs)}
          trailing={
            <>
              <div className="t-primary tabular-nums shrink-0">{formatBytes(s.size_bytes)}</div>
              <RevealButton path={s.path} />
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
            </>
          }
        />
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
        <ListItemRow
          key={b.path}
          title={b.device_name ?? b.uuid}
          meta={
            <span title={b.path}>
              {b.uuid} · {fmtDate(b.last_modified)}
            </span>
          }
          trailing={
            <>
              <div className="t-primary tabular-nums shrink-0">{formatBytes(b.size_bytes)}</div>
              <RevealButton path={b.path} />
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
            </>
          }
        />
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
        <ListItemRow
          key={m.path}
          title={`Mail · ${m.version}`}
          meta={m.path}
          trailing={
            <>
              <div className="t-primary tabular-nums shrink-0">{formatBytes(m.size_bytes)}</div>
              <RevealButton path={m.path} />
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
            </>
          }
        />
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
          <ListItemRow
            key={s.path}
            title={
              <span className="flex items-center gap-1.5">
                <span className="truncate">{s.name}</span>
                {!s.available && (
                  <span className="text-[10px] px-1 py-px rounded bg-white/5 t-tertiary font-normal">
                    unavailable
                  </span>
                )}
              </span>
            }
            meta={s.path}
            trailing={
              <>
                <div className="t-primary tabular-nums shrink-0">{formatBytes(s.size_bytes)}</div>
                <RevealButton path={s.path} />
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
              </>
            }
          />
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
        <ListItemRow
          key={s.name}
          title={s.created_at}
          meta={s.name}
          trailing={
            <Button
              size="sm"
              variant="soft"
              tone="danger"
              onClick={() => onPending({ kind: 'tm', name: s.name })}
            >
              Видалити
            </Button>
          }
        />
      ))}
    </ul>
  );
};

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
      <PanelHeader
        gradient={['#ffd86b', '#ff3a6f']}
        icon={
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
        }
        title="Важке на диску"
        description="Скріншоти, iOS-бекапи, Mail, Xcode-симулятори, Time Machine snapshots."
        inlineRight={
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
        }
      />

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
