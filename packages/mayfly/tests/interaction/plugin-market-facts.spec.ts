/** The marketplace's translated facts: rows, tabs, groups, legends, key availability, and the detail page.
 * @module @ephemeral-ai/mayfly/tests/interaction/plugin-market-facts
 */
import { describe, expect, it } from 'vitest'
import type { BundleInfo } from '@deepseek-ai/dsh-plugin-manager'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import {
  categoryLabel,
  describeEntry,
  detailFacts,
  groupModeLabel,
  rowFacts,
  sourceLabel,
  tabFacts,
  unavailableKeys,
  type FactsEnv,
} from '../../src/interaction/plugin-market/facts.ts'
import type { MarketEntry } from '../../src/interaction/plugin-market/types.ts'
import type { MarketRow } from '../../src/interaction/plugin-market/model.ts'

const t: MayflyTranslate = (key, values) => key.replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? `{${name}}`))
const env: FactsEnv = { t, locale: 'en' }

function entry(over: Partial<MarketEntry> = {}): MarketEntry {
  return {
    id: 'loop', source: 'official', displayName: 'Loop', description: 'Runs loops', author: { name: 'Dev' },
    category: 'tools', status: 'stable', surfaces: { server: {} },
    install: { rows: [{ name: 'dsh-loop', npm: { spec: 'dsh-loop' } }] },
    ...over,
  }
}

function bundle(name: string, over: Partial<BundleInfo> = {}): BundleInfo {
  return { name, official: false, availability: 'profile', enabled: true, installed: true, optional: false, removable: true, rows: [], overrides: [], ...over } as BundleInfo
}

function row(over: Partial<MarketRow> = {}): MarketRow {
  return { id: 'row', state: 'available', installed: false, partial: false, ...over }
}

const bothSources = () => entry({
  install: { rows: [{ name: 'dsh-loop', npm: { spec: 'dsh-loop' }, github: { repo: 'o/r', ref: 'main' } }] },
})

describe('labels', () => {
  it('maps known categories and capitalizes unknown ones, with unlisted as Custom', () => {
    for (const [key, label] of [['tools', 'Tools'], ['ui', 'UI'], ['provider', 'Providers'], ['workflow', 'Workflow'], ['testing', 'Testing'], ['integration', 'Integration']] as const) {
      expect(categoryLabel(t, key)).toBe(label)
    }
    expect(categoryLabel(t, 'unlisted')).toBe('Custom')
    expect(categoryLabel(t, 'weird')).toBe('Weird')
    expect(categoryLabel(t, '')).toBe('')
  })

  it('maps every source tier and grouping mode', () => {
    expect(sourceLabel(t, 'official')).toBe('official')
    expect(sourceLabel(t, 'dsh')).toBe('dsh')
    expect(sourceLabel(t, 'community')).toBe('community')
    expect(groupModeLabel(t, 'category')).toBe('category')
    expect(groupModeLabel(t, 'source')).toBe('source')
    expect(groupModeLabel(t, 'none')).toBe('none')
  })

  it('describes an entry in the active language with an English fallback', () => {
    const described = entry({ description: 'English', descriptionZh: '中文' })
    expect(describeEntry(described, 'zh')).toBe('中文')
    expect(describeEntry(described, 'en')).toBe('English')
    expect(describeEntry(entry({ description: 'English' }), 'zh')).toBe('English')
  })
})

