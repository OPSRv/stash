import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('returns null when closed', () => {
    const { container } = render(
      <ConfirmDialog open={false} title="T" onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders title and description when open', () => {
    render(
      <ConfirmDialog
        open
        title="Delete?"
        description="This cannot be undone."
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText('Delete?')).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
  });

  it('Esc triggers onCancel', () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="T" onConfirm={() => {}} onCancel={onCancel} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('Enter triggers onConfirm', () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog open title="T" onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('clicking backdrop calls onCancel', () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="T" onConfirm={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('presentation'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('Confirm button calls onConfirm', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="T"
        confirmLabel="Yes"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByText('Yes'));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
