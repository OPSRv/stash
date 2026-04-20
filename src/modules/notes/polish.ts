import { buildModel } from '../ai/provider';
import type { AiSettings } from '../ai/useAiSettings';

/** Strict system prompt designed to leave the transcript's content untouched
 *  while fixing only objective transcription artefacts. The rules are
 *  deliberately written in the imperative — modern instruction-tuned models
 *  follow negative constraints much better than loose guidance. */
const SYSTEM_PROMPT = `You are a transcript corrector for voice notes. The transcript is primarily in Ukrainian but may contain English or mixed-language fragments.

YOU MAY fix only:
- objective typos and misspelled words;
- wrong homophones where the correct word is unambiguous from context;
- obviously missing sentence-final punctuation and capitalisation;
- stray whitespace or repeated-word stutters from speech-to-text;
- digits vs words only when the original clearly intended digits.

YOU MUST NOT:
- add any words, phrases, ideas, or examples that are not in the input;
- remove any content beyond trivial stutters;
- rephrase, paraphrase, summarise, translate, or "improve" wording;
- change sentence structure, word order, or meaning;
- invent punctuation, quotation marks, or formatting where the speaker did not clearly pause;
- add bullet points, headings, or markdown;
- add commentary, explanations, or preamble.

If a word is ambiguous or inaudible, LEAVE IT UNCHANGED. Preserve the original language of every token — do not translate Ukrainian into English or vice versa.

Output only the corrected transcript. No quotes, no wrapping, no trailing notes.`;

export type PolishOutcome =
  | { kind: 'ok'; text: string }
  | { kind: 'skipped'; reason: string };

/** Call the active AI provider with a strict corrector prompt. Returns the
 *  corrected text or a reason explaining why we couldn't polish (missing
 *  key, empty input, etc) — never throws for "expected" conditions so the
 *  UI can decide whether to surface a toast or stay quiet. */
export const polishTranscript = async (
  raw: string,
  settings: AiSettings,
): Promise<PolishOutcome> => {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'skipped', reason: 'empty transcript' };
  if (!settings.aiModel) {
    return { kind: 'skipped', reason: 'no AI model configured' };
  }
  const apiKey = settings.aiApiKeys?.[settings.aiProvider];
  if (!apiKey && settings.aiProvider !== 'custom') {
    return { kind: 'skipped', reason: 'missing API key for the active provider' };
  }

  const model = await buildModel(
    {
      provider: settings.aiProvider,
      model: settings.aiModel,
      baseUrl: settings.aiBaseUrl,
    },
    apiKey ?? '',
  );

  // `ai` is ~150 KB; defer until a polish call actually fires so simply
  // opening Notes doesn't tug the SDK over the wire.
  const { generateText } = await import('ai');
  const { text } = await generateText({
    model,
    system: SYSTEM_PROMPT,
    prompt: trimmed,
    temperature: 0,
    // Hard ceiling. 1.5× raw length leaves just enough headroom for the
    // handful of added punctuation marks without letting the model run off
    // and write a paragraph of its own.
    maxOutputTokens: Math.max(64, Math.floor(trimmed.length * 1.5)),
  });

  const cleaned = text.trim();
  if (!cleaned) return { kind: 'skipped', reason: 'model returned an empty response' };
  return { kind: 'ok', text: cleaned };
};