describe('unavailableKeys', () => {
  it('explains an unlisted row and the key set a full alternative source offers', () => {
    expect(unavailableKeys(t, row({ bundle: bundle('@scope/extra') }))).toEqual({
      install: 'Already installed in this profile',
      remove: 'Not installed in this profile',
      update: 'Not installed in this profile',
      source: 'Only one install source',
    })
  })

  it('explains a protected installed row and the absence of an update', () => {
    const installed = row({ entry: bothSources(), state: 'installed', installed: true, removable: false, bundle: bundle('dsh-loop', { readOnlyReason: 'management-required' }) })
    expect(unavailableKeys(t, installed)).toEqual({
      install: 'Already installed in this profile',
      remove: 'the plugin manager protects this bundle',
      update: 'Nothing to update',
      source: 'Only one install source',
    })
  })

  it('gives the manager’s generic removal reason and leaves a repair unblocked', () => {
    const repair = row({ entry: bothSources(), state: 'repair', installed: true, removable: false, bundle: bundle('dsh-loop') })
    expect(unavailableKeys(t, repair)).toEqual({
      remove: 'the plugin manager does not allow removing this bundle',
      source: 'Only one install source',
    })
  })

  it('refuses installation and update of a removed entry, with its note', () => {
    const removed = entry({ status: 'removed', displayName: 'Gone', statusNote: 'moved away', install: { rows: [{ name: 'dsh-loop', npm: { spec: 'a' }, github: { repo: 'o/r', ref: 'main' } }] } })
    expect(unavailableKeys(t, row({ entry: removed }))).toMatchObject({
      install: '"Gone" was removed from the marketplace: moved away',
      update: 'Not installed in this profile',
    })
    expect(unavailableKeys(t, row({ entry: removed }))).not.toHaveProperty('source')
    expect(unavailableKeys(t, row({ entry: removed, state: 'update', installed: true }))).toEqual({
      install: '"Gone" was removed from the marketplace: moved away',
      update: '"Gone" was removed from the marketplace: moved away',
      source: 'Only one install source',
    })
  })

  it('refuses the automation-only ACP package for install and update', () => {
    const acp = entry({ install: { rows: [{ name: '@deepseek-ai/dsh-acp', npm: { spec: 'acp' } }] } })
    expect(unavailableKeys(t, row({ entry: acp }))).toMatchObject({
      install: 'automation-only ACP server owns stdio; install it in a dedicated non-Mayfly profile',
      update: 'Not installed in this profile',
    })
    expect(unavailableKeys(t, row({ entry: acp, state: 'repair', installed: true }))).toMatchObject({
      update: 'automation-only ACP server owns stdio; install it in a dedicated non-Mayfly profile',
    })
  })
})

describe('rowFacts', () => {
  it('shows an update version transition, the source, and both surface flags', () => {
    const item = rowFacts(env, row({
      id: 'loop', entry: entry({ surfaces: { tui: { contributions: [] }, web: { clientModule: true } } }),
      state: 'update', installed: true, version: '1.0.0', updateVersion: '2.0.0',
    }), 'Tools · 1')
    expect(item).toMatchObject({
      id: 'loop', name: 'Loop', group: 'Tools · 1', glyph: '↑', glyphTone: 'warning',
      source: 'official', version: '1.0.0→2.0.0', dim: false,
      surfaces: [{ letter: 'T', label: 'TUI', on: true }, { letter: 'W', label: 'WEB', on: true }],
    })
  })

  it('falls back to the row or catalog version and dims retired rows', () => {
    expect(rowFacts(env, row({ state: 'update', entry: entry(), version: '3.0.0' }), undefined).version).toBe('3.0.0')
    expect(rowFacts(env, row({ entry: entry({ verified: { at: '', packages: [{ name: 'dsh-loop', version: '4.0.0' }] } }) }), undefined).version).toBe('4.0.0')
    expect(rowFacts(env, row({ state: 'deprecated', entry: entry() }), undefined).dim).toBe(true)
    expect(rowFacts(env, row({ state: 'removed', entry: entry() }), undefined).dim).toBe(true)
    expect(rowFacts(env, row({ state: 'installed', entry: entry() }), undefined).dim).toBe(false)
  })

  it('omits entry-derived fields for an unlisted bundle', () => {
    const item = rowFacts(env, row({ id: 'unlisted:extra', bundle: bundle('extra'), state: 'unlisted', installed: true }), undefined)
    expect(item).toMatchObject({
      id: 'unlisted:extra', name: 'extra', group: undefined, glyph: '?', glyphTone: 'muted',
      source: undefined, surfaces: undefined, version: undefined, dim: false, searchText: 'extra   state:custom installed',
    })
  })
})

