/** The marketplace's read-only facts: install state, rows, tabs, grouping, and filter text.
 * @module @ephemeral-ai/mayfly/tests/interaction/plugin-market-model
 */
import { describe, expect, it } from 'vitest'
import type { BundleInfo } from '@deepseek-ai/dsh-plugin-manager'
import {
  buildRows,
  currentProfileInstallBlock,
  declaredEngines,
  defaultInstallSource,
  entryInstallStates,
  entrySupportsSource,
  groupKey,
  groupRows,
  inTab,
  MAYFLY_PACKAGE,
  marketEntryInstallBlock,
  MARKET_TABS,
  newerVersion,
  rowName,
  rowSearchText,
  rowSpec,
  surfaceFlags,
  tabRows,
  UNLISTED_GROUP,
  usefulInTui,
  usefulOnWeb,
  type MarketRow,
} from '../../src/interaction/plugin-market/model.ts'
import type { MarketEntry, MarketInstallRow } from '../../src/interaction/plugin-market/types.ts'

function entry(over: Partial<MarketEntry> = {}): MarketEntry {
  return {
    id: 'loop', source: 'official', displayName: 'Loop', description: 'Runs loops', author: { name: 'Dev' },
    category: 'tools', status: 'stable', surfaces: { server: {} },
    install: { rows: [{ name: 'dsh-loop', npm: { spec: 'dsh-loop' } }] },
    ...over,
  }
}

function installRow(over: Partial<MarketInstallRow> & { readonly name: string }): MarketInstallRow {
  return over
}

function bundle(name: string, over: Partial<BundleInfo> = {}): BundleInfo {
  return {
    name, official: false, availability: 'profile', enabled: true, installed: true,
    optional: false, removable: true, rows: [], overrides: [], ...over,
  } as BundleInfo
}

function row(over: Partial<MarketRow> = {}): MarketRow {
  return { id: 'row', state: 'available', installed: false, partial: false, ...over }
}

describe('rowSpec and install sources', () => {
  it('composes npm and GitHub specs, with an optional monorepo path', () => {
    expect(rowSpec(installRow({ name: 'a', npm: { spec: 'a@1' } }), 'npm')).toBe('a@1')
    expect(rowSpec(installRow({ name: 'a' }), 'npm')).toBeUndefined()
    expect(rowSpec(installRow({ name: 'a', github: { repo: 'o/r', ref: 'main' } }), 'github')).toBe('github:o/r#main')
    expect(rowSpec(installRow({ name: 'a', github: { repo: 'o/r', ref: 'v1', subdir: 'packages/a' } }), 'github')).toBe('github:o/r#v1&path:packages/a')
    expect(rowSpec(installRow({ name: 'a' }), 'github')).toBeUndefined()
  })

  it('requires every row to support a source', () => {
    expect(entrySupportsSource(entry({ install: { rows: [] } }), 'npm')).toBe(false)
    expect(entrySupportsSource(entry(), 'npm')).toBe(true)
    expect(entrySupportsSource(entry(), 'github')).toBe(false)
    const mixed = entry({ install: { rows: [
      { name: 'a', npm: { spec: 'a' } },
      { name: 'b', github: { repo: 'o/r', ref: 'main' } },
    ] } })
    expect(entrySupportsSource(mixed, 'npm')).toBe(false)
    expect(entrySupportsSource(mixed, 'github')).toBe(false)
    const github = entry({ install: { rows: [{ name: 'a', github: { repo: 'o/r', ref: 'main' } }] } })
    expect(entrySupportsSource(github, 'github')).toBe(true)
    expect(entrySupportsSource(github, 'npm')).toBe(false)
  })

  it('prefers npm, then GitHub, then nothing', () => {
    const both = entry({ install: { rows: [{ name: 'a', npm: { spec: 'a' }, github: { repo: 'o/r', ref: 'main' } }] } })
    expect(defaultInstallSource(both)).toBe('npm')
    const github = entry({ install: { rows: [{ name: 'a', github: { repo: 'o/r', ref: 'main' } }] } })
    expect(defaultInstallSource(github)).toBe('github')
    expect(defaultInstallSource(entry({ install: { rows: [] } }))).toBeUndefined()
  })
})

