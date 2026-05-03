import {
  Children,
  isValidElement,
  useCallback,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Components } from 'react-markdown';

import { LazyMarkdown } from '../../shared/ui/LazyMarkdown';
import { EmptyState } from '../../shared/ui/EmptyState';
import { ContextMenu, type ContextMenuItem } from '../../shared/ui/ContextMenu';
import { openExternalUrl } from '../../shared/ui/LinkifiedText';
import { useToast } from '../../shared/ui/Toast';
import { copyText } from '../../shared/util/clipboard';
import { NoteIcon } from '../../shared/ui/icons';
import { isAudioSrc, isImageSrc, isVideoSrc, normaliseEmbedSrc } from './audioEmbed';
import { LinkEmbed } from './LinkEmbed';
import { MarkdownAudioPlayer } from './MarkdownAudioPlayer';
import { MarkdownImageEmbed } from './MarkdownImageEmbed';
import { MarkdownVideoEmbed } from './MarkdownVideoEmbed';

/** Local image embeds point at files we've copied into the managed images
 *  dir, which sits under the app-data root. Everything else (http(s), data,
 *  assets) passes through to the native `<img>` renderer. */
const isLocalImagePath = (src: string): boolean => {
  if (!src) return false;
  if (/^(https?:|data:|blob:|asset:)/i.test(src)) return false;
  return isImageSrc(src);
};

/// Walk a paragraph's children looking for a leading `<a href="http…">`
/// (either remark-gfm's autolinked URL or a hand-authored `[label](url)`)
/// and, if present, return the href plus the children with that anchor
/// stripped — so the caller can render a rich `LinkEmbed` above any
/// surviving prose.
///
/// Two flavours, both treated as "this paragraph is a link card":
///
///   1. **Bare autolink** (`https://example.com` becomes `<a>https://…</a>`).
///      Matched leniently — even URLs pasted next to prose ("check this out
///      https://youtu.be/… 🔥") promote, because users paste links that way
///      far more often than alone on a line.
///
///   2. **Markdown link `[label](url)` standalone**, where the entire
///      paragraph is just the link plus whitespace. Inline `[docs](url)`
///      sitting mid-sentence stays a plain anchor — promoting it would
///      shred the surrounding sentence into a link card per word.
const extractEmbedLink = (
  children: ReactNode,
): { href: string; rest: ReactNode[] } | null => {
  const arr = Children.toArray(children);
  // Walk past leading whitespace-only text nodes — but stop at the first
  // meaningful child and require IT to be the anchor.
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
  const rest = arr.filter((_, idx) => idx !== i);

  const looksAutolinked = inner === href || /^https?:\/\/\S+$/i.test(inner);
  if (looksAutolinked) {
    // Lenient: keep any trailing prose so the embed renders above it.
    return { href, rest };
  }

  // Markdown link with custom label — only embed when nothing else of
  // substance sits in the paragraph, so inline anchors stay inline.
  if (isEmptyChildren(rest)) return { href, rest: [] };
  return null;
};

/// True when `children` collapse to nothing visible after the autolink is
/// stripped — that is, they are all empty strings or bare whitespace. Used
/// to decide whether to render a trailing `<p>` at all.
const isEmptyChildren = (children: ReactNode[]): boolean =>
  children.every((c) => typeof c === 'string' && c.trim() === '');

/// `.mp4` / `.webm` overlap audio and video — disambiguate by checking
/// whether the absolute path lives under the managed videos dir. New
/// embeds saved via `notes_save_video_file` always land there; legacy
/// audio recordings stay in `notes/audio/` and keep rendering as audio.
const isManagedVideoPath = (src: string): boolean =>
  /[\\/]notes[\\/]videos[\\/]/.test(decodeURI(src));

const renderableMediaKind = (
  src: string | undefined | null,
): 'audio' | 'video' | null => {
  if (typeof src !== 'string' || !src) return null;
  if (isManagedVideoPath(src)) return 'video';
  if (isAudioSrc(src)) return 'audio';
  // Pure-video extensions that aren't shared with audio (mov, m4v, mkv,
  // avi) can promote regardless of dir — files dropped before the
  // `/notes/videos/` convention still resolve via the attachments scope
  // on the media server.
  if (isVideoSrc(src)) return 'video';
  return null;
};

/// Detect a paragraph whose only meaningful child is an `<img>` whose
/// `src` should render as an audio or video player. React-markdown wraps
/// standalone `![](…)` in a `<p>`, but our players are block `<div>`s —
/// rendering them inside a `<p>` violates HTML nesting and trips a
/// hydration warning. When this pattern matches we bypass the `<p>`.
const soleMediaImg = (
  children: ReactNode,
): { src: string; alt: string; kind: 'audio' | 'video' } | null => {
  const meaningful = Children.toArray(children).filter(
    (c) => !(typeof c === 'string' && c.trim() === ''),
  );
  if (meaningful.length !== 1) return null;
  const only = meaningful[0];
  if (!isValidElement(only)) return null;
  const props = (only as ReactElement<{ src?: unknown; alt?: unknown }>).props;
  const src = typeof props.src === 'string' ? props.src : null;
  const kind = renderableMediaKind(src);
  if (!src || !kind) return null;
  const alt = typeof props.alt === 'string' ? props.alt : '';
  return { src, alt, kind };
};

