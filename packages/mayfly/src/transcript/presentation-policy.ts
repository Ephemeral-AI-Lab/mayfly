/**
 * Frontend-tree-scoped transcript presentation policy. The host settings
 * document updates this object; semantic components read it without owning a
 * second Harness projection or leaking mutable policy between Cordis trees.
 *
 * @module @ephemeral-ai/mayfly/transcript/presentation-policy
 */

/** Default count of newest transcript turns kept mounted. */
export const DEFAULT_WINDOW_TURNS = 15
/** Recent steps retained by the domain projection before summary folding. */
export const DEFAULT_RECENT_STEPS_RETENTION = 30
/** Most-recent turns reached by the Ctrl-O expansion toggle. */
export const DEFAULT_EXPAND_TURNS = 3
/** Raw-line threshold above which a user message folds. */
export const DEFAULT_USER_FOLD_LINES = 10
/** Raw-character threshold above which a user message folds. */
export const DEFAULT_USER_FOLD_CHARS = 1000

/**
 * One entry family's detail level: `full` renders complete bodies by default,
 * `collapsed` keeps the bounded preview/tree, `compact` keeps only the summary
 * header (settled thinking renders nothing; failures keep a one-line error).
 */
export type TranscriptDetail = 'full' | 'collapsed' | 'compact'

/**
 * Transcript families with independently configurable detail. `thinking` is
 * the reasoning block; `command` covers terminal-card calls (grouped and
 * lone); `read`/`search` the grouped file/search calls; `edit`/`web`/`other`
 * the remaining lone tool cards by presenter card.
 */
export type TranscriptFamily = 'thinking' | 'command' | 'read' | 'search' | 'edit' | 'web' | 'other'

/** All configurable families, in settings-document order. */
export const TRANSCRIPT_FAMILIES: readonly TranscriptFamily[] = [
  'thinking', 'command', 'read', 'search', 'edit', 'web', 'other',
]

/** The shipped per-family detail when the host provides nothing. */
export const DEFAULT_TRANSCRIPT_DETAIL: TranscriptDetail = 'compact'

function transcriptDetail(candidate: unknown): TranscriptDetail | undefined {
  return candidate === 'full' || candidate === 'collapsed' || candidate === 'compact' ? candidate : undefined
}

/** Immutable reading of one transcript tree's presentation policy. */
export interface TranscriptPresentationSnapshot {
  /** Resolved per-family detail; `inherit` already folded through `defaultDetail`. */
  readonly detail: Readonly<Record<TranscriptFamily, TranscriptDetail>>
  /** The raw `transcript.default` fallback level family values inherit. */
  readonly defaultDetail: TranscriptDetail
  readonly windowTurns: number
  readonly recentStepsRetention: number
  readonly expandTurns: number
  readonly userFoldLines: number
  readonly userFoldChars: number
}

/** Default policy used when the host has no settings service. */
export const DEFAULT_TRANSCRIPT_PRESENTATION: TranscriptPresentationSnapshot = Object.freeze({
  detail: Object.freeze<Record<TranscriptFamily, TranscriptDetail>>({
    thinking: DEFAULT_TRANSCRIPT_DETAIL,
    command: DEFAULT_TRANSCRIPT_DETAIL,
    read: DEFAULT_TRANSCRIPT_DETAIL,
    search: DEFAULT_TRANSCRIPT_DETAIL,
    edit: DEFAULT_TRANSCRIPT_DETAIL,
    web: DEFAULT_TRANSCRIPT_DETAIL,
    other: DEFAULT_TRANSCRIPT_DETAIL,
  }),
  defaultDetail: DEFAULT_TRANSCRIPT_DETAIL,
  windowTurns: DEFAULT_WINDOW_TURNS,
  recentStepsRetention: DEFAULT_RECENT_STEPS_RETENTION,
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
   * `transcript.<family>` accepts `full`/`collapsed`/`compact`/`inherit`;
   * `inherit` and absent keys resolve through `transcript.default`; malformed
   * values retain their current setting, as do the numeric tunables.
   * @param input - unknown host settings section.
   * @returns whether any effective value changed.
   */
  apply(input: unknown): boolean {
    const section = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
    const transcript = typeof section.transcript === 'object' && section.transcript !== null
      ? section.transcript as Record<string, unknown>
      : {}
    const before = this.value
    const positiveInteger = (candidate: unknown, fallback: number): number =>
      typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0 ? candidate : fallback
    const defaultDetail = transcriptDetail(transcript.default) ?? before.defaultDetail
    const detail = Object.freeze(Object.fromEntries(TRANSCRIPT_FAMILIES.map(family => {
      const raw = transcript[family]
      const parsed = transcriptDetail(raw)
      const value = parsed ?? (raw === undefined || raw === 'inherit' ? defaultDetail : before.detail[family])
      return [family, value]
    })) as Record<TranscriptFamily, TranscriptDetail>)
    const next: TranscriptPresentationSnapshot = Object.freeze({
      detail,
      defaultDetail,
      windowTurns: positiveInteger(section.windowTurns, before.windowTurns),
      recentStepsRetention: positiveInteger(section.recentStepsRetention, before.recentStepsRetention),
      expandTurns: positiveInteger(section.expandTurns, before.expandTurns),
      userFoldLines: positiveInteger(section.userFoldLines, before.userFoldLines),
      userFoldChars: positiveInteger(section.userFoldChars, before.userFoldChars),
    })
    const changed = next.defaultDetail !== before.defaultDetail
      || TRANSCRIPT_FAMILIES.some(family => detail[family] !== before.detail[family])
      || next.windowTurns !== before.windowTurns
      || next.recentStepsRetention !== before.recentStepsRetention
      || next.expandTurns !== before.expandTurns
      || next.userFoldLines !== before.userFoldLines
      || next.userFoldChars !== before.userFoldChars
    if (changed) this.value = next
    return changed
  }
}
