import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DropZone } from './DropZone';

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
const mockedOpen = vi.mocked(openDialog);

describe('DropZone', () => {
  beforeEach(() => {
    mockedOpen.mockReset();
  });

  it('rejects unsupported file extensions on drop', () => {
    const onPick = vi.fn();
    render(<DropZone onPick={onPick} />);
    const zone = screen.getByTestId('separator-dropzone');
    const fakeFile = Object.assign(new File([''], 'cover.png', { type: 'image/png' }), {
      path: '/x/cover.png',
    });
    fireEvent.drop(zone, { dataTransfer: { files: [fakeFile] } });
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/png/);
  });

  it('forwards a supported drop to onPick using the absolute path', () => {
    const onPick = vi.fn();
    render(<DropZone onPick={onPick} />);
    const zone = screen.getByTestId('separator-dropzone');
    const fakeFile = Object.assign(new File([''], 'song.mp3', { type: 'audio/mp3' }), {
      path: '/Music/song.mp3',
    });
    fireEvent.drop(zone, { dataTransfer: { files: [fakeFile] } });
    expect(onPick).toHaveBeenCalledWith('/Music/song.mp3');
  });

  it('opens a file picker on button click and forwards the choice', async () => {
    const onPick = vi.fn();
    mockedOpen.mockResolvedValue('/Music/picked.flac');
    render(<DropZone onPick={onPick} />);
    await userEvent.click(screen.getByRole('button', { name: /виберіть файл/i }));
    expect(mockedOpen).toHaveBeenCalled();
    // After the dialog resolves we should hand the path off.
    await Promise.resolve();
    expect(onPick).toHaveBeenCalledWith('/Music/picked.flac');
  });

  it('exposes pendingFile via data-pending-file for cross-module hand-offs', () => {
    render(<DropZone onPick={() => undefined} pendingFile="/Music/from-downloader.mp3" />);
    expect(screen.getByTestId('separator-dropzone')).toHaveAttribute(
      'data-pending-file',
      '/Music/from-downloader.mp3',
    );
  });
});
