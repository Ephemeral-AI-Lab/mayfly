/**
 * The editor's inline tokens: a pasted block (`[paste #1 +12 lines]`), a pasted image (`[image #1 84 KB]`), and an
 * accepted `@` mention (`@packages/a.ts`) stay ordinary text in the buffer and show as tokens. This module is pure
 * string work with no pi-tui machinery: it finds the token spans of a buffer line, gives each character its tone, and
 * repaints the rows the editor rendered, which carry SGR escapes (the cursor) and wrap a token across two rows when it
 * meets the right edge. A token is selected with the first Backspace and removed by the second (the adapter owns that
 * state).
 *
 * @module mayfly-core/editor-tokens
 */

import { terminalSequenceAt } from './escape-sequences.ts'
import type { MayflyEditorTokenSpan } from './types.ts'

/** A pasted block's marker: pi-tui writes it and treats it as one unit while its id is in the paste table. */
const PASTE_MARKER = /\[paste #(\d+)(?: (?:\+\d+ lines|\d+ chars))?\]/gu

/** The tokens' kinds: the two interaction-owned ones plus pi-tui's own pasted block. */
export type EditorTokenKind = MayflyEditorTokenSpan['kind'] | 'paste'

/**
 * The text a buffer with pasted-block markers stands for: each marker whose id is in the table becomes its content.
 * @param raw - the buffer text with its `[paste #N …]` markers.
 * @param pastes - the paste table.
 * @returns the expanded text.
 */
export function expandPastes(raw: string, pastes: ReadonlyMap<number, string>): string {
  return raw.replace(PASTE_MARKER, (marker, id: string) => pastes.get(Number(id)) ?? marker)
}

/** One token of a buffer line, half-open in UTF-16 units. */
export interface EditorTokenRange {
  readonly start: number
  readonly end: number
  readonly kind: EditorTokenKind
}

/** One token of the buffer as the painter needs it: its text and kind. */
export interface EditorTokenText {
  readonly text: string
  readonly kind: EditorTokenKind
}

/** The two tones a token is written in; a selected token is inverse whatever its tone. */
export interface EditorTokenPaints {
  /** The label (`image #1`, `paste #2`) and a mention's path. */
  readonly label: (text: string) => string
  /** The brackets and the size. */
  readonly detail: (text: string) => string
}

/** One stretch of a text: plain, or the content of a pasted block that a marker can stand for. */
export type FoldSegment = { readonly paste: false, readonly text: string } | { readonly paste: true, readonly text: string }

/**
 * Cut a text around the places where a pasted block's content appears, in text order: the editor folds each such
 * stretch back into a marker. Each content is used once, and a stretch another one overlaps is left plain.
 * @param text - the text as an external editor returned it.
 * @param contents - the contents of the pasted blocks that were in the buffer before.
 * @returns the plain and paste segments that spell the text again.
 */
export function foldSegments(text: string, contents: readonly string[]): FoldSegment[] {
  const hits: Array<{ start: number, end: number }> = []
  for (const content of contents) {
    if (content.length === 0) continue
    for (let from = 0; ; from += 1) {
      const start = text.indexOf(content, from)
      if (start < 0) break
      const end = start + content.length
      if (!hits.some(hit => start < hit.end && end > hit.start)) {
        hits.push({ start, end })
        break
      }
      from = start
    }
  }
  hits.sort((a, b) => a.start - b.start)
  const segments: FoldSegment[] = []
  let at = 0
  for (const hit of hits) {
    if (hit.start > at) segments.push({ paste: false, text: text.slice(at, hit.start) })
    segments.push({ paste: true, text: text.slice(hit.start, hit.end) })
    at = hit.end
  }
  if (at < text.length) segments.push({ paste: false, text: text.slice(at) })
  return segments
}

/**
 * The tokens of one buffer line in order. Paste markers count only while their id is in the paste table (as for
 * pi-tui); the source's spans are taken as given, and a span that overlaps an earlier one is dropped.
 * @param line - the buffer line.
 * @param pasteIds - the ids in the editor's paste table.
 * @param source - the interaction-owned token spans of the line, if any.
 * @returns the ranges, sorted by start.
 */
export function findTokenRanges(line: string, pasteIds: ReadonlySet<number>, source: readonly MayflyEditorTokenSpan[] = []): EditorTokenRange[] {
  const found: EditorTokenRange[] = source.map(span => ({ start: span.start, end: span.end, kind: span.kind }))
  if (pasteIds.size > 0 && line.includes('[paste #')) {
    for (const match of line.matchAll(PASTE_MARKER)) {
      if (pasteIds.has(Number(match[1]))) found.push({ start: match.index, end: match.index + match[0].length, kind: 'paste' })
    }
  }
  found.sort((a, b) => a.start - b.start)
  const kept: EditorTokenRange[] = []
  for (const range of found) {
    if (range.end > range.start && (kept.length === 0 || range.start >= kept[kept.length - 1]!.end)) kept.push(range)
  }
  return kept
}

/** The index in a token's text where its label ends: the brackets and the size around it are detail. */
function labelEnd(token: EditorTokenText): number {
  if (token.kind === 'mention') return token.text.length
  // `[image #12 84 KB]`: the brackets and the size are detail, `image #12` is the label.
  const match = /^\[([a-z]+ #\d+)/u.exec(token.text)
  return match === null ? token.text.length : 1 + match[1]!.length
}

/** The tone of the character at `index` of a token's text. */
function toneOf(token: EditorTokenText, index: number): 'label' | 'detail' {
  if (token.kind === 'mention') return 'label'
  return index >= 1 && index < labelEnd(token) ? 'label' : 'detail'
}

/** One piece of a token on one row: where it sits in the row's visible text and in the token's text. */
interface Piece {
  readonly row: number
  readonly start: number
  readonly end: number
  /** Index into the token list. */
  readonly token: number
  /** The index in the token's text where this piece starts. */
  readonly offset: number
  /** The same occurrence continues on another row; both pieces share one group. */
  readonly group: number
}

/** A row's visible text with the raw index of every visible character, and whether the cursor marker is in it. */
interface RowText {
  readonly plain: string
  readonly raw: readonly number[]
}

/** Split a rendered row into its visible characters and the raw index each came from. */
function readRow(row: string): RowText {
  const raw: number[] = []
  let plain = ''
  let at = 0
  while (at < row.length) {
    const sequence = row.charCodeAt(at) === 0x1b || row.charCodeAt(at) >= 0x80 ? terminalSequenceAt(row, at) : undefined
    if (sequence !== undefined) {
      at += sequence.length
      continue
    }
    raw.push(at)
    plain += row[at]!
    at += 1
  }
  return { plain, raw }
}

/** The pieces of one token on the rows: every whole occurrence, and each occurrence the wrap split across rows. */
function pieceOccurrences(tokenIndex: number, token: EditorTokenText, rows: readonly RowText[], groups: { next: number }): Piece[] {
  const text = token.text
  const pieces: Piece[] = []
  rows.forEach((row, index) => {
    for (let from = row.plain.indexOf(text); from >= 0; from = row.plain.indexOf(text, from + text.length)) {
      pieces.push({ row: index, start: from, end: from + text.length, token: tokenIndex, offset: 0, group: groups.next++ })
    }
    // A token cut at the right edge: its head ends this row and the rest starts the next (the wrap drops the break's space).
    const trimmed = row.plain.trimEnd()
    for (let k = Math.min(text.length - 1, trimmed.length); k >= 2; k -= 1) {
      if (text[k - 1] === ' ' || !trimmed.endsWith(text.slice(0, k))) continue
      const rest = followingPieces(index, text, k, rows)
      if (rest === undefined) continue
      const group = groups.next++
      pieces.push({ row: index, start: trimmed.length - k, end: trimmed.length, token: tokenIndex, offset: 0, group })
      for (const piece of rest) pieces.push({ ...piece, token: tokenIndex, group })
      break
    }
  })
  return pieces
}

/** The rows after `index` that carry the rest of `text` from `from`, or `undefined` when they do not spell it. */
function followingPieces(index: number, text: string, from: number, rows: readonly RowText[]): Array<Omit<Piece, 'token' | 'group'>> | undefined {
  const pieces: Array<Omit<Piece, 'token' | 'group'>> = []
  let done = from
  for (let next = index + 1; next < rows.length && done < text.length; next += 1) {
    const plain = rows[next]!.plain
    // The wrap drops the space it breaks at.
    const rest = text.slice(done).replace(/^ /u, '')
    const skipped = text.length - done - rest.length
    if (plain.startsWith(rest)) {
      pieces.push({ row: next, start: 0, end: rest.length, offset: done + skipped })
      return pieces
    }
    const trimmed = plain.trimEnd()
    if (trimmed.length === 0 || !rest.startsWith(trimmed)) return undefined
    pieces.push({ row: next, start: 0, end: trimmed.length, offset: done + skipped })
    done += skipped + trimmed.length
  }
  return undefined
}

/**
 * Repaint the tokens in rendered editor rows. Rows keep their width: only the style of characters changes.
 * @param rows - the editor's rendered content rows, escapes and cursor included.
 * @param tokens - the tokens of the buffer, in buffer order.
 * @param selected - the index of the selected token, drawn inverse, or `undefined`.
 * @param paints - the tones.
 * @param cursor - the marker pi-tui puts at the cursor; the selected occurrence is the one on the cursor's row.
 * @returns the repainted rows.
 */
export function paintTokenRows(rows: readonly string[], tokens: readonly EditorTokenText[], selected: number | undefined, paints: EditorTokenPaints, cursor: string): string[] {
  if (tokens.length === 0 || rows.length === 0) return [...rows]
  const read = rows.map(readRow)
  const unique = new Map<string, number>()
  tokens.forEach((token, index) => { if (!unique.has(token.text)) unique.set(token.text, index) })
  const groups = { next: 0 }
  const pieces = [...unique.values()].flatMap(index => pieceOccurrences(index, tokens[index]!, read, groups))
  if (pieces.length === 0) return [...rows]
  // Of several occurrences of the selected token, the one on the cursor's row is selected, else the last.
  const wanted = selected === undefined ? undefined : unique.get(tokens[selected]!.text)
  let chosen: number | undefined
  if (wanted !== undefined) {
    const own = pieces.filter(piece => piece.token === wanted)
    const onCursor = own.find(piece => rows[piece.row]!.includes(cursor))
    chosen = (onCursor ?? own.at(-1))?.group
  }
  return rows.map((row, index) => {
    const here = pieces.filter(piece => piece.row === index).sort((a, b) => a.start - b.start)
    if (here.length === 0) return row
    return paintPieces(row, read[index]!, here, tokens, chosen, paints)
  })
}

/** One row with its pieces repainted. */
function paintPieces(row: string, text: RowText, pieces: readonly Piece[], tokens: readonly EditorTokenText[], chosen: number | undefined, paints: EditorTokenPaints): string {
  let out = ''
  let at = 0
  for (const piece of pieces) {
    if (piece.start < 0 || piece.end > text.raw.length || piece.start < countVisible(text, at)) continue
    const rawStart = text.raw[piece.start]!
    out += row.slice(at, rawStart)
    out += paintRange(row, text, piece, tokens[piece.token]!, piece.group === chosen, paints)
    at = text.raw[piece.end - 1]! + 1
  }
  return out + row.slice(at)
}

/** How many visible characters precede raw index `at`. */
function countVisible(text: RowText, at: number): number {
  let low = 0
  let high = text.raw.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (text.raw[mid]! < at) low = mid + 1
    else high = mid
  }
  return low
}

/** The raw text of one piece with each run of same-toned characters wrapped in its paint, escapes left in place. */
function paintRange(row: string, text: RowText, piece: Piece, token: EditorTokenText, selected: boolean, paints: EditorTokenPaints): string {
  let out = ''
  let run = ''
  let tone: 'label' | 'detail' | undefined
  const flush = (): void => {
    if (run === '') return
    out += selected ? `\x1b[7m${run}\x1b[27m` : (tone === 'label' ? paints.label(run) : paints.detail(run))
    run = ''
  }
  const end = text.raw[piece.end - 1]! + 1
  let at = text.raw[piece.start]!
  let visible = piece.start
  while (at < end) {
    if (text.raw[visible] !== at) {
      // An escape sequence between two visible characters: it ends the run so the paint never wraps it.
      flush()
      const sequence = terminalSequenceAt(row, at)
      const length = sequence?.length ?? 1
      out += row.slice(at, at + length)
      at += length
      continue
    }
    const next = toneOf(token, piece.offset + (visible - piece.start))
    if (next !== tone) {
      flush()
      tone = next
    }
    run += row[at]!
    at += 1
    visible += 1
  }
  flush()
  return out
}
