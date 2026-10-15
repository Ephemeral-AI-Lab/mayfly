/**
 * The stats panel: four tabs over one `patterns.statusPage`. Session is the live session as aligned rows; Account is the
 * provider of the current model (its key or sign-in, balance and links, read-only); History is the
 * activity heatmap (the weeks that fit), the date range, two columns of figures, and the token line; Models is the
 * tokens and cost per day as stacked columns, one colour per model, beside each model's share. The panel has no buttons: `r` cycles the range
 * (refreshes on Session), `w` switches the workspace scope, `c` copies the summary. Every text is final (translated by
 * the command that publishes the facts).
 *
 * @module components/stats-panel
 */

import { patterns, ui, type MayflyInlineSpan, type MayflySurfaceNode, type MayflyTone, type MayflyUiChild, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** One labelled row. */
export interface StatsRow {
  readonly label: string
  readonly value: readonly MayflyInlineSpan[]
}

/** The Session tab: the live session, one more block per model when it used several. */
export interface SessionTabFacts {
  readonly rows: readonly StatsRow[]
  readonly byModelTitle?: string | undefined
  readonly byModel: readonly StatsRow[]
  /** Shown instead of the rows while the session facts cannot be read. */
  readonly unavailable?: string | undefined
  readonly refresh: string
}

/** The Account tab: the provider of the current model as rows, with the state of the balance read under them. */
export interface AccountTabFacts {
  readonly rows: readonly StatsRow[]
  /** `⣾ checking balance…` while the read runs. */
  readonly loading?: string | undefined
  /** A muted line under the rows (`No balance information for this provider`). */
  readonly note?: string | undefined
}

/** The date range line and the workspace scope, shared by History and Models. */
export interface StatsRangeFacts {
  readonly ranges: readonly { readonly id: string, readonly label: string, readonly active: boolean }[]
  /** `all workspaces` or `this workspace`, at the right of the range line. */
  readonly scope: string
}

/** The index's state under the figures. */
export interface StatsIndexFacts {
  /** `indexing 12/80 sessions`, with the gap spinner, while sessions are read. */
  readonly loading?: string | undefined
  /** `latest 300 sessions`, `2 sessions could not be read`. */
  readonly note?: string | undefined
}

/** The texts of the keyed actions (their hint labels). */
export interface StatsKeys {
  readonly range: string
  readonly workspace: string
  readonly copy: string
}

/** One heatmap, drawn when the terminal is at least `minWidth` wide (the narrowest has none); 52 weeks need 57 cells beside the panel's gutters and scrollbar. */
export interface HeatmapVariant {
  readonly weeks: number
  readonly minWidth: number
  readonly monthLabels: readonly string[]
  /** Seven rows, Sunday first, of levels 0 to 4 (null after today). */
  readonly levels: readonly (readonly (number | null)[])[]
}

/** The History tab. */
export interface HistoryTabFacts extends StatsRangeFacts, StatsIndexFacts {
  readonly variants: readonly HeatmapVariant[]
  /** Seven names, one per weekday row, `''` for the rows left unnamed. */
  readonly rowLabels: readonly string[]
  /** The names of levels 0 to 4. */
  readonly levelLabels: readonly string[]
  readonly legend: { readonly less: string, readonly more: string }
  readonly left: readonly StatsRow[]
  readonly right: readonly StatsRow[]
  /** `Input 3.4k · Output 1.3m · …  ≈ ¥ 1,204`, muted. */
  readonly tokens: readonly MayflyInlineSpan[]
  /** Replaces everything under the range line when there is nothing to count. */
  readonly empty?: string | undefined
  readonly keys: StatsKeys
}

/** One model of the Models tab. */
export interface ModelBlock {
  readonly id: string
  /** `provider/model`, with the tone its line and its dot share. */
  readonly name: string
  readonly tone: MayflyTone
  /** `99.6%`. */
  readonly share: string
  /** The money, `≈ $ 1.20`, after the share; absent when the model has no price. */
  readonly amount?: string | undefined
  readonly lines: readonly string[]
}

/** One per-day chart of the Models tab. */
export interface ModelsChart {
  readonly title: string
  readonly xLabels: readonly string[]
  readonly series: readonly { readonly id: string, readonly label: string, readonly tone: MayflyTone, readonly points: readonly number[] }[]
}

/** The Models tab. */
export interface ModelsTabFacts extends StatsRangeFacts, StatsIndexFacts {
  /** Tokens per day, then money per day (absent when no model has a price). */
  readonly tokensChart?: ModelsChart | undefined
  readonly costChart?: ModelsChart | undefined
  readonly models: readonly ModelBlock[]
  readonly empty?: string | undefined
  readonly keys: StatsKeys
}

/** The facts of one stats panel. */
export interface StatsFacts {
  readonly title: string
  readonly activeTab: string
  readonly tabs: { readonly session: string, readonly account: string, readonly history: string, readonly models: string }
  /** A low balance puts a warning `!` on the Account tab. */
  readonly accountAttention: boolean
  readonly session: SessionTabFacts
  readonly account: AccountTabFacts
  readonly history: HistoryTabFacts
  readonly models: ModelsTabFacts
}

const TABS_ID = 'stats-tabs'
/** From this width the model blocks and the figures sit in two columns. */
const TWO_COLUMNS_FROM = 80
/** From this width the two Models charts sit side by side (each needs about 45 cells). */
const TWO_CHARTS_FROM = 100
/**
 * The grow weights of two equal columns. pi-tui hands out the free width in successive shares of what is left, so equal
 * weights come out as two thirds and one third; 5 and 8 (about the golden ratio) come out as halves.
 */
const COLUMN_GROW = [5, 8] as const
/** The panel height from which blank rows separate the blocks of a page; a shorter panel keeps them together. */
const ROOMY = { minHeight: 25 } as const

const rangeLine = (facts: StatsRangeFacts): MayflyUiNode => ui.richText([
  ...facts.ranges.flatMap((range, index): MayflyInlineSpan[] => [
    ...index === 0 ? [] : [{ text: ' · ', tone: 'muted' as const }],
    range.active ? { text: range.label, tone: 'primary' as const, styles: ['strong' as const] } : { text: range.label, tone: 'muted' as const },
  ]),
  { text: `   ${facts.scope}`, tone: 'muted' },
], { overflow: 'truncate' })

const status = (facts: StatsIndexFacts): MayflyUiNode[] => [
  ...facts.loading === undefined ? [] : [ui.richText([{ text: '', motion: 'loader', variant: 'gap' }, { text: ` ${facts.loading}`, tone: 'muted' }], { overflow: 'truncate' })],
  ...facts.note === undefined ? [] : [ui.richText([{ text: facts.note, tone: 'muted' }], { overflow: 'truncate' })],
]

function keysNode(id: string, keys: StatsKeys): MayflyUiNode {
  return ui.actions({ id, items: [
    { id: 'range', label: keys.range, key: 'r', hidden: true },
    { id: 'workspace', label: keys.workspace, key: 'w', hidden: true },
    { id: 'copy', label: keys.copy, semantic: 'copy', hidden: true },
  ] })
}

function sessionPage(facts: SessionTabFacts): MayflyUiNode {
  return scrolled('stats-session-scroll', facts.unavailable === undefined
    ? ui.stack.column([
      ui.child(ui.fields(facts.rows)),
      ...facts.byModel.length === 0 ? [] : [ui.child(ui.spacer()), ...facts.byModelTitle === undefined ? [] : [ui.child(ui.richText([{ text: facts.byModelTitle, styles: ['strong'] }]))], ui.child(ui.fields(facts.byModel))],
    ])
    : ui.text(facts.unavailable, { tone: 'danger', overflow: 'wrap' }),
  ui.actions({ id: 'stats-keys-session', items: [{ id: 'refresh', label: facts.refresh, semantic: 'refresh', hidden: true }] }))
}

function heatmap(facts: HistoryTabFacts, variant: HeatmapVariant): MayflyUiNode {
  return ui.chart({
    chart: 'heatmap', cell: 1,
    columns: variant.monthLabels.map((_label, index) => String(index)), columnLabels: variant.monthLabels,
    rows: facts.rowLabels, values: variant.levels,
    levels: facts.levelLabels.map((label, value) => ({ value, label, ...value === 0 ? { tone: 'muted' as const } : { tone: 'primary' as const } })),
    range: facts.legend,
  })
}

/** The figures in two columns from `TWO_COLUMNS_FROM`, in one below it, then the token line. */
function figures(facts: HistoryTabFacts): MayflyUiChild[] {
  return [
    ui.child(ui.stack.row([ui.child(ui.fields(facts.left), { grow: COLUMN_GROW[0], basis: 0 }), ui.child(ui.fields(facts.right), { grow: COLUMN_GROW[1], basis: 0 })], { gap: 2 }), { when: { minWidth: TWO_COLUMNS_FROM } }),
    ui.child(ui.fields([...facts.left, ...facts.right]), { when: { maxWidth: TWO_COLUMNS_FROM - 1 } }),
    ui.child(ui.spacer(), { when: ROOMY }),
    ui.child(ui.richText(facts.tokens, { overflow: 'wrap' })),
  ]
}

/**
 * The rows a page keeps for its content at each viewport height of the panel (its rule, title, tab strip and hint row
 * take the rest): a short terminal gets a short page that scrolls, a tall one the whole page.
 */
const PAGE_HEIGHTS = [
  { minHeight: 31, height: 24 },
  { minHeight: 25, maxHeight: 30, height: 18 },
  { maxHeight: 24, height: 10 },
] as const

/**
 * A tab page: the content in a viewport of at most the panel's page height that scrolls beyond it, the hidden keys beside
 * it. The panel keeps one height whichever tab is on show: core pads every page to the tallest (its tab-page hold).
 */
function scrolled(id: string, content: MayflyUiNode, keys?: MayflyUiNode): MayflyUiNode {
  return ui.stack.column([
    ...PAGE_HEIGHTS.map(({ height, ...when }) => ui.child(ui.scroll(content, { id, height, expandedHeight: height, fit: true, scrollbar: true }), { when })),
    ...keys === undefined ? [] : [ui.child(keys)],
  ])
}

function accountPage(facts: AccountTabFacts): MayflyUiNode {
  return scrolled('stats-account-scroll', ui.stack.column([
    ui.child(ui.fields(facts.rows)),
    ...status(facts).map(node => ui.child(node)),
  ]))
}

function historyPage(facts: HistoryTabFacts): MayflyUiNode {
  const variants = [...facts.variants].sort((a, b) => b.minWidth - a.minWidth)
  return scrolled('stats-history-scroll', ui.stack.column([
    ...variants.map((variant, index) => ui.child(heatmap(facts, variant), {
      when: { minWidth: variant.minWidth, ...index === 0 ? {} : { maxWidth: variants[index - 1]!.minWidth - 1 } },
    })),
    ui.child(ui.spacer(), { when: ROOMY }),
    ui.child(rangeLine(facts)),
    ui.child(ui.spacer(), { when: ROOMY }),
    ...facts.empty === undefined ? figures(facts) : [ui.child(ui.text(facts.empty, { tone: 'muted', overflow: 'wrap' }))],
    ...status(facts).map(node => ui.child(node)),
  ]), keysNode('stats-keys-history', facts.keys))
}

function modelBlock(model: ModelBlock): MayflyUiNode {
  return ui.stack.column([
    ui.child(ui.richText([{ text: '● ', tone: model.tone }, { text: model.name, styles: ['strong'] }], { overflow: 'truncate' })),
    ui.child(ui.text(model.amount === undefined ? model.share : `${model.share} · ${model.amount}`, { tone: 'muted', overflow: 'truncate' })),
    ...model.lines.map(line => ui.child(ui.text(line, { tone: 'muted', overflow: 'truncate' }))),
  ])
}

/** A per-day chart under its title: one stacked column per day, one colour per model, the tone of the model's block below. */
function chartBlock(chart: ModelsChart): MayflyUiNode {
  return ui.stack.column([
    ui.child(ui.richText([{ text: chart.title, styles: ['strong'] }], { overflow: 'truncate' })),
    ui.child(ui.chart({
      chart: 'bar', layout: 'stacked', orientation: 'vertical', height: 7, legend: false, yFormat: 'compact',
      categories: chart.xLabels,
      series: chart.series.map(series => ({ id: series.id, label: series.label, tone: series.tone, values: series.points })),
    })),
  ])
}

/** The two charts side by side from `TWO_CHARTS_FROM`, one above the other below it. */
function charts(facts: ModelsTabFacts): MayflyUiChild[] {
  const drawn = [facts.tokensChart, facts.costChart].filter(chart => chart !== undefined)
  if (drawn.length === 0) return []
  return [
    ui.child(ui.stack.row(drawn.map((chart, index) => ui.child(chartBlock(chart), { grow: COLUMN_GROW[index]!, basis: 0 })), { gap: 2 }), { when: { minWidth: TWO_CHARTS_FROM } }),
    ui.child(ui.stack.column(drawn.map(chart => ui.child(chartBlock(chart)))), { when: { maxWidth: TWO_CHARTS_FROM - 1 } }),
    ui.child(ui.spacer(), { when: ROOMY }),
  ]
}

function modelsPage(facts: ModelsTabFacts): MayflyUiNode {
  const pairs: ModelBlock[][] = []
  for (let index = 0; index < facts.models.length; index += 2) pairs.push(facts.models.slice(index, index + 2))
  return scrolled('stats-models-scroll', ui.stack.column([
    ...charts(facts),
    ui.child(rangeLine(facts)),
    ui.child(ui.spacer(), { when: ROOMY }),
    ...facts.empty === undefined ? [
      ui.child(ui.stack.column(pairs.map(pair => ui.child(ui.stack.row(pair.map((model, index) => ui.child(modelBlock(model), { grow: COLUMN_GROW[index]!, basis: 0 })), { gap: 2 })))), { when: { minWidth: TWO_COLUMNS_FROM } }),
      ui.child(ui.stack.column(facts.models.map(model => ui.child(modelBlock(model)))), { when: { maxWidth: TWO_COLUMNS_FROM - 1 } }),
    ] : [ui.child(ui.text(facts.empty, { tone: 'muted', overflow: 'wrap' }))],
    ...status(facts).map(node => ui.child(node)),
  ]), keysNode('stats-keys-models', facts.keys))
}

/**
 * The stats surface.
 * @param facts - the three tabs' facts.
 * @returns the overlay surface.
 */
export function StatsPanel(facts: StatsFacts): MayflySurfaceNode {
  return patterns.statusPage({
    title: facts.title,
    tabs: { id: TABS_ID, activeId: facts.activeTab, hintLabel: 'tabs', items: [
      { id: 'session', label: facts.tabs.session },
      { id: 'account', label: facts.tabs.account, ...facts.accountAttention ? { attention: true } : {} },
      { id: 'history', label: facts.tabs.history },
      { id: 'models', label: facts.tabs.models },
    ] },
    pages: {
      session: sessionPage(facts.session),
      account: accountPage(facts.account),
      history: historyPage(facts.history),
      models: modelsPage(facts.models),
    },
  })
}
