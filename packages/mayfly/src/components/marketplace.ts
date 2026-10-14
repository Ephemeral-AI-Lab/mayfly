/**
 * The plugin marketplace: three tabs (Installed, Updates, Browse) over one grouped, slash-filtered list each, and from
 * 100 columns a detail that follows the cursor beside it (`patterns.splitView`); below that the list is alone and
 * `Enter` opens the detail panel. A row is a state icon and the name, with the source, the surfaces and the version at the right; the detail names the icon in words. The panel has no buttons: `i` install, `u` update, `x` remove, `s` source, `g` group, `a` update
 * all, `r` refresh, `/` filter; the hint row lists the keys the focused row can use. A restart that is pending stays
 * in the footer as a banner. Every text is final (translated by the command that publishes the facts).
 *
 * @module components/marketplace
 */

import { patterns, ui, type MayflyConfirmation, type MayflyInlineSpan, type MayflyListItem, type MayflySurfaceNode, type MayflyTone, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

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
  /** The surfaces the plugin contributes to, in order (`TUI`, `WEB`); a missing one reads `·`. Where the row is narrow the `letter` stands for the label. */
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
}

const TABS_ID = 'plugin-tabs'
const DETAIL_ID = 'plugin-detail'
/** Where a list that stands alone gives its surfaces and source the short texts: its row no longer fits the long ones. */
const COMPACT_BELOW = 56

/** The list id of a tab. */
export const listId = (tab: string): string => `plugins-${tab}`

/** Terminal cells of a text, counting East Asian wide characters as two (padding only; the painter measures for real). */
function cells(text: string): number {
  let total = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    total += (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ? 2 : 1
  }
  return total
}

const padEnd = (text: string, width: number): string => `${text}${' '.repeat(Math.max(0, width - cells(text)))}`

/** The widths of the row columns, equal on every row of a tab so they line up. */
interface Columns { readonly source: number, readonly version: number }

function rowItem(row: MarketplaceRow, columns: Columns, short: boolean, icons: boolean): MayflyListItem {
  const dim: MayflyTone | undefined = row.dim === true ? 'muted' : undefined
  const right: MayflyInlineSpan[] = []
  if (columns.source > 0) right.push({ text: padEnd(row.source ?? '', columns.source), tone: 'muted' }, { text: '  ' })
  if (row.surfaces !== undefined) {
    for (const [index, surface] of row.surfaces.entries()) {
      if (index > 0) right.push({ text: ' ' })
      const text = short ? surface.letter : surface.label
      right.push(surface.on ? { text, styles: ['strong'] } : { text: padEnd('·', cells(text)), tone: 'muted' })
    }
    right.push({ text: ' ' })
  }
  if (columns.version > 0) right.push({ text: padEnd(row.version ?? '', columns.version), ...dim === undefined ? {} : { tone: dim } })
  return {
    id: row.id, label: row.name,
    labelSpans: [...icons ? [{ text: `${row.glyph === '' ? ' ' : row.glyph} `, tone: row.glyphTone }] : [], { text: row.name, ...dim === undefined ? {} : { tone: dim } }],
    ...row.group === undefined ? {} : { group: row.group },
    right, searchText: row.searchText,
    ...row.unavailable === undefined || Object.keys(row.unavailable).length === 0 ? {} : { unavailableActions: row.unavailable },
  }
}

/**
 * The detail of one plugin: a title, a tagline, the note that leads for a deprecated or removed one, the description,
 * and titled field sections.
 * @param facts - the detail's texts.
 * @returns the detail document.
 */
export function PluginDetail(facts: PluginDetailFacts, height?: number, titled = true): MayflyUiNode {
  // A fixed viewport keeps the pane the same height whatever the plugin: the list never jumps while the cursor moves.
  return ui.scroll(ui.stack.column([
    ...titled ? [ui.child(ui.richText([{ text: facts.title, styles: ['strong'] }]))] : [],
    ui.child(ui.richText(facts.tagline)),
    ...facts.notes.map(note => ui.child(ui.text(note.text, { tone: note.tone, overflow: 'wrap' }))),
    ui.child(ui.text(facts.description, { tone: 'muted', overflow: 'wrap' })),
    ...facts.rows.length === 0 ? [] : [ui.child(ui.spacer()), ui.child(ui.fields(facts.rows))],
  ]), { id: DETAIL_ID, ...height === undefined ? { scrollbar: true } : { height, scrollbar: false } })
}

