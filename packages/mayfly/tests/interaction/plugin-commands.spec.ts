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
import { parse as parseYaml } from 'yaml'
import { mkdtempTracked, registerTempDirCleanup } from '../core/temp-dir.ts'

registerTempDirCleanup()
import { updaterInternals, type SpawnOutcome } from '../../src/interaction/updater/io.ts'
import { setSharedEditor } from '../../src/interaction/editor-instance.ts'
import { registerPluginCommand } from '../../src/interaction/plugin-commands.ts'
import { currentProfileInstallBlock, defaultInstallSource, entryInstallStates, readInstalledPlugins, rowSpec, installEntry, uninstallEntry, entrySupportsSource, MAYFLY_PACKAGE } from '../../src/interaction/plugin-market/installer.ts'
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

/** Write the profile dependency facts consumed by uninstallEntry. */
function writeInstalledDependencies(root: string, names: readonly string[]): void {
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    dependencies: Object.fromEntries(names.map(name => [name, '1.0.0'])),
  }))
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
  withLocale?: boolean
} = {}) {
  const home = mkdtempTracked('mayfly-plugin-cmd-')
  const root = join(home, '.dsh', 'profiles', 'mayfly')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'dsh-profile-mayfly',
    private: true,
    dependencies: {
      '@ephemeral-ai/mayfly': '0.1.0-alpha.1',
      ...options.profileDependencies,
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
  if (mayfly !== undefined && options.withLocale !== false) new MayflyLocaleService(ctx, { systemLocale: 'en' })
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

interface BrowserPanel {
  handleInput(data: string): void
  currentNode(): unknown
  render(width: number): string[]
  onEvent(event: { kind: string, controlId: string, tabId?: string, value?: unknown }): void
}

/** Select one browser tab through the canonical tab event. */
function selectBrowserTab(panel: BrowserPanel, tabId: 'installed' | 'not-installed'): void {
  panel.onEvent({ kind: 'tab-change', controlId: 'frontend-panel-groups', tabId })
}

/** Activate one list row through the canonical selection event. */
function activateBrowserRow(panel: BrowserPanel, id: string): void {
  panel.onEvent({ kind: 'selection-change', controlId: 'frontend-panel-list', value: id })
}

/** Read the canonical tabs node from a plugin browser. */
function browserTabs(panel: BrowserPanel): unknown {
  const node = panel.currentNode() as { child: { children: Array<{ node: { kind?: string } }> } }
  return node.child.children.find(child => child.node.kind === 'tabs')?.node
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

  it('chooses a source only when it covers every install row', () => {
    const githubOnly = entry({ install: { rows: [{ name: 'a', github: { repo: 'a/b', ref: 'r' } }] } })
    const mixed = entry({ install: { rows: [
      { name: 'a', npm: { spec: 'a' } },
      { name: 'b', github: { repo: 'a/b', ref: 'r' } },
    ] } })
    expect(defaultInstallSource(entry())).toBe('npm')
    expect(defaultInstallSource(githubOnly)).toBe('github')
    expect(defaultInstallSource(mixed)).toBeUndefined()
    expect(entrySupportsSource(mixed, 'npm')).toBe(false)
  })

  it('blocks automation-only stdio servers from the current TUI profile', async () => {
    const acp = entry({ install: { rows: [{ id: 'acp', name: '@deepseek-ai/dsh-acp', activation: 'profile-patch', npm: { spec: '@deepseek-ai/dsh-acp' } }] } })
    updaterInternals.spawnOnce = vi.fn(async () => ok())
    expect(currentProfileInstallBlock(entry())).toBeUndefined()
    expect(currentProfileInstallBlock(acp)).toContain('owns stdio')
    expect(await installEntry({ dshBin: 'dsh', profile: 'p', root: mkdtempTracked('mayfly-install-'), entry: acp, source: 'npm' }))
      .toMatchObject({ kind: 'error', text: expect.stringContaining('dedicated non-Mayfly profile') })
    expect(updaterInternals.spawnOnce).not.toHaveBeenCalled()
  })

  it('blocks removed marketplace entries before spawning an install', async () => {
    const removed = entry({ status: 'removed', statusNote: 'security incident' })
    updaterInternals.spawnOnce = vi.fn(async () => ok())
    expect(await installEntry({ dshBin: 'dsh', profile: 'p', root: mkdtempTracked('mayfly-install-'), entry: removed, source: 'npm' }))
      .toMatchObject({ kind: 'error', text: expect.stringContaining('security incident') })
    expect(await installEntry({ dshBin: 'dsh', profile: 'p', root: mkdtempTracked('mayfly-install-'), entry: entry({ status: 'removed', statusNote: undefined }), source: 'npm' }))
      .toEqual({ kind: 'error', text: '"Loop" was removed from the marketplace' })
    expect(updaterInternals.spawnOnce).not.toHaveBeenCalled()
  })

  it('refuses to reinstall an entry while any of its rows are present', async () => {
    const root = mkdtempTracked('mayfly-install-')
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'dsh-loop': '0.1.4' } }))
    updaterInternals.spawnOnce = vi.fn(async () => ok())
    expect(await installEntry({ dshBin: 'dsh', profile: 'p', root, entry: entry(), source: 'npm' }))
      .toMatchObject({ kind: 'error', text: expect.stringContaining('already or partially installed') })
    expect(updaterInternals.spawnOnce).not.toHaveBeenCalled()
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
    expect(entryInstallStates([entry()], [{ name: 'dsh-loop', spec: 'y', version: '0.1.5' }]).loop)
      .toEqual({ installed: true, version: '0.1.5', updateAvailable: false })
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
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - .\nallowBuilds:\n  node-pty: false\noverrides:\n  keep: true\n')
    writeFileSync(join(root, 'cordis.patch.yml'), '# User patch layer\n[]\n')
    const outcome = await installEntry({ dshBin: 'dsh', profile: 'p', root, entry: profilePatch, source: 'npm' })
    expect(outcome.kind).toBe('success')
    const workspace = parseYaml(updaterInternals.readTextFile(join(root, 'pnpm-workspace.yaml')) ?? '') as Record<string, unknown>
    expect(workspace).toMatchObject({ allowBuilds: { 'node-pty': true }, overrides: { keep: true } })
    const patch = parseYaml(updaterInternals.readTextFile(join(root, 'cordis.patch.yml')) ?? '') as readonly Record<string, unknown>[]
    expect(patch).toContainEqual({ insert: [{ id: 'terminal-bash', name: '@deepseek-ai/dsh-terminal-bash' }] })
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
    expect(parseYaml(patch)).toContainEqual({
      insert: [{ id: 'code-runtime', name: '@deepseek-ai/dsh-code-runtime-worker-thread', config: { computeMs: 60000 } }],
    })
  })

  it('uninstalling removes exactly the entry\'s patch blocks', async () => {
    const two = entry({
      install: { rows: [{ id: 'a', name: 'pkg-a', activation: 'profile-patch', npm: { spec: 'a' } }, { id: 'b', name: 'pkg-b' }] },
    })
    updaterInternals.spawnOnce = vi.fn(async () => ok())
    const root = mkdtempTracked('mayfly-uninstall-')
    writeInstalledDependencies(root, ['pkg-a', 'pkg-b'])
    writeFileSync(join(root, 'cordis.patch.yml'), [
      '- id: keep',
      "  name: 'keep-me'",
      '- insert:',
      '    - id: a',
      "      name: 'pkg-a'",
      '      config:',
      '        x: 1',
      '    - id: user-a',
      "      name: 'pkg-a'",
      '      config:',
      '        keep: true',
      '    - id: after',
      "      name: 'pkg-after'",
    ].join('\n') + '\n')
    const outcome = await uninstallEntry({ dshBin: 'dsh', profile: 'p', root, entry: two, source: 'npm' })
    expect(outcome.kind).toBe('success')
    const patch = updaterInternals.readTextFile(join(root, 'cordis.patch.yml')) ?? ''
    expect(patch).toContain('keep-me')
    expect(patch).toContain('pkg-after')
    expect(patch).toContain('user-a')
    expect(patch).toContain("'pkg-a'")
    expect(patch).toContain('keep: true')
    expect(patch).not.toContain('x: 1')
  })

  it('refuses an installer-level uninstall when no entry rows are present', async () => {
    updaterInternals.spawnOnce = vi.fn(async () => ok())
    const outcome = await uninstallEntry({
      dshBin: 'dsh', profile: 'p', root: mkdtempTracked('mayfly-uninstall-'), entry: entry(), source: 'npm',
    })
    expect(outcome).toEqual({ kind: 'error', text: '"Loop" is not installed in this profile' })
    expect(updaterInternals.spawnOnce).not.toHaveBeenCalled()
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
    writeInstalledDependencies(root, ['dsh-loop'])
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

  it('refuses malformed workspace mappings before spawning', async () => {
    const withBuild = entry({ install: { allowBuilds: ['node-pty'], rows: entry().install.rows } })
    updaterInternals.spawnOnce = vi.fn(async () => ok())
    for (const source of ['[]\n', '[\n', 'allowBuilds: []\n']) {
      const root = mkdtempTracked('mayfly-install-')
      writeFileSync(join(root, 'pnpm-workspace.yaml'), source)
      const outcome = await installEntry({ dshBin: 'dsh', profile: 'p', root, entry: withBuild, source: 'npm' })
      expect(outcome).toMatchObject({ kind: 'error', text: expect.stringContaining('pnpm-workspace.yaml') })
    }
    expect(updaterInternals.spawnOnce).not.toHaveBeenCalled()
  })

  it('reports invalid or conflicting patch documents without overwriting them', async () => {
    updaterInternals.spawnOnce = vi.fn(async () => ok())
    const withPatch = entry({ install: { rows: [{ id: 'wanted', name: 'pkg-wanted', activation: 'profile-patch', npm: { spec: 'pkg-wanted' } }] } })
    for (const source of ['{}\n', '[\n', '- insert: {}\n', '- insert:\n    - scalar\n', '- insert:\n    - id: wanted\n      name: another-package\n']) {
      const root = mkdtempTracked('mayfly-install-')
      writeFileSync(join(root, 'cordis.patch.yml'), source)
      const outcome = await installEntry({ dshBin: 'dsh', profile: 'p', root, entry: withPatch, source: 'npm' })
      expect(outcome).toMatchObject({ kind: 'error', text: expect.stringContaining('cordis.patch.yml') })
      expect(updaterInternals.readTextFile(join(root, 'cordis.patch.yml'))).toBe(source)
    }
  })

  it('preserves tagged user config and uses the package name when a patch id is absent', async () => {
    updaterInternals.spawnOnce = vi.fn(async () => ok())
    const root = mkdtempTracked('mayfly-install-')
    writeFileSync(join(root, 'cordis.patch.yml'), '- id: keep\n  name: keep\n  config:\n    value: !!js return 1\n')
    const noId = entry({ install: { rows: [{ name: 'pkg-no-id', activation: 'profile-patch', npm: { spec: 'pkg-no-id' } }] } })
    expect((await installEntry({ dshBin: 'dsh', profile: 'p', root, entry: noId, source: 'npm' })).kind).toBe('success')
    expect(updaterInternals.readTextFile(join(root, 'cordis.patch.yml'))).toContain('!!js return 1')
    writeInstalledDependencies(root, ['pkg-no-id'])
    expect((await uninstallEntry({ dshBin: 'dsh', profile: 'p', root, entry: noId, source: 'npm' })).kind).toBe('success')
    expect(updaterInternals.readTextFile(join(root, 'cordis.patch.yml'))).not.toContain('pkg-no-id')
  })

  it('reports invalid patch cleanup and leaves unrelated sequence items intact', async () => {
    updaterInternals.spawnOnce = vi.fn(async () => ok())
    const target = entry({ install: { rows: [{ id: 'target', name: 'pkg-target', activation: 'profile-patch', npm: { spec: 'pkg-target' } }] } })
    for (const source of ['{}\n', '[\n']) {
      const root = mkdtempTracked('mayfly-uninstall-')
      writeInstalledDependencies(root, ['pkg-target'])
      writeFileSync(join(root, 'cordis.patch.yml'), source)
      const outcome = await uninstallEntry({ dshBin: 'dsh', profile: 'p', root, entry: target, source: 'npm' })
      expect(outcome).toMatchObject({ kind: 'error', text: expect.stringContaining('cordis.patch.yml') })
    }
    const root = mkdtempTracked('mayfly-uninstall-')
    writeInstalledDependencies(root, ['pkg-target'])
    writeFileSync(join(root, 'cordis.patch.yml'), '- scalar\n- name: top-level\n- insert:\n    - name: no-id\n    - id: orphan\n    - id: target\n      name: pkg-target\n')
    expect((await uninstallEntry({ dshBin: 'dsh', profile: 'p', root, entry: target, source: 'npm' })).kind).toBe('success')
    expect(parseYaml(updaterInternals.readTextFile(join(root, 'cordis.patch.yml')) ?? '')).toEqual([
      'scalar',
      { name: 'top-level' },
      { insert: [{ name: 'no-id' }, { id: 'orphan' }] },
    ])
  })

  it('reports patch write failures after successful package operations', async () => {
    updaterInternals.spawnOnce = vi.fn(async () => ok())
    const withPatch = entry({ install: { rows: [{ id: 'write', name: 'pkg-write', activation: 'profile-patch', npm: { spec: 'pkg-write' } }] } })
    const installRoot = mkdtempTracked('mayfly-install-')
    writeFileSync(join(installRoot, 'cordis.patch.yml'), '[]\n')
    updaterInternals.writeTextFile = () => { throw new Error('disk full') }
    expect(await installEntry({ dshBin: 'dsh', profile: 'p', root: installRoot, entry: withPatch, source: 'npm' }))
      .toMatchObject({ kind: 'error', text: expect.stringContaining('activating') })

    const uninstallRoot = mkdtempTracked('mayfly-uninstall-')
    writeInstalledDependencies(uninstallRoot, ['pkg-write'])
    writeFileSync(join(uninstallRoot, 'cordis.patch.yml'), '- insert:\n    - id: write\n      name: pkg-write\n')
    expect(await uninstallEntry({ dshBin: 'dsh', profile: 'p', root: uninstallRoot, entry: withPatch, source: 'npm' }))
      .toMatchObject({ kind: 'error', text: expect.stringContaining('cleaning up') })
  })

  it('import-checks new packages and restores the profile when compatibility fails', async () => {
    const root = mkdtempTracked('mayfly-install-')
    const files = {
      'package.json': JSON.stringify({ dependencies: { '@ephemeral-ai/mayfly': '1.0.0' }, dsh: { profile: { bundles: ['@ephemeral-ai/mayfly'] } } }),
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'pnpm-workspace.yaml': 'packages:\n  - .\nallowBuilds:\n  node-pty: false\n',
      'cordis.patch.yml': '# user layer\n[]\n',
    }
    for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text)
    const phases: string[] = []
    updaterInternals.spawnOnce = vi.fn(async (cmd: string, args: readonly string[]) => {
      if (cmd === process.execPath) return { code: 1, signal: null, stdout: '', stderr: 'does not provide an export named CallId', timedOut: false }
      if (args.includes('add')) {
        writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@ephemeral-ai/mayfly': '1.0.0', 'dsh-loop': 'github:x' } }))
      }
      return ok()
    })
    const outcome = await installEntry({
      dshBin: 'dsh', profile: 'p', root,
      entry: entry({ install: { allowBuilds: ['node-pty'], rows: entry().install.rows } }),
      source: 'npm', onProgress: phase => phases.push(phase),
    })
    expect(outcome).toMatchObject({ kind: 'error', text: expect.stringContaining('changes rolled back') })
    expect(outcome.kind === 'error' ? outcome.text : '').toContain('CallId')
    expect(phases).toEqual(['verify', 'rollback'])
    for (const [file, text] of Object.entries(files)) expect(updaterInternals.readTextFile(join(root, file))).toBe(text)
    expect(updaterInternals.spawnOnce).toHaveBeenCalledWith(process.execPath, expect.arrayContaining(['--input-type=module']), expect.objectContaining({ cwd: root }))
    expect(updaterInternals.spawnOnce).toHaveBeenCalledWith('dsh', ['plugin', '--profile', 'p', 'remove', 'dsh-loop'], expect.any(Object))
  })

  it('reports an incomplete rollback while still restoring captured files', async () => {
    const root = mkdtempTracked('mayfly-install-')
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@ephemeral-ai/mayfly': '1.0.0' } }))
    updaterInternals.spawnOnce = vi.fn(async (cmd: string, args: readonly string[]) => {
      if (cmd === process.execPath) return { code: 1, signal: null, stdout: '', stderr: 'bad import', timedOut: false }
      if (args.includes('remove')) return { code: 1, signal: null, stdout: '', stderr: 'remove failed', timedOut: false }
      return ok()
    })
    const outcome = await installEntry({ dshBin: 'dsh', profile: 'p', root, entry: entry(), source: 'npm' })
    expect(outcome).toMatchObject({ kind: 'error', text: expect.stringContaining('rollback incomplete') })
    expect(updaterInternals.readTextFile(join(root, 'package.json'))).toBe(JSON.stringify({ dependencies: { '@ephemeral-ai/mayfly': '1.0.0' } }))
  })
})

