import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ContextMenu, type ContextMenuItem } from './ContextMenu';

const makeItems = (onFoo = () => {}, onBar = () => {}): ContextMenuItem[] => [
  { kind: 'action', label: 'Foo', onSelect: onFoo },
  { kind: 'separator' },
  { kind: 'action', label: 'Bar', onSelect: onBar, tone: 'danger' },
  { kind: 'action', label: 'Disabled', onSelect: () => {}, disabled: true },
];

describe('ContextMenu', () => {
  it('renders each action as a menuitem and separators as separators', () => {
    render(
      <ContextMenu
        open
        x={40}
        y={40}
        items={makeItems()}
        onClose={() => {}}
        label="Test menu"
      />,
    );
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    expect(screen.getByRole('separator')).toBeInTheDocument();
    expect(screen.getByRole('menu', { name: 'Test menu' })).toBeInTheDocument();
  });

  it('fires onSelect and closes on click', async () => {
    const user = userEvent.setup();
    const onFoo = vi.fn();
    const onClose = vi.fn();
    render(
      <ContextMenu
        open
        x={0}
        y={0}
        items={makeItems(onFoo)}
        onClose={onClose}
        label="Test"
      />,
    );
    await user.click(screen.getByText('Foo'));
    expect(onFoo).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('does not fire onSelect for disabled items', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const items: ContextMenuItem[] = [
      { kind: 'action', label: 'X', onSelect: vi.fn(), disabled: true },
    ];
    render(<ContextMenu open x={0} y={0} items={items} onClose={onClose} label="Test" />);
    await user.click(screen.getByText('X'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ContextMenu open x={0} y={0} items={makeItems()} onClose={onClose} label="Test" />,
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('returns null when closed', () => {
    const { container } = render(
      <ContextMenu
        open={false}
        x={0}
        y={0}
        items={makeItems()}
        onClose={() => {}}
        label="Test"
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('clamps position inside the viewport', () => {
    // Put the cursor at the bottom-right corner; menu should not overflow.
    const { container } = render(
      <ContextMenu
        open
        x={9999}
        y={9999}
        items={makeItems()}
        onClose={() => {}}
        label="Test"
      />,
    );
    const panel = container.querySelector('[role="menu"]') as HTMLElement;
    const left = Number(panel.style.left.replace('px', ''));
    const top = Number(panel.style.top.replace('px', ''));
    // Default jsdom viewport is 1024×768.
    expect(left).toBeLessThan(1024);
    expect(top).toBeLessThan(768);
  });
});
