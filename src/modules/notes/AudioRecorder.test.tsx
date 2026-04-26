import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioRecorder } from './AudioRecorder';

/** Minimal MediaRecorder stub — enough to let AudioRecorder wire event
 *  handlers and advance through its state machine without actually decoding
 *  audio. */
class MockMediaRecorder {
  static isTypeSupported = () => true;
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(
    public stream: MediaStream,
    public opts?: MediaRecorderOptions
  ) {}
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['x']) });
    this.onstop?.();
  }
}

class MockAnalyser {
  fftSize = 512;
  connect() {}
  disconnect() {}
  getByteTimeDomainData(buf: Uint8Array) {
    buf.fill(128);
  }
}

class MockAudioContext {
  createMediaStreamSource() {
    return { connect: () => {} };
  }
  createAnalyser() {
    return new MockAnalyser();
  }
  close() {
    return Promise.resolve();
  }
}

type Device = { deviceId: string; label: string; kind: 'audioinput' };

const makeTrack = (deviceId: string) => ({
  stop: vi.fn(),
  getSettings: () => ({ deviceId }),
});

const makeStream = (deviceId: string): MediaStream => {
  const tracks = [makeTrack(deviceId)];
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
  } as unknown as MediaStream;
};

const installMediaMocks = (devices: Device[]) => {
  const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
    const audio = constraints.audio;
    if (typeof audio === 'object' && audio?.deviceId) {
      const exact = (audio.deviceId as { exact?: string }).exact;
      const match = devices.find((d) => d.deviceId === exact);
      if (!match) {
        const e = new Error('overconstrained');
        (e as unknown as { name: string }).name = 'OverconstrainedError';
        throw e;
      }
      return makeStream(match.deviceId);
    }
    return makeStream(devices[0]?.deviceId ?? 'default');
  });
  const enumerateDevices = vi.fn(async () => devices as unknown as MediaDeviceInfo[]);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia, enumerateDevices },
  });
  return { getUserMedia, enumerateDevices };
};

// jsdom's localStorage under node 25 occasionally lacks methods. Install a
// simple in-memory Storage polyfill so the picker's persistence branch is
// exercised deterministically.
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(k: string) {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
  (globalThis as unknown as { MediaRecorder: typeof MockMediaRecorder }).MediaRecorder =
    MockMediaRecorder;
  (globalThis as unknown as { AudioContext: typeof MockAudioContext }).AudioContext =
    MockAudioContext;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1 as number);
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AudioRecorder mic selection', () => {
  it('records on the default mic first open and saves the iPhone as preference for the next', async () => {
    const { getUserMedia } = installMediaMocks([
      { deviceId: 'mac', label: 'MacBook Pro Microphone', kind: 'audioinput' },
      { deviceId: 'phone', label: "Sasha's iPhone Microphone", kind: 'audioinput' },
    ]);

    render(<AudioRecorder open onCancel={() => {}} onComplete={() => {}} />);

    // Only one getUserMedia on open — the iPhone discovery runs off the
    // critical path, so the first recording starts instantly on the default
    // mic. The iPhone id is instead cached for subsequent opens.
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    expect(getUserMedia.mock.calls[0][0]).toEqual({ audio: true });
    await waitFor(() => {
      expect(localStorage.getItem('stash:notes:micDeviceId')).toBe('phone');
    });
  });

  it('respects a saved mic preference and skips the auto-switch', async () => {
    localStorage.setItem('stash:notes:micDeviceId', 'mac');
    const { getUserMedia } = installMediaMocks([
      { deviceId: 'mac', label: 'MacBook Pro Microphone', kind: 'audioinput' },
      { deviceId: 'phone', label: "Sasha's iPhone Microphone", kind: 'audioinput' },
    ]);

    render(<AudioRecorder open onCancel={() => {}} onComplete={() => {}} />);

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    const call = getUserMedia.mock.calls[0][0] as MediaStreamConstraints;
    expect((call.audio as { deviceId: { exact: string } }).deviceId.exact).toBe('mac');
  });

  it('falls back to the default mic if the saved device is gone', async () => {
    localStorage.setItem('stash:notes:micDeviceId', 'ghost');
    const { getUserMedia } = installMediaMocks([
      { deviceId: 'mac', label: 'MacBook Pro Microphone', kind: 'audioinput' },
    ]);

    render(<AudioRecorder open onCancel={() => {}} onComplete={() => {}} />);

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    // Second call uses the unconstrained default.
    expect(getUserMedia.mock.calls[1][0]).toEqual({ audio: true });
    // Stale preference was cleared and then replaced with the mic we
    // actually ended up on, so next open goes straight to it.
    await waitFor(() => {
      expect(localStorage.getItem('stash:notes:micDeviceId')).toBe('mac');
    });
  });

  it('persists a manual mic change via the picker', async () => {
    installMediaMocks([
      { deviceId: 'mac', label: 'MacBook Pro Microphone', kind: 'audioinput' },
      { deviceId: 'usb', label: 'USB Condenser', kind: 'audioinput' },
    ]);

    render(<AudioRecorder open onCancel={() => {}} onComplete={() => {}} />);

    // Picker appears once devices enumerate and there's >1 mic.
    const combobox = await screen.findByRole('combobox', { name: /microphone/i });
    await act(async () => {
      await userEvent.click(combobox);
    });
    await act(async () => {
      await userEvent.click(await screen.findByRole('option', { name: /USB Condenser/i }));
    });

    await waitFor(() => {
      expect(localStorage.getItem('stash:notes:micDeviceId')).toBe('usb');
    });
  });
});

describe('AudioRecorder unmount safety', () => {
  it('stops the MediaRecorder when unmounted mid-recording', async () => {
    installMediaMocks([
      { deviceId: 'mac', label: 'MacBook Pro Microphone', kind: 'audioinput' },
    ]);
    const stopSpy = vi.spyOn(MockMediaRecorder.prototype, 'stop');

    const { unmount } = render(
      <AudioRecorder open onCancel={() => {}} onComplete={() => {}} />,
    );

    // Wait for recording to engage.
    await waitFor(() => expect(screen.getByText(/recording/i)).toBeTruthy());

    unmount();

    // Cleanup must explicitly stop the recorder so the underlying audio
    // graph is released — without this fix the MediaRecorder kept emitting
    // dataavailable into a detached chunk array.
    expect(stopSpy).toHaveBeenCalled();
  });
});
