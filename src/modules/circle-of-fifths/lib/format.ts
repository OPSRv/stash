/* Display formatting shared across the circle-of-fifths components. */

/** ASCII accidentals → typographic glyphs for display ('F#' → 'F♯',
 * 'Bb' → 'B♭', 'bVII' → '♭VII'). Display-only — theory keeps ASCII. */
export const pretty = (label: string): string => label.replace(/#/g, '♯').replace(/b/g, '♭');
