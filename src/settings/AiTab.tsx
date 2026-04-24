import { useState } from 'react';

import { buildModel } from '../modules/ai/provider';
import { Button } from '../shared/ui/Button';
import { Input } from '../shared/ui/Input';
import { SegmentedControl } from '../shared/ui/SegmentedControl';
import { Textarea } from '../shared/ui/Textarea';
import { useToast } from '../shared/ui/Toast';

import { SettingRow } from './SettingRow';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import type { AiProvider, Settings } from './store';

interface AiTabProps {
  settings: Settings;
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

/// `null`/empty base URLs are fine (providers bring their own default).
/// Otherwise we parse and require http(s) — `new URL()` throws on garbage,
/// so `try/catch` doubles as the shape check.
const isInvalidBaseUrl = (raw: string | null | undefined): boolean => {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return !(u.protocol === 'http:' || u.protocol === 'https:');
  } catch {
    return true;
  }
};

const PROVIDERS: { value: AiProvider; label: string }[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'google', label: 'Google' },
  { value: 'custom', label: 'Custom' },
];

const modelPlaceholder = (p: AiProvider): string => {
  switch (p) {
    case 'openai':
      return 'gpt-4o, o1-mini, …';
    case 'anthropic':
      return 'claude-opus-4-7, claude-sonnet-4-6, …';
    case 'google':
      return 'gemini-2.5-pro, gemini-2.5-flash, …';
    case 'custom':
      return 'model id as your provider expects it';
  }
};

type TestResult =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'ok'; ms: number }
  | { kind: 'err'; message: string };

export const AiTab = ({ settings, onChange }: AiTabProps) => {
  const { toast } = useToast();
  const [keyInput, setKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [test, setTest] = useState<TestResult>({ kind: 'idle' });

  const currentKey = settings.aiApiKeys[settings.aiProvider] ?? '';
  const keyStored = currentKey.length > 0;

  const saveKey = () => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    onChange('aiApiKeys', {
      ...settings.aiApiKeys,
      [settings.aiProvider]: trimmed,
    });
    setKeyInput('');
    toast({ title: 'API key saved', variant: 'success' });
  };

  const clearKey = () => {
    const next = { ...settings.aiApiKeys };
    delete next[settings.aiProvider];
    onChange('aiApiKeys', next);
    setKeyInput('');
    toast({ title: 'API key cleared' });
  };

  const runTest = async () => {
    setTest({ kind: 'pending' });
    try {
      if (!settings.aiModel.trim()) {
        throw new Error('Set a model name first');
      }
      if (settings.aiProvider === 'custom' && !settings.aiBaseUrl) {
        throw new Error('Custom provider requires a base URL');
      }
      if (!currentKey) {
        throw new Error('No API key saved for this provider');
      }
      const model = await buildModel(
        {
          provider: settings.aiProvider,
          model: settings.aiModel,
          baseUrl: settings.aiBaseUrl,
        },
        currentKey,
      );
      const started = performance.now();
      // Defer `ai` until the user actually clicks Test — keeps the Settings
      // tab cold-load free of the 150 KB SDK.
      const { generateText } = await import('ai');
      await generateText({ model, prompt: 'ping', maxOutputTokens: 1 });
      const ms = Math.round(performance.now() - started);
      setTest({ kind: 'ok', ms });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setTest({ kind: 'err', message });
    }
  };

  return (
    <div className="max-w-[560px] mx-auto space-y-6">
      <section>
        <SettingsSectionHeader label="API" />
        <div className="divide-y divide-white/5">
        <SettingRow
          title="Provider"
          description="OpenAI / Anthropic / Google use their native APIs. Custom points at any OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter, …)."
          control={
            <SegmentedControl<AiProvider>
              value={settings.aiProvider}
              onChange={(v) => onChange('aiProvider', v)}
              options={PROVIDERS}
              ariaLabel="Provider"
              size="sm"
            />
          }
        />
        <SettingRow
          title="Model"
          description="Exact model id as the provider expects it. Not validated — new models work the moment your provider adds them."
          control={
            <Input
              size="sm"
              aria-label="Model name"
              placeholder={modelPlaceholder(settings.aiProvider)}
              value={settings.aiModel}
              onChange={(e) => onChange('aiModel', e.currentTarget.value)}
              className="w-[280px]"
            />
          }
        />
        <SettingRow
          title="API key"
          description={
            keyStored
              ? 'A key is saved for this provider. Type a new value and Save to replace.'
              : 'Saved to the app settings file. No internet round-trip, no keychain.'
          }
          control={
            <div className="flex items-center gap-2">
              <Input
                size="sm"
                aria-label="API key"
                type={showKey ? 'text' : 'password'}
                placeholder={keyStored ? '••••••••' : 'sk-…'}
                value={keyInput}
                onChange={(e) => setKeyInput(e.currentTarget.value)}
                maxLength={512}
                spellCheck={false}
                autoComplete="off"
                className="w-[240px]"
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? 'Hide key' : 'Show key'}
                title={showKey ? 'Hide' : 'Show'}
              >
                {showKey ? 'Hide' : 'Show'}
              </Button>
              <Button size="sm" variant="soft" tone="accent" onClick={saveKey} disabled={!keyInput.trim()}>
                Save
              </Button>
              {keyStored && (
                <Button size="sm" variant="ghost" tone="danger" onClick={clearKey}>
                  Clear
                </Button>
              )}
            </div>
          }
        />
        {settings.aiProvider === 'custom' && (
          <SettingRow
            title="Base URL"
            description='Example: "https://api.openrouter.ai/api/v1" or "http://localhost:11434/v1".'
            control={
              <Input
                size="sm"
                aria-label="Base URL"
                placeholder="https://…"
                value={settings.aiBaseUrl ?? ''}
                onChange={(e) => {
                  const raw = e.currentTarget.value.trim();
                  onChange('aiBaseUrl', (raw || null) as string | null);
                }}
                invalid={isInvalidBaseUrl(settings.aiBaseUrl)}
                maxLength={2000}
                className="w-[320px]"
              />
            }
          />
        )}
        <SettingRow
          title="System prompt"
          description="Applied to every chat as the first instruction. Leave empty for none."
          control={
            <Textarea
              aria-label="System prompt"
              placeholder="e.g. Respond in Ukrainian. Be concise. Format code with language fences."
              value={settings.aiSystemPrompt}
              onChange={(e) => onChange('aiSystemPrompt', e.currentTarget.value)}
              rows={3}
              maxLength={4000}
              className="w-[420px]"
            />
          }
        />
        <SettingRow
          title="Test connection"
          description="Sends a 1-token request with your current settings to confirm everything is wired."
          control={
            <div className="flex items-center gap-3">
              <Button
                size="sm"
                variant="soft"
                tone="accent"
                loading={test.kind === 'pending'}
                onClick={runTest}
              >
                Test
              </Button>
              {test.kind === 'ok' && (
                <span className="t-success text-meta" aria-live="polite">
                  ✓ Connected in {test.ms}ms
                </span>
              )}
              {test.kind === 'err' && (
                <span className="t-danger text-meta" aria-live="polite">
                  ✗ {test.message}
                </span>
              )}
            </div>
          }
        />
        </div>
      </section>
    </div>
  );
};
