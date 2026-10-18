/**
 * The plugin marketplace: three tabs (Installed, Updates, Browse) over one grouped, slash-filtered list each. Above 100
 * columns the focused plugin's detail lives beside the list through the compose browser; below it the list is one page
 * and `Enter` shows the detail in the same panel, `Esc` returning. A row is a state icon and the name, its source, the
 * surfaces, and the version in list cells; the detail names the icon in words. The panel has no buttons: `i` install,
 * `u` update, `x` remove, `s` source, `g` group, `a` update all, `r` refresh, `/` filter; the hint row lists the keys the
 * focused row can use. A restart that is pending stays in the footer as a banner. Every text is final (translated by the
 * command that publishes the facts).
 *
 * @module components/marketplace
 */

import { browser, panel, tabs, ui, type MayflyConfirmation, type MayflyInlineSpan, type MayflyListCell, type MayflyListItem, type MayflySurfaceNode, type MayflyTone, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** The width from which the list and the detail share the panel; below it they are pages of the same panel. */
export const MARKET_BREAKPOINT = 100

/** One plugin of a tab's list. */
export interface MarketplaceRow {
  readonly id: string
  readonly name: string
  /** The heading the row sits under (`Tools · 5`); rows of one group are contiguous. */
  readonly group?: string | undefined
  /** The state icon: `✓` installed, `↑` an update (or the rest of an incomplete install), `!` deprecated, `✗` removed, `?` custom (installed, not from the marketplace). The detail says it in words. */
  readonly glyph: string
  readonly glyphTone: MayflyTone
  /** `official`, `dsh`, or `community`. */
  readonly source?: string | undefined
  /** The surfaces the plugin contributes to, in order (`TUI`, `WEB`). */
  readonly surfaces?: readonly { readonly letter: string, readonly label: string, readonly on: boolean }[] | undefined
  /** The version column (`1.4.0`, or `1.2.1→1.3.0` while an update is waiting). */
  readonly version?: string | undefined
  readonly dim?: boolean | undefined
  readonly searchText: string
  /** Actions the focused row cannot run, with the reason. */
  readonly unavailable?: Readonly<Record<string, string>> | undefined
}

/** One tab. */
export interface MarketplaceTab {
  readonly id: string
  readonly label: string
  readonly count: number
  /** The strip draws a warning `!` in place of the count. */
  readonly attention?: boolean | undefined
  readonly rows: readonly MarketplaceRow[]
  /** What the icons on show mean, in the order of the rows' icons: one muted row under the pane. */
  readonly legend: readonly { readonly glyph: string, readonly tone: MayflyTone, readonly text: string }[]
  readonly emptyTitle: string
  readonly emptyDescription?: string | undefined
  /** Moves the cursor to a row whenever `rev` changes (after a regroup). */
  readonly focus?: { readonly id: string, readonly rev: number } | undefined
}

/** The texts of the keyed actions (their hint labels). */
export interface MarketplaceKeys {
  readonly install: string
  readonly update: string
  readonly remove: string
  readonly source: string
  /** The grouping on show (`group: category`). */
  readonly group: string
  readonly refresh: string
  readonly updateAll: string
  readonly removeConfirm: MayflyConfirmation
  readonly updateAllConfirm: MayflyConfirmation
}

/** What a plugin's detail pane shows: what the row does not already say. */
export interface PluginDetailFacts {
  readonly title: string
  /** `official · Tools`, as spans. */
  readonly tagline: readonly MayflyInlineSpan[]
  /** Lines that need a look first: deprecated or removed, web-only, automation-only, partly installed. */
  readonly notes: readonly { readonly text: string, readonly tone: MayflyTone }[]
  readonly description: string
  readonly rows: readonly { readonly label: string, readonly value: readonly MayflyInlineSpan[] }[]
}

/** The facts of one marketplace. */
export interface MarketplaceFacts {
  readonly title: string
  /** The catalog's age, or the offline notice. */
  readonly subtitle: string
  readonly tabs: readonly MarketplaceTab[]
  readonly activeTab: string
  /** The detail of the focused row of the active tab; absent when the tab is empty. */
  readonly detail?: PluginDetailFacts | undefined
  /** Shown in the detail pane when no row is focused. */
  readonly noDetail: string
  readonly keys: MarketplaceKeys
  /** `↻ 2 changes apply after you restart Mayfly and start a new session`: stays until the restart. */
  readonly restartBanner?: string | undefined
  /** The id of the row the cursor is on; the keyed operations act on it. */
  readonly focusedRowId?: string | undefined
  /** Which page a narrow panel shows (`list` unless the detail was just opened). */
  readonly narrow?: 'list' | 'detail' | undefined
  /** `back` while a narrow detail page is up; `close` at the list and beside the wide detail. */
  readonly escapeLabel?: 'close' | 'back' | undefined
  /** The detail scroll's viewport; the browser fills the panel body with the same height. */
  readonly detailHeight?: number | undefined
}

const TABS_ID = 'plugin-tabs'
const DETAIL_ID = 'plugin-detail'
const LIST_WIDTH = 64

/** The list id of a tab. */
export const listId = (tab: string): string => `plugins-${tab}`

/** The columns a tab's rows carry; a column absent from every row is not drawn. */
interface RowColumns { readonly source: boolean, readonly surfaces: boolean, readonly version: boolean }

function surfaceSpans(row: MarketplaceRow): MayflyInlineSpan[] {
  if (row.surfaces === undefined) return []
  return row.surfaces.flatMap((surface, index): MayflyInlineSpan[] => [
    ...index === 0 ? [] : [{ text: ' ' }],
    surface.on ? { text: surface.label, styles: ['strong'] } : { text: surface.label, tone: 'muted' },
  ])
}

function rowItem(row: MarketplaceRow, icons: boolean, columns: RowColumns): MayflyListItem {
  const dim: MayflyTone | undefined = row.dim === true ? 'muted' : undefined
  const cells: MayflyListCell[] = []
  if (columns.source) cells.push({ spans: [{ text: row.source ?? '', tone: 'muted' }], min: 8, shed: 3 })
  if (columns.surfaces) cells.push({ spans: surfaceSpans(row), min: 7, shed: 2 })
  if (columns.version) cells.push({ spans: [{ text: row.version ?? '', ...dim === undefined ? {} : { tone: dim } }], align: 'right', min: 7, shed: 1 })
  return {
    id: row.id, label: row.name,
    labelSpans: [...icons ? [{ text: `${row.glyph === '' ? ' ' : row.glyph} `, tone: row.glyphTone }] : [], { text: row.name, ...dim === undefined ? {} : { tone: dim } }],
    ...row.group === undefined ? {} : { group: row.group },
    cells, searchText: row.searchText,
    ...row.unavailable === undefined || Object.keys(row.unavailable).length === 0 ? {} : { unavailableActions: row.unavailable },
  }
}

/**
 * The detail of one plugin: a title, a tagline, the note that leads for a deprecated or removed one, the description,
 * and titled field sections.
 * @param facts - the detail's texts.
 * @param height - a fixed viewport in rows; absent, the pane fills the room it is given.
 * @param titled - draw the plugin's title (the panel already names it on a narrow page).
 * @returns the detail document.
 */
export function PluginDetail(facts: PluginDetailFacts, height?: number, titled = true): MayflyUiNode {
  return ui.scroll(ui.stack.column([
    ...titled ? [ui.child(ui.richText([{ text: facts.title, styles: ['strong'] }]))] : [],
    ui.child(ui.richText(facts.tagline)),
    ...facts.notes.map(note => ui.child(ui.text(note.text, { tone: note.tone, overflow: 'wrap' }))),
    ui.child(ui.text(facts.description, { tone: 'muted', overflow: 'wrap' })),
    ...facts.rows.length === 0 ? [] : [ui.child(ui.spacer()), ui.child(ui.fields(facts.rows))],
  ]), { id: DETAIL_ID, ...height === undefined ? { scrollbar: true } : { height, scrollbar: false } })
}

/** The hidden keys of one tab: install, update, and remove stay, with their shared confirmations, on whichever page is up. */
function tabActions(tab: MarketplaceTab, keys: MarketplaceKeys, focusedRowId: string | undefined): MayflyUiNode {
  const row = focusedRowId === undefined ? tab.rows[0] : tab.rows.find(item => item.id === focusedRowId)
  const unavailable = row?.unavailable ?? {}
  const blocked = (id: string) => unavailable[id] === undefined ? {} : { disabled: true, disabledReason: unavailable[id]! }
  return ui.actions({ id: `plugin-keys-${tab.id}`, items: [
    ...row === undefined ? [] : [
      { id: 'install', label: keys.install, key: 'i', hidden: true, ...blocked('install') },
      { id: 'update', label: keys.update, key: 'u', hidden: true, ...blocked('update') },
      { id: 'remove', label: keys.remove, semantic: 'delete' as const, hidden: true, confirm: keys.removeConfirm, ...blocked('remove') },
      { id: 'source', label: keys.source, key: 's', hidden: true, ...blocked('source') },
      { id: 'group', label: keys.group, key: 'g', hidden: true },
    ],
    ...tab.id === 'updates' && tab.count > 0 ? [{ id: 'update-all', label: keys.updateAll, key: 'a', hidden: true, confirm: keys.updateAllConfirm }] : [],
    { id: 'refresh', label: keys.refresh, semantic: 'refresh' as const, hidden: true },
  ] })
}

function tabPage(tab: MarketplaceTab, facts: MarketplaceFacts): MayflyUiNode {
  const columns: RowColumns = {
    source: tab.rows.some(row => (row.source ?? '') !== ''),
    surfaces: tab.rows.some(row => row.surfaces !== undefined),
    version: tab.rows.some(row => row.version !== undefined),
  }
  // The icon column exists only where some row has an icon, so Browse (all plain) has none.
  const icons = tab.rows.some(row => row.glyph !== '')
  const list = ui.list({
    id: listId(tab.id), role: 'browse', acceptVerb: 'open', filterable: true, filterMode: 'slash', marker: 'selection', groupGap: true,
    selectedIds: [], autofocus: true,
    items: tab.rows.map(row => rowItem(row, icons, columns)),
    ...tab.focus === undefined ? {} : { focusItem: tab.focus },
    empty: ui.empty({ title: tab.emptyTitle, ...tab.emptyDescription === undefined ? {} : { description: tab.emptyDescription } }),
  })
  const legend: MayflyInlineSpan[] = tab.legend.flatMap((entry, index): MayflyInlineSpan[] => [
    ...index === 0 ? [] : [{ text: '   ' }],
    { text: entry.glyph, tone: entry.tone }, { text: ` ${entry.text}`, tone: 'muted' },
  ])
  const listPane = ui.stack.column([
    ui.child(list, { grow: 1, minSize: 1 }),
    ...legend.length === 0 ? [] : [ui.child(ui.richText(legend, { overflow: 'truncate' }))],
  ])
  const detailPane = facts.detail === undefined
    ? ui.stack.column([ui.child(ui.text(facts.noDetail, { tone: 'muted' }), { grow: 1 })])
    : ui.stack.column([ui.child(PluginDetail(facts.detail, facts.detailHeight), { grow: 1, minSize: 1 })])
  return ui.stack.column([
    ui.child(browser({ list: listPane, detail: detailPane, narrow: facts.narrow ?? 'list', listWidth: LIST_WIDTH, breakpoint: MARKET_BREAKPOINT }), { grow: 1, minSize: 4 }),
    ui.child(tabActions(tab, facts.keys, facts.focusedRowId)),
  ])
}

/**
 * The marketplace surface: one panel whose browser holds the list and the focused plugin's detail.
 * @param facts - the tabs, rows, detail, and texts.
 * @returns the panel surface.
 */
export function PluginMarketplace(facts: MarketplaceFacts): MayflySurfaceNode {
  return panel({
    title: facts.title, subtitle: facts.subtitle, escapeLabel: facts.escapeLabel ?? 'close',
    body: tabs({
      tabs: {
        id: TABS_ID, activeId: facts.activeTab, hintLabel: 'tabs',
        items: facts.tabs.map(tab => ({
          // The attention mark replaces a count, so a tab that needs attention carries its number in the label.
          id: tab.id, label: tab.attention === true ? `${tab.label} ${String(tab.count)}` : tab.label,
          ...tab.attention === true ? { attention: true } : { count: tab.count },
        })),
      },
      pages: Object.fromEntries(facts.tabs.map(tab => [tab.id, tabPage(tab, facts)])),
    }),
    ...facts.restartBanner === undefined ? {} : { footer: ui.richText([{ text: facts.restartBanner, tone: 'warning' }]) },
  })
}

/**
 * The marketplace while the catalog loads.
 * @param title - the panel title.
 * @param message - the loader's message.
 * @returns the panel surface.
 */
export function PluginMarketplaceLoading(title: string, message: string): MayflySurfaceNode {
  return panel({ title, escapeLabel: 'close', body: ui.loader({ message }) })
}

/**
 * The marketplace when the native plugin manager is not mounted: nothing can be installed, removed, or enabled.
 * @param title - the panel title.
 * @param message - why the native service is unavailable.
 * @returns the panel surface.
 */
export function PluginMarketplaceUnavailable(title: string, message: string): MayflySurfaceNode {
  return panel({ title, escapeLabel: 'close', body: ui.text(message, { tone: 'danger', overflow: 'wrap' }) })
}

/**
 * The marketplace when the catalog is unreachable and nothing is cached.
 * @param title - the panel title.
 * @param message - why it is offline.
 * @param refresh - the label of the `r` key.
 * @returns the panel surface.
 */
export function PluginMarketplaceOffline(title: string, message: string, refresh: string): MayflySurfaceNode {
  return panel({
    title, escapeLabel: 'close',
    body: ui.stack.column([
      ui.text(message, { tone: 'danger', overflow: 'wrap' }),
      ui.actions({ id: 'plugin-keys-offline', items: [{ id: 'refresh', label: refresh, semantic: 'refresh', hidden: true }] }),
    ]),
  })
}
