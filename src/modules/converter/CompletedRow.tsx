import { useMemo, useState, type MouseEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { ContextMenu, type ContextMenuItem } from '../../shared/ui/ContextMenu';
import { IconButton } from '../../shared/ui/IconButton';
import { CloseIcon } from '../../shared/ui/icons';
import { useToast } from '../../shared/ui/Toast';
import { copyText } from '../../shared/util/clipboard';
import { revealFile } from '../../shared/util/revealFile';
import type { ConverterJob } from './api';

type CompletedRowProps = {
  job: ConverterJob;
  /// Called when the user wants the row gone. The shell decides whether
  /// to fire a confirm dialog first — completed rows own a file on disk
  /// we don't want to wipe without explicit consent.
  onRemove: (job: ConverterJob) => void;
};

const TEXT_EXT = /\.(md|txt|markdown|csv|json|log)$/i;
const AUDIO_EXT = /\.(mp3|m4a|wav|flac|ogg|opus|aac)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;

/// Finished-job row: filename → output, with a kind-aware action menu.
/// Hover surfaces the quick actions (Open / Reveal / overflow); the
/// overflow icon and right-click both open the same `ContextMenu` so
/// the row stays operable with one hand on the trackpad.
export function CompletedRow({ job, onRemove }: CompletedRowProps) {
  const { toast } = useToast();
  const failed = job.status === 'failed';
  const cancelled = job.status === 'cancelled';
  const path = job.output_path;
  const hasFile = !!path && !failed && !cancelled;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const open = () => {
    if (!path) return;
    void import('@tauri-apps/plugin-opener')
      .then((m) => m.openPath(path))
      .catch((err) => {
        toast({
          title: 'Could not open',
          description: err instanceof Error ? err.message : String(err),
          variant: 'error',
        });
      });
  };

  const items: ContextMenuItem[] = useMemo(() => {
    if (!path) return [];
    const isText = TEXT_EXT.test(path);
    const isAudio = AUDIO_EXT.test(path);
    const isVideo = VIDEO_EXT.test(path);
    const base: ContextMenuItem[] = [
      { kind: 'action', label: 'Open', shortcut: '↵', onSelect: open },
      {
        kind: 'action',
        label: 'Reveal in Finder',
        shortcut: '⌥⌘R',
        onSelect: () => void revealFile(path),
      },
    ];

    const kindActions: ContextMenuItem[] = [];
    if (isText) {
      kindActions.push(
        {
          kind: 'action',
          label: 'Ask AI about this transcript',
          onSelect: () =>
            void readTextAndDispatch(job.id, toast, (text) => {
              window.dispatchEvent(
                new CustomEvent('stash:ai-prefill', {
                  detail: {
                    text: `Here is a transcript I just produced:\n\n${text}\n\nAnalyse / summarise it.`,
                    newSession: true,
                  },
                }),
              );
              window.dispatchEvent(
                new CustomEvent('stash:navigate', { detail: 'ai' }),
              );
            }),
        },
        {
          kind: 'action',
          label: 'Translate',
          onSelect: () =>
            void readTextAndDispatch(job.id, toast, (text) => {
              window.dispatchEvent(
                new CustomEvent('stash:translator-prefill', { detail: text }),
              );
              window.dispatchEvent(
                new CustomEvent('stash:navigate', { detail: 'translator' }),
              );
            }),
        },
        {
          kind: 'action',
          label: 'Copy contents',
          shortcut: '⌘C',
          onSelect: () =>
            void readTextAndDispatch(job.id, toast, async (text) => {
              const ok = await copyText(text);
              if (ok) toast({ title: 'Copied transcript', variant: 'success' });
            }),
        },
        {
          kind: 'action',
          label: 'Send to Telegram',
          onSelect: () =>
            void readTextAndDispatch(job.id, toast, async (text) => {
              const sent = await invoke<boolean>('telegram_send_text', { text })
                .catch(() => false);
              toast({
                title: sent ? 'Sent to Telegram' : 'Telegram not paired',
                variant: sent ? 'success' : 'error',
              });
            }),
        },
      );
    }
    if (isAudio || isVideo) {
      kindActions.push({
        kind: 'action',
        label: isVideo ? 'Extract audio (stems)' : 'Open in Stems',
        onSelect: () => {
          window.dispatchEvent(
            new CustomEvent('stash:navigate', {
              detail: { tabId: 'separator', file: path },
            }),
          );
        },
      });
      kindActions.push({
        kind: 'action',
        label: 'Transcribe…',
        onSelect: () => {
          window.dispatchEvent(
            new CustomEvent('stash:navigate', {
              detail: { tabId: 'converter', file: path },
            }),
          );
        },
      });
    }

    const tail: ContextMenuItem[] = [
      {
        kind: 'action',
        label: 'Copy path',
        onSelect: () =>
          void copyText(path).then((ok) => {
            if (ok) toast({ title: 'Path copied', variant: 'success' });
          }),
      },
      {
        kind: 'action',
        label: 'Copy filename',
        onSelect: () => void copyText(filename(path)),
      },
      { kind: 'separator' },
      {
        kind: 'action',
        label: 'Delete file & remove',
        tone: 'danger',
        onSelect: () => onRemove(job),
      },
    ];

    return kindActions.length > 0
      ? [...base, { kind: 'separator' }, ...kindActions, { kind: 'separator' }, ...tail]
      : [...base, { kind: 'separator' }, ...tail];
  }, [job, onRemove, path, toast]);

  const onContextMenu = (e: MouseEvent) => {
    if (!hasFile) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  return (
    <div
      data-testid={`converter-completed-${job.id}`}
      onContextMenu={onContextMenu}
      onDoubleClick={() => hasFile && open()}
      className="group flex items-center gap-2 rounded-md border [border-color:var(--hairline)] p-3"
      style={{
        background: failed ? 'rgba(239, 68, 68, 0.05)' : 'var(--bg-row)',
      }}
    >
      <div className="flex-1 min-w-0">
        <div className="t-primary text-body truncate font-medium">
          {filename(job.output_path || job.input_path)}
        </div>
        <div className="t-tertiary text-meta truncate">
          {statusLabel(job)} · from {filename(job.input_path)}
        </div>
        {failed && job.error && (
          <p className="text-meta mt-1" style={{ color: 'rgba(239, 68, 68, 0.95)' }}>
            {firstLine(job.error)}
          </p>
        )}
      </div>
      {hasFile && (
        <>
          <IconButton title="Open" onClick={open} tooltipSide="left">
            <OpenIcon />
          </IconButton>
          <IconButton
            title="Reveal in Finder"
            onClick={() => void revealFile(path!)}
            tooltipSide="left"
          >
            <RevealIcon />
          </IconButton>
          <IconButton
            title="More actions"
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setMenu({ x: rect.left, y: rect.bottom + 4 });
            }}
            tooltipSide="left"
          >
            <MoreIcon />
          </IconButton>
        </>
      )}
      <IconButton
        title={
          job.status === 'completed' && job.output_path
            ? 'Delete file and remove from list'
            : 'Remove from list'
        }
        onClick={() => onRemove(job)}
        tooltipSide="left"
      >
        <CloseIcon size={13} />
      </IconButton>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={items}
        onClose={() => setMenu(null)}
        label="Job actions"
      />
    </div>
  );
}

