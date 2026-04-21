import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { Spinner } from '../../shared/ui/Spinner';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog';
import { EmptyState } from '../../shared/ui/EmptyState';
import { useToast } from '../../shared/ui/Toast';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { listPrivacy, trashPath, type PrivacyItem } from './api';
import { formatBytes } from './format';

const CAT_TINT: Record<string, { bg: string; dot: string }> = {
  browser: { bg: 'rgba(142,197,255,0.18)', dot: '#8ec5ff' },
  system: { bg: 'rgba(208,140,255,0.18)', dot: '#d08cff' },
  terminal: { bg: 'rgba(126,247,165,0.18)', dot: '#7ef7a5' },
};

export const PrivacyPanel = () => {
  const [items, setItems] = useState<PrivacyItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PrivacyItem | null>(null);
  const { toast } = useToast();

  const refresh = useCallback(() => {
    listPrivacy().then(setItems).catch((e) => setError(String(e)));
  }, []);

  useEffect(refresh, [refresh]);

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
        title: 'У кошик',
        description: `${p.label} · ${formatBytes(p.size_bytes)}`,
        variant: 'success',
      });
      refresh();
    } catch (e) {
      toast({ title: 'Помилка', description: String(e), variant: 'error' });
    }
  }, [pending, refresh, toast]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header
        className="px-4 py-3 relative overflow-hidden"
        style={{
          background:
            'linear-gradient(135deg, rgba(208,140,255,0.12), rgba(255,58,111,0.16))',
          boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.06)',
        }}
      >
        <div
          aria-hidden
          className="absolute -top-10 -right-6 w-40 h-40 rounded-full"
          style={{
            background: 'radial-gradient(closest-side, rgba(208,140,255,0.35), transparent)',
            filter: 'blur(10px)',
          }}
        />
        <div className="relative flex items-center gap-4">
          <div
            aria-hidden
            className="w-14 h-14 rounded-2xl inline-flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg,#d08cff,#ff3a6f)',
              boxShadow: '0 8px 24px -8px rgba(208,140,255,0.55), inset 0 0 0 1px rgba(255,255,255,0.2)',
            }}
          >
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5z" />
            </svg>
          </div>
          <div className="flex-1">
            <div className="t-primary text-title font-semibold">Приватність</div>
            <div className="t-tertiary text-meta">
              Історія браузерів, Recent Items, QuickLook, shell history.
            </div>
          </div>
          <div className="text-right">
            <div className="t-primary tabular-nums text-title font-semibold">
              {formatBytes(total)}
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto">
        {error && <div className="p-4 t-danger text-body">Помилка: {error}</div>}
        {!error && !items && <div className="flex items-center justify-center h-full"><Spinner /></div>}
        {items && items.length === 0 && <EmptyState title="Нічого не знайдено" />}
        {items && items.length > 0 && (
          <ul className="divide-y hair">
            {items.map((i) => {
              const tint = CAT_TINT[i.category] ?? CAT_TINT.system;
              return (
                <li key={i.path} className="px-4 py-2 flex items-center gap-3 hover:bg-white/[0.03]">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="t-primary text-body font-medium truncate">{i.label}</span>
                      <span
                        className="shrink-0 inline-flex items-center gap-1 px-1.5 py-px rounded text-[10px] t-secondary"
                        style={{ background: tint.bg }}
                      >
                        <span aria-hidden className="w-1.5 h-1.5 rounded-full" style={{ background: tint.dot }} />
                        {i.category}
                      </span>
                    </div>
                    <div className="t-tertiary text-meta truncate" title={i.path}>{i.path}</div>
                  </div>
                  <div className="t-primary tabular-nums shrink-0">{formatBytes(i.size_bytes)}</div>
                  <Button size="sm" variant="ghost" onClick={() => revealItemInDir(i.path).catch(() => undefined)}>
                    Показати
                  </Button>
                  <Button size="sm" variant="soft" tone="danger" onClick={() => setPending(i)}>
                    У кошик
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={pending !== null}
        title="Видалити слід активності?"
        description={
          pending
            ? `${pending.label} — ${pending.path}\n\nБуде переміщено у кошик. Деякі застосунки автоматично відтворять файл при наступному запуску.`
            : undefined
        }
        confirmLabel="У кошик"
        tone="danger"
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      />
    </div>
  );
};
