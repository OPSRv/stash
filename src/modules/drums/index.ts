/* Embedded-only module: hosted by the Valeton editor's `Drums` view, so it
 * exports its shell instead of a `ModuleDefinition` — there is no tab in
 * `registry.ts`. The Valeton shell lazy-imports from here, which keeps the
 * whole module (synth, sequencer, renderer) off-heap until Drums is opened. */
export { DrumsShell } from './DrumsShell';
