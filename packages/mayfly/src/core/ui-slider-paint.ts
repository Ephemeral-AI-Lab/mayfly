/**
 * The slider painter: the rows of a `slider` node, a pure function of the node, the model's pinned level, the width, and
 * the palette. Three rows: the captions over the ends of a track, the track (a rule with a `▲` over the active level),
 * and the level labels. The track is centered in the width; the labels spread evenly along it, never touching. The
 * provider's default level always carries a muted `(default)`. A width too narrow for the labels folds to one row,
 * `‹ high (default) › +2`, the way the tabs strip folds.
 *
 * @module @ephemeral-ai/mayfly/core/ui-slider-paint
 */
import type { MayflySliderNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflySemanticColors } from './types.ts'
import type { UiSliderModel } from './ui-interaction-slider.ts'
import { sliceByColumn, visibleWidth } from './width.ts'

const strong = (text: string): string => `\x1b[1m${text}\x1b[22m`
/** The columns between two labels, at the least. */
const LABEL_GAP = 2
/** The widest track, in columns; a track that is wider than its labels need keeps this much room per step. */
const TRACK_MAX = 56
const STEP_ROOM = 12
/** The narrowest ideal track: a slider of two or three short levels still gets room to read as a track. */
const TRACK_MIN = 28
const DEFAULT_TAG = ' (default)'

export interface SliderPaint {
  readonly node: MayflySliderNode
  /** The surface model's state; absent outside an interactive surface, where the node's seed is drawn. */
  readonly model: UiSliderModel | undefined
  readonly width: number
  readonly colors: MayflySemanticColors
}

interface Slot {
  readonly id: string
  readonly label: string
  readonly tag: string
  readonly width: number
  readonly disabled: boolean
}

function clip(line: string, width: number): string {
  return visibleWidth(line) <= width ? line : sliceByColumn(line, 0, Math.max(0, width), true)
}

/** The start column of each label: evenly spread centers, pushed apart to keep the gap, kept inside the track. */
function starts(slots: readonly Slot[], track: number): readonly number[] {
  const n = slots.length
  const at = slots.map((slot, index) => {
    const center = n === 1 ? Math.floor(track / 2) : Math.round(index * (track - 1) / (n - 1))
    return Math.min(Math.max(0, center - Math.floor(slot.width / 2)), Math.max(0, track - slot.width))
  })
  for (let index = 1; index < n; index += 1) at[index] = Math.max(at[index]!, at[index - 1]! + slots[index - 1]!.width + LABEL_GAP)
  for (let index = n - 1; index >= 0; index -= 1) {
    const limit = index === n - 1 ? track : at[index + 1]! - LABEL_GAP
    at[index] = Math.max(0, Math.min(at[index]!, limit - slots[index]!.width))
  }
  return at
}

/** The one-row fold: the active level with the neighbors that fit, `‹ … ›`, and a muted `+N` for the rest. */
function folded(slots: readonly Slot[], active: number, width: number, colors: MayflySemanticColors): string {
  const keep = new Set([Math.max(0, active)])
  const cells = (list: ReadonlySet<number>): number => {
    const shown = [...list].toSorted((left, right) => left - right).map(index => slots[index]!)
    const hidden = slots.length - shown.length
    return 4 + shown.reduce((sum, slot) => sum + slot.width, 0) + Math.max(0, shown.length - 1) + (hidden > 0 ? 1 + `+${String(hidden)}`.length : 0)
  }
  for (let distance = 1; distance < slots.length; distance += 1) {
    for (const index of [active - distance, active + distance]) {
      if (index < 0 || index >= slots.length) continue
      const next = new Set(keep).add(index)
      if (cells(next) <= width) keep.add(index)
    }
  }
  const shown = [...keep].toSorted((left, right) => left - right)
  const hidden = slots.length - shown.length
  const body = shown.map(index => {
    const slot = slots[index]!
    const text = `${slot.label}${slot.tag}`
    return index === active ? `${strong(colors.primary(slot.label))}${colors.muted(slot.tag)}` : slot.disabled ? colors.muted(text) : colors.text(text)
  }).join(' ')
  return clip(`${colors.muted('‹')} ${body} ${colors.muted('›')}${hidden > 0 ? ` ${colors.muted(`+${String(hidden)}`)}` : ''}`, width)
}

/**
 * The rows of one slider.
 * @returns the caption row (when the captions fit), the track row, and the label row; or one folded row at a width too
 *   narrow for the labels.
 */
export function paintSlider(paint: SliderPaint): string[] {
  const { node, model, colors } = paint
  const width = Math.max(1, Math.floor(paint.width))
  const activeId = model === undefined ? node.selectedId ?? node.inheritedId : model.pinned ?? node.inheritedId
  const slots: Slot[] = node.levels.map(level => {
    const tag = level.id === node.inheritedId ? DEFAULT_TAG : ''
    return { id: level.id, label: level.label, tag, width: visibleWidth(level.label) + tag.length, disabled: level.disabled === true }
  })
  const active = slots.findIndex(slot => slot.id === activeId)
  const widest = Math.max(...slots.map(slot => slot.width))
  const needed = slots.reduce((sum, slot) => sum + slot.width, 0) + LABEL_GAP * (slots.length - 1)
  if (needed > width) return [folded(slots, active, width, colors)]
  const ideal = Math.min(TRACK_MAX, Math.max(needed, TRACK_MIN, STEP_ROOM * (slots.length - 1) + widest))
  const track = Math.min(width, ideal)
  const lead = ' '.repeat(Math.floor((width - track) / 2))
  const at = starts(slots, track)
  // The marker stands over the middle of the active label's own text, never its tag.
  const markerAt = active < 0 ? -1 : at[active]! + Math.floor(visibleWidth(slots[active]!.label) / 2)
  const rule = markerAt < 0 || markerAt >= track
    ? colors.muted('─'.repeat(track))
    : `${colors.muted('─'.repeat(markerAt))}${strong(colors.primary('▲'))}${colors.muted('─'.repeat(track - markerAt - 1))}`
  let labels = ''
  let column = 0
  slots.forEach((slot, index) => {
    labels += ' '.repeat(Math.max(0, at[index]! - column))
    labels += index === active ? `${strong(colors.primary(slot.label))}${colors.muted(slot.tag)}` : slot.disabled ? colors.muted(`${slot.label}${slot.tag}`) : `${colors.text(slot.label)}${colors.muted(slot.tag)}`
    column = at[index]! + slot.width
  })
  const rows: string[] = []
  const start = node.startCaption ?? ''
  const end = node.endCaption ?? ''
  if ((start.length > 0 || end.length > 0) && visibleWidth(start) + visibleWidth(end) + 2 <= track) {
    rows.push(`${lead}${colors.muted(start)}${' '.repeat(Math.max(1, track - visibleWidth(start) - visibleWidth(end)))}${colors.muted(end)}`)
  }
  rows.push(`${lead}${rule}`, `${lead}${labels}`)
  return rows.map(row => clip(row, width))
}
