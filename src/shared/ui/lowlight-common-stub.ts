/// Stub for `lowlight/lib/common.js`. The real module statically pulls in
/// ~38 highlight.js language grammars (~250 KB) so that `lowlight` exposes a
/// `common` set ready to plug into `createLowlight()`. We always pass our
/// curated language set explicitly (see `Markdown.tsx`), so the `common`
/// export is unused at runtime — but rehype-highlight imports it eagerly,
/// which defeats tree-shaking. Stubbing the module keeps the API surface
/// (`{ grammars }`) intact while shipping zero grammar bytes.
export const grammars: Record<string, never> = {};
