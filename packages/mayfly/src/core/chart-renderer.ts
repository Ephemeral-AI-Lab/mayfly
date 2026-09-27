/**
 * Width-contained adapter from canonical Mayfly chart nodes to simple-ascii-chart.
 *
 * @module @ephemeral-ai/mayfly/core/chart-renderer
 */

import type { MayflyChartNode, MayflyTone } from '@ephemeral-ai/mayfly-ui'
import { heatmap, plot, renderChart, sparkline, type Color } from 'simple-ascii-chart'
import { paintPluginTone } from './plugin-view.ts'
import type { MayflyComponents, MayflySemanticColors } from './types.ts'

const TONE_COLOR: Readonly<Record<MayflyTone, Color>> = {
  default: 'ansiWhite',
  muted: 'ansiBrightBlack',
  primary: 'ansiBrightCyan',
  accent: 'ansiCyan',
  user: 'ansiBrightBlue',
  success: 'ansiGreen',
  warning: 'ansiYellow',
  danger: 'ansiRed',
}
const COLOR_CODE: Readonly<Record<Color, number>> = {
  ansiBlack: 30, ansiRed: 31, ansiGreen: 32, ansiYellow: 33,
  ansiBlue: 34, ansiMagenta: 35, ansiCyan: 36, ansiWhite: 37,
  ansiBrightBlack: 90, ansiBrightRed: 91, ansiBrightGreen: 92, ansiBrightYellow: 93,
  ansiBrightBlue: 94, ansiBrightMagenta: 95, ansiBrightCyan: 96, ansiBrightWhite: 97,
}
const DEFAULT_TONES: readonly MayflyTone[] = ['accent', 'success', 'warning', 'danger', 'muted', 'default']

function toneAt(tone: MayflyTone | undefined, index: number): MayflyTone {
  return tone ?? DEFAULT_TONES[index % DEFAULT_TONES.length]!
}

function vendorColor(tone: MayflyTone): Color {
  return TONE_COLOR[tone]
}

function applyTheme(output: string, tones: readonly MayflyTone[], colors: MayflySemanticColors): string {
  const byCode = new Map(tones.map(tone => [COLOR_CODE[vendorColor(tone)], tone]))
  return output.replace(/\x1b\[(\d+)m([^\x1b]*)\x1b\[0m/gu, (_match, rawCode: string, body: string) => {
    const tone = byCode.get(Number(rawCode))
    return tone === undefined ? body : paintPluginTone(colors, tone)(body)
  })
}

function rows(output: string): string[] {
  const result = output.replaceAll('\r\n', '\n').split('\n')
  while (result.length > 0 && result[0] === '') result.shift()
  while (result.length > 0 && result.at(-1) === '') result.pop()
  return result
}

function checkedRows(
  render: (plotWidth: number, compact: boolean) => string,
  width: number,
  tones: readonly MayflyTone[],
  components: MayflyComponents,
  colors: MayflySemanticColors,
): string[] | undefined {
  for (const compact of [false, true]) {
    let plotWidth = Math.max(4, width - (compact ? 2 : 8))
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const themed = rows(applyTheme(render(plotWidth, compact), tones, colors))
        const widest = themed.reduce((maximum, row) => Math.max(maximum, components.visibleWidth(row)), 0)
        if (themed.length > 0 && widest <= width) return themed
        plotWidth = Math.max(4, plotWidth - Math.max(1, widest - width + 1))
      } catch { break }
    }
  }
  return undefined
}

/** Format a chart summary value without corrupting scientific exponents. */
export function formatChartNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(4)))
}

