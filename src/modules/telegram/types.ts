export type ConnectionStatus =
  | { kind: 'no_token' }
  | { kind: 'token_only' }
  | { kind: 'pairing'; code: string; expires_at: number }
  | { kind: 'paired'; chat_id: number };
