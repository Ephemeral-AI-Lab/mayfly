/**
 * The plugin marketplace of a scenario: an index served over HTTP (or an unreachable one, or a stale cache), a profile
 * that carries some of its plugins, and a fake `dsh` that installs and removes them without a package manager. A
 * scenario with a `market` field gets all of it from `prepareSession`; the state it writes into the throwaway `bench`
 * profile and the market cache is put back when the session closes. Only `pnpm run scenario` and `pnpm run frame` (the
 * runs on the `bench` profile) can seed it. @module script/scenarios/market
 */

import { createServer } from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FAKE_DSH = fileURLToPath(new URL('./fake-dsh.mjs', import.meta.url))
/** A port nothing listens on: the catalog is unreachable. */
const UNREACHABLE = 'http://127.0.0.1:9/index.json'

const row = (name, over = {}) => ({ name, npm: { spec: name }, ...over })
const entry = (id, over) => ({
  id, source: 'community', displayName: id, description: id, author: { name: 'Acme' }, category: 'tools', status: 'stable',
  surfaces: { server: {} }, install: { rows: [row(`dsh-${id}`)] }, ...over,
})
const latest = (version, names) => Object.fromEntries(names.map(name => [name, { latestVersion: version }]))

/** The entries of the fixture index: every category, source, surface, status, and install state the panel classifies. */
const ENTRIES = [
  entry('loop', {
    source: 'official', displayName: 'Loop', category: 'workflow', description: 'Repeat a prompt on an interval.', descriptionZh: '按间隔重复执行提示。',
    surfaces: { server: {}, tui: { contributions: ['commands'] } }, provides: { tools: ['loop_start', 'loop_stop'], commands: ['/loop'] },
    capabilities: ['timer'], engines: { dsh: '^0.2.0', mayfly: '>=0.1.0', node: '>=20' }, npm: latest('1.4.0', ['dsh-loop']),
    verified: { at: '2026-09-20', packages: [{ name: 'dsh-loop', version: '1.4.0' }] }, links: { repo: 'https://example.test/dsh-loop' }, license: 'MIT',
  }),
  entry('git-helper', {
    displayName: 'Git Helper', description: 'Branch, stage, and commit from the conversation.', provides: { tools: ['git_status', 'git_commit'], commands: ['/git'] },
    capabilities: ['shell', 'process-spawn'], npm: latest('1.3.0', ['dsh-git-helper']), license: 'Apache-2.0',
  }),
  entry('legacy-search', {
    displayName: 'Legacy Search', status: 'deprecated', statusNote: 'Use Smart Search instead; this one is no longer updated.',
    description: 'Search the workspace with a plain index.', provides: { tools: ['legacy_search'] }, npm: latest('0.9.4', ['dsh-legacy-search']),
  }),
  entry('smart-search', {
    source: 'dsh', displayName: 'Smart Search', status: 'beta', description: 'Semantic search across the workspace and the web.',
    surfaces: { server: {}, web: { clientModule: true } }, provides: { tools: ['smart_search'] }, capabilities: ['network'], npm: latest('0.3.0', ['dsh-smart-search']),
  }),
  entry('theme-pack', {
    source: 'official', displayName: 'Theme Pack', category: 'ui', description: 'Four extra color themes for the terminal.',
    surfaces: { tui: { contributions: ['themes'] } }, npm: latest('1.0.2', ['dsh-theme-pack']),
  }),
  entry('status-clock', {
    displayName: 'Status Clock', category: 'ui', status: 'unstable', description: 'A clock in the status footer.',
    surfaces: { tui: { contributions: ['status'] } }, capabilities: ['timer'], npm: latest('0.1.0', ['dsh-status-clock']),
  }),
  entry('web-dashboard', {
    source: 'dsh', displayName: 'Web Dashboard', category: 'ui', description: 'A browser dashboard for jobs and sessions.',
    surfaces: { web: { clientModule: true } }, npm: latest('2.1.0', ['dsh-web-dashboard']),
  }),
  entry('provider-pack', {
    source: 'official', displayName: 'Provider Pack', category: 'provider', description: 'More model providers with their catalogs.',
    capabilities: ['credentials', 'network'], install: { rows: [row('dsh-provider-pack', { github: { repo: 'acme/dsh-provider-pack', ref: 'v1.1.0' } })] },
    npm: latest('1.1.0', ['dsh-provider-pack']),
  }),
  entry('agent-team', {
    source: 'dsh', displayName: 'Agent Team', category: 'workflow', status: 'beta', description: 'Coordinate several agents on one goal.',
    surfaces: { server: {}, tui: { contributions: ['panes'] } }, provides: { tools: ['team_spawn'] },
    install: { rows: [row('dsh-agent-team'), row('dsh-agent-team-ui')] }, npm: latest('0.5.0', ['dsh-agent-team', 'dsh-agent-team-ui']),
  }),
  entry('test-recorder', {
    displayName: 'Test Recorder', category: 'testing', description: 'Record a session as a regression test.',
    engines: { mayfly: '>=9.0.0' }, npm: latest('4.0.0', ['dsh-test-recorder']),
  }),
  entry('github-bridge', {
    source: 'official', displayName: 'GitHub Bridge', category: 'integration', description: 'Issues and pull requests as tools.',
    capabilities: ['network', 'credentials'], provides: { tools: ['gh_issue', 'gh_pr'] }, npm: latest('2.0.0', ['dsh-github-bridge']),
  }),
  entry('slack-notify', {
    displayName: 'Slack Notify', category: 'integration',
    description: 'Post a message to a Slack channel when a long job finishes, when an approval is waiting, or when the session ends, with the last lines of output and a link back to the session so the team can follow the work without watching the terminal.',
    capabilities: ['network'], npm: latest('1.0.0', ['dsh-slack-notify']),
  }),
  entry('acp-server', {
    source: 'official', displayName: 'ACP Server', category: 'integration', description: 'An automation-only Agent Client Protocol server.',
    install: { rows: [row('@deepseek-ai/dsh-acp')] }, npm: latest('0.2.0', ['@deepseek-ai/dsh-acp']),
  }),
  entry('old-widget', {
    displayName: 'Old Widget', category: 'ui', status: 'removed', statusNote: 'Removed from the market: unmaintained.',
    description: 'A widget nobody maintains.', surfaces: { tui: { contributions: ['panes'] } },
  }),
]

