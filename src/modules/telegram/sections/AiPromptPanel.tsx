import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

import { Button } from '../../../shared/ui/Button';
import { Textarea } from '../../../shared/ui/Textarea';
import { Toggle } from '../../../shared/ui/Toggle';
import { SliderField } from '../../../settings/SliderField';
import * as api from '../api';
import type { AiSettings, DiarStatus, InboxLimits } from '../types';

const DEFAULT_PROMPT =
  'You are a helpful assistant for Oleksandr inside Telegram. \
Answer concisely. Use tools when they would save the user time.';

const SAVE_DEBOUNCE_MS = 500;

/// System prompt + context-window editor. Writes debounced so each
/// keystroke doesn't round-trip to Rust; the Reset button restores
/// the bundled default prompt.
export function AiPromptPanel() {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSettings(await api.getAiSettings());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const schedule = (next: AiSettings) => {
    setSettings(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        await api.setAiSettings(next);
        setSavedNote('Saved');
        // The note is advisory — no reason to clear it aggressively.
        setTimeout(() => setSavedNote(null), 1500);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }, SAVE_DEBOUNCE_MS);
  };

  const onPrompt = (v: string) => {
    if (!settings) return;
    schedule({ ...settings, system_prompt: v });
  };
  const onWindow = (v: number) => {
    if (!settings) return;
    schedule({ ...settings, context_window: v });
  };
  const onReset = () => {
    if (!settings) return;
    schedule({ ...settings, system_prompt: DEFAULT_PROMPT });
  };

  if (!settings) {
    return <div className="py-3 t-tertiary text-meta">Loading…</div>;
  }

  return (
    <>
      {error && (
        <div role="alert" className="py-3 t-danger text-meta">
          {error}
        </div>
      )}

      <div className="py-3">
        <div className="flex items-baseline justify-between mb-1.5">
          <label
            htmlFor="tg-ai-prompt"
            className="t-primary text-body font-medium"
          >
            System prompt
          </label>
          {savedNote && (
            <span className="t-tertiary text-meta">{savedNote}</span>
          )}
        </div>
        <div className="t-tertiary text-meta mb-2">
          Instructions the assistant sees on every reply.
        </div>
        <Textarea
          id="tg-ai-prompt"
          rows={6}
          value={settings.system_prompt}
          onChange={(e) => onPrompt(e.target.value)}
          aria-label="System prompt"
          className="w-full block"
        />
        <div className="flex justify-end mt-2">
          <Button size="sm" variant="soft" tone="neutral" onClick={onReset}>
            Reset to default
          </Button>
        </div>
      </div>

      <div className="py-3">
        <SliderField
          label="Context window"
          description="Messages the assistant re-reads on every reply."
          value={settings.context_window}
          min={10}
          max={200}
          step={10}
          onChange={onWindow}
          display={`${settings.context_window} msg`}
        />
      </div>

      <div className="py-3 flex items-start justify-between gap-4">
        <div>
          <div className="t-primary text-body font-medium">AI reply on voice</div>
          <div className="t-tertiary text-meta">
            When off, voice notes only send a transcript — no AI reply.
          </div>
        </div>
        <Toggle
          checked={settings.reply_on_voice}
          onChange={(v) => schedule({ ...settings, reply_on_voice: v })}
          label="AI reply on voice"
        />
      </div>

      <DiarizationRow
        enabled={settings.diarization_enabled}
        onChange={(v) => schedule({ ...settings, diarization_enabled: v })}
        onError={(e) => setError(e)}
      />

      <InboxLimitsSection onError={(e) => setError(e)} />
    </>
  );
}

type InboxLimitsSectionProps = {
  onError: (e: string) => void;
};

