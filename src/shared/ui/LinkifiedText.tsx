import type { MouseEvent, ReactNode } from 'react';
import { Tooltip } from './Tooltip';

type LinkifiedTextProps = {
  /// Raw text, possibly containing URLs. Preserves whitespace and
  /// line breaks with `whitespace-pre-wrap`, so multi-line bot
  /// messages render as-they-were-typed.
  content: string;
  className?: string;
};

// Conservative URL matcher: requires a scheme (http / https) so we
// don't grab ambiguous things like "example.com" that could be a
// product name. www-prefixed bare hosts also match so the common
// "www.tauri.app/foo" paste still works. Stops at whitespace and a
// few sentence-ending punctuators so a trailing period doesn't end
// up inside the href.
const URL_RE =
  /((?:https?:\/\/|www\.)[^\s<>"'`)]+[^\s<>"'`).,;:!?])/gi;

const normaliseHref = (raw: string): string => {
  if (/^[a-z]+:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
};

/// Pull every URL out of `text` in order of appearance. Shared helper
/// so callers (e.g. TextItem's action row) don't re-implement the
/// matching logic.
export const extractUrls = (text: string): string[] => {
  const out: string[] = [];
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) out.push(normaliseHref(m[0]));
  return out;
};

/// Open a URL in the user's default browser via the Tauri opener
/// plugin. Falls back to `window.open` when the plugin is missing.
export const openExternalUrl = async (url: string): Promise<void> => {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
};

const onAnchorClick = (
  e: MouseEvent<HTMLAnchorElement>,
  href: string,
) => {
  e.preventDefault();
  void openExternalUrl(href);
};

/// Render text with embedded URLs turned into clickable anchors that
/// open through the Tauri opener plugin (external browser, not the
/// popup webview). Non-URL content stays as plain text, preserving
/// whitespace and newlines.
export const LinkifiedText = ({ content, className }: LinkifiedTextProps) => {
  const nodes: ReactNode[] = [];
  let last = 0;
  URL_RE.lastIndex = 0;
  // `matchAll` would be nicer, but `.exec` with a global regex keeps
  // us compatible with older ES targets and gives us the explicit
  // lastIndex reset above.
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(content)) !== null) {
    if (m.index > last) {
      nodes.push(content.slice(last, m.index));
    }
    const raw = m[0];
    const href = normaliseHref(raw);
    nodes.push(
      <Tooltip key={`${m.index}-${raw}`} label={href}>
        <a
          href={href}
          onClick={(e) => onAnchorClick(e, href)}
          className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
          style={{ color: 'rgb(var(--stash-accent-rgb))' }}
        >
          {raw}
        </a>
      </Tooltip>,
    );
    last = m.index + raw.length;
  }
  if (last < content.length) {
    nodes.push(content.slice(last));
  }
  return (
    <p
      className={
        className ??
        'text-[13px] leading-[18px] text-white/90 whitespace-pre-wrap'
      }
    >
      {nodes.length > 0 ? nodes : content}
    </p>
  );
};
