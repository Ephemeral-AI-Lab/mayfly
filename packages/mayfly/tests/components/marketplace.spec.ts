/**
 * Component tests for the plugin marketplace surface: the row columns and
 * their wide-character padding, grouped/attention tabs, the detail viewport,
 * the keyed detail panel, and the loading, unavailable, and offline states.
 */

import { describe, expect, it } from 'vitest'
import {
  PluginDetail,
  PluginDetailPanel,
  PluginMarketplace,
  PluginMarketplaceLoading,
  PluginMarketplaceOffline,
  PluginMarketplaceUnavailable,
  type MarketplaceFacts,
  type MarketplaceKeys,
  type MarketplaceRow,
  type MarketplaceTab,
  type PluginDetailFacts,
} from '../../src/components/marketplace.ts'

/** The keyed action texts every panel needs. */
const KEYS: MarketplaceKeys = {
  install: 'install', update: 'update', remove: 'remove', source: 'source',
  group: 'group: category', refresh: 'refresh', updateAll: 'update all',
  removeConfirm: { title: 'Remove the selected plugin?', detail: 'It applies after restart.', confirmLabel: 'Remove', tone: 'danger' },
  updateAllConfirm: { title: 'Update every plugin?', detail: 'It applies after restart.', confirmLabel: 'Update' },
}

/** One marketplace row, every optional field absent unless overridden. */
function row(id: string, overrides: Partial<MarketplaceRow> = {}): MarketplaceRow {
  return { id, name: id, glyph: '', glyphTone: 'muted', searchText: id, ...overrides }
}

/** One tab over the given rows. */
function tab(id: string, rows: readonly MarketplaceRow[], overrides: Partial<MarketplaceTab> = {}): MarketplaceTab {
  return { id, label: id, count: rows.length, rows, legend: [], emptyTitle: `No ${id} plugins`, ...overrides }
}

/** The marketplace facts over the given tabs. */
function facts(tabs: readonly MarketplaceTab[], overrides: Partial<MarketplaceFacts> = {}): MarketplaceFacts {
  return { title: 'Plugin marketplace', subtitle: '1 entry', tabs, activeTab: tabs[0]!.id, noDetail: 'No plugin selected', keys: KEYS, ...overrides }
}

/** The detail facts of one plugin. */
function detail(rows: PluginDetailFacts['rows'] = []): PluginDetailFacts {
  return {
    title: 'Loop', tagline: [{ text: 'official · Tools' }], notes: [{ text: 'Needs a restart', tone: 'warning' }],
    description: 'Recurring prompts and alarms.', rows,
  }
}