/**
 * The heights of the panel's viewport (rows) and the rows of the list-and-detail pane each leaves, after the panel's own
 * head (rule, title, tabs) and hint row: a short terminal gets a short pane (the detail scrolls) and a tall one a long pane.
 */
const DETAIL_HEIGHTS = [
  { minHeight: 34, height: 23 },
  { minHeight: 30, maxHeight: 33, height: 19 },
  { minHeight: 26, maxHeight: 29, height: 15 },
  { minHeight: 22, maxHeight: 25, height: 11 },
  { minHeight: 18, maxHeight: 21, height: 7 },
  { maxHeight: 17, height: 4 },
] as const


function tabActions(tab: MarketplaceTab, keys: MarketplaceKeys): MayflyUiNode {
  const selections = [{ pagePath: [{ controlId: TABS_ID, itemId: tab.id }], controlId: listId(tab.id) }]
  // An empty tab has no row to act on: only the keys that need none remain.
  return ui.actions({ id: `plugin-keys-${tab.id}`, items: [
    ...tab.rows.length === 0 ? [] : [
      { id: 'install', label: keys.install, key: 'i', hidden: true, selections },
      { id: 'update', label: keys.update, key: 'u', hidden: true, selections },
      { id: 'remove', label: keys.remove, semantic: 'delete' as const, hidden: true, confirm: keys.removeConfirm, selections },
      { id: 'source', label: keys.source, key: 's', hidden: true, selections },
      { id: 'group', label: keys.group, key: 'g', hidden: true },
    ],
    ...tab.id === 'updates' && tab.count > 0 ? [{ id: 'update-all', label: keys.updateAll, key: 'a', hidden: true, confirm: keys.updateAllConfirm }] : [],
    { id: 'refresh', label: keys.refresh, semantic: 'refresh' as const, hidden: true },
  ] })
}

function tabPage(tab: MarketplaceTab, facts: MarketplaceFacts): MayflyUiNode {
  const columns: Columns = {
    source: Math.max(0, ...tab.rows.map(row => cells(row.source ?? ''))),
    version: Math.max(0, ...tab.rows.map(row => cells(row.version ?? ''))),
  }
  // The icon column exists only where some row has an icon, so Browse (all plain) has none.
  const icons = tab.rows.some(row => row.glyph !== '')
  const groups = new Set(tab.rows.flatMap(row => row.group === undefined ? [] : [row.group])).size
  // Beside the detail Enter has nothing to open; where the list is alone it opens the detail panel.
  const list = (short: boolean, maxRows?: number): MayflyUiNode => ui.list({
    id: listId(tab.id), role: 'browse', acceptVerb: maxRows === undefined ? 'open' : 'none', filterable: true, filterMode: 'slash', marker: 'selection', groupGap: true,
    selectedIds: [], autofocus: true, ...maxRows === undefined ? {} : { maxRows },
    items: tab.rows.map(row => rowItem(row, columns, short, icons)),
    ...tab.focus === undefined ? {} : { focusItem: tab.focus },
    empty: ui.empty({ title: tab.emptyTitle, ...tab.emptyDescription === undefined ? {} : { description: tab.emptyDescription } }),
  })
  // Beside the detail the pane is as tall as the detail viewport for the panel's height, list and rule included, so
  // nothing moves while the cursor does. Where the list is alone it takes the room there is.
  const split = ui.stack.column(DETAIL_HEIGHTS.map(({ height, ...when }) => ui.child(patterns.splitView({
    // The pane is `height` rows: the list's rows, its group headings and the blank rows between them fit in it, or the list windows to leave room for the overflow and filter rows.
    list: list(false, tab.rows.length + Math.max(0, 2 * groups - 1) <= height ? tab.rows.length : Math.max(2, height - 2 - Math.min(2 * groups - 1, Math.floor(height / 2)))), aloneList: list(false), compactList: list(true), compactBelow: COMPACT_BELOW,
    separator: ui.text(Array.from({ length: height }, () => '│').join('\n'), { tone: 'muted' }),
    detail: facts.detail === undefined ? ui.text(facts.noDetail, { tone: 'muted' }) : PluginDetail(facts.detail, height),
    // Wide enough that the legend row (the longest text under the pane) ends before the rule.
    listWidth: 64,
  }), { when })))
  const legend: MayflyInlineSpan[] = tab.legend.flatMap((entry, index): MayflyInlineSpan[] => [
    ...index === 0 ? [] : [{ text: '   ' }],
    { text: entry.glyph, tone: entry.tone }, { text: ` ${entry.text}`, tone: 'muted' },
  ])
  return ui.stack.column([
    ui.child(split, { grow: 1, minSize: 4 }),
    ...legend.length === 0 ? [] : [ui.child(ui.richText(legend, { overflow: 'truncate' }))],
    ui.child(tabActions(tab, facts.keys)),
  ])
}

