/**
 * What the reader has opened beyond the level's policy, as plain data the stream facts read: the Ctrl-O reach, the turns
 * and rows opened one by one, and the turns a search holds open. The controller owns the value; nothing here keeps state.
 * @module
 */

/** The reader's openings. A level's policy decides everything else. */
export interface Disclosure {
  /** Ctrl-O: the last `expandTurns` turns draw their Verbose tier. */
  readonly recent: boolean
  /**
   * Turns Enter on their header set apart from what `recent` gives: `true` opened, `false` folded. The state holds while the
   * reach moves on to newer turns, so no turn opens or folds by itself; a press of Ctrl-O forgets the folds.
   */
  readonly turns: ReadonlyMap<number, boolean>
  /** Entries Enter opened: each draws its Verbose tier with every row it carries (a diff, a command's output, a reasoning block, a folded prompt). */
  readonly rows: ReadonlySet<string>
  /** Runs of calls (by their first call's id) the reader opened as a whole: every call in them is open, those that join later too. */
  readonly groups: ReadonlySet<string>
  /** Turns a search match sits in: mounted and drawn Verbose while the search is open. */
  readonly forced: ReadonlySet<number>
}

/** Nothing opened. */
export const NO_DISCLOSURE: Disclosure = Object.freeze({
  recent: false,
  turns: new Map<number, boolean>(),
  rows: new Set<string>(),
  groups: new Set<string>(),
  forced: new Set<number>(),
})

/**
 * The turns drawn at their Verbose tier: the Ctrl-O reach, then the turns Enter opened or folded, plus the forced ones.
 * @param disclosure - what the reader opened.
 * @param reach - the turns Ctrl-O reaches (the newest few).
 * @returns the turn numbers to open.
 */
export function openTurns(disclosure: Disclosure, reach: ReadonlySet<number>): Set<number> {
  const open = new Set<number>()
  if (disclosure.recent) for (const turn of reach) open.add(turn)
  for (const [turn, opened] of disclosure.turns) {
    if (opened) open.add(turn)
    else open.delete(turn)
  }
  for (const turn of disclosure.forced) open.add(turn)
  return open
}

/**
 * The same disclosure with one turn flipped from how it is drawn: open, it folds; closed, it opens. A turn put back to what
 * Ctrl-O gives it follows Ctrl-O again.
 * @param disclosure - the current value.
 * @param turn - the turn whose header was accepted.
 * @param reach - the turns Ctrl-O reaches, as the stream last drew them.
 * @returns the next value.
 */
export function toggleTurn(disclosure: Disclosure, turn: number, reach: ReadonlySet<number>): Disclosure {
  const opened = !openTurns(disclosure, reach).has(turn)
  const turns = new Map(disclosure.turns)
  if (opened === (disclosure.recent && reach.has(turn))) turns.delete(turn)
  else turns.set(turn, opened)
  return { ...disclosure, turns }
}

/**
 * The same disclosure after Ctrl-O: the reach opens or closes whole. The turns Enter folded are forgotten, so the next press
 * opens them with the others; the turns Enter opened stay open.
 * @param disclosure - the current value.
 * @returns the next value.
 */
export function toggleRecent(disclosure: Disclosure): Disclosure {
  return { ...disclosure, recent: !disclosure.recent, turns: new Map([...disclosure.turns].filter(([, opened]) => opened)) }
}

/**
 * The same disclosure with some entries opened, or closed again when they all are open.
 * @param disclosure - the current value.
 * @param ids - the entry ids a row stands for.
 * @returns the next value.
 */
export function toggleRows(disclosure: Disclosure, ids: readonly string[]): Disclosure {
  if (ids.length === 0) return disclosure
  const rows = new Set(disclosure.rows)
  const allOpen = ids.every(id => rows.has(id))
  for (const id of ids) {
    if (allOpen) rows.delete(id)
    else rows.add(id)
  }
  return { ...disclosure, rows }
}

/**
 * Enter on the head of a run: every call opens, or, when the run is open as a whole or every call is, every call folds.
 * An open run keeps the calls that join it open too.
 * @param disclosure - the current value.
 * @param head - the run's id (its first call's).
 * @param calls - the ids of the calls the run holds now.
 * @returns the next value.
 */
export function toggleGroup(disclosure: Disclosure, head: string, calls: readonly string[]): Disclosure {
  const rows = new Set(disclosure.rows)
  const groups = new Set(disclosure.groups)
  const open = groups.has(head) || calls.every(call => rows.has(call))
  for (const call of calls) rows.delete(call)
  if (open) groups.delete(head)
  else groups.add(head)
  return { ...disclosure, rows, groups }
}

/**
 * Enter on one call of a run: only that call flips, and the run keeps its shape. A call folded inside an open run ends the
 * run's being open as a whole: the other calls stay open one by one, and the ones that join later come in folded.
 * @param disclosure - the current value.
 * @param head - the run's id.
 * @param calls - the ids of the calls the run holds now.
 * @param call - the call that was accepted.
 * @returns the next value.
 */
export function toggleCall(disclosure: Disclosure, head: string, calls: readonly string[], call: string): Disclosure {
  const rows = new Set(disclosure.rows)
  const groups = new Set(disclosure.groups)
  if (groups.delete(head)) for (const other of calls) rows.add(other)
  if (!rows.delete(call)) rows.add(call)
  return { ...disclosure, rows, groups }
}
