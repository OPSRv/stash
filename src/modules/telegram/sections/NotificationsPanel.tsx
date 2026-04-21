import { useCallback, useEffect, useState } from 'react';

import { Button } from '../../../shared/ui/Button';
import { Input } from '../../../shared/ui/Input';
import { Toggle } from '../../../shared/ui/Toggle';
import * as api from '../api';
import type { NotificationSettings } from '../types';

type Row = {
  key: keyof Pick<
    NotificationSettings,
    'pomodoro' | 'download_complete' | 'battery_low' | 'calendar'
  >;
  label: string;
  hint: string;
};

const ROWS: Row[] = [
  {
    key: 'pomodoro',
    label: 'Pomodoro transitions',
    hint: 'Block changes and session completion.',
  },
  {
    key: 'download_complete',
    label: 'Download complete',
    hint: 'yt-dlp job finished.',
  },
  {
    key: 'battery_low',
    label: 'Battery low',
    hint: 'Pings when below threshold and not charging.',
  },
  {
    key: 'calendar',
    label: 'Calendar events',
    hint: 'Heads-up before an event in Calendar.app starts.',
  },
];

export function NotificationsPanel() {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSettings(await api.getNotificationSettings());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mutate = async (next: NotificationSettings) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.setNotificationSettings(next);
      setSettings(next);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1_500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return null;

  return (
    <section className="p-4 flex flex-col gap-4">
      <h2 className="text-base font-semibold">Notifications</h2>
      {error && (
        <p role="alert" className="text-sm text-[rgba(239,68,68,0.9)]">
          {error}
        </p>
      )}

      <ul className="flex flex-col gap-2" aria-label="category toggles">
        {ROWS.map((row) => (
          <li
            key={row.key}
            className="flex items-start justify-between gap-3 border border-white/10 rounded-md p-2"
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{row.label}</p>
              <p className="text-xs t-secondary">{row.hint}</p>
            </div>
            <Toggle
              checked={settings[row.key]}
              label={row.label}
              onChange={(next) =>
                mutate({ ...settings, [row.key]: next })
              }
            />
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm">
          <span className="flex-1">Calendar lead time (minutes)</span>
          <Input
            type="number"
            min={1}
            max={120}
            value={settings.calendar_lead_minutes}
            disabled={busy}
            onChange={(e) => {
              const n = Math.max(1, Math.min(120, Number(e.target.value) || 1));
              void mutate({ ...settings, calendar_lead_minutes: n });
            }}
            className="w-20"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="flex-1">Battery-low threshold (%)</span>
          <Input
            type="number"
            min={1}
            max={99}
            value={settings.battery_threshold_pct}
            disabled={busy}
            onChange={(e) => {
              const n = Math.max(1, Math.min(99, Number(e.target.value) || 1));
              void mutate({ ...settings, battery_threshold_pct: n });
            }}
            className="w-20"
          />
        </label>
      </div>

      {saved && <p className="text-xs t-secondary">Saved.</p>}

      <div>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => void refresh()}
          title="Reload from disk"
        >
          Refresh
        </Button>
      </div>
    </section>
  );
}
