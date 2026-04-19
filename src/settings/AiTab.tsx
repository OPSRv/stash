import { useEffect, useState } from 'react';
import { generateText } from 'ai';

import {
  aiDeleteApiKey,
  aiHasApiKey,
  aiSetApiKey,
} from '../modules/ai/api';
import { buildModel } from '../modules/ai/provider';
import { Button } from '../shared/ui/Button';
import { Input } from '../shared/ui/Input';
import { SegmentedControl } from '../shared/ui/SegmentedControl';
import { Textarea } from '../shared/ui/Textarea';
import { Toggle } from '../shared/ui/Toggle';
import { useToast } from '../shared/ui/Toast';

import { SettingRow } from './SettingRow';
import type { AiProvider, Settings } from './store';

interface AiTabProps {
  settings: Settings;
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

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
  const [keyStored, setKeyStored] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [test, setTest] = useState<TestResult>({ kind: 'idle' });

  // Reflect keychain state in the password field placeholder so the user
  // sees whether a key is already saved without ever exposing the value.
  useEffect(() => {
    aiHasApiKey(settings.aiProvider)
      .then(setKeyStored)
      .catch(() => setKeyStored(false));
  }, [settings.aiProvider]);

  const saveKey = async () => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    try {
      await aiSetApiKey(settings.aiProvider, trimmed);
      setKeyInput('');
      setKeyStored(true);
      toast({ title: 'API key saved', variant: 'success' });
    } catch (e) {
      toast({ title: 'Save failed', description: String(e), variant: 'error' });
    }
  };

  const clearKey = async () => {
    try {
      await aiDeleteApiKey(settings.aiProvider);
      setKeyStored(false);
      setKeyInput('');
      toast({ title: 'API key cleared' });
    } catch (e) {
      toast({ title: 'Clear failed', description: String(e), variant: 'error' });
    }
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
      // Read the key back from keychain so the test uses exactly what chat
      // will use at runtime.
      const key = await (await import('../modules/ai/api')).aiGetApiKey(
        settings.aiProvider,
      );
      if (!key) throw new Error('No API key saved for this provider');
      const model = buildModel(
        {
          provider: settings.aiProvider,
          model: settings.aiModel,
          baseUrl: settings.aiBaseUrl,
        },
        key,
      );
      const started = performance.now();
      await generateText({ model, prompt: 'ping', maxOutputTokens: 1 });
      const ms = Math.round(performance.now() - started);
      setTest({ kind: 'ok', ms });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setTest({ kind: 'err', message });
    }
  };

  const enabled = settings.aiEnabled;
  const disabledClass = enabled ? '' : 'opacity-40 pointer-events-none';

  return (
    <div className="divide-y divide-white/5">
      <SettingRow
        title="Enable AI"
        description="Adds an AI Chat tab and unlocks AI-powered actions in other modules."
        control={
          <Toggle
            checked={enabled}
            onChange={(v) => onChange('aiEnabled', v)}
            label="Enable AI"
          />
        }
      />
      <div className={disabledClass}>
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
              ? 'A key is saved in the system keychain. Type a new value to replace it.'
              : 'Stored in the macOS Keychain, never written to disk in plain text.'
          }
          control={
            <div className="flex items-center gap-2">
              <Input
                aria-label="API key"
                type={showKey ? 'text' : 'password'}
                placeholder={keyStored ? '••••••••' : 'sk-…'}
                value={keyInput}
                onChange={(e) => setKeyInput(e.currentTarget.value)}
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
                aria-label="Base URL"
                placeholder="https://…"
                value={settings.aiBaseUrl ?? ''}
                onChange={(e) =>
                  onChange('aiBaseUrl', (e.currentTarget.value.trim() || null) as string | null)
                }
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
    </div>
  );
};
