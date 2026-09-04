/**
 * Tests for `/plugin` over the real command runtime: the catalog browse
 * panel (groups, badges, detail panel), the installed view (updates and
 * removed-from-market rows), the argument paths (install with npm and
 * GitHub sources, uninstall, info, list, refresh, usage errors), the
 * dsh-CLI seam (allowBuilds preflight, profile-patch row insertion and
 * removal, failure reporting), and the offline catalog state — all over
 * scripted `updaterInternals` seams like the update-command specs.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtempTracked, registerTempDirCleanup } from '../core/temp-dir.ts'

registerTempDirCleanup()
import { updaterInternals, type SpawnOutcome } from '../../src/interaction/updater/io.ts'
import { setSharedEditor } from '../../src/interaction/editor-instance.ts'
import { registerPluginCommand } from '../../src/interaction/plugin-commands.ts'
import { entryInstallStates, readInstalledPlugins, rowSpec, installEntry, uninstallEntry, entrySupportsSource, MAYFLY_PACKAGE } from '../../src/interaction/plugin-market/installer.ts'
import * as settingsPlugin from '../../src/interaction/settings.ts'
import { InteractionStateService } from '../../src/interaction/runtime-state.ts'
import { fakeMayflyContext, KEY, type FakeScreen } from './fakes.ts'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'
import type { MarketEntry } from '../../src/interaction/plugin-market/types.ts'

/** The real seams, restored after every test. */
const REAL = { ...updaterInternals }

afterEach(() => {
  Object.assign(updaterInternals, REAL)
  vi.restoreAllMocks()
})

/** A spawn success. */
function ok(stdout = ''): SpawnOutcome {
  return { code: 0, signal: null, stdout, stderr: '', timedOut: false }
}

/** A marketplace entry fixture with every optional field populated. */
function entry(overrides: Partial<MarketEntry> = {}): MarketEntry {
  return {
    id: 'loop',
    source: 'official',
    displayName: 'Loop',
    description: 'Recurring prompts and alarms.',
    descriptionZh: '循环提示与闹钟。',
    author: { name: 'Ephemeral AI Lab', url: 'https://github.com/Ephemeral-AI-Lab' },
    links: { repo: 'https://github.com/Ephemeral-AI-Lab/dsh-plugins' },
    license: 'MIT',
    category: 'workflow',
    status: 'stable',
    surfaces: { server: {}, web: { clientModule: true } },
    provides: { tools: ['loop_create'], commands: ['/loop'] },
    install: {
      rows: [
        {
          id: 'loop',
          name: 'dsh-loop',
          npm: { spec: 'dsh-loop' },
          github: { repo: 'Ephemeral-AI-Lab/dsh-plugins', ref: 'main', subdir: 'plugins/loop' },
        },
      ],
    },
    engines: { dsh: '>=0.1.0-rc.5', node: '>=22' },
    capabilities: ['timer'],
    verified: { at: '2026-09-04', packages: [{ name: 'dsh-loop', version: '0.1.4' }] },
    npm: { 'dsh-loop': { latestVersion: '0.1.4' } },
    ...overrides,
  }
}

/** The index document for the scripted network. */
function indexJson(entries: readonly MarketEntry[]): string {
  return JSON.stringify({ schemaVersion: 1, generatedAt: '2026-09-04T00:00:00.000Z', entries })
}

/** What the dsh CLI spawn scripts do. */
interface SpawnScript {
  /** Behavior for `dsh plugin ...`; defaults to a success that records. */
  plugin?: (args: readonly string[]) => SpawnOutcome
  /** `command -v dsh` result; default resolves `/usr/bin/dsh`. */
  dshOnPath?: boolean
}

