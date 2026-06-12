/* AI panel: natural-language entry points into the circle. One compact row —
 * a prompt input with Compose, plus Explain / Suggest-next for the current
 * progression — with optional result blocks below (markdown explanation,
 * suggestion chips). All three actions go through `circle_ai_assist`; the
 * Rust side only strips clean code fences, so robust JSON extraction lives
 * here (same fence-then-brace strategy as the Valeton editor's presetIO).
 * Errors render inline in the danger colour (PresetAiModal pattern) — no
 * toasts. */

import { useState } from 'react';
import { Button } from '../../../shared/ui/Button';
import { Input } from '../../../shared/ui/Input';
import { LazyMarkdown } from '../../../shared/ui/LazyMarkdown';
import { circleAiAssist, type AiMode } from '../api';
import { addChord, stopProgression } from '../lib/actions';
import { pretty } from '../lib/format';
import { progressionText } from '../lib/progressions';
import {
  MODES,
  chordName,
  parseChordName,
  slotOfKey,
  spellPitch,
  type Chord,
  type Key,
} from '../lib/theory';
import {
  MAX_BPM,
  MIN_BPM,
  getState,
  setState,
  useStore,
  type AiSuggestion,
  type CircleState,
} from '../store';

/* ── Reply parsing ─────────────────────────────────────────────────────── */

/** Extract a JSON value from a model reply that may carry prose or fences:
 * take the body of the first ``` fence if present, otherwise the whole text,
 * then slice from the first `{`/`[` to its last matching closer. Falls
 * through unchanged when neither is found, so JSON.parse reports an error. */
const extractJson = (text: string): string => {
  // Local reasoning models prepend <think> blocks whose prose can contain
  // braces — drop them before hunting for the JSON payload.
  const bare = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const fence = bare.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fence ? fence[1] : bare).trim();
  const obj = body.indexOf('{');
  const arr = body.indexOf('[');
  const start = obj >= 0 && (arr < 0 || obj < arr) ? obj : arr;
  if (start < 0) return body;
  const end = body.lastIndexOf(body[start] === '{' ? '}' : ']');
  return end > start ? body.slice(start, end + 1) : body;
};

/** Extract + parse a reply into an object or array, or null when neither.
 * Second attempt strips trailing commas (`[1, 2,]`) — the most common JSON
 * defect of less instruction-compliant models. Logs the raw reply on
 * failure so a misbehaving model is diagnosable from the console. */
const parseJsonReply = (raw: string): Record<string, unknown> | unknown[] | null => {
  const body = extractJson(raw);
  for (const candidate of [body, body.replace(/,\s*([\]}])/g, '$1')]) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown> | unknown[];
      }
    } catch {
      // fall through to the trailing-comma attempt / failure path
    }
  }
  console.warn('[circle] AI reply was not parseable JSON:', raw);
  return null;
};

/** One-line peek at a bad reply for the inline error — enough to see what
 * the model actually sent without opening the console. */
const replyPeek = (raw: string): string => {
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
};

/** Chord-name parsing with one extra mercy: slash chords (`C/G`) drop their
 * bass note and parse as the plain chord — models suggest inversions even
 * when told not to, and losing the voicing beats dropping the suggestion. */
const parseLooseChord = (name: string): Chord | null => {
  const trimmed = name.trim();
  const slash = trimmed.indexOf('/');
  return (
    parseChordName(trimmed) ??
    (slash > 0 ? parseChordName(trimmed.slice(0, slash).trim()) : null)
  );
};

/** Read a key name like `Am` / `C` / `F#m` via the chord parser: a minor
 * chord quality means a minor key, anything else reads as major. */
const keyFromName = (name: unknown): Key | null => {
  const chord = typeof name === 'string' ? parseChordName(name) : null;
  if (!chord) return null;
  return { tonic: chord.root, minor: chord.quality === 'min' || chord.quality === 'min7' };
};

/** A reply handler either produces a store patch or a user-facing error. */
type ApplyResult = Partial<CircleState> | { error: string };

