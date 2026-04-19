import { describe, it, expect } from 'vitest';
import {
  DETECT_SLOW_HINT_THRESHOLD_SEC,
  STATUS_LABELS,
  SUPPORTED_VIDEO_URL,
} from './downloads.constants';

describe('SUPPORTED_VIDEO_URL', () => {
  it.each([
    'https://youtube.com/watch?v=abc',
    'https://www.youtube.com/watch?v=abc',
    'https://youtu.be/abc',
    'http://tiktok.com/@user/video/1',
    'https://instagram.com/reel/xyz',
    'https://twitter.com/user/status/1',
    'https://x.com/user/status/1',
    'https://www.reddit.com/r/videos/comments/x/y/',
    'https://vimeo.com/12345',
    'https://twitch.tv/user/video',
    'https://facebook.com/watch/?v=1',
    'https://fb.watch/abc',
  ])('matches supported URL: %s', (url) => {
    expect(SUPPORTED_VIDEO_URL.test(url)).toBe(true);
  });

  it.each([
    '',
    'not a url',
    'ftp://example.com',
    'https://example.com/video',
    'https://example.org',
    'youtube.com',
    'https://fake-youtube.evil',
  ])('rejects non-supported URL: %s', (url) => {
    expect(SUPPORTED_VIDEO_URL.test(url)).toBe(false);
  });
});

describe('STATUS_LABELS', () => {
  it('exposes a label for every job status', () => {
    expect(STATUS_LABELS.pending).toBe('Queued');
    expect(STATUS_LABELS.active).toBe('Downloading');
    expect(STATUS_LABELS.paused).toBe('Paused');
    expect(STATUS_LABELS.completed).toBe('Completed');
    expect(STATUS_LABELS.failed).toBe('Failed');
    expect(STATUS_LABELS.cancelled).toBe('Cancelled');
  });
});

describe('DETECT_SLOW_HINT_THRESHOLD_SEC', () => {
  it('is a positive finite number', () => {
    expect(DETECT_SLOW_HINT_THRESHOLD_SEC).toBeGreaterThan(0);
    expect(Number.isFinite(DETECT_SLOW_HINT_THRESHOLD_SEC)).toBe(true);
  });
});