/** One command world: temp profile, scripted network and spawns, command mounted. */
async function mountWorld(options: {
  index?: readonly MarketEntry[]
  offline?: boolean
  profileDependencies?: Readonly<Record<string, string>>
  installedVersions?: Readonly<Record<string, string>>
  spawn?: SpawnScript
  withScreen?: boolean
} = {}) {
  const home = mkdtempTracked('mayfly-plugin-cmd-')
  const root = join(home, '.dsh', 'profiles', 'mayfly')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'dsh-profile-mayfly',
    private: true,
    dependencies: {
      '@ephemeral-ai/mayfly': '0.1.0-alpha.1',
      ...(options.profileDependencies ?? {}),
    },
    dsh: { profile: { bundles: ['@ephemeral-ai/mayfly'] } },
  }))
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  writeFileSync(join(root, 'cordis.patch.yml'), '# empty profile layer\n[]\n')
  for (const [name, version] of Object.entries(options.installedVersions ?? {})) {
    const dir = join(root, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
  }

  const spawns: Array<{ cmd: string, args: readonly string[] }> = []
  const writes: string[] = []
  updaterInternals.env = { DSH_HOME: join(home, '.dsh'), DSH_BIN: '/usr/bin/dsh' }
  updaterInternals.homedir = () => home
  updaterInternals.now = () => 1_000_000
  updaterInternals.fetchText = vi.fn(async (url: string) => {
    if (options.offline === true) throw new Error(`registry responded 503 for ${url}`)
    if (url.includes('jsdelivr') || url.includes('raw.githubusercontent')) {
      if (options.index === undefined) throw new Error('no index scripted')
      return indexJson(options.index)
    }
    throw new Error(`no route for ${url}`)
  })
  const realWrite = updaterInternals.writeTextFile
  updaterInternals.writeTextFile = vi.fn((path: string, data: string) => {
    writes.push(`${path.replace(root, '<root>')}: ${data.replaceAll('\n', ' ⏎ ')}`)
    realWrite(path, data)
  })
  updaterInternals.spawnOnce = vi.fn(async (cmd: string, args: readonly string[]) => {
    spawns.push({ cmd, args: [...args] })
    if (cmd === '/usr/bin/dsh' && args[0] === 'plugin') {
      return options.spawn?.plugin?.(args) ?? ok()
    }
    return ok('/usr/bin/dsh')
  })

  const mayfly = options.withScreen === false ? undefined : fakeMayflyContext()
  const ctx = mayfly?.ctx ?? new Context()
  // The fakes mount the interaction state with the screen; a bare context
  // still needs one for the settings thunk.
  if (mayfly === undefined) new InteractionStateService(ctx, settingsPlugin.DEFAULT_SETTINGS)
  // The Service constructor registers itself; the fakes ship no locale.
  if (mayfly !== undefined) new MayflyLocaleService(ctx, { systemLocale: 'en' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  const session = ctx.sessions.create(SessionId('plugin-spec'))
  const agent = { id: session.id, session, status: 'idle' } as unknown as Agent
  // Mount inside a dedicated plugin fiber so specs can dispose it and stage
  // the unload gates (the agents-command spec's discipline).
  const fiber = await ctx.plugin({ name: 'plugin-market-spec', inject: ['commands'], apply: c => { registerPluginCommand(c) } })
  const dispose = (): void => { void fiber.dispose() }
  const notices: string[] = []
  if (mayfly !== undefined) {
    setSharedEditor(ctx, { submitPrompt: () => {}, notice: text => notices.push(text) } as never)
  }
  return {
    ctx,
    screen: mayfly?.screen as FakeScreen,
    agent,
    root,
    spawns,
    writes,
    notices,
    dispose,
    run: async (line: string) => {
      const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
      return execution?.result
    },
    overlay: (): unknown => (mayfly?.screen as FakeScreen | undefined)?.overlays.at(-1)?.component,
  }
}

describe('installer unit seams', () => {
  it('composes npm and github specs, including monorepo subdirectories', () => {
    const row = entry().install.rows[0]!
    expect(rowSpec(row, 'npm')).toBe('dsh-loop')
    expect(rowSpec(row, 'github')).toBe('github:Ephemeral-AI-Lab/dsh-plugins#main&path:plugins/loop')
    expect(rowSpec({ name: 'x' }, 'npm')).toBeUndefined()
    expect(rowSpec({ name: 'x', github: { repo: 'a/b', ref: 'abc123' } }, 'github')).toBe('github:a/b#abc123')
  })

  it('reports which sources an entry supports', () => {
    expect(entrySupportsSource(entry(), 'npm')).toBe(true)
    expect(entrySupportsSource({ ...entry(), install: { rows: [{ name: 'x', github: { repo: 'a/b', ref: 'r' } }] } }, 'npm')).toBe(false)
  })

  it('reads installed plugins, skipping Mayfly itself', () => {
    const root = mkdtempTracked('mayfly-installed-')
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      dependencies: { [MAYFLY_PACKAGE]: '1.0.0', 'dsh-loop': 'github:x', broken: 5 },
    }))
    mkdirSync(join(root, 'node_modules', 'dsh-loop'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'dsh-loop', 'package.json'), JSON.stringify({ name: 'dsh-loop', version: '0.1.3' }))
    expect(readInstalledPlugins(root)).toEqual([{ name: 'dsh-loop', spec: 'github:x', version: '0.1.3' }])
  })

  it('reads an absent or broken profile as no plugins', () => {
    const root = mkdtempTracked('mayfly-installed-')
    expect(readInstalledPlugins(root)).toEqual([])
    writeFileSync(join(root, 'package.json'), 'not json')
    expect(readInstalledPlugins(root)).toEqual([])
    writeFileSync(join(root, 'package.json'), 'null')
    expect(readInstalledPlugins(root)).toEqual([])
  })

  it('derives install states including partial installs and updates', () => {
    const twoRows = entry({
      id: 'sidechat',
      install: { rows: [{ name: 'dsh-workbench-ui' }, { name: 'dsh-sidechat' }] },
    })
    const states = entryInstallStates([twoRows, entry()], [
      { name: 'dsh-workbench-ui', spec: 'x', version: '0.1.0' },
      { name: 'dsh-loop', spec: 'y', version: '0.1.3' },
    ])
    expect(states.sidechat).toEqual({ installed: false, version: undefined, updateAvailable: false })
    expect(states.loop).toEqual({ installed: true, version: '0.1.3', updateAvailable: true })
  })

  it('installs: allowBuilds first, one add carrying every spec, then profile-patch rows', async () => {
    const profilePatch = entry({
      install: {
        allowBuilds: ['node-pty'],
        rows: [{ id: 'terminal-bash', name: '@deepseek-ai/dsh-terminal-bash', activation: 'profile-patch', npm: { spec: '@deepseek-ai/dsh-terminal-bash' } }],
      },
    })
    updaterInternals.spawnOnce = vi.fn(async () => ok())
    const root = mkdtempTracked('mayfly-install-')
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    writeFileSync(join(root, 'cordis.patch.yml'), '[]\n')
    const outcome = await installEntry({ dshBin: 'dsh', profile: 'p', root, entry: profilePatch, source: 'npm' })
    expect(outcome.kind).toBe('success')
    expect(updaterInternals.readTextFile(join(root, 'pnpm-workspace.yaml'))).toContain('"node-pty": true')
    expect(updaterInternals.readTextFile(join(root, 'cordis.patch.yml'))).toContain(`- id: terminal-bash\n  name: "@deepseek-ai/dsh-terminal-bash"`)
  })

  it('appending to a non-empty patch layer keeps existing rows, and config renders', async () => {
    const withConfig = entry({
      install: { rows: [{ id: 'code-runtime', name: '@deepseek-ai/dsh-code-runtime-worker-thread', activation: 'profile-patch', config: { computeMs: 60000 }, npm: { spec: 'x' } }] },
    })
    updaterInternals.spawnOnce = vi.fn(async () => ok())
    const root = mkdtempTracked('mayfly-install-')
    writeFileSync(join(root, 'cordis.patch.yml'), '- id: keep\n  name: \'keep-me\'\n')
    const outcome = await installEntry({ dshBin: 'dsh', profile: 'p', root, entry: withConfig, source: 'npm' })
    expect(outcome.kind).toBe('success')
    const patch = updaterInternals.readTextFile(join(root, 'cordis.patch.yml')) ?? ''
    expect(patch).toContain('- id: keep')
    expect(patch).toContain('config:\n    computeMs: 60000')
  })

  it('uninstalling removes exactly the entry\'s patch blocks', async () => {
    const two = entry({
      install: { rows: [{ id: 'a', name: 'pkg-a', activation: 'profile-patch', npm: { spec: 'a' } }, { id: 'b', name: 'pkg-b' }] },
    })
    updaterInternals.spawnOnce = vi.fn(async () => ok())
    const root = mkdtempTracked('mayfly-uninstall-')
    writeFileSync(join(root, 'cordis.patch.yml'), [
      '- id: keep',
      "  name: 'keep-me'",
      '- id: a',
      "  name: 'pkg-a'",
      '  config:',
      '    x: 1',
      '- id: after',
      "  name: 'pkg-after'",
    ].join('\n') + '\n')
    const outcome = await uninstallEntry({ dshBin: 'dsh', profile: 'p', root, entry: two, source: 'npm' })
    expect(outcome.kind).toBe('success')
    const patch = updaterInternals.readTextFile(join(root, 'cordis.patch.yml')) ?? ''
    expect(patch).toContain('keep-me')
    expect(patch).toContain('pkg-after')
    expect(patch).not.toContain("'pkg-a'")
    expect(patch).not.toContain('x: 1')
  })

  it('reports install failures with the allowBuilds follow-up when pnpm raised it', async () => {
    const failing = entry()
    const root = mkdtempTracked('mayfly-install-')
    const realSpawn = updaterInternals.spawnOnce
    updaterInternals.spawnOnce = async () => ({ code: 1, signal: null, stdout: '', stderr: 'ERR_PNPM_IGNORED_BUILDS add the package to "allowBuilds"', timedOut: false })
    const outcome = await installEntry({ dshBin: 'dsh', profile: 'p', root, entry: failing, source: 'npm' })
    updaterInternals.spawnOnce = realSpawn
    expect(outcome).toMatchObject({ kind: 'error', text: expect.stringContaining('allowBuilds in the profile pnpm-workspace.yaml') })
  })

  it('reports spawn errors and timeouts distinctly', async () => {
    const root = mkdtempTracked('mayfly-install-')
    const enoent = await installEntry({ dshBin: 'dsh', profile: 'p', root, entry: entry(), source: 'npm' }).catch(() => undefined)
    void enoent
    const realSpawn = updaterInternals.spawnOnce
    updaterInternals.spawnOnce = async () => ({ code: null, signal: null, stdout: '', stderr: '', timedOut: true, spawnError: 'ENOENT' })
    const outcome = await installEntry({ dshBin: 'dsh', profile: 'p', root, entry: entry(), source: 'npm' })
    updaterInternals.spawnOnce = realSpawn
    expect(outcome).toMatchObject({ kind: 'error', text: expect.stringContaining('failed to start') })
    updaterInternals.spawnOnce = async () => ({ code: null, signal: null, stdout: '', stderr: '', timedOut: true })
    const timedOut = await uninstallEntry({ dshBin: 'dsh', profile: 'p', root, entry: entry(), source: 'npm' })
    updaterInternals.spawnOnce = realSpawn
    expect(timedOut).toMatchObject({ kind: 'error', text: expect.stringContaining('timed out') })
  })

  it('refuses a source the entry does not declare', async () => {
    const githubOnly = { ...entry(), install: { rows: [{ name: 'dsh-loop', github: { repo: 'a/b', ref: 'r' } }] } }
    const outcome = await installEntry({ dshBin: 'dsh', profile: 'p', root: mkdtempTracked('mayfly-install-'), entry: githubOnly, source: 'npm' })
    expect(outcome).toMatchObject({ kind: 'error', text: expect.stringContaining('no npm install source') })
  })

  it('skips allowBuilds entirely for entries without them', async () => {
    updaterInternals.spawnOnce = vi.fn(async () => ok())
    const root = mkdtempTracked('mayfly-install-')
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    await installEntry({ dshBin: 'dsh', profile: 'p', root, entry: entry(), source: 'npm' })
    expect(updaterInternals.readTextFile(join(root, 'pnpm-workspace.yaml'))).toBe('packages:\n  - .\n')
  })
})

