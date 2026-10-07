/**
 * Admission rules for the optional fields of slice 1.3 (content, layout, and motion). The validator hands this module
 * its primitives, so each rule reads like the ones beside it and the arms in `ui-validator.ts` stay one call each.
 *
 * @module @ephemeral-ai/mayfly/core/ui-validator-content
 */

import type { MayflyInlineSpan, MayflyProgressNode, MayflyTextStyle, MayflyTone } from '@ephemeral-ai/mayfly-ui'

/** The validator's field primitives, generic over its private state. */
export interface AdmissionHelpers<State> {
  own(object: Record<string, unknown>, key: string, path: string): unknown
  invalid(message: string): never
  enumeration<Value extends string | number>(value: unknown, values: readonly Value[], path: string): Value
  finiteInteger(value: unknown, path: string, minimum?: number): number
  boolean(value: unknown, path: string): boolean
  text(value: unknown, path: string, state: State): string
  collection(value: unknown, path: string): readonly unknown[]
}

type Fields = Record<string, unknown>

const TONES = ['default', 'muted', 'primary', 'accent', 'user', 'success', 'warning', 'danger'] as const

/** The tallest scroll viewport, in rows. */
export const SCROLL_HEIGHT_MAX = 500

/** The widest progress bar, in cells. */
export const PROGRESS_WIDTH_MAX = 200

/** The longest progress transition, in milliseconds. */
export const PROGRESS_TRANSITION_MAX_MS = 60_000

function present<Value>(key: string, value: Value | undefined): Fields {
  return value === undefined ? {} : { [key]: value }
}

function flag<State>(h: AdmissionHelpers<State>, object: Fields, key: string, path: string): boolean | undefined {
  const value = h.own(object, key, path)
  return value === undefined ? undefined : h.boolean(value, `${path}.${key}`)
}

function integer<State>(h: AdmissionHelpers<State>, object: Fields, key: string, path: string, minimum: number, maximum: number): number | undefined {
  const value = h.own(object, key, path)
  if (value === undefined) return undefined
  const result = h.finiteInteger(value, `${path}.${key}`, minimum)
  if (result > maximum) h.invalid(`${path}.${key} must be at most ${String(maximum)}`)
  return result
}

/** A text node's `styles`: each of strong, italic, and strike at most once. */
export function admitTextStyles<State>(h: AdmissionHelpers<State>, object: Fields, path: string): Fields {
  const value = h.own(object, 'styles', path)
  if (value === undefined) return {}
  const styles = h.collection(value, `${path}.styles`).map((style, index) => h.enumeration<MayflyTextStyle>(style, ['strong', 'italic', 'strike'], `${path}.styles[${String(index)}]`))
  if (new Set(styles).size !== styles.length) h.invalid(`${path}.styles contains duplicates`)
  return { styles }
}

/** A code node's `numbered`. */
export function admitCodeFields<State>(h: AdmissionHelpers<State>, object: Fields, path: string): Fields {
  return present('numbered', flag(h, object, 'numbered', path))
}

/** A diff node's `start`, `numbered`, `hunkHeader`, `context` (0 to 3), and `maxRows`. */
export function admitDiffFields<State>(h: AdmissionHelpers<State>, object: Fields, path: string): Fields {
  return {
    ...present('start', integer(h, object, 'start', path, 0, 1_000_000)),
    ...present('numbered', flag(h, object, 'numbered', path)),
    ...present('hunkHeader', flag(h, object, 'hunkHeader', path)),
    ...present('context', integer(h, object, 'context', path, 0, 3)),
    ...present('maxRows', integer(h, object, 'maxRows', path, 1, 10_000)),
  }
}

/** A stack child's `priority`, `band`, and `overflow`. */
export function admitChildAdmission<State>(h: AdmissionHelpers<State>, object: Fields, path: string): Fields {
  const band = h.own(object, 'band', path)
  const overflow = h.own(object, 'overflow', path)
  return {
    ...present('priority', integer(h, object, 'priority', path, 0, 1_000_000)),
    ...present('band', band === undefined ? undefined : h.enumeration(band, ['left', 'center', 'right'] as const, `${path}.band`)),
    ...present('overflow', overflow === undefined ? undefined : h.enumeration(overflow, ['truncate', 'hide'] as const, `${path}.overflow`)),
  }
}

