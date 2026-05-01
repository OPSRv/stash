import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { CenterSpinner } from '../../shared/ui/CenterSpinner';
import { EmptyState } from '../../shared/ui/EmptyState';
import { ListItemRow } from '../../shared/ui/ListItemRow';
import { PanelHeader } from '../../shared/ui/PanelHeader';
import { RevealButton } from '../../shared/ui/RevealButton';
import { Spinner } from '../../shared/ui/Spinner';
import { Toggle } from '../../shared/ui/Toggle';
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
          title: enable ? 'Started' : 'Stopped',
          description: agent.label,
          variant: 'success',
        });
        refresh();
      } catch (e) {
        toast({
          title: 'Failed to toggle',
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
      <ListItemRow
        key={a.path}
        className="hover:[background:var(--bg-hover)]"
        leading={
          <span
            aria-hidden
            className="w-2 h-2 rounded-full"
            style={{
              background: loaded ? '#7ef7a5' : 'rgba(255,255,255,0.2)',
              boxShadow: loaded ? '0 0 6px #7ef7a599' : 'none',
            }}
          />
        }
        title={a.label}
        meta={
          <span title={a.path}>
            {a.path}
            {a.pid !== null && ` · PID ${a.pid}`}
          </span>
        }
        trailing={
          <>
            <RevealButton path={a.path} />
            <Toggle
              checked={loaded}
              onChange={() => handleToggle(a)}
              label={loaded ? 'Disable agent' : 'Enable agent'}
            />
            {busyPath === a.path && <Spinner size={12} />}
          </>
        }
      />
    );
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <PanelHeader
        gradient={['#7ef7a5', '#17b26a']}
        icon={
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 2v6M12 22v-4M4 12H2M22 12h-2M5 5l1.5 1.5M19 19l-1.5-1.5M5 19l1.5-1.5M19 5l-1.5 1.5" />
          </svg>
        }
        title="Login items"
        description="User and system LaunchAgents. System-level requires sudo to toggle."
        trailing={
          <Button size="sm" variant="ghost" onClick={refresh}>
            Refresh
          </Button>
        }
      />

      <div className="flex-1 min-h-0 overflow-auto">
        {error && <div className="p-4 t-danger text-body">Error: {error}</div>}
        {!error && !agents && <CenterSpinner />}
        {!error && agents && agents.length === 0 && (
          <EmptyState title="No agents found" />
        )}
        {agents && userAgents.length > 0 && (
          <>
            <div className="px-4 py-1.5 t-tertiary text-meta uppercase tracking-wider border-b hair">
              User ({userAgents.length})
            </div>
            <ul className="divide-y hair">{userAgents.map(renderRow)}</ul>
          </>
        )}
        {agents && systemAgents.length > 0 && (
          <>
            <div className="px-4 py-1.5 t-tertiary text-meta uppercase tracking-wider border-b hair border-t">
              System ({systemAgents.length})
            </div>
            <ul className="divide-y hair">{systemAgents.map(renderRow)}</ul>
          </>
        )}
      </div>
    </div>
  );
};
