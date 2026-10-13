/**
 * What the reader has opened beyond the level's policy, as plain data the stream facts read: the Ctrl-O reach, the turns
 * and rows opened one by one, and the turns a search holds open. The controller owns the value; nothing here keeps state.
 * @module
 */

/** The reader's openings. A level's policy decides everything else. */
export interface Disclosure {
  /** Ctrl-O: the last `expandTurns` turns draw their Verbose tier. */
  readonly recent: boolean
  /** Turns whose state Enter on their header flipped against what `recent` gives. */
  readonly turns: ReadonlySet<number>
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
  turns: new Set<number>(),
  rows: new Set<string>(),
  groups: new Set<string>(),
  forced: new Set<number>(),
})

/**
 * The turns drawn at their Verbose tier: the Ctrl-O reach flipped by the turns Enter toggled, plus the forced ones.
 * @param disclosure - what the reader opened.
 * @param reach - the turns Ctrl-O reaches (the newest few).
 * @returns the turn numbers to open.
 */
export function openTurns(disclosure: Disclosure, reach: ReadonlySet<number>): Set<number> {
  const open = new Set<number>()
  if (disclosure.recent) for (const turn of reach) open.add(turn)
  for (const turn of disclosure.turns) {
    if (open.has(turn)) open.delete(turn)
    else open.add(turn)
  }
  for (const turn of disclosure.forced) open.add(turn)
  return open
}

/**
 * The same disclosure with one turn flipped.
 * @param disclosure - the current value.
 * @param turn - the turn whose header was accepted.
 * @returns the next value.
 */
export function toggleTurn(disclosure: Disclosure, turn: number): Disclosure {
  const turns = new Set(disclosure.turns)
  if (!turns.delete(turn)) turns.add(turn)
  return { ...disclosure, turns }
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
