/* Embedded-only module: hosted by the Valeton editor's `Circle` view, so it
 * exports its shell instead of a `ModuleDefinition` — there is no tab in
 * `registry.ts`. The Valeton shell lazy-imports from here, which keeps the
 * whole module off-heap until the Circle button is first pressed. */
export { CircleShell } from './CircleShell';
