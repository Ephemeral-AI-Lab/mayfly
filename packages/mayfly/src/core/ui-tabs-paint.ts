/**
 * The tab painters (spec 4.5): the horizontal strip with its heavy underline and its narrow folds, the wizard's step
 * marks, and the vertical rail with group headings, a cursor arrow, and right-aligned counts. They own presentation and
 * width degradation only; focus, keys, and events stay in `ui-compiler.ts`. A rail keeps each item's rows in the
 * surface's row cache, so a cursor move repaints the two items whose look changed.
 *
 * @module @ephemeral-ai/mayfly/core/ui-tabs-paint
 */

import type { MayflyTabItem, MayflyTabsNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflySemanticColors } from './types.ts'
import { UiRowCache } from './ui-row-cache.ts'
import type { MayflyWorkCounters } from './ui-work-counters.ts'
import { OVERFLOW_ELLIPSIS, sliceByColumn, truncateMiddle, visibleWidth } from './width.ts'

/** What the painter needs to know about focus: whether the surface holds it, which item is current, and the cursor mark. */
export interface TabsFocus {
  readonly key: string
  readonly focused: boolean
  readonly marker: string
}

/** The row cache and counters a rail paints through; a strip is two rows and keeps no cache. */
export interface TabsPaintOptions {
  readonly cache?: UiRowCache
  readonly counters?: MayflyWorkCounters | undefined
}

/** Gap between two tabs of a strip. */
const TAB_GAP = 3
/** Below this many columns a rail is drawn as the horizontal strip (spec 4.5). */
export const RAIL_MIN_COLUMNS = 60
const WIZARD_SEPARATOR_WIDTH = 5

/** Whether a tabs node is drawn as a vertical rail in a viewport that is `columns` wide. */
export function isRail(node: Pick<MayflyTabsNode, 'mode' | 'orientation'>, columns: number): boolean {
  return node.orientation === 'vertical' && node.mode !== 'wizard' && columns >= RAIL_MIN_COLUMNS
}

/** The node as it is drawn in a viewport `columns` wide: a rail below {@link RAIL_MIN_COLUMNS} is the horizontal strip. */
export function tabsShape(node: MayflyTabsNode, columns: number): MayflyTabsNode {
  return node.orientation === 'vertical' && !isRail(node, columns) ? { ...node, orientation: 'horizontal' } : node
}

const strong = (text: string): string => `\x1b[1m${text}\x1b[22m`
const safeWidth = (width: number): number => Math.max(1, Number.isFinite(width) ? Math.floor(width) : 1)
const fit = (value: string, width: number): string => visibleWidth(value) <= width ? value : sliceByColumn(value, 0, width, true)

/** The count or attention mark after a label: `!` replaces a count. */
function badgeOf(item: MayflyTabItem): string {
  return item.attention === true ? '!' : item.count === undefined ? '' : String(item.count)
}

function paintStrip(node: MayflyTabsNode, width: number, focus: TabsFocus, colors: MayflySemanticColors, completed: readonly string[]): string[] {
  const focused = focus.focused && focus.key !== ''
  const activeIndex = Math.max(0, node.items.findIndex(item => item.id === node.activeId))
  const tokens = node.items.map((item, index) => {
    const active = index === activeIndex
    const badge = badgeOf(item)
    if (node.mode === 'wizard') {
      const done = !active && completed.includes(item.id)
      const plain = `${done ? '✓' : active ? '●' : '○'} ${item.label}`
      const text = done ? `${colors.success('✓')} ${colors.text(item.label)}`
        : active ? `${colors.primary('●')} ${strong(colors.primary(item.label))}` : colors.muted(plain)
      return { plain, text }
    }
    const label = active ? colors.primary(item.label) : colors.muted(item.label)
    const mark = badge === '' ? '' : ` ${item.attention === true ? strong(colors.warning(badge)) : (active ? colors.primary : colors.muted)(badge)}`
    return { plain: `${item.label}${badge === '' ? '' : ` ${badge}`}`, text: `${active && focused ? strong(label) : label}${mark}` }
  })
  const wizard = node.mode === 'wizard'
  const separator = wizard ? colors.muted('  ›  ') : ' '.repeat(TAB_GAP)
  const separatorWidth = wizard ? WIZARD_SEPARATOR_WIDTH : TAB_GAP
  const total = tokens.reduce((sum, token) => sum + visibleWidth(token.plain), 0) + separatorWidth * Math.max(0, tokens.length - 1)
  if (total > width) return [paintFolded(tokens, activeIndex, width, colors, focused ? focus.marker : '')]
  const offset = tokens.slice(0, activeIndex).reduce((sum, token) => sum + visibleWidth(token.plain) + separatorWidth, 0)
  const rule = '━'.repeat(visibleWidth(tokens[activeIndex]?.plain ?? ''))
  // The strip's rule is bold while it has focus; the wizard's is not.
  const underline = `${' '.repeat(offset)}${focused ? (wizard ? colors.primary(rule) : strong(colors.primary(rule))) : colors.muted(rule)}${focused ? focus.marker : ''}`
  return [tokens.map(token => token.text).join(separator), fit(underline, width)]
}

