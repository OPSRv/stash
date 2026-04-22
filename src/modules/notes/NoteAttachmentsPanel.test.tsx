import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';

import { NoteAttachmentsPanel } from './NoteAttachmentsPanel';
import type { NoteAttachment } from './api';

const mkAttachment = (over: Partial<NoteAttachment> = {}): NoteAttachment => ({
  id: 1,
  note_id: 10,
  file_path: '/app/data/notes/attachments/10/abc_report.pdf',
  original_name: 'report.pdf',
  mime_type: 'application/pdf',
  size_bytes: 2048,
  created_at: 1,
  ...over,
});

describe('<NoteAttachmentsPanel />', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('empty state shows the + Attach file prompt', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'notes_list_attachments') return [];
      return undefined;
    });
    render(<NoteAttachmentsPanel noteId={10} />);
    expect(
      await screen.findByRole('button', { name: /attach file/i }),
    ).toBeInTheDocument();
  });

  it('renders attachments and lets the user remove one', async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'notes_list_attachments')
        return [mkAttachment({ id: 7 })];
      if (cmd === 'notes_remove_attachment') return undefined;
      return undefined;
    });
    render(<NoteAttachmentsPanel noteId={10} />);
    await screen.findByText(/report.pdf/);
    await user.click(
      screen.getByRole('button', { name: /remove attachment/i }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('notes_remove_attachment', { id: 7 }),
    );
  });

  it('renders an inline <img> for image attachments', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'notes_list_attachments')
        return [
          mkAttachment({
            id: 8,
            original_name: 'cat.png',
            mime_type: 'image/png',
            file_path: '/app/notes/8.png',
          }),
        ];
      return undefined;
    });
    render(<NoteAttachmentsPanel noteId={10} />);
    const img = await screen.findByAltText('cat.png');
    expect(img).toBeInstanceOf(HTMLImageElement);
    expect(img.getAttribute('src')).toContain('asset://localhost');
  });
});
