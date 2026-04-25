import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  cancel,
  clearCompleted,
  deleteJob,
  detect,
  detectQuick,
  formatBytes,
  formatDuration,
  list,
  pause,
  platformBadge,
  pruneHistory,
  purgeCookies,
  resume,
  retry,
  setCookiesBrowser,
  setDownloadsDir,
  setMaxParallel,
  setRateLimit,
  setTranscription,
  start,
  transcribeJob,
  updateYtDlp,
  ytDlpVersion,
} from './api';

describe('downloader/api pure helpers', () => {
  describe('formatBytes', () => {
    it('returns empty string for null/undefined/zero/negative', () => {
      expect(formatBytes(null)).toBe('');
      expect(formatBytes(undefined)).toBe('');
      expect(formatBytes(0)).toBe('');
      expect(formatBytes(-1)).toBe('');
    });
    it('uses B under 1024', () => {
      expect(formatBytes(1)).toBe('1 B');
      expect(formatBytes(1023)).toBe('1023 B');
    });
    it('uses KB between 1024 and 1MB', () => {
      expect(formatBytes(1024)).toBe('1.0 KB');
      expect(formatBytes(2048)).toBe('2.0 KB');
    });
    it('uses MB between 1MB and 1GB', () => {
      expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
      expect(formatBytes(1024 * 1024 * 512)).toBe('512.0 MB');
    });
    it('uses GB at 1GB and above', () => {
      expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
      expect(formatBytes(1024 * 1024 * 1024 * 2)).toBe('2.00 GB');
    });
  });

  describe('formatDuration', () => {
    it('returns empty string for null/undefined/zero/negative', () => {
      expect(formatDuration(null)).toBe('');
      expect(formatDuration(undefined)).toBe('');
      expect(formatDuration(0)).toBe('');
      expect(formatDuration(-5)).toBe('');
    });
    it('formats under an hour as M:SS', () => {
      expect(formatDuration(5)).toBe('0:05');
      expect(formatDuration(65)).toBe('1:05');
      expect(formatDuration(125)).toBe('2:05');
    });
    it('formats at or over an hour as H:MM:SS', () => {
      expect(formatDuration(3600)).toBe('1:00:00');
      expect(formatDuration(3665)).toBe('1:01:05');
      expect(formatDuration(7325)).toBe('2:02:05');
    });
    it('rounds fractional seconds', () => {
      expect(formatDuration(5.4)).toBe('0:05');
      expect(formatDuration(5.6)).toBe('0:06');
    });
  });

  describe('platformBadge', () => {
    it('returns known labels for known platforms', () => {
      expect(platformBadge('youtube').label).toBe('YOUTUBE');
      expect(platformBadge('twitter').label).toBe('X');
      expect(platformBadge('instagram').label).toBe('INSTAGRAM');
      expect(platformBadge('tiktok').label).toBe('TIKTOK');
      expect(platformBadge('reddit').label).toBe('REDDIT');
      expect(platformBadge('vimeo').label).toBe('VIMEO');
      expect(platformBadge('twitch').label).toBe('TWITCH');
      expect(platformBadge('facebook').label).toBe('FACEBOOK');
    });
    it('falls back to LINK for unknown platforms', () => {
      expect(platformBadge('generic').label).toBe('LINK');
      expect(platformBadge('anything-else').label).toBe('LINK');
    });
  });
});

