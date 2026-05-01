import { useEffect, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';

import { detectFileKind, isTextual, type FileKind } from '../util/fileKind';
import { formatBytes as fmtBytes } from '../format/bytes';
import { AudioPlayer } from './AudioPlayer';
import { CodePreview } from './CodePreview';
import { FileChip } from './FileChip';
import { ImageThumbnail } from './ImageThumbnail';
import { InlineVideo } from './InlineVideo';
import { LazyMarkdown } from './LazyMarkdown';

/// One source entry. Identical shape for single and multi-file previews
/// — Phase 2's `kind: 'file'` clipboard items will always be an array of
/// these, even when only one file was copied, so we never end up with
/// parallel single/multi codepaths.
export type FileSource = {
  /// Absolute filesystem path, `asset://`, `file://`, `http(s)://`, or
  /// `blob:`/`data:` URL. Binary previews (image/video/audio/pdf) hand
  /// this directly to the leaf; textual kinds fetch it.
  src?: string;
  /// Inline text content. When present, we skip any fetch and render
  /// immediately (used for clipboard text items and AI-generated
  /// snippets that never touched the filesystem).
  text?: string;
  /// Filename (with extension). Drives kind detection and is shown as
  /// a header for code/unknown previews.
  name?: string | null;
  /// OS-reported MIME. Used as a fallback for kind detection when
  /// the filename has no usable extension.
  mime?: string | null;
  /// Human-visible caption rendered below the preview (Telegram
  /// attachment caption, note attachment description, etc.).
  caption?: string | null;
  /// File size in bytes. Shown inside the `FileChip` placeholder when
  /// we can't render the content in-app.
  sizeBytes?: number | null;
};

type FilePreviewProps = FileSource & {
  className?: string;
};

const isAbsoluteUrl = (s: string): boolean =>
  /^[a-z]+:\/\//i.test(s) || s.startsWith('data:') || s.startsWith('blob:');

/// Canonical src normaliser. Absolute filesystem paths go through the
/// Tauri asset protocol; anything already carrying a scheme passes
/// through. Shared by every leaf preview so behaviour stays uniform.
export const normaliseFileSrc = (src: string): string => {
  if (!src) return src;
  if (isAbsoluteUrl(src)) return src;
  if (src.startsWith('/')) return convertFileSrc(src);
  return src;
};

const MAX_INLINE_TEXT_BYTES = 512 * 1024;

type TextState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; text: string }
  | { status: 'too-large'; bytes: number }
  | { status: 'error'; message: string };

