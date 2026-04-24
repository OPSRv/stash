import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdownLang from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import 'highlight.js/styles/github-dark.css';
import { accent } from '../theme/accent';
import { copyText } from '../util/clipboard';

// rehype-highlight ships with all ~190 highlight.js languages by default,
// dragging ~250 KB of grammar into every chunk that touches the markdown
// renderer (Notes preview, AI chat). Almost no real note or chat fence
// uses anything outside this set, so curating cuts the markdown chunk by
// more than half with no user-visible impact.
const HLJS_LANGUAGES = {
  bash,
  shell: bash,
  sh: bash,
  zsh: bash,
  css,
  diff,
  go,
  java,
  javascript,
  js: javascript,
  jsx: javascript,
  json,
  markdown: markdownLang,
  md: markdownLang,
  plaintext,
  text: plaintext,
  python,
  py: python,
  rust,
  rs: rust,
  sql,
  typescript,
  ts: typescript,
  tsx: typescript,
  xml,
  html: xml,
  yaml,
  yml: yaml,
};

type MarkdownProps = {
  source: string;
  className?: string;
  /** Show a floating "copy" button in the top-right of every fenced code block. */
  codeCopy?: boolean;
  /** Extra component overrides. Merged on top of defaults. */
  components?: Components;
};

// Reject script-style schemes so pasted/AI/clipboard markdown can't execute
// arbitrary code via [text](javascript:…). Allow relative links and the
// usual http(s)/mailto/tel.
const safeHref = (href: string | undefined): string | undefined => {
  if (!href) return href;
  const trimmed = href.trim();
  if (/^(javascript|vbscript|data|file):/i.test(trimmed)) return undefined;
  return href;
};

const baseAnchor: Components['a'] = ({ href, children, ...rest }) => {
  const safe = safeHref(href);
  return (
    <a
      {...rest}
      href={safe}
      target="_blank"
      rel="noreferrer noopener"
      className="text-[color:rgba(var(--stash-accent-rgb),1)] underline decoration-dotted"
    >
      {children}
    </a>
  );
};

const MermaidLazy = lazy(() =>
  import('./MermaidBlock').then((m) => ({ default: m.MermaidBlock })),
);

const MermaidSuspense = ({ source }: { source: string }) => (
  <Suspense
    fallback={
      <div className="md-mermaid-loading t-tertiary text-meta py-2">
        rendering diagram…
      </div>
    }
  >
    <MermaidLazy source={source} />
  </Suspense>
);

// Loose hast shapes — avoids pulling `@types/hast` just for one plugin.
type HastText = { type: 'text'; value: string };
type HastElement = {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown> & { className?: unknown };
  children: HastNode[];
};
type HastRoot = { type: 'root'; children: HastNode[] };
type HastNode = HastElement | HastText | HastRoot | { type: string; [k: string]: unknown };

const hasMermaidClass = (cls: unknown): boolean => {
  if (typeof cls === 'string') return cls.split(/\s+/).includes('language-mermaid');
  if (Array.isArray(cls)) return cls.some((c) => c === 'language-mermaid');
  return false;
};

const collectText = (node: HastNode): string => {
  if (!node || typeof node !== 'object') return '';
  if ((node as HastText).type === 'text') return (node as HastText).value;
  const children = (node as HastElement).children;
  if (Array.isArray(children)) return children.map(collectText).join('');
  return '';
};

