import { describe, it, expect } from 'vitest';
import { detectType } from './contentType';

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
