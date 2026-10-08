/**
 * The painter and the editor adapter behind `prompt` nodes (roadmap slice 1.9b). The first row paints the symbol, the
 * tokens, and the buffer, with the recall position in the right corner; the placeholder is the longest variant that fits;
 * the completion list shows up to five rows. The buffer itself is the existing terminal editor (`createEditor`), so
 * kill ring, undo, paste folding, and input methods stay pi-tui's; this module only mirrors the draft into it and lays
 * its rows out beside the symbol and the tokens.
 *
 * @module @ephemeral-ai/mayfly/core/ui-prompt
 */
import { CURSOR_MARKER } from '@earendil-works/pi-tui'
import type { MayflyPromptNode } from '@ephemeral-ai/mayfly-ui'
import { glyphRows, type MayflyGlyphMode } from './glyphs.ts'
import type { MayflyComponents, MayflyEditor, MayflySemanticColors } from './types.ts'
import { paintTone } from './ui-paint.ts'
import { PROMPT_COMPLETION_ROWS, promptCompletionStart, promptCompletionsOpen, type UiPromptModel } from './ui-interaction-prompt.ts'

/** The text room a token strip leaves the buffer on the first row before it folds. */
const MIN_TEXT_ROOM = 8

/** The cells `+N ` takes in a folded token strip, for up to two digits. */
const FOLD_MARKER_ROOM = 5

type Measure = Pick<MayflyComponents, 'visibleWidth' | 'truncateToWidth'>

/** What the painter reads: the node, the draft state (absent outside an interactive surface), and the palette. */
export interface PromptPaint {
  readonly node: MayflyPromptNode
  /** The draft; a prompt outside an interactive surface paints `node.value` and offers no editing. */
  readonly model: UiPromptModel | undefined
  readonly width: number
  readonly focused: boolean
  readonly colors: MayflySemanticColors
  readonly components: Measure
  readonly glyphs: MayflyGlyphMode | undefined
  /** Core-owned words (`history`, `queued`), through the host catalog. */
  readonly translate: (key: string) => string
  /** The buffer's rows at a width, with the editor's cursor; called only when the buffer or a token is on show. */
  readonly buffer: (width: number) => string[]
}

const inverse = (text: string): string => `\x1b[7m${text}\x1b[0m`
const strong = (text: string): string => `\x1b[1m${text}\x1b[22m`

/**
 * The placeholder variants, longest first. An array is the caller's ladder; a string degrades by dropping its last
 * ` · ` segment, so a placeholder is never cut inside a trigger (`Ask anything · / commands · @ files` becomes
 * `Ask anything · / commands`, then `Ask anything`).
 */
export function placeholderLadder(placeholder: string | readonly string[] | undefined): readonly string[] {
  if (placeholder === undefined) return []
  if (typeof placeholder !== 'string') return placeholder
  const segments = placeholder.split(' · ')
  return segments.map((_, index) => segments.slice(0, segments.length - index).join(' · '))
}

/** The longest variant that fits `room` cells; the shortest, cut with an ellipsis, when none does. */
export function pickPlaceholder(ladder: readonly string[], room: number, components: Measure): string {
  const fits = ladder.find(variant => components.visibleWidth(variant) <= room)
  if (fits !== undefined) return fits
  const last = ladder.at(-1)
  return last === undefined || room <= 0 ? '' : components.truncateToWidth(last, room, '…')
}

/** One token as the row writes it: `[label size ×]`, the whole token inverse while it is selected. */
function paintToken(token: NonNullable<MayflyPromptNode['tokens']>[number], selected: boolean, colors: MayflySemanticColors): string {
  const size = token.size === undefined ? '' : ` ${token.size}`
  if (selected) return inverse(`[${token.label}${size} ×]`)
  return colors.muted('[') + colors.accent(token.label) + (token.size === undefined ? '' : colors.muted(size)) + colors.muted(' ×]')
}

/**
 * The token strip at a room: every token while they fit, else the newest ones that do behind a muted `+N`; the selected
 * token is always kept. Returns the painted strip and its width, trailing space included.
 */
