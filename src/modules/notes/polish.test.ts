import { beforeEach, describe, expect, it, vi } from 'vitest';
import { polishTranscript } from './polish';
import type { AiSettings } from '../ai/useAiSettings';

const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock('ai', () => ({
  generateText: generateTextMock,
}));
vi.mock('../ai/provider', () => ({
  buildModel: vi.fn((cfg, key) => ({ __mock: true, cfg, key })),
}));

const baseSettings: AiSettings = {
  aiProvider: 'openai',
  aiModel: 'gpt-4o-mini',
  aiBaseUrl: null,
  aiSystemPrompt: '',
  aiApiKeys: { openai: 'sk-test' },
  aiWebServices: [],
};

describe('polishTranscript', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  it('returns the polished text on success', async () => {
    generateTextMock.mockResolvedValue({ text: ' Привіт, світе. ' });
    const out = await polishTranscript('привіт світе', baseSettings);
    expect(out).toEqual({ kind: 'ok', text: 'Привіт, світе.' });
  });

  it('calls the SDK with temperature 0 so polish is deterministic', async () => {
    generateTextMock.mockResolvedValue({ text: 'ok' });
    await polishTranscript('hello', baseSettings);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const call = generateTextMock.mock.calls[0][0];
    expect(call.temperature).toBe(0);
    expect(call.system).toMatch(/YOU MUST NOT/);
    expect(call.prompt).toBe('hello');
  });

  it('skips when the transcript is empty', async () => {
    const out = await polishTranscript('   ', baseSettings);
    expect(out).toEqual({ kind: 'skipped', reason: 'empty transcript' });
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('skips when no model is configured', async () => {
    const out = await polishTranscript('x', { ...baseSettings, aiModel: '' });
    expect(out.kind).toBe('skipped');
  });

  it('skips when the active provider has no API key', async () => {
    const out = await polishTranscript('x', {
      ...baseSettings,
      aiProvider: 'anthropic',
      aiApiKeys: {},
    });
    expect(out.kind).toBe('skipped');
  });

  it('allows custom provider without an API key (local endpoints)', async () => {
    generateTextMock.mockResolvedValue({ text: 'ok' });
    const out = await polishTranscript('x', {
      ...baseSettings,
      aiProvider: 'custom',
      aiBaseUrl: 'http://localhost:11434/v1',
      aiApiKeys: {},
    });
    expect(out.kind).toBe('ok');
  });
});
