/**
 * The shared chrome helper layer (D25): pure `string[]` post-processing of
 * pi-tui's editor rows and the panel rules. Everything here is theme-agnostic
 * math — callers inject the paint function — so the module carries no pi-tui
 * component machinery and no lifecycle. The module is core-private; renderer
 * adapters use narrow `MayflyComponents` methods rather than importing its
 * algorithms. The algorithms are kimi-code ports kept ANSI-safe: visible
 * columns are located by stripping SGR runs, and styled cells are never
 * clobbered.
 *
 * @module mayfly-core/chrome
 */

import { sliceByColumn, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { mapRows } from './ui-rows.ts'
import { OVERFLOW_ELLIPSIS } from './width.ts'

// oxlint-disable-next-line no-control-regex -- ESC (\x1b) is required to match ANSI SGR escape sequences
const ANSI_SGR = /\x1b\[[0-9;]*m/g

/** Drop every SGR escape sequence, leaving only visible characters. */
function stripSgr(text: string): string {
  return text.replace(ANSI_SGR, '')
}

/**
 * Convert a visible-character index (ANSI-stripped) back into an index into
 * the raw ANSI-bearing string: a sticky-regex walk that skips SGR runs
 * without counting them.
 * @param line - the raw line, SGR escapes allowed.
 * @param visibleIdx - the index into `stripSgr(line)`.
 * @returns the corresponding index into `line`.
 */
function visibleIndexToRaw(line: string, visibleIdx: number): number {
  let visibleCount = 0
  let i = 0
  const re = new RegExp(ANSI_SGR.source, 'y')
  while (i < line.length && visibleCount < visibleIdx) {
    re.lastIndex = i
    const match = re.exec(line)
    if (match !== null && match.index === i) {
      i += match[0].length
    } else {
      visibleCount++
      i++
    }
  }
  return i
}

/**
 * Locate the leading `/command` token on a visible (SGR-stripped) line: the
 * `/` must be the first non-whitespace character (a mid-sentence slash is
 * prose, not a command) and the token ends at the next whitespace; a token
 * containing a second `/` is a path, not a command, and declines.
 * @param visible - the SGR-stripped line.
 * @returns the token's half-open visible range, or `null` when absent.
 */
function leadingSlashTokenRange(visible: string): { start: number, end: number } | null {
  const slashIdx = visible.indexOf('/')
  if (slashIdx < 0) return null
  for (let i = 0; i < slashIdx; i++) {
    if (visible[i] !== ' ' && visible[i] !== '\t') return null
  }
  let endVisible = slashIdx + 1
  while (endVisible < visible.length) {
    const ch = visible[endVisible]
    if (ch === ' ' || ch === '\t') break
    endVisible++
  }
  const visibleToken = visible.slice(slashIdx, endVisible)
  if (visibleToken.slice(1).includes('/')) return null
  return { start: slashIdx, end: endVisible }
}

/**
 * Paint the leading `/command` token of an editor content row (the kimi
 * `highlightFirstSlashToken` port). The row may already carry SGR escapes
 * (the inverse-video cursor), so the token is located through visible-index
 * math and the paint wraps the raw slice — ANSI pass-through survives.
 * @param line - the rendered editor content row.
 * @param paint - the token styling (bold + `primary` at the call site).
 * @returns the repainted row, or `undefined` when no leading slash token
 *   exists on the row.
 */
export function highlightLeadingSlashToken(
  line: string,
  paint: (text: string) => string,
): string | undefined {
  const visible = stripSgr(line)
  const range = leadingSlashTokenRange(visible)
  if (range === null) return undefined
  const rawStart = visibleIndexToRaw(line, range.start)
  const rawEnd = visibleIndexToRaw(line, range.end)
  return line.slice(0, rawStart) + paint(line.slice(rawStart, rawEnd)) + line.slice(rawEnd)
}

/** The editor's horizontal padding: its content rows are the prompt's buffer, so there is none. */
const EDITOR_PADDING = 0
/** pi-tui renders the end-of-input cursor as an inverse-video space. */
// oxlint-disable-next-line no-control-regex -- the cursor block is a raw SGR sequence
const CURSOR_BLOCK = '\x1b[7m \x1b[0m'

/**
 * Clip a ghost hint to `maxLen` display columns with an ellipsis. Column
 * truth comes from pi-tui, so a CJK or emoji hint never renders wider than
 * the row budget and a grapheme is never split.
 * @param hint - the hint text.
 * @param maxLen - the maximum visible column count.
 * @returns the clipped hint, or `''` when there is no room at all.
 */
function truncateHint(hint: string, maxLen: number): string {
  if (maxLen <= 0) return ''
  if (visibleWidth(hint) <= maxLen) return hint
  if (maxLen === 1) return '…'
  return `${sliceByColumn(hint, 0, maxLen - 1, true)}…`
}

/**
 * Splice a dimmed argument-hint ghost into an editor content row (the kimi
 * `injectArgumentHint` port). The ghost is purely visual: it lands after the
 * typed text — after the inverse-video cursor block when one is rendered —
 * and consumes the trailing padding, so the row width is preserved; a hint
 * that would overflow the content area is ellipsized instead. When the
 * cursor block sits before trailing non-padding text (cursor mid-text), the
 * row is returned unchanged: the ghost belongs at the end of the input.
 * @param line - the first content row of an editor render.
 * @param hint - the ghost text, already lead-spaced by the caller.
 * @param text - the real editor text; its display width reserves the room.
 * @param width - the full render width of the row.
 * @param paint - the ghost styling (`textMuted` at the call site).
 * @returns the row with the ghost spliced in, or the row unchanged when
 *   there is no room or the cursor is mid-text.
 */
export function injectGhostHint(
  line: string,
  hint: string,
  text: string,
  width: number,
  paint: (text: string) => string,
): string {
  const cursorIdx = line.indexOf(CURSOR_BLOCK)
  const cursorPresent = cursorIdx !== -1
  if (cursorPresent) {
    // Everything after the cursor block must be padding for the ghost to
    // belong here; otherwise the cursor is mid-text and the hint declines.
    if (stripSgr(line.slice(cursorIdx + CURSOR_BLOCK.length)).trim().length > 0) return line
  }
  const contentWidth = Math.max(1, width - EDITOR_PADDING * 2)
  const available = contentWidth - visibleWidth(text) - (cursorPresent ? 1 : 0)
  const trimmed = truncateHint(hint, available)
  if (trimmed === '') return line
  const insertAt = cursorPresent
    ? cursorIdx + CURSOR_BLOCK.length
    : visibleIndexToRaw(line, EDITOR_PADDING + [...text].length)
  const trailing = line.length - insertAt
  return line.slice(0, insertAt) + paint(trimmed) + ' '.repeat(Math.max(0, trailing - visibleWidth(trimmed)))
}

/**
 * Split pi-tui's editor rows into the content rows and the completion list. The editor renders a top rule, its content
 * rows, a bottom rule, and then the list while one is open. A rule row starts with `─` and does not end in a space; a
 * content row always does, because it is padded to the width with at least the cell of the cursor.
 * @param rows - the rows of a pi-tui editor render.
 * @returns the content rows between the rules, and the list rows after the bottom rule.
 */
export function splitEditorRows(rows: readonly string[]): { readonly content: string[], readonly list: string[] } {
  const isRule = (row: string): boolean => {
    const plain = stripSgr(row)
    return plain.startsWith('─') && !plain.endsWith(' ')
  }
  const bottom = rows.findIndex((row, index) => index > 0 && isRule(row))
  if (bottom < 0) return { content: rows.slice(1), list: [] }
  return { content: rows.slice(1, bottom), list: rows.slice(bottom + 1) }
}

const identity = (text: string): string => text

/** Options for {@link topRule}. */
interface TopRuleOptions {
  /** Title text rendered after the left corner, typically pre-styled (e.g. bold ` BTW `). */
  readonly title?: string
  /** Styling for the title; defaults to unstyled. */
  readonly titlePaint?: (text: string) => string
  /** Hint text rendered after the title and a `─ ` joiner, typically pre-styled. */
  readonly hint?: string
  /** Styling for the hint; defaults to unstyled. */
  readonly hintPaint?: (text: string) => string
  /** Styling for the corners, the joiner, and the dash fill; defaults to unstyled. */
  readonly paint?: (text: string) => string
}

/**
 * Render a panel's top border with an in-border title — the kimi
 * `╭ BTW ─ Esc close ────╮` row. The joiner `─ ` appears only when both a
 * title and a hint are present; the composite title+hint is clipped
 * ANSI-safe (styled text is never cut mid-SGR) with the dash fill taking the
 * remainder of the inner width. Callers guard `width >= 4` before invoking.
 * @param width - the full render width of the panel row.
 * @param options - the title, hint, and their paints.
 * @returns the single top-border row.
 */
export function topRule(width: number, options: TopRuleOptions = {}): string {
  const paint = options.paint ?? identity
  const innerWidth = Math.max(1, width - 2)
  const title = options.title
  const hint = options.hint
  const composite =
    title !== undefined && hint !== undefined
      ? `${(options.titlePaint ?? identity)(title)}${paint('─ ')}${(options.hintPaint ?? identity)(hint)}`
      : title !== undefined
        ? (options.titlePaint ?? identity)(title)
        : hint !== undefined
          ? (options.hintPaint ?? identity)(hint)
          : ''
  const clipped =
    composite === ''
      ? ''
      : visibleWidth(composite) > innerWidth
        ? truncateToWidth(composite, innerWidth, OVERFLOW_ELLIPSIS)
        : composite
  return paint('╭') + clipped + paint('─'.repeat(Math.max(0, innerWidth - visibleWidth(clipped)))) + paint('╮')
}

/**
 * Indent a block of rendered rows by a column gutter: every row gains `n`
 * literal leading spaces, which the side-border post-processing overlays its
 * bars onto only at content rows' outermost literal spaces. The pure-function
 * equivalent of kimi's `GutterContainer(1)` — S13 lands the helper and
 * measures a real terminal before deciding whether any consumer enables it.
 * @param lines - the block's rendered rows.
 * @param n - the gutter width in columns.
 * @returns the indented rows, styling untouched.
 */
export function padColumns(lines: readonly string[], n: number): string[] {
  return mapRows(lines, line => ' '.repeat(n) + line)
}

/**
 * The component-level width backstop (D48): every hand-assembled row —
 * bullet plus wrapped text, indent plus content — passes through the
 * display-width-aware truncate before it leaves `render`. Rows that already
 * fit come back untouched (the truncate fast path), so the cost on healthy
 * widths is one width measurement per row; at degenerate widths (a resize
 * drag crossing two or three columns) the row is cut instead of tripping
 * pi-tui's width guard. The render-exit clamp in terminal.ts is the frame
 * backstop behind this one; a clamped row is still a component bug.
 * @param rows - the assembled rows.
 * @param width - the viewport width the rows were rendered for.
 * @param truncate - the components service's `truncateToWidth`.
 * @returns rows whose visible width never exceeds `width`.
 */
export function clampRowsToWidth(
  rows: readonly string[],
  width: number,
  truncate: (text: string, width: number) => string,
): string[] {
  return mapRows(rows, row => truncate(row, width))
}
