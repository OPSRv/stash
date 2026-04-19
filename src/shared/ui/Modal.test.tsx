import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Modal } from './Modal';

describe('Modal', () => {
  it('renders nothing when open=false', () => {
    render(
      <Modal open={false} onClose={() => {}} ariaLabel="x">
        inside
      </Modal>,
    );
    expect(screen.queryByText('inside')).toBeNull();
  });

  it('renders content and dialog role when open', () => {
    render(
      <Modal open onClose={() => {}} ariaLabel="modal-1">
        inside
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'modal-1');
    expect(screen.getByText('inside')).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} ariaLabel="m">
        <button>hi</button>
      </Modal>,
    );
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on backdrop click', async () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal open onClose={onClose} ariaLabel="m">
        <div>inner</div>
      </Modal>,
    );
    const backdrop = container.querySelector('[data-modal-backdrop]') as HTMLElement;
    await userEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not close on panel click', async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} ariaLabel="m">
        <div data-testid="panel-child">inner</div>
      </Modal>,
    );
    await userEvent.click(screen.getByTestId('panel-child'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close on backdrop when dismissOnBackdropClick=false', async () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal open onClose={onClose} ariaLabel="m" dismissOnBackdropClick={false}>
        inner
      </Modal>,
    );
    const backdrop = container.querySelector('[data-modal-backdrop]') as HTMLElement;
    await userEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });
});
