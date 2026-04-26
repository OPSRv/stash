import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../shared/ui/Toast';

import { AiTab } from './AiTab';
import type { Settings } from './store';

// Use a partial fixture to keep the test focused on the AI fields.
const baseSettings = (over: Partial<Settings> = {}): Settings =>
  ({
    aiProvider: 'openai',
    aiModel: 'gpt-4o-mini',
    aiBaseUrl: null,
    aiSystemPrompt: '',
    aiApiKeys: {},
    ...over,
  }) as Settings;

const renderUnit = (settings: Settings, onChange = vi.fn()) =>
  render(
    <ToastProvider>
      <AiTab settings={settings} onChange={onChange} />
    </ToastProvider>,
  );

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
});

describe('AiTab key persistence', () => {
  it('Save writes to settings.aiApiKeys AND keyring (ai_set_api_key)', async () => {
    const onChange = vi.fn();
    renderUnit(baseSettings(), onChange);

    await userEvent.type(screen.getByLabelText('API key'), 'sk-test-123');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onChange).toHaveBeenCalledWith('aiApiKeys', { openai: 'sk-test-123' });
    expect(invoke).toHaveBeenCalledWith('ai_set_api_key', {
      provider: 'openai',
      key: 'sk-test-123',
    });
  });

  it('Clear removes from settings.aiApiKeys AND keyring (ai_delete_api_key)', async () => {
    const onChange = vi.fn();
    renderUnit(
      baseSettings({ aiApiKeys: { openai: 'sk-existing' } }),
      onChange,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(onChange).toHaveBeenCalledWith('aiApiKeys', {});
    expect(invoke).toHaveBeenCalledWith('ai_delete_api_key', { provider: 'openai' });
  });

  it('Save targets the active provider account, not always openai', async () => {
    const onChange = vi.fn();
    renderUnit(baseSettings({ aiProvider: 'anthropic' }), onChange);

    await userEvent.type(screen.getByLabelText('API key'), 'sk-ant-xyz');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(invoke).toHaveBeenCalledWith('ai_set_api_key', {
      provider: 'anthropic',
      key: 'sk-ant-xyz',
    });
  });
});