describe('install blocks', () => {
  it('explains the automation-only ACP package and a removed marketplace entry', () => {
    const acp = entry({ install: { rows: [{ name: '@deepseek-ai/dsh-acp', npm: { spec: 'acp' } }] } })
    expect(currentProfileInstallBlock(acp)).toContain('automation-only ACP server')
    expect(currentProfileInstallBlock(entry())).toBeUndefined()
    expect(marketEntryInstallBlock(entry({ status: 'removed', displayName: 'Gone' }))).toBe('"Gone" was removed from the marketplace')
    expect(marketEntryInstallBlock(entry({ status: 'removed', displayName: 'Gone', statusNote: 'moved away' }))).toBe('"Gone" was removed from the marketplace: moved away')
    expect(marketEntryInstallBlock(acp)).toContain('automation-only ACP server')
    expect(marketEntryInstallBlock(entry())).toBeUndefined()
  })
})

describe('newerVersion', () => {
  it('compares valid catalog and on-demand versions against the installed one', () => {
    const npmEntry = entry({ npm: { 'dsh-loop': { latestVersion: '2.0.0' } } })
    expect(newerVersion(installRow({ name: 'dsh-loop' }), bundle('dsh-loop', { version: '1.0.0' }), npmEntry)).toBe('2.0.0')
    expect(newerVersion(installRow({ name: 'dsh-loop' }), bundle('dsh-loop', { version: '2.0.0' }), npmEntry)).toBeUndefined()
    expect(newerVersion(installRow({ name: 'dsh-loop' }), bundle('dsh-loop', { version: '3.0.0' }), npmEntry)).toBeUndefined()
    expect(newerVersion(installRow({ name: 'dsh-loop' }), bundle('dsh-loop', { version: '1.0.0' }), entry({ npm: { 'dsh-loop': { latestVersion: null } } }))).toBeUndefined()
  })

  it('falls back to the native on-demand target and refuses invalid or incomplete versions', () => {
    const target = bundle('dsh-loop', { version: '1.0.0', installTarget: { spec: 'dsh-loop', version: '4.0.0' } })
    expect(newerVersion(installRow({ name: 'dsh-loop' }), target, entry())).toBe('4.0.0')
    expect(newerVersion(installRow({ name: 'dsh-loop' }), undefined, entry())).toBeUndefined()
    expect(newerVersion(installRow({ name: 'dsh-loop' }), bundle('dsh-loop'), entry())).toBeUndefined()
    expect(newerVersion(installRow({ name: 'dsh-loop' }), bundle('dsh-loop', { version: 'banana' }), entry({ npm: { 'dsh-loop': { latestVersion: '1.0.0' } } }))).toBeUndefined()
    expect(newerVersion(installRow({ name: 'dsh-loop' }), bundle('dsh-loop', { version: '1.0.0' }), entry({ npm: { 'dsh-loop': { latestVersion: 'not-a-version' } } }))).toBeUndefined()
  })
})

describe('entryInstallStates', () => {
  it('reports an absent entry as not installed with nothing removable', () => {
    expect(entryInstallStates([entry()], [])).toEqual({
      loop: { installed: false, version: undefined, updateAvailable: false, updateVersion: undefined, enabled: undefined, removable: false },
    })
  })

  it('matches every row package and merges enablement, removal, and update facts', () => {
    const multi = entry({ install: { rows: [{ name: 'a', npm: { spec: 'a' } }, { name: 'b', npm: { spec: 'b' } }] }, npm: { b: { latestVersion: '2.0.0' } } })
    const states = entryInstallStates([multi], [bundle('a', { version: '1.0.0', enabled: true, removable: true }), bundle('b', { version: '1.2.0', enabled: false, removable: false })])
    expect(states.loop).toEqual({ installed: true, version: '1.0.0', updateAvailable: true, updateVersion: '2.0.0', enabled: false, removable: false })
  })

  it('treats a partial install as not installed while keeping removal availability from present rows', () => {
    const multi = entry({ install: { rows: [{ name: 'a', npm: { spec: 'a' } }, { name: 'b', npm: { spec: 'b' } }] } })
    const states = entryInstallStates([multi], [bundle('a', { enabled: false, removable: true })])
    expect(states.loop).toEqual({ installed: false, version: undefined, updateAvailable: false, updateVersion: undefined, enabled: undefined, removable: true })
    const absent = entryInstallStates([entry()], [bundle('dsh-loop', { installed: false })])
    expect(absent.loop).toMatchObject({ installed: false })
  })
})