/**
 * The marketplace surface.
 * @param facts - the tabs, rows, detail, and texts.
 * @returns the overlay surface.
 */
export function PluginMarketplace(facts: MarketplaceFacts): MayflySurfaceNode {
  return ui.surface({
    chrome: 'overlay', title: facts.title, subtitle: facts.subtitle,
    child: ui.stack.column([
      ui.tabs({ id: TABS_ID, activeId: facts.activeTab, hintLabel: 'tabs', items: facts.tabs.map(tab => ({
        // The attention mark replaces a count, so a tab that needs attention carries its number in the label.
        id: tab.id, label: tab.attention === true ? `${tab.label} ${String(tab.count)}` : tab.label,
        ...tab.attention === true ? { attention: true } : { count: tab.count },
      })) }),
      ui.spacer(),
      ...facts.tabs.map(tab => ui.child(tabPage(tab, facts), { tab: { controlId: TABS_ID, itemId: tab.id } })),
    ]),
    ...facts.restartBanner === undefined ? {} : { footer: ui.richText([{ text: facts.restartBanner, tone: 'warning' }]) },
  })
}

/**
 * The detail panel that `Enter` opens where the list is alone (below 100 columns), and that `/plugin info` opens.
 * @param facts - the detail's texts.
 * @param title - the panel title.
 * @param keys - the panel's key texts, absent for a read-only panel.
 * @returns the overlay surface.
 */
export function PluginDetailPanel(facts: PluginDetailFacts, title: string, keys?: { readonly install: string, readonly update: string, readonly remove: string, readonly removeConfirm: MayflyConfirmation, readonly can: { readonly install: boolean, readonly update: boolean, readonly remove: boolean } }): MayflySurfaceNode {
  return ui.surface({
    chrome: 'overlay', title, escapeLabel: 'back',
    child: ui.stack.column([
      ui.child(PluginDetail(facts, undefined, false)),
      ...keys === undefined ? [] : [ui.child(ui.actions({ id: 'plugin-detail-keys', items: [
        ...keys.can.install ? [{ id: 'install', label: keys.install, key: 'i', hidden: true }] : [],
        ...keys.can.update ? [{ id: 'update', label: keys.update, key: 'u', hidden: true }] : [],
        ...keys.can.remove ? [{ id: 'remove', label: keys.remove, semantic: 'delete' as const, hidden: true, confirm: keys.removeConfirm }] : [],
      ] }))],
    ]),
  })
}

/**
 * The marketplace while the catalog loads.
 * @param title - the panel title.
 * @param message - the loader's message.
 * @returns the overlay surface.
 */
export function PluginMarketplaceLoading(title: string, message: string): MayflySurfaceNode {
  return ui.surface({ chrome: 'overlay', title, child: ui.loader({ message }) })
}

/**
 * The marketplace when the catalog is unreachable and nothing is cached.
 * @param title - the panel title.
 * @param message - why it is offline.
 * @param refresh - the label of the `r` key.
 * @returns the overlay surface.
 */
export function PluginMarketplaceOffline(title: string, message: string, refresh: string): MayflySurfaceNode {
  return ui.surface({
    chrome: 'overlay', title,
    child: ui.stack.column([
      ui.child(ui.text(message, { tone: 'danger', overflow: 'wrap' })),
      ui.child(ui.actions({ id: 'plugin-keys-offline', items: [{ id: 'refresh', label: refresh, semantic: 'refresh', hidden: true }] })),
    ]),
  })
}
