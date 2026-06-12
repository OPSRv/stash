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

/** Extract a JSON object from a model reply that may carry prose or fences:
 * take the body of the first ``` fence if present, otherwise the whole text,
 * then slice from the first `{` to the last `}`. Falls through unchanged when
 * no braces are found, so JSON.parse reports a sensible error. */
const extractJsonObject = (text: string): string => {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fence ? fence[1] : text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
};

/** Extract + parse a reply into a plain object, or null when it isn't one. */
const parseJsonReply = (raw: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(extractJsonObject(raw));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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
  const data = parseJsonReply(raw);
  if (!data) return { error: 'The model reply was not valid JSON — try again.' };
  const names = Array.isArray(data.chords) ? data.chords : [];
  const progression = names
    .map((n) => (typeof n === 'string' ? parseChordName(n) : null))
    .filter((c): c is Chord => c !== null);
  if (progression.length === 0) {
    return { error: 'The model reply contained no usable chords — try rephrasing.' };
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
  const data = parseJsonReply(raw);
  const items = data && Array.isArray(data.suggestions) ? data.suggestions : null;
  if (!items) return { error: 'The model reply was not valid JSON — try again.' };
  const suggestions: AiSuggestion[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const { chord: name, why } = item as { chord?: unknown; why?: unknown };
    const chord = typeof name === 'string' ? parseChordName(name) : null;
    if (chord) suggestions.push({ chord, why: typeof why === 'string' ? why : '' });
  }
  if (suggestions.length === 0) {
    return { error: 'The model reply contained no usable suggestions — try again.' };
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
