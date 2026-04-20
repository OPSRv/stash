import { describe, expect, test } from 'vitest';

import { buildModel } from './provider';

describe('buildModel', () => {
  test('openai returns a model handle', async () => {
    const m = await buildModel(
      { provider: 'openai', model: 'gpt-4o', baseUrl: null },
      'sk-test',
    );
    expect(m).toBeDefined();
  });

  test('anthropic returns a model handle', async () => {
    const m = await buildModel(
      { provider: 'anthropic', model: 'claude-opus-4-7', baseUrl: null },
      'sk-test',
    );
    expect(m).toBeDefined();
  });

  test('google returns a model handle', async () => {
    const m = await buildModel(
      { provider: 'google', model: 'gemini-2.5-pro', baseUrl: null },
      'key',
    );
    expect(m).toBeDefined();
  });

  test('custom with baseUrl works', async () => {
    const m = await buildModel(
      { provider: 'custom', model: 'llama3', baseUrl: 'http://localhost:11434/v1' },
      'unused',
    );
    expect(m).toBeDefined();
  });

  test('custom without baseUrl rejects', async () => {
    await expect(
      buildModel(
        { provider: 'custom', model: 'x', baseUrl: null },
        'k',
      ),
    ).rejects.toThrow(/base URL/i);
  });
});
