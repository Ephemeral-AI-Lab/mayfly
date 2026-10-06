/**
 * The pending-parity ledgers (docs/design/implementation-roadmap.md, "Working in parallel"): what a strict parity spec
 * cannot match yet because the behavior belongs to a later slice of Phase 1. Every entry names that slice; slice 1.11
 * asserts both ledgers are empty.
 *
 * - `PENDING_WALKS` lists whole walks. A parity spec expects a listed walk to still differ, so an entry cannot go stale.
 * - `PENDING_PARITY` lists frames, or rectangles of cells inside them. A parity spec skips only the cells an entry
 *   covers, so everything else in the frame is still compared.
 */

export interface PendingWalk {
  /** The prototype scene number. */
  readonly scene: number
  /** The walk name in script/design-golden-walks.mjs. */
  readonly walk: string
  /** The slice whose work the walk waits for. */
  readonly slice: string
  readonly reason: string
}

export const PENDING_WALKS: readonly PendingWalk[] = []

/** The ledger entry of one walk, if it is pending. */
export function pendingWalk(scene: number, walk: string): PendingWalk | undefined {
  return PENDING_WALKS.find(entry => entry.scene === scene && entry.walk === walk)
}

export interface PendingParity {
  /** The golden directory, e.g. `01-marks-and-tokens`. */
  readonly directory: string
  readonly walk: string
  /** The frame indexes of the walk (one per step, starting at 0). */
  readonly frames: readonly number[]
  /** Inclusive rows of the frame; absent means the whole frame. */
  readonly rows?: readonly [number, number]
  /** Inclusive columns; absent means whole rows. */
  readonly cols?: readonly [number, number]
  /** The slice that closes the entry. */
  readonly slice: string
  readonly reason: string
}

export const PENDING_PARITY: readonly PendingParity[] = [
  { directory: '01-marks-and-tokens', walk: 'pages', frames: [0], rows: [7, 26], slice: '1.4', reason: 'page 1 below the first list: marker: selection rails, right-aligned counts, tree guides and disclosure (1.4) and the form marks, units, and (inherited) (1.6)' },
  { directory: '01-marks-and-tokens', walk: 'pages', frames: [3], rows: [2, 2], cols: [0, 0], slice: '1.3', reason: 'the loader draws the gap variant (⣾) by default' },
  { directory: '01-marks-and-tokens', walk: 'pages', frames: [5], slice: '1.8b', reason: 'page 6 is patterns.splitView over lists with right-aligned spans (1.4)' },
  { directory: '08-content', walk: 'pages', frames: [2], rows: [8, 16], slice: '1.3', reason: 'page 3 markdown: the kit\'s heading, bullet, quote, and fence look through the real markdown renderer' },
  { directory: '08-content', walk: 'highlight', frames: [3], slice: '1.3', reason: 'the h key is a demo toggle (one flat user tone); the real code node has no such switch, so the frame needs a Δ or a numbered/flat option' },
]

/** The entries that cover a frame of a walk. */
export function pendingFor(directory: string, walk: string, frame: number): readonly PendingParity[] {
  return PENDING_PARITY.filter(entry => entry.directory === directory && entry.walk === walk && entry.frames.includes(frame))
}
