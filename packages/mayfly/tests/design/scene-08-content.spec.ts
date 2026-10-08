/**
 * Scene 8, Content (roadmap slice 1.3): text, rich text, fields and sections, code, markdown, the numbered diff,
 * charts, and the diagram, each page rebuilt with the real builders and compared cell by cell with the prototype.
 * Pages the real renderer draws differently on purpose are listed as accepted differences.
 */
import { Context } from '@deepseek-ai/cordis'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import { afterEach, describe, expect, it } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import { caption, diffReport, frameDiffs, goldenRows, paint } from './scene.ts'
import { pendingFor } from './pending.ts'
import { PROBE_PALETTE } from './parity.ts'
import { MayflyComponentsService } from '../../src/core/components.ts'
import { FakeTerminal } from '../core/fake-terminal.ts'
import type { MayflyComponents } from '../../src/core/types.ts'

type Tone = 'default' | 'muted' | 'primary' | 'accent' | 'user' | 'success' | 'warning' | 'danger'
type Style = 'strong' | 'italic' | 'strike'
const S = (text: string, tone?: Tone, styles?: readonly Style[]) => ({ text, ...(tone === undefined || tone === 'default' ? {} : { tone }), ...(styles === undefined ? {} : { styles }) })
const mu = (text: string) => S(text, 'muted')
const col = (...children: Parameters<typeof ui.stack.column>[0]) => ui.stack.column(children)
const TONES: readonly Tone[] = ['default', 'muted', 'primary', 'accent', 'user', 'success', 'warning', 'danger']

const WIDTH = 100

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

/** The real components service under the probe palette: the markdown component is the shipped one. */
function realComponents(): MayflyComponents {
  const ctx = new Context()
  contexts.push(ctx)
  return new MayflyComponentsService(ctx, { theme: { colors: PROBE_PALETTE } as never, tui: new TuiMainScreen(new FakeTerminal()) })
}

/** A page frame: the scene's caption, a blank row, then the body; a wrapped caption's continuation is plain in the kit (Δ20). */
async function page(frame: number, title: string, body: Parameters<typeof paint>[0], waive: readonly number[] = [], walk = 'pages', components?: MayflyComponents, more: readonly { readonly delta: string, readonly rows: readonly [number, number] }[] = []): Promise<string> {
  const rows = [...paint(caption(title), WIDTH), '', ...paint(body, WIDTH, components)]
  const waivers = [...waive.map(row => ({ delta: 'Δ20', rows: [row, row] as const })), ...more]
  return diffReport(await frameDiffs(goldenRows('08-content', walk, frame), rows, WIDTH, waivers, pendingFor('08-content', walk, frame)))
}