/** A surface's `titleAlign`, `border`, `escapeLabel`, and `hint`. */
export function admitSurfaceFields<State>(h: AdmissionHelpers<State>, object: Fields, path: string): Fields {
  const titleAlign = h.own(object, 'titleAlign', path)
  const border = h.own(object, 'border', path)
  const escapeLabel = h.own(object, 'escapeLabel', path)
  const hint = h.own(object, 'hint', path)
  return {
    ...present('titleAlign', titleAlign === undefined ? undefined : h.enumeration(titleAlign, ['left', 'right'] as const, `${path}.titleAlign`)),
    ...present('border', border === undefined ? undefined : h.enumeration<MayflyTone>(border, TONES, `${path}.border`)),
    ...present('escapeLabel', escapeLabel === undefined ? undefined : h.enumeration(escapeLabel, ['close', 'back', 'cancel', 'reject', 'leave'] as const, `${path}.escapeLabel`)),
    ...present('hint', hint === undefined ? undefined : h.enumeration(hint, ['auto', 'none', 'completions'] as const, `${path}.hint`)),
  }
}

/** A scroll's `height`, `expandedHeight` (not shorter than `height`), `fit`, and `pill`. */
export function admitScrollFields<State>(h: AdmissionHelpers<State>, object: Fields, path: string): Fields {
  const height = integer(h, object, 'height', path, 1, SCROLL_HEIGHT_MAX)
  const expandedHeight = integer(h, object, 'expandedHeight', path, 1, SCROLL_HEIGHT_MAX)
  if (height !== undefined && expandedHeight !== undefined && expandedHeight < height) h.invalid(`${path}.expandedHeight must not be shorter than height`)
  return { ...present('height', height), ...present('expandedHeight', expandedHeight), ...present('fit', flag(h, object, 'fit', path)), ...present('pill', flag(h, object, 'pill', path)) }
}

/**
 * A progress node's `style`, `width`, `tone`, `showCount`, `showPercent`, and `transition`. A status node carries no
 * motion, so it takes no transition.
 */
export function admitProgressFields<State>(h: AdmissionHelpers<State>, object: Fields, path: string, max: number, status: boolean): Fields {
  const style = h.own(object, 'style', path)
  const tone = h.own(object, 'tone', path)
  const transition = h.own(object, 'transition', path)
  let settled: MayflyProgressNode['transition']
  if (transition !== undefined) {
    if (status) h.invalid(`${path}.transition is not supported in a status node`)
    const entry = transition as Fields
    if (typeof transition !== 'object' || transition === null || Array.isArray(transition)) h.invalid(`${path}.transition must be an object`)
    settled = {
      from: Math.min(max, h.finiteInteger(h.own(entry, 'from', `${path}.transition`), `${path}.transition.from`)),
      ms: integer(h, entry, 'ms', `${path}.transition`, 1, PROGRESS_TRANSITION_MAX_MS) ?? h.invalid(`${path}.transition.ms is required`),
      rev: h.finiteInteger(h.own(entry, 'rev', `${path}.transition`), `${path}.transition.rev`),
    }
  }
  return {
    ...present('style', style === undefined ? undefined : h.enumeration(style, ['cells', 'rule'] as const, `${path}.style`)),
    ...present('width', integer(h, object, 'width', path, 1, PROGRESS_WIDTH_MAX)),
    ...present('tone', tone === undefined ? undefined : h.enumeration<MayflyTone>(tone, TONES, `${path}.tone`)),
    ...present('showCount', flag(h, object, 'showCount', path)),
    ...present('showPercent', flag(h, object, 'showPercent', path)),
    ...present('transition', settled),
  }
}

/** A heatmap's `cell` (1 or 2) and `columnLabels`, one per column. */
export function admitHeatmapFields<State>(h: AdmissionHelpers<State>, object: Fields, path: string, columns: number, state: State): Fields {
  const cell = h.own(object, 'cell', path)
  const labels = h.own(object, 'columnLabels', path)
  const columnLabels = labels === undefined ? undefined : h.collection(labels, `${path}.columnLabels`).map((label, index) => h.text(label, `${path}.columnLabels[${String(index)}]`, state))
  if (columnLabels !== undefined && columnLabels.length !== columns) h.invalid(`${path}.columnLabels must match columns`)
  return { ...present('cell', cell === undefined ? undefined : h.enumeration(cell, [1, 2] as const, `${path}.cell`)), ...present('columnLabels', columnLabels) }
}

/** A rich-text row has one motion channel: at most one span shimmers or is a loader cell. */
export function countMotion<State>(h: AdmissionHelpers<State>, spans: readonly MayflyInlineSpan[], path: string): void {
  if (spans.filter(span => span.motion !== undefined).length > 1) h.invalid(`${path} has more than one motion channel in a row`)
}
