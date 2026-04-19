import { useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import 'highlight.js/styles/github-dark.css';

type MarkdownProps = {
  source: string;
  className?: string;
  /** Show a floating "copy" button in the top-right of every fenced code block. */
  codeCopy?: boolean;
  /** Extra component overrides. Merged on top of defaults. */
  components?: Components;
};

const baseAnchor: Components['a'] = ({ href, children, ...rest }) => (
  <a
    {...rest}
    href={href}
    target="_blank"
    rel="noreferrer noopener"
    className="text-[color:rgba(var(--stash-accent-rgb),1)] underline decoration-dotted"
  >
    {children}
  </a>
);

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
  const onCopy = async () => {
    try {
      const text = (codeRef.current?.textContent ?? '').replace(/\n$/, '');
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // ignore — clipboard may be unavailable in some contexts
    }
  };
  return (
    <div className="relative group">
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copy code"
        className="absolute top-2 right-2 text-meta px-2 py-0.5 rounded-md opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
        style={{ background: 'rgba(255,255,255,0.08)' }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre className={className}>
        <code ref={codeRef} {...rest}>
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
    if (codeCopy) {
      // react-markdown passes `inline` only for `` `x` ``; fenced blocks come
      // through as the nested <pre><code>, so we replace `pre` with our
      // copy-enabled wrapper and leave inline code untouched.
      base.pre = ({ children }) => {
        // Extract language class from the inner code element so
        // rehype-highlight's classes are preserved on the <pre>.
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

  return (
    <div className={className ?? 't-primary text-body'}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={merged}>
        {source}
      </ReactMarkdown>
    </div>
  );
};
