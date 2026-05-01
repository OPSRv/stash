import { render, screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import * as events from '@tauri-apps/api/event';
const __emit = (events as unknown as { __emit: (e: string, p: unknown) => void }).__emit;
import { invoke } from '@tauri-apps/api/core';
import { ActiveDownloadRow } from './ActiveDownloadRow';
import { CompletedDownloadRow } from './CompletedDownloadRow';
import { CompletedDownloadTile } from './CompletedDownloadTile';
import { DetectedPreviewCard } from './DetectedPreviewCard';
import { DownloadUrlBar } from './DownloadUrlBar';
import { DropOverlay } from './DropOverlay';
import { PlatformBadge } from './PlatformBadge';
import { QualityPicker } from './QualityPicker';
import type { DownloadJob, QualityOption } from './api';

const job = (overrides: Partial<DownloadJob> = {}): DownloadJob => ({
  id: 1,
  url: 'https://youtu.be/abc',
  platform: 'youtube',
  title: 'Some video',
  thumbnail_url: null,
  format_id: null,
  target_path: null,
  status: 'active',
  progress: 0.42,
  bytes_total: 10 * 1024 * 1024,
  bytes_done: 4 * 1024 * 1024,
  error: null,
  created_at: 0,
  completed_at: null,
  transcription: null,
  ...overrides,
});

describe('PlatformBadge', () => {
  it('renders the known label', () => {
    render(<PlatformBadge platform="youtube" />);
    expect(screen.getByText('YOUTUBE')).toBeInTheDocument();
  });
  it('falls back to LINK for unknown platforms', () => {
    render(<PlatformBadge platform="whatever" />);
    expect(screen.getByText('LINK')).toBeInTheDocument();
  });
});

describe('DropOverlay', () => {
  it('renders the drop hint', () => {
    render(<DropOverlay />);
    expect(screen.getByText(/Drop URL to download/)).toBeInTheDocument();
  });
});

describe('DownloadUrlBar', () => {
  it('calls onUrlChange as the user types', async () => {
    const user = userEvent.setup();
    const onUrlChange = vi.fn();
    render(
      <DownloadUrlBar
        url=""
        detecting={false}
        elapsedSec={0}
        onUrlChange={onUrlChange}
        onDetect={() => {}}
        onCancel={() => {}}
      />
    );
    await user.type(screen.getByPlaceholderText(/Paste a YouTube/), 'x');
    expect(onUrlChange).toHaveBeenCalledWith('x');
  });

  it('fires onDetect on Enter', async () => {
    const user = userEvent.setup();
    const onDetect = vi.fn();
    render(
      <DownloadUrlBar
        url="https://youtu.be/abc"
        detecting={false}
        elapsedSec={0}
        onUrlChange={() => {}}
        onDetect={onDetect}
        onCancel={() => {}}
      />
    );
    await user.type(screen.getByPlaceholderText(/Paste a YouTube/), '{Enter}');
    expect(onDetect).toHaveBeenCalled();
  });

  it('disables Detect when the URL is empty', () => {
    render(
      <DownloadUrlBar
        url="   "
        detecting={false}
        elapsedSec={0}
        onUrlChange={() => {}}
        onDetect={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByRole('button', { name: 'Detect' })).toBeDisabled();
  });

  it('shows Cancel (with elapsed) while detecting and calls onCancel', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <DownloadUrlBar
        url="x"
        detecting={true}
        elapsedSec={7}
        onUrlChange={() => {}}
        onDetect={() => {}}
        onCancel={onCancel}
      />
    );
    const cancel = screen.getByRole('button', { name: /Cancel · 7s/ });
    await user.click(cancel);
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('QualityPicker', () => {
  const options: QualityOption[] = [
    { label: '1080p', format_id: 'a', kind: 'video', height: 1080, est_size: 2_000_000 },
    { label: '720p', format_id: 'b', kind: 'video', height: 720, est_size: null },
  ];

  it('calls onSelect when a quality is picked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <QualityPicker options={options} selected={null} onSelect={onSelect} onDownload={() => {}} />
    );
    await user.click(screen.getByRole('button', { name: /720p/ }));
    expect(onSelect).toHaveBeenCalledWith(options[1]);
  });

  it('disables the Download button until a quality is selected', () => {
    render(
      <QualityPicker options={options} selected={null} onSelect={() => {}} onDownload={() => {}} />
    );
    expect(screen.getByRole('button', { name: /Download/ })).toBeDisabled();
  });

  it('enables Download once something is selected', async () => {
    const user = userEvent.setup();
    const onDownload = vi.fn();
    render(
      <QualityPicker
        options={options}
        selected={options[0]}
        onSelect={() => {}}
        onDownload={onDownload}
      />
    );
    await user.click(screen.getByRole('button', { name: /Download/ }));
    expect(onDownload).toHaveBeenCalled();
  });
});

describe('DetectedPreviewCard', () => {
  it('shows title, platform badge, uploader, footer and trailing', () => {
    render(
      <DetectedPreviewCard
        platform="youtube"
        title="Hello"
        uploader="Creator"
        thumbnail={null}
        footerText="5 quality options"
        trailing={<button>Trailing</button>}
      />
    );
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByText('YOUTUBE')).toBeInTheDocument();
    expect(screen.getByText('Creator')).toBeInTheDocument();
    expect(screen.getByText('5 quality options')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Trailing' })).toBeInTheDocument();
  });
});

describe('ActiveDownloadRow', () => {
  it('renders progress percentage and bytes', () => {
    render(
      <ActiveDownloadRow
        job={job()}
        onCancel={() => {}}
        onPause={() => {}}
        onResume={() => {}}
      />
    );
    expect(screen.getByText(/42%/)).toBeInTheDocument();
    expect(screen.getByText('Downloading')).toBeInTheDocument();
  });

  it('wires Pause while active and Resume while paused', async () => {
    const user = userEvent.setup();
    const onPause = vi.fn();
    const onResume = vi.fn();
    const { rerender } = render(
      <ActiveDownloadRow
        job={job({ status: 'active' })}
        onCancel={() => {}}
        onPause={onPause}
        onResume={onResume}
      />
    );
    await user.click(screen.getByRole('button', { name: /^Pause\b/ }));
    expect(onPause).toHaveBeenCalled();

    rerender(
      <ActiveDownloadRow
        job={job({ status: 'paused' })}
        onCancel={() => {}}
        onPause={onPause}
        onResume={onResume}
      />
    );
    await user.click(screen.getByRole('button', { name: /^Resume\b/ }));
    expect(onResume).toHaveBeenCalled();
  });

  it('fires onCancel when the close button is pressed', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <ActiveDownloadRow
        job={job()}
        onCancel={onCancel}
        onPause={() => {}}
        onResume={() => {}}
      />
    );
    await user.click(screen.getByRole('button', { name: /^Cancel\b/ }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('CompletedDownloadRow', () => {
  it('shows Play & Reveal for a successful download with target_path', async () => {
    const user = userEvent.setup();
    const onPlay = vi.fn();
    render(
      <CompletedDownloadRow
        job={job({ status: 'completed', target_path: '/tmp/video.mp4' })}
        zebra={false}
        onDelete={() => {}}
        onPlay={onPlay}
        onRetry={() => {}}
      />
    );
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reveal' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Play' }));
    expect(onPlay).toHaveBeenCalled();
  });

  it('shows Retry on failure instead of Play', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <CompletedDownloadRow
        job={job({ status: 'failed', target_path: null, error: 'boom' })}
        zebra
        onDelete={() => {}}
        onPlay={() => {}}
        onRetry={onRetry}
      />
    );
    expect(screen.queryByRole('button', { name: 'Play' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('Stems button is shown for audio downloads only and dispatches stash:navigate', async () => {
    const user = userEvent.setup();
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(
      <CompletedDownloadRow
        job={job({ status: 'completed', target_path: '/tmp/song.mp3' })}
        zebra={false}
        onDelete={() => {}}
        onPlay={() => {}}
        onRetry={() => {}}
      />
    );
    const stems = screen.getByRole('button', { name: 'Розділити на стеми' });
    await user.click(stems);
    const ev = dispatchSpy.mock.calls.find(
      (c) => (c[0] as Event).type === 'stash:navigate',
    )?.[0] as CustomEvent | undefined;
    expect(ev).toBeDefined();
    expect(ev!.detail).toEqual({ tabId: 'separator', file: '/tmp/song.mp3' });
  });

  it('hides Stems button for non-audio downloads', () => {
    render(
      <CompletedDownloadRow
        job={job({ status: 'completed', target_path: '/tmp/clip.mp4' })}
        zebra={false}
        onDelete={() => {}}
        onPlay={() => {}}
        onRetry={() => {}}
      />
    );
    expect(
      screen.queryByRole('button', { name: 'Розділити на стеми' }),
    ).not.toBeInTheDocument();
  });
});

describe('CompletedDownloadTile', () => {
  it('treats a click on the tile as Play for successful jobs', async () => {
    const user = userEvent.setup();
    const onPlay = vi.fn();
    render(
      <CompletedDownloadTile
        job={job({ status: 'completed', target_path: '/tmp/v.mp4' })}
        onPlay={onPlay}
        onDelete={() => {}}
      />
    );
    await user.click(screen.getByText('Some video'));
    expect(onPlay).toHaveBeenCalled();
  });

  it('does not play a failed job on click', async () => {
    const user = userEvent.setup();
    const onPlay = vi.fn();
    render(
      <CompletedDownloadTile
        job={job({ status: 'failed' })}
        onPlay={onPlay}
        onDelete={() => {}}
      />
    );
    expect(screen.getByText('Failed')).toBeInTheDocument();
    await user.click(screen.getByText('Some video'));
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('delete button opens a confirm dialog without triggering play', async () => {
    const user = userEvent.setup();
    const onPlay = vi.fn();
    const onDelete = vi.fn();
    render(
      <CompletedDownloadTile
        job={job({ status: 'completed', target_path: '/tmp/v.mp4' })}
        onPlay={onPlay}
        onDelete={onDelete}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onPlay).not.toHaveBeenCalled();
    // Dialog confirm button sits inside role="dialog" — disambiguate from the
    // tile's own × button (also labelled "Delete").
    const dialog = await screen.findByRole('dialog');
    const { getByRole } = within(dialog);
    await user.click(getByRole('button', { name: 'Delete' }));
    // Row/Tile now forward the row's id so memoised parents can pass
    // stable callbacks without per-item arrow closures.
    expect(onDelete).toHaveBeenCalledWith(expect.any(Number), false);
  });

  it('delete confirm passes purgeFile=true when the "also delete file" box is ticked', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(
      <CompletedDownloadTile
        job={job({ status: 'completed', target_path: '/tmp/v.mp4' })}
        onPlay={vi.fn()}
        onDelete={onDelete}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    const { getByRole } = within(dialog);
    await user.click(
      getByRole('checkbox', { name: /also delete the downloaded file/i }),
    );
    await user.click(getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledWith(expect.any(Number), true);
  });

  it('renders TranscriptArea for a completed audio job', () => {
    render(
      <CompletedDownloadTile
        job={job({ status: 'completed', target_path: '/tmp/clip.m4a' })}
        onPlay={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /transcribe audio/i })).toBeInTheDocument();
  });

  it('does not render TranscriptArea for a completed video job', () => {
    render(
      <CompletedDownloadTile
        job={job({ status: 'completed', target_path: '/tmp/v.mp4' })}
        onPlay={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: /transcribe audio/i })).not.toBeInTheDocument();
  });

  it('clicking the transcribe button calls dl_transcribe_job', async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockResolvedValue(undefined);
    render(
      <CompletedDownloadTile
        job={job({ id: 42, status: 'completed', target_path: '/tmp/clip.mp3' })}
        onPlay={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button', { name: /transcribe audio/i }));
    expect(invoke).toHaveBeenCalledWith('dl_transcribe_job', { id: 42 });
  });

  it('refreshes transcript text on downloader:job_updated event', async () => {
    // dl_list returns the updated job with transcription text
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'dl_list') {
        return [
          job({ id: 7, status: 'completed', target_path: '/tmp/clip.m4a', transcription: 'Hello world' }),
        ];
      }
      return undefined;
    });

    render(
      <CompletedDownloadTile
        job={job({ id: 7, status: 'completed', target_path: '/tmp/clip.m4a', transcription: null })}
        onPlay={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    // No transcript yet — transcribe button is visible
    expect(screen.getByRole('button', { name: /transcribe audio/i })).toBeInTheDocument();

    // Fire the job_updated event
    await act(async () => {
      __emit('downloader:job_updated', { id: 7 });
      // Allow the async list() call inside the subscribe handler to settle
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });
});