describe('/plugin browse panel', () => {
  it('loads the catalog and opens the grouped browse panel', async () => {
    const world = await mountWorld({ index: [entry()] })
    const result = await world.run('/plugin')
    expect(result).toEqual({ kind: 'success' })
    const panel = world.overlay()
    expect(panel).toBeDefined()
    const node = (panel as { currentNode(): { kind: string, child?: { children?: Array<{ node: unknown }> } } }).currentNode()
    expect(JSON.stringify(node)).toContain('Loop')
    expect(JSON.stringify(node)).toContain('official · Web+Server')
    world.dispose()
  })

  it('shows the offline document when nothing can be fetched', async () => {
    const world = await mountWorld({ offline: true })
    await world.run('/plugin')
    const node = (world.overlay() as { currentNode(): unknown }).currentNode()
    expect(JSON.stringify(node)).toContain('offline')
    world.dispose()
  })

  it('hides removed entries from the catalog', async () => {
    const world = await mountWorld({ index: [entry(), entry({ id: 'gone', displayName: 'Gone', status: 'removed', statusNote: 'security' })] })
    await world.run('/plugin')
    const node = (world.overlay() as { currentNode(): unknown }).currentNode()
    expect(JSON.stringify(node)).not.toContain('Gone')
    world.dispose()
  })

  it('errors without the Mayfly screen', async () => {
    const world = await mountWorld({ index: [entry()], withScreen: false })
    const result = await world.run('/plugin')
    expect(result).toMatchObject({ kind: 'error', text: expect.stringContaining('not mounted') })
    world.dispose()
  })
})

