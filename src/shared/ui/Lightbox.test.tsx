import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { Lightbox } from './Lightbox';
import { ToastProvider } from './Toast';

const renderLightbox = (path?: string) =>
  render(
    <ToastProvider>
      <Lightbox
        src={path ?? 'asset://localhost/photo.png'}
        alt="photo"
        onClose={() => undefined}
        path={path}
      />
    </ToastProvider>,
  );

describe('<Lightbox />', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(saveDialog).mockReset();
  });

  it('right-click on the image opens a menu with Copy + Save items', async () => {
    const user = userEvent.setup();
    renderLightbox('/Users/x/photo.png');
    const img = screen.getByAltText('photo');
    await user.pointer({ keys: '[MouseRight]', target: img });
    expect(screen.getByRole('menuitem', { name: /Copy image/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Save image as/ })).toBeInTheDocument();
  });

  it('Copy image dispatches clipboard_copy_image_from_path with the source path', async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockResolvedValue(undefined);
    renderLightbox('/Users/x/cat.jpg');
    await user.pointer({ keys: '[MouseRight]', target: screen.getByAltText('photo') });
    await user.click(screen.getByRole('menuitem', { name: /Copy image/ }));
    expect(invoke).toHaveBeenCalledWith('clipboard_copy_image_from_path', {
      path: '/Users/x/cat.jpg',
    });
  });

  it('Save image as picks a destination via the dialog plugin and copies the file', async () => {
    const user = userEvent.setup();
    vi.mocked(saveDialog).mockResolvedValue('/Users/x/out/cat.jpg');
    vi.mocked(invoke).mockImplementation(async () => undefined);
    renderLightbox('/Users/x/cat.jpg');
    await user.pointer({ keys: '[MouseRight]', target: screen.getByAltText('photo') });
    await user.click(screen.getByRole('menuitem', { name: /Save image as/ }));
    // Dialog opened with the original filename pre-filled.
    expect(saveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: 'cat.jpg' }),
    );
    expect(invoke).toHaveBeenCalledWith('save_file_to', {
      src: '/Users/x/cat.jpg',
      dst: '/Users/x/out/cat.jpg',
    });
  });

  it('disables menu items when the source path is unknown (asset URL only)', async () => {
    const user = userEvent.setup();
    renderLightbox(undefined);
    await user.pointer({ keys: '[MouseRight]', target: screen.getByAltText('photo') });
    expect(screen.getByRole('menuitem', { name: /Copy image/ })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: /Save image as/ })).toBeDisabled();
  });
});