/** The fixture index document. */
export function marketIndex() {
  return { schemaVersion: 1, generatedAt: '2025-12-31T07:00:00Z', entries: ENTRIES }
}

/** Installed in the `full` profile: an up-to-date one, one with an update, a deprecated one, half of a pair, a removed one, and an unlisted package. */
const INSTALLED = {
  full: [
    ['dsh-loop', '1.4.0'], ['dsh-git-helper', '1.2.1'], ['dsh-legacy-search', '0.9.4'], ['dsh-agent-team', '0.4.0'],
    ['dsh-github-bridge', '2.0.0'], ['dsh-old-widget', '0.3.0'], ['dsh-local-experiment', '0.0.1'],
  ],
  none: [],
}

/** Write a stub package: a manifest with a version and an entry point that loads. */
function writePackage(root, name, version, broken = false) {
  const dir = join(root, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name, version, main: 'index.js' })}\n`)
  writeFileSync(join(dir, 'index.js'), broken ? "throw new Error('incompatible with this Mayfly')\n" : 'module.exports = {}\n')
}

/**
 * Seed the market of a scenario.
 * @param {object} options
 * @param {{ installed?: 'full' | 'none', offline?: boolean, stale?: boolean, delayMs?: number, broken?: readonly string[] }} options.market - the scenario's `market`.
 * @param {string} options.dshHome - the `bench` profile's home.
 * @param {string} options.dir - where the fake `dsh` keeps its fixture copy (the session directory).
 * @returns {Promise<{ config: Record<string, Record<string, unknown>>, env: Record<string, string>, close(): Promise<void> }>}
 */
export async function prepareMarket({ market, dshHome, dir }) {
  const profileDir = join(dshHome, 'profiles', 'bench')
  if (!existsSync(join(profileDir, 'package.json'))) throw new Error('a market scenario needs the throwaway bench profile: run it with pnpm run scenario or pnpm run frame')
  const fixture = join(dir, 'market-index.json')
  writeFileSync(fixture, JSON.stringify(marketIndex()))

  const manifestPath = join(profileDir, 'package.json')
  // A run that died before `close` leaves its plugins behind: the baseline is the profile without any `dsh-*` package.
  for (const name of readdirSafe(join(profileDir, 'node_modules'))) if (name.startsWith('dsh-')) rmSync(join(profileDir, 'node_modules', name), { recursive: true, force: true })
  const stored = JSON.parse(readFileSync(manifestPath, 'utf8'))
  stored.dependencies = Object.fromEntries(Object.entries(stored.dependencies ?? {}).filter(([name]) => !name.startsWith('dsh-')))
  const manifestBefore = `${JSON.stringify(stored, null, 2)}\n`
  const manifest = JSON.parse(manifestBefore)
  const planted = []
  for (const [name, version] of INSTALLED[market.installed ?? 'full']) {
    manifest.dependencies = { ...manifest.dependencies, [name]: `^${version}` }
    writePackage(profileDir, name, version)
    planted.push(name)
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const cachePath = join(dshHome, 'storages', 'mayfly-plugin-market', 'cache.json')
  const cacheBefore = existsSync(cachePath) ? readFileSync(cachePath, 'utf8') : undefined
  let server
  let url
  if (market.offline === true || market.stale === true) {
    url = UNREACHABLE
    if (market.stale === true) {
      mkdirSync(dirname(cachePath), { recursive: true })
      writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.parse('2025-12-29T09:00:00Z'), indexUrl: url, text: JSON.stringify(marketIndex()) }))
    } else rmSync(cachePath, { force: true })
  } else {
    server = createServer((request, response) => {
      if ((request.url ?? '').split('?')[0] !== '/index.json') { response.writeHead(404).end(); return }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(marketIndex()))
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    url = `http://127.0.0.1:${String(server.address().port)}/index.json`
  }

  return {
    config: { mayfly: { marketIndexUrl: url } },
    env: {
      MAYFLY_DSH_BIN: FAKE_DSH,
      FAKE_DSH_FIXTURE: fixture,
      FAKE_DSH_DELAY_MS: String(market.delayMs ?? 1500),
      FAKE_DSH_BROKEN: (market.broken ?? []).join(','),
    },
    close: async () => {
      if (server !== undefined) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
      // Put the bench profile and the cache back the way they were.
      writeFileSync(manifestPath, manifestBefore)
      const restored = JSON.parse(manifestBefore).dependencies ?? {}
      for (const name of planted) if (!(name in restored)) rmSync(join(profileDir, 'node_modules', name), { recursive: true, force: true })
      for (const name of readdirSafe(join(profileDir, 'node_modules'))) if (name.startsWith('dsh-') && !(name in restored)) rmSync(join(profileDir, 'node_modules', name), { recursive: true, force: true })
      if (cacheBefore === undefined) rmSync(cachePath, { force: true })
      else writeFileSync(cachePath, cacheBefore)
    },
  }
}

function readdirSafe(path) {
  try { return readdirSync(path) } catch { return [] }
}
