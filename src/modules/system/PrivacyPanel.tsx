import { useCallback, useMemo, useState } from 'react';
import { useAsync } from '../../shared/hooks/useAsync';
import { Button } from '../../shared/ui/Button';
import { CenterSpinner } from '../../shared/ui/CenterSpinner';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { EmptyState } from '../../shared/ui/EmptyState';
import { ListItemRow } from '../../shared/ui/ListItemRow';
import { PanelHeader } from '../../shared/ui/PanelHeader';
import { RevealButton } from '../../shared/ui/RevealButton';
import { useToast } from '../../shared/ui/Toast';
import { listPrivacy, trashPath, type PrivacyItem } from './api';
import { formatBytes } from './format';

const CAT_TINT: Record<string, { bg: string; dot: string }> = {
  browser: { bg: 'rgba(142,197,255,0.18)', dot: '#8ec5ff' },
  system: { bg: 'rgba(208,140,255,0.18)', dot: '#d08cff' },
  terminal: { bg: 'rgba(126,247,165,0.18)', dot: '#7ef7a5' },
};

export const PrivacyPanel = () => {
  const { data: items, error, reload: refresh } = useAsync(listPrivacy);
  const [pending, setPending] = useState<PrivacyItem | null>(null);
  const { toast } = useToast();

  const total = useMemo(
    () => (items ?? []).reduce((a, i) => a + i.size_bytes, 0),
    [items],
  );

  const confirm = useCallback(async () => {
    if (!pending) return;
    const p = pending;
    setPending(null);
    try {
      await trashPath(p.path);
      toast({
        title: 'Moved to trash',
        description: `${p.label} · ${formatBytes(p.size_bytes)}`,
        variant: 'success',
      });
      refresh();
    } catch (e) {
      toast({ title: 'Error', description: String(e), variant: 'error' });
    }
  }, [pending, refresh, toast]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <PanelHeader
        gradient={['#d08cff', '#ff3a6f']}
        icon={
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5z" />
          </svg>
        }
        title="Privacy"
        description="Browser history, Recent Items, QuickLook, shell history."
        trailing={
          <div className="t-primary tabular-nums text-title font-semibold">
            {formatBytes(total)}
          </div>
        }
      />

      <div className="flex-1 min-h-0 overflow-auto">
        {error && <div className="p-4 t-danger text-body">Error: {error}</div>}
        {!error && !items && <CenterSpinner />}
        {items && items.length === 0 && <EmptyState title="Nothing found" />}
        {items && items.length > 0 && (
          <ul className="divide-y hair">
            {items.map((i) => {
              const tint = CAT_TINT[i.category] ?? CAT_TINT.system;
              return (
                <ListItemRow
                  key={i.path}
                  className="hover:bg-white/[0.03]"
                  title={
                    <span className="flex items-center gap-2">
                      <span className="truncate">{i.label}</span>
                      <span
                        className="shrink-0 inline-flex items-center gap-1 px-1.5 py-px rounded text-[10px] t-secondary font-normal"
                        style={{ background: tint.bg }}
                      >
                        <span aria-hidden className="w-1.5 h-1.5 rounded-full" style={{ background: tint.dot }} />
                        {i.category}
                      </span>
                    </span>
                  }
                  meta={<span title={i.path}>{i.path}</span>}
                  trailing={
                    <>
                      <div className="t-primary tabular-nums shrink-0">{formatBytes(i.size_bytes)}</div>
                      <RevealButton path={i.path} />
                      <Button size="sm" variant="soft" tone="danger" onClick={() => setPending(i)}>
                        Trash
                      </Button>
                    </>
                  }
                />
              );
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={pending !== null}
        title="Delete activity trail?"
        description={
          pending
            ? `${pending.label} — ${pending.path}\n\nWill be moved to trash. Some apps will recreate the file automatically on next launch.`
            : undefined
        }
        confirmLabel="Trash"
        tone="danger"
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      />
    </div>
  );
};
