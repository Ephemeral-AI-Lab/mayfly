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

/** Scene 13's views walks: the frames before the lane is entered (`idle`) and while it is (`entered`). */
const SCENE_13_VIEWS = [
  { walk: 'views', idle: [0], entered: [1] },
  { walk: 'views-next', idle: [0], entered: [1, 2, 3] },
  { walk: 'views-stop', idle: [0], entered: [1, 2] },
  { walk: 'views-back', idle: [0, 2], entered: [1] },
] as const

/** Scene 15's walks: every frame carries the caption and the queue line above the frame, which the Editor component draws. */
const SCENE_15_WALKS = [
  { walk: 'initial', frames: 1 }, { walk: 'type', frames: 3 }, { walk: 'slash', frames: 2 }, { walk: 'mention', frames: 2 }, { walk: 'skill', frames: 2 },
  { walk: 'shell', frames: 2 }, { walk: 'image', frames: 2 }, { walk: 'paste', frames: 2 }, { walk: 'recall', frames: 4 }, { walk: 'running', frames: 2 },
  { walk: 'conversation', frames: 2 }, { walk: 'narrow', frames: 2 }, { walk: 'narrower', frames: 3 },
] as const

export const PENDING_PARITY: readonly PendingParity[] = [
  { directory: '01-marks-and-tokens', walk: 'pages', frames: [0], rows: [21, 26], slice: '1.6', reason: 'page 1 form block: the form marks, units, and (inherited) (1.6)' },
  // Scene 11 (patterns): page 2's railPanel is pinned by `scene-11-patterns.spec.ts`; the pattern calls are slice 1.8b's.
  { directory: '11-patterns', walk: 'initial', frames: [0], slice: '1.8b', reason: 'page 1 is patterns.decisionPanel (1.8b)' },
  { directory: '11-patterns', walk: 'move', frames: [0, 1, 2, 3], slice: '1.8b', reason: 'page 1 is patterns.decisionPanel, whose options list the walk moves through (1.8b)' },
  { directory: '11-patterns', walk: 'pages', frames: [0, 2, 3], slice: '1.8b', reason: 'pages 1, 3, and 4 are patterns.decisionPanel, splitView, and statusPage (1.8b)' },
  { directory: '11-patterns', walk: 'page-2', frames: [0], slice: '1.8b', reason: 'page 1 is patterns.decisionPanel (1.8b)' },
  ...SCENE_15_WALKS.map(({ walk, frames }) => ({
    directory: '15-editor', walk, frames: Array.from({ length: frames }, (_, index) => index), rows: [0, 2] as const, slice: 'Phase 5',
    reason: 'the scene caption and the queue line above the frame are the Editor component (Phase 5); slice 1.9b draws the prompt inside the frame',
  })),
  { directory: '01-marks-and-tokens', walk: 'pages', frames: [5], slice: '1.8b', reason: 'page 6 is patterns.splitView over lists with right-aligned spans (1.4)' },
  ...SCENE_13_VIEWS.flatMap(({ walk, entered, idle }) => [
    { directory: '13-status-area', walk, frames: [...idle, ...entered], rows: [0, 7] as const, slice: 'Phase 3', reason: 'row 1 of the status area (Phase 3) and the editor frame (Phase 5); the lane starts at row 8' },
    { directory: '13-status-area', walk, frames: idle, rows: [8, 8] as const, slice: 'Phase 3', reason: 'row 2 idle: the footer joins summaries with two spaces and has no right cue yet; Phase 3 replaces it with StatusRows' },
    { directory: '13-status-area', walk, frames: entered, rows: [10, 99] as const, slice: 'Phase 3', reason: 'the panel body and its hint row are Mayfly\'s agents and jobs views (Phase 3) over the list painter (1.4)' },
  ]),
]

/** The entries that cover a frame of a walk. */
export function pendingFor(directory: string, walk: string, frame: number): readonly PendingParity[] {
  return PENDING_PARITY.filter(entry => entry.directory === directory && entry.walk === walk && entry.frames.includes(frame))
}
