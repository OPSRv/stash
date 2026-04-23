import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useVoiceRecorder } from './useVoiceRecorder';

vi.mock('../util/encodeWav', () => ({
  blobToWav16Mono: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
}));

import { invoke } from '@tauri-apps/api/core';
const invokeMock = vi.mocked(invoke);

class FakeMediaRecorder {
  static lastInstance: FakeMediaRecorder | null = null;
  static isTypeSupported = () => true;
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: MediaStream, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? 'audio/webm';
    FakeMediaRecorder.lastInstance = this;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])]) });
    this.onstop?.();
  }
}

const stubStream: MediaStream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;

beforeEach(() => {
  vi.clearAllMocks();
  FakeMediaRecorder.lastInstance = null;
  (globalThis as unknown as { MediaRecorder: typeof FakeMediaRecorder }).MediaRecorder =
    FakeMediaRecorder;
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(stubStream) },
  });
});

describe('useVoiceRecorder', () => {
  it('walks the idle → recording → transcribing → idle path and fires onTranscript', async () => {
    invokeMock.mockResolvedValueOnce('привіт, включи метроном');
    const onTranscript = vi.fn();

    const { result } = renderHook(() => useVoiceRecorder({ onTranscript }));
    expect(result.current.phase).toBe('idle');

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.phase).toBe('recording');

    await act(async () => {
      result.current.stop();
    });

    await waitFor(() => {
      expect(onTranscript).toHaveBeenCalledWith('привіт, включи метроном');
      expect(result.current.phase).toBe('idle');
    });
  });

  it('calls onEmpty instead of onTranscript when whisper returns empty text', async () => {
    invokeMock.mockResolvedValueOnce('   ');
    const onTranscript = vi.fn();
    const onEmpty = vi.fn();

    const { result } = renderHook(() =>
      useVoiceRecorder({ onTranscript, onEmpty }),
    );

    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      result.current.stop();
    });

    await waitFor(() => {
      expect(onEmpty).toHaveBeenCalled();
    });
    // Empty transcripts must not get forwarded to the consumer — the AI
    // composer would otherwise silently append whitespace to the input.
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('surfaces a readable error when microphone access is denied', async () => {
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockRejectedValue(new Error('NotAllowed')) },
    });
    const { result } = renderHook(() => useVoiceRecorder({ onTranscript: vi.fn() }));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.phase).toBe('error');
    expect(result.current.error).toMatch(/мікрофон/i);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
