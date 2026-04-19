import { describe, expect, test } from 'vitest';

import { buildModel } from './provider';

describe('buildModel', () => {
  test('openai returns a model handle', () => {
    const m = buildModel(
      { provider: 'openai', model: 'gpt-4o', baseUrl: null },
      'sk-test',
    );
    expect(m).toBeDefined();
  });

  test('anthropic returns a model handle', () => {
    const m = buildModel(
      { provider: 'anthropic', model: 'claude-opus-4-7', baseUrl: null },
      'sk-test',
    );
    expect(m).toBeDefined();
  });

  test('google returns a model handle', () => {
    const m = buildModel(
      { provider: 'google', model: 'gemini-2.5-pro', baseUrl: null },
      'key',
    );
    expect(m).toBeDefined();
  });

  test('custom with baseUrl works', () => {
    const m = buildModel(
      { provider: 'custom', model: 'llama3', baseUrl: 'http://localhost:11434/v1' },
      'unused',
    );
    expect(m).toBeDefined();
  });

  test('custom without baseUrl throws', () => {
    expect(() =>
      buildModel(
        { provider: 'custom', model: 'x', baseUrl: null },
        'k',
      ),
    ).toThrow(/base URL/i);
  });
});