describe('/plugin argument paths', () => {
  it('installs via npm by default and reminds about the restart', async () => {
    const world = await mountWorld({ index: [entry()] })
    const result = await world.run('/plugin install loop')
    expect(result).toEqual({ kind: 'success' })
    const dsh = world.spawns.find(spawn => spawn.cmd === '/usr/bin/dsh')
    expect(dsh?.args).toEqual(['plugin', '--profile', 'mayfly', 'add', 'dsh-loop'])
    expect(world.notices.at(-1)).toBe('installed; restart Mayfly and start a new session to apply')
    world.dispose()
  })

  it('installs via github with --source github', async () => {
    const world = await mountWorld({ index: [entry()] })
    await world.run('/plugin install loop --source github')
    const dsh = world.spawns.find(spawn => spawn.cmd === '/usr/bin/dsh')
    expect(dsh?.args).toEqual(['plugin', '--profile', 'mayfly', 'add', 'github:Ephemeral-AI-Lab/dsh-plugins#main&path:plugins/loop'])
    world.dispose()
  })

  it('installs multi-row entries with every spec in one add', async () => {
    const sidechat = entry({
      id: 'sidechat',
      displayName: 'Sidechat',
      install: { rows: [{ name: 'dsh-workbench-ui', npm: { spec: 'dsh-workbench-ui' } }, { name: 'dsh-sidechat', npm: { spec: 'dsh-sidechat' } }] },
    })
    const world = await mountWorld({ index: [sidechat] })
    await world.run('/plugin install sidechat')
    const dsh = world.spawns.find(spawn => spawn.cmd === '/usr/bin/dsh')
    expect(dsh?.args).toEqual(['plugin', '--profile', 'mayfly', 'add', 'dsh-workbench-ui', 'dsh-sidechat'])
    world.dispose()
  })

  it('warns before installing a web-only entry and still installs', async () => {
    const webOnly = entry({ id: 'panel', displayName: 'Panel', surfaces: { web: { clientModule: true } } })
    const world = await mountWorld({ index: [webOnly] })
    await world.run('/plugin install panel')
    expect(world.notices).toContain('web-only plugin: it contributes nothing in this terminal frontend')
    expect(world.spawns.some(spawn => spawn.cmd === '/usr/bin/dsh')).toBe(true)
    world.dispose()
  })

  it('reports install failures from the CLI seam', async () => {
    const world = await mountWorld({ index: [entry()], spawn: { plugin: () => ({ code: 1, signal: null, stdout: '', stderr: 'pnpm: network down', timedOut: false }) } })
    await world.run('/plugin install loop')
    expect(world.notices.at(-1)).toBe('install failed: installing "Loop" failed: pnpm: network down')
    world.dispose()
  })

  it('uninstalls installed entries and refuses the rest', async () => {
    const notInstalled = entry({ id: 'fresh-thing', displayName: 'Fresh Thing', install: { rows: [{ name: 'fresh-thing-pkg', npm: { spec: 'fresh-thing-pkg' } }] } })
    const world = await mountWorld({
      index: [entry(), notInstalled],
      profileDependencies: { 'dsh-loop': '0.1.4' },
      installedVersions: { 'dsh-loop': '0.1.4' },
    })
    const refusal = await world.run('/plugin uninstall fresh-thing')
    expect(refusal).toMatchObject({ kind: 'error', text: expect.stringContaining('not installed') })
    const result = await world.run('/plugin uninstall loop')
    expect(result).toEqual({ kind: 'success' })
    const dsh = world.spawns.find(spawn => spawn.cmd === '/usr/bin/dsh')
    expect(dsh?.args).toEqual(['plugin', '--profile', 'mayfly', 'remove', 'dsh-loop'])
    expect(world.notices.at(-1)).toBe('removed; restart Mayfly and start a new session to apply')
    world.dispose()
  })

  it('info opens the detail panel with the entry facts', async () => {
    const world = await mountWorld({ index: [entry()] })
    const result = await world.run('/plugin info loop')
    expect(result).toEqual({ kind: 'success' })
    const node = (world.overlay() as { currentNode(): unknown }).currentNode()
    const json = JSON.stringify(node)
    expect(json).toContain('Loop')
    expect(json).toContain('loop_create')
    expect(json).toContain('/loop')
    expect(json).toContain('dsh plugin --profile <name> add dsh-loop')
    expect(json).toContain('2026-09-04')
    world.dispose()
  })

  it('info covers the sparse shapes: no provides, no extras, zh description', async () => {
    const sparse = entry({
      id: 'bare',
      displayName: 'Bare',
      descriptionZh: undefined,
      provides: {},
      engines: undefined,
      capabilities: [],
      verified: undefined,
      links: {},
      npm: {},
      status: 'deprecated',
      statusNote: 'superseded',
    })
    const world = await mountWorld({ index: [sparse] })
    await world.run('/plugin info bare')
    const json = JSON.stringify((world.overlay() as { currentNode(): unknown }).currentNode())
    expect(json).toContain('none declared')
    expect(json).toContain('superseded')
    expect(json).toContain('unknown')
    world.dispose()
  })

  it('list groups installed rows by state, including removed-from-market', async () => {
    const gone = entry({ id: 'gone', displayName: 'Gone', status: 'removed', statusNote: 'yanked', install: { rows: [{ name: 'gone-pkg' }] } })
    const updated = entry({ id: 'loop', npm: { 'dsh-loop': { latestVersion: '0.1.5' } } })
    const fresh = entry({ id: 'fresh', displayName: 'Fresh', install: { rows: [{ name: 'dsh-fresh-pkg', npm: { spec: 'dsh-fresh-pkg' } }] } })
    const world = await mountWorld({
      index: [gone, updated, fresh],
      profileDependencies: { 'gone-pkg': '1.0.0', 'dsh-loop': '0.1.4', 'dsh-fresh-pkg': '0.1.0' },
      installedVersions: { 'dsh-loop': '0.1.4', 'dsh-fresh-pkg': '0.1.0' },
    })
    await world.run('/plugin list')
    const json = JSON.stringify((world.overlay() as { currentNode(): unknown }).currentNode())
    expect(json).toContain('yanked')
    expect(json).toContain('up 0.1.5')
    expect(json).toContain('Fresh')
    world.dispose()
  })

  it('list shows the empty state when nothing is installed', async () => {
    const world = await mountWorld({ index: [entry()] })
    await world.run('/plugin list')
    const json = JSON.stringify((world.overlay() as { currentNode(): unknown }).currentNode())
    expect(json).toContain('no plugins installed')
    world.dispose()
  })

  it('refresh reports the entry count, or the failure when offline', async () => {
    const world = await mountWorld({ index: [entry()] })
    expect(await world.run('/plugin refresh')).toEqual({ kind: 'success', text: 'refreshed 1 entries' })
    const offline = await mountWorld({ offline: true })
    expect(await offline.run('/plugin refresh')).toMatchObject({ kind: 'error', text: expect.stringContaining('refresh failed') })
    world.dispose()
    offline.dispose()
  })

  it('rejects unknown ids and malformed verbs', async () => {
    const world = await mountWorld({ index: [entry()] })
    expect(await world.run('/plugin install nope')).toMatchObject({ kind: 'error', text: 'unknown plugin: nope' })
    expect(await world.run('/plugin install')).toMatchObject({ kind: 'error', text: expect.stringContaining('usage') })
    expect(await world.run('/plugin info')).toMatchObject({ kind: 'error', text: expect.stringContaining('usage') })
    expect(await world.run('/plugin dance')).toMatchObject({ kind: 'error', text: expect.stringContaining('usage') })
    world.dispose()
  })

  it('finds entries by package name too', async () => {
    const world = await mountWorld({ index: [entry()] })
    expect(await world.run('/plugin info dsh-loop')).toEqual({ kind: 'success' })
    world.dispose()
  })
})

