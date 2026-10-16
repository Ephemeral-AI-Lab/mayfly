/**
 * The new-messages marker of one conversation view. A reader who scrolls away from the tail leaves the newest rows below the
 * view; the rows that arrive from then on are the ones they have not seen. The marker is a rule in the stream before the
 * first of them, so Ctrl+↓ can bring it to the top of the view, and it leaves once the reader has gone past it or looked at
 * it long enough.
 *
 * The state here is semantics only (which row begins the unseen ones, how long the rule has been on screen). Where the rule
 * stands comes from the host: the stream list reports the line of the followed row, and the content scroll reports its top
 * and height.
 *
 * @module @ephemeral-ai/mayfly/transcript/new-messages
 */

import { NEW_MESSAGES_ROWS, type StreamRow, type StreamTurn, type TranscriptViewFacts } from '../components/transcript-view.ts'

/** The rows of history that stay above the rule when Ctrl+↓ brings it to the top of the view. */
export const NEW_MESSAGES_HISTORY_ROWS = 3

/** How long the rule may stand on screen before it goes, counted over the time it is in view. */
export const NEW_MESSAGES_VISIBLE_MS = 5000

/** The marker row's id: one per stream, so the list keeps the same item while the rule moves. */
const MARKER_ID = 'new-messages'

type MarkerRow = Extract<StreamRow, { readonly kind: 'new-messages' }>

/** Rows that are not messages of the conversation: the turn's header and the folded process title are structure, and the marker is the rule itself. */
function isMessage(row: StreamRow): boolean {
  return row.kind !== 'header' && row.kind !== 'title' && row.kind !== 'new-messages'
}

/**
 * The ids of the stream's message rows, oldest first. The queued messages are not among them: they are not part of the
 * conversation yet.
 * @param facts - the stream's facts.
 * @returns the row ids in reading order.
 */
export function messageRowIds(facts: TranscriptViewFacts): string[] {
  const ids: string[] = []
  for (const turn of facts.turns) {
    for (const row of turn.rows) if (isMessage(row)) ids.push(row.id)
    for (const row of turn.after ?? []) if (isMessage(row)) ids.push(row.id)
  }
  return ids
}

/** What the marker asks of the screen it is shown on. */
export interface NewMessagesHost {
  /** The content scroll's standing: `undefined` when the screen does not scroll its content (the main screen). */
  tail(): { readonly away: boolean, readonly top: number, readonly viewport: number } | undefined
  /** The line the marker row stands on among the content's rows, or `undefined` while it is not painted. */
  row(): number | undefined
  /** Scroll the content so `row` stands at the top of the view. */
  scrollTo(row: number): void
  /** Scroll the content up by `rows`, which keeps what the reader sees where it was after rows above the view went. */
  scrollUp(rows: number): void
  /** Bring the view back to the newest content. */
  follow(): void
  /** Publish the stream again: the marker came or went. */
  republish(): void
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** The marker of one conversation view. */
export class NewMessages {
  /** The marker row, kept by identity while its text stays: the list's caches hit on it. */
  private marker: MarkerRow | undefined
  /** The message rows the reader had seen when they left the tail; `undefined` while nothing is pending. */
  private known: ReadonlySet<string> | undefined
  /** The message rows of the last stream built while the view was at the tail. */
  private tail: readonly string[] = []
  /** The message rows of the last stream built. */
  private latest: readonly string[] = []
  /** The first row the reader has not seen, while there is one. */
  private boundary: string | undefined
  /** The time the marker has stood in view, over the spans before the current one. */
  private visibleMs = 0
  private shownSince = 0
  private timer: unknown
  /** The turn the marker was last put into, and what came of it: the same turn and boundary give the same result. */
  private inserted: { readonly source: StreamTurn, readonly boundary: string, readonly marker: MarkerRow, readonly result: StreamTurn } | undefined

  constructor(private readonly host: NewMessagesHost) {}

  /** Whether a marker is waiting to be read. */
  get pending(): boolean { return this.boundary !== undefined }

  /** The marker row's id, while a marker is pending. */
  get rowId(): string | undefined { return this.boundary === undefined ? undefined : MARKER_ID }

  /**
   * Take a built stream in: decide which row begins what the reader has not seen.
   * @param ids - the stream's message row ids.
   * @param away - the view is scrolled away from the tail.
   * @returns the id of the row the marker goes before, or `undefined`.
   */
  observe(ids: readonly string[], away: boolean): string | undefined {
    this.latest = ids
    if (!away) {
      this.tail = ids
      // Nothing was left behind: the next time the reader leaves, what stands then is what they have seen.
      if (this.boundary === undefined) this.known = undefined
    } else if (this.known === undefined) {
      this.known = new Set(this.tail)
    }
    const known = this.known
    if (known === undefined) return this.boundary
    let last = -1
    for (let index = ids.length - 1; index >= 0; index -= 1) {
      if (known.has(ids[index]!)) { last = index; break }
    }
    // None of the rows the reader had seen is left (another conversation, a rewind): there is nothing to compare with.
    if (last < 0) {
      this.clear()
      return undefined
    }
    const next = ids[last + 1]
    if (next === undefined && this.boundary !== undefined) {
      this.clear()
      return undefined
    }
    this.boundary = next
    return next
  }