describe('tabFacts', () => {
  const rows = [
    row({ id: 'i', entry: entry({ displayName: 'Installed' }), state: 'installed', installed: true }),
    row({ id: 'u', entry: entry({ displayName: 'Update', source: 'dsh' }), state: 'update', installed: true, version: '1.0.0', updateVersion: '2.0.0' }),
    row({ id: 'd', entry: entry({ displayName: 'Deprecated', status: 'deprecated' }), state: 'deprecated', installed: true }),
    row({ id: 'r', entry: entry({ displayName: 'Removed', status: 'removed' }), state: 'removed', installed: true }),
    row({ id: 'x', bundle: bundle('extra'), state: 'unlisted', installed: true }),
    row({ id: 'a', entry: entry({ displayName: 'Available' }), state: 'available' }),
  ]

  it('builds the installed tab with its legend, groups, count, and empty copy', () => {
    const tab = tabFacts(env, rows, 'installed', 'category', { id: 'i', rev: 2 })
    expect(tab).toMatchObject({
      id: 'installed', label: 'Installed', count: 5, attention: false, focus: { id: 'i', rev: 2 },
      legend: [
        { glyph: '✓', tone: 'success', text: 'installed' },
        { glyph: '↑', tone: 'warning', text: 'update' },
        { glyph: '!', tone: 'warning', text: 'deprecated' },
        { glyph: '✗', tone: 'danger', text: 'removed' },
        { glyph: '?', tone: 'muted', text: 'custom' },
      ],
      emptyDescription: 'Switch to Browse with Alt+→ to add one.',
      emptyTitle: 'no plugins installed',
    })
    expect(tab.rows.find(item => item.id === 'i')?.group).toBe('Tools · 4')
    expect(tab.rows.find(item => item.id === 'u')?.version).toBe('1.0.0→2.0.0')
  })

  it('builds the updates inbox with attention and its own empty copy', () => {
    const tab = tabFacts(env, rows, 'updates', 'source', undefined)
    expect(tab).toMatchObject({ label: 'Updates', count: 3, attention: true, emptyDescription: undefined, emptyTitle: 'everything is up to date', focus: undefined })
    expect(tab.rows.map(item => item.id)).toEqual(['d', 'r', 'u'])
    expect(tab.rows[0]?.group).toBe('official · 2')
    expect(tab.rows.at(-1)?.group).toBe('dsh · 1')
    expect(tab.legend.map(item => item.glyph)).toEqual(['↑', '!', '✗'])
  })

  it('builds the browse tab, keeps unlisted rows in a Custom group, and passes a custom legend through', () => {
    const browse = tabFacts(env, rows, 'browse', 'none', undefined)
    expect(browse).toMatchObject({ label: 'Browse', count: 1, attention: false, emptyTitle: 'no plugins available', emptyDescription: undefined })
    expect(browse.rows[0]).toMatchObject({ id: 'a', group: undefined })

    const custom = tabFacts(env, [row({ id: 'x', bundle: bundle('extra'), state: 'unlisted', installed: false })], 'browse', 'category', undefined)
    expect(custom.rows[0]).toMatchObject({ id: 'x', group: 'Custom · 1' })
    expect(custom.legend).toEqual([{ glyph: '?', tone: 'muted', text: 'custom' }])
  })
})

