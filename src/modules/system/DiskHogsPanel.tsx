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
    return <EmptyState title="No screenshots found on Desktop" />;
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
                Trash
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
  if (list.length === 0) return <EmptyState title="No iOS backups found" />;
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
                Trash
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
  if (list.length === 0) return <EmptyState title="No Mail data found" />;
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
                Trash
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
          {list.length} simulators · {formatBytes(list.reduce((a, s) => a + s.size_bytes, 0))}
        </div>
        <Button
          size="sm"
          variant="soft"
          tone="accent"
          disabled={list.every((s) => s.available)}
          onClick={() => onPending({ kind: 'sims-unavailable' })}
        >
          Remove unavailable
        </Button>
      </div>
      {list.length === 0 && <EmptyState title="No simulators found" />}
      <ul className="divide-y hair">
        {list.map((s) => (
          <ListItemRow
            key={s.path}
            title={
              <span className="flex items-center gap-1.5">
                <span className="truncate">{s.name}</span>
                {!s.available && (
                  <span className="text-[10px] px-1 py-px rounded [background:var(--bg-hover)] t-tertiary font-normal">
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
                  Trash
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
    return <EmptyState title="No local TM snapshots found" description="tmutil returned nothing — disk is clean." />;
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
              Delete
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
          title: 'Moved to trash',
          description: `${p.label} (${formatBytes(p.size)})`,
          variant: 'success',
        });
      } else if (p.kind === 'tm') {
        await deleteTmSnapshot(p.name);
        toast({ title: 'Snapshot deleted', description: p.name, variant: 'success' });
      } else if (p.kind === 'sims-unavailable') {
        await deleteUnavailableSimulators();
        toast({ title: 'Unavailable simulators removed', variant: 'success' });
      }
    } catch (e) {
      toast({ title: 'Error', description: String(e), variant: 'error' });
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
      return `${pending.label} (${formatBytes(pending.size)}) will be moved to trash.`;
    if (pending.kind === 'tm')
      return `Local TM snapshot ${pending.name} will be permanently deleted.`;
    return 'Runs `xcrun simctl delete unavailable` — removes all simulators whose iOS version is no longer installed.';
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
        title="Disk hogs"
        description="Screenshots, iOS backups, Mail, Xcode simulators, Time Machine snapshots."
        inlineRight={
          <SegmentedControl<Tab>
            size="sm"
            value={tab}
            onChange={setTab}
            ariaLabel="Data type"
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
        title={pending?.kind === 'sims-unavailable' ? 'Remove unavailable simulators?' : 'Delete?'}
        description={dialogDescription}
        confirmLabel={pending?.kind === 'sims-unavailable' ? 'Remove' : 'Delete'}
        tone="danger"
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      />
    </div>
  );
};
