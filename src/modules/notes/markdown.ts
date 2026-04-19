// Source-based checkbox toggle for task lists. Rendering goes through
// react-markdown + remark-gfm; only the line-aware toggle lives here so the
// editor can rewrite the raw markdown when a checkbox is clicked.

export const toggleCheckboxAtLine = (source: string, line: number): string => {
  const lines = source.split('\n');
  if (line < 0 || line >= lines.length) return source;
  const re = /^(\s*([-*+]|\d+\.)\s+)\[( |x|X)\](\s+.*)$/;
  const m = re.exec(lines[line]);
  if (!m) return source;
  const next = m[3] === ' ' ? 'x' : ' ';
  lines[line] = `${m[1]}[${next}]${m[4]}`;
  return lines.join('\n');
};
