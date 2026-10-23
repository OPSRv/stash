import type { LanguageModel } from 'ai';

import { aiComplete, type CompleteMessage } from './api';

// Derived from the SDK's public `LanguageModel` union so we don't import
// the transitive `@ai-sdk/provider` package directly.
type LanguageModelV3 = Extract<LanguageModel, { specificationVersion: 'v3' }>;
type CallOptions = Parameters<LanguageModelV3['doGenerate']>[0];
type GenerateResult = Awaited<ReturnType<LanguageModelV3['doGenerate']>>;
type StreamResult = Awaited<ReturnType<LanguageModelV3['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

const EMPTY_USAGE: GenerateResult['usage'] = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};
const STOP: GenerateResult['finishReason'] = { unified: 'stop', raw: undefined };

/// Flatten the SDK prompt to plain role/text pairs. System messages are
/// joined into one; tool rows and non-text parts are dropped (this path
/// is a plain completion, no tools).
const toMessages = (prompt: CallOptions['prompt']) => {
  const system: string[] = [];
  const messages: CompleteMessage[] = [];
  for (const m of prompt) {
    if (m.role === 'system') {
      system.push(m.content);
      continue;
    }
    if (m.role === 'tool') continue;
    const text = m.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
    if (text.trim()) messages.push({ role: m.role, content: text });
  }
  return { messages, system: system.join('\n\n') || undefined };
};

const complete = async (options: CallOptions): Promise<string> => {
  const { messages, system } = toMessages(options.prompt);
  return aiComplete(messages, system);
};

/// Vercel AI SDK model backed by the Rust `ai_complete` command, which
/// runs the local Claude Code CLI. No token streaming: `doStream` waits
/// for the full reply and emits it as a single text chunk.
export const createClaudeCodeModel = (modelId: string): LanguageModelV3 => ({
  specificationVersion: 'v3',
  provider: 'claude-code',
  modelId: modelId.trim() || 'default',
  supportedUrls: {},
  async doGenerate(options) {
    const text = await complete(options);
    return {
      content: [{ type: 'text', text }],
      finishReason: STOP,
      usage: EMPTY_USAGE,
      warnings: [],
    };
  },
  async doStream(options) {
    // Await before returning so failures reject `doStream`, the same way
    // the HTTP providers fail on their initial request.
    const text = await complete(options);
    const parts: StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', delta: text },
      { type: 'text-end', id: '0' },
      { type: 'finish', usage: EMPTY_USAGE, finishReason: STOP },
    ];
    return {
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          for (const p of parts) controller.enqueue(p);
          controller.close();
        },
      }),
    };
  },
});
