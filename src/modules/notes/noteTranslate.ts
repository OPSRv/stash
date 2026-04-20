import { translate } from '../translator/api';

export type TranslateEdit = {
  /** Source string handed to the translator (trimmed, never empty). */
  source: string;
  /** Where the translation should land in the final body. */
  insertion: {
    next: string;
    /** New selection start/end so the translated chunk is selected after
     *  the edit — lets the user immediately nudge / replace. */
    selStart: number;
    selEnd: number;
  };
};

export type TranslateOutcome =
  | { kind: 'ok'; edit: TranslateEdit; translated: string; from: string; to: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'error'; message: string };

/** Produce the edit we would apply if we translated the given selection in
 *  `body`. Pure — no IPC, no DOM — so the unit tests can pin the before/after
 *  shape without mocking the network. Selection semantics:
 *  - A non-empty selection translates and REPLACES only that slice.
 *  - An empty / whole-doc selection appends the translation below a
 *    `---` divider with an italic caption — original stays intact. */
export const buildTranslationEdit = (
  body: string,
  selStart: number,
  selEnd: number,
  translated: string,
  to: string,
): TranslateEdit => {
  const hasSelection = selStart !== selEnd;
  if (hasSelection) {
    const next = body.slice(0, selStart) + translated + body.slice(selEnd);
    return {
      source: body.slice(selStart, selEnd),
      insertion: {
        next,
        selStart,
        selEnd: selStart + translated.length,
      },
    };
  }
  const trimmedBody = body.trimEnd();
  const separator = trimmedBody.length > 0 ? '\n\n---\n' : '';
  const caption = `*Translation → ${to}:*\n\n`;
  const prefix = trimmedBody + separator + caption;
  const next = prefix + translated;
  return {
    source: body,
    insertion: {
      next,
      selStart: prefix.length,
      selEnd: prefix.length + translated.length,
    },
  };
};

/** Run the translator for the current selection / body and return a ready-
 *  to-apply edit. The caller is responsible for writing `edit.insertion.next`
 *  back into the textarea + applying the selection (requestAnimationFrame). */
export const translateForNote = async (
  body: string,
  selStart: number,
  selEnd: number,
  to: string = 'uk',
): Promise<TranslateOutcome> => {
  const hasSelection = selStart !== selEnd;
  const source = (hasSelection ? body.slice(selStart, selEnd) : body).trim();
  if (!source) return { kind: 'skipped', reason: 'empty source' };
  const result = await translate(source, to).then(
    (r) => ({ ok: true as const, r }),
    (e: unknown) => ({ ok: false as const, e }),
  );
  if (!result.ok) return { kind: 'error', message: String(result.e) };
  const cleaned = result.r.translated.trim();
  if (!cleaned) return { kind: 'skipped', reason: 'empty translation' };
  return {
    kind: 'ok',
    translated: cleaned,
    from: result.r.from,
    to: result.r.to,
    edit: buildTranslationEdit(body, selStart, selEnd, cleaned, to),
  };
};