/// Two sliders for the per-file and per-day inbox storage caps.
/// Writes go through the same debounce pattern as the prompt editor
/// — a quick drag doesn't fire a save per intermediate value.
function InboxLimitsSection({ onError }: InboxLimitsSectionProps) {
  const [limits, setLimits] = useState<InboxLimits | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setLimits(await api.getInboxLimits());
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [onError]);

  const schedule = (next: InboxLimits) => {
    setLimits(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        await api.setInboxLimits(next);
        setSavedNote('Saved');
        setTimeout(() => setSavedNote(null), 1500);
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
      }
    }, SAVE_DEBOUNCE_MS);
  };

  if (!limits) return null;

  return (
    <div className="py-3">
      <div className="flex items-baseline justify-between mb-1.5">
        <div className="t-primary text-body font-medium">Inbox limits</div>
        {savedNote && <span className="t-tertiary text-meta">{savedNote}</span>}
      </div>
      <div className="t-tertiary text-meta mb-2">
        Розмір файлів, які бот зберігає в інбокс. Telegram Bot API сам по
        собі не віддає &gt;20 MB — підіймати має сенс при власному API-сервері.
      </div>
      <SliderField
        label="Per-file"
        description="Максимальний розмір одного файлу."
        value={limits.per_file_mb}
        min={1}
        max={2048}
        step={10}
        onChange={(v) => schedule({ ...limits, per_file_mb: v })}
        display={`${limits.per_file_mb} MB`}
      />
      <div className="h-2" />
      <SliderField
        label="Per-day"
        description="Скільки байтів за добу бот узагалі завантажує."
        value={limits.per_day_mb}
        min={10}
        max={10240}
        step={50}
        onChange={(v) => schedule({ ...limits, per_day_mb: v })}
        display={
          limits.per_day_mb >= 1024
            ? `${(limits.per_day_mb / 1024).toFixed(1)} GB`
            : `${limits.per_day_mb} MB`
        }
      />
    </div>
  );
}

type DiarizationRowProps = {
  enabled: boolean;
  onChange: (v: boolean) => void;
  onError: (e: string) => void;
};

/// Speaker-diarization toggle. Flipping it on auto-downloads the
/// pyannote + 3D-Speaker ONNX pair (~24 MB) on first use; the toggle
/// itself only flips after the download succeeds so users don't end
/// up with the flag enabled but the models missing.
function DiarizationRow({ enabled, onChange, onError }: DiarizationRowProps) {
  const [status, setStatus] = useState<DiarStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.diarizationStatus());
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
    let unlisten: (() => void) | undefined;
    listen<{ id: string; received: number; total: number; done: boolean }>(
      'diarization:download',
      (e) => {
        setProgress({ received: e.payload.received, total: e.payload.total });
        if (e.payload.done) void refresh();
      },
    ).then((u) => {
      unlisten = u;
    });
    return () => {
      unlisten?.();
    };
  }, [refresh]);

  const handleToggle = async (next: boolean) => {
    if (next && status && !status.ready) {
      setDownloading(true);
      try {
        await api.diarizationDownload();
        onChange(true);
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
      } finally {
        setDownloading(false);
        setProgress(null);
        void refresh();
      }
      return;
    }
    onChange(next);
  };

  const totalSize = status?.models.reduce((acc, m) => acc + m.size_bytes, 0) ?? 0;
  const sizeMb = (totalSize / 1024 / 1024).toFixed(0);
  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.received / progress.total) * 100))
      : null;

  return (
    <div className="py-3 flex items-start justify-between gap-4">
      <div>
        <div className="t-primary text-body font-medium flex items-center gap-2">
          Розрізняти спікерів
          {status?.ready && (
            <span
              className="text-meta px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(95,200,138,0.15)', color: '#5fc88a' }}
            >
              ✓ Models ready
            </span>
          )}
        </div>
        <div className="t-tertiary text-meta">
          {status?.ready
            ? 'Pyannote + 3D-Speaker, працює локально. Транскрипт буде розмічений «Спікер 1 / 2 / …».'
            : `Перший раз завантажить близько ${sizeMb} MB моделей (pyannote + 3D-Speaker).`}
          {downloading && pct !== null && (
            <span className="ml-2 t-secondary">downloading {pct}%</span>
          )}
        </div>
      </div>
      <Toggle
        checked={enabled}
        onChange={(v) => {
          if (downloading) return;
          void handleToggle(v);
        }}
        label="Speaker diarization"
      />
    </div>
  );
}
