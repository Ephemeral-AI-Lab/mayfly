/**
 * Frontend-tree-scoped transcript presentation policy. The host settings
 * document updates this object; semantic components and the activity row
 * read it without owning a second Harness projection or leaking mutable
 * policy between Cordis trees.
 *
 * The work-details modes keep the upstream Harness Chat names but split the
 * work by tense: the activity row owns every live fact (phase, elapsed time,
 * current action, throughput), and the transcript shows only content and
 * settled summaries. Each mode resolves to a fixed set of capabilities, and
 * renderers read single capabilities rather than comparing the mode.
 *
 * @module @ephemeral-ai/mayfly/transcript/presentation-policy
 */

import type { Context } from '@deepseek-ai/cordis'
// Empty type import carries the `settings/document-updated` Events merge.
import type {} from '@deepseek-ai/dsh-settings'

/** Default count of newest transcript turns kept mounted. */
export const DEFAULT_WINDOW_TURNS = 15
/** Most-recent turns reached by the Ctrl-O expansion toggle. */
export const DEFAULT_EXPAND_TURNS = 3
/** Raw-line threshold above which a user message folds. */
export const DEFAULT_USER_FOLD_LINES = 10
/** Raw-character threshold above which a user message folds. */
export const DEFAULT_USER_FOLD_CHARS = 1000

/** The Harness work-details mode persisted in `mayfly.transcriptView`. */
export type TranscriptViewMode = 'compact' | 'standard' | 'detailed' | 'verbose'

/** Presentation capabilities one work-details mode enables. */
export interface ProcessPolicy {
  /** Whether a normally completed turn folds its process and interim replies behind the turn header. */
  readonly foldCompletedTurns: boolean
  /**
   * A running turn's process, as the tier each view draws: `hidden` (nothing), `blocks` (a run of calls of one kind is one
   * multi-line block, the Standard tier), `current` (the step the model works in draws one block with a body per call, the
   * Verbose tier, and the steps before it collapse to blocks), or `cards` (the Verbose tier for every step). A running call
   * has no block in any view: the activity row names it.
   */
  readonly liveProcess: 'hidden' | 'blocks' | 'current' | 'cards'
  /** A settled turn that does not fold: `titles` is the Compact tier, one merged line per run of calls between two messages. */
  readonly settledProcess: 'titles' | 'blocks' | 'cards'
  /**
   * Diff-card calls (file writes and edits): ordinary process members, or
   * content that renders as its card, closes the current group, and stays
   * visible when the turn folds.
   */
  readonly fileChanges: 'process' | 'content'
  /** Whether a settled reasoning row shows its first line only, instead of the whole text (an open turn always shows it whole). */
  readonly settledReasoningPreview: boolean
  /** Whether a streaming reasoning grows line by line under its header, instead of showing its latest line. */
  readonly streamedReasoning: boolean
}

/** The fixed capability table; the same mode always yields the same object. */
export const PROCESS_POLICIES: Readonly<Record<TranscriptViewMode, ProcessPolicy>> = Object.freeze({
  compact: Object.freeze({ foldCompletedTurns: true, liveProcess: 'hidden', settledProcess: 'titles', fileChanges: 'process', settledReasoningPreview: false, streamedReasoning: false }),
  standard: Object.freeze({ foldCompletedTurns: false, liveProcess: 'blocks', settledProcess: 'blocks', fileChanges: 'content', settledReasoningPreview: false, streamedReasoning: false }),
  detailed: Object.freeze({ foldCompletedTurns: false, liveProcess: 'current', settledProcess: 'blocks', fileChanges: 'content', settledReasoningPreview: true, streamedReasoning: false }),
  verbose: Object.freeze({ foldCompletedTurns: false, liveProcess: 'cards', settledProcess: 'cards', fileChanges: 'content', settledReasoningPreview: false, streamedReasoning: true }),
})

/** Immutable reading of one transcript tree's presentation policy. */
export interface TranscriptPresentationSnapshot {
  readonly mode: TranscriptViewMode
  /** The capabilities the mode enables. */
  readonly process: ProcessPolicy
  readonly windowTurns: number
  readonly expandTurns: number
  readonly userFoldLines: number
  readonly userFoldChars: number
}

/** Default policy used when the host has no settings service. */
export const DEFAULT_TRANSCRIPT_PRESENTATION: TranscriptPresentationSnapshot = Object.freeze({
  mode: 'standard',
  process: PROCESS_POLICIES.standard,
  windowTurns: DEFAULT_WINDOW_TURNS,
  expandTurns: DEFAULT_EXPAND_TURNS,
  userFoldLines: DEFAULT_USER_FOLD_LINES,
  userFoldChars: DEFAULT_USER_FOLD_CHARS,
})

/** Mutable policy capsule owned by one `mayfly-transcript` parent Fiber. */
export class TranscriptPresentationPolicy {
  private value: TranscriptPresentationSnapshot = DEFAULT_TRANSCRIPT_PRESENTATION

  /** Return an immutable snapshot for one render or assertion. */
  snapshot(): TranscriptPresentationSnapshot { return this.value }

  /**
   * Apply recognized values from the resolved `mayfly` settings section.
   * Unknown work-detail modes use Standard. Valid positive integer tunables
   * update independently; malformed numeric values retain the current setting.
   * @param input - unknown host settings section.
   * @returns whether any effective value changed.
   */
  apply(input: unknown): boolean {
    const section = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
    const before = this.value
    const positiveInteger = (candidate: unknown, fallback: number): number =>
      typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0 ? candidate : fallback
    const mode: TranscriptViewMode = section.transcriptView === 'compact' || section.transcriptView === 'detailed' || section.transcriptView === 'verbose' ? section.transcriptView : 'standard'
    const next: TranscriptPresentationSnapshot = Object.freeze({
      mode,
      process: PROCESS_POLICIES[mode],
      windowTurns: positiveInteger(section.windowTurns, before.windowTurns),
      expandTurns: positiveInteger(section.expandTurns, before.expandTurns),
      userFoldLines: positiveInteger(section.userFoldLines, before.userFoldLines),
      userFoldChars: positiveInteger(section.userFoldChars, before.userFoldChars),
    })
    const changed = next.mode !== before.mode
      || next.windowTurns !== before.windowTurns
      || next.expandTurns !== before.expandTurns
      || next.userFoldLines !== before.userFoldLines
      || next.userFoldChars !== before.userFoldChars
    if (changed) this.value = next
    return changed
  }
}

/**
 * Feed one policy from the host `mayfly` settings section: the current value
 * now, then every `settings/document-updated` for that namespace. The
 * listener is Fiber-owned, so it retires with `ctx`.
 * @param ctx - the owning plugin context.
 * @param policy - the tree's policy capsule.
 * @param onChange - called after an update changed an effective value.
 */
export function followPresentationSettings(ctx: Context, policy: TranscriptPresentationPolicy, onChange: () => void): void {
  const read = (): unknown => ctx.get('mayflyInteractionState')?.settingsSource()
  policy.apply(read())
  ctx.on('settings/document-updated', (ns) => {
    if (String(ns) === 'mayfly' && policy.apply(read())) onChange()
  })
}
