/** Model selection equality and the reference switch feedback. @module @ephemeral-ai/mayfly/components/model-selection */

/** Readonly route fields used by both native and Remote model selection. */
interface ModelSelectionFacts {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Whether the model route and explicit effort are unchanged. */
export function sameModelSelection(previous: ModelSelectionFacts, next: ModelSelectionFacts): boolean {
  return previous.provider === next.provider && previous.model === next.model && previous.reasoningEffort === next.reasoningEffort
}

/** Reference notice for a confirmed route or effort change. */
export function modelSwitchNotice(previous: ModelSelectionFacts, next: ModelSelectionFacts, defaultEffort?: string): string {
  const modelChanged = previous.provider !== next.provider || previous.model !== next.model
  const effortChanged = previous.reasoningEffort !== next.reasoningEffort
  const effective = next.reasoningEffort ?? defaultEffort
  if (modelChanged) {
    const base = `Switched to ${next.model} (${next.provider})`
    return effective === undefined ? base : `${base} · thinking ${effective}`
  }
  if (effortChanged) {
    if (next.reasoningEffort !== undefined) return `Thinking set to ${next.reasoningEffort}`
    return defaultEffort === undefined ? 'Thinking set to provider default' : `Thinking set to provider default (${defaultEffort})`
  }
  return `Already using ${next.model} (${next.provider})`
}
