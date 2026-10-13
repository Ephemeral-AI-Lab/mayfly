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
  /** Entries whose body Enter lifted to its full rows (a diff, a command's output, a reasoning block). */
  readonly rows: ReadonlySet<string>
  /** Turns a search match sits in: mounted and drawn Verbose while the search is open. */
  readonly forced: ReadonlySet<number>
}

/** Nothing opened. */
export const NO_DISCLOSURE: Disclosure = Object.freeze({
  recent: false,
  turns: new Set<number>(),
  rows: new Set<string>(),
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
 * The same disclosure with one entry's body lifted or put back.
 * @param disclosure - the current value.
 * @param id - the entry id.
 * @returns the next value.
 */
export function toggleRow(disclosure: Disclosure, id: string): Disclosure {
  const rows = new Set(disclosure.rows)
  if (!rows.delete(id)) rows.add(id)
  return { ...disclosure, rows }
}