describe('scene 8 Content', () => {
  it('page 1: text in eight tones, wrap and truncate side by side, rich text, divider', async () => {
    const hdr = 'Prefer small diffs and always run the width scan before pushing.'
    const body = col(
      ...TONES.map(tone => ui.text(`${tone.padEnd(9)} sample in this tone`, { tone })), ui.spacer(),
      // The kit's `gap: 4` is a four-cell empty child here: a row's gap is at most two.
      ui.stack.row([ui.child(ui.text(hdr), { basis: 30 }), ui.child(ui.text(''), { basis: 4 }), ui.child(ui.text(hdr, { overflow: 'truncate' }), { basis: 30 })], { gap: 0 }),
      caption('wrap (default)                    truncate'), ui.spacer(),
      ui.richText([S('deepseek-chat High  '), S('PLAN', 'primary', ['strong']), S('  '), S('YOLO', 'warning', ['strong']), S('  '), S('italic', 'default', ['italic']), S('  '), S('struck', 'muted', ['strike']), S('  '), mu('⏵ 2 jobs')]),
      ui.spacer(), ui.divider(), ui.divider({ label: 'Connection' }),
    )
    expect(await page(0, 'page 1/7 (Ctrl+N): text, rich text, spacer, divider: eight tones, wrap or truncate, strong italic strike', body, [1])).toBe('')
  })

  it('page 2: aligned fields and sections with a collapsed body', async () => {
    const body = col(
      ui.fields([{ label: 'Provider', value: [S('DeepSeek')] }, { label: 'Balance', value: [S('¥ 128.40', 'default', ['strong']), mu(' available')] }, { label: 'Status', value: [S('✓ ', 'success'), S('signed in')] }]), ui.spacer(),
      ui.sections([{ title: 'Connection', body: ui.fields([{ label: 'Name', value: [S('production')] }, { label: 'Endpoint', value: [S('https://api.example.com/v1')] }]) }, { title: 'Behaviour', collapsed: true, body: ui.text('hidden') }, { body: ui.text('x'), collapsed: true }]),
    )
    expect(await page(1, 'page 2/7 (Ctrl+N): fields (key/value) and sections (bold title, body; collapsed shows the title only)', body, [1])).toBe('')
  })

  it('page 3: highlighted code and markdown', async () => {
    const body = col(
      caption('ui.code — highlighted by language (h toggles)'),
      ui.code(["const frame = glyphFor(state)", "if (state.mode === 'waiting') {", "  return { kind: 'loader', variant: 'gap' }", '}'].join('\n'), { language: 'typescript' }), ui.spacer(),
      caption('ui.markdown'),
      ui.markdown('# Release notes\n- Hero copy now reads *Ship agent UI in a keystroke*\n- Width scan covers the **new panels**\n> a quote reads muted\n```ts\nconst a = 1\n```'),
    )
    // The kit's wrap drops the indent of the third code line (Δ20).
    expect(await page(2, 'page 3/7 (Ctrl+N): markdown (code fences highlighted) and code (muted language name, then the lines)', body, [6], 'pages', realComponents(), [{ delta: 'Δ21', rows: [8, 40] }])).toBe('')
  })

  const EDIT_BEFORE = ["  const moon = state.mode === 'waiting'", '  const frame = moon', '  const now = activityNow()', '  const a = 1', '  const b = 2', '  const c = 3', '  const d = 4', "  return { kind: 'stack', direction: 'column',"].join('\n')
  const EDIT_AFTER = ["  const moon = state.mode === 'waiting'", '  const frame = glyphFor(state)', '  const now = activityNow()', '  const a = 1', '  const b = 2', '  const c = 3', '  const d = 4', "  return { kind: 'stack', direction: 'column',"].join('\n')
  const diffPage = (numbered: boolean) => col(
    caption(`numbered ${numbered ? 'on' : 'off'} (d toggles); an @@ header names the hunk`),
    ui.diff(EDIT_BEFORE, EDIT_AFTER, { start: 41, numbered, hunkHeader: true, context: 1 }),
  )
  const DIFF_TITLE = 'page 4/7 (Ctrl+N): diff: two strings in, aligned rows out — numbered gutters, −/+ and color, ⋯ between hunks'

  it('page 4: a numbered diff with a hunk header, and the d walk with the gutters off', async () => {
    expect(await page(3, DIFF_TITLE, diffPage(true), [1])).toBe('')
    expect(await page(4, DIFF_TITLE, diffPage(false), [1], 'diff')).toBe('')
  })

  it('draws a diff node with the defaults, a start line, a row budget, and a context of zero', () => {
    const rows = (options: Parameters<typeof ui.diff>[2]) => paint(ui.diff('a\nb\nc\nd\ne', 'a\nB\nc\nd\nE', options), 60).map(row => row.replace(/\x1b\[[0-9;]*m/gu, ''))
    expect(rows({})[0]).toBe('    1   1 │   a')
    expect(rows({ start: 10 })[0]).toContain(' 10  10 │')
    expect(rows({ context: 0 }).filter(row => row.includes('⋯'))).toHaveLength(2)
    expect(rows({ maxRows: 2 }).at(-1)).toMatch(/^ {2}… \+\d+ rows · Ctrl\+O$/u)
  })

  const SPARK = { chart: 'sparkline', values: [3, 5, 4, 8, 6, 9, 7, 5, 4, 6, 8, 10], label: 'tokens' } as const
  const HEAT = {
    chart: 'heatmap', title: 'activity', columns: ['Mon', 'Tue', 'Wed', 'Thu'], rows: ['AM', 'PM'], values: [[0, 1, 2, 2], [0, 1, 2, 1]],
    levels: [{ value: 0, label: 'low', tone: 'muted' }, { value: 1, label: 'mid', tone: 'warning' }, { value: 2, label: 'high', tone: 'success' }],
  } as const

  it('page 5: the sparkline and the heatmap with its legend match; the other bars are the library chart (Δ23)', async () => {
    const golden = goldenRows('08-content', 'pages', 4)
    expect(diffReport(await frameDiffs(golden.slice(2, 3), paint(ui.chart(SPARK), WIDTH), WIDTH))).toBe('')
    expect(diffReport(await frameDiffs(golden.slice(-5), paint(ui.chart(HEAT), WIDTH), WIDTH))).toBe('')
    const bars = paint(ui.chart({ chart: 'bar', orientation: 'horizontal', layout: 'normalized', title: 'normalized', categories: ['mon', 'tue'], series: [{ id: 'a', values: [12, 8] }, { id: 'b', values: [8, 14] }] }), WIDTH)
    expect(bars.map(row => row.replace(/\x1b\[[0-9;]*m/gu, '')).filter(row => ['normalized', 'mon', 'tue'].includes(row))).toEqual(['normalized', 'mon', 'tue'])
  })

  it('draws the one-cell heatmap of a year with its month labels, and a blank for a value with no level', () => {
    const weeks = 12
    const days = ['Mon', 'Wed', 'Fri']
    const levels = [{ value: 0, label: 'none', tone: 'muted' as const }, { value: 1, label: 'some', tone: 'success' as const }, { value: 2, label: 'more', tone: 'success' as const }, { value: 3, label: 'most', tone: 'success' as const }, { value: 4, label: 'peak', tone: 'success' as const }]
    const columnLabels = Array.from({ length: weeks }, (_, week) => week === 0 ? 'Jan' : week === 5 ? 'Feb' : '')
    const rows = paint(ui.chart({
      chart: 'heatmap', cell: 1, columns: Array.from({ length: weeks }, (_, week) => `w${String(week)}`), columnLabels, rows: days,
      values: days.map((_, day) => Array.from({ length: weeks }, (_, week) => (day === 2 && week === 11 ? null : (week + day) % 5))), levels,
    }), 60).map(row => row.replace(/\x1b\[[0-9;]*m/gu, ''))
    expect(rows).toEqual([
      '     Jan  Feb',
      'Mon  ·░▒▓█·░▒▓█·░',
      'Wed  ░▒▓█·░▒▓█·░▒',
      'Fri  ▒▓█·░▒▓█·░▒',
      `legend: · none  ░ some  ▒ more  ▓ most  █ peak`,
    ])
  })

  it('page 6: line, point, and vertical bar charts are the library charts (Δ23), each drawn with its title', () => {
    const rows = paint(col(
      ui.chart({ chart: 'line', title: 'latency (ms)', xLabel: 'turn', series: [{ id: 's', tone: 'accent', points: Array.from({ length: 30 }, (_, x) => ({ x, y: Math.round(120 + 90 * Math.sin(x / 5) + x * 4) })) }] }), ui.spacer(),
      ui.chart({ chart: 'point', title: 'point', series: [{ id: 's', tone: 'success', points: Array.from({ length: 20 }, (_, x) => ({ x, y: (x * 7) % 11 })) }], height: 5 }), ui.spacer(),
      ui.chart({ chart: 'bar', title: 'vertical', categories: ['mon', 'tue', 'wed', 'thu'], series: [{ id: 'a', tone: 'warning', values: [3, 5, 2, 4] }], height: 5 }),
    ), WIDTH).map(row => row.replace(/\x1b\[[0-9;]*m/gu, '').trimEnd())
    for (const title of ['latency (ms)', 'point', 'vertical']) expect(rows).toContain(title)
    expect(rows.some(row => row.includes('turn'))).toBe(true)
  })

  it('page 7: a diagram within budget draws as boxes and one over budget falls back to its source (Δ23)', () => {
    const within = paint(ui.diagram('flowchart LR\n  queue --> agent --> tools'), WIDTH, realComponents()).map(row => row.replace(/\x1b\[[0-9;]*m/gu, ''))
    expect(within.join('\n')).toMatch(/queue[\s\S]*agent[\s\S]*tools/u)
    expect(within.join('\n')).not.toContain('mermaid')
    const source = Array.from({ length: 30 }, (_, index) => `  n${String(index)} --> n${String(index + 1)}`).join('\n')
    const over = paint(ui.diagram(source), WIDTH, realComponents()).map(row => row.replace(/\x1b\[[0-9;]*m/gu, ''))
    expect(over.join('\n')).toContain('mermaid')
    expect(over.join('\n')).toContain('n29 --> n30')
  })

  it('the h walk: the code node always highlights, so the kit\'s flat user-tone frame differs only in the code body (Δ22)', async () => {
    const body = col(
      caption('ui.code — one flat tone (h toggles)'),
      ui.code(["const frame = glyphFor(state)", "if (state.mode === 'waiting') {", "  return { kind: 'loader', variant: 'gap' }", '}'].join('\n'), { language: 'typescript' }),
    )
    const rows = [...paint(caption('page 3/7 (Ctrl+N): markdown (code fences highlighted) and code (muted language name, then the lines)'), WIDTH), '', ...paint(body, WIDTH)]
    const diffs = await frameDiffs(goldenRows('08-content', 'highlight', 3).slice(0, rows.length), rows, WIDTH, [{ delta: 'Δ20', rows: [6, 6] }, { delta: 'Δ22', rows: [2, 7] }])
    expect(diffReport(diffs)).toBe('')
  })
})
