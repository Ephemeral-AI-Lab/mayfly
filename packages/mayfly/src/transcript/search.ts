/**
 * The stream search: which places of a session match a pattern, in the order the stream shows them: every occurrence is a stop. A part is one entry, or
 * one call of a group entry, and is searched by the text a person reads (`row-text.ts`), so a detail a level hides is
 * found too. The pattern is a regular expression, case-insensitive unless it holds a capital letter (smart case). The
 * search reaches every turn of the model, whether or not the stream mounts it. It runs on demand, per pattern and per
 * model, and holds nothing.
 * @module
 */
import type { TranscriptEntryModel, TranscriptModel } from '../frontend/models.ts'
import { partText, type RowPart } from './row-text.ts'

/** The most matches one part contributes: a part of a few thousand lines cannot make a search of a million stops. */
const MAX_PER_PART = 500

/** One match of the pattern: the `nth` (from 0) inside one part. */
export interface SearchHit {
  /** The entry id, or the call id (`<entry>:<call>`) the stream's owner index knows. */
  readonly part: string
  readonly turn: number
  /** Where the part stands among every searched part, oldest first. */
  readonly order: number
  /** Which match of the part this is, counted from 0. */
  readonly nth: number
}

/** What a search found. */
export interface SearchResult {
  /** The hits, oldest first. */
  readonly hits: readonly SearchHit[]
  /** The order of the first searched part of each turn, for a cursor on a row that holds no part (a header). */
  readonly turnStart: ReadonlyMap<number, number>
  /** The order of every searched part, by id. */
  readonly orders: ReadonlyMap<string, number>
}

/** A pattern as the search reads it: its expression for the matching, and the case rule the painter repeats. */
export type SearchPattern = { readonly kind: 'empty' } | { readonly kind: 'invalid' } | { readonly kind: 'ok', readonly regex: RegExp, readonly caseSensitive: boolean }

/**
 * Read a pattern: a JavaScript regular expression, matched in any case unless it holds a capital letter.
 * @param pattern - what the reader typed.
 */
export function readPattern(pattern: string): SearchPattern {
  if (pattern === '') return { kind: 'empty' }
  const caseSensitive = /[A-Z]/u.test(pattern)
  try {
    return { kind: 'ok', regex: new RegExp(pattern, caseSensitive ? 'u' : 'iu'), caseSensitive }
  } catch {
    return { kind: 'invalid' }
  }
}

type Entry = TranscriptModel['entries'][number]

function isSemantic(entry: Entry): entry is TranscriptEntryModel {
  return entry.kind.startsWith('transcript-')
}

function partsOf(entry: TranscriptEntryModel): readonly (RowPart & { readonly id: string })[] {
  switch (entry.kind) {
    case 'transcript-read-group': return entry.reads.map(call => ({ id: `${entry.id}:${call.callId}`, entry, call }))
    case 'transcript-search-group': return entry.searches.map(call => ({ id: `${entry.id}:${call.callId}`, entry, call }))
    case 'transcript-command-group': return entry.commands.map(call => ({ id: `${entry.id}:${call.callId}`, entry, call }))
    default: return [{ id: entry.id, entry }]
  }
}

/**
 * Every match of a pattern in a model, one per occurrence, in the order the stream shows them.
 * @param model - the displayed conversation.
 * @param pattern - the pattern, from {@link readPattern}; anything but `ok` finds nothing.
 */
export function findHits(model: TranscriptModel, pattern: SearchPattern): SearchResult {
  const hits: SearchHit[] = []
  const global = pattern.kind === 'ok' ? new RegExp(pattern.regex.source, `${pattern.regex.flags}g`) : undefined
  const turnStart = new Map<number, number>()
  const orders = new Map<string, number>()
  let order = 0
  for (const entry of [...model.entries, ...(model.live?.entries ?? [])]) {
    if (!isSemantic(entry)) continue
    for (const part of partsOf(entry)) {
      if (!turnStart.has(entry.turn)) turnStart.set(entry.turn, order)
      orders.set(part.id, order)
      if (global !== undefined) {
        const text = partText(part, 'text')
        global.lastIndex = 0
        let nth = 0
        for (let match = global.exec(text); match !== null && nth < MAX_PER_PART; match = global.exec(text)) {
          // A match with no width marks nothing; the search steps past it.
          if (match[0].length === 0) {
            global.lastIndex += 1
            continue
          }
          hits.push({ part: part.id, turn: entry.turn, order, nth })
          nth += 1
        }
      }
      order += 1
    }
  }
  return { hits, turnStart, orders }
}