  /**
   * Put the marker row into a stream's facts, before the boundary row.
   * @param facts - the built facts.
   * @param boundary - the row the marker goes before.
   * @param text - the marker's translated label.
   * @returns the facts with the marker; the turns that did not change keep their identity.
   */
  insert(facts: TranscriptViewFacts, boundary: string, text: string): TranscriptViewFacts {
    if (this.marker?.text !== text) this.marker = { kind: 'new-messages', id: MARKER_ID, text }
    const marker = this.marker
    const index = facts.turns.findIndex(turn => turn.rows.some(row => row.id === boundary) || (turn.after?.some(row => row.id === boundary) ?? false))
    if (index < 0) return facts
    const source = facts.turns[index]!
    const kept = this.inserted
    const result = kept !== undefined && kept.source === source && kept.boundary === boundary && kept.marker === marker ? kept.result : turnWith(source, boundary, marker)
    this.inserted = { source, boundary, marker, result }
    return { ...facts, turns: facts.turns.map((turn, at) => at === index ? result : turn) }
  }

  /**
   * The content's layout moved: see where the marker stands against the view. A marker above the view was passed, so the
   * reader has seen what follows it; one in view runs down its time; one below the view waits.
   */
  layout(): void {
    if (this.boundary === undefined) return
    const tail = this.host.tail()
    const row = this.host.row()
    if (tail === undefined || row === undefined) {
      this.pause()
      return
    }
    if (row < tail.top) {
      // The layout that found it is still painting: the stream changes after it.
      const away = tail.away
      queueMicrotask(() => { if (this.boundary !== undefined) this.dismiss(away) })
    } else if (row < tail.top + tail.viewport) this.resume()
    else this.pause()
  }

  /**
   * Ctrl+↓: the first press brings the marker to the top of the view with a few rows of history above it; with no marker
   * to go to (or the view already there) it follows the tail.
   */
  jump(): void {
    const tail = this.host.tail()
    const row = this.host.row()
    if (this.boundary !== undefined && tail?.away === true && row !== undefined) {
      const target = row - NEW_MESSAGES_HISTORY_ROWS
      if (target > tail.top) {
        this.host.scrollTo(target)
        return
      }
    }
    this.host.follow()
  }

  /** The marker and what it waited for are gone: another conversation, the stream's focus, or new texts under the same ids. */
  reset(): void {
    this.clear()
    this.known = undefined
    this.tail = []
    this.latest = []
    this.marker = undefined
    this.inserted = undefined
  }

  private clear(): void {
    this.stop()
    this.boundary = undefined
    this.visibleMs = 0
  }

  /** The marker goes. `compensate`: the view is away from the tail and the marker stood above it, so the rows it took are given back. */
  private dismiss(compensate: boolean): void {
    this.clear()
    // A reader still away has now been told about everything that stands: only later rows are new.
    this.known = compensate || this.host.tail()?.away === true ? new Set(this.latest) : undefined
    this.host.republish()
    if (compensate) this.host.scrollUp(NEW_MESSAGES_ROWS)
  }

  private resume(): void {
    if (this.timer !== undefined) return
    this.shownSince = this.host.now()
    this.timer = this.host.setTimeout(() => {
      this.timer = undefined
      this.dismiss(false)
    }, Math.max(0, NEW_MESSAGES_VISIBLE_MS - this.visibleMs))
  }

  private pause(): void {
    if (this.timer === undefined) return
    this.visibleMs += this.host.now() - this.shownSince
    this.stop()
  }

  private stop(): void {
    if (this.timer === undefined) return
    this.host.clearTimeout(this.timer)
    this.timer = undefined
  }
}

/** A turn with the marker before the boundary row, in the rows or the blocks after the closing line. */
function turnWith(turn: StreamTurn, boundary: string, marker: MarkerRow): StreamTurn {
  const among = (rows: readonly StreamRow[]): readonly StreamRow[] => {
    let at = rows.findIndex(row => row.id === boundary)
    // The turn's header is not a message: the rule goes before it, so the header stays with its turn's first message.
    while (at > 0 && rows[at - 1]!.kind === 'header') at -= 1
    return [...rows.slice(0, at), marker, ...rows.slice(at)]
  }
  return turn.rows.some(row => row.id === boundary) ? { ...turn, rows: among(turn.rows) } : { ...turn, after: among(turn.after ?? []) }
}
