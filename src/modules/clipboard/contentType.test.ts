import { describe, it, expect } from 'vitest';
import {
  detectType,
  detectTextSubtype,
  maskSecret,
  prettyJson,
} from './contentType';

describe('detectType', () => {
  it('detects plain https url as link', () => {
    expect(detectType('https://github.com')).toBe('link');
  });

  it('detects http url as link', () => {
    expect(detectType('http://example.com/path')).toBe('link');
  });

  it('detects url with query string as link', () => {
    expect(detectType('https://example.com/search?q=hello&sort=asc')).toBe('link');
  });

  it('detects url with fragment as link', () => {
    expect(detectType('https://example.com/path#section')).toBe('link');
  });

  it('detects url surrounded by whitespace as link', () => {
    expect(detectType('  https://example.com  \n')).toBe('link');
  });

  it('detects url wrapped in angle brackets as link', () => {
    expect(detectType('<https://example.com>')).toBe('link');
  });

  it('detects url wrapped in quotes as link', () => {
    expect(detectType('"https://example.com"')).toBe('link');
  });

  it('detects url with trailing control character as link', () => {
    expect(detectType('https://example.com\u0000')).toBe('link');
  });

  it('treats plain prose as text', () => {
    expect(detectType('Hello, world!')).toBe('text');
  });

  it('detects a code snippet', () => {
    expect(detectType('const x = () => 42;')).toBe('code');
  });

  it('prefers link over code for URL with = in query', () => {
    expect(detectType('https://example.com/?q=value')).toBe('link');
  });

  it('returns text for empty content', () => {
    expect(detectType('')).toBe('text');
    expect(detectType('   ')).toBe('text');
  });
});

describe('detectTextSubtype', () => {
  it('classifies an email address', () => {
    expect(detectTextSubtype('alice@example.com')).toBe('email');
    expect(detectTextSubtype('  alice@example.com  ')).toBe('email');
  });

  it('classifies phone numbers in multiple formats', () => {
    expect(detectTextSubtype('+1 (415) 555-1234')).toBe('phone');
    expect(detectTextSubtype('+380 67 123 45 67')).toBe('phone');
    expect(detectTextSubtype('4155551234')).toBe('phone');
  });

  it('classifies hex and rgb colours', () => {
    expect(detectTextSubtype('#abc123')).toBe('hex-color');
    expect(detectTextSubtype('#FFF')).toBe('hex-color');
    expect(detectTextSubtype('rgba(10, 20, 30, 0.5)')).toBe('hex-color');
  });

  it('classifies a canonical UUID', () => {
    expect(
      detectTextSubtype('550e8400-e29b-41d4-a716-446655440000'),
    ).toBe('uuid');
  });

  it('classifies absolute filesystem paths', () => {
    expect(detectTextSubtype('/Users/alice/notes.md')).toBe('file-path');
    expect(detectTextSubtype('~/Downloads/invoice.pdf')).toBe('file-path');
  });

  it('classifies well-formed JSON', () => {
    expect(detectTextSubtype('{"ok":true,"n":42}')).toBe('json');
    expect(detectTextSubtype('[1,2,3]')).toBe('json');
    // Malformed JSON falls back to plain, not 'json'.
    expect(detectTextSubtype('{not json')).toBe('plain');
  });

  it('classifies recognisable API tokens as secrets', () => {
    expect(detectTextSubtype('sk-ant-api03-abcdef1234567890abcdef1234567890abcdef')).toBe('secret');
    expect(detectTextSubtype('ghp_abcdefghijklmnopqrstuvwxyz1234567890')).toBe('secret');
    expect(detectTextSubtype('AKIAIOSFODNN7EXAMPLE')).toBe('secret');
    expect(detectTextSubtype('xoxb-123456789012-1234567890123-abcdefghijklmnopqrstuvwx')).toBe('secret');
  });

  it('classifies JWTs as secrets', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(detectTextSubtype(jwt)).toBe('secret');
  });

  it('classifies a PEM private key block as secret', () => {
    expect(detectTextSubtype('-----BEGIN RSA PRIVATE KEY-----\n...')).toBe('secret');
  });

  it('returns plain for ordinary prose', () => {
    expect(detectTextSubtype('just a note to self')).toBe('plain');
  });

  it('returns plain for too-short random strings that could look like a UUID fragment', () => {
    expect(detectTextSubtype('abcd-efgh')).toBe('plain');
  });
});

describe('maskSecret', () => {
  it('keeps the first and last four characters visible for long values', () => {
    const masked = maskSecret('sk-abcdef0123456789XYZ');
    expect(masked.startsWith('sk-a')).toBe(true);
    expect(masked.endsWith('9XYZ')).toBe(true);
    expect(masked).toContain('•');
  });

  it('masks short values entirely with at least 4 dots', () => {
    expect(maskSecret('abc')).toBe('••••');
    expect(maskSecret('tokenA')).toMatch(/^•+$/);
  });
});

describe('prettyJson', () => {
  it('indents valid JSON', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
  });
  it('returns null for malformed JSON', () => {
    expect(prettyJson('{oops}')).toBeNull();
  });
});