/**
 * A strip that does not fit folds around the active tab: `‹ active next +N ›`, then `‹ active +N ›`, then the same row
 * cut to the width. The cursor mark rides at the end when the row leaves a column for it.
 */
function paintFolded(tokens: readonly { readonly text: string, readonly plain: string }[], activeIndex: number, width: number, colors: MayflySemanticColors, marker: string): string {
  const fold = (shown: readonly { readonly text: string }[]): string => {
    const rest = tokens.length - shown.length
    return `${colors.muted('‹ ')}${shown.map(token => token.text).join('  ')}${colors.muted(rest > 0 ? `  +${String(rest)} ›` : ' ›')}`
  }
  const active = tokens[activeIndex]!
  const next = tokens[activeIndex + 1]
  const both = fold(next === undefined ? [active] : [active, next])
  const row = visibleWidth(both) <= width || next === undefined ? both : fold([active])
  const clipped = fit(row, width)
  return marker !== '' && visibleWidth(clipped) < width ? `${clipped}${marker}` : clipped
}

/** One rail item: its heading when it opens a group, then its row. */
function paintRailItem(item: MayflyTabItem, heading: boolean, state: { readonly active: boolean, readonly focused: boolean, readonly marker: string }, width: number, colors: MayflySemanticColors): string[] {
  const rows: string[] = []
  if (heading) rows.push(fit(colors.muted(` ${item.group!.toUpperCase()}`), width))
  const badge = badgeOf(item)
  const right = badge === '' ? '' : item.attention === true ? strong(colors.warning(badge)) : colors.muted(badge)
  const rightWidth = visibleWidth(right)
  const room = Math.max(1, width - rightWidth - 4)
  const label = item.clip === 'start' ? truncateMiddle(item.label, room, 'start')
    : visibleWidth(item.label) <= room ? item.label : `${sliceByColumn(item.label, 0, room - 1, true)}${OVERFLOW_ELLIPSIS}`
  const arrow = state.active ? strong(state.focused ? colors.primary('→') : colors.muted('→')) : ' '
  const text = state.active ? strong(state.focused ? colors.primary(label) : colors.text(label)) : item.disabled === true ? colors.muted(label) : colors.text(label)
  const left = `${arrow} ${text}`
  // The gap column before the count is where the hardware cursor sits while the rail has focus.
  const gap = Math.max(0, width - rightWidth - 1 - visibleWidth(left))
  const mark = state.active && state.focused ? state.marker : ' '
  rows.push(fit(`${left}${' '.repeat(gap)}${mark}${right}`, width))
  return rows
}

function paintRail(node: MayflyTabsNode, width: number, focus: TabsFocus, colors: MayflySemanticColors, options: TabsPaintOptions): string[] {
  const cache = options.cache ?? new UiRowCache()
  const rows: string[] = []
  let group: string | undefined
  for (const item of node.items) {
    const heading = item.group !== undefined && item.group !== group
    if (heading) group = item.group
    const state = { active: item.id === node.activeId, focused: focus.focused && focus.key !== '', marker: focus.marker }
    const key = `${String(width)}\0${state.active ? 'a' : 'i'}${state.active && state.focused ? `f${state.marker}` : ''}${heading ? 'h' : ''}`
    rows.push(...cache.readLines(colors, item, key, () => paintRailItem(item, heading, state, width, colors), options.counters))
  }
  return rows
}

/**
 * Paints a tabs node at a width: the rail when the node is vertical (the caller decides, with {@link isRail}, whether the
 * viewport is wide enough), else the strip or wizard.
 * @param node - the node to paint; a vertical `orientation` paints the rail.
 * @param width - the columns available.
 * @param focus - whether the surface has focus and which item holds it.
 * @param colors - the semantic palette.
 * @param completed - the wizard steps already left behind.
 * @param options - the row cache and counters a rail paints through.
 * @returns the painted rows.
 */
export function paintTabs(node: MayflyTabsNode, width: number, focus: TabsFocus, colors: MayflySemanticColors, completed: readonly string[] = [], options: TabsPaintOptions = {}): string[] {
  const available = safeWidth(width)
  return node.orientation === 'vertical' && node.mode !== 'wizard' ? paintRail(node, available, focus, colors, options) : paintStrip(node, available, focus, colors, completed)
}