describe('downloader/api invoke wrappers', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined as never);
  });

  it('detect forwards the url', async () => {
    await detect('https://example.com/v');
    expect(invoke).toHaveBeenCalledWith('dl_detect', { url: 'https://example.com/v' });
  });

  it('detectQuick forwards the url', async () => {
    await detectQuick('https://example.com/v');
    expect(invoke).toHaveBeenCalledWith('dl_detect_quick', { url: 'https://example.com/v' });
  });

  it('start serialises arguments with snake->camel conversions and null defaults', async () => {
    vi.mocked(invoke).mockResolvedValue(42 as never);
    const id = await start({
      url: 'u',
      title: 't',
      thumbnail: 'th',
      format_id: 'f',
      height: 720,
      kind: 'video',
    });
    expect(id).toBe(42);
    expect(invoke).toHaveBeenCalledWith('dl_start', {
      url: 'u',
      title: 't',
      thumbnail: 'th',
      formatId: 'f',
      height: 720,
      kind: 'video',
    });
  });

  it('start defaults optional fields to null', async () => {
    await start({ url: 'u', kind: 'audio' });
    expect(invoke).toHaveBeenCalledWith('dl_start', {
      url: 'u',
      title: null,
      thumbnail: null,
      formatId: null,
      height: null,
      kind: 'audio',
    });
  });

  it.each([
    ['cancel', cancel, 'dl_cancel'],
    ['pause', pause, 'dl_pause'],
    ['resume', resume, 'dl_resume'],
    ['retry', retry, 'dl_retry'],
  ])('%s sends { id }', async (_, fn, expected) => {
    await fn(7);
    expect(invoke).toHaveBeenCalledWith(expected, { id: 7 });
  });

  it('deleteJob defaults to keeping the file on disk', async () => {
    await deleteJob(7);
    expect(invoke).toHaveBeenCalledWith('dl_delete', { id: 7, purgeFile: false });
  });

  it('deleteJob forwards purgeFile=true to Rust', async () => {
    await deleteJob(7, true);
    expect(invoke).toHaveBeenCalledWith('dl_delete', { id: 7, purgeFile: true });
  });

  it('extractSubtitles passes id and defaults langs=null so Rust picks en/uk', async () => {
    const { extractSubtitles } = await import('./api');
    await extractSubtitles(9);
    expect(invoke).toHaveBeenCalledWith('dl_extract_subtitles', { id: 9, langs: null });
  });

  it('extractSubtitles forwards an explicit lang list', async () => {
    const { extractSubtitles } = await import('./api');
    await extractSubtitles(9, ['uk', 'en']);
    expect(invoke).toHaveBeenCalledWith('dl_extract_subtitles', {
      id: 9,
      langs: ['uk', 'en'],
    });
  });

  it('list invokes without args', async () => {
    await list();
    expect(invoke).toHaveBeenCalledWith('dl_list');
  });

  it('clearCompleted invokes without args', async () => {
    await clearCompleted();
    expect(invoke).toHaveBeenCalledWith('dl_clear_completed');
  });

  it('ytDlpVersion / updateYtDlp / purgeCookies are argument-less', async () => {
    await ytDlpVersion();
    await updateYtDlp();
    await purgeCookies();
    expect(invoke).toHaveBeenCalledWith('dl_ytdlp_version');
    expect(invoke).toHaveBeenCalledWith('dl_update_binary');
    expect(invoke).toHaveBeenCalledWith('dl_purge_cookies');
  });

  it('setTranscription sends { id, transcription } with text', async () => {
    await setTranscription(3, 'Hello world');
    expect(invoke).toHaveBeenCalledWith('dl_set_transcription', {
      id: 3,
      transcription: 'Hello world',
    });
  });

  it('setTranscription sends null to clear', async () => {
    await setTranscription(3, null);
    expect(invoke).toHaveBeenCalledWith('dl_set_transcription', {
      id: 3,
      transcription: null,
    });
  });

  it('transcribeJob sends { id }', async () => {
    await transcribeJob(5);
    expect(invoke).toHaveBeenCalledWith('dl_transcribe_job', { id: 5 });
  });

  it('setters forward named args', async () => {
    await setDownloadsDir('/tmp/x');
    await setDownloadsDir(null);
    await setCookiesBrowser('arc');
    await setCookiesBrowser(null);
    await setMaxParallel(5);
    await setRateLimit('2M');
    await setRateLimit(null);
    await pruneHistory(30);

    expect(invoke).toHaveBeenCalledWith('dl_set_downloads_dir', { path: '/tmp/x' });
    expect(invoke).toHaveBeenCalledWith('dl_set_downloads_dir', { path: null });
    expect(invoke).toHaveBeenCalledWith('dl_set_cookies_browser', { browser: 'arc' });
    expect(invoke).toHaveBeenCalledWith('dl_set_cookies_browser', { browser: null });
    expect(invoke).toHaveBeenCalledWith('dl_set_max_parallel', { value: 5 });
    expect(invoke).toHaveBeenCalledWith('dl_set_rate_limit', { value: '2M' });
    expect(invoke).toHaveBeenCalledWith('dl_set_rate_limit', { value: null });
    expect(invoke).toHaveBeenCalledWith('dl_prune_history', { olderThanDays: 30 });
  });
});