async function readTextAndDispatch(
  jobId: string,
  toast: ReturnType<typeof useToast>['toast'],
  handler: (text: string) => unknown | Promise<unknown>,
) {
  try {
    const text = await invoke<string>('converter_read_transcript', { jobId });
    await handler(text);
  } catch (e) {
    toast({
      title: 'Could not read transcript',
      description: e instanceof Error ? e.message : String(e),
      variant: 'error',
    });
  }
}

function statusLabel(job: ConverterJob): string {
  switch (job.status) {
    case 'completed':
      return job.kind === 'transcribe' ? 'Transcribed' : 'Converted';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return job.status;
  }
}

function filename(path: string): string {
  if (!path) return '';
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return i < 0 ? s : s.slice(0, i);
}

const OpenIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden fill="none">
    <path
      d="M3 3h4M3 3v4M3 3l7 7M11 11v-4M11 11H7"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const RevealIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden fill="none">
    <path
      d="M2 4h3l1.5 1.5h5.5a.5.5 0 0 1 .5.5v5.5a.5.5 0 0 1-.5.5H2a.5.5 0 0 1-.5-.5V4.5A.5.5 0 0 1 2 4z"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
  </svg>
);

const MoreIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden>
    <circle cx="3" cy="7" r="1.2" fill="currentColor" />
    <circle cx="7" cy="7" r="1.2" fill="currentColor" />
    <circle cx="11" cy="7" r="1.2" fill="currentColor" />
  </svg>
);
