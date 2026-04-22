import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '../../../shared/ui/Button';
import { Textarea } from '../../../shared/ui/Textarea';
import { Toggle } from '../../../shared/ui/Toggle';
import { SliderField } from '../../../settings/SliderField';
import * as api from '../api';
import type { AiSettings } from '../types';

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
          <Button variant="soft" tone="neutral" onClick={onReset}>
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
    </>
  );
}