describe('PluginMarketplace', () => {
  it('lays out wide, grouped, dimmed, and unavailable rows with every column', () => {
    // One character from every range the cell counter treats as wide, then an
    // ASCII character for the narrow path.
    const wide = '\u1100\u2e80\uac00\uf900\ufe30\uff00\uffe0a'
    const tabs = [
      tab('browse', [
        row('loop', {
          name: 'Loop', glyph: '✓', glyphTone: 'success', group: 'Tools · 2', source: wide, version: '版本一',
          surfaces: [{ letter: 'T', label: 'TUI', on: true }, { letter: 'W', label: 'WEB', on: false }],
          dim: true, unavailable: { install: 'needs a source' },
        }),
        row('plain', { name: 'Plain', glyph: '', source: undefined, version: undefined, dim: false, unavailable: {} }),
      ], {
        attention: true, legend: [{ glyph: '✓', tone: 'success', text: 'installed' }, { glyph: '↑', tone: 'warning', text: 'update' }],
        emptyDescription: 'Nothing here yet', focus: { id: 'loop', rev: 2 },
      }),
    ]
    const surface = PluginMarketplace(facts(tabs, {
      subtitle: 'index updated 2h ago · 2 entries',
      detail: detail([{ label: 'Source', value: [{ text: 'official' }] }]),
      restartBanner: '↻ 1 change applies after you restart Mayfly and start a new session',
    }))
    const json = JSON.stringify(surface)
    expect(json).toContain('Plugin marketplace')
    expect(json).toContain('Loop')
    expect(json).toContain('Plain')
    expect(json).toContain('Tools · 2')
    expect(json).toContain('needs a source')
    expect(json).toContain('1 change applies')
    expect(json).not.toContain('No plugin selected')
  })

  it('drops the source and version columns, the icon column, and the legend for a bare tab', () => {
    const empty = tab('browse', [], {
      legend: [{ glyph: '✓', tone: 'success', text: 'installed' }, { glyph: '↑', tone: 'warning', text: 'update' }],
      emptyTitle: 'No plugins found', emptyDescription: 'Try another filter',
    })
    expect(JSON.stringify(PluginMarketplace(facts([empty])))).toContain('No plugins found')
    const bare = tab('installed', [
      row('loop', { name: 'Loop', surfaces: undefined }),
      row('alarm', { name: 'Alarm', dim: undefined }),
    ])
    const surface = PluginMarketplace(facts([bare], { detail: undefined }))
    const json = JSON.stringify(surface)
    expect(json).toContain('No plugin selected')
    expect(json).toContain('Loop')
    // No row carries a source or version, so the right side is empty.
    expect(json).not.toContain('official')
  })

  it('windows a tall grouped tab whose rows cannot share the pane height', () => {
    const rows = Array.from({ length: 40 }, (_, index) => row(`p${String(index)}`, {
      name: `Plugin ${String(index)}`, glyph: index % 2 === 0 ? '✓' : '', group: `Group ${String(index % 20)}`, version: `1.0.${String(index)}`,
    }))
    const tabs = [
      tab('updates', rows, { count: 40, attention: false, emptyTitle: 'No updates' }),
      tab('browse', [row('one')]),
    ]
    const surface = PluginMarketplace(facts(tabs, { activeTab: 'updates' }))
    const json = JSON.stringify(surface)
    expect(json).toContain('Plugin 39')
    expect(json).toContain('Group 19')
  })

  it('renders an empty detail section without the field spacer', () => {
    const empty = JSON.stringify(PluginDetail(detail([])))
    const filled = JSON.stringify(PluginDetail(detail([{ label: 'Source', value: [{ text: 'official' }] }])))
    expect(empty).toContain('Recurring prompts and alarms.')
    expect(empty).not.toContain('"fields"')
    expect(filled).toContain('"fields"')
    // The titled view has its heading; the panel's untitled body does not.
    expect(empty).toContain('Loop')
    expect(JSON.stringify(PluginDetail(detail([]), 10, false))).not.toContain('"Loop","styles":["strong"]')
  })
})

describe('PluginDetailPanel', () => {
  it('renders read-only without a key row and with only the permitted keys', () => {
    const readOnly = JSON.stringify(PluginDetailPanel(detail(), 'Loop'))
    expect(readOnly).toContain('Loop')
    expect(readOnly).not.toContain('plugin-detail-keys')

    const noAction = JSON.stringify(PluginDetailPanel(detail(), 'Loop', {
      install: 'install', update: 'update', remove: 'remove',
      removeConfirm: KEYS.removeConfirm, can: { install: false, update: false, remove: false },
    }))
    expect(noAction).toContain('plugin-detail-keys')
    expect(noAction).not.toContain('"id":"install"')

    const permitted = JSON.stringify(PluginDetailPanel(detail(), 'Loop', {
      install: 'install', update: 'update', remove: 'remove',
      removeConfirm: KEYS.removeConfirm, can: { install: true, update: true, remove: true },
    }))
    for (const id of ['install', 'update', 'remove']) expect(permitted).toContain(`"id":"${id}"`)
  })
})

describe('marketplace placeholders', () => {
  it('renders the loader, the unavailable manager, and the offline catalog states', () => {
    expect(JSON.stringify(PluginMarketplaceLoading('Plugin marketplace', 'loading catalog...'))).toContain('loading catalog...')
    const unavailable = JSON.stringify(PluginMarketplaceUnavailable('Plugin marketplace', 'plugin manager is unavailable'))
    expect(unavailable).toContain('plugin manager is unavailable')
    const offline = JSON.stringify(PluginMarketplaceOffline('Plugin marketplace', 'marketplace is offline', 'refresh'))
    expect(offline).toContain('marketplace is offline')
    expect(offline).toContain('"refresh"')
  })
})
