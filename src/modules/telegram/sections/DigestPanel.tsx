import { useCallback, useEffect, useState } from 'react';

import { Button } from '../../../shared/ui/Button';
import { Input } from '../../../shared/ui/Input';
import { Toggle } from '../../../shared/ui/Toggle';
import { SettingRow } from '../../../settings/SettingRow';
import * as api from '../api';
import type { DigestSettings } from '../types';

/// Bit 0 = Monday … bit 6 = Sunday — mirrors `settings::DigestSettings`.
const DAYS: { label: string; full: string }[] = [
  { label: 'Mo', full: 'Monday' },
  { label: 'Tu', full: 'Tuesday' },
  { label: 'We', full: 'Wednesday' },
  { label: 'Th', full: 'Thursday' },
  { label: 'Fr', full: 'Friday' },
  { label: 'Sa', full: 'Saturday' },
  { label: 'Su', full: 'Sunday' },
];

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/// Morning digest controls: on/off, local send time, weekdays and a
/// "send now" action. Toggles persist immediately; the time persists on
/// blur / Enter so intermediate keystrokes ("07:00" while retyping
/// 08:00 → 07:45) never reach the scheduler.
export function DigestPanel() {
  const [settings, setSettings] = useState<DigestSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [draftTime, setDraftTime] = useState<string | null>(null);

  useEffect(() => {
    api
      .getDigestSettings()
      .then(setSettings)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const mutate = useCallback(async (next: DigestSettings) => {
    setSettings(next);
    setError(null);
    try {
      setSettings(await api.setDigestSettings(next));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const sendNow = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const sent = await api.sendDigestNow();
      setNote(sent ? 'Digest sent.' : 'Bot is not paired yet.');
      window.setTimeout(() => setNote(null), 2_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const commitTime = () => {
    if (!settings || draftTime === null) return;
    setDraftTime(null);
    if (HHMM_RE.test(draftTime) && draftTime !== settings.time) {
      void mutate({ ...settings, time: draftTime });
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

      <SettingRow
        title="Morning digest"
        description="Daily dashboard + today's reminders pushed to Telegram."
        control={
          <Toggle
            checked={settings.enabled}
            label="Morning digest"
            onChange={(enabled) => void mutate({ ...settings, enabled })}
          />
        }
      />

      <SettingRow
        title="Digest time"
        description="Local time. Sent on wake if the Mac slept through it (up to 3 h late)."
        control={
          <Input
            size="sm"
            type="time"
            aria-label="Digest time"
            value={draftTime ?? settings.time}
            disabled={!settings.enabled}
            onChange={(e) => setDraftTime(e.target.value)}
            onBlur={commitTime}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTime();
              if (e.key === 'Escape' && draftTime !== null) {
                e.stopPropagation();
                setDraftTime(null);
              }
            }}
            className="w-[104px]"
          />
        }
      />

      <SettingRow
        title="Digest days"
        description="Weekdays the digest goes out."
        control={
          <div role="group" aria-label="Digest days" className="flex items-center gap-1">
            {DAYS.map((d, i) => {
              const bit = 1 << i;
              const on = (settings.weekdays & bit) !== 0;
              return (
                <Button
                  key={d.full}
                  size="xs"
                  variant={on ? 'soft' : 'ghost'}
                  tone={on ? 'accent' : 'neutral'}
                  aria-pressed={on}
                  aria-label={d.full}
                  disabled={!settings.enabled || (on && settings.weekdays === bit)}
                  onClick={() => void mutate({ ...settings, weekdays: settings.weekdays ^ bit })}
                >
                  {d.label}
                </Button>
              );
            })}
          </div>
        }
      />

      <SettingRow
        title="Send digest now"
        description={note ?? 'Push the digest to your chat immediately.'}
        control={
          <Button size="sm" disabled={busy} loading={busy} onClick={() => void sendNow()}>
            Send now
          </Button>
        }
      />
    </>
  );
}
