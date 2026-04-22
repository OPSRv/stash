import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Drawer } from './Drawer';

describe('Drawer', () => {
  it('renders children with role=dialog when open', () => {
    render(
      <Drawer open ariaLabel="History" onClose={() => {}}>
        <p>Contents</p>
      </Drawer>,
    );
    expect(screen.getByRole('dialog', { name: 'History' })).toBeInTheDocument();
    expect(screen.getByText('Contents')).toBeInTheDocument();
  });

  it('does not render when closed and never opened', () => {
    render(
      <Drawer open={false} ariaLabel="History" onClose={() => {}}>
        <p>Contents</p>
      </Drawer>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape calls onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Drawer open ariaLabel="x" onClose={onClose}>
        <p>hi</p>
      </Drawer>,
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking backdrop calls onClose by default', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Drawer open ariaLabel="x" onClose={onClose}>
        <p>hi</p>
      </Drawer>,
    );
    const backdrop = document.querySelector('[data-drawer-backdrop]') as HTMLElement;
    await user.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it('dismissOnBackdropClick=false keeps the drawer open', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Drawer open ariaLabel="x" onClose={onClose} dismissOnBackdropClick={false}>
        <p>hi</p>
      </Drawer>,
    );
    const backdrop = document.querySelector('[data-drawer-backdrop]') as HTMLElement;
    await user.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });
});
