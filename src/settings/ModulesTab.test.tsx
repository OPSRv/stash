import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModulesTab } from './ModulesTab';
import { DEFAULT_SETTINGS, type Settings } from './store';

const renderTab = (overrides: Partial<Settings> = {}) => {
  const onChange = vi.fn();
  const settings: Settings = { ...DEFAULT_SETTINGS, ...overrides };
  render(<ModulesTab settings={settings} onChange={onChange} />);
  return { onChange };
};

describe('ModulesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists every module under Visible Tabs by default', () => {
    renderTab();
    const list = screen.getByRole('list', { name: /visible tabs/i });
    expect(list).toBeInTheDocument();
    // Settings is always the last visible row.
    expect(list.textContent).toContain('Settings');
    expect(list.textContent).toContain('Clipboard');
    // Separator's display title is "Stems".
    expect(list.textContent).toContain('Stems');
    // No Hidden section when nothing is hidden.
    expect(screen.queryByRole('list', { name: /hidden tabs/i })).toBeNull();
  });

  it('toggling a module off persists it to hiddenModules', async () => {
    const user = userEvent.setup();
    const { onChange } = renderTab();
    const hideSeparator = screen.getByRole('switch', { name: /hide stems/i });
    await user.click(hideSeparator);
    expect(onChange).toHaveBeenCalledWith('hiddenModules', expect.arrayContaining(['separator']));
  });

  it('moves disabled modules into the Hidden section', () => {
    renderTab({ hiddenModules: ['metronome'] });
    const hidden = screen.getByRole('list', { name: /hidden tabs/i });
    expect(hidden.textContent).toContain('Metronome');
    const visible = screen.getByRole('list', { name: /visible tabs/i });
    expect(visible.textContent).not.toContain('Metronome');
  });

  it('toggling a hidden module back on removes it from hiddenModules', async () => {
    const user = userEvent.setup();
    const { onChange } = renderTab({ hiddenModules: ['separator', 'metronome'] });
    await user.click(screen.getByRole('switch', { name: /show stems/i }));
    expect(onChange).toHaveBeenCalledWith('hiddenModules', expect.not.arrayContaining(['separator']));
    expect(onChange.mock.calls[0][1]).toContain('metronome');
  });

  it('Settings switch is labelled as not hidable', () => {
    renderTab();
    const settingsSwitch = screen.getByRole('switch', {
      name: /settings cannot be hidden/i,
    });
    expect(settingsSwitch).toBeInTheDocument();
  });

  it('Reset button is disabled when there are no overrides', () => {
    renderTab();
    expect(screen.getByRole('button', { name: /^Reset$/ })).toBeDisabled();
  });

  it('Reset clears hiddenModules and moduleOrder', async () => {
    const user = userEvent.setup();
    const { onChange } = renderTab({
      hiddenModules: ['metronome'],
      moduleOrder: ['notes', 'clipboard'],
    });
    await user.click(screen.getByRole('button', { name: /^Reset$/ }));
    expect(onChange).toHaveBeenCalledWith('hiddenModules', []);
    expect(onChange).toHaveBeenCalledWith('moduleOrder', []);
  });
});
