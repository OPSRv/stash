import { createContext, useCallback, useContext, useRef, type ReactNode } from 'react';

type Politeness = 'polite' | 'assertive';

type Ctx = {
  announce: (message: string, politeness?: Politeness) => void;
};

const LiveRegionContext = createContext<Ctx | null>(null);

export const LiveRegionProvider = ({ children }: { children: ReactNode }) => {
  const politeRef = useRef<HTMLDivElement>(null);
  const assertiveRef = useRef<HTMLDivElement>(null);

  const announce = useCallback((message: string, politeness: Politeness = 'polite') => {
    const el = politeness === 'assertive' ? assertiveRef.current : politeRef.current;
    if (!el) return;
    // Clear first so screen readers re-announce identical messages.
    el.textContent = '';
    window.setTimeout(() => {
      if (el) el.textContent = message;
    }, 30);
  }, []);

  return (
    <LiveRegionContext.Provider value={{ announce }}>
      {children}
      <div
        ref={politeRef}
        aria-live="polite"
        aria-atomic="true"
        role="status"
        data-testid="live-region-polite"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0,0,0,0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      />
      <div
        ref={assertiveRef}
        aria-live="assertive"
        aria-atomic="true"
        role="alert"
        data-testid="live-region-assertive"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0,0,0,0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      />
    </LiveRegionContext.Provider>
  );
};

export const useAnnounce = () => {
  const ctx = useContext(LiveRegionContext);
  if (!ctx) {
    // No-op fallback so components don't crash when provider is absent (tests, storybook).
    return { announce: () => {} };
  }
  return ctx;
};
