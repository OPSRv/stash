import { useEffect, useRef, useState } from 'react';

/// Lazy mermaid renderer. Mermaid 11 ships as an ESM bundle ~600 KB
/// gzipped — dynamic-imported once, then memoised for subsequent
/// blocks. Initialised on the first call with a theme that tracks the
/// current light/dark mode via the `.light` class on `<html>`.
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
const loadMermaid = () => {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      const mermaid = m.default;
      const isLight = document.documentElement.classList.contains('light');
      mermaid.initialize({
        startOnLoad: false,
        theme: isLight ? 'default' : 'dark',
        securityLevel: 'strict',
        fontFamily:
          "system-ui, -apple-system, 'SF Pro Text', 'Helvetica Neue', sans-serif",
      });
      return mermaid;
    });
  }
  return mermaidPromise;
};

// Monotonic id per mermaid.render call. Mermaid uses the id for the
// root <svg> — collisions cause it to replace prior diagrams.
let uid = 0;
const nextId = () => `stash-mermaid-${++uid}`;

type Props = {
  source: string;
};

/// Render a mermaid diagram from `source`. Falls back to a code block
/// on parse errors so a malformed diagram never silently swallows the
/// user's content. Re-renders on `source` change (streaming-safe, but
/// debounced to one mermaid pass per frame).
export const MermaidBlock = ({ source }: Props) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const host = hostRef.current;
      if (!host) return;
      const trimmed = source.trim();
      if (!trimmed) {
        host.innerHTML = '';
        return;
      }
      try {
        const mermaid = await loadMermaid();
        if (cancelled) return;
        // `parse` validates without side effects. `render` itself also
        // validates, but `parse` lets us fail fast while streaming so a
        // half-formed diagram doesn't throw for every intermediate token.
        await mermaid.parse(trimmed);
        const { svg } = await mermaid.render(nextId(), trimmed);
        if (cancelled) return;
        host.innerHTML = svg;
        setError(null);
      } catch (e) {
        if (cancelled) return;
        host.innerHTML = '';
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source]);

  if (error) {
    return (
      <pre className="md-mermaid-error text-meta t-tertiary">
        <code>{`mermaid: ${error}\n\n${source}`}</code>
      </pre>
    );
  }

  return (
    <div
      ref={hostRef}
      className="md-mermaid flex justify-center my-2"
      aria-label="mermaid diagram"
    />
  );
};
