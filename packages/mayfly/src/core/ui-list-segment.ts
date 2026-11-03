/**
 * The segment line of a list (spec 4.4): the focused row's thinking level on one line under the rows, `● Thinking: high
 * (default)`. The list reserves the line in advance, so focus never moves a row. The dot is filled and in the brand ink
 * while the row pins a level and hollow and muted while it follows its default. The width ladder drops the label, then
 * the `(default)` tag, then clips.
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

/** The columns a segment line sits in: the list's own gutter. */
const PANEL_INDENT = 2

const strong = (text: string): string => `\x1b[1m${text}\x1b[22m`

/** The level the row shows: its active option's label with `(default)` while the row follows the inherited option; `—` for none. */
function levelText(view: SegmentView, withDefault: boolean): string {
  const option = view.segment.options.find(candidate => candidate.id === view.active)
  if (option === undefined) return '—'
  return withDefault && view.pinned === null && option.id === view.segment.inheritedId ? `${option.label} (default)` : option.label
}

/**
 * The line a list reserves under its rows for the focused row's segment: `● Thinking: high (default)`. The ladder drops
 * the label, then `(default)`, then clips with an ellipsis; `label` is the caption the segment names itself with.
 */
export function segmentLine(view: SegmentView, width: number, colors: MayflySemanticColors, label: string): string {
  const room = Math.max(1, width - PANEL_INDENT)
  const dot = view.pinned === null ? colors.muted('○') : strong(colors.primary('●'))
  const fitted = (text: string): string | undefined => visibleWidth(text) + 2 <= room ? text : undefined
  const candidates = [
    `${label}: ${levelText(view, true)}`, `${label}: ${levelText(view, false)}`, levelText(view, true), levelText(view, false),
  ]
  const text = candidates.map(fitted).find(candidate => candidate !== undefined) ?? sliceByColumn(levelText(view, false), 0, Math.max(1, room - 2), true)
  const painted = text.startsWith(`${label}: `) ? `${colors.muted(`${label}:`)} ${view.pinned === null ? colors.text(text.slice(label.length + 2)) : strong(colors.text(text.slice(label.length + 2)))}` : view.pinned === null ? colors.text(text) : strong(colors.text(text))
  return `${' '.repeat(PANEL_INDENT)}${dot} ${painted}`
}
