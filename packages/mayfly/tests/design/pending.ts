/**
 * The golden walks a strict parity spec cannot match yet (docs/design/implementation-roadmap.md, "Working in
 * parallel"), one entry per walk with the slice that will close it. A parity spec expects a listed walk to still differ,
 * so an entry cannot go stale, and slice 1.11 asserts the list is empty.
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

const VISUAL_LANGUAGE = 'the overlay chrome, the action tokens, the feedback row, and the kit hint words and notation (c copy)'

export const PENDING_WALKS: readonly PendingWalk[] = [
  { scene: 2, walk: 'initial', slice: '1.2', reason: VISUAL_LANGUAGE },
  { scene: 2, walk: 'narrow', slice: '1.2', reason: `${VISUAL_LANGUAGE}; the +N fold of a narrow row` },
  { scene: 2, walk: 'copy', slice: '1.2', reason: VISUAL_LANGUAGE },
  { scene: 2, walk: 'copy-link', slice: '1.2', reason: VISUAL_LANGUAGE },
  { scene: 2, walk: 'move', slice: '1.2', reason: VISUAL_LANGUAGE },
]

/** The ledger entry of one walk, if it is pending. */
export function pendingWalk(scene: number, walk: string): PendingWalk | undefined {
  return PENDING_WALKS.find(entry => entry.scene === scene && entry.walk === walk)
}