/** Compose: `{"key":"Am","mode":"aeolian","bpm":90,"chords":["Am","F",…]}` →
 * key/mode/bpm/progression, rotating the circle to the new key. Unparseable
 * key or mode keeps the current one; bpm is clamped; unparseable chord names
 * are skipped — only an empty result is an error. */
const applyCompose = (raw: string): ApplyResult => {
  const parsed = parseJsonReply(raw);
  if (!parsed) {
    return { error: `The model reply was not valid JSON — try again. It began: ${replyPeek(raw)}` };
  }
  // A bare array reads as the chord list (some models skip the wrapper).
  const data: Record<string, unknown> = Array.isArray(parsed) ? { chords: parsed } : parsed;
  const names = Array.isArray(data.chords) ? data.chords : [];
  const progression = names
    .map((n) => (typeof n === 'string' ? parseLooseChord(n) : null))
    .filter((c): c is Chord => c !== null);
  if (progression.length === 0) {
    return {
      error: `The model reply contained no usable chords — try rephrasing. It began: ${replyPeek(raw)}`,
    };
  }
  const s = getState();
  const key = keyFromName(data.key) ?? s.key;
  const modeId = typeof data.mode === 'string' ? data.mode.toLowerCase() : '';
  const next: Partial<CircleState> = {
    key,
    mode: MODES.find((m) => m.id === modeId)?.id ?? s.mode,
    progression,
    rotation: slotOfKey(key),
    aiExplanation: null,
    aiSuggestions: null,
  };
  if (typeof data.bpm === 'number' && Number.isFinite(data.bpm)) {
    next.bpm = Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(data.bpm)));
  }
  // Replacing the progression desyncs a sounding run from the chips.
  stopProgression();
  return next;
};

/** Suggest: `{"suggestions":[{"chord":"F","why":"…"}]}` → chips. Items with
 * unparseable chord names are dropped; only an empty result is an error. */
const applySuggest = (raw: string): ApplyResult => {
  const parsed = parseJsonReply(raw);
  // Tolerate a bare top-level array (the wrapper object skipped).
  const items = Array.isArray(parsed)
    ? parsed
    : parsed && Array.isArray(parsed.suggestions)
      ? parsed.suggestions
      : null;
  if (!items) {
    return { error: `The model reply was not valid JSON — try again. It began: ${replyPeek(raw)}` };
  }
  const suggestions: AiSuggestion[] = [];
  for (const item of items) {
    // Item shapes seen in the wild: {chord, why} per the prompt, or a bare
    // chord-name string from terser models.
    const { chord: name, why } =
      typeof item === 'string'
        ? { chord: item, why: undefined }
        : typeof item === 'object' && item !== null
          ? (item as { chord?: unknown; why?: unknown })
          : { chord: undefined, why: undefined };
    const chord = typeof name === 'string' ? parseLooseChord(name) : null;
    if (chord) suggestions.push({ chord, why: typeof why === 'string' ? why : '' });
  }
  if (suggestions.length === 0) {
    return {
      error: `The model reply contained no usable suggestions — try again. It began: ${replyPeek(raw)}`,
    };
  }
  return { aiSuggestions: suggestions };
};

/* ── Calls & store plumbing ────────────────────────────────────────────── */

/** Human-readable key for the LLM payload, ASCII spelling: "F# minor". */
const keyName = (key: Key): string =>
  `${spellPitch(key.tonic, key)} ${key.minor ? 'minor' : 'major'}`;

/** Explain/Suggest payload: the progression plus its key, in plain text. */
const progressionPayload = (): string => {
  const s = getState();
  return `${progressionText(s.progression, s.key)} in ${keyName(s.key)}`;
};

/** Shared busy/error wrapper: flips aiBusy, clears the previous error, maps
 * the reply through `apply`, and lands either its patch or an inline error.
 * A rejected invoke (no key configured, network, …) lands as aiError too. */
