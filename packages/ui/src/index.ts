/**
 * Renderer-neutral Mayfly UI contracts and pure wire-node builders.
 *
 * @module @ephemeral-ai/mayfly-ui
 */

export type * from './contracts.ts'
export {
  deepFreeze,
  freezeWire,
  isWireSnapshot,
  defineMayflyComponent,
  ui,
  type MayflyComponentDefinition,
  type MayflyComponentFactory,
} from './builders.ts'
export {
  patterns,
  type MayflyDecisionPanelProps,
  type MayflyRailPanelProps,
  type MayflySplitViewProps,
  type MayflyStatusPageProps,
} from './patterns.ts'
