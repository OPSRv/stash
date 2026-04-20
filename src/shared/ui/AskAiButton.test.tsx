import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AskAiButton, askAiWithText } from './AskAiButton';

describe('askAiWithText', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches prefill + navigate with newSession on non-empty text', () => {
    const spy = vi.spyOn(window, 'dispatchEvent');
    askAiWithText('  hello  ');
    expect(spy).toHaveBeenCalledTimes(2);
    const prefill = spy.mock.calls[0][0] as CustomEvent;
    expect(prefill.type).toBe('stash:ai-prefill');
    expect(prefill.detail).toEqual({ text: 'hello', newSession: true });
    const nav = spy.mock.calls[1][0] as CustomEvent;
    expect(nav.type).toBe('stash:navigate');
    expect(nav.detail).toBe('ai');
  });

  it('no-ops on whitespace-only input', () => {
    const spy = vi.spyOn(window, 'dispatchEvent');
    askAiWithText('   ');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('AskAiButton', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires on click with a static text prop', () => {
    const spy = vi.spyOn(window, 'dispatchEvent');
    render(<AskAiButton text="hi" />);
    fireEvent.click(screen.getByRole('button'));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('evaluates a lazy text function only on click', () => {
    const getter = vi.fn(() => 'late');
    render(<AskAiButton text={getter} />);
    expect(getter).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button'));
    expect(getter).toHaveBeenCalledTimes(1);
  });

  it('is disabled and shows an informative tooltip', () => {
    render(<AskAiButton text="" disabled />);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-label', expect.stringMatching(/nothing to ask/i));
    expect(screen.getByRole('tooltip')).toHaveTextContent(/nothing to ask/i);
  });
});