async function runAssist(
  mode: AiMode,
  payload: string,
  apply: (reply: string) => ApplyResult,
): Promise<void> {
  setState({ aiBusy: true, aiError: null });
  try {
    const reply = await circleAiAssist(mode, payload);
    const result = apply(reply);
    setState(
      'error' in result ? { aiBusy: false, aiError: result.error } : { ...result, aiBusy: false },
    );
  } catch (e) {
    setState({ aiBusy: false, aiError: String(e) });
  }
}

/* ── Component ─────────────────────────────────────────────────────────── */

export const AiPanel = () => {
  const aiBusy = useStore((s) => s.aiBusy);
  const aiError = useStore((s) => s.aiError);
  const aiExplanation = useStore((s) => s.aiExplanation);
  const aiSuggestions = useStore((s) => s.aiSuggestions);
  const empty = useStore((s) => s.progression.length === 0);

  const [prompt, setPrompt] = useState('');
  /** Which action is in flight — puts the spinner on the right button. */
  const [action, setAction] = useState<AiMode | null>(null);

  const run = async (
    mode: AiMode,
    payload: string,
    apply: (reply: string) => ApplyResult,
  ): Promise<void> => {
    setAction(mode);
    try {
      await runAssist(mode, payload, apply);
    } finally {
      setAction(null);
    }
  };

  const compose = (): void => {
    const text = prompt.trim();
    if (!text || aiBusy) return;
    void run('compose', text, applyCompose);
  };

  return (
    <section className="flex flex-col gap-1.5 min-w-0" aria-label="AI assistant">
      <div className="flex items-center gap-1.5 min-w-0">
        <Input
          size="sm"
          className="flex-1 min-w-0"
          placeholder="Describe music to compose — e.g. wistful lo-fi in A minor"
          aria-label="Describe music for the AI to compose"
          value={prompt}
          disabled={aiBusy}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') compose();
          }}
        />
        <Button
          size="sm"
          variant="soft"
          tone="accent"
          loading={aiBusy && action === 'compose'}
          disabled={aiBusy || !prompt.trim()}
          title="Compose a key and progression from the description"
          onClick={compose}
        >
          Compose
        </Button>
        <Button
          size="sm"
          variant="soft"
          loading={aiBusy && action === 'explain'}
          disabled={aiBusy || empty}
          title={empty ? 'Build a progression first' : 'Explain why the progression works'}
          onClick={() => void run('explain', progressionPayload(), (reply) => ({ aiExplanation: reply }))}
        >
          Explain
        </Button>
        <Button
          size="sm"
          variant="soft"
          loading={aiBusy && action === 'suggest'}
          disabled={aiBusy || empty}
          title={empty ? 'Build a progression first' : 'Suggest chords that could come next'}
          onClick={() => void run('suggest', progressionPayload(), applySuggest)}
        >
          Suggest next
        </Button>
      </div>

      {aiError && (
        <p role="alert" className="text-meta text-[color:var(--color-danger-fg)]">
          {aiError}
        </p>
      )}

      {aiExplanation && <LazyMarkdown source={aiExplanation} className="text-body t-secondary" />}

      {aiSuggestions && aiSuggestions.length > 0 && (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Suggested next chords">
          {aiSuggestions.map(({ chord, why }, i) => (
            <button
              key={`${i}-${chord.root}-${chord.quality}`}
              type="button"
              className="circle-chip ring-focus max-w-64"
              title="Append to the progression"
              onClick={() => addChord(chord)}
              onMouseEnter={() => setState({ hoveredChord: chord })}
              onMouseLeave={() => setState({ hoveredChord: null })}
              onFocus={() => setState({ hoveredChord: chord })}
              onBlur={() => setState({ hoveredChord: null })}
            >
              <span className="text-body t-primary">{pretty(chordName(chord))}</span>
              {why && <span className="text-meta t-tertiary text-center">{why}</span>}
            </button>
          ))}
        </div>
      )}
    </section>
  );
};