function summary(node: Exclude<MayflyChartNode, { readonly chart: 'sparkline' }>, width: number, components: MayflyComponents, colors: MayflySemanticColors): string[] {
  const result: string[] = []
  if ('title' in node && node.title !== undefined) result.push(colors.textStrong(components.truncateToWidth(node.title, width)))
  switch (node.chart) {
    case 'line':
    case 'point':
      for (const [index, series] of node.series.entries()) {
        const values = series.points.flatMap(point => point.y === null ? [] : [point.y])
        const detail = values.length === 0 ? 'no data' : `min ${formatChartNumber(Math.min(...values))}, max ${formatChartNumber(Math.max(...values))}, last ${formatChartNumber(values.at(-1)!)}`
        result.push(paintPluginTone(colors, toneAt(series.tone, index))(components.truncateToWidth(`${series.label ?? series.id}: ${detail}`, width)))
      }
      break
    case 'bar':
      for (const [index, series] of node.series.entries()) {
        const values = series.values.flatMap(value => value === null ? [] : [value])
        const detail = values.length === 0 ? 'no data' : `total ${formatChartNumber(values.reduce((sum, value) => sum + value, 0))}`
        result.push(paintPluginTone(colors, toneAt(series.tone, index))(components.truncateToWidth(`${series.label ?? series.id}: ${detail}`, width)))
      }
      break
    case 'heatmap':
      for (const [index, row] of node.values.entries()) {
        result.push(components.truncateToWidth(`${node.rows[index] ?? ''}: ${row.map(value => value ?? '-').join(' ')}`, width))
      }
  }
  return result
}

function renderNumeric(node: Extract<MayflyChartNode, { readonly chart: 'line' | 'point' }>, width: number, components: MayflyComponents, colors: MayflySemanticColors): string[] | undefined {
  const tones = node.series.map((series, index) => toneAt(series.tone, index))
  return checkedRows((plotWidth, compact) => plot(
    node.series.map(series => series.points.map(point => [point.x, point.y] as const)),
    {
      width: plotWidth,
      height: node.height ?? 10,
      mode: node.chart,
      interpolation: 'linear',
      overflow: 'clip',
      color: tones.map(vendorColor),
      ...(compact ? { hideXAxisTicks: true, hideYAxisTicks: true } : {
        showTickLabel: true,
        ...(node.title === undefined ? {} : { title: components.truncateToWidth(node.title, width) }),
        ...(node.xLabel === undefined ? {} : { xLabel: components.truncateToWidth(node.xLabel, width) }),
        ...(node.yLabel === undefined ? {} : { yLabel: components.truncateToWidth(node.yLabel, width) }),
        ...(node.series.length < 2 ? {} : { legend: { position: 'bottom' as const, series: node.series.map(series => series.label ?? series.id) } }),
      }),
    },
  ), width, tones, components, colors)
}

function renderBars(node: Extract<MayflyChartNode, { readonly chart: 'bar' }>, width: number, components: MayflyComponents, colors: MayflySemanticColors): string[] | undefined {
  const tones = node.series.map((series, index) => toneAt(series.tone, index))
  return checkedRows((plotWidth, compact) => renderChart({
    width: plotWidth,
    height: node.height ?? 10,
    series: node.series.map((series, index) => ({
      id: series.id,
      name: series.label ?? series.id,
      data: node.categories.map((category, categoryIndex) => [category, series.values[categoryIndex] ?? null] as const),
      mode: 'bar' as const,
      color: vendorColor(tones[index]!),
    })),
    xAxis: { scale: 'band' as const, ...(compact ? { ticks: 0 } : {}) },
    ...(compact || node.yLabel === undefined ? {} : { yAxis: { label: components.truncateToWidth(node.yLabel, width) } }),
    ...(compact || node.title === undefined ? {} : { title: components.truncateToWidth(node.title, width) }),
    ...(compact || node.series.length < 2 ? {} : { legend: { position: 'bottom' as const, series: true } }),
    barLayout: node.layout ?? 'grouped',
  }), width, tones, components, colors)
}

