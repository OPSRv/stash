import { invoke } from '@tauri-apps/api/core';

import type { AiProvider } from '../../settings/store';

export type Session = {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
};

export type MessageRole = 'user' | 'assistant';

export type Message = {
  id: string;
  session_id: string;
  role: MessageRole;
  content: string;
  created_at: number;
  stopped: boolean;
};

export const aiListSessions = (): Promise<Session[]> => invoke('ai_list_sessions');

export const aiCreateSession = (title?: string): Promise<Session> =>
  invoke('ai_create_session', { title: title ?? null });

export const aiRenameSession = (id: string, title: string): Promise<void> =>
  invoke('ai_rename_session', { id, title });

export const aiDeleteSession = (id: string): Promise<void> =>
  invoke('ai_delete_session', { id });

export const aiListMessages = (sessionId: string): Promise<Message[]> =>
  invoke('ai_list_messages', { sessionId });

export const aiAppendMessage = (args: {
  sessionId: string;
  role: MessageRole;
  content: string;
  stopped?: boolean;
}): Promise<Message> =>
  invoke('ai_append_message', {
    sessionId: args.sessionId,
    role: args.role,
    content: args.content,
    stopped: args.stopped ?? null,
  });

export const aiGetApiKey = (provider: AiProvider): Promise<string | null> =>
  invoke('ai_get_api_key', { provider });

export const aiSetApiKey = (provider: AiProvider, key: string): Promise<void> =>
  invoke('ai_set_api_key', { provider, key });

export const aiDeleteApiKey = (provider: AiProvider): Promise<void> =>
  invoke('ai_delete_api_key', { provider });

export const aiHasApiKey = (provider: AiProvider): Promise<boolean> =>
  invoke('ai_has_api_key', { provider });
