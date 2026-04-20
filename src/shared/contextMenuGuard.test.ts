import { afterEach, describe, expect, it } from 'vitest';
import { installContextMenuGuard } from './contextMenuGuard';

describe('installContextMenuGuard', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.innerHTML = '';
  });

  const fire = (target: Element) => {
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    return ev;
  };

  it('prevents default on non-editable elements', () => {
    cleanup = installContextMenuGuard(window);
    const div = document.createElement('div');
    document.body.append(div);
    expect(fire(div).defaultPrevented).toBe(true);
  });

  it('allows the native menu inside <input>', () => {
    cleanup = installContextMenuGuard(window);
    const input = document.createElement('input');
    document.body.append(input);
    expect(fire(input).defaultPrevented).toBe(false);
  });

  it('allows the native menu inside <textarea>', () => {
    cleanup = installContextMenuGuard(window);
    const ta = document.createElement('textarea');
    document.body.append(ta);
    expect(fire(ta).defaultPrevented).toBe(false);
  });

  it('allows the native menu inside contenteditable hosts', () => {
    cleanup = installContextMenuGuard(window);
    const host = document.createElement('div');
    host.setAttribute('contenteditable', 'true');
    const child = document.createElement('span');
    host.append(child);
    document.body.append(host);
    expect(fire(child).defaultPrevented).toBe(false);
  });

  it('returns a disposer that removes the listener', () => {
    const dispose = installContextMenuGuard(window);
    dispose();
    const div = document.createElement('div');
    document.body.append(div);
    expect(fire(div).defaultPrevented).toBe(false);
  });
});
