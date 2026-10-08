/**
 * The form field painter (roadmap slice 1.6): one row per field in the kit's layout, a mark column (`→` focused, `•`
 * edited), the labels aligned across the form, the value in its kind's reading, a muted `(inherited)` or `(override)`,
 * and under the field its error, its help while it holds focus, and the completions of an edit. A textarea that holds
 * focus opens a box. Heading rules between groups are drawn by {@link formHeading}.
 *
 * @module @ephemeral-ai/mayfly/core/ui-form-paint
 */

import type { MayflyFormField } from '@ephemeral-ai/mayfly-ui'
import type { MayflySemanticColors } from './types.ts'
import type { PatternFocus } from './ui-patterns.ts'
import { sliceByColumn, truncateToWidth, visibleWidth } from './width.ts'

/** What the draft adds to a field's own node: the pieces of its reading the node cannot know. */
export interface FieldDecor {
  /** The value differs from the field's default: the `•` mark and the `(override)` note. */
  readonly edited?: boolean
  /** Which of the two notes an origin field carries; absent for a field without an origin. */
  readonly origin?: 'inherited' | 'override'
  /** A secret whose stored value is untouched reads `(saved)`. */
  readonly saved?: boolean
  /** A number's text as typed, which may not be a number yet. */
  readonly draft?: string
}

export interface FormFieldPaint {
  readonly field: MayflyFormField
  readonly decor: FieldDecor
  readonly width: number
  readonly focus: PatternFocus
  readonly colors: MayflySemanticColors
  readonly text: (key: string) => string
  /** The widest label of the form, in cells; every label pads to the same column. */
  readonly labelWidth: number
  /** The editor's rows while a text field is being edited: the text with its cursor. */
  readonly editing?: readonly string[]
  /** The completions offered under a field being edited. */
  readonly suggestions?: readonly string[]
}

/** The widest a heading rule and a textarea box grow. */
const HEADING_WIDTH = 44
const BOX_WIDTH = 42
/** A textarea box shows at least this many rows. */
const BOX_ROWS = 3
/** A box that holds focus without being edited shows at most this many rows of the value. */
const BOX_PREVIEW_ROWS = 12
/** The help line is the first thing a narrow form drops: below this many columns it is not drawn. */
const HELP_MIN_WIDTH = 40
/** The most completions listed under a field. */
const SUGGESTION_ROWS = 3
/** The most bullets a saved secret draws. */
const SECRET_BULLETS = 10
/** A row is cut with an ellipsis only from this width up; narrower rows keep their first cells. */
const ELLIPSIS_MIN_WIDTH = 8
/** A value narrower than this many cells moves under its label. */
const MIN_VALUE_CELLS = 12

