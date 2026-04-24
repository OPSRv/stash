import { useCallback, useEffect, useState } from 'react';

import { Button } from '../../../shared/ui/Button';
import { NumberInput } from '../../../shared/ui/NumberInput';
import { Toggle } from '../../../shared/ui/Toggle';
import { SettingRow } from '../../../settings/SettingRow';
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
    <>
      {error && (
        <div role="alert" className="py-3 t-danger text-meta">
          {error}
        </div>
      )}

      {ROWS.map((row) => (
        <SettingRow
          key={row.key}
          title={row.label}
          description={row.hint}
          control={
            <Toggle
              checked={settings[row.key]}
              label={row.label}
              onChange={(next) => mutate({ ...settings, [row.key]: next })}
            />
          }
        />
      ))}

      <SettingRow
        title="Calendar lead time"
        description="Minutes before an event to ping."
        control={
          <NumberInput
            size="sm"
            ariaLabel="Calendar lead minutes"
            min={1}
            max={120}
            value={settings.calendar_lead_minutes}
            disabled={busy}
            onChange={(v) => {
              const n = Math.max(1, Math.min(120, v ?? 1));
              void mutate({ ...settings, calendar_lead_minutes: n });
            }}
            suffix="min"
            className="w-[118px]"
          />
        }
      />

      <SettingRow
        title="Battery-low threshold"
        description="Charge percentage below which to ping."
        control={
          <NumberInput
            size="sm"
            ariaLabel="Battery threshold"
            min={1}
            max={99}
            value={settings.battery_threshold_pct}
            disabled={busy}
            onChange={(v) => {
              const n = Math.max(1, Math.min(99, v ?? 1));
              void mutate({ ...settings, battery_threshold_pct: n });
            }}
            suffix="%"
            className="w-[104px]"
          />
        }
      />

      <SettingRow
        title="Reload from disk"
        description={saved ? 'Saved.' : 'Re-read the on-disk config.'}
        control={
          <Button size="sm" disabled={busy} onClick={() => void refresh()}>
            Refresh
          </Button>
        }
      />
    </>
  );
}
