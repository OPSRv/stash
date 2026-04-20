import { afterEach, describe, expect, it } from 'vitest';
import {
  peekPendingDownloaderUrl,
  setPendingDownloaderUrl,
  takePendingDownloaderUrl,
} from './pendingUrl';

describe('pendingUrl handoff', () => {
  afterEach(() => {
    setPendingDownloaderUrl(null);
  });

  it('set + take returns the stored URL exactly once', () => {
    setPendingDownloaderUrl('https://youtu.be/abc');
    expect(takePendingDownloaderUrl()).toBe('https://youtu.be/abc');
    expect(takePendingDownloaderUrl()).toBeNull();
  });

  it('set trims whitespace and clears on empty input', () => {
    setPendingDownloaderUrl('  https://youtu.be/abc  ');
    expect(peekPendingDownloaderUrl()).toBe('https://youtu.be/abc');
    setPendingDownloaderUrl('   ');
    expect(peekPendingDownloaderUrl()).toBeNull();
  });

  it('set null forgets a previously pending URL', () => {
    setPendingDownloaderUrl('https://youtu.be/abc');
    setPendingDownloaderUrl(null);
    expect(takePendingDownloaderUrl()).toBeNull();
  });
});