/// Replace each `<pre><code class="language-mermaid">…</code></pre>`
/// with a marker `<div data-mermaid-source="…">` BEFORE rehype-highlight
/// runs. This preserves the raw diagram text (rehype-highlight would
/// otherwise shatter it into token spans, which drops newlines in
/// non-highlighted languages like mermaid) and lets the React-side
/// override render it as SVG.
const rehypeMermaid = () => (tree: HastRoot) => {
  const walk = (nodes: HastNode[]) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n && (n as HastElement).type === 'element') {
        const el = n as HastElement;
        if (el.tagName === 'pre') {
          const codeEl = el.children?.find(
            (c) => (c as HastElement).type === 'element' && (c as HastElement).tagName === 'code',
          ) as HastElement | undefined;
          if (codeEl && hasMermaidClass(codeEl.properties?.className)) {
            const raw = collectText(codeEl).replace(/\n$/, '');
            nodes[i] = {
              type: 'element',
              tagName: 'div',
              properties: { 'data-mermaid-source': raw },
              children: [],
            };
            continue;
          }
        }
        if (Array.isArray(el.children)) walk(el.children);
      }
    }
  };
  walk(tree.children);
};

const CodeBlock = ({
  children,
  className,
  ...rest
}: {
  children?: ReactNode;
  className?: string;
}) => {
  const [copied, setCopied] = useState(false);
  // rehype-highlight rewrites the code's children into a tree of highlighted
  // <span> tokens, so `String(children)` is meaningless. Read the rendered
  // text content from the DOM instead — always correct, always cheap.
  const codeRef = useRef<HTMLElement | null>(null);
  const resetTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    },
    [],
  );
  const onCopy = async () => {
    const text = (codeRef.current?.textContent ?? '').replace(/\n$/, '');
    if (!(await copyText(text))) return;
    setCopied(true);
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = window.setTimeout(() => {
      resetTimerRef.current = null;
      setCopied(false);
    }, 1400);
  };
  return (
    <div className="relative group">
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copy code"
        className="absolute top-2 right-2 text-meta px-2 py-0.5 rounded-md opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
        style={{ background: accent(0.14) }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre>
        <code ref={codeRef} className={className} {...rest}>
          {children}
        </code>
      </pre>
    </div>
  );
};

/// Shared markdown renderer. Uses react-markdown + remark-gfm + rehype-highlight
/// (highlight.js / github-dark). Used by Notes preview and the AI Chat thread.
/// Streaming-safe: re-renders on every token and partial code fences/bold
/// tokens just render as partial.
export const Markdown = ({ source, className, codeCopy, components }: MarkdownProps) => {
  const merged: Components = useMemo(() => {
    const base: Components = { a: baseAnchor };
    // ```mermaid fences are rewritten by `rehypeMermaid` into a
    // `<div data-mermaid-source="…">` marker (see plugin) so the
    // diagram source survives rehype-highlight untouched. Intercept
    // that marker here and hand it to the lazy SVG renderer.
    base.div = ({ children, ...rest }) => {
      const src = (rest as { 'data-mermaid-source'?: unknown })['data-mermaid-source'];
      if (typeof src === 'string') return <MermaidSuspense source={src} />;
      return <div {...rest}>{children}</div>;
    };
    if (codeCopy) {
      // react-markdown passes `inline` only for `` `x` ``; fenced blocks come
      // through as the nested <pre><code>, so we replace `pre` with our
      // copy-enabled wrapper and leave inline code untouched.
      base.pre = ({ children }) => {
        const child = Array.isArray(children) ? children[0] : children;
        const codeProps =
          child && typeof child === 'object' && 'props' in child
            ? (child as { props: { children?: ReactNode; className?: string } }).props
            : { children: '', className: undefined };
        return (
          <CodeBlock className={codeProps.className}>
            {codeProps.children}
          </CodeBlock>
        );
      };
    }
    return { ...base, ...(components ?? {}) };
  }, [codeCopy, components]);

  if (!source) return null;

  // `.md-body` carries the shared paragraph/list/code spacing — without it,
  // the browser default of margin: 0 on <p> etc. squashes everything together.
  const rootClass = `md-body ${className ?? 't-primary text-body'}`;

  return (
    <div className={rootClass}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          rehypeMermaid,
          [rehypeHighlight, { languages: HLJS_LANGUAGES, ignoreMissing: true }],
        ]}
        components={merged}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
};
