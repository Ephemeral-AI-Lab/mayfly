/**
 * The segment strip of a list row (spec 4.4): `min ‹ high (default) › max`, drawn on the focused row only. Pure painters
 * and the width ladder that keeps the strip on screen without ever moving a row: inline with `(default)`, inline
 * without it, then one footer line the list reserves in advance (label and full strip, the strip alone, folded tokens
 * with a `+N`, and last the active token alone).
 *
 * @module @ephemeral-ai/mayfly/core/ui-list-segment
 */

import type { MayflyListSegment } from '@ephemeral-ai/mayfly-ui'
import type { MayflySemanticColors } from './types.ts'
import { sliceByColumn, visibleWidth } from './width.ts'

/** A row's segment and where it stands: the option pinned on it (`null` while unpinned) and the one that applies. */
export interface SegmentView {
  readonly segment: MayflyListSegment
  readonly pinned: string | null
  readonly active: string | undefined
}

interface Token {
  readonly active: boolean
  readonly plain: string
  readonly text: string
}

const GAP = ' '
const strong = (text: string): string => `\x1b[1m${text}\x1b[22m`

/** The strip's tokens; `withDefault` marks the inherited option `(default)` while the row is unpinned. */
function tokens(view: SegmentView, withDefault: boolean, colors: MayflySemanticColors): readonly Token[] {
  return view.segment.options.map(option => {
    const active = option.id === view.active
    const tag = withDefault && view.pinned === null && option.id === view.segment.inheritedId ? ' (default)' : ''
    const plain = active ? `‹ ${option.label}${tag} ›` : option.label
    // An active option that cannot be chosen stays muted: the strip never promotes it.
    return { active, plain, text: active && option.disabled !== true ? strong(colors.primary(plain)) : colors.muted(plain) }
  })
}

const widthOf = (list: readonly Token[]): number => list.reduce((sum, token) => sum + visibleWidth(token.plain), 0) + Math.max(0, list.length - 1) * GAP.length
const join = (list: readonly Token[]): string => list.map(token => token.text).join(GAP)

/** The whole strip as one string and its width. */
export function segmentStrip(view: SegmentView, withDefault: boolean, colors: MayflySemanticColors): { readonly text: string, readonly width: number } {
  const list = tokens(view, withDefault, colors)
  return { text: join(list), width: widthOf(list) }
}

/** The inline strip that fits in `room` columns, with `(default)` when it can, or undefined when only the footer fits it. */
export function inlineSegmentStrip(view: SegmentView, room: number, colors: MayflySemanticColors): { readonly text: string, readonly width: number } | undefined {
  for (const withDefault of [true, false]) {
    const strip = segmentStrip(view, withDefault, colors)
    if (strip.width <= room) return strip
  }
  return undefined
}

/** Whether the strip fits inline without `(default)`: the test that decides whether the list reserves its footer. */
export function segmentFitsInline(view: SegmentView, room: number, colors: MayflySemanticColors): boolean {
  return segmentStrip(view, false, colors).width <= room
}

/** The tokens nearest the active one that fit in `room`, with a muted `+N` for the rest; the active token alone as a last resort. */
function folded(view: SegmentView, room: number, colors: MayflySemanticColors): string {
  const list = tokens(view, true, colors)
  const at = Math.max(0, list.findIndex(token => token.active))
  const keep = new Set([at])
  const fits = (): boolean => {
    const shown = list.filter((_, index) => keep.has(index))
    const hidden = list.length - shown.length
    return widthOf(shown) + (hidden > 0 ? GAP.length + `+${String(hidden)}`.length : 0) <= room
  }
  for (let distance = 1; distance < list.length; distance += 1) {
    for (const index of [at - distance, at + distance]) {
      if (index < 0 || index >= list.length) continue
      keep.add(index)
      if (!fits()) keep.delete(index)
    }
  }
  const shown = list.filter((_, index) => keep.has(index))
  const hidden = list.length - shown.length
  const line = `${join(shown)}${hidden > 0 ? `${GAP}${colors.muted(`+${String(hidden)}`)}` : ''}`
  return visibleWidth(line) <= room ? line : sliceByColumn(line, 0, Math.max(1, room), true)
}

/**
 * The footer line of a list that reserves one: a two-column indent, then the most it can show of `Label: strip`. The
 * ladder drops the label, then `(default)`, then folds far tokens into `+N`, then keeps the active token alone.
 */
export function segmentFooter(view: SegmentView, width: number, colors: MayflySemanticColors, label: string): string {
  const line = footerLine(view, width, colors, label)
  return visibleWidth(line) <= width ? line : sliceByColumn(line, 0, Math.max(1, width), true)
}

function footerLine(view: SegmentView, width: number, colors: MayflySemanticColors, label: string): string {
  const room = Math.max(1, width - 2)
  const full = segmentStrip(view, true, colors)
  const caption = `${label}:`
  if (visibleWidth(caption) + 1 + full.width <= room) return `  ${colors.muted(caption)} ${full.text}`
  if (full.width <= room) return `  ${full.text}`
  const plain = segmentStrip(view, false, colors)
  if (plain.width <= room) return `  ${plain.text}`
  return `  ${folded(view, room, colors)}`
}
