import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

import type { AiProvider } from '../../settings/store';

export type AiConfig = {
  provider: AiProvider;
  model: string;
  baseUrl: string | null;
};

/// Build a Vercel AI SDK model handle from the user's config and secret.
/// `custom` reuses the OpenAI-compatible client with a custom baseURL — works
/// for Ollama, LM Studio, OpenRouter, Groq, DeepSeek, and anything else that
/// exposes an OpenAI-compatible chat endpoint.
export const buildModel = (cfg: AiConfig, apiKey: string): LanguageModel => {
  switch (cfg.provider) {
    case 'openai':
      return createOpenAI({ apiKey })(cfg.model);
    case 'anthropic':
      return createAnthropic({ apiKey })(cfg.model);
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(cfg.model);
    case 'custom': {
      if (!cfg.baseUrl) {
        throw new Error('Custom provider requires a base URL');
      }
      return createOpenAI({ apiKey, baseURL: cfg.baseUrl })(cfg.model);
    }
  }
};
