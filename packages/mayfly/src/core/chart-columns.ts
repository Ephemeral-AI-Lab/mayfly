/**
 * The kit's vertical bar chart: one column group per category, painted in whole cells with eighths on top
 * (`▁▂▃▄▅▆▇█`), so a bar is as tall as its value on an axis that starts at zero. `stacked` piles the series in one
 * column, `grouped` sets them side by side, `normalized` stretches each category to a hundred percent. The y axis
 * carries a rounded top, a middle and zero; the x axis writes the category labels as far apart as they need. A chart
 * with more categories than columns shows the last ones that fit, and one with fewer is right-aligned under an axis that
 * always spans the plot. A bar is one cell wide (a grouped chart: one cell per series): a chart never stretches or
 * squeezes its bars to the row. Colour is the series'
 * tone; nothing relies on it alone, the legend names the series.
 *
 * @module @ephemeral-ai/mayfly/core/chart-columns
 */

import type { MayflyChartNode } from '@ephemeral-ai/mayfly-ui'
import { compactChartNumber, formatChartNumber } from './chart-format.ts'
import { paintPluginTone } from './plugin-view.ts'
import type { MayflyComponents, MayflySemanticColors } from './types.ts'
import type { MayflyTone } from '@ephemeral-ai/mayfly-ui'

type BarNode = Extract<MayflyChartNode, { readonly chart: 'bar' }>

const EIGHTHS = ' ▁▂▃▄▅▆▇█'
const DEFAULT_TONES: readonly MayflyTone[] = ['accent', 'success', 'warning', 'danger', 'muted', 'default']
/** The narrowest chart that is drawn; narrower falls back to the text summary. */
const MIN_WIDTH = 12
/** The share of the room after the y labels that the plot takes: the axis stops short of the row's edge. */
const PLOT_SHARE = 0.9

/** A rounded-up axis maximum: 1, 2, 2.5, 5 or 10 times a power of ten. */
function niceMax(value: number): number {
  if (!(value > 0)) return 1
  const unit = 10 ** Math.floor(Math.log10(value))
  const fraction = value / unit
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * unit
}

/** One painted group of columns: the values it holds per series. */
interface Group {
  readonly label: string
  /** The value of each series in this group, merged categories added. */
  readonly values: readonly number[]
}

/**
 * Rows of a column chart, or undefined when the width is too small to draw one.
 * @param node - the bar chart.
 * @param width - the cells available.
 * @param components - the width helpers.
 * @param colors - the semantic colours.
 * @returns the painted rows.
 */