describe('/plugin key paths', () => {
  it('i installs the selected row and u removes it, r refreshes', async () => {
    const world = await mountWorld({
      index: [entry()],
      profileDependencies: { 'dsh-loop': '0.1.4' },
      installedVersions: { 'dsh-loop': '0.1.4' },
    })
    await world.run('/plugin')
    const panel = world.overlay() as { handleInput(data: string): void, currentNode(): unknown }
    panel.handleInput('u')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(world.spawns.some(spawn => spawn.args.includes('remove'))).toBe(true)
    world.dispose()
  })

  it('u on an uninstalled entry only flashes a notice', async () => {
    const world = await mountWorld({ index: [entry()] })
    await world.run('/plugin')
    const panel = world.overlay() as { handleInput(data: string): void }
    panel.handleInput('u')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(world.spawns.filter(spawn => spawn.cmd === '/usr/bin/dsh')).toHaveLength(0)
    expect(world.notices).toContain('"Loop" is not installed in this profile')
    world.dispose()
  })
})

describe('/plugin coverage corners', () => {
  it('mounts the loading document first, then swaps in the catalog', async () => {
    let release: ((value: string) => void) | undefined
    const gate = new Promise<string>(resolve => {
      release = resolve
    })
    const world = await mountWorld({})
    const realFetch = updaterInternals.fetchText
    updaterInternals.fetchText = vi.fn(async (url: string) => (url.includes('jsdelivr') || url.includes('raw.githubusercontent') ? gate : realFetch(url)))
    await world.run('/plugin')
    let json = JSON.stringify((world.overlay() as { currentNode(): unknown }).currentNode())
    expect(json).toContain('loading catalog...')
    release?.(indexJson([entry()]))
    await new Promise(resolve => setTimeout(resolve, 10))
    json = JSON.stringify((world.overlay() as { currentNode(): unknown }).currentNode())
    expect(json).toContain('Loop')
    world.dispose()
  })

  it('serializes overlapping operations through the in-flight guard', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const world = await mountWorld({ index: [entry()] })
    const realSpawn = updaterInternals.spawnOnce
    updaterInternals.spawnOnce = vi.fn(async (cmd: string, args: readonly string[]) => {
      if (cmd === 'sh') return { code: 0, signal: null, stdout: '/usr/bin/dsh\n', stderr: '', timedOut: false }
      if (args[0] === 'plugin') await gate
      return realSpawn(cmd, args)
    })
    await world.run('/plugin')
    const panel = world.overlay() as { handleInput(data: string): void }
    panel.handleInput('i')
    await new Promise(resolve => setTimeout(resolve, 5))
    panel.handleInput('I')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(world.notices).toContain('a plugin operation is already running')
    release?.()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(world.spawns.filter(spawn => spawn.args.includes('add'))).toHaveLength(1)
    world.dispose()
  })

  it('requires the dsh CLI for operations', async () => {
    const world = await mountWorld({ index: [entry()] })
    updaterInternals.env = { DSH_HOME: updaterInternals.env.DSH_HOME }
    const realSpawn = updaterInternals.spawnOnce
    updaterInternals.spawnOnce = vi.fn(async (cmd: string) => (cmd === 'sh' ? { code: 1, signal: null, stdout: '', stderr: '', timedOut: false } : realSpawn(cmd, [])))
    await world.run('/plugin install loop')
    expect(world.notices.at(-1)).toBe('plugin operations need the dsh CLI on PATH (or $DSH_BIN)')
    world.dispose()
  })

  it('refuses a source the entry does not declare, from the argument path', async () => {
    const githubOnly = entry({ id: 'gh', displayName: 'GH', install: { rows: [{ name: 'gh-pkg', github: { repo: 'a/b', ref: 'r' } }] } })
    const world = await mountWorld({ index: [githubOnly] })
    await world.run('/plugin install gh')
    expect(world.notices.at(-1)).toBe('"GH" has no npm install source')
    world.dispose()
  })

  it('Enter opens the detail overlay above the browse panel; Escape pops it', async () => {
    const world = await mountWorld({ index: [entry()] })
    await world.run('/plugin')
    const panel = world.overlay() as { handleInput(data: string): void }
    expect(world.screen.overlays).toHaveLength(1)
    await vi.waitFor(() => {
      expect(JSON.stringify(panel.currentNode())).toContain('Loop')
    })
    // Compile the surface once, then step focus into the list and activate
    // the row (the trace-command spec's driving discipline).
    ;(panel as unknown as { render(width: number): string[] }).render(80)
    panel.handleInput(KEY.tab)
    panel.handleInput(KEY.enter)
    await vi.waitFor(() => {
      expect(world.screen.overlays).toHaveLength(2)
    })
    const detail = world.screen.overlays.at(-1)!.component as { handleInput(data: string): void }
    detail.handleInput(KEY.escape)
    expect(world.screen.overlays.at(-1)!.hidden).toBe(true)
    expect(world.screen.overlays[0]!.hidden).toBe(false)
    world.dispose()
  })

  it('r refreshes through the panel, hotkeys are case-insensitive, and other keys pass through', async () => {
    const world = await mountWorld({ index: [entry()] })
    await world.run('/plugin')
    const panel = world.overlay() as { handleInput(data: string): void }
    panel.handleInput('R')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(updaterInternals.fetchText).toHaveBeenCalled()
    panel.handleInput('U')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(world.notices).toContain('"Loop" is not installed in this profile')
    // Any other printable key starts the built-in type-to-filter instead.
    panel.handleInput('x')
    world.dispose()
  })

  it('i with no selected row is a no-op', async () => {
    const world = await mountWorld({ index: [] })
    await world.run('/plugin')
    const panel = world.overlay() as { handleInput(data: string): void }
    panel.handleInput('i')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(world.spawns.filter(spawn => spawn.cmd === '/usr/bin/dsh' && spawn.args[0] === 'plugin')).toHaveLength(0)
    world.dispose()
  })

  it('installs through the i hotkey with the web-only warning for web-only entries', async () => {
    const webOnly = entry({ id: 'panel', displayName: 'Panel', surfaces: { web: { clientModule: true } } })
    const world = await mountWorld({ index: [webOnly] })
    await world.run('/plugin')
    const panel = world.overlay() as { handleInput(data: string): void }
    panel.handleInput('i')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(world.notices).toContain('web-only plugin: it contributes nothing in this terminal frontend')
    expect(world.spawns.some(spawn => spawn.args.includes('add'))).toBe(true)
    world.dispose()
  })

  it('derives states for not-installed and version-less installed entries', () => {
    const ghOnly = entry({ id: 'gh', install: { rows: [{ name: 'gh-pkg', github: { repo: 'a/b', ref: 'r' } }] } })
    const states = entryInstallStates([ghOnly, entry({ id: 'unrelated', install: { rows: [{ name: 'zz-pkg', npm: { spec: 'z' } }] } })], [
      { name: 'gh-pkg', spec: 'github:a/b#r', version: undefined },
    ])
    expect(states.gh).toEqual({ installed: true, version: undefined, updateAvailable: false })
    expect(states.unrelated).toEqual({ installed: false, version: undefined, updateAvailable: false })
  })

  it('rowSpec returns undefined when the requested source is absent', () => {
    expect(rowSpec({ name: 'x', npm: { spec: 's' } }, 'github')).toBeUndefined()
  })

  it('reads a profile whose dependencies block is null', () => {
    const root = mkdtempTracked('mayfly-installed-')
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: null }))
    expect(readInstalledPlugins(root)).toEqual([])
  })

  it('allowBuilds merge is idempotent across installs', async () => {
    const profilePatch = entry({ install: { allowBuilds: ['node-pty'], rows: [{ id: 't', name: 'pkg-t', activation: 'profile-patch', npm: { spec: 'pkg-t' } }] } })
    const root = mkdtempTracked('mayfly-install-')
    updaterInternals.spawnOnce = vi.fn(async () => ok())
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - .\nallowBuilds:\n  "node-pty": true\n')
    await installEntry({ dshBin: 'dsh', profile: 'p', root, entry: profilePatch, source: 'npm' })
    expect(updaterInternals.readTextFile(join(root, 'pnpm-workspace.yaml'))).toBe('packages:\n  - .\nallowBuilds:\n  "node-pty": true\n')
  })

  it('uninstall tolerates a missing patch file and unquoted names', async () => {
    const unquoted = entry({ install: { rows: [{ id: 'u', name: 'bare-pkg', activation: 'profile-patch', npm: { spec: 'u' } }] } })
    const root = mkdtempTracked('mayfly-uninstall-')
    updaterInternals.spawnOnce = vi.fn(async () => ok())
    const withoutFile = await uninstallEntry({ dshBin: 'dsh', profile: 'p', root, entry: unquoted, source: 'npm' })
    expect(withoutFile.kind).toBe('success')
    writeFileSync(join(root, 'cordis.patch.yml'), '- id: u\n  name: bare-pkg\n')
    const outcome = await uninstallEntry({ dshBin: 'dsh', profile: 'p', root, entry: unquoted, source: 'npm' })
    expect(outcome.kind).toBe('success')
    expect(updaterInternals.readTextFile(join(root, 'cordis.patch.yml'))).toBe('')
  })
})

