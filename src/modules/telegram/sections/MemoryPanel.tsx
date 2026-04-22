import { useCallback, useEffect, useState } from 'react';

import { IconButton } from '../../../shared/ui/IconButton';
import { Spinner } from '../../../shared/ui/Spinner';
import * as api from '../api';
import type { MemoryRow } from '../types';

/// View + delete for the assistant's memory facts. Mutation still
/// flows through the bot (`/remember`) or via tool-use — the UI is a
/// read-and-prune surface on top.
export function MemoryPanel() {
  const [rows, setRows] = useState<MemoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRows(await api.listMemory());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onDelete = async (id: number) => {
    setBusyId(id);
    try {
      await api.deleteMemory(id);
      setRows((prev) => (prev ?? []).filter((r) => r.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  if (rows === null) {
    return (
      <div className="py-3 flex items-center gap-2 t-tertiary text-meta">
        <Spinner size={14} /> Loading facts…
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="py-3 t-tertiary text-meta">
        No facts yet. Tell the bot
        {' '}
        <code className="t-primary">/remember &lt;fact&gt;</code>
        {' '}
        (or let it call <code>remember_fact</code> while answering) to start.
      </div>
    );
  }

  return (
    <>
      {error && (
        <div role="alert" className="py-3 t-danger text-meta">
          {error}
        </div>
      )}
      {rows.map((row) => (
        <div
          key={row.id}
          className="flex items-start justify-between gap-3 py-3"
        >
          <span className="flex-1 min-w-0 t-primary text-body break-words">
            {row.fact}
          </span>
          <IconButton
            title={`Delete fact ${row.id}`}
            tone="danger"
            disabled={busyId === row.id}
            onClick={() => onDelete(row.id)}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2m-9 0v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V7" />
            </svg>
          </IconButton>
        </div>
      ))}
    </>
  );
}
