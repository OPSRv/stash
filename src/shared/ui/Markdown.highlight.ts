// Heavy syntax-highlighting bundle, dynamically imported by `Markdown.tsx`
// only when the source actually contains a fenced code block. Splits
// rehype-highlight + the curated highlight.js grammars (~250 KB minified)
// out of the main UI chunk so plain-prose markdown — the common case for
// AI chat tokens, note bodies, and toast/error blurbs — pays nothing.
import rehypeHighlight from 'rehype-highlight';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdownLang from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import 'highlight.js/styles/github-dark.css';

const HLJS_LANGUAGES = {
  bash,
  shell: bash,
  sh: bash,
  zsh: bash,
  css,
  diff,
  go,
  java,
  javascript,
  js: javascript,
  jsx: javascript,
  json,
  markdown: markdownLang,
  md: markdownLang,
  plaintext,
  text: plaintext,
  python,
  py: python,
  rust,
  rs: rust,
  sql,
  typescript,
  ts: typescript,
  tsx: typescript,
  xml,
  html: xml,
  yaml,
  yml: yaml,
};

// Pre-bound rehype plugin entry — the same shape react-markdown expects in
// `rehypePlugins`. Returned as a tuple so the caller can spread it directly.
export const rehypeHighlightEntry: [typeof rehypeHighlight, { languages: typeof HLJS_LANGUAGES; ignoreMissing: boolean }] = [
  rehypeHighlight,
  { languages: HLJS_LANGUAGES, ignoreMissing: true },
];