const safe = (width: number): number => Math.max(1, Number.isFinite(width) ? Math.floor(width) : 1)
/** Fits a row, painted or not, to a width: cut with `…` where there is room for one, and cut short below that (the mark column survives). */
const clip = (value: string, width: number): string => {
  if (visibleWidth(value) <= width) return value
  if (width < ELLIPSIS_MIN_WIDTH) return sliceByColumn(value, 0, Math.max(1, width), true)
  return truncateToWidth(value, width, '…').replace(/(?:\x1b\[0m)+$/u, '')
}

/** The cells the editor of a text field gets: the value column, or the whole row under a stacked label, or the textarea box. */
export function editorWidth(field: MayflyFormField, width: number, labelWidth: number): number {
  const available = safe(width)
  if (field.kind === 'textarea') return Math.max(1, Math.max(2, Math.min(BOX_WIDTH, available - 6)) - 1)
  const valueColumn = labelWidth + 4
  return available - valueColumn < Math.min(MIN_VALUE_CELLS, available) ? Math.max(1, available - 4) : available - valueColumn
}

/** The widest label of a form, in cells. */
export function formLabelWidth(fields: readonly MayflyFormField[]): number {
  return fields.reduce((widest, field) => Math.max(widest, visibleWidth(field.label)), 0)
}

/** The rule above the first field of a group: `── Group ──────`, at most 44 cells wide. */
export function formHeading(group: string, width: number, colors: MayflySemanticColors): string {
  const rule = '─'.repeat(Math.max(2, Math.min(safe(width), HEADING_WIDTH) - visibleWidth(group) - 4))
  return clip(colors.muted(`── ${group} ${rule}`), safe(width))
}

/** The completions of a typed value: the suggestions it is the start of. */
export function matchingSuggestions(suggestions: readonly string[] | undefined, value: string): readonly string[] {
  return suggestions?.filter(suggestion => suggestion.startsWith(value) && suggestion !== value) ?? []
}

/** The unit and the range a number shows beside a focused value. */
function numberRange(field: Extract<MayflyFormField, { readonly kind: 'number' }>): string {
  if (field.min !== undefined && field.max !== undefined) return `${String(field.min)}–${String(field.max)}`
  if (field.min !== undefined) return `≥ ${String(field.min)}`
  if (field.max !== undefined) return `≤ ${String(field.max)}`
  return ''
}

/** The field's value as the row reads it: the painted text, and whether it is a placeholder-like muted reading. */
function valueText(paint: FormFieldPaint, focused: boolean): string {
  const { field, text, decor } = paint
  // A disabled field is muted whole.
  const colors = field.disabled === true ? { text: paint.colors.muted, primary: paint.colors.muted, muted: paint.colors.muted } : paint.colors
  switch (field.kind) {
    case 'toggle': return field.value ? colors.primary('[on]') : colors.muted('[off]')
    case 'select': {
      const label = field.value === null ? undefined : field.options.find(option => option.id === field.value)?.label ?? field.value
      const cycles = focused && field.options.filter(option => option.disabled !== true).length > (field.value === null ? 0 : 1)
      if (cycles) return colors.primary(`‹ ${label ?? text('Choose…')} ›`)
      return label === undefined ? colors.muted(text('Choose…')) : colors.text(label)
    }
    case 'multiselect': {
      const chosen = field.options.filter(option => field.value.includes(option.id)).map(option => option.label)
      return chosen.length === 0 ? colors.muted(text('None selected')) : colors.text(chosen.join(', '))
    }
    case 'number': {
      const unit = field.unit === undefined ? '' : ` ${field.unit}`
      const shown = decor.draft ?? (field.value === null ? '' : String(field.value))
      if (!focused) return shown === '' ? '' : colors.text(`${shown}${unit}`)
      const range = numberRange(field)
      return `${colors.primary(`‹ ${shown} ›`)}${unit === '' ? '' : colors.text(unit)}${range === '' ? '' : colors.muted(`  ${range}`)}`
    }
    case 'secret': {
      if (field.value.length === 0) return colors.muted(field.placeholder ?? text('not set'))
      const bullets = colors.text('•'.repeat(Math.min(SECRET_BULLETS, Array.from(field.value).length)))
      return decor.saved === true ? `${bullets}${colors.muted(` (${text('saved')})`)}` : bullets
    }
    case 'textarea': {
      const first = field.value.split('\n', 1)[0]!
      return `${first === '' ? colors.muted(text('empty')) : colors.text(first)}${field.value.includes('\n') ? colors.muted(' …') : ''}`
    }
    default: return field.value.length === 0 ? colors.muted(field.placeholder ?? '') : colors.text(field.value)
  }
}

/** The box a focused textarea opens: its lines in a muted frame, at least three rows tall. */
function textareaBox(paint: FormFieldPaint, width: number, value: string): string[] {
  const { colors } = paint
  const inner = Math.max(2, Math.min(BOX_WIDTH, width - 6))
  const lines = paint.editing !== undefined ? [...paint.editing] : value.split('\n')
  const shown = paint.editing === undefined && lines.length > BOX_PREVIEW_ROWS ? [...lines.slice(0, BOX_PREVIEW_ROWS - 1), '…'] : lines
  const bar = colors.muted('│')
  const body = Array.from({ length: Math.max(BOX_ROWS, shown.length) }, (_, index) => {
    const line = clip(shown[index] ?? '', inner - 1)
    return `    ${bar} ${line}${' '.repeat(Math.max(0, inner - 1 - visibleWidth(line)))}${bar}`
  })
  return [`    ${colors.muted(`┌${'─'.repeat(inner)}┐`)}`, ...body, `    ${colors.muted(`└${'─'.repeat(inner)}┘`)}`]
}

/**
 * The rows of one field. A field that is being edited takes the editor's rows (`editing`), so the cursor and the wrap are
 * the editor's; every other reading is drawn here.
 */
export function paintFormField(paint: FormFieldPaint): string[] {
  const { field, decor, colors, focus } = paint
  const width = safe(paint.width)
  const focused = focus.focused && focus.key === field.id && field.disabled !== true
  const choice = field.kind === 'select' || field.kind === 'multiselect' ? field : undefined
  const picking = focused && focus.editing === true && choice !== undefined && choice.options.length > 0
  const editingText = paint.editing !== undefined && field.kind !== 'select' && field.kind !== 'multiselect' && field.kind !== 'toggle'
  const mark = focused ? colors.primary('→') : decor.edited === true && field.disabled !== true ? colors.primary('•') : ' '
  const lead = `${mark}${focused ? focus.marker : ' '}`
  const labelColumn = paint.labelWidth + 2
  const valueColumn = 2 + labelColumn
  const label = `${field.label}:`
  const stacked = width - valueColumn < Math.min(MIN_VALUE_CELLS, width)
  const origin = decor.origin === undefined ? '' : colors.muted(`  (${decor.origin === 'inherited' ? paint.text('inherited') : paint.text('override')})`)
  const rows: string[] = []

  const labelText = (padded: boolean): string => {
    const cells = padded ? `${label}${' '.repeat(Math.max(1, labelColumn - visibleWidth(label)))}` : label
    return field.disabled === true ? colors.muted(cells) : focused ? `\x1b[1m${colors.text(cells)}\x1b[22m` : colors.text(cells)
  }

  if (field.kind === 'textarea' && (focused || editingText)) {
    // The box carries the value, so the label stands alone above it.
    rows.push(clip(`${lead}${labelText(true)}${origin}`, width))
    rows.push(...textareaBox(paint, width, field.value).map(row => clip(row, width)))
  } else if (picking) {
    // An open picker shows the label alone; the option rows carry the value, the arrow standing under the help's indent.
    rows.push(clip(`${lead}\x1b[1m${colors.text(field.label)}\x1b[22m`, width))
    const options = choice!.options
    for (const option of options) {
      const selected = choice!.kind === 'select' ? choice!.value === option.id : choice!.value.includes(option.id)
      const current = choice!.kind === 'select' ? choice!.value : choice!.value[0]
      const active = (focus.optionId ?? current ?? options[0]?.id) === option.id
      const arrow = active ? colors.primary('→') : ' '
      const reason = option.disabledReason === undefined ? '' : ` — ${option.disabledReason}`
      const body = option.disabled === true ? colors.muted(`○ ${option.label}${reason}`)
        : `${selected ? colors.primary('●') : colors.muted('○')} ${colors.text(option.label)}`
      rows.push(clip(`    ${arrow} ${body}`, width))
    }
  } else {
    const value = editingText ? paint.editing![0]! : valueText(paint, focused)
    const extra = editingText ? paint.editing!.slice(1) : []
    if (stacked) {
      rows.push(clip(`${lead}${labelText(false)}${origin}`, width))
      rows.push(...[value, ...extra].map(row => clip(`    ${row}`, width)))
    } else {
      const room = width - valueColumn
      const painted = editingText ? value : visibleWidth(value) > room ? clip(value, room) : value
      rows.push(clip(`${lead}${labelText(true)}${painted}${origin}`, width))
      rows.push(...extra.map(row => clip(`${' '.repeat(valueColumn)}${row}`, width)))
    }
  }

  if (field.error !== undefined) rows.push(clip(`    ${colors.error(`! ${field.error}`)}`, width))
  if (focused && field.help !== undefined && !picking && width >= HELP_MIN_WIDTH) rows.push(clip(`    ${colors.muted(clip(field.help, Math.max(1, width - 4)))}`, width))
  if (editingText && paint.suggestions !== undefined) {
    paint.suggestions.slice(0, SUGGESTION_ROWS).forEach((suggestion, index) => rows.push(clip(`    ${colors.muted(`${index === 0 ? '⇥' : ' '} ${suggestion}`)}`, width)))
  }
  return rows
}