describe('buildRows', () => {
  it('derives available, installed, update, repair, deprecated, and removed rows', () => {
    const updatable = entry({ id: 'up', displayName: 'Up', npm: { 'dsh-loop': { latestVersion: '2.0.0' } } })
    const deprecated = entry({ id: 'old', displayName: 'Old', status: 'deprecated' })
    const removed = entry({ id: 'gone', displayName: 'Gone', status: 'removed' })
    const rows = buildRows([entry(), updatable, deprecated, removed], [bundle('dsh-loop', { version: '1.0.0' })])
    expect(rows.map(item => [item.id, item.state])).toEqual([
      ['loop', 'installed'],
      ['up', 'update'],
      ['old', 'deprecated'],
      ['gone', 'removed'],
    ])
    expect(rows[1]).toMatchObject({ installed: true, partial: false, version: '1.0.0', updateVersion: '2.0.0', removable: true })
    expect(rows[3]).toMatchObject({ installed: true, removable: true })
    expect(buildRows([entry()], [])[0]).toMatchObject({ state: 'available', installed: false, removable: false })
  })

  it('marks a partial install and a deselected install as needing repair', () => {
    const multi = entry({ install: { rows: [{ name: 'a', npm: { spec: 'a' } }, { name: 'b', npm: { spec: 'b' } }] } })
    expect(buildRows([multi], [bundle('a')])[0]).toMatchObject({ state: 'repair', installed: true, partial: true })
    expect(buildRows([entry()], [bundle('dsh-loop', { enabled: false })])[0]).toMatchObject({ state: 'repair', installed: true, partial: false })
    expect(buildRows([entry()], [bundle('dsh-loop')])[0]).toMatchObject({ state: 'installed', partial: false })
  })

  it('keeps a removed entry only while the profile still carries it', () => {
    const removed = entry({ id: 'gone', displayName: 'Gone', status: 'removed' })
    expect(buildRows([removed], [])).toEqual([])
    expect(buildRows([removed], [bundle('dsh-loop')])[0]).toMatchObject({ id: 'gone', state: 'removed', installed: true })
  })

  it('appends installed bundles the index does not own, except Mayfly and its protected packages', () => {
    const rows = buildRows([entry({ install: { rows: [{ name: 'dsh-claimed', npm: { spec: 'dsh-claimed' } }] } })], [
      bundle('dsh-claimed'),
      bundle('@scope/extra', { version: '3.1.0', enabled: false, removable: false }),
      bundle(MAYFLY_PACKAGE),
      bundle('@ephemeral-ai/mayfly-ui'),
      bundle('@deepseek-ai/dsh-base'),
      bundle('not-installed', { installed: false }),
    ])
    expect(rows.map(item => item.id)).toEqual(['loop', `${UNLISTED_GROUP}:@scope/extra`])
    expect(rows[1]).toMatchObject({
      id: `${UNLISTED_GROUP}:@scope/extra`, state: 'unlisted', installed: true, partial: false,
      version: '3.1.0', enabled: false, removable: false,
    })
    expect(rows[1]?.bundle?.name).toBe('@scope/extra')
  })

  it('omits a version an unlisted bundle does not report', () => {
    const rows = buildRows([], [bundle('extra')])
    expect(rows[0]).not.toHaveProperty('version')
  })
})