describe('/plugin lifecycle and locale', () => {
  it('stops touching the context after the fiber unloads mid-load', async () => {
    let release: ((value: string) => void) | undefined
    const gate = new Promise<string>(resolve => {
      release = resolve
    })
    const world = await mountWorld({})
    const realFetch = updaterInternals.fetchText
    updaterInternals.fetchText = vi.fn(async (url: string) => (url.includes('jsdelivr') || url.includes('raw.githubusercontent') ? gate : realFetch(url)))
    await world.run('/plugin')
    await world.dispose()
    release?.(indexJson([entry()]))
    await new Promise(resolve => setTimeout(resolve, 10))
    const json = JSON.stringify((world.overlay() as { currentNode(): unknown }).currentNode())
    expect(json).toContain('loading catalog...')
    world.dispose()
  })

  it('aborts an install that spans a fiber unload, at each await', async () => {
    // Gate the CLI spawn: the operate continuation after installEntry must
    // gate on the unload flag (and the runOperation invalidate after it).
    for (const verb of ['/plugin install loop', '/plugin uninstall loop'] as const) {
      const world = await mountWorld({
        index: [entry()],
        profileDependencies: verb.includes('uninstall') ? { 'dsh-loop': '0.1.4' } : {},
        installedVersions: verb.includes('uninstall') ? { 'dsh-loop': '0.1.4' } : {},
      })
      let release: (() => void) | undefined
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      const realSpawn = updaterInternals.spawnOnce
      updaterInternals.spawnOnce = vi.fn(async (cmd: string, args: readonly string[]) => {
        if (cmd === 'sh') return { code: 0, signal: null, stdout: '/usr/bin/dsh\n', stderr: '', timedOut: false }
        if (args[0] === 'plugin') await gate
        return realSpawn(cmd, args)
      })
      // Kick without awaiting: the handler parks on the gated spawn, the
      // dispose lands mid-flight, then the release lets it settle quietly.
      const execution = world.run(verb)
      await new Promise(resolve => setTimeout(resolve, 5))
      await world.dispose()
      release?.()
      await execution
      world.dispose()
    }
  })

  it('aborts an argument-path load and refresh that span a fiber unload', async () => {
    for (const line of ['/plugin install loop', '/plugin refresh'] as const) {
      let release: ((value: string) => void) | undefined
      const gate = new Promise<string>(resolve => {
        release = resolve
      })
      const world = await mountWorld({})
      const realFetch = updaterInternals.fetchText
      updaterInternals.fetchText = vi.fn(async (url: string) => (url.includes('jsdelivr') || url.includes('raw.githubusercontent') ? gate : realFetch(url)))
      const execution = world.run(line)
      await new Promise(resolve => setTimeout(resolve, 5))
      await world.dispose()
      release?.(indexJson([entry()]))
      await execution
      world.dispose()
    }
  })

  it('re-renders browse, detail, and info panels when the locale switches', async () => {
    const tui = entry({
      id: 'tui-pane',
      displayName: 'Tui Pane',
      status: 'unstable',
      surfaces: { server: {}, tui: { contributions: ['panes'] } },
    })
    const world = await mountWorld({ index: [entry(), tui] })
    await world.run('/plugin')
    const browse = world.overlay() as { handleInput(data: string): void, currentNode(): unknown }
    let json = JSON.stringify(browse.currentNode())
    expect(json).toContain('Tui Pane')
    expect(json).toContain('TUI+Server')
    expect(json).toContain('unstable')
    // Enter → detail above the browse panel; both observers re-render on a
    // preference switch, and the zh description takes over.
    ;(browse as unknown as { render(width: number): string[] }).render(80)
    browse.handleInput(KEY.enter)
    await vi.waitFor(() => {
      expect(world.screen.overlays).toHaveLength(2)
    })
    // Info panels are construction-frozen (the /mcp D40 boundary): a locale
    // switch re-renders the panels below but a fresh info is the zh one.
    world.ctx.mayflyLocale.setPreference('zh')
    await new Promise(resolve => setTimeout(resolve, 5))
    const detail = world.screen.overlays.at(-1)!.component as { handleInput(data: string): void }
    detail.handleInput(KEY.escape)
    // The bare info path mounts its own locale observer.
    await world.run('/plugin info loop')
    const info = world.overlay() as { handleInput(data: string): void, currentNode(): unknown }
    expect(JSON.stringify(info.currentNode())).toContain('循环提示与闹钟。')
    world.ctx.mayflyLocale.setPreference('en')
    await new Promise(resolve => setTimeout(resolve, 5))
    info.handleInput(KEY.escape)
    // Escape closes the browse panel.
    browse.handleInput(KEY.escape)
    expect(world.screen.overlays[0]!.hidden).toBe(true)
    world.dispose()
  })

  it('covers the info error paths and the installed-mode stray row hotkey', async () => {
    const world = await mountWorld({
      index: [entry()],
      profileDependencies: { 'stray-pkg': '1.0.0' },
    })
    expect(await world.run('/plugin info nope')).toMatchObject({ kind: 'error', text: 'unknown plugin: nope' })
    const bare = await mountWorld({ index: [entry()], withScreen: false })
    expect(await bare.run('/plugin info loop')).toMatchObject({ kind: 'error', text: expect.stringContaining('not mounted') })
    bare.dispose()
    await world.run('/plugin list')
    const panel = world.overlay() as { handleInput(data: string): void, currentNode(): unknown }
    const json = JSON.stringify(panel.currentNode())
    expect(json).toContain('stray-pkg')
    expect(json).toContain('removed')
    // i on the stray row resolves no entry and stays a no-op.
    panel.handleInput('i')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(world.spawns.filter(spawn => spawn.args[0] === 'plugin')).toHaveLength(0)
    world.dispose()
  })

  it('reads installed versions defensively', () => {
    const root = mkdtempTracked('mayfly-installed-')
    mkdirSync(join(root, 'node_modules', 'weird-a'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'weird-a', 'package.json'), 'null')
    mkdirSync(join(root, 'node_modules', 'weird-c'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'weird-c', 'package.json'), 'not json')
    mkdirSync(join(root, 'node_modules', 'weird-b'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'weird-b', 'package.json'), JSON.stringify({ version: 5 }))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'weird-a': '1', 'weird-b': '1', 'weird-c': '1' } }))
    const plugins = readInstalledPlugins(root)
    expect(plugins.map(plugin => [plugin.name, plugin.version])).toEqual([['weird-a', undefined], ['weird-b', undefined], ['weird-c', undefined]])
  })
})