export function paintTokenStrip(node: MayflyPromptNode, selectedId: string | undefined, room: number, colors: MayflySemanticColors, components: Measure): { readonly text: string, readonly width: number } {
  const tokens = node.tokens ?? []
  if (tokens.length === 0) return { text: '', width: 0 }
  const widths = tokens.map(token => components.visibleWidth(`[${token.label}${token.size === undefined ? '' : ` ${token.size}`} ×]`) + 1)
  const everything = widths.reduce((sum, width) => sum + width, 0)
  // Once any token folds, `+N ` takes a few cells of the room.
  const budget = everything <= room ? everything : room - FOLD_MARKER_ROOM
  const selected = tokens.findIndex(token => token.id === selectedId)
  const newest = tokens.map((_, index) => tokens.length - 1 - index).filter(index => index !== selected)
  const candidates = selected < 0 ? newest : [selected, ...newest]
  const kept = new Set<number>()
  let used = 0
  for (const index of candidates) {
    // The first token always shows, even in a room too small for it; the row clips it.
    if (kept.size > 0 && used + widths[index]! > budget) break
    kept.add(index)
    used += widths[index]!
  }
  const folded = tokens.length - kept.size
  const marker = folded === 0 ? '' : `${colors.muted(`+${String(folded)}`)} `
  const shown = tokens.flatMap((token, index) => kept.has(index) ? [paintToken(token, token.id === selectedId, colors)] : [])
  return { text: `${marker}${shown.join(' ')} `, width: used + (folded === 0 ? 0 : String(folded).length + 2) }
}

/** The right-corner recall marker, `↑ history 2/4`, painted muted. */
function recallCorner(paint: PromptPaint): { readonly text: string, readonly width: number } | undefined {
  const model = paint.model
  const entries = paint.node.recall ?? []
  const entry = model?.recall === undefined ? undefined : entries[model.recall.index]
  if (model?.recall === undefined || entry === undefined) return undefined
  const word = entry.kind === 'queued' ? paint.translate('queued') : paint.node.recallLabel ?? paint.translate('history')
  const plain = glyphRows([`↑ ${word} ${String(model.recall.index + 1)}/${String(entries.length)}`], paint.glyphs)[0]!
  return { text: paint.colors.muted(plain), width: paint.components.visibleWidth(plain) }
}

/** The caret of an empty buffer: the terminal's cursor marker over one inverse cell, as the editor draws its own. */
function caret(focused: boolean): string {
  return focused ? `${CURSOR_MARKER}${inverse(' ')}` : ''
}

/** The completion rows: `→ label — detail`, the focused row's label bold, an optional key at the right edge. */
function paintCompletions(paint: PromptPaint): string[] {
  const model = paint.model
  const items = paint.node.completions?.items ?? []
  if (model === undefined || !promptCompletionsOpen(model)) return []
  const start = promptCompletionStart(model)
  const c = paint.components
  return items.slice(start, start + PROMPT_COMPLETION_ROWS).map((item, offset) => {
    const focused = start + offset === model.completion.index
    const mark = focused ? paint.colors.primary(strong(glyphRows(['→'], paint.glyphs)[0]!)) : ' '
    const label = focused ? strong(paint.colors.text(item.label)) : paint.colors.text(item.label)
    const detail = item.detail === undefined ? '' : paint.colors.muted(` — ${item.detail}`)
    const left = `${mark} ${label}${detail}`
    const right = item.right === undefined ? '' : paint.colors.muted(item.right)
    const room = paint.width - c.visibleWidth(left) - c.visibleWidth(right)
    // The key sits at the edge when it fits behind two spaces; otherwise the row keeps its text.
    if (right !== '' && room >= 2) return `${left}${' '.repeat(room)}${right}`
    return c.visibleWidth(left) <= paint.width ? left : c.truncateToWidth(left, paint.width, '…')
  })
}

/**
 * The rows of one prompt at `paint.width`: the input row (symbol, tokens, buffer, recall corner), the buffer's later
 * rows under the symbol's indent, then the completion list. Chrome glyphs convert to the active glyph mode; the buffer
 * and the labels the user or the host wrote never do.
 */
