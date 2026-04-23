import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  aiListSessions,
  aiCreateSession,
  aiFindSessionByContext,
  aiRenameSession,
  aiDeleteSession,
  aiListMessages,
  aiAppendMessage,
  aiGetApiKey,
  aiSetApiKey,
  aiDeleteApiKey,
  aiHasApiKey,
  type Session,
  type Message,
} from './api';

const session = (over: Partial<Session> = {}): Session => ({
  id: 's1',
  title: 'Chat',
  created_at: 1,
  updated_at: 1,
  kind: null,
  context_ref: null,
  ...over,
});

const message = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  session_id: 's1',
  role: 'user',
  content: 'hi',
  created_at: 1,
  stopped: false,
  ...over,
});

describe('ai api', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  it('aiListSessions → ai_list_sessions', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([session()]);
    await expect(aiListSessions()).resolves.toEqual([session()]);
    expect(invoke).toHaveBeenCalledWith('ai_list_sessions');
  });

  it('aiCreateSession passes nulls when unspecified', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(session());
    await aiCreateSession();
    expect(invoke).toHaveBeenCalledWith('ai_create_session', {
      title: null,
      kind: null,
      contextRef: null,
    });
  });

  it('aiCreateSession forwards title+kind+context', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(session({ kind: 'note', context_ref: '42' }));
    await aiCreateSession('Note 42 chat', 'note', '42');
    expect(invoke).toHaveBeenCalledWith('ai_create_session', {
      title: 'Note 42 chat',
      kind: 'note',
      contextRef: '42',
    });
  });

  it('aiFindSessionByContext returns existing or null', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await expect(aiFindSessionByContext('note', '7')).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledWith('ai_find_session_by_context', {
      kind: 'note',
      contextRef: '7',
    });
  });

  it('aiRenameSession forwards id+title', async () => {
    await aiRenameSession('s1', 'Renamed');
    expect(invoke).toHaveBeenCalledWith('ai_rename_session', {
      id: 's1',
      title: 'Renamed',
    });
  });

  it('aiDeleteSession forwards id', async () => {
    await aiDeleteSession('s1');
    expect(invoke).toHaveBeenCalledWith('ai_delete_session', { id: 's1' });
  });

  it('aiListMessages forwards sessionId (camelCase)', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([message()]);
    await aiListMessages('s1');
    expect(invoke).toHaveBeenCalledWith('ai_list_messages', { sessionId: 's1' });
  });

  it('aiAppendMessage serializes stopped null when absent', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(message());
    await aiAppendMessage({ sessionId: 's1', role: 'user', content: 'hi' });
    expect(invoke).toHaveBeenCalledWith('ai_append_message', {
      sessionId: 's1',
      role: 'user',
      content: 'hi',
      stopped: null,
    });
  });

  it('aiAppendMessage forwards stopped flag when present', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(message({ stopped: true }));
    await aiAppendMessage({
      sessionId: 's1',
      role: 'assistant',
      content: 'partial',
      stopped: true,
    });
    expect(invoke).toHaveBeenCalledWith('ai_append_message', {
      sessionId: 's1',
      role: 'assistant',
      content: 'partial',
      stopped: true,
    });
  });

  it('aiGetApiKey forwards provider', async () => {
    vi.mocked(invoke).mockResolvedValueOnce('sk-xxx');
    await expect(aiGetApiKey('openai')).resolves.toBe('sk-xxx');
    expect(invoke).toHaveBeenCalledWith('ai_get_api_key', { provider: 'openai' });
  });

  it('aiSetApiKey forwards provider+key', async () => {
    await aiSetApiKey('anthropic', 'sk-ant-xyz');
    expect(invoke).toHaveBeenCalledWith('ai_set_api_key', {
      provider: 'anthropic',
      key: 'sk-ant-xyz',
    });
  });

  it('aiDeleteApiKey forwards provider', async () => {
    await aiDeleteApiKey('google');
    expect(invoke).toHaveBeenCalledWith('ai_delete_api_key', { provider: 'google' });
  });

  it('aiHasApiKey returns boolean', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(true);
    await expect(aiHasApiKey('openai')).resolves.toBe(true);
  });

  it('propagates invoke rejections', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('keyring denied'));
    await expect(aiSetApiKey('openai', 'x')).rejects.toThrow('keyring denied');
  });
});