export function renderColumns(node: BarNode, width: number, components: MayflyComponents, colors: MayflySemanticColors): string[] | undefined {
  if (width < MIN_WIDTH || node.categories.length === 0 || node.series.length === 0) return undefined
  const layout = node.layout ?? 'grouped'
  const seriesCount = node.series.length
  const tones = node.series.map((series, index) => series.tone ?? DEFAULT_TONES[index % DEFAULT_TONES.length]!)
  const height = Math.max(2, Math.floor(node.height ?? 8))
  const value = (series: number, category: number): number => Math.max(0, node.series[series]!.values[category] ?? 0)
  const normalized = layout === 'normalized'
  const format = (amount: number): string => normalized ? `${String(Math.round(amount))}%` : node.yFormat === 'compact' ? compactChartNumber(amount) : formatChartNumber(amount)

  // The columns each group needs: one for a pile, one per series side by side.
  const perGroup = layout === 'grouped' ? seriesCount : 1
  const widest = (top: number): number => Math.max(...[0, top / 2, top].map(amount => components.visibleWidth(format(amount))))
  // The axis maximum depends on the groups, which depend on the plot width, which depends on the label gutter: settle
  // the gutter from the raw maximum first (rounding up never adds a digit beyond one).
  const rawTop = Math.max(0, ...node.categories.map((_label, category) => layout === 'grouped'
    ? Math.max(0, ...node.series.map((_series, series) => value(series, category)))
    : node.series.reduce((sum, _series, series) => sum + value(series, category), 0)))
  const gutter = widest(normalized ? 100 : niceMax(rawTop)) + 1
  const plot = Math.floor((width - gutter) * PLOT_SHARE)
  if (plot < perGroup) return undefined

  // Every category is one group of `perGroup` cells; the plot shows the last groups that fit and the rest stay empty.
  const fit = Math.max(1, Math.floor(plot / perGroup))
  const first = Math.max(0, node.categories.length - fit)
  const groups: Group[] = []
  for (let category = first; category < node.categories.length; category += 1) {
    groups.push({ label: node.categories[category]!, values: node.series.map((_series, series) => value(series, category)) })
  }
  const totalOf = (group: Group): number => group.values.reduce((sum, amount) => sum + amount, 0)
  const top = normalized ? 100 : niceMax(Math.max(0, ...groups.map(group => layout === 'grouped' ? Math.max(0, ...group.values) : totalOf(group))))
  const used = groups.length * perGroup
  const lead = plot - used
  const unit = top / height

  /** The painted cell of one column: the glyph and the tone, or blank. */
  const cell = (amounts: readonly number[], row: number): { glyph: string, tone: MayflyTone } | undefined => {
    const low = (height - 1 - row) * unit
    const total = amounts.reduce((sum, amount) => sum + amount, 0)
    const scaled = normalized ? (index: number): number => total === 0 ? 0 : amounts[index]! / total * 100 : (index: number): number => amounts[index]!
    const sum = normalized ? (total === 0 ? 0 : 100) : total
    if (sum <= low) return undefined
    // The topmost series of the pile gives the partial cell on top its colour.
    let topSeries = 0
    for (let index = 0; index < amounts.length; index += 1) if (amounts[index]! > 0) topSeries = index
    if (sum < low + unit) return { glyph: EIGHTHS[Math.max(1, Math.min(8, Math.round((sum - low) / unit * 8)))]!, tone: tones[topSeries]! }
    // A full cell takes the colour of the series that covers its middle.
    const middle = low + unit / 2
    let cumulative = 0
    for (let index = 0; index < amounts.length; index += 1) {
      cumulative += scaled(index)
      if (middle < cumulative) return { glyph: '█', tone: tones[index]! }
    }
    return { glyph: '█', tone: tones[topSeries]! }
  }

  const rows: string[] = []
  if (node.title !== undefined) rows.push(colors.textStrong(components.truncateToWidth(node.title, width)))
  const labelRows = new Set([0, Math.floor((height - 1) / 2), height - 1])
  for (let row = 0; row < height; row += 1) {
    const label = row === 0 ? format(top) : row === height - 1 ? format(0) : labelRows.has(row) && height >= 5 ? format(top / 2) : ''
    const axis = label === '' ? '│' : '┤'
    let line = `${label.padStart(gutter - 1)}${axis}${' '.repeat(lead)}`
    for (const group of groups) {
      let painted = ''
      if (layout === 'grouped') {
        for (let series = 0; series < seriesCount; series += 1) {
          const drawn = cell([group.values[series]!], row)
          painted += drawn === undefined ? ' ' : paintPluginTone(colors, tones[series]!)(drawn.glyph)
        }
      } else {
        const drawn = cell(group.values, row)
        painted = drawn === undefined ? ' ' : paintPluginTone(colors, drawn.tone)(drawn.glyph)
      }
      line += painted
    }
    rows.push(line)
  }
  rows.push(`${' '.repeat(gutter - 1)}└${'─'.repeat(plot)}`)

  // The category labels, as far apart as the widest needs, the first under the first bar.
  const labelWidth = Math.max(...groups.map(group => components.visibleWidth(group.label)))
  const stride = Math.max(1, Math.ceil((labelWidth + 1) / perGroup))
  const axisCells = Array.from({ length: plot }, () => ' ')
  for (let index = 0; index < groups.length; index += stride) {
    const start = lead + index * perGroup
    const fits = Math.max(0, Math.min(components.visibleWidth(groups[index]!.label), plot - start))
    ;[...components.truncateToWidth(groups[index]!.label, fits, '')].forEach((letter, offset) => { axisCells[start + offset] = letter })
  }
  rows.push(`${' '.repeat(gutter)}${colors.muted(axisCells.join('').trimEnd())}`)

  if (node.legend !== false && seriesCount >= 2) {
    const legend = node.series.map((series, index) => `${paintPluginTone(colors, tones[index]!)('█')} ${series.label ?? series.id}`).join('  ')
    rows.push(components.truncateToWidth(`${' '.repeat(gutter)}${legend}`, width, ''))
  }
  return rows.map(row => components.truncateToWidth(row, width, ''))
}
