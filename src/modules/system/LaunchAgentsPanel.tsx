import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { Spinner } from '../../shared/ui/Spinner';
import { Toggle } from '../../shared/ui/Toggle';
import { EmptyState } from '../../shared/ui/EmptyState';
import { RevealButton } from '../../shared/ui/RevealButton';
import { useToast } from '../../shared/ui/Toast';
import {
  listLaunchAgents,
  toggleLaunchAgent,
  type LaunchAgent,
} from './api';

export const LaunchAgentsPanel = () => {
  const [agents, setAgents] = useState<LaunchAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    try {
      const list = await listLaunchAgents();
      setAgents(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleToggle = useCallback(
    async (agent: LaunchAgent) => {
      setBusyPath(agent.path);
      const enable = agent.disabled || agent.pid === null;
      try {
        await toggleLaunchAgent(agent.path, enable);
        toast({
          title: enable ? 'Запущено' : 'Зупинено',
          description: agent.label,
          variant: 'success',
        });
        refresh();
      } catch (e) {
        toast({
          title: 'Не вдалося перемкнути',
          description: String(e),
          variant: 'error',
        });
      } finally {
        setBusyPath(null);
      }
    },
    [refresh, toast],
  );

  const userAgents = agents?.filter((a) => a.scope === 'user') ?? [];
  const systemAgents = agents?.filter((a) => a.scope === 'system') ?? [];

  const renderRow = (a: LaunchAgent) => {
    const loaded = a.pid !== null && !a.disabled;
    return (
      <li
        key={a.path}
        className="px-4 py-2 flex items-center gap-3 hover:bg-white/[0.03]"
      >
        <span
          aria-hidden
          className="shrink-0 w-2 h-2 rounded-full"
          style={{
            background: loaded ? '#7ef7a5' : 'rgba(255,255,255,0.2)',
            boxShadow: loaded ? '0 0 6px #7ef7a599' : 'none',
          }}
        />
        <div className="min-w-0 flex-1">
          <div className="t-primary text-body font-medium truncate">{a.label}</div>
          <div className="t-tertiary text-meta truncate" title={a.path}>
            {a.path}
            {a.pid !== null && ` · PID ${a.pid}`}
          </div>
        </div>
        <RevealButton path={a.path} />
        <Toggle
          checked={loaded}
          onChange={() => handleToggle(a)}
          label={loaded ? 'Вимкнути агент' : 'Увімкнути агент'}
        />
        {busyPath === a.path && <Spinner size={12} />}
      </li>
    );
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header
        className="px-4 py-3 relative overflow-hidden"
        style={{
          background:
            'linear-gradient(135deg, rgba(126,247,165,0.12), rgba(23,178,106,0.18))',
          boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.06)',
        }}
      >
        <div
          aria-hidden
          className="absolute -top-12 -right-6 w-40 h-40 rounded-full"
          style={{
            background: 'radial-gradient(closest-side, rgba(23,178,106,0.35), transparent)',
            filter: 'blur(10px)',
          }}
        />
        <div className="relative flex items-center gap-4">
          <div
            aria-hidden
            className="w-14 h-14 rounded-2xl inline-flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg,#7ef7a5,#17b26a)',
              boxShadow: '0 8px 24px -8px rgba(23,178,106,0.55), inset 0 0 0 1px rgba(255,255,255,0.2)',
            }}
          >
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 2v6M12 22v-4M4 12H2M22 12h-2M5 5l1.5 1.5M19 19l-1.5-1.5M5 19l1.5-1.5M19 5l-1.5 1.5" />
            </svg>
          </div>
          <div className="flex-1">
            <div className="t-primary text-title font-semibold">Автозапуск</div>
            <div className="t-tertiary text-meta">
              LaunchAgents користувача та системні. System-рівень потребує sudo при перемиканні.
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={refresh}>
            Оновити
          </Button>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto">
        {error && <div className="p-4 t-danger text-body">Помилка: {error}</div>}
        {!error && !agents && (
          <div className="flex items-center justify-center h-full">
            <Spinner />
          </div>
        )}
        {!error && agents && agents.length === 0 && (
          <EmptyState title="Агентів не знайдено" />
        )}
        {agents && userAgents.length > 0 && (
          <>
            <div className="px-4 py-1.5 t-tertiary text-meta uppercase tracking-wider border-b hair">
              Користувацькі ({userAgents.length})
            </div>
            <ul className="divide-y hair">{userAgents.map(renderRow)}</ul>
          </>
        )}
        {agents && systemAgents.length > 0 && (
          <>
            <div className="px-4 py-1.5 t-tertiary text-meta uppercase tracking-wider border-b hair border-t">
              Системні ({systemAgents.length})
            </div>
            <ul className="divide-y hair">{systemAgents.map(renderRow)}</ul>
          </>
        )}
      </div>
    </div>
  );
};
