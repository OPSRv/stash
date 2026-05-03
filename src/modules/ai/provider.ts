import type { LanguageModel } from 'ai';

import type { AiProvider } from '../../settings/store';

export type AiConfig = {
  provider: AiProvider;
  model: string;
  baseUrl: string | null;
};

/// Build a Vercel AI SDK model handle from the user's config and secret.
/// Each `@ai-sdk/*` package is ~150 KB; importing all three eagerly bloats
/// every chunk that touches the AI module (Notes pulls polish, Settings
/// pulls AiTab) by ~480 KB. Loading per-provider on demand keeps cold
/// chunks small and means the user pays the AI bytes only when an actual
/// generation is requested. `custom` reuses the OpenAI-compatible client
/// with a custom baseURL — works for Ollama, LM Studio, OpenRouter, Groq,
/// DeepSeek, and anything else exposing an OpenAI-compatible endpoint.
export const buildModel = async (
  cfg: AiConfig,
  apiKey: string,
): Promise<LanguageModel> => {
  switch (cfg.provider) {
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({ apiKey })(cfg.model);
    }
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      return createAnthropic({ apiKey })(cfg.model);
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      return createGoogleGenerativeAI({ apiKey })(cfg.model);
    }
    case 'custom': {
      if (!cfg.baseUrl) {
        throw new Error('Custom provider requires a base URL');
      }
      const [{ createOpenAI }, { fetch: tauriFetch }] = await Promise.all([
        import('@ai-sdk/openai'),
        import('@tauri-apps/plugin-http'),
      ]);
      // Two non-obvious choices, both forced by local LLM runtimes:
      //   1. `.chat()` forces `/chat/completions`. The default call shape
      //      hits the new Responses API (`/responses`) which Ollama /
      //      LM Studio / Groq / DeepSeek do not implement.
      //   2. `fetch: tauriFetch` routes the request through Rust instead
      //      of WKWebView. WKWebView fires a CORS preflight on every
      //      `Authorization`-bearing POST, and most local runtimes
      //      either omit CORS headers or mishandle `OPTIONS` (LM Studio
      //      logs `'messages' field is required` for the empty preflight
      //      body). Rust has no CORS, so the call goes straight through.
      return createOpenAI({
        apiKey,
        baseURL: cfg.baseUrl,
        fetch: tauriFetch as typeof fetch,
      }).chat(cfg.model);
    }
  }
};
