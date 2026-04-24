import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { NoteAiBar } from './NoteAiBar';

// The hook reads settings from the store; stub it so tests can flip the
// ready/unready state without touching Rust IPC.
const settingsRef = { value: makeSettings() };
function makeSettings(overrides: Record<string, unknown> = {}) {
  return {
    aiProvider: 'openai' as const,
    aiModel: 'gpt-4',
    aiBaseUrl: null,
    aiSystemPrompt: '',
    aiApiKeys: { openai: 'sk-test', anthropic: '', google: '', custom: '' },
    ...overrides,
  };
}
vi.mock('../ai/useAiSettings', () => ({
  useAiSettings: () => settingsRef.value,
}));

// Control the stream from tests: push chunks manually, optionally throw.
// When `hangAfterChunks` is true, the generator awaits an abort instead of
// finishing — letting a test reliably click Stop mid-stream.
const streamControl: {
  chunks: string[];
  throwError?: Error;
  hangAfterChunks: boolean;
} = { chunks: [], hangAfterChunks: false };
let receivedAbortSignal: AbortSignal | null = null;

vi.mock('ai', () => ({
  streamText: ({ abortSignal }: { abortSignal?: AbortSignal }) => {
    receivedAbortSignal = abortSignal ?? null;
    const err = streamControl.throwError;
    const chunks = streamControl.chunks.slice();
    const hang = streamControl.hangAfterChunks;
    return {
      textStream: (async function* () {
        for (const c of chunks) {
          if (abortSignal?.aborted) {
            throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          }
          await Promise.resolve();
          yield c;
        }
        if (hang) {
          await new Promise<void>((_, reject) => {
            if (abortSignal?.aborted) {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              return;
            }
            abortSignal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          });
        }
        if (err) throw err;
      })(),
    };
  },
}));

vi.mock('../ai/provider', () => ({
  buildModel: vi.fn().mockResolvedValue({ id: 'stub-model' }),
}));

beforeEach(() => {
  settingsRef.value = makeSettings();
  streamControl.chunks = [];
  streamControl.throwError = undefined;
  streamControl.hangAfterChunks = false;
  receivedAbortSignal = null;
});

const noopStubs = {
  onUndo: () => {},
  onRedo: () => {},
  canUndo: false,
  canRedo: false,
  beginTransaction: () => {},
  endTransaction: () => {},
};

describe('NoteAiBar', () => {
  it('streams AI output into the body via onBodyChange', async () => {
    const user = userEvent.setup();
    streamControl.chunks = ['Para 1 rewritten.', '\n\nPara 2 kept.'];
    const onBodyChange = vi.fn();

    render(
      <NoteAiBar
        noteTitle="Demo"
        body="Original body"
        onBodyChange={onBodyChange}
        onClose={() => {}}
        {...noopStubs}
      />,
    );

    await user.type(screen.getByLabelText('AI instruction for this note'), 'rewrite it');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(onBodyChange).toHaveBeenLastCalledWith('Para 1 rewritten.\n\nPara 2 kept.');
    });
    // First chunk lands before the second — verifies progressive streaming.
    expect(onBodyChange.mock.calls.map((c) => c[0])).toEqual([
      'Para 1 rewritten.',
      'Para 1 rewritten.\n\nPara 2 kept.',
    ]);
  });

  it('reverts to the original body when the user stops mid-stream', async () => {
    const user = userEvent.setup();
    streamControl.chunks = ['partial…'];
    streamControl.hangAfterChunks = true;
    const onBodyChange = vi.fn();

    render(
      <NoteAiBar
        noteTitle="Demo"
        body="ORIGINAL"
        onBodyChange={onBodyChange}
        onClose={() => {}}
        {...noopStubs}
      />,
    );

    await user.type(screen.getByLabelText('AI instruction for this note'), 'do it');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    // Wait until the first chunk has landed, then abort.
    await waitFor(() => {
      expect(onBodyChange).toHaveBeenCalledWith('partial…');
    });
    await user.click(screen.getByRole('button', { name: 'Stop and revert' }));

    await waitFor(() => {
      expect(onBodyChange).toHaveBeenLastCalledWith('ORIGINAL');
    });
    expect(receivedAbortSignal?.aborted).toBe(true);
  });

  it('disables Send when AI is not configured', () => {
    settingsRef.value = makeSettings({ aiApiKeys: { openai: '', anthropic: '', google: '', custom: '' } });

    render(
      <NoteAiBar
        noteTitle="Demo"
        body="hi"
        onBodyChange={() => {}}
        onClose={() => {}}
        {...noopStubs}
      />,
    );

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByLabelText('AI instruction for this note')).toBeDisabled();
  });
});
