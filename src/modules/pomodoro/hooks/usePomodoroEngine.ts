import { useCallback, useEffect, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  getState,
  type BlockChangedEvent,
  type NudgeEvent,
  type SessionDoneEvent,
  type SessionSnapshot,
} from '../api';

export interface EngineCallbacks {
  onTransition?: (ev: BlockChangedEvent) => void;
  onNudge?: (ev: NudgeEvent) => void;
  onDone?: (ev: SessionDoneEvent) => void;
}

const IDLE: SessionSnapshot = {
  status: 'idle',
  blocks: [],
  current_idx: 0,
  remaining_ms: 0,
  started_at: 0,
  preset_id: null,
};

/// Subscribes to the pomodoro engine's Rust-side events and exposes the
/// latest snapshot to React. The hook never drives time itself — `remaining_ms`
/// is refreshed from `pomodoro:tick`, not a JS interval — so the timer stays
/// accurate across popup hide, webview unload, and sleep/wake cycles.
export const usePomodoroEngine = (cb: EngineCallbacks = {}) => {
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(IDLE);
  const cbRef = useRef(cb);
  cbRef.current = cb;

  useEffect(() => {
    let mounted = true;
    const unlisteners: UnlistenFn[] = [];
    const addListener = async (
      name: string,
      handler: (ev: { payload: unknown }) => void,
    ) => {
      const un = await listen(name, handler);
      if (!mounted) un();
      else unlisteners.push(un);
    };

    getState()
      .then((s) => {
        if (mounted) setSnapshot(s);
      })
      .catch(() => {});

    void addListener('pomodoro:state', (ev) =>
      setSnapshot(ev.payload as SessionSnapshot),
    );
    void addListener('pomodoro:tick', (ev) =>
      setSnapshot(ev.payload as SessionSnapshot),
    );
    void addListener('pomodoro:block_changed', (ev) =>
      cbRef.current.onTransition?.(ev.payload as BlockChangedEvent),
    );
    void addListener('pomodoro:nudge', (ev) =>
      cbRef.current.onNudge?.(ev.payload as NudgeEvent),
    );
    void addListener('pomodoro:session_done', (ev) =>
      cbRef.current.onDone?.(ev.payload as SessionDoneEvent),
    );

    return () => {
      mounted = false;
      unlisteners.forEach((un) => un());
    };
  }, []);

  const refresh = useCallback(async () => {
    const s = await getState();
    setSnapshot(s);
    return s;
  }, []);

  return { snapshot, refresh };
};
