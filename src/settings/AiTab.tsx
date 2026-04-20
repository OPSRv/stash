import { useState } from 'react';

import { buildModel } from '../modules/ai/provider';
import { Button } from '../shared/ui/Button';
import { Input } from '../shared/ui/Input';
import { SegmentedControl } from '../shared/ui/SegmentedControl';
import { Textarea } from '../shared/ui/Textarea';
import { useToast } from '../shared/ui/Toast';

import { SettingRow } from './SettingRow';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import type { AiProvider, Settings, WebChatService } from './store';

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

// Derive a safe id from a human label: lowercase, keep alnum/underscore,
// replace everything else with "-". Rust-side label_for() rejects anything
// that doesn't match `[a-zA-Z0-9_-]+`, so this keeps us in sync.
const slugify = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'service';

const freshServiceId = (existing: WebChatService[]): string => {
  const base = 'service';
  const used = new Set(existing.map((s) => s.id));
  let i = 1;
  while (used.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
};

const updateService = (
  settings: Settings,
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void,
  index: number,
  patch: Partial<WebChatService>,
) => {
  const next = settings.aiWebServices.map((s, i) => {
    if (i !== index) return s;
    const merged = { ...s, ...patch };
    // Auto-sync id from label so the Rust label stays stable-but-readable.
    // Only re-slug when the label itself changed, to avoid overwriting a
    // user-picked id on every URL edit.
    if (patch.label !== undefined) {
      merged.id = slugify(patch.label);
    }
    return merged;
  });
  onChange('aiWebServices', next);
};

const moveService = (
  settings: Settings,
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void,
  from: number,
  to: number,
) => {
  if (to < 0 || to >= settings.aiWebServices.length) return;
  const next = settings.aiWebServices.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  onChange('aiWebServices', next);
};

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
        <SettingsSectionHeader label="WEB SERVICES" />
        <div className="divide-y divide-white/5">
        <SettingRow
          title="Embedded web services"
          description="Services that appear in the AI tab's mode switcher. Each opens in a native child webview so your regular browser login carries over."
          control={
            <Button
              size="sm"
              variant="soft"
              shape="square"
              aria-label="Add service"
              title="Add service"
              onClick={() => {
                const nextId = freshServiceId(settings.aiWebServices);
                onChange('aiWebServices', [
                  ...settings.aiWebServices,
                  { id: nextId, label: 'New service', url: 'https://' },
                ]);
              }}
            >
              +
            </Button>
          }
        />
        <div className="py-1 space-y-1.5">
          {settings.aiWebServices.map((s, i) => (
            <div key={s.id + i} className="flex items-center gap-2">
              <Input
                aria-label="Service label"
                placeholder="Label"
                value={s.label}
                onChange={(e) =>
                  updateService(settings, onChange, i, { label: e.currentTarget.value })
                }
                className="w-[140px]"
              />
              <Input
                aria-label="Service URL"
                placeholder="https://"
                value={s.url}
                onChange={(e) =>
                  updateService(settings, onChange, i, { url: e.currentTarget.value })
                }
                className="flex-1"
              />
              <Button
                size="sm"
                variant="ghost"
                shape="square"
                disabled={i === 0}
                onClick={() => moveService(settings, onChange, i, i - 1)}
                aria-label="Move up"
                title="Move up"
              >
                ↑
              </Button>
              <Button
                size="sm"
                variant="ghost"
                shape="square"
                disabled={i === settings.aiWebServices.length - 1}
                onClick={() => moveService(settings, onChange, i, i + 1)}
                aria-label="Move down"
                title="Move down"
              >
                ↓
              </Button>
              <Button
                size="sm"
                variant="ghost"
                tone="danger"
                onClick={() =>
                  onChange(
                    'aiWebServices',
                    settings.aiWebServices.filter((_, j) => j !== i),
                  )
                }
                aria-label="Remove service"
                title="Remove"
              >
                ×
              </Button>
            </div>
          ))}
        </div>
        </div>
      </section>
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
      </section>
    </div>
  );
};
