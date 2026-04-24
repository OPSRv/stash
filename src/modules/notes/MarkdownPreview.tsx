import { Children, isValidElement, useMemo, type ReactElement, type ReactNode } from 'react';
import type { Components } from 'react-markdown';

import { LazyMarkdown } from '../../shared/ui/LazyMarkdown';
import { EmptyState } from '../../shared/ui/EmptyState';
import { NoteIcon } from '../../shared/ui/icons';
import { isAudioSrc, isImageSrc } from './audioEmbed';
import { LinkEmbed } from './LinkEmbed';
import { MarkdownAudioPlayer } from './MarkdownAudioPlayer';
import { MarkdownImageEmbed } from './MarkdownImageEmbed';

/** Local image embeds point at files we've copied into the managed images
 *  dir, which sits under the app-data root. Everything else (http(s), data,
 *  assets) passes through to the native `<img>` renderer. */
const isLocalImagePath = (src: string): boolean => {
  if (!src) return false;
  if (/^(https?:|data:|blob:|asset:)/i.test(src)) return false;
  return isImageSrc(src);
};

/// Walk a paragraph's children looking for the first remark-gfm autolink
/// (`<a href="http…">http…</a>`) and, if present, return the href plus the
/// children with that anchor stripped. This makes the rich-embed preview
/// work not only for a URL alone on its line but also for URLs pasted next
/// to prose ("check this out https://youtu.be/… 🔥"), which users hit far
/// more often than the sterile bare-URL case.
///
/// Anchor-text matching is lenient on purpose — remark-gfm autolink may
/// normalise the visible text (trailing slash, decoded escapes) so
/// `inner === href` misses obvious autolinks. We accept any visible text
/// that *is* a URL, which distinguishes an autolink from a hand-written
/// `[label](url)`.
const extractAutolink = (
  children: ReactNode,
): { href: string; rest: ReactNode[] } | null => {
  const arr = Children.toArray(children);
  // Walk past leading whitespace-only text nodes — but stop at the first
  // meaningful child and require IT to be the autolink. A URL sitting mid-
  // sentence ("see https://… for details") stays a plain anchor, because
  // tearing it out of its prose would butcher the surrounding meaning.
  let i = 0;
  while (i < arr.length) {
    const c = arr[i];
    if (typeof c === 'string' && c.trim() === '') {
      i += 1;
      continue;
    }
    break;
  }
  if (i >= arr.length) return null;
  const first = arr[i];
  if (!isValidElement(first)) return null;
  const props = (first as ReactElement<{ href?: unknown; children?: ReactNode }>).props;
  const href = typeof props.href === 'string' ? props.href : null;
  if (!href || !/^https?:\/\//i.test(href)) return null;
  const innerParts = Children.toArray(props.children).map((cc) =>
    typeof cc === 'string' ? cc : '',
  );
  const inner = innerParts.join('').trim();
  if (!inner) return null;
  const looksAutolinked = inner === href || /^https?:\/\/\S+$/i.test(inner);
  if (!looksAutolinked) return null;
  const rest = arr.filter((_, idx) => idx !== i);
  return { href, rest };
};

/// True when `children` collapse to nothing visible after the autolink is
/// stripped — that is, they are all empty strings or bare whitespace. Used
/// to decide whether to render a trailing `<p>` at all.
const isEmptyChildren = (children: ReactNode[]): boolean =>
  children.every((c) => typeof c === 'string' && c.trim() === '');

/// Detect a paragraph whose only meaningful child is an `<img>` with an
/// audio `src`. React-markdown always wraps standalone `![](…)` in a `<p>`,
/// but our audio player is a block `<div>` — rendering it inside a `<p>`
/// violates HTML nesting rules and triggers a hydration warning. When this
/// pattern matches we bypass the `<p>` wrapper entirely.
const soleAudioImg = (children: ReactNode): { src: string; alt: string } | null => {
  const meaningful = Children.toArray(children).filter(
    (c) => !(typeof c === 'string' && c.trim() === ''),
  );
  if (meaningful.length !== 1) return null;
  const only = meaningful[0];
  if (!isValidElement(only)) return null;
  const props = (only as ReactElement<{ src?: unknown; alt?: unknown }>).props;
  const src = typeof props.src === 'string' ? props.src : null;
  if (!src || !isAudioSrc(src)) return null;
  const alt = typeof props.alt === 'string' ? props.alt : '';
  return { src, alt };
};

type Props = {
  source: string;
  onToggleCheckbox?: (line: number) => void;
};

// remark-gfm parses `- [ ] task` into <li class="task-list-item"> with a
// disabled <input type="checkbox">. We want those checkboxes clickable and
// to call `onToggleCheckbox(line)`. react-markdown strips position info from
// element props by default, so we recover the source line of each task item
// by scanning the raw source once and mapping checkbox occurrences to their
// line numbers in order.
const collectTaskLines = (source: string): number[] => {
  const re = /^\s*([-*+]|\d+\.)\s+\[( |x|X)\]/;
  const out: number[] = [];
  source.split('\n').forEach((line, i) => {
    if (re.test(line)) out.push(i);
  });
  return out;
};

export const MarkdownPreview = ({ source, onToggleCheckbox }: Props) => {
  const taskLines = useMemo(() => collectTaskLines(source), [source]);

  const components: Components = useMemo(() => {
    let taskIndex = 0;
    return {
      input: ({ type, checked, ...rest }) => {
        if (type !== 'checkbox') return <input type={type} {...rest} />;
        const line = taskLines[taskIndex++];
        return (
          <input
            type="checkbox"
            checked={!!checked}
            onChange={() => line !== undefined && onToggleCheckbox?.(line)}
            className="mt-1 cursor-pointer"
            aria-label={checked ? 'Mark as not done' : 'Mark as done'}
          />
        );
      },
      // Markdown image syntax `![caption](/path/to/file.mp3)` with an audio
      // extension renders as an inline player rather than a broken `<img>`.
      // Non-audio srcs fall through to the default image rendering, so
      // existing screenshot / diagram embeds continue to work untouched.
      img: ({ src, alt, ...rest }) => {
        if (typeof src === 'string' && isAudioSrc(src)) {
          return <MarkdownAudioPlayer src={src} caption={alt || undefined} />;
        }
        if (typeof src === 'string' && isLocalImagePath(src)) {
          return <MarkdownImageEmbed src={src} alt={alt || undefined} />;
        }
        // eslint-disable-next-line @next/next/no-img-element
        return <img src={src} alt={alt ?? ''} {...rest} />;
      },
      // A paragraph that contains only an autolinked URL becomes a rich
      // embed — YouTube renders as an inline player, everything else gets an
      // og-driven preview card. Inline links inside prose pass through as
      // normal anchors. A paragraph containing only an audio `![](…)` embed
      // skips the `<p>` wrapper so the block-level player doesn't violate
      // HTML nesting.
      p: ({ children, ...rest }) => {
        const link = extractAutolink(children);
        if (link) {
          // Render the embed above any surrounding prose. If everything
          // except the URL was whitespace, drop the trailing `<p>` so
          // the preview doesn't leave an empty gap beneath the embed.
          const trimmed = isEmptyChildren(link.rest);
          return (
            <>
              <LinkEmbed href={link.href} />
              {!trimmed && <p {...rest}>{link.rest}</p>}
            </>
          );
        }
        const audio = soleAudioImg(children);
        if (audio) return <MarkdownAudioPlayer src={audio.src} caption={audio.alt || undefined} />;
        return <p {...rest}>{children}</p>;
      },
    };
  }, [onToggleCheckbox, taskLines]);

  if (!source.trim()) {
    return (
      <EmptyState
        variant="compact"
        icon={<NoteIcon size={24} />}
        title="Nothing to preview yet"
        description="Switch to Edit to start writing, or drop markdown into the editor on the left."
      />
    );
  }

  return (
    <div className="notes-md">
      <LazyMarkdown source={source} components={components} codeCopy />
    </div>
  );
};
