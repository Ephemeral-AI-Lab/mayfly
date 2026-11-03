/** The stats panel surface: the four tab pages, their responsive columns and
 * heatmap widths, the page-height scroll windows, the keyed hints, and the
 * empty/loading/note states.
 * @module @ephemeral-ai/mayfly/tests/components/stats-panel
 */
import { describe, expect, it } from 'vitest'
import type { MayflyInlineSpan, MayflyTone } from '@ephemeral-ai/mayfly-ui'
import { StatsPanel, type StatsFacts, type StatsRow } from '../../src/components/stats-panel.ts'
import { compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import type { MayflyComponents } from '../../src/core/types.ts'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { plainColors, plainText } from '../helpers.ts'

const components = { visibleWidth, truncateToWidth, wrapText: wrapTextWithAnsi } as unknown as MayflyComponents
const colors = plainColors()

const text = (value: string, tone?: MayflyTone): readonly MayflyInlineSpan[] => tone === undefined ? [{ text: value }] : [{ text: value, tone }]
const row = (label: string, value: string, tone?: MayflyTone): StatsRow => ({ label, value: text(value, tone) })
const keys = { range: 'dates', workspace: 'workspace', copy: 'copy' }

function facts(overrides: Partial<StatsFacts> = {}): StatsFacts {
  return {
    title: 'Stats', activeTab: 'session',
    tabs: { session: 'Session', account: 'Account', history: 'History', models: 'Models' },
    accountAttention: false,
    session: {
      rows: [row('Working directory', '/repo'), row('Agent', 'idle'), row('Turns', '3 turns · 7 steps')],
      byModel: [], refresh: 'refresh',
    },
    account: { rows: [row('Provider', 'deepseek-official'), row('Checked', 'just now', 'muted')] },
    history: {
      ranges: [
        { id: 'all', label: 'All time', active: false },
        { id: '7d', label: 'Last 7 days', active: true },
        { id: '30d', label: 'Last 30 days', active: false },
      ],
      scope: 'all workspaces',
      variants: [
        { weeks: 52, minWidth: 64, monthLabels: ['@'], levels: [[4], [0], [0], [0], [0], [0], [0]] },
        { weeks: 26, minWidth: 38, monthLabels: ['~'], levels: [[3], [0], [0], [0], [0], [0], [0]] },
        { weeks: 13, minWidth: 0, monthLabels: ['&'], levels: [[2], [0], [0], [0], [0], [0], [0]] },
      ],
      rowLabels: ['', 'Mon', '', 'Wed', '', 'Fri', ''],
      levelLabels: ['0', '1', '2', '3', '4'],
      legend: { less: 'Less', more: 'More' },
      left: [row('Favorite model', 'deepseek/flash'), row('Sessions', '2')],
      right: [row('Total tokens', '1.2m'), row('Longest streak', '2 days')],
      tokens: text('Input 1m · Output 200k', 'muted'),
      keys,
    },
    models: {
      ranges: [
        { id: 'all', label: 'All time', active: false },
        { id: '7d', label: 'Last 7 days', active: true },
        { id: '30d', label: 'Last 30 days', active: false },
      ],
      scope: 'all workspaces',
      tokensChart: {
        title: 'Tokens per day', xLabels: ['Oct 12', 'Oct 13', 'Oct 14'],
        series: [
          { id: 'deepseek\u0000flash', label: 'deepseek/flash', tone: 'accent', points: [1, 2, 3] },
          { id: 'deepseek\u0000pro', label: 'deepseek/pro', tone: 'success', points: [4, 5, 6] },
        ],
      },
      costChart: {
        title: 'Cost per day (USD)', xLabels: ['Oct 12', 'Oct 13', 'Oct 14'],
        series: [{ id: 'deepseek\u0000flash', label: 'deepseek/flash', tone: 'accent', points: [0.1, 0.2, 0.3] }],
      },
      models: [
        { id: 'deepseek\u0000flash', name: 'deepseek/flash', tone: 'accent', share: '66.7%', amount: '≈ $ 1.20', lines: ['Input 1m · Output 200k', 'Cache read 0 · Cache write 0'] },
        { id: 'deepseek\u0000pro', name: 'deepseek/pro', tone: 'success', share: '33.3%', lines: ['Input 900k · Output 100k', 'Cache read 0 · Cache write 0'] },
      ],
      keys,
    },
    ...overrides,
  }
}

function compile(value: StatsFacts, width: number, rows = 40) {
  const result = compileMayflyUiNode(StatsPanel(value), {
    components, colors, getViewport: () => ({ columns: width, rows }), screenMode: 'alternate', emit: () => {},
  })
  if (!result.ok) throw new Error(result.message)
  return {
    component: result.value.component,
    render: (renderWidth = width): string[] => result.value.component.render(renderWidth),
  }
}

const joined = (value: StatsFacts, width: number, rows = 40): string => compile(value, width, rows).render().join('\n')
const shown = (value: StatsFacts, width: number, rows = 40): string[] => compile(value, width, rows).render().map(plainText)

describe('StatsPanel', () => {
  it('renders the title, tabs, session fields, and the keyed back row', () => {
    const frame = shown(facts(), 80)
    const content = frame.join('\n')
    expect(content).toContain('Stats')
    expect(content).toContain('Session')
    expect(content).toContain('Account')
    expect(content).toContain('History')
    expect(content).toContain('Models')
    expect(content).toContain('Working directory')
    expect(content).toContain('/repo')
    expect(content).toContain('3 turns · 7 steps')
    expect(content).toContain('Working directory')
    expect(frame.every(line => visibleWidth(line) <= 80)).toBe(true)
  })

  it('renders the by-model block and the unavailable state on the session page', () => {
    const byModel = facts({
      session: {
        rows: [row('Working directory', '/repo')],
        byModelTitle: 'By model',
        byModel: [row('deepseek/flash', '1m tokens · ≈ $ 1.00'), row('deepseek/pro', '900k tokens')],
        refresh: 'refresh',
      },
    })
    expect(joined(byModel, 80)).toContain('By model')
    expect(joined(byModel, 80)).toContain('deepseek/flash')
    expect(joined(byModel, 80)).toContain('900k tokens')
    const untitled = facts({ session: { rows: [row('Agent', 'idle')], byModel: [row('deepseek/flash', '1m tokens')], refresh: 'refresh' } })
    expect(joined(untitled, 80)).toContain('1m tokens')
    expect(joined(untitled, 80)).not.toContain('By model')
    const unavailable = facts({ session: { rows: [], byModel: [], unavailable: 'Session information unavailable', refresh: 'refresh' } })
    const page = joined(unavailable, 80)
    expect(page).toContain('Session information unavailable')
    expect(page).not.toContain('Working directory')
  })

  it('renders the account rows, the balance loading line, and the attention mark', () => {
    const account = facts({
      activeTab: 'account', accountAttention: true,
      account: { rows: [row('Provider', 'DeepSeek'), row('Balance', '≈ ¥ 3.02')], loading: 'checking balance…', note: '2 sessions could not be read' },
    })
    const frame = shown(account, 80)
    const content = frame.join('\n')
    expect(content).toContain('Provider')
    expect(content).toContain('DeepSeek')
    expect(content).toContain('checking balance…')
    expect(content).toContain('2 sessions could not be read')
    expect(content).toMatch(/Account\s*!/u)
    expect(frame.every(line => visibleWidth(line) <= 80)).toBe(true)
  })

  it('chooses the heatmap variant that fits the width', () => {
    const wide = joined(facts({ activeTab: 'history' }), 120)
    expect(wide).toContain('@')
    expect(wide).not.toContain('~')
    expect(wide).not.toContain('&')
    const medium = joined(facts({ activeTab: 'history' }), 50)
    expect(medium).toContain('~')
    expect(medium).not.toContain('@')
    const narrow = joined(facts({ activeTab: 'history' }), 30)
    expect(narrow).toContain('&')
    expect(narrow).not.toContain('~')
    expect(narrow).not.toContain('@')
  })

  it('puts the history figures in two columns from eighty cells and one below it', () => {
    const wide = shown(facts({ activeTab: 'history' }), 100)
    const wideRows = wide.filter(line => line.includes('Favorite model') || line.includes('Total tokens'))
    expect(wideRows.some(line => line.includes('Favorite model') && line.includes('Total tokens'))).toBe(true)
    const narrow = shown(facts({ activeTab: 'history' }), 60)
    const narrowRows = narrow.filter(line => line.includes('Favorite model') || line.includes('Total tokens'))
    expect(narrowRows.some(line => line.includes('Favorite model') && line.includes('Total tokens'))).toBe(false)
    expect(narrow.join('\n')).toContain('Input 1m · Output 200k')
  })

  it('replaces the history figures with the empty reason and shows index state', () => {
    const empty = facts({
      activeTab: 'history',
      history: { ...facts().history, empty: 'No session with a turn yet · 5 stored sessions found', loading: 'indexing 1/5 sessions' },
    })
    const content = joined(empty, 80)
    expect(content).toContain('No session with a turn yet · 5 stored sessions found')
    expect(content).toContain('indexing 1/5 sessions')
    expect(content).not.toContain('Favorite model')
    const note = facts({ activeTab: 'history', history: { ...facts().history, note: 'latest 120 sessions' } })
    expect(joined(note, 80)).toContain('latest 120 sessions')
  })

  it('renders both model charts side by side from one hundred cells and stacked below', () => {
    const wide = shown(facts({ activeTab: 'models' }), 120)
    expect(wide.some(line => line.includes('Tokens per day') && line.includes('Cost per day (USD)'))).toBe(true)
    const narrow = shown(facts({ activeTab: 'models' }), 90)
    expect(narrow.some(line => line.includes('Tokens per day') && line.includes('Cost per day (USD)'))).toBe(false)
    expect(narrow.join('\n')).toContain('Tokens per day')
    expect(narrow.join('\n')).toContain('Cost per day (USD)')
  })

  it('puts the model blocks in two columns from eighty cells and one below', () => {
    const wide = shown(facts({ activeTab: 'models' }), 100)
    expect(wide.some(line => line.includes('deepseek/flash') && line.includes('deepseek/pro'))).toBe(true)
    const narrowFacts = facts({
      activeTab: 'models',
      models: { ...facts().models, tokensChart: undefined, costChart: undefined },
    })
    const narrow = shown(narrowFacts, 60)
    expect(narrow.some(line => line.includes('deepseek/flash') && line.includes('deepseek/pro'))).toBe(false)
    expect(narrow.join('\n')).toContain('66.7% · ≈ $ 1.20')
    expect(narrow.join('\n')).toContain('Input 1m · Output 200k')
  })

  it('renders one chart when only the token chart exists and the empty reason instead of blocks', () => {
    const oneChart = facts({
      activeTab: 'models',
      models: { ...facts().models, costChart: undefined },
    })
    const content = joined(oneChart, 120)
    expect(content).toContain('Tokens per day')
    expect(content).not.toContain('Cost per day')
    const empty = facts({
      activeTab: 'models',
      models: { ...facts().models, tokensChart: undefined, costChart: undefined, models: [], empty: 'No session with a turn yet · 5 stored sessions found' },
    })
    expect(joined(empty, 80)).toContain('No session with a turn yet · 5 stored sessions found')
    expect(joined(empty, 80)).not.toContain('deepseek/flash')
  })

  it('shows the models index state under the range line', () => {
    const bare = { ...facts().models, tokensChart: undefined, costChart: undefined, models: [] }
    const loading = facts({ activeTab: 'models', models: { ...bare, loading: 'indexing 3/8 sessions' } })
    expect(joined(loading, 80)).toContain('indexing 3/8 sessions')
    const note = facts({ activeTab: 'models', models: { ...bare, note: '3 sessions could not be read' } })
    expect(joined(note, 80)).toContain('3 sessions could not be read')
  })

  it('keeps every tab inside the terminal width at common sizes', () => {
    for (const tab of ['session', 'account', 'history', 'models'] as const) {
      for (const width of [30, 40, 60, 80, 120, 160]) {
        const frame = shown(facts({ activeTab: tab }), width)
        expect(frame.every(line => visibleWidth(line) <= width), `${tab} at ${String(width)}`).toBe(true)
      }
    }
  })

  it('keeps a short panel to its page height while a tall panel has room to spare', () => {
    for (const rows of [24, 30, 31]) {
      const frame = show(facts(), 80, rows)
      expect(frame.length).toBeLessThanOrEqual(rows)
    }
    const tall = compile(facts(), 80, 40)
    expect(tall.render().length).toBeGreaterThan(0)
  })

  it('exposes the hidden keyed actions for each page', () => {
    const session = JSON.stringify(StatsPanel(facts()))
    expect(session).toContain('"id":"stats-keys-session"')
    expect(session).toContain('"id":"refresh"')
    const history = JSON.stringify(StatsPanel(facts({ activeTab: 'history' })))
    expect(history).toContain('"id":"stats-keys-history"')
    expect(history).toContain('"key":"r"')
    expect(history).toContain('"key":"w"')
    expect(history).toContain('"semantic":"copy"')
    expect(JSON.stringify(StatsPanel(facts({ activeTab: 'account', accountAttention: true })))).toContain('"attention":true')
  })

  it('draws the models chart as a stacked vertical bar chart with compact labels', () => {
    const node = JSON.stringify(StatsPanel(facts({ activeTab: 'models' })))
    expect(node).toContain('"chart":"bar"')
    expect(node).toContain('"layout":"stacked"')
    expect(node).toContain('"orientation":"vertical"')
    expect(node).toContain('"yFormat":"compact"')
    expect(node).toContain('"legend":false')
    expect(node).toContain('deepseek/flash')
  })
})

/** Raw frame rows for the height test, without stripping or joining. */
function show(value: StatsFacts, width: number, rows: number): string[] {
  return compile(value, width, rows).render()
}