export function paintPrompt(paint: PromptPaint): string[] {
  const { node, model, colors, components } = paint
  const width = Math.max(1, paint.width)
  const symbol = node.symbol ?? '> '
  const symbolWidth = components.visibleWidth(symbol)
  const head = node.symbolTone === undefined ? colors.text(symbol) : strong(paintTone(node.symbolTone, symbol, colors))
  const text = model?.text ?? node.value ?? ''
  const tokens = node.tokens ?? []
  const rows: string[] = []
  if (text === '' && tokens.length === 0) {
    const ladder = placeholderLadder(node.placeholder)
    // One cell for the caret and one to spare, as the design's ladder counts.
    const ghost = pickPlaceholder(ladder, width - symbolWidth - 2, components)
    rows.push(`${head}${caret(paint.focused)}${ghost === '' ? '' : colors.textMuted(ghost)}`)
  } else {
    const corner = recallCorner(paint)
    const reserve = corner === undefined ? 0 : corner.width + 1
    const strip = paintTokenStrip(node, model?.selectedToken, width - symbolWidth - reserve - MIN_TEXT_ROOM, colors, components)
    const room = Math.max(1, width - symbolWidth - strip.width - reserve)
    const buffer = model === undefined ? text.split('\n').map(line => components.truncateToWidth(line, room, '')) : paint.buffer(room)
    const first = components.truncateToWidth(buffer[0]!, room, '')
    const gap = ' '.repeat(Math.max(0, room - components.visibleWidth(first)))
    rows.push(`${head}${strip.text}${first}${corner === undefined ? '' : `${gap} ${corner.text}`}`)
    for (const row of buffer.slice(1)) rows.push(`${' '.repeat(symbolWidth)}${components.truncateToWidth(row, Math.max(1, width - symbolWidth), '')}`)
  }
  rows.push(...paintCompletions(paint))
  return rows
}

/**
 * The terminal editor behind one prompt. The surface model owns the draft; this mirrors it into the editor when the
 * model moves (a recall, a reset, a submit) and reports the editor's own edits back. Enter never reaches the editor, so
 * it cannot submit or clear itself, and a bracketed paste is tracked so a chunk of it is never read as a key.
 */
export class UiPromptEditor {
  private readonly editor: MayflyEditor
  private pasting = false
  private change: ((value: string) => void) | undefined

  constructor(components: Pick<MayflyComponents, 'createEditor'>) {
    this.editor = components.createEditor()
    this.editor.disableSubmit = true
    this.editor.onChange = () => { this.change?.(this.editor.getExpandedText()) }
  }

  /** Whether a bracketed paste has begun and not yet ended: its chunks are text whatever they spell. */
  get pending(): boolean { return this.pasting }

  /** Where the editor reports its edits; core passes the surface model. */
  onChange(listener: ((value: string) => void) | undefined): void { this.change = listener }

  /** Show the model's draft when the editor holds something else, without reporting it back as an edit. */
  sync(text: string): void {
    if (this.editor.getExpandedText() === text) return
    const listener = this.change
    this.change = undefined
    try { this.editor.setText(text) } finally { this.change = listener }
  }

  /** The buffer's rows at `width`, with the cursor while focused. */
  render(width: number, focused: boolean): string[] {
    this.editor.focused = focused
    return this.editor.renderContent(width)
  }

  handleInput(data: string): void {
    const begin = data.lastIndexOf('\x1b[200~')
    const end = data.lastIndexOf('\x1b[201~')
    if (begin >= 0 || end >= 0) this.pasting = begin > end
    this.editor.handleInput?.(data)
  }

  newline(): void { this.editor.insertText('\n') }

  invalidate(): void { this.editor.invalidate() }

  set focused(value: boolean) { this.editor.focused = value }

  /** Drop the editor's callbacks and buffer; the compiler calls it when the renderer lets the prompt go. */
  release(): void {
    this.editor.focused = false
    this.change = undefined
    this.pasting = false
    this.editor.onChange = undefined
    this.editor.setText('')
  }
}