type Props = {
  source: string;
  onToggleCheckbox?: (line: number) => void;
};

/// Catches bare URLs that remark-gfm's autolinker may miss (parens,
/// trailing punctuation, surrounding non-ASCII) and promotes them to
/// `<https://…>` autolinks so react-markdown always renders them as
/// anchors. Skips URLs already inside `[…](…)`, existing `<…>` autolinks,
/// fenced code, or inline code so we never double-wrap.
const URL_RE = /\bhttps?:\/\/[^\s<>()\[\]]+/g;
const linkifyBareUrls = (src: string): string => {
  const masks: string[] = [];
  const stash = (m: string) => {
    masks.push(m);
    return `\u0001${masks.length - 1}\u0001`;
  };
  let masked = src
    .replace(/```[\s\S]*?```/g, stash)
    .replace(/`[^`\n]+`/g, stash)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, stash)
    .replace(/\[[^\]]+\]\([^)]+\)/g, stash)
    .replace(/<https?:\/\/[^>\s]+>/g, stash);
  masked = masked.replace(URL_RE, (raw) => {
    // Trim trailing punctuation that's almost never part of the URL —
    // sentences end "…visit https://example.com." and the period belongs
    // to the prose, not the link.
    const m = /[).,;:!?'"]+$/.exec(raw);
    const url = m ? raw.slice(0, raw.length - m[0].length) : raw;
    const tail = m ? m[0] : '';
    return `<${url}>${tail}`;
  });
  return masked.replace(/\u0001(\d+)\u0001/g, (_, i) => masks[Number(i)]);
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

type MenuTarget =
  | { kind: 'link'; href: string; selection: string }
  | { kind: 'image'; mdSrc: string; alt: string; selection: string }
  | { kind: 'video'; mdSrc: string; selection: string }
  | { kind: 'default'; selection: string };

const findAnchor = (start: HTMLElement | null): HTMLAnchorElement | null => {
  let el: HTMLElement | null = start;
  while (el) {
    if (el.tagName === 'A' && (el as HTMLAnchorElement).href) {
      return el as HTMLAnchorElement;
    }
    el = el.parentElement;
  }
  return null;
};

const findMdSrc = (
  start: HTMLElement | null,
  tag: 'IMG' | 'VIDEO',
): { el: HTMLElement; mdSrc: string } | null => {
  let el: HTMLElement | null = start;
  while (el) {
    if (el.tagName === tag) {
      const mdSrc = el.getAttribute('data-md-src');
      if (mdSrc) return { el, mdSrc };
    }
    el = el.parentElement;
  }
  return null;
};

export const MarkdownPreview = ({ source, onToggleCheckbox }: Props) => {
  const { toast } = useToast();
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null);

  const handleContextMenu = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    // Only intercept left-pane right-clicks; allow native menus on form
    // controls (selects, native videos with their own menus) by checking
    // for the wrapper data attribute.
    const start = e.target as HTMLElement;
    const sel = window.getSelection()?.toString() ?? '';
    const anchor = findAnchor(start);
    const img = findMdSrc(start, 'IMG');
    const video = findMdSrc(start, 'VIDEO');

    let target: MenuTarget;
    if (anchor && /^https?:\/\//i.test(anchor.href)) {
      target = { kind: 'link', href: anchor.href, selection: sel };
    } else if (img) {
      target = {
        kind: 'image',
        mdSrc: img.mdSrc,
        alt: img.el.getAttribute('alt') ?? '',
        selection: sel,
      };
    } else if (video) {
      target = { kind: 'video', mdSrc: video.mdSrc, selection: sel };
    } else {
      target = { kind: 'default', selection: sel };
    }
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, target });
  }, []);

  const buildMenuItems = useCallback(
    (t: MenuTarget): ContextMenuItem[] => {
      const items: ContextMenuItem[] = [];
      const sel = t.selection.trim();

      const reveal = async (path: string) => {
        try {
          const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
          await revealItemInDir(path);
        } catch (err) {
          toast({ title: 'Reveal failed', description: String(err), variant: 'error' });
        }
      };

      const copyImage = async (path: string) => {
        try {
          await invoke('clipboard_copy_image_from_path', { path });
          toast({ title: 'Image copied', variant: 'success', durationMs: 1400 });
        } catch (err) {
          toast({ title: 'Copy failed', description: String(err), variant: 'error' });
        }
      };

      const doCopy = async (text: string, label = 'Copied') => {
        if (await copyText(text)) {
          toast({ title: label, variant: 'success', durationMs: 1200 });
        } else {
          toast({ title: 'Copy failed', variant: 'error' });
        }
      };

      if (t.kind === 'link') {
        items.push(
          {
            kind: 'action',
            label: 'Open link',
            onSelect: () => void openExternalUrl(t.href),
          },
          {
            kind: 'action',
            label: 'Copy link',
            onSelect: () => void doCopy(t.href, 'Link copied'),
          },
        );
      } else if (t.kind === 'image') {
        items.push(
          {
            kind: 'action',
            label: 'Copy image',
            onSelect: () => void copyImage(t.mdSrc),
          },
          {
            kind: 'action',
            label: 'Copy image path',
            onSelect: () => void doCopy(t.mdSrc, 'Path copied'),
          },
          {
            kind: 'action',
            label: 'Reveal in Finder',
            onSelect: () => void reveal(t.mdSrc),
          },
        );
      } else if (t.kind === 'video') {
        items.push(
          {
            kind: 'action',
            label: 'Copy video path',
            onSelect: () => void doCopy(t.mdSrc, 'Path copied'),
          },
          {
            kind: 'action',
            label: 'Reveal in Finder',
            onSelect: () => void reveal(t.mdSrc),
          },
        );
      }

      if (sel) {
        if (items.length) items.push({ kind: 'separator' });
        items.push({
          kind: 'action',
          label: 'Copy selection',
          shortcut: '⌘C',
          onSelect: () => void doCopy(sel),
        });
        // If the selection is itself a URL, offer to open it.
        if (/^https?:\/\/\S+$/i.test(sel)) {
          items.push({
            kind: 'action',
            label: 'Open as URL',
            onSelect: () => void openExternalUrl(sel),
          });
        }
        items.push({
          kind: 'action',
          label: 'Search the web',
          onSelect: () =>
            void openExternalUrl(
              `https://www.google.com/search?q=${encodeURIComponent(sel)}`,
            ),
        });
      }

      if (items.length) items.push({ kind: 'separator' });
      items.push({
        kind: 'action',
        label: 'Copy all as Markdown',
        onSelect: () => void doCopy(source, 'Note copied'),
      });
      items.push({
        kind: 'action',
        label: 'Copy all as plain text',
        onSelect: () => {
          // Strip the most common markdown noise — fences, emphasis,
          // heading marks, link wrappers — for a paste-into-anything copy.
          const plain = source
            .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ''))
            .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
            .replace(/^#{1,6}\s+/gm, '')
            .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/^>\s?/gm, '');
          void doCopy(plain, 'Plain text copied');
        },
      });
      return items;
    },
    [source, toast],
  );

  // Rewrite stale-format embeds (`![image](/path with space.png)` etc.) before
  // rendering so notes saved before angle-bracket wrapping still display the
  // image instead of leaking the raw markdown text. `normaliseEmbedSrc` is
  // idempotent — already-correct sources pass through untouched. We keep
  // `taskLines` indexed against the *original* source so a click on a
  // checkbox still maps to the user's actual line, not a normalised one.
  const normalised = useMemo(
    () => linkifyBareUrls(normaliseEmbedSrc(source)),
    [source],
  );
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
      // Markdown image syntax `![caption](/path/to/file.ext)` is the
      // single shape our audio/video/image embeds all use; dispatch on
      // path/extension. Non-media srcs fall through to the default
      // image rendering so screenshot / diagram embeds keep working.
      img: ({ src, alt, ...rest }) => {
        if (typeof src === 'string') {
          const kind = renderableMediaKind(src);
          if (kind === 'video') {
            return <MarkdownVideoEmbed src={src} alt={alt || undefined} />;
          }
          if (kind === 'audio') {
            return <MarkdownAudioPlayer src={src} caption={alt || undefined} />;
          }
          if (isLocalImagePath(src)) {
            return <MarkdownImageEmbed src={src} alt={alt || undefined} />;
          }
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
        const link = extractEmbedLink(children);
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
        const media = soleMediaImg(children);
        if (media) {
          if (media.kind === 'video') {
            return <MarkdownVideoEmbed src={media.src} alt={media.alt || undefined} />;
          }
          return <MarkdownAudioPlayer src={media.src} caption={media.alt || undefined} />;
        }
        return <p {...rest}>{children}</p>;
      },
      // Mirror the `<p>` promotion for list items: tight lists (`1. foo\n2.
      // bar`) don't wrap children in `<p>`, so a bare URL or standalone
      // `[label](url)` sitting on its own list line would otherwise stay a
      // plain anchor. Loose lists already go through the `<p>` branch above.
      li: ({ children, ...rest }) => {
        const link = extractEmbedLink(children);
        if (!link) return <li {...rest}>{children}</li>;
        const trimmed = isEmptyChildren(link.rest);
        return (
          <li {...rest}>
            <LinkEmbed href={link.href} />
            {!trimmed && link.rest}
          </li>
        );
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
    <div className="notes-md" onContextMenu={handleContextMenu}>
      <LazyMarkdown source={normalised} components={components} codeCopy />
      {menu && (
        <ContextMenu
          open
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu.target)}
          onClose={() => setMenu(null)}
          label="Markdown preview actions"
        />
      )}
    </div>
  );
};
