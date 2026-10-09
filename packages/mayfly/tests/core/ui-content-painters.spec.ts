/** The painters of slice 1.3: ellipsis, text and field looks, progress, loaders, motion cells, sparkline, heatmap, chrome. */
import { describe, expect, it } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import { renderChartRows } from '../../src/core/chart-renderer.ts'
import { renderCanonicalView } from '../../src/core/plugin-view.ts'
import type { MayflyComponents, MayflySemanticColors } from '../../src/core/types.ts'
import {
  BREATH_LEVELS, LOADER_FRAMES, breathLevel, breathPaint, loaderCell, loaderFrameGlyph, loaderVariant, shimmerText, shimmerWindow,
} from '../../src/core/ui-loader-animation.ts'
import { hasMotion, paintMotionSpans } from '../../src/core/ui-motion-text.ts'
import { renderDivider, renderEmpty, renderLoader, renderProgress, renderSurfaceHead, renderSurfaceTail, surfaceBorderPaint } from '../../src/core/ui-patterns.ts'
import { UiProgressTransitions } from '../../src/core/ui-progress-transition.ts'
import { truncateMiddle, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { ADVERSARIAL } from './width-scan.ts'

const tag = new Proxy({}, { get: (_target, role: string) => (text: string) => `<${role}>${text}</${role}>` }) as MayflySemanticColors
const identity = (value: string): string => value
const plainColors = new Proxy({ logoGradient: [identity] }, { get: (target, key) => key === 'logoGradient' ? target.logoGradient : identity }) as MayflySemanticColors
const components = { visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth } as unknown as MayflyComponents
const truecolor = (r: number, g: number, b: number) => (text: string): string => `\x1b[38;2;${String(r)};${String(g)};${String(b)}m${text}\x1b[39m`
const rgbColors = { ...plainColors, primary: truecolor(200, 100, 50), textMuted: truecolor(100, 100, 100), muted: identity } as unknown as MayflySemanticColors
const strip = (row: string): string => row.replace(/\x1b\[[0-9;]*m/gu, '')

describe('truncateMiddle', () => {
  it('keeps text that fits, elides the middle or the start, and handles the edges', () => {
    expect(truncateMiddle('short', 10)).toBe('short')
    expect(truncateMiddle('~/work/mayfly/packages/mayfly', 12)).toBe('~/work…ayfly')
    expect(truncateMiddle('~/work/mayfly/packages/mayfly', 12, 'start')).toBe('…ages/mayfly')
    expect(truncateMiddle('abcdefghij', 4, 'middle')).toBe('ab…j')
    expect(truncateMiddle('abcdefghij', 2, 'middle')).toBe('a…')
    expect(truncateMiddle('abcdefghij', 1)).toBe('…')
    expect(truncateMiddle('abcdefghij', 0)).toBe('')
    expect(visibleWidth(truncateMiddle('你好，世界，宽度守卫', 7))).toBeLessThanOrEqual(7)
  })
})

describe('motion tables and cells', () => {
  it('steps each variant over its table, and breathes a shade every fourth step', () => {
    expect(LOADER_FRAMES.bloom).toHaveLength(10)
    expect(LOADER_FRAMES.fill).toHaveLength(12)
    expect(LOADER_FRAMES.gap).toHaveLength(8)
    expect(loaderFrameGlyph('gap', 9)).toBe('⣽')
    expect([0, 3, 4, 8, 12, 16, 20, 24].map(breathLevel)).toEqual([0.25, 0.25, 0.5, 0.8, 1, 0.8, 0.5, 0.25])
    expect(BREATH_LEVELS).toHaveLength(6)
    expect([undefined, 'braille', 'tide', 'bloom'].map(variant => loaderVariant(variant as never))).toEqual(['gap', 'gap', 'gap', 'bloom'])
  })

  it('paints a stepping cell in primary, the ASCII spinner in ASCII mode, and freezes under reduced motion', () => {
    expect(loaderCell('bloom', 1, { colors: tag })).toBe('<primary>✢</primary>')
    expect(loaderCell('fill', 5, { colors: tag, reducedMotion: true })).toBe('<primary>⡀</primary>')
    expect(loaderCell('gap', 5, { colors: tag, glyphs: 'ascii' })).toBe('<primary>\\</primary>')
  })

  it('blends the breath from the palette, brightest at primary itself, and falls back to the tone without truecolor', () => {
    expect(loaderCell('breath', 12, { colors: rgbColors })).toBe('\x1b[38;2;200;100;50m●\x1b[39m')
    expect(loaderCell('breath', 0, { colors: rgbColors })).toBe('\x1b[38;2;125;100;100m●\x1b[39m'.replace('125;100;100', '125;100;88'))
    expect(loaderCell('breath', 4, { colors: rgbColors, reducedMotion: true })).toBe(loaderCell('breath', 0, { colors: rgbColors }))
    expect(breathPaint(tag, 0.5)('x')).toBe('<primary>x</primary>')
    expect(breathPaint({ primary: truecolor(1, 2, 3), textMuted: identity }, 0.5)('x')).toBe('\x1b[38;2;1;2;3mx\x1b[39m')
  })

  it('sweeps a three-letter window over the label and keeps it still under reduced motion', () => {
    expect([0, 1, 4, 9, 10].map(frame => shimmerWindow(4, frame))).toEqual([-3, -2, 1, 6, -3])
    expect(shimmerText('abcd', 4, tag)).toBe('\x1b[1m<primary>a</primary>\x1b[22m\x1b[1m<primary>b</primary>\x1b[22m\x1b[1m<primary>c</primary>\x1b[22m<muted>d</muted>')
    expect(shimmerText('abcd', 4, tag, true)).toBe(shimmerText('abcd', 0, tag))
  })

  it('paints rich-text spans with their motion, and tells whether any moves', () => {
    const spans = [{ text: '', motion: 'loader' as const, variant: 'bloom' as const }, { text: ' ready', tone: 'muted' as const }]
    expect(hasMotion(spans)).toBe(true)
    expect(hasMotion([{ text: 'x' }])).toBe(false)
    expect(paintMotionSpans(spans, tag, 2)).toBe('<primary>✳</primary><muted> ready</muted>')
    expect(paintMotionSpans([{ text: 'ab', motion: 'shimmer' }], tag, 5, { reducedMotion: true })).toBe('<muted>a</muted><muted>b</muted>')
    expect(paintMotionSpans([{ text: '', motion: 'loader' }], tag, 3, { glyphs: 'ascii' })).toBe('<primary>/</primary>')
  })

  it('drains a transition linearly from `from` to the value over its milliseconds, once per revision', () => {
    const transitions = new UiProgressTransitions()
    const node = { kind: 'progress' as const, value: 10, max: 100, transition: { from: 90, ms: 400, rev: 1 } }
    expect(transitions.step('a', node, 5)).toEqual({ value: 90, animating: true })
    expect(transitions.step('a', node, 7)).toEqual({ value: 50, animating: true })
    expect(transitions.step('a', node, 9)).toEqual({ value: 10, animating: false })
    expect(transitions.step('a', node, 99)).toEqual({ value: 10, animating: false })
    expect(transitions.step('a', { ...node, transition: { ...node.transition, rev: 2 } }, 100)).toEqual({ value: 90, animating: true })
  })
})

describe('feedback painters', () => {
  it('draws a loader as its glyph, message, and elapsed time up to hours, or as the bare glyph', () => {
    expect(strip(renderLoader(ui.loader({ message: 'Working', elapsedMs: 3_725_000 }), 40, plainColors)[0]!)).toBe('⣾ Working 1h 2m')
    expect(strip(renderLoader(ui.loader({ variant: 'fill' }), 40, plainColors, 1)[0]!)).toBe('⣄')
    expect(strip(renderLoader(ui.loader({ message: '', variant: 'bloom' }), 40, plainColors)[0]!)).toBe('·')
    expect(strip(renderLoader(ui.loader({ message: 'Go', variant: 'breath' }), 40, plainColors, 0, 'unicode', true)[0]!)).toBe('● Go')
  })

  it('draws progress cells with a label, count, and percent, squeezed to the room', () => {
    const bar = (options: Parameters<typeof ui.progress>[0], width = 40) => strip(renderProgress(ui.progress(options), width, plainColors)[0]!)
    expect(bar({ label: 'Building', value: 6, max: 10, width: 10 })).toBe('Building ▰▰▰▰▰▰▱▱▱▱ 6/10')
    expect(bar({ value: 9, max: 10, width: 10, showCount: false, showPercent: true })).toBe('▰▰▰▰▰▰▰▰▰▱ 90%')
    expect(bar({ style: 'cells', value: 1, max: 4 })).toBe('▰▰▰▱▱▱▱▱▱▱ 1/4')
    expect(bar({ label: 'A very long label', value: 5, max: 10, width: 10 }, 20)).toHaveLength(20)
    expect(visibleWidth(bar({ label: 'Building', value: 6, max: 10, width: 10 }, 6))).toBeLessThanOrEqual(6)
    expect(renderProgress(ui.progress({ value: 5, max: 10, width: 4, tone: 'warning' }), 40, tag)[0]).toContain('<warning>▰▰</warning>')
  })

  it('draws the heading rule heavy for done and light for what is left, clipped to the room', () => {
    expect(renderProgress(ui.progress({ style: 'rule', value: 2, max: 8, width: 8 }), 40, tag)).toEqual(['<primary>━━</primary><muted>──────</muted>'])
    expect(strip(renderProgress(ui.progress({ style: 'rule', value: 8, max: 8 }), 10, plainColors)[0]!)).toBe('━'.repeat(10))
    expect(renderProgress(ui.progress({ style: 'rule', value: 8, max: 8, width: 4, tone: 'danger' }), 40, tag)[0]).toContain('<error>')
  })

  it('draws the legacy block bar with the new switches, and shows a shown value in place of the node value', () => {
    expect(visibleWidth(renderProgress(ui.progress({ value: 5, max: 10 }), 20, plainColors)[0]!)).toBe(20)
    expect(strip(renderProgress(ui.progress({ value: 5, max: 10, showCount: false, showPercent: true, tone: 'success' }), 20, plainColors)[0]!)).toMatch(/^█+░* 50%$/u)
    expect(strip(renderProgress(ui.progress({ label: 'Build', value: 5, max: 10 }), 30, plainColors, 2)[0]!)).toContain('2/10')
    expect(strip(renderProgress(ui.progress({ value: 5, max: 10 }), 20, plainColors)[0]!)).toContain('5/10')
  })

  it('draws a divider with its label and two dashes at least, and an empty state in muted text', () => {
    expect(strip(renderDivider(undefined, 6, plainColors)[0]!)).toBe('──────')
    expect(strip(renderDivider('Connection', 20, plainColors)[0]!)).toBe('── Connection ──────')
    expect(strip(renderDivider('Connection', 14, plainColors)[0]!)).toBe('── Connection ')
    expect(renderEmpty(ui.empty({ title: 'Nothing', description: 'Try' }), 40, tag)).toEqual(['<muted>Nothing</muted>', '<muted>Try</muted>'])
  })
})

describe('surface chrome', () => {
  const frame = (options: Partial<Parameters<typeof ui.surface>[0]>, width: number) => strip(renderSurfaceHead(ui.surface({ child: ui.text('x'), chrome: 'surface', ...options }), width, plainColors)[0]!)

  it('puts a right-aligned title in the corner with the badges at the left, eliding its start', () => {
    expect(frame({ title: 'Compose', titleAlign: 'right', badges: [{ text: 'dirty' }] }, 30)).toBe('╭ dirty ──────────── Compose ╮')
    expect(frame({ title: '~/work/mayfly/packages/mayfly', titleAlign: 'right' }, 20)).toMatch(/^╭─+ …\S+ ╮$/u)
    expect(frame({ title: 'Compose', titleAlign: 'right' }, 20)).toBe('╭───────── Compose ╮')
    expect(frame({ title: 'A very long title indeed', titleAlign: 'left' }, 14)).toMatch(/^╭ A very l…/u)
  })

  it('paints the border in the named tone on the head and the tail', () => {
    const node = ui.surface({ title: 'T', chrome: 'overlay', border: 'warning', child: ui.text('x') })
    expect(renderSurfaceHead(node, 10, tag)[0]).toContain('<warning>╭</warning>')
    expect(renderSurfaceTail(node, 10, tag)[0]).toBe('<warning>╰────────╯</warning>')
    expect(surfaceBorderPaint('overlay', tag)('x')).toBe('<borderFocus>x</borderFocus>')
    expect(surfaceBorderPaint('surface', tag)('x')).toBe('<border>x</border>')
  })
})

describe('content views', () => {
  const view = (node: Parameters<typeof renderCanonicalView>[0], width = 40) => renderCanonicalView(node, width, components, plainColors).map(strip)

  it('elides the middle or the start of a text row and styles it', () => {
    expect(view({ kind: 'text', content: '~/work/mayfly/packages/mayfly', overflow: 'middle' }, 12)).toEqual(['~/work…ayfly'])
    expect(view({ kind: 'text', content: 'a\nb/c/d/e/f/g/h', overflow: 'start' }, 6)).toEqual(['…f/g/h'])
    expect(renderCanonicalView({ kind: 'text', content: 'x', styles: ['strong', 'italic'] }, 10, components, plainColors)).toEqual(['\x1b[3m\x1b[1mx\x1b[22m\x1b[23m'])
  })

  it('aligns field labels, leaves an empty label bare, and indents a titled section body', () => {
    expect(view({ kind: 'fields', rows: [{ label: 'Provider', value: [{ text: 'DeepSeek' }] }, { label: '', value: [{ text: 'x' }] }, { label: 'Id', value: [{ text: '7' }] }] })).toEqual(['Provider: DeepSeek', '          x', 'Id:       7'])
    expect(view({ kind: 'sections', sections: [{ title: 'Open', body: { kind: 'text', content: 'body' } }, { body: { kind: 'text', content: 'bare' } }, { title: 'Shut', collapsed: true, body: { kind: 'text', content: 'x' } }, { collapsed: true, body: { kind: 'text', content: 'y' } }] })).toEqual(['Open', '  body', 'bare', 'Shut', '  …', '...'])
  })

  it('numbers code with a gutter, keeps wrapped rows under their code, and takes the diff options', () => {
    expect(view({ kind: 'code', code: 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj', numbered: true }, 20).slice(8)).toEqual([' 9 │ i', '10 │ j'])
    expect(view({ kind: 'code', code: 'abcdefghij', numbered: true }, 8)).toEqual(['1 │ abcd', '    efgh', '    ij'])
    const diff = view({ kind: 'diff', before: 'a\nb\nc', after: 'a\nB\nc', start: 40, numbered: false, hunkHeader: true, context: 0, maxRows: 1 }, 30)
    expect(diff[0]).toBe('@@ -40,3 +40,3 @@')
    expect(diff.at(-1)).toMatch(/…/u)
  })
})

describe('charts', () => {
  const rows = (chart: Parameters<typeof renderChartRows>[0], width = 40) => renderChartRows(chart, width, components, plainColors).map(strip)

  it('draws a sparkline as its label and cells on one row, scaled to the tallest value', () => {
    expect(rows(ui.chart({ chart: 'sparkline', values: [1, 2, 4, 8, null, 8], label: 'tokens' }))).toEqual(['tokens ▁▂▄▇▁▇'.replace('▇▁▇', '█▁█')].map(row => row))
    expect(rows(ui.chart({ chart: 'sparkline', values: [3, 6] }))).toEqual(['▄█'])
    expect(rows(ui.chart({ chart: 'sparkline', values: [] }))).toEqual([])
    expect(rows(ui.chart({ chart: 'sparkline', values: [], label: 'idle' }))).toEqual(['idle'])
    expect(rows(ui.chart({ chart: 'sparkline', values: Array.from({ length: 50 }, (_, index) => index), label: 'long' }), 12)[0]).toHaveLength(12)
    expect(rows(ui.chart({ chart: 'sparkline', values: [1, 2, 3], label: 'label' }), 2)[0]).toHaveLength(2)
  })

  it('draws a heatmap with a title, the header, one row per label, and a legend, in two cells or one', () => {
    const levels = [{ value: 0, label: 'low' }, { value: 1, label: 'mid' }, { value: 2, label: 'high' }, { value: 3, label: 'top' }]
    const heat = { chart: 'heatmap' as const, title: 'activity', columns: ['Mon', 'Tue'], rows: ['AM', 'Evening'], values: [[0, 3], [2, null]], levels }
    expect(rows(ui.chart(heat))).toEqual(['activity', '        Mon Tue', 'AM      ░░  ██', 'Evening ▓▓', 'legend: ░░ low  ▒▒ mid  ▓▓ high  ██ top'])
    expect(rows(ui.chart({ ...heat, title: undefined as never, cell: 1, columnLabels: ['J', 'F'] }), 12)).toEqual(['        JF', 'AM      ·▓', 'Evening ▒', 'legend: · lo'])
    expect(rows(ui.chart({ ...heat, columnLabels: ['Mo', 'Tu'] }))[1]).toBe('        Mo  Tu')
  })

  it.each(ADVERSARIAL)('keeps a heatmap and a sparkline inside their width over $name', ({ text }) => {
    for (const width of [1, 2, 5, 12, 40, 80]) {
      const heat = ui.chart({ chart: 'heatmap', title: text, columns: ['a', text], rows: [text], values: [[0, 1]], levels: [{ value: 0, label: text }, { value: 1, label: 'x' }] })
      for (const row of renderChartRows(heat, width, components, plainColors)) expect(visibleWidth(row)).toBeLessThanOrEqual(width)
      for (const row of renderChartRows(ui.chart({ chart: 'sparkline', values: [1, 2, 3], label: text }), width, components, plainColors)) expect(visibleWidth(row)).toBeLessThanOrEqual(width)
    }
  })
})
