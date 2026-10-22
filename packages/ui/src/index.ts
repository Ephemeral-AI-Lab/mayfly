/**
 * Renderer-neutral Mayfly UI contracts and pure wire-node builders.
 *
 * @module @ephemeral-ai/mayfly-ui
 */

export * from './contracts.ts'
export {
  deepFreeze,
  freezeWire,
  defineMayflyComponent,
  ui,
  type MayflyComponentDefinition,
  type MayflyComponentFactory,
} from './builders.ts'
