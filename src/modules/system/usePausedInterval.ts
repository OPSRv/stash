import { useEffect, useRef } from 'react';

/// Polls `fn` every `ms` milliseconds, pausing while the document is
/// hidden (tab switched away, window minimised). This is the page-
/// visibility equivalent of `setInterval` — gives us live dashboards
/// without burning CPU when the user isn't looking at them.
export const usePausedInterval = (fn: () => void, ms: number, enabled = true) => {
  const savedFn = useRef(fn);
  useEffect(() => {
    savedFn.current = fn;
  }, [fn]);

  useEffect(() => {
    if (!enabled) return;
    let intervalId: number | null = null;
    const start = () => {
      if (intervalId !== null) return;
      savedFn.current();
      intervalId = window.setInterval(() => savedFn.current(), ms);
    };
    const stop = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };
    const onVis = () => {
      if (document.hidden) stop();
      else start();
    };
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      stop();
    };
  }, [ms, enabled]);
};
