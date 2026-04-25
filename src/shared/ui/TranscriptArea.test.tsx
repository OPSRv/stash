import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TranscriptArea } from './TranscriptArea';

describe('TranscriptArea', () => {
  describe('Transcribing state', () => {
    it('renders spinner and status text', () => {
      render(<TranscriptArea transcript={null} transcribing />);
      expect(screen.getByRole('status')).toBeInTheDocument();
      expect(screen.getByText('Транскрибую…')).toBeInTheDocument();
    });

    it('has aria-live=polite on the status element', () => {
      render(<TranscriptArea transcript={null} transcribing />);
      const status = screen.getByRole('status');
      expect(status).toHaveAttribute('aria-live', 'polite');
    });
  });

  describe('Failed state (no transcript)', () => {
    it('renders failure message', () => {
      render(<TranscriptArea transcript={null} failed />);
      expect(screen.getByText('⚠ Не вдалося транскрибувати')).toBeInTheDocument();
    });

    it('shows retry button when onRetry provided', () => {
      const onRetry = vi.fn();
      render(<TranscriptArea transcript={null} failed onRetry={onRetry} />);
      expect(screen.getByRole('button', { name: /спробувати/i })).toBeInTheDocument();
    });

    it('fires onRetry when retry button clicked', () => {
      const onRetry = vi.fn();
      render(<TranscriptArea transcript={null} failed onRetry={onRetry} />);
      fireEvent.click(screen.getByRole('button', { name: /спробувати/i }));
      expect(onRetry).toHaveBeenCalledOnce();
    });

    it('hides retry button when onRetry not provided', () => {
      render(<TranscriptArea transcript={null} failed />);
      expect(screen.queryByRole('button', { name: /спробувати/i })).not.toBeInTheDocument();
    });
  });

  describe('Idle state (no transcript, no transcribing, no failed)', () => {
    it('shows Transcribe button when onTranscribe provided', () => {
      const onTranscribe = vi.fn();
      render(<TranscriptArea transcript={null} onTranscribe={onTranscribe} />);
      expect(screen.getByRole('button', { name: /транскрибувати/i })).toBeInTheDocument();
    });

    it('fires onTranscribe when button clicked', () => {
      const onTranscribe = vi.fn();
      render(<TranscriptArea transcript={null} onTranscribe={onTranscribe} />);
      fireEvent.click(screen.getByRole('button', { name: /транскрибувати/i }));
      expect(onTranscribe).toHaveBeenCalledOnce();
    });

    it('hides Transcribe button when onTranscribe not provided', () => {
      render(<TranscriptArea transcript={null} />);
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
  });

  describe('Read-only transcript', () => {
    it('renders transcript text', () => {
      render(<TranscriptArea transcript="Hello world" />);
      expect(screen.getByText('Hello world')).toBeInTheDocument();
    });

    it('does not show edit button when onEdit not provided', () => {
      render(<TranscriptArea transcript="Hello world" />);
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('shows edit button when onEdit provided', () => {
      render(<TranscriptArea transcript="Hello world" onEdit={vi.fn()} />);
      expect(screen.getByRole('button', { name: /edit transcript/i })).toBeInTheDocument();
    });
  });

  describe('Editable transcript', () => {
    it('enters edit mode when edit button clicked', () => {
      render(<TranscriptArea transcript="Hello world" onEdit={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: /edit transcript/i }));
      expect(screen.getByRole('textbox', { name: /edit transcript/i })).toBeInTheDocument();
    });

    it('enters edit mode on double-click of transcript', () => {
      render(<TranscriptArea transcript="Hello world" onEdit={vi.fn()} />);
      fireEvent.doubleClick(screen.getByText('Hello world'));
      expect(screen.getByRole('textbox', { name: /edit transcript/i })).toBeInTheDocument();
    });

    it('calls onEdit with new value when Save clicked', async () => {
      const onEdit = vi.fn().mockResolvedValue(undefined);
      render(<TranscriptArea transcript="Hello world" onEdit={onEdit} />);
      fireEvent.click(screen.getByRole('button', { name: /edit transcript/i }));

      const textarea = screen.getByRole('textbox', { name: /edit transcript/i });
      fireEvent.change(textarea, { target: { value: 'Updated text' } });
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(onEdit).toHaveBeenCalledWith('Updated text'));
    });

    it('exits edit mode and restores draft after Cancel', () => {
      render(<TranscriptArea transcript="Hello world" onEdit={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: /edit transcript/i }));

      const textarea = screen.getByRole('textbox', { name: /edit transcript/i });
      fireEvent.change(textarea, { target: { value: 'Changed' } });
      fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.getByText('Hello world')).toBeInTheDocument();
    });

    it('exits edit mode after save completes', async () => {
      const onEdit = vi.fn().mockResolvedValue(undefined);
      render(<TranscriptArea transcript="Hello world" onEdit={onEdit} />);
      fireEvent.click(screen.getByRole('button', { name: /edit transcript/i }));
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    });
  });

  describe('Label overrides', () => {
    it('uses custom labels when provided', () => {
      render(
        <TranscriptArea
          transcript={null}
          transcribing
          labels={{ transcribing: 'Custom transcribing…' }}
        />,
      );
      expect(screen.getByText('Custom transcribing…')).toBeInTheDocument();
    });
  });
});
