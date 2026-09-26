/**
 * Frontend-tree-scoped transcript presentation policy. The host settings
 * document updates this object; semantic components read it without owning a
 * second Harness projection or leaking mutable policy between Cordis trees.
 *
 * The work-details modes mirror the upstream Harness Chat policy table: each
 * mode resolves to a fixed set of capabilities, and renderers read single
 * capabilities rather than comparing the mode.
 *
 * @module @ephemeral-ai/mayfly/transcript/presentation-policy
 */

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

/** Presentation capabilities one work-details mode enables (the upstream `ChatPresentationPolicy`). */
export interface ProcessPolicy {
  /** Whether a normally completed turn folds its process and interim replies behind the turn header. */
  readonly foldCompletedTurns: boolean
  /** Collapsed group titles for every turn, for closed turns only, or never. */
  readonly stepGrouping: 'collapsed' | 'history' | 'none'
  /** Whether a running group title appends the running command, path, query, or reasoning. */
  readonly liveProcessDetail: boolean
  /** Whether a settled reasoning row previews its first line beside its title. */
  readonly settledReasoningPreview: boolean
}

/** The fixed capability table; the same mode always yields the same object. */
export const PROCESS_POLICIES: Readonly<Record<TranscriptViewMode, ProcessPolicy>> = Object.freeze({
  compact: Object.freeze({ foldCompletedTurns: true, stepGrouping: 'collapsed', liveProcessDetail: false, settledReasoningPreview: false }),
  standard: Object.freeze({ foldCompletedTurns: true, stepGrouping: 'collapsed', liveProcessDetail: true, settledReasoningPreview: true }),
  detailed: Object.freeze({ foldCompletedTurns: true, stepGrouping: 'history', liveProcessDetail: true, settledReasoningPreview: true }),
  verbose: Object.freeze({ foldCompletedTurns: false, stepGrouping: 'none', liveProcessDetail: false, settledReasoningPreview: true }),
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
