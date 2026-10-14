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
  /**
   * A running turn's process, as the tier each view draws: `collect` (one line that collects the turn's calls, and the lines of those in flight), `blocks` (a run of calls of one kind is one
   * multi-line block, the Standard tier), `current` (the step the model works in draws one block with a body per call, the
   * Verbose tier, and the steps before it collapse to blocks), or `cards` (the Verbose tier for every step). A call in
   * flight is a pending line in every view, `collect` included (a kind's input under it by tier); the activity row names only the phase.
   */
  readonly liveProcess: 'collect' | 'blocks' | 'current' | 'cards'
  /** A settled turn's process: `collect` is the Compact tier, one line for the turn's calls. */
  readonly settledProcess: 'collect' | 'blocks' | 'cards'
  /** Whether a compaction row is one line, without its bar or summary (the Compact tier). */
  readonly compactionLine: boolean
  /** Whether a compaction row shows its summary without being opened (the Verbose tier). */
  readonly compactionSummary: boolean
}

/** The fixed capability table; the same mode always yields the same object. */
export const PROCESS_POLICIES: Readonly<Record<TranscriptViewMode, ProcessPolicy>> = Object.freeze({
  compact: Object.freeze({ liveProcess: 'collect', settledProcess: 'collect', compactionLine: true, compactionSummary: false }),
  standard: Object.freeze({ liveProcess: 'blocks', settledProcess: 'blocks', compactionLine: false, compactionSummary: false }),
  detailed: Object.freeze({ liveProcess: 'current', settledProcess: 'blocks', compactionLine: false, compactionSummary: false }),
  verbose: Object.freeze({ liveProcess: 'cards', settledProcess: 'cards', compactionLine: false, compactionSummary: true }),
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
