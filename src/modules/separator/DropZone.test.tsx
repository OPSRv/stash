import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DropZone } from './DropZone';

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

type DragDropPayload =
  | { type: 'enter'; paths: string[]; position: { x: number; y: number } }
  | { type: 'over'; position: { x: number; y: number } }
  | { type: 'drop'; paths: string[]; position: { x: number; y: number } }
  | { type: 'leave' };
type Handler = (event: { payload: DragDropPayload }) => void;

let registered: Handler | null = null;
const unlisten = vi.fn();
const onDragDropEvent = vi.fn(async (h: Handler) => {
  registered = h;
  return unlisten;
});

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent }),
}));

const fire = (payload: DragDropPayload) => {
  if (!registered) throw new Error('no handler registered');
  registered({ payload });
};

const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
const mockedOpen = vi.mocked(openDialog);

const flushSubscribe = async () => {
  // The webview subscription is async — wait two microtasks for it to register.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('DropZone', () => {
  beforeEach(() => {
    mockedOpen.mockReset();
    registered = null;
    onDragDropEvent.mockClear();
    unlisten.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects unsupported file extensions on drop', async () => {
    const onPick = vi.fn();
    render(<DropZone onPick={onPick} />);
    await flushSubscribe();
    act(() =>
      fire({ type: 'drop', paths: ['/x/cover.png'], position: { x: 0, y: 0 } }),
    );
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/png/);
  });

  it('forwards a supported drop to onPick using the absolute path', async () => {
    const onPick = vi.fn();
    render(<DropZone onPick={onPick} />);
    await flushSubscribe();
    act(() =>
      fire({ type: 'drop', paths: ['/Music/song.mp3'], position: { x: 0, y: 0 } }),
    );
    expect(onPick).toHaveBeenCalledWith('/Music/song.mp3');
  });

  it('opens a file picker when the dropzone is clicked and forwards the choice', async () => {
    const onPick = vi.fn();
    mockedOpen.mockResolvedValue('/Music/picked.flac');
    render(<DropZone onPick={onPick} />);
    await flushSubscribe();
    // The whole zone is now the affordance — `role="button"` with the
    // accessible label below; clicking anywhere on it opens the picker.
    await userEvent.click(
      screen.getByRole('button', { name: /drop or pick an audio file/i }),
    );
    expect(mockedOpen).toHaveBeenCalled();
    await Promise.resolve();
    expect(onPick).toHaveBeenCalledWith('/Music/picked.flac');
  });

  it('opens the picker on Enter / Space (keyboard activation)', async () => {
    const onPick = vi.fn();
    mockedOpen.mockResolvedValue('/Music/keyboard.wav');
    render(<DropZone onPick={onPick} />);
    await flushSubscribe();
    const zone = screen.getByRole('button', { name: /drop or pick an audio file/i });
    zone.focus();
    await userEvent.keyboard('{Enter}');
    expect(mockedOpen).toHaveBeenCalled();
    await Promise.resolve();
    expect(onPick).toHaveBeenCalledWith('/Music/keyboard.wav');
  });

  it('exposes pendingFile via data-pending-file for cross-module hand-offs', async () => {
    render(<DropZone onPick={() => undefined} pendingFile="/Music/from-downloader.mp3" />);
    await flushSubscribe();
    expect(screen.getByTestId('separator-dropzone')).toHaveAttribute(
      'data-pending-file',
      '/Music/from-downloader.mp3',
    );
  });
});