/** Horizontal normalized bars: each category folds its proportional series fill row-major over a `height`-row grid of ~1% cells; `empty` series paint as the muted empty track. */
function renderHorizontalBars(node: Extract<MayflyChartNode, { readonly chart: 'bar' }>, width: number, components: MayflyComponents, colors: MayflySemanticColors): string[] | undefined {
  if (node.categories.length === 0) return undefined
  const tones = node.series.map((series, index) => toneAt(series.tone, index))
  const height = Math.max(1, node.height ?? 10)
  const columns = Math.max(1, Math.min(width, Math.ceil(100 / height)))
  const cells = height * columns
  const result: string[] = []
  if (node.title !== undefined) result.push(colors.textStrong(components.truncateToWidth(node.title, width)))
  for (const [categoryIndex, category] of node.categories.entries()) {
    if (category.length > 0) result.push(colors.textStrong(components.truncateToWidth(category, width)))
    const totals = node.series.map(series => Math.max(0, series.values[categoryIndex] ?? 0))
    const total = totals.reduce((sum, value) => sum + value, 0)
    const counts = node.series.map(() => 0)
    if (total > 0) {
      let cumulative = 0
      let boundary = 0
      for (const [index, value] of totals.entries()) {
        cumulative += value
        const next = Math.round((cumulative / total) * cells)
        counts[index] = next - boundary
        boundary = next
      }
      for (const [index, value] of totals.entries()) {
        if (value <= 0 || counts[index]! > 0) continue
        let donor = -1
        for (const [candidate, count] of counts.entries()) if (count > 1 && (donor === -1 || count > counts[donor]!)) donor = candidate
        if (donor === -1) break
        counts[donor]! -= 1
        counts[index] = 1
      }
    }
    const assignments = counts.flatMap((count, index) => Array.from({ length: count }, () => index))
    while (assignments.length < cells) assignments.push(-1)
    for (let row = 0; row < height; row += 1) {
      let line = ''
      let run = -1
      let runLength = 0
      const flush = (): void => {
        if (runLength === 0) return
        const series = run >= 0 ? node.series[run] : undefined
        line += paintPluginTone(colors, run >= 0 ? tones[run] : 'muted')((series?.empty === true || run < 0 ? '░' : '█').repeat(runLength))
        runLength = 0
      }
      for (let column = 0; column < columns; column += 1) {
        const index = assignments[row * columns + column]!
        if (index !== run) { flush(); run = index }
        runLength += 1
      }
      flush()
      result.push(line)
    }
  }
  return result
}

function sampleValues(values: readonly (number | null)[], size: number): readonly (number | null)[] {
  if (values.length <= size) return values
  return Array.from({ length: size }, (_, index) => values[Math.round(index * (values.length - 1) / Math.max(1, size - 1))]!)
}

function renderSparkline(node: Extract<MayflyChartNode, { readonly chart: 'sparkline' }>, width: number, components: MayflyComponents, colors: MayflySemanticColors): string[] {
  const tone = toneAt(node.tone, 0)
  const label = node.label === undefined ? [] : [colors.textStrong(components.truncateToWidth(node.label, width))]
  if (node.values.length === 0) return label
  const output = applyTheme(sparkline(sampleValues(node.values, width), { color: vendorColor(tone) }), [tone], colors)
  return [...label, components.truncateToWidth(output, width)]
}

function renderHeatmap(node: Extract<MayflyChartNode, { readonly chart: 'heatmap' }>, width: number, components: MayflyComponents, colors: MayflySemanticColors): string[] | undefined {
  const tones = node.levels.map((level, index) => toneAt(level.tone, index))
  const symbols = ['●', '◆', '■', '▲', '○', '◇'] as const
  for (const compact of [false, true]) {
    try {
      const output = heatmap({
        columns: node.columns.map(label => compact ? components.truncateToWidth(label, 6) : label),
        rows: node.rows.map(label => compact ? components.truncateToWidth(label, 8) : label),
        data: node.values,
        levels: node.levels.map((level, index) => ({
          value: level.value,
          label: level.label,
          symbol: symbols[index % symbols.length]!,
          color: vendorColor(tones[index]!),
        })),
        ...(compact || node.title === undefined ? {} : { title: components.truncateToWidth(node.title, width) }),
        legend: !compact,
      })
      const themed = rows(applyTheme(output, tones, colors))
      if (themed.every(row => components.visibleWidth(row) <= width)) return themed
    } catch { /* the bounded summary below is the defined fallback */ }
  }
  return undefined
}

/** Render one canonical chart, falling back to a bounded textual summary. */
export function renderChartRows(node: MayflyChartNode, width: number, components: MayflyComponents, colors: MayflySemanticColors): string[] {
  const safeWidth = Math.max(1, Number.isFinite(width) ? Math.floor(width) : 1)
  switch (node.chart) {
    case 'sparkline': return renderSparkline(node, safeWidth, components, colors)
    case 'line':
    case 'point': return renderNumeric(node, safeWidth, components, colors) ?? summary(node, safeWidth, components, colors)
    case 'bar': return (node.orientation === 'horizontal' ? renderHorizontalBars(node, safeWidth, components, colors) : renderBars(node, safeWidth, components, colors)) ?? summary(node, safeWidth, components, colors)
    case 'heatmap': return renderHeatmap(node, safeWidth, components, colors) ?? summary(node, safeWidth, components, colors)
  }
}