describe('tabs, names, and grouping', () => {
  it('assigns rows to the installed, updates, and browse inboxes', () => {
    expect(MARKET_TABS).toEqual(['installed', 'updates', 'browse'])
    expect(inTab(row({ installed: false }), 'browse')).toBe(true)
    expect(inTab(row({ installed: true, state: 'installed' }), 'browse')).toBe(false)
    expect(inTab(row({ installed: true, state: 'installed' }), 'installed')).toBe(true)
    expect(inTab(row({ installed: false }), 'installed')).toBe(false)
    expect(inTab(row({ installed: true, state: 'update' }), 'updates')).toBe(true)
    expect(inTab(row({ installed: true, state: 'repair' }), 'updates')).toBe(true)
    expect(inTab(row({ installed: true, state: 'installed' }), 'updates')).toBe(false)
    expect(inTab(row({ installed: true, state: 'unlisted' }), 'updates')).toBe(false)
    expect(tabRows([row({ installed: true, state: 'update' }), row({ id: 'b' })], 'updates')).toHaveLength(1)
  })

  it('names a row from the entry, the bundle, or nothing', () => {
    expect(rowName(row({ entry: entry({ displayName: 'Loop' }) }))).toBe('Loop')
    expect(rowName(row({ bundle: bundle('pkg') }))).toBe('pkg')
    expect(rowName(row())).toBe('')
  })

  it('derives the group key: category, source, unlisted, or none', () => {
    expect(groupKey(row({ entry: entry({ category: 'Testing' }) }), 'category')).toBe('testing')
    expect(groupKey(row({ entry: entry({ source: 'dsh' }) }), 'source')).toBe('dsh')
    expect(groupKey(row({ entry: entry() }), 'none')).toBeUndefined()
    expect(groupKey(row(), 'category')).toBe(UNLISTED_GROUP)
    expect(groupKey(row(), 'none')).toBe(UNLISTED_GROUP)
  })

  it('sorts by group rank, group key, then row name', () => {
    const community = row({ id: 'c', entry: entry({ displayName: 'Alpha', source: 'community' }), state: 'available' })
    const officialB = row({ id: 'ob', entry: entry({ displayName: 'Beta', source: 'official' }), state: 'available' })
    const officialA = row({ id: 'oa', entry: entry({ displayName: 'Alpha', source: 'official' }), state: 'available' })
    const unlisted = row({ id: 'u', bundle: bundle('Zulu'), state: 'unlisted', installed: true })
    const dsh = row({ id: 'd', entry: entry({ displayName: 'Delta', source: 'dsh' }), state: 'available' })
    expect(groupRows([community, officialB, officialA, unlisted, dsh], 'source').map(item => item.id)).toEqual(['oa', 'ob', 'd', 'c', 'u'])
    expect(groupRows([officialB, officialA], 'none').map(item => item.id)).toEqual(['oa', 'ob'])
    expect(groupRows([row({ id: 'z', entry: entry({ displayName: 'Zulu', category: 'ui' }) }), row({ id: 'a', entry: entry({ displayName: 'Alpha', category: 'tools' }) })], 'category').map(item => item.id)).toEqual(['a', 'z'])
    expect(groupRows([unlisted, officialA], 'none').map(item => item.id)).toEqual(['oa', 'u'])
    expect(groupRows([row({ id: 'z', entry: entry({ displayName: 'Zulu', category: 'zulu' }) }), row({ id: 'a', entry: entry({ displayName: 'Alpha', category: 'alpha' }) })], 'category').map(item => item.id)).toEqual(['a', 'z'])
    expect(groupRows([row({ id: 'a', entry: entry({ displayName: 'Alpha', category: 'alpha' }) }), row({ id: 'z', entry: entry({ displayName: 'Zulu', category: 'zulu' }) })], 'category').map(item => item.id)).toEqual(['a', 'z'])
  })
})