describe('/plugin browse panel', () => {
  it('loads the catalog and opens the grouped browse panel', async () => {
    const world = await mountWorld({ index: [entry()] })
    const result = await world.run('/plugin')
    expect(result).toEqual({ kind: 'success' })
    const panel = world.overlay()
    expect(panel).toBeDefined()
    const controller = panel as BrowserPanel
    const node = controller.currentNode()
    expect(JSON.stringify(node)).toContain('Loop')
    expect(JSON.stringify(node)).toContain('official · Web+Server')
    expect(browserTabs(controller)).toMatchObject({ kind: 'tabs', activeId: 'not-installed', items: [
      { id: 'installed', count: 0 },
      { id: 'not-installed', count: 1 },
    ] })
    expect(JSON.stringify(node)).toContain('Install')
    expect(controller.render(80).join('\n')).toContain('i install · u remove · r refresh')
    expect(controller.render(36).join('\n')).toContain('i/u/r')
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
  it('shows but does not install the dedicated-profile ACP server', async () => {
    const acp = entry({
      id: 'acp',
      displayName: 'ACP Server',
      install: { rows: [{ id: 'acp', name: '@deepseek-ai/dsh-acp', activation: 'profile-patch', npm: { spec: '@deepseek-ai/dsh-acp' } }] },
    })
    const world = await mountWorld({ index: [acp] })
    expect(await world.run('/plugin install acp')).toMatchObject({ kind: 'error', text: expect.stringContaining('owns stdio') })
    expect(world.spawns.filter(spawn => spawn.cmd === '/usr/bin/dsh')).toHaveLength(0)
    await world.run('/plugin info acp')
    const detail = JSON.stringify((world.overlay() as { currentNode(): unknown }).currentNode())
    expect(detail).toContain('dedicated non-Mayfly profile')
    expect(detail).toContain('dsh plugin --profile <automation-name> add @deepseek-ai/dsh-acp')
    await world.run('/plugin')
    const panel = world.overlay() as BrowserPanel
    expect(JSON.stringify(panel.currentNode())).toContain('Automation')
    panel.handleInput('i')
    expect(JSON.stringify(panel.currentNode())).toContain('automation-only ACP server owns stdio; install it in a dedicated non-Mayfly profile')
    world.dispose()
  })

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

  it('refuses to install a removed entry through the command path', async () => {
    const removed = entry({ id: 'gone', displayName: 'Gone', status: 'removed', statusNote: 'compromised release' })
    const world = await mountWorld({ index: [removed] })
    expect(await world.run('/plugin install gone')).toMatchObject({
      kind: 'error', text: expect.stringContaining('compromised release'),
    })
    expect(world.spawns.some(spawn => spawn.cmd === '/usr/bin/dsh')).toBe(false)
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

  it('quotes GitHub specs in the copyable install command', async () => {
    const githubOnly = entry({ install: { rows: [{ name: 'dsh-loop', github: { repo: 'a/b', ref: 'release-candidate', subdir: 'plugins/loop' } }] } })
    const world = await mountWorld({ index: [githubOnly] })
    await world.run('/plugin info loop')
    const json = JSON.stringify((world.overlay() as { currentNode(): unknown }).currentNode())
    expect(json).toContain("'github:a/b#release-candidate&path:plugins/loop'")
    world.dispose()
  })

  it('list groups installed rows by state, including removed-from-market', async () => {
    const gone = entry({ id: 'gone', displayName: 'Gone', status: 'removed', statusNote: 'yanked', install: { rows: [{ name: 'gone-pkg', npm: { spec: 'gone-pkg' } }] } })
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

  it('shows a removed entry without a reinstall command', async () => {
    const gone = entry({ id: 'gone', displayName: 'Gone', status: 'removed', statusNote: 'yanked', install: { rows: [{ name: 'gone-pkg', npm: { spec: 'gone-pkg' } }] } })
    const world = await mountWorld({ index: [gone] })
    expect(await world.run('/plugin info gone')).toEqual({ kind: 'success' })
    const json = JSON.stringify((world.overlay() as { currentNode(): unknown }).currentNode())
    expect(json).toContain('yanked')
    expect(json).not.toContain('Install command')
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
    expect(await world.run('/plugin install loop --source')).toMatchObject({ kind: 'error', text: expect.stringContaining('usage') })
    expect(await world.run('/plugin install loop --source archive')).toMatchObject({ kind: 'error', text: expect.stringContaining('usage') })
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
  it('shows compatibility rollback progress and failure in the panel', async () => {
    let releaseRollback: (() => void) | undefined
    const rollbackGate = new Promise<void>(resolve => { releaseRollback = resolve })
    const world = await mountWorld({ index: [entry()] })
    updaterInternals.spawnOnce = vi.fn(async (cmd: string, args: readonly string[]) => {
      if (cmd === 'sh') return ok('/usr/bin/dsh\n')
      if (cmd === process.execPath) return { code: 1, signal: null, stdout: '', stderr: 'missing export', timedOut: false }
      if (args.includes('remove')) await rollbackGate
      return ok()
    })
    await world.run('/plugin')
    const panel = world.overlay() as BrowserPanel
    panel.handleInput('i')
    await vi.waitFor(() => expect(panel.render(100).join('\n')).toContain('rolling back "Loop"...'))
    releaseRollback?.()
    await vi.waitFor(() => expect(panel.render(100).join('\n')).toContain('changes rolled back'))
    expect(browserTabs(panel)).toMatchObject({ activeId: 'not-installed', items: [
      { id: 'installed', count: 0 }, { id: 'not-installed', count: 1 },
    ] })
    world.dispose()
  })

  it('shows progress and moves a plugin between tabs after visible actions complete', async () => {
    let releaseInstall: (() => void) | undefined
    const installGate = new Promise<void>(resolve => { releaseInstall = resolve })
    let releaseVerify: (() => void) | undefined
    const verifyGate = new Promise<void>(resolve => { releaseVerify = resolve })
    const world = await mountWorld({ index: [entry()] })
    updaterInternals.spawnOnce = vi.fn(async (cmd: string, args: readonly string[]) => {
      if (cmd === 'sh') return ok('/usr/bin/dsh\n')
      if (cmd === process.execPath) {
        await verifyGate
        return ok()
      }
      const manifestPath = join(world.root, 'package.json')
      const manifest = JSON.parse(updaterInternals.readTextFile(manifestPath) ?? '{}') as { dependencies: Record<string, string> }
      if (args.includes('add')) {
        await installGate
        manifest.dependencies['dsh-loop'] = '0.1.4'
        mkdirSync(join(world.root, 'node_modules', 'dsh-loop'), { recursive: true })
        writeFileSync(join(world.root, 'node_modules', 'dsh-loop', 'package.json'), JSON.stringify({ version: '0.1.4' }))
      } else if (args.includes('remove')) {
        delete manifest.dependencies['dsh-loop']
      }
      writeFileSync(manifestPath, JSON.stringify(manifest))
      return ok()
    })
    await world.run('/plugin')
    const panel = world.overlay() as BrowserPanel
    expect(JSON.stringify(panel.currentNode())).toContain('Install')
    panel.onEvent({ kind: 'activate', controlId: 'frontend-panel-secondary' })
    await vi.waitFor(() => expect(panel.render(100).join('\n')).toContain('installing "Loop"...'))
    releaseInstall?.()
    await vi.waitFor(() => expect(panel.render(100).join('\n')).toContain('checking "Loop" compatibility...'))
    releaseVerify?.()
    await vi.waitFor(() => expect(panel.render(100).join('\n')).toContain('installed; restart Mayfly'))
    expect(browserTabs(panel)).toMatchObject({ items: [{ id: 'installed', count: 1 }, { id: 'not-installed', count: 0 }] })
    selectBrowserTab(panel, 'installed')
    expect(JSON.stringify(panel.currentNode())).toContain('Uninstall')
    panel.onEvent({ kind: 'activate', controlId: 'frontend-panel-secondary' })
    await vi.waitFor(() => expect(panel.render(100).join('\n')).toContain('removed; restart Mayfly'))
    expect(browserTabs(panel)).toMatchObject({ items: [{ id: 'installed', count: 0 }, { id: 'not-installed', count: 1 }] })
    world.dispose()
  })

  it('i installs the selected row and u removes it, r refreshes', async () => {
    const world = await mountWorld({
      index: [entry()],
      profileDependencies: { 'dsh-loop': '0.1.4' },
      installedVersions: { 'dsh-loop': '0.1.4' },
    })
    await world.run('/plugin list')
    const panel = world.overlay() as BrowserPanel
    panel.handleInput('u')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(world.spawns.some(spawn => spawn.args.includes('remove'))).toBe(true)
    world.dispose()
  })

  it('u on an uninstalled entry reports inside the panel', async () => {
    const world = await mountWorld({ index: [entry()] })
    await world.run('/plugin')
    const panel = world.overlay() as BrowserPanel
    panel.handleInput('u')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(world.spawns.filter(spawn => spawn.cmd === '/usr/bin/dsh')).toHaveLength(0)
    expect(panel.render(100).join('\n')).toContain('"Loop" is not installed in this profile')
    world.dispose()
  })

  it('handles a mixed-source entry without dropping any package rows', async () => {
    const mixed = entry({
      id: 'mixed',
      displayName: 'Mixed',
      install: { rows: [
        { name: 'mixed-a', npm: { spec: 'mixed-a' } },
        { name: 'mixed-b', github: { repo: 'a/b', ref: 'r' } },
      ] },
    })
    const world = await mountWorld({
      index: [mixed],
      profileDependencies: { 'mixed-a': '1.0.0', 'mixed-b': 'github:a/b#r' },
      installedVersions: { 'mixed-a': '1.0.0', 'mixed-b': '1.0.0' },
    })
    expect(await world.run('/plugin install mixed')).toMatchObject({ kind: 'error', text: expect.stringContaining('no common install source') })
    await world.run('/plugin info mixed')
    expect(JSON.stringify((world.overlay() as { currentNode(): unknown }).currentNode())).toContain('add <mixed>')
    await world.run('/plugin list')
    const panel = world.overlay() as BrowserPanel
    panel.handleInput('i')
    expect(panel.render(100).join('\n')).toContain('"Mixed" has no common install source for every package')
    panel.handleInput('u')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(world.spawns.some(spawn => spawn.args.includes('remove'))).toBe(true)
    expect(await world.run('/plugin uninstall mixed')).toEqual({ kind: 'success' })
    world.dispose()
  })

  it('lists a partially installed multi-row entry as removable and removes only present rows', async () => {
    const multi = entry({
      id: 'multi',
      displayName: 'Multi Row',
      install: { rows: [
        { name: 'multi-a', npm: { spec: 'multi-a' } },
        { name: 'multi-b', npm: { spec: 'multi-b' } },
      ] },
    })
    const world = await mountWorld({ index: [multi], profileDependencies: { 'multi-a': '1.0.0' } })
    await world.run('/plugin list')
    const panel = world.overlay() as BrowserPanel
    const json = JSON.stringify(panel.currentNode())
    expect(json).toContain('partial')
    expect(json.match(/Multi Row/gu)).toHaveLength(1)
    expect(json).toContain('Uninstall')
    expect(browserTabs(panel)).toMatchObject({ activeId: 'installed', items: [
      { id: 'installed', count: 1 }, { id: 'not-installed', count: 0 },
    ] })
    panel.handleInput('u')
    await vi.waitFor(() => expect(world.spawns.some(spawn => spawn.args.includes('remove'))).toBe(true))
    expect(world.spawns.find(spawn => spawn.args.includes('remove'))?.args)
      .toEqual(['plugin', '--profile', 'mayfly', 'remove', 'multi-a'])
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
    const panel = world.overlay() as BrowserPanel
    panel.handleInput('i')
    await new Promise(resolve => setTimeout(resolve, 5))
    panel.handleInput('I')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(JSON.stringify(panel.currentNode())).toContain('a plugin operation is already running')
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
    expect(world.spawns.some(spawn => spawn.args.includes('github:a/b#r'))).toBe(true)
    await world.run('/plugin install gh --source npm')
    expect(world.notices.at(-1)).toBe('"GH" has no npm install source')
    world.dispose()
  })

  it('Enter opens the detail overlay above the browse panel; Escape pops it', async () => {
    const world = await mountWorld({ index: [entry()] })
    await world.run('/plugin')
    const panel = world.overlay() as BrowserPanel
    expect(world.screen.overlays).toHaveLength(1)
    await vi.waitFor(() => {
      expect(JSON.stringify(panel.currentNode())).toContain('Loop')
    })
    // The canonical list emits the same selection action Enter dispatches.
    activateBrowserRow(panel, 'loop')
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
    const panel = world.overlay() as BrowserPanel
    panel.handleInput('R')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(updaterInternals.fetchText).toHaveBeenCalled()
    panel.handleInput('U')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(panel.render(100).join('\n')).toContain('"Loop" is not installed in this profile')
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
    const panel = world.overlay() as BrowserPanel
    panel.handleInput('i')
    expect(JSON.stringify(panel.currentNode())).toContain('web-only plugin: it contributes nothing in this terminal frontend')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(JSON.stringify(panel.currentNode())).toContain('installed; restart Mayfly and start a new session to apply')
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
    await installEntry({ dshBin: 'dsh', profile: 'p', root, entry: profilePatch, source: 'npm' })
    expect(updaterInternals.readTextFile(join(root, 'pnpm-workspace.yaml'))).toBe('packages:\n  - .\nallowBuilds:\n  "node-pty": true\n')
    expect(parseYaml(updaterInternals.readTextFile(join(root, 'cordis.patch.yml')) ?? '')).toEqual([{ insert: [{ id: 't', name: 'pkg-t' }] }])
  })

  it('uninstall tolerates a missing patch file and unquoted names', async () => {
    const unquoted = entry({ install: { rows: [{ id: 'u', name: 'bare-pkg', activation: 'profile-patch', npm: { spec: 'u' } }] } })
    const root = mkdtempTracked('mayfly-uninstall-')
    updaterInternals.spawnOnce = vi.fn(async () => ok())
    writeInstalledDependencies(root, ['bare-pkg'])
    const withoutFile = await uninstallEntry({ dshBin: 'dsh', profile: 'p', root, entry: unquoted, source: 'npm' })
    expect(withoutFile.kind).toBe('success')
    const unrelated = '- insert:\n    - id: other\n      name: other-package\n'
    writeFileSync(join(root, 'cordis.patch.yml'), unrelated)
    expect((await uninstallEntry({ dshBin: 'dsh', profile: 'p', root, entry: unquoted, source: 'npm' })).kind).toBe('success')
    expect(updaterInternals.readTextFile(join(root, 'cordis.patch.yml'))).toBe(unrelated)
    writeFileSync(join(root, 'cordis.patch.yml'), '- insert:\n    - id: u\n      name: bare-pkg\n')
    const outcome = await uninstallEntry({ dshBin: 'dsh', profile: 'p', root, entry: unquoted, source: 'npm' })
    expect(outcome.kind).toBe('success')
    expect(parseYaml(updaterInternals.readTextFile(join(root, 'cordis.patch.yml')) ?? '')).toEqual([])
  })
})

describe('/plugin lifecycle and locale', () => {
  it('does not let a slower earlier load replace a newer refresh', async () => {
    const world = await mountWorld()
    let releaseFirst: ((value: string) => void) | undefined
    const first = new Promise<string>(resolve => {
      releaseFirst = resolve
    })
    let calls = 0
    updaterInternals.fetchText = vi.fn(async () => {
      calls += 1
      return calls === 1 ? first : indexJson([entry({ id: 'newer', displayName: 'Newer' })])
    })
    await world.run('/plugin')
    const panel = world.overlay() as { handleInput(data: string): void, currentNode(): unknown }
    panel.handleInput('r')
    await new Promise(resolve => setTimeout(resolve, 5))
    releaseFirst?.(indexJson([entry({ id: 'older', displayName: 'Older' })]))
    await new Promise(resolve => setTimeout(resolve, 5))
    const json = JSON.stringify(panel.currentNode())
    expect(json).toContain('Newer')
    expect(json).not.toContain('Older')
    world.dispose()
  })

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
    const browse = world.overlay() as BrowserPanel
    let json = JSON.stringify(browse.currentNode())
    expect(json).toContain('Tui Pane')
    expect(json).toContain('TUI+Server')
    expect(json).toContain('unstable')
    // Enter → detail above the browse panel; both observers re-render on a
    // preference switch, and the zh description takes over.
    activateBrowserRow(browse, 'loop')
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

  it('covers info errors and excludes unindexed profile dependencies from market tabs', async () => {
    const world = await mountWorld({
      index: [entry()],
      profileDependencies: { 'stray-pkg': '1.0.0' },
    })
    expect(await world.run('/plugin info nope')).toMatchObject({ kind: 'error', text: 'unknown plugin: nope' })
    const bare = await mountWorld({ index: [entry()], withScreen: false })
    expect(await bare.run('/plugin info loop')).toMatchObject({ kind: 'error', text: expect.stringContaining('not mounted') })
    bare.dispose()
    await world.run('/plugin list')
    const panel = world.overlay() as BrowserPanel
    const json = JSON.stringify(panel.currentNode())
    expect(json).not.toContain('stray-pkg')
    expect(json).toContain('no plugins installed')
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
    const panel = world.overlay() as BrowserPanel
    updaterInternals.fetchText = vi.fn(async () => {
      throw new Error('offline now')
    })
    panel.handleInput('r')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(JSON.stringify(panel.currentNode())).toContain('refresh failed:')
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

describe('badge and patch-shape arms', () => {
  it('shows the installed badge without an update in catalog mode', async () => {
    const world = await mountWorld({
      index: [entry()],
      profileDependencies: { 'dsh-loop': '0.1.4' },
      installedVersions: { 'dsh-loop': '0.1.4' },
    })
    await world.run('/plugin')
    const json = JSON.stringify((world.overlay() as { currentNode(): unknown }).currentNode())
    expect(json).toContain('installed')
    world.dispose()
  })

  it('appends patch rows to a file without a trailing newline', async () => {
    const withPatch = entry({ install: { rows: [{ id: 'nl', name: 'pkg-nl', activation: 'profile-patch', npm: { spec: 'pkg-nl' } }] } })
    const root = mkdtempTracked('mayfly-install-')
    updaterInternals.spawnOnce = vi.fn(async () => ok())
    writeFileSync(join(root, 'cordis.patch.yml'), "- id: keep\n  name: 'keep-me'")
    const outcome = await installEntry({ dshBin: 'dsh', profile: 'p', root, entry: withPatch, source: 'npm' })
    expect(outcome.kind).toBe('success')
    const patch = updaterInternals.readTextFile(join(root, 'cordis.patch.yml')) ?? ''
    expect(patch).toContain('keep-me')
    expect(parseYaml(patch)).toContainEqual({ insert: [{ id: 'nl', name: 'pkg-nl' }] })
    // allowBuilds block lands after content lacking a trailing newline too.
    const allowEntry = entry({ install: { allowBuilds: ['node-pty'], rows: [{ id: 't', name: 'pkg-t', activation: 'profile-patch', npm: { spec: 'x' } }] } })
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - .')
    await installEntry({ dshBin: 'dsh', profile: 'p', root, entry: allowEntry, source: 'npm' })
    expect(parseYaml(updaterInternals.readTextFile(join(root, 'pnpm-workspace.yaml')) ?? '')).toMatchObject({ allowBuilds: { 'node-pty': true } })
  })
})

describe('panel arms without a locale service', () => {
  it('renders English descriptions when no locale service is mounted', async () => {
    const world = await mountWorld({ index: [entry()], withLocale: false })
    await world.run('/plugin')
    const json = JSON.stringify((world.overlay() as { currentNode(): unknown }).currentNode())
    expect(json).toContain('Recurring prompts and alarms.')
    world.dispose()
  })
})

describe('detail-shape arms', () => {
  it('renders installed details, update rows, tools-only and commands-only provides', async () => {
    const toolsOnly = entry({ id: 'tools-only', displayName: 'Tools Only', provides: { tools: ['a_tool'] } })
    const commandsOnly = entry({ id: 'commands-only', displayName: 'Commands Only', provides: { commands: ['/cmd'] } })
    const tuiOnly = entry({ id: 'tui-only', displayName: 'Tui Only', surfaces: { tui: { contributions: ['status'] } }, provides: {} })
    const webOnly = entry({ id: 'web-only2', displayName: 'Web Only 2', surfaces: { web: { clientModule: true } }, provides: {} })
    const world = await mountWorld({
      index: [entry(), toolsOnly, commandsOnly, tuiOnly, webOnly],
      profileDependencies: { 'dsh-loop': '0.1.3' },
      installedVersions: { 'dsh-loop': '0.1.3' },
    })
    // Installed with an update available: the Version row shows the update.
    await world.run('/plugin info loop')
    expect(JSON.stringify((world.overlay() as { currentNode(): unknown }).currentNode())).toContain('update available')
    for (const id of ['tools-only', 'commands-only', 'tui-only', 'web-only2']) {
      await world.run(`/plugin info ${id}`)
      expect(world.overlay()).toBeDefined()
    }
    world.dispose()
  })

  it('covers bare-context installs, missing workspace files, and the r-unload gate', async () => {
    const world = await mountWorld({ index: [entry()], withScreen: false })
    expect(await world.run('/plugin install loop')).toEqual({ kind: 'success' })
    world.dispose()

    // allowBuilds merge into a profile whose workspace file does not exist yet.
    const allowEntry = entry({ install: { allowBuilds: ['node-pty'], rows: [{ id: 't', name: 'pkg-t', activation: 'profile-patch', npm: { spec: 'x' } }] } })
    const root = mkdtempTracked('mayfly-install-')
    updaterInternals.spawnOnce = vi.fn(async () => ok())
    const outcome = await installEntry({ dshBin: 'dsh', profile: 'p', root, entry: allowEntry, source: 'npm' })
    expect(outcome.kind).toBe('success')
    expect(parseYaml(updaterInternals.readTextFile(join(root, 'pnpm-workspace.yaml')) ?? '')).toMatchObject({ allowBuilds: { 'node-pty': true } })

    // The r-key refresh continuation gates on the fiber unload.
    const rWorld = await mountWorld({})
    let release: ((value: string) => void) | undefined
    const gate = new Promise<string>(resolve => {
      release = resolve
    })
    const realFetch = updaterInternals.fetchText
    updaterInternals.fetchText = vi.fn(async (url: string) => (url.includes('jsdelivr') || url.includes('raw.githubusercontent') ? gate : realFetch(url)))
    await rWorld.run('/plugin')
    const panel = rWorld.overlay() as { handleInput(data: string): void }
    panel.handleInput('r')
    await new Promise(resolve => setTimeout(resolve, 5))
    await rWorld.dispose()
    release?.(indexJson([entry()]))
    await new Promise(resolve => setTimeout(resolve, 10))
  })
})

describe('final arms', () => {
  it('reports uninstall failures and info for github-only and versionless rows', async () => {
    const githubOnly = entry({ id: 'gh2', displayName: 'GH2', install: { rows: [{ name: 'gh2-pkg', github: { repo: 'a/b', ref: 'r' } }] } })
    const world = await mountWorld({
      index: [entry(), githubOnly],
      profileDependencies: { 'dsh-loop': '0.1.4', 'gh2-pkg': 'github:a/b#r' },
      spawn: { plugin: () => ({ code: 1, signal: null, stdout: '', stderr: 'boom', timedOut: false }) },
    })
    await world.run('/plugin uninstall loop')
    expect(world.notices.at(-1)).toBe('uninstall failed: removing "Loop" failed: boom')
    // No node_modules version: the Version row falls back to installed.
    await world.run('/plugin info loop')
    expect(JSON.stringify((world.overlay() as { currentNode(): unknown }).currentNode())).toContain('installed')
    // GitHub-only rows render their github install command.
    await world.run('/plugin info gh2')
    expect(JSON.stringify((world.overlay() as { currentNode(): unknown }).currentNode())).toContain('github:a/b#r')
    world.dispose()
  })

  it('falls back to the generic removed note without a statusNote', async () => {
    const world = await mountWorld({
      index: [entry({ id: 'silent-gone', displayName: 'Silent Gone', status: 'removed', install: { rows: [{ name: 'silent-pkg', npm: { spec: 'silent-pkg' } }] } })],
      profileDependencies: { 'silent-pkg': '1.0.0' },
    })
    await world.run('/plugin list')
    expect(JSON.stringify((world.overlay() as { currentNode(): unknown }).currentNode())).toContain('removed from the market')
    world.dispose()
  })

})
