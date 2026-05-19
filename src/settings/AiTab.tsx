import { useState } from 'react';

import { aiDeleteApiKey, aiSetApiKey } from '../modules/ai/api';
import { buildModel } from '../modules/ai/provider';
import { Badge } from '../shared/ui/Badge';
import { Button } from '../shared/ui/Button';
import { Input } from '../shared/ui/Input';
import { SegmentedControl } from '../shared/ui/SegmentedControl';
import { Select } from '../shared/ui/Select';
import { Textarea } from '../shared/ui/Textarea';
import { useToast } from '../shared/ui/Toast';

import { SettingRow } from './SettingRow';
import { SettingsSection, SettingsTab } from './SettingsLayout';
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

/// Curated, provider-specific model catalogs. Lets the user pick from
/// a short list of "what to use" labels instead of memorising bare
/// model ids. The trailing `__custom__` sentinel keeps the door open
/// for any id the provider supports outside our curation — useful for
/// pre-release SKUs, OpenRouter aliases, etc.
const CUSTOM_SENTINEL = '__custom__';

type ModelOption = {
  id: string;
  label: string;
  hint?: string;
};

const MODEL_CATALOG: Record<Exclude<AiProvider, 'custom'>, ModelOption[]> = {
  anthropic: [
    {
      id: 'claude-opus-4-7',
      label: 'Claude Opus 4.7',
      hint: 'Найрозумніша, найдорожча',
    },
    {
      id: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6',
      hint: 'Баланс ціна/якість',
    },
    {
      id: 'claude-haiku-4-5-20251001',
      label: 'Claude Haiku 4.5',
      hint: 'Швидка і дешева',
    },
  ],
  openai: [
    { id: 'gpt-4o', label: 'GPT-4o', hint: 'Універсальна, мультимодальна' },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini', hint: 'Дешева 4o' },
    { id: 'o3-mini', label: 'o3-mini', hint: 'Reasoning, швидка' },
    { id: 'o1', label: 'o1', hint: 'Reasoning, складні задачі' },
    { id: 'o1-mini', label: 'o1-mini', hint: 'Reasoning, дешева' },
  ],
  google: [
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', hint: 'Топ-моделька' },
    {
      id: 'gemini-2.5-flash',
      label: 'Gemini 2.5 Flash',
      hint: 'Швидка і дешева',
    },
    {
      id: 'gemini-2.5-flash-lite',
      label: 'Gemini 2.5 Flash Lite',
      hint: 'Найдешевша',
    },
  ],
};

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

  // Dual-write: keyring is the source of truth in release builds (the Rust
  // assistant only reads from `com.stash.ai`). settings.json is kept in sync
  // because the in-process JS chat (AiShell, useAiChat) and Test connection
  // here use that copy directly via the AI SDK. If either path is skipped,
  // Test passes while Telegram fails (or vice versa).
  const saveKey = async () => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    onChange('aiApiKeys', {
      ...settings.aiApiKeys,
      [settings.aiProvider]: trimmed,
    });
    setKeyInput('');
    try {
      await aiSetApiKey(settings.aiProvider, trimmed);
      toast({ title: 'API key saved', variant: 'success' });
    } catch (e) {
      toast({
        title: 'Saved to settings, but keyring write failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      });
    }
  };

  const clearKey = async () => {
    const next = { ...settings.aiApiKeys };
    delete next[settings.aiProvider];
    onChange('aiApiKeys', next);
    setKeyInput('');
    try {
      await aiDeleteApiKey(settings.aiProvider);
      toast({ title: 'API key cleared' });
    } catch (e) {
      toast({
        title: 'Cleared from settings, but keyring delete failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      });
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
    <SettingsTab>
      <SettingsSection label="API">
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
          description="Обери з курованого списку або введи власний id (напр. з OpenRouter). Список не валідується — нові моделі провайдера працюють одразу."
          control={
            <ModelPicker
              provider={settings.aiProvider}
              value={settings.aiModel}
              onChange={(v) => onChange('aiModel', v)}
            />
          }
        />
        <SettingRow
          title="API key"
          description="Спочатку пробує OS Keychain; на unsigned-білдах падає у зашифрований файл поряд із SQLite."
          control={
            <div className="flex flex-col items-end gap-2">
              <div className="flex items-center gap-2">
                {keyStored ? (
                  <Badge tone="success" title="API key is stored for this provider">
                    ✓ Saved
                  </Badge>
                ) : (
                  <Badge tone="warning" title="No API key for this provider yet">
                    Not configured
                  </Badge>
                )}
                <Input
                  size="sm"
                  aria-label="API key"
                  type={showKey ? 'text' : 'password'}
                  placeholder={keyStored ? 'Replace key…' : keyPlaceholder(settings.aiProvider)}
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
                <Button
                  size="sm"
                  variant="soft"
                  tone="accent"
                  onClick={saveKey}
                  disabled={!keyInput.trim()}
                >
                  Save
                </Button>
                {keyStored && (
                  <Button size="sm" variant="ghost" tone="danger" onClick={clearKey}>
                    Clear
                  </Button>
                )}
              </div>
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
              rows={2}
              maxLength={4000}
              className="w-[360px] text-meta"
            />
          }
        />
        <SettingRow
          title="Test connection"
          description="Sends a 1-token request with your current settings to confirm everything is wired."
          control={
            <div className="flex flex-col items-end gap-2">
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
                <span
                  className="t-danger text-meta max-w-[420px] text-right break-words"
                  aria-live="polite"
                >
                  ✗ {test.message}
                </span>
              )}
            </div>
          }
        />
      </SettingsSection>
    </SettingsTab>
  );
};

// ---------------------------- Model picker ----------------------------

type ModelPickerProps = {
  provider: AiProvider;
  value: string;
  onChange: (next: string) => void;
};

/// Two-mode model selector: a Select with curated options when the
/// provider has a catalog, plus a "Custom…" sentinel that drops the
/// user back into a free-form Input. The free-form path is required —
/// model ids drift faster than we can hand-edit a list, and OpenRouter
/// / OpenAI-compat endpoints accept arbitrary names.
const ModelPicker = ({ provider, value, onChange }: ModelPickerProps) => {
  // Custom provider: free-form id only (we have no curated list).
  if (provider === 'custom') {
    return (
      <Input
        size="sm"
        aria-label="Model id"
        placeholder="model id as your provider expects it"
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        className="w-[280px]"
      />
    );
  }

  const catalog = MODEL_CATALOG[provider];
  const known = catalog.find((m) => m.id === value);
  const showCustom = value.trim().length > 0 && !known;
  const selectValue = showCustom ? CUSTOM_SENTINEL : known?.id ?? '';

  const options = [
    ...catalog.map((m) => ({
      value: m.id,
      label: m.hint ? `${m.label} · ${m.hint}` : m.label,
    })),
    { value: CUSTOM_SENTINEL, label: 'Custom…' },
  ];

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="w-[320px]">
        <Select<string>
          size="sm"
          value={selectValue}
          onChange={(next) => {
            if (next === CUSTOM_SENTINEL) {
              // Keep whatever the user already typed when flipping to
              // Custom — otherwise the input flashes empty and they
              // have to re-type.
              if (!showCustom) onChange('');
              return;
            }
            onChange(next);
          }}
          options={options}
          placeholder="Select a model…"
        />
      </div>
      {showCustom && (
        <Input
          size="sm"
          aria-label="Custom model id"
          placeholder={modelPlaceholder(provider)}
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
          className="w-[320px]"
        />
      )}
      {known && (
        <code className="t-tertiary text-meta">{known.id}</code>
      )}
    </div>
  );
};

const keyPlaceholder = (p: AiProvider): string => {
  switch (p) {
    case 'openai':
      return 'sk-…';
    case 'anthropic':
      return 'sk-ant-…';
    case 'google':
      return 'AIza…';
    case 'custom':
      return 'API key';
  }
};
