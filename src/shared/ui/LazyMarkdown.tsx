import { lazy, Suspense, type ComponentProps } from 'react';

/// Lazy wrapper around the heavy `Markdown` renderer. The underlying chunk
/// pulls react-markdown + remark-gfm + rehype-highlight + curated highlight.js
/// grammars (~242 KB raw / ~75 KB gzip). Importing it eagerly would mean
/// every code path that *might* render markdown — opening Notes, AI tab, or
/// Settings — pays the cost on first mount, even before the user actually
/// renders any markdown content. With this wrapper the chunk only loads
/// when something asks to render a `<LazyMarkdown source=...>`.
///
/// `import('./Markdown')` is also captured as `preloadMarkdown` so callers
/// that *will* render markdown imminently (e.g. opening the Notes editor)
/// can warm the cache — see TabButton-style hover preloads for prior art.
const load = () =>
  import('./Markdown').then((m) => ({ default: m.Markdown }));

const LazyImpl = lazy(load);

type MarkdownProps = ComponentProps<typeof LazyImpl>;

/// Tiny fallback — markdown chunks finish in a few ms on a warm cache, and
/// in cold cases a flash is preferable to a blocking spinner.
const FALLBACK = <div className="t-tertiary text-meta px-3 py-2">…</div>;

export const LazyMarkdown = (props: MarkdownProps) => (
  <Suspense fallback={FALLBACK}>
    <LazyImpl {...props} />
  </Suspense>
);

/// Eagerly start loading the markdown chunk without rendering. Useful for
/// modules that know they're about to need it (e.g. Notes editor focus).
export const preloadMarkdown = (): Promise<unknown> => load();