/// Fetch a textual file and hand the string body to its caller. Guards
/// against oversized files (> 512 KB) because the markdown renderer
/// does sync highlight work on every update and would jank the popup.
const useFetchedText = (
  src: string | undefined,
  inline: string | undefined,
  kind: FileKind,
): TextState => {
  const [state, setState] = useState<TextState>(
    inline !== undefined
      ? { status: 'ready', text: inline }
      : src && isTextual(kind)
        ? { status: 'loading' }
        : { status: 'idle' },
  );

  useEffect(() => {
    if (inline !== undefined) {
      setState({ status: 'ready', text: inline });
      return;
    }
    if (!src || !isTextual(kind)) {
      setState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    fetch(normaliseFileSrc(src))
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const len = Number(res.headers.get('content-length') ?? '0');
        if (len > MAX_INLINE_TEXT_BYTES) {
          return { kind: 'too-large' as const, bytes: len };
        }
        const body = await res.text();
        if (body.length > MAX_INLINE_TEXT_BYTES) {
          return { kind: 'too-large' as const, bytes: body.length };
        }
        return { kind: 'text' as const, body };
      })
      .then((out) => {
        if (cancelled) return;
        if (out.kind === 'too-large') {
          setState({ status: 'too-large', bytes: out.bytes });
        } else {
          setState({ status: 'ready', text: out.body });
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          message: e instanceof Error ? e.message : String(e),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [src, inline, kind]);

  return state;
};

/// Single-file preview. Routes the source through the shared per-kind
/// leaves so the same file looks the same everywhere (clipboard,
/// telegram inbox, notes attachments, future storybook demos).
///
/// Binary kinds (image/video/audio/pdf) render immediately from
/// `src`. Textual kinds either use the `text` prop (fast path) or
/// fetch the body via the Tauri asset protocol.
export const FilePreview = ({
  src,
  text,
  name,
  mime,
  caption,
  sizeBytes,
  className,
}: FilePreviewProps) => {
  const { kind, language } = detectFileKind({ name, mime });
  const textState = useFetchedText(src, text, kind);
  const displayName = name ?? (src ? src.split('/').pop() ?? src : 'file');
  const wrapClass = `flex flex-col gap-2 ${className ?? ''}`;

  if (kind === 'image' && src) {
    return (
      <div className={wrapClass} data-file-kind="image">
        <ImageThumbnail src={src} alt={name ?? undefined} caption={caption} />
      </div>
    );
  }

  if (kind === 'video' && src) {
    return (
      <div className={wrapClass} data-file-kind="video">
        <InlineVideo src={src} caption={caption} />
      </div>
    );
  }

  if (kind === 'audio' && src) {
    return (
      <div className={wrapClass} data-file-kind="audio">
        <AudioPlayer src={src} caption={caption ?? undefined} />
      </div>
    );
  }

  if (kind === 'pdf' && src) {
    return (
      <div className={wrapClass} data-file-kind="pdf">
        <embed
          src={normaliseFileSrc(src)}
          type="application/pdf"
          className="w-full h-[420px] rounded-lg border [border-color:var(--hairline)] bg-black/40"
          aria-label={displayName}
        />
        {caption && (
          <p className="text-[13px] leading-[18px] text-white/80 whitespace-pre-wrap">
            {caption}
          </p>
        )}
      </div>
    );
  }

  if (isTextual(kind)) {
    if (textState.status === 'loading') {
      return (
        <div
          className={`${wrapClass} t-tertiary text-meta px-3 py-2`}
          data-file-kind={kind}
          data-file-state="loading"
        >
          Loading {displayName}…
        </div>
      );
    }
    if (textState.status === 'too-large') {
      return (
        <div className={wrapClass} data-file-kind={kind} data-file-state="too-large">
          <FileChip
            name={displayName}
            mimeType={mime}
            size={fmtBytes(textState.bytes, { stopAt: 'MB', empty: '' })}
            caption={caption ?? `File is too large to preview (${fmtBytes(textState.bytes, { stopAt: 'MB', empty: '' })})`}
          />
        </div>
      );
    }
    if (textState.status === 'error') {
      return (
        <div className={wrapClass} data-file-kind={kind} data-file-state="error">
          <FileChip
            name={displayName}
            mimeType={mime}
            size={sizeBytes != null ? fmtBytes(sizeBytes, { stopAt: 'MB', empty: '' }) : null}
            caption={caption ?? `Can't preview: ${textState.message}`}
          />
        </div>
      );
    }
    if (textState.status === 'ready') {
      if (kind === 'markdown') {
        return (
          <div className={wrapClass} data-file-kind="markdown">
            <LazyMarkdown source={textState.text} codeCopy />
            {caption && (
              <p className="text-[13px] leading-[18px] text-white/80 whitespace-pre-wrap">
                {caption}
              </p>
            )}
          </div>
        );
      }
      if (kind === 'code') {
        return (
          <div className={wrapClass} data-file-kind="code">
            <CodePreview
              code={textState.text}
              language={language}
              filename={name ?? undefined}
            />
            {caption && (
              <p className="text-[13px] leading-[18px] text-white/80 whitespace-pre-wrap">
                {caption}
              </p>
            )}
          </div>
        );
      }
      // plain text
      return (
        <div className={wrapClass} data-file-kind="text">
          <pre className="whitespace-pre-wrap break-words text-[12px] leading-[18px] font-mono text-white/85 rounded-lg border [border-color:var(--hairline)] bg-black/30 p-3 max-h-[360px] overflow-auto">
            {textState.text}
          </pre>
          {caption && (
            <p className="text-[13px] leading-[18px] text-white/80 whitespace-pre-wrap">
              {caption}
            </p>
          )}
        </div>
      );
    }
  }

  // Unknown / unsupported: graceful fallback. Gives the user at least
  // the filename, MIME, and size so they can decide what to do next.
  return (
    <div className={wrapClass} data-file-kind="unknown">
      <FileChip
        name={displayName}
        mimeType={mime}
        size={sizeBytes != null ? fmtBytes(sizeBytes, { stopAt: 'MB', empty: '' }) : null}
        caption={caption}
      />
    </div>
  );
};

type FilePreviewListProps = {
  files: FileSource[];
  className?: string;
};

/// Stacks multiple `FilePreview` rows with a thin divider. Used by
/// clipboard items that came out of a multi-file copy, telegram album
/// groups, and any future module that needs "N files, uniformly
/// rendered." A single-item list is a legal input — callers shouldn't
/// have to special-case single vs many.
export const FilePreviewList = ({ files, className }: FilePreviewListProps) => {
  if (files.length === 0) return null;
  return (
    <div className={`flex flex-col gap-3 ${className ?? ''}`}>
      {files.map((file, i) => (
        <FilePreview
          key={`${file.src ?? file.name ?? 'file'}-${i}`}
          {...file}
        />
      ))}
    </div>
  );
};
