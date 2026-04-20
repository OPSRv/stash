import { Children, isValidElement, useMemo, type ReactElement, type ReactNode } from 'react';
import type { Components } from 'react-markdown';

import { LazyMarkdown } from '../../shared/ui/LazyMarkdown';
import { EmptyState } from '../../shared/ui/EmptyState';
import { NoteIcon } from '../../shared/ui/icons';
import { isAudioSrc } from './audioEmbed';
import { LinkEmbed } from './LinkEmbed';
import { MarkdownAudioPlayer } from './MarkdownAudioPlayer';

/// Detect a paragraph whose only meaningful child is a single autolinked URL
/// (`<a href="X">X</a>`). Those should render as rich embeds instead of plain
/// text — inline links inside prose stay untouched. We strip empty text nodes
/// so trailing whitespace from the markdown source doesn't disqualify it.
const baremUrlHref = (children: ReactNode): string | null => {
  const meaningful = Children.toArray(children).filter(
    (c) => !(typeof c === 'string' && c.trim() === ''),
  );
  if (meaningful.length !== 1) return null;
  const only = meaningful[0];
  if (!isValidElement(only)) return null;
  const props = (only as ReactElement<{ href?: unknown; children?: ReactNode }>).props;
  const href = typeof props.href === 'string' ? props.href : null;
  if (!href || !/^https?:\/\//i.test(href)) return null;
  // Anchor's visible text equals the href → autolinked bare URL.
  const inner = Children.toArray(props.children).join('').toString().trim();
  return inner === href ? href : null;
};

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
        const href = baremUrlHref(children);
        if (href) return <LinkEmbed href={href} />;
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
      <LazyMarkdown source={source} components={components} />
    </div>
  );
};
