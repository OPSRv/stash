import { describe, expect, test } from 'vitest';

import type { WebChatService } from '../../settings/store';

import {
  clampZoom,
  defaultLabelFromUrl,
  isEmbeddableUrl,
  MAX_ZOOM,
  MIN_ZOOM,
  reorderServices,
  slugify,
  uniqueServiceId,
} from './webServiceUtils';

describe('slugify', () => {
  test('lowercases and replaces punctuation with dashes', () => {
    expect(slugify('My Service')).toBe('my-service');
    expect(slugify('Claude Sonnet 4.6')).toBe('claude-sonnet-4-6');
  });

  test('strips leading/trailing dashes', () => {
    expect(slugify('  hello  ')).toBe('hello');
    expect(slugify('--x--')).toBe('x');
  });

  test('falls back to "service" for empty input', () => {
    expect(slugify('')).toBe('service');
    expect(slugify('!!!')).toBe('service');
  });

  test('caps length at 40 to keep labels tidy', () => {
    const long = 'a'.repeat(60);
    expect(slugify(long)).toHaveLength(40);
  });
});

describe('uniqueServiceId', () => {
  const svc = (id: string): WebChatService => ({ id, label: id, url: 'https://x' });

  test('returns the base id when it is free', () => {
    expect(uniqueServiceId('claude', [svc('gpt')])).toBe('claude');
  });

  test('appends -2, -3, … on collision', () => {
    expect(uniqueServiceId('claude', [svc('claude')])).toBe('claude-2');
    expect(
      uniqueServiceId('claude', [svc('claude'), svc('claude-2')]),
    ).toBe('claude-3');
  });
});

describe('defaultLabelFromUrl', () => {
  test('takes the leading subdomain and capitalises it', () => {
    expect(defaultLabelFromUrl('https://chat.openai.com/')).toBe('Chat');
    expect(defaultLabelFromUrl('https://gemini.google.com/app')).toBe('Gemini');
  });

  test('skips a leading www', () => {
    expect(defaultLabelFromUrl('https://www.example.com/x')).toBe('Example');
  });

  test('returns an empty string for an unparseable URL', () => {
    expect(defaultLabelFromUrl('not a url')).toBe('');
    expect(defaultLabelFromUrl('')).toBe('');
  });
});

describe('clampZoom', () => {
  test('returns 1 for non-finite input', () => {
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
  });

  test('clamps to the allowed band', () => {
    expect(clampZoom(0.1)).toBe(MIN_ZOOM);
    expect(clampZoom(10)).toBe(MAX_ZOOM);
  });

  test('rounds to 2 decimals so repeated bumps stay stable', () => {
    expect(clampZoom(1.23456)).toBe(1.23);
    // 1 + 0.1 + 0.1 + 0.1 = 1.3000000000000003 in IEEE-754 land.
    expect(clampZoom(1 + 0.1 + 0.1 + 0.1)).toBe(1.3);
  });
});

describe('reorderServices', () => {
  const svc = (id: string): WebChatService => ({ id, label: id, url: 'https://x' });
  const a = svc('a');
  const b = svc('b');
  const c = svc('c');

  test('moves the source in front of the destination', () => {
    expect(reorderServices([a, b, c], 'c', 'a').map((s) => s.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  test('no-op when source and destination match', () => {
    const list = [a, b, c];
    expect(reorderServices(list, 'b', 'b')).toBe(list);
  });

  test('no-op when an id is missing', () => {
    const list = [a, b];
    expect(reorderServices(list, 'missing', 'a')).toBe(list);
    expect(reorderServices(list, 'a', 'missing')).toBe(list);
  });
});

describe('isEmbeddableUrl', () => {
  test('accepts http and https', () => {
    expect(isEmbeddableUrl('https://example.com')).toBe(true);
    expect(isEmbeddableUrl('http://localhost:3000')).toBe(true);
  });

  test('rejects other schemes and junk', () => {
    expect(isEmbeddableUrl('file:///etc/passwd')).toBe(false);
    expect(isEmbeddableUrl('about:blank')).toBe(false);
    expect(isEmbeddableUrl('javascript:alert(1)')).toBe(false);
    expect(isEmbeddableUrl('')).toBe(false);
    expect(isEmbeddableUrl('not a url')).toBe(false);
  });
});