describe('detailFacts', () => {
  it('describes an unlisted bundle by its source, install target, or package name', () => {
    const fromSource = detailFacts(env, row({ bundle: bundle('extra', { source: 'file:/tmp/extra' }), state: 'unlisted', installed: true }), undefined)
    expect(fromSource.title).toBe('extra')
    expect(fromSource.tagline).toEqual([{ text: '? Custom', tone: 'muted' }])
    expect(fromSource.description).toBe('Installed in this profile but not listed in the marketplace index.')
    expect(fromSource.rows).toEqual([{ label: 'Package', value: [{ text: 'file:/tmp/extra', tone: 'accent' }] }])

    const fromTarget = detailFacts(env, row({ bundle: bundle('extra', { installTarget: { spec: 'extra@1', version: '1.0.0' } }), state: 'unlisted', installed: true }), undefined)
    expect(fromTarget.rows[0]?.value).toEqual([{ text: 'extra@1', tone: 'accent' }])
    const fromName = detailFacts(env, row({ bundle: bundle('extra'), state: 'unlisted', installed: true }), undefined)
    expect(fromName.rows[0]?.value).toEqual([{ text: 'extra', tone: 'accent' }])
  })

  it('lists the entry offers, needs, engines, sources, author, and repository', () => {
    const detail = detailFacts(env, row({
      entry: entry({
        displayName: 'Loop', category: 'tools', license: 'MIT',
        surfaces: { tui: { contributions: [] }, web: { clientModule: true }, server: {} },
        provides: { tools: ['run', 'stop'], commands: ['loop'] },
        capabilities: ['shell', 'network'],
        engines: { node: '>=22', dsh: '*', mayfly: '^1' },
        links: { repo: 'https://example.test/loop' },
        install: { rows: [{ name: 'dsh-loop', npm: { spec: 'dsh-loop' }, github: { repo: 'o/r', ref: 'main' } }] },
      }),
      state: 'update', installed: false, version: '1.0.0', updateVersion: '2.0.0',
    }), 'github')
    expect(detail.title).toBe('Loop')
    expect(detail.tagline).toEqual([
      { text: '↑ Update available', tone: 'warning' },
      { text: ' · ' },
      { text: 'Tools' },
    ])
    expect(detail.description).toBe('Runs loops')
    expect(detail.rows.map(item => item.label)).toEqual(['Tools', 'Commands', 'Needs', 'Engines', 'Install via', 'Author', 'Links'])
    expect(detail.rows.find(item => item.label === 'Engines')?.value).toEqual([
      { text: 'dsh *' }, { text: ' · ' }, { text: 'mayfly ^1' }, { text: ' · ' }, { text: 'node >=22' },
    ])
    expect(detail.rows.find(item => item.label === 'Install via')?.value).toEqual([
      { text: 'github', tone: 'accent' }, { text: ' · press s for npm', tone: 'muted' },
    ])
    expect(detail.rows.find(item => item.label === 'Author')?.value).toEqual([{ text: 'Dev · MIT' }])
    expect(detail.rows.find(item => item.label === 'Links')?.value).toEqual([{ text: 'https://example.test/loop', tone: 'accent' }])
  })

  it('uses the default source and drops the source row once installed', () => {
    const both = entry({ install: { rows: [{ name: 'dsh-loop', npm: { spec: 'dsh-loop' }, github: { repo: 'o/r', ref: 'main' } }] } })
    expect(detailFacts(env, row({ entry: both }), undefined).rows.some(item => item.label === 'Install via')).toBe(true)
    expect(detailFacts(env, row({ entry: both, installed: true, state: 'installed' }), 'npm').rows.some(item => item.label === 'Install via')).toBe(false)
    const githubOnly = entry({ install: { rows: [{ name: 'dsh-loop', github: { repo: 'o/r', ref: 'main' } }] } })
    expect(detailFacts(env, row({ entry: githubOnly }), undefined).rows.some(item => item.label === 'Install via')).toBe(false)
    expect(detailFacts(env, row({ entry: entry() }), undefined).rows.some(item => item.label === 'Install via')).toBe(false)
  })

  it('adds status, automation, and web-only notes with their tones', () => {
    const removed = detailFacts(env, row({ entry: entry({ status: 'removed', statusNote: 'moved away' }), state: 'removed' }), undefined)
    expect(removed.notes).toEqual([{ text: 'moved away', tone: 'danger' }])
    const deprecated = detailFacts(env, row({ entry: entry({ status: 'deprecated', statusNote: 'old' }), state: 'deprecated' }), undefined)
    expect(deprecated.notes).toEqual([{ text: 'old', tone: 'warning' }])
    expect(detailFacts(env, row({ entry: entry({ status: 'removed' }) }), undefined).notes).toEqual([])
    expect(detailFacts(env, row({ entry: entry({ status: 'stable', statusNote: 'ignored' }) }), undefined).notes).toEqual([])
    const acp = entry({ install: { rows: [{ name: '@deepseek-ai/dsh-acp', npm: { spec: 'acp' } }] } })
    expect(detailFacts(env, row({ entry: acp }), undefined).notes).toEqual([
      { text: 'automation-only ACP server owns stdio; install it in a dedicated non-Mayfly profile', tone: 'warning' },
    ])
    expect(detailFacts(env, row({ entry: entry({ surfaces: { web: { clientModule: true } } }) }), undefined).notes).toEqual([
      { text: 'web-only plugin: it contributes nothing in this terminal frontend', tone: 'warning' },
    ])
    expect(detailFacts(env, row({ entry: entry({ surfaces: { tui: { contributions: [] } } }) }), undefined).notes).toEqual([])
  })

  it('shows the plain category tagline for current rows and the other states in words', () => {
    const category = (state: MarketRow['state']) => detailFacts(env, row({ entry: entry({ category: 'UI' }), state }), undefined).tagline
    expect(category('installed')).toEqual([{ text: 'UI' }])
    expect(category('available')).toEqual([{ text: 'UI' }])
    expect(category('repair')).toEqual([{ text: '↑ Incomplete; update to repair', tone: 'warning' }, { text: ' · ' }, { text: 'UI' }])
    expect(category('deprecated')).toEqual([{ text: '! Deprecated', tone: 'warning' }, { text: ' · ' }, { text: 'UI' }])
    expect(category('removed')).toEqual([{ text: '✗ Removed from the market', tone: 'danger' }, { text: ' · ' }, { text: 'UI' }])
    expect(category('unlisted')).toEqual([{ text: '? Custom', tone: 'muted' }, { text: ' · ' }, { text: 'UI' }])
  })

  it('describes the catalog entry in Chinese and drops empty optional rows', () => {
    const detail = detailFacts({ t, locale: 'zh' }, row({ entry: entry({ description: 'English', descriptionZh: '中文' }) }), undefined)
    expect(detail.description).toBe('中文')
    expect(detail.rows.map(item => item.label)).toEqual(['Author'])
    expect(detail.rows[0]?.value).toEqual([{ text: 'Dev' }])
    expect(detail.tagline).toEqual([{ text: 'Tools' }])
  })
})
