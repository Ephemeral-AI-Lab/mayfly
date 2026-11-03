/**
 * Renderer-neutral Mayfly UI contracts and pure wire-node builders.
 *
 * @module @ephemeral-ai/mayfly-ui
 */

export type * from './contracts.ts'
export { equalPaneSummary, equalStatusNode } from './status-equality.ts'
export {
  deepFreeze,
  freezeWire,
  isWireSnapshot,
  textOf,
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
  type MayflyWizardProps,
  type MayflyWizardReviewItem,
  type MayflyWizardStep,
} from './patterns.ts'

export {
  compose,
  tabs,
  browser,
  completionPalette,
  decisionArmMs,
  decisionLane,
  decisionStrip,
  panel,
  rail,
  statusPage,
  wizard,
  wizardNext,
  DECISION_NO,
  DECISION_YES,
  type BrowserProps,
  type CompletionPaletteItem,
  type CompletionPaletteProps,
  type DecisionLaneProps,
  type DecisionStripProps,
  type PanelProps,
  type TabsProps,
  type RailProps,
  type StatusPageProps,
  type WizardProps,
  type WizardReview,
  type WizardReviewItem,
  type WizardStep,
} from './compositions.ts'
