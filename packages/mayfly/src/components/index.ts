/**
 * The Mayfly components: pure functions of facts that return `ui.*` nodes. The area has no Cordis entry and no public
 * subpath. A component imports only `@ephemeral-ai/mayfly-ui` and its siblings; widths, ANSI, clocks, and keys belong to
 * `core/`, and the feature plugins that publish a component's nodes own its facts and writes
 * (`tests/components/layering.spec.ts` enforces the boundary). Import a component from its own module, not from here.
 * @module components
 */

export {}
