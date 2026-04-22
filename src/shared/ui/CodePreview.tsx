import type { CodeLanguage } from '../util/fileKind';
import { LazyMarkdown } from './LazyMarkdown';

type CodePreviewProps = {
  /// The source code to render. Trailing newlines are fine — the
  /// underlying markdown pipeline trims the fence for us.
  code: string;
  /// Highlight.js grammar key. Must be one of the curated languages
  /// wired up in `shared/ui/Markdown.tsx`. Falls back to plaintext.
  language?: CodeLanguage;
  /// Optional filename shown above the code block (monospace).
  /// Rendered lazily — if absent, the block has no header chrome.
  filename?: string | null;
  className?: string;
};

/// Escape fence that can't appear verbatim in typical source code,
/// so pasted content never terminates our synthetic block early. Five
/// backticks is a valid CommonMark fence and highlight.js doesn't care.
const FENCE = '`````';

/// Shared read-only code viewer. Funnels through the existing `Markdown`
/// chunk so that a `.tsx` file, a fenced block inside a markdown note,
/// and an AI-chat code reply all share one renderer, one theme, and
/// the same "copy" button behaviour.
///
/// Heavier dependencies (react-markdown + highlight.js) load on first
/// mount via `LazyMarkdown`.
export const CodePreview = ({
  code,
  language,
  filename,
  className,
}: CodePreviewProps) => {
  const lang = language ?? 'plaintext';
  const source = `${FENCE}${lang}\n${code}\n${FENCE}`;
  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ''}`}>
      {filename && (
        <div
          className="text-[11px] font-mono text-white/45 truncate"
          title={filename}
        >
          {filename}
        </div>
      )}
      <LazyMarkdown source={source} codeCopy />
    </div>
  );
};