describe('/plugin final coverage corners', () => {
  it('covers the remaining unload gates: info load, findDshBin, the i-key invalidate', async () => {
    // info argument path parking on the catalog load.
    let releaseFetch: ((value: string) => void) | undefined
    const fetchGate = new Promise<string>(resolve => {
      releaseFetch = resolve
    })
    const infoWorld = await mountWorld({})
    const realFetch = updaterInternals.fetchText
    updaterInternals.fetchText = vi.fn(async (url: string) => (url.includes('jsdelivr') || url.includes('raw.githubusercontent') ? fetchGate : realFetch(url)))
    const infoExecution = infoWorld.run('/plugin info loop')
    await new Promise(resolve => setTimeout(resolve, 5))
    await infoWorld.dispose()
    releaseFetch?.(indexJson([entry()]))
    await infoExecution

    // operate parking on findDshBin (the sh spawn itself gated).
    const shWorld = await mountWorld({ index: [entry()] })
    let releaseSh: (() => void) | undefined
    const shGate = new Promise<void>(resolve => {
      releaseSh = resolve
    })
    const realSpawn = updaterInternals.spawnOnce
    updaterInternals.spawnOnce = vi.fn(async (cmd: string) => {
      if (cmd === 'sh') await shGate
      return realSpawn(cmd, [])
    })
    const shExecution = shWorld.run('/plugin install loop')
    await new Promise(resolve => setTimeout(resolve, 5))
    await shWorld.dispose()
    releaseSh?.()
    await shExecution

    // The i-key path's post-operate invalidate also gates on the unload.
    const keyWorld = await mountWorld({ index: [entry()] })
    let releaseOp: (() => void) | undefined
    const opGate = new Promise<void>(resolve => {
      releaseOp = resolve
    })
    updaterInternals.spawnOnce = vi.fn(async (cmd: string, args: readonly string[]) => {
      if (cmd === 'sh') return { code: 0, signal: null, stdout: '/usr/bin/dsh\n', stderr: '', timedOut: false }
      if (args[0] === 'plugin') await opGate
      return realSpawn(cmd, args)
    })
    await keyWorld.run('/plugin')
    const panel = keyWorld.overlay() as { handleInput(data: string): void }
    panel.handleInput('i')
    await new Promise(resolve => setTimeout(resolve, 5))
    await keyWorld.dispose()
    releaseOp?.()
    await new Promise(resolve => setTimeout(resolve, 10))
  })

  it('flashes the refresh failure when the r key hits an offline market', async () => {
    const world = await mountWorld({ index: [entry()], offline: true })
    await world.run('/plugin refresh').catch(() => undefined)
    // Load a cached catalog so the panel opens, then go offline for the key.
    updaterInternals.writeTextFile(join(world.root, '..', '..', 'storages', 'mayfly-plugin-market', 'cache.json'), JSON.stringify({ fetchedAt: 1_000_000, text: indexJson([entry()]) }))
    await world.run('/plugin')
    const panel = world.overlay() as { handleInput(data: string): void }
    updaterInternals.fetchText = vi.fn(async () => {
      throw new Error('offline now')
    })
    panel.handleInput('r')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(world.notices.some(notice => notice.startsWith('refresh failed:'))).toBe(true)
    world.dispose()
  })

  it('returns a working disposer from registerPluginCommand', async () => {
    const ctx = new Context()
    new InteractionStateService(ctx, settingsPlugin.DEFAULT_SETTINGS)
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    const dispose = registerPluginCommand(ctx)
    const agent = await currentAgent(ctx)
    expect(ctx.commands.find(agent, 'plugin')).toBeDefined()
    dispose()
    expect(ctx.commands.find(agent, 'plugin')).toBeUndefined()
  })
})


async function currentAgent(ctx: Context): Promise<never> {
  const session = ctx.sessions.create(SessionId('disposer-spec'))
  return { id: session.id, session, status: 'idle' } as never
}
