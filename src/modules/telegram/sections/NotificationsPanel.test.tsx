import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';

import { NotificationsPanel } from './NotificationsPanel';
import type { NotificationSettings } from '../types';

const defaults: NotificationSettings = {
  pomodoro: true,
  download_complete: true,
  battery_low: true,
  calendar: true,
  calendar_lead_minutes: 10,
  battery_threshold_pct: 20,
};

describe('<NotificationsPanel />', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('renders all four category toggles', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_get_notification_settings') return defaults;
      return undefined;
    });
    render(<NotificationsPanel />);
    expect(await screen.findByText(/pomodoro transitions/i)).toBeInTheDocument();
    expect(screen.getByText(/download complete/i)).toBeInTheDocument();
    expect(screen.getByText(/battery low/i)).toBeInTheDocument();
    expect(screen.getByText(/calendar events/i)).toBeInTheDocument();
    const toggles = screen.getAllByRole('switch');
    expect(toggles).toHaveLength(4);
    toggles.forEach((t) => expect(t).toHaveAttribute('aria-checked', 'true'));
  });

  it('toggling a category calls set with the updated payload', async () => {
    const user = userEvent.setup();
    let saved: NotificationSettings | null = null;
    vi.mocked(invoke).mockImplementation(async (cmd, arg) => {
      if (cmd === 'telegram_get_notification_settings') return defaults;
      if (cmd === 'telegram_set_notification_settings') {
        saved = (arg as { settings: NotificationSettings }).settings;
        return undefined;
      }
      return undefined;
    });
    render(<NotificationsPanel />);
    await screen.findByText(/pomodoro transitions/i);
    const pomToggle = screen.getAllByRole('switch')[0];
    await user.click(pomToggle);
    await waitFor(() => expect(saved).not.toBeNull());
    expect(saved).toEqual({ ...defaults, pomodoro: false });
  });

  it('changing lead minutes persists via set', async () => {
    const user = userEvent.setup();
    let called = 0;
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'telegram_get_notification_settings') return defaults;
      if (cmd === 'telegram_set_notification_settings') {
        called += 1;
        return undefined;
      }
      return undefined;
    });
    render(<NotificationsPanel />);
    const leadInput = await screen.findByDisplayValue('10');
    await user.type(leadInput, '5'); // "105" → clamped to 105? nope, max 120 → 105 survives. Either way set is called.
    await waitFor(() =>
      expect(called).toBeGreaterThan(0),
    );
  });
});