describe('surfaces and engines', () => {
  it('reads declared surface flags and automation ownership', () => {
    expect(surfaceFlags(entry({ surfaces: { tui: { contributions: ['pane'] }, web: { clientModule: true }, server: {} } })))
      .toEqual({ tui: true, web: true, server: true, automation: false })
    expect(surfaceFlags(entry({ surfaces: {} }))).toEqual({ tui: false, web: false, server: false, automation: false })
    const acp = entry({ install: { rows: [{ name: '@deepseek-ai/dsh-acp', npm: { spec: 'acp' } }] } })
    expect(surfaceFlags(acp).automation).toBe(true)
  })

  it('decides usefulness per frontend', () => {
    expect(usefulInTui(entry({ surfaces: { server: {} } }))).toBe(true)
    expect(usefulInTui(entry({ surfaces: { tui: { contributions: [] } } }))).toBe(true)
    expect(usefulInTui(entry({ surfaces: { web: { clientModule: true } } }))).toBe(false)
    expect(usefulOnWeb(entry({ surfaces: { server: {} } }))).toBe(true)
    expect(usefulOnWeb(entry({ surfaces: { web: { clientModule: true } } }))).toBe(true)
    expect(usefulOnWeb(entry({ surfaces: { tui: { contributions: [] } } }))).toBe(false)
    const acp = entry({ install: { rows: [{ name: '@deepseek-ai/dsh-acp', npm: { spec: 'acp' } }] } })
    expect(usefulInTui(acp)).toBe(false)
    expect(usefulOnWeb(acp)).toBe(false)
  })

  it('lists declared engine ranges in display order', () => {
    expect(declaredEngines(entry())).toEqual([])
    expect(declaredEngines(entry({ engines: { node: '>=22', dsh: '*', mayfly: '^1' } }))).toEqual([
      { engine: 'dsh', range: '*' },
      { engine: 'mayfly', range: '^1' },
      { engine: 'node', range: '>=22' },
    ])
    expect(declaredEngines(entry({ engines: { mayfly: '*' } }))).toEqual([{ engine: 'mayfly', range: '*' }])
    expect(declaredEngines(entry({ engines: { dsh: '*' } }))).toEqual([{ engine: 'dsh', range: '*' }])
    expect(declaredEngines(entry({ engines: { node: '>=22' } }))).toEqual([{ engine: 'node', range: '>=22' }])
  })
})

describe('rowSearchText', () => {
  it('joins the entry metadata, offers, needs, surfaces, and state tokens', () => {
    const text = rowSearchText(row({
      entry: entry({
        displayName: 'Loop', id: 'loop', description: 'Runs loops', descriptionZh: '循环', author: { name: 'Dev' },
        category: 'tools', source: 'dsh', status: 'beta',
        surfaces: { tui: { contributions: [] }, web: { clientModule: true }, server: {} },
        capabilities: ['shell'], provides: { tools: ['run'], commands: ['loop'] },
      }),
      state: 'available', installed: false,
    }))
    expect(text).toContain('Loop loop Runs loops 循环 Dev tools run loop')
    expect(text).toContain('source:dsh cat:tools status:beta state:available surface:tui surface:web surface:server needs:shell kind:tool kind:command')
    expect(text).not.toContain('installed')
    const installed = rowSearchText(row({ entry: entry({ provides: {} }), state: 'installed', installed: true }))
    expect(installed).toContain('state:installed')
    expect(installed.endsWith(' installed')).toBe(true)
    const webOnly = rowSearchText(row({ entry: entry({ surfaces: { web: { clientModule: true } } }) }))
    expect(webOnly).toContain('surface:web')
    expect(webOnly).not.toContain('surface:tui')
    const tuiOnly = rowSearchText(row({ entry: entry({ surfaces: { tui: { contributions: [] } } }) }))
    expect(tuiOnly).toContain('surface:tui')
    expect(tuiOnly).not.toContain('surface:web')
    expect(installed).not.toContain('kind:tool')
  })

  it('joins an unlisted bundle metadata and custom state tokens', () => {
    const text = rowSearchText(row({
      bundle: bundle('@scope/extra', { source: 'file:/tmp/extra', description: 'Local extra', meta: { title: 'Extra', description: 'More' } }),
      state: 'unlisted', installed: true,
    }))
    expect(text).toBe('@scope/extra file:/tmp/extra Local extra Extra More state:custom installed')
  })

  it('omits non-string metadata and tolerates a row with neither entry nor bundle', () => {
    const weird = bundle('pkg', { meta: { title: 4, description: null } } as unknown as Partial<BundleInfo>)
    expect(rowSearchText(row({ bundle: weird, state: 'unlisted', installed: true }))).toBe('pkg   state:custom installed')
    expect(rowSearchText(row({ state: 'unlisted' }))).toBe('   state:custom installed')
  })
})
