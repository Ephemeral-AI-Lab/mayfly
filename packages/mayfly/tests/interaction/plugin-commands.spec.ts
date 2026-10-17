/**
 * Tests for `/plugin` over the real command runtime and a fake native
 * `ctx.pluginManager`: the read-only catalog stays the discovery source, while
 * install, update, remove, and enable go through the native service and render
 * its `ChangeResult` (applied, restart-required, failed, pendingBuilds,
 * incompatible-version). No CLI process runs and no profile file is read or
 * written by the command.
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BundleInfo, ChangeResult, InstallBundleOptions } from '@deepseek-ai/dsh-plugin-manager'
import { mkdtempTracked, registerTempDirCleanup } from '../core/temp-dir.ts'

registerTempDirCleanup()
import { updaterInternals } from '../../src/interaction/updater/io.ts'
import { registerPluginCommand } from '../../src/interaction/plugin-commands.ts'
import * as settingsPlugin from '../../src/interaction/settings.ts'
import { InteractionStateService } from '../../src/interaction/runtime-state.ts'
import { fakeMayflyContext, type FakeScreen } from './fakes.ts'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'
import type { MarketEntry } from '../../src/interaction/plugin-market/types.ts'
import { mountUiRegistryObservers, UiInteractionService } from '../../src/core/ui-interaction-state.ts'
import type { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import { renderRequest } from './request-fixture.ts'
import { withOverrides, type Overrides } from '../fixture-fields.ts'

/** The real seams, restored after every test. */
const REAL = { ...updaterInternals }

afterEach(() => {
  Object.assign(updaterInternals, REAL)
  vi.restoreAllMocks()
})

/** A marketplace entry fixture with every optional field populated. */
function entry(overrides: Overrides<MarketEntry> = {}): MarketEntry {
  return withOverrides<MarketEntry>({
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
  }, overrides)
}

/** A native bundle fixture. */
function bundle(overrides: Partial<BundleInfo> & { name: string }): BundleInfo {
  const { name, ...rest } = overrides
  return {
    official: false,
    availability: 'profile',
    version: '1.0.0',
    enabled: true,
    installed: true,
    optional: false,
    removable: true,
    rows: [],
    overrides: [],
    ...rest,
    name,
  }
}

/** A change the native manager applies only at the next start. */
function restartResult(overrides: Partial<ChangeResult> = {}): ChangeResult {
  return { changed: true, application: 'restart-required', restartReason: 'no-hmr', stage: 'install', target: 'change', ...overrides }
}

/** The index document for the scripted network. */
function indexJson(entries: readonly MarketEntry[]): string {
  return JSON.stringify({ schemaVersion: 1, generatedAt: '2026-09-04T00:00:00.000Z', entries })
}

/** The package name a spec installs, for the default native fake. */
function specName(spec: string, map: Readonly<Record<string, string>> = {}): string {
  const mapped = map[spec]
  if (mapped !== undefined) return mapped
  if (spec.startsWith('github:')) {
    const repo = spec.slice('github:'.length).split('#')[0] ?? ''
    return repo.split('/').pop() ?? repo
  }
  if (spec.startsWith('@')) {
    const at = spec.indexOf('@', 1)
    return at === -1 ? spec : spec.slice(0, at)
  }
  const at = spec.indexOf('@')
  return at === -1 ? spec : spec.slice(0, at)
}

interface WorldOptions {
  index?: readonly MarketEntry[]
  offline?: boolean
  bundles?: readonly BundleInfo[]
  /** Override the list read; throwing simulates an unreadable native profile. */
  listBundles?: () => Promise<readonly BundleInfo[]>
  installResult?: (spec: string) => ChangeResult | Promise<ChangeResult>
  removeResult?: (name: string) => ChangeResult | Promise<ChangeResult>
  enableResult?: (name: string, enabled: boolean) => ChangeResult | Promise<ChangeResult>
  /** Map an installed spec to the package name the default fake adds. */
  bundleNames?: Readonly<Record<string, string>>
  withManager?: boolean
  withScreen?: boolean
  withLocale?: boolean
}

/** One command world: temp catalog home, a fake native manager, and the command mounted. */
async function mountWorld(options: WorldOptions = {}) {
  const home = mkdtempTracked('mayfly-plugin-cmd-')
  mkdirSync(join(home, '.dsh'), { recursive: true })
  updaterInternals.env = { DSH_HOME: join(home, '.dsh') }
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
  const spawns: Array<{ cmd: string, args: readonly string[] }> = []
  updaterInternals.spawnOnce = vi.fn(async (cmd: string, args: readonly string[]) => {
    spawns.push({ cmd, args: [...args] })
    return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
  })

  let currentBundles: BundleInfo[] = [...options.bundles ?? []]
  const calls = {
    install: [] as Array<{ spec: string, options?: InstallBundleOptions }>,
    remove: [] as string[],
    enable: [] as Array<{ name: string, enabled: boolean }>,
  }
  const replaceBundle = (next: BundleInfo): void => {
    currentBundles = [...currentBundles.filter(bundle => bundle.name !== next.name), next]
  }
  const manager = {
    listBundles: vi.fn(async () => options.listBundles === undefined ? currentBundles : options.listBundles()),
    installBundle: vi.fn(async (spec: string, installOptions?: InstallBundleOptions) => {
      calls.install.push({ spec, ...installOptions === undefined ? {} : { options: installOptions } })
      const result = await (options.installResult?.(spec) ?? restartResult({
        target: spec, bundle: specName(spec, options.bundleNames), version: '1.0.0',
      }))
      if (result.application !== 'failed' && result.application !== 'cancelled') {
        const name = result.bundle ?? specName(spec, options.bundleNames)
        replaceBundle(bundle({ name, version: result.version ?? '1.0.0', enabled: true }))
      }
      return result
    }),
    removeBundle: vi.fn(async (name: string) => {
      calls.remove.push(name)
      const result = await (options.removeResult?.(name) ?? restartResult({ stage: 'remove', target: name }))
      if (result.application !== 'failed' && result.application !== 'cancelled') {
        currentBundles = currentBundles.filter(bundle => bundle.name !== name)
      }
      return result
    }),
    setBundleEnabled: vi.fn(async (name: string, enabled: boolean) => {
      calls.enable.push({ name, enabled })
      const result = await (options.enableResult?.(name, enabled) ?? restartResult({ stage: 'enable', target: name, enabled }))
      if (result.application !== 'failed' && result.application !== 'cancelled') {
        currentBundles = currentBundles.map(bundle => bundle.name === name ? { ...bundle, enabled } : bundle)
      }
      return result
    }),
    listVersionExemptions: vi.fn(() => ({ exemptions: {}, warnings: [] })),
    registries: vi.fn(async () => ({ registry: null, fallbackRegistries: [], resolved: null })),
  }

  const mayfly = options.withScreen === false ? undefined : fakeMayflyContext()
  const ctx = mayfly?.ctx ?? new Context()
  const notices: string[] = []
  // The fakes mount the interaction state with the screen; a bare context
  // still needs one for the settings thunk.
  if (mayfly === undefined) new InteractionStateService(ctx, settingsPlugin.DEFAULT_SETTINGS)
  // The Service constructor registers itself; the fakes ship no locale.
  if (mayfly !== undefined && options.withLocale !== false) new MayflyLocaleService(ctx, { systemLocale: 'en' })
  if (mayfly !== undefined) {
    const interaction = new UiInteractionService(ctx)
    interaction.subscribe(() => { notices.splice(0, notices.length, ...interaction.notificationSnapshot().map(item => item.message)) })
    mountUiRegistryObservers(ctx)
    await Promise.resolve()
  }
  if (options.withManager !== false) ctx.provide('pluginManager', manager as never)
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  const session = ctx.sessions.create(SessionId('plugin-spec'))
  const agent = { id: session.id, session, status: 'idle' } as unknown as Agent
  const fiber = await ctx.plugin({ name: 'plugin-market-spec', inject: ['commands'], apply: c => { registerPluginCommand(c) } })
  const drivers = new WeakMap<UiSurfaceModel, BrowserPanel>()
  const surface = (): UiSurfaceModel | undefined => {
    const overlay = mayfly === undefined ? undefined : ctx.mayflyOverlays.list().findLast(item => item.id === 'mayfly.plugin-market')
    return overlay === undefined ? undefined : ctx.mayflyUiInteraction.get('overlay', overlay.id)
  }
  const panel = (): BrowserPanel | undefined => {
    const overlay = mayfly === undefined ? undefined : ctx.mayflyOverlays.list().at(-1)
    if (overlay === undefined) return undefined
    const model = ctx.mayflyUiInteraction.get('overlay', overlay.id)
    if (model === undefined) return undefined
    const existing = drivers.get(model)
    if (existing !== undefined) return existing
    let compiled: ReturnType<typeof renderRequest> | undefined
    let compiledRevision = -1
    const sync = (width = 80) => {
      if (compiled === undefined || compiledRevision !== model.revision) {
        compiled = renderRequest(model, { columns: width, rows: 24 }, compiled?.runtime)
        compiledRevision = model.revision
      }
      return compiled
    }
    const driver: BrowserPanel = {
      handleInput: data => sync().input(data),
      currentNode: () => model.node,
      render: width => sync(width).component.render(width),
    }
    drivers.set(model, driver)
    return driver
  }
  return {
    ctx,
    screen: mayfly?.screen as FakeScreen,
    agent,
    root: join(home, '.dsh'),
    spawns,
    notices,
    calls,
    manager,
    bundles: () => currentBundles,
    setBundles: (next: readonly BundleInfo[]) => { currentBundles = [...next] },
    addBundle: (next: BundleInfo) => replaceBundle(next),
    dispose: (): void => { void fiber.dispose() },
    surface,
    overlay: (): unknown => panel(),
    run: async (line: string) => {
      const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
      return execution?.result
    },
  }
}

type World = Awaited<ReturnType<typeof mountWorld>>

interface BrowserPanel {
  handleInput(data: string): void
  currentNode(): unknown
  render(width: number): string[]
}

/** Address the controls inside the active marketplace tab. */
function marketPage(model: UiSurfaceModel) {
  const tab = model.activeTab({ pagePath: [], controlId: 'plugin-tabs' }) ?? 'browse'
  return [{ controlId: 'plugin-tabs', itemId: tab }]
}

/** Compile and paint the panel once so its responsive list and detail are addressable. */
function renderMarket(world: World): void {
  ;(world.overlay() as BrowserPanel | undefined)?.render(80)
}

/** Select one browser tab through shared tab state. */
function selectBrowserTab(world: World, tabId: 'installed' | 'updates' | 'browse'): void {
  world.surface()!.activateTab({ pagePath: [], controlId: 'plugin-tabs' }, tabId)
  renderMarket(world)
}

/** Move the shared browse focus without turning it into mutable domain selection. */
function focusBrowserRow(world: World, id: string): void {
  renderMarket(world)
  const model = world.surface()!
  const pagePath = marketPage(model)
  model.updateChoice({ pagePath, controlId: `plugins-${pagePath[0]!.itemId}` }, { kind: 'focus', id })
  renderMarket(world)
}

/** Invoke one declared action in the active marketplace tab. */
function invokeMarketAction(world: World, actionId: 'install' | 'update' | 'remove' | 'refresh' | 'update-all'): void {
  renderMarket(world)
  const model = world.surface()!
  model.invoke(actionId, marketPage(model))
}

/** Current structured feedback text for assertions. */
function marketFeedback(model: UiSurfaceModel): string {
  return model.feedbackSnapshot().map(item => item.message).join('\n')
}

/** Open `/plugin` and wait until the panel left its loading document. */
async function openMarket(world: World): Promise<UiSurfaceModel> {
  expect(await world.run('/plugin')).toEqual({ kind: 'success' })
  await vi.waitFor(() => {
    const model = world.surface()
    expect(model).toBeDefined()
    expect(JSON.stringify(model!.node)).not.toContain('loading catalog...')
  })
  renderMarket(world)
  return world.surface()!
}

describe('/plugin install through the native manager', () => {
  it('installs the catalog row through pluginManager and never spawns a CLI', async () => {
    const world = await mountWorld({ index: [entry()] })
    expect(await world.run('/plugin install loop')).toEqual({ kind: 'success' })
    expect(world.calls.install).toEqual([{ spec: 'dsh-loop', options: { enabled: true } }])
    expect(world.spawns).toHaveLength(0)
    expect(world.notices.at(-1)).toBe('installed; restart Mayfly and start a new session to apply')
    world.dispose()
  })

  it('installs the github spec with --source github', async () => {
    const world = await mountWorld({ index: [entry()] })
    await world.run('/plugin install loop --source github')
    expect(world.calls.install[0]?.spec).toBe('github:Ephemeral-AI-Lab/dsh-plugins#main&path:plugins/loop')
    expect(world.spawns).toHaveLength(0)
    world.dispose()
  })

  it('installs every row of a multi-row entry through native calls', async () => {
    const sidechat = entry({
      id: 'sidechat',
      displayName: 'Sidechat',
      install: { rows: [{ name: 'dsh-workbench-ui', npm: { spec: 'dsh-workbench-ui' } }, { name: 'dsh-sidechat', npm: { spec: 'dsh-sidechat' } }] },
    })
    const world = await mountWorld({ index: [sidechat] })
    await world.run('/plugin install sidechat')
    expect(world.calls.install.map(call => call.spec)).toEqual(['dsh-workbench-ui', 'dsh-sidechat'])
    expect(world.spawns).toHaveLength(0)
    world.dispose()
  })

  it('prefers the native exact on-demand target over the catalog spec', async () => {
    const world = await mountWorld({
      index: [entry()],
      bundles: [bundle({ name: 'dsh-loop', availability: 'missing', installed: false, enabled: false, installTarget: { spec: 'dsh-loop@0.1.4', version: '0.1.4' } })],
    })
    await world.run('/plugin install loop')
    expect(world.calls.install[0]).toEqual({ spec: 'dsh-loop@0.1.4', options: { enabled: true, saveExact: true } })
    world.dispose()
  })

  it('warns about a web-only entry and still installs it natively', async () => {
    const webOnly = entry({ id: 'panel', displayName: 'Panel', surfaces: { web: { clientModule: true } } })
    const world = await mountWorld({ index: [webOnly] })
    await world.run('/plugin install panel')
    expect(world.notices).toContain('web-only plugin: it contributes nothing in this terminal frontend')
    expect(world.calls.install).toHaveLength(1)
    world.dispose()
  })

  it('refuses the dedicated-profile ACP server before any native call', async () => {
    const acp = entry({
      id: 'acp', displayName: 'ACP Server',
      install: { rows: [{ id: 'acp', name: '@deepseek-ai/dsh-acp', activation: 'profile-patch', npm: { spec: '@deepseek-ai/dsh-acp' } }] },
    })
    const world = await mountWorld({ index: [acp] })
    expect(await world.run('/plugin install acp')).toMatchObject({ kind: 'error', text: expect.stringContaining('owns stdio') })
    expect(world.calls.install).toHaveLength(0)
    world.dispose()
  })

  it('refuses a removed catalog entry before any native call', async () => {
    const removed = entry({ id: 'gone', displayName: 'Gone', status: 'removed', statusNote: 'compromised release' })
    const world = await mountWorld({ index: [removed] })
    expect(await world.run('/plugin install gone')).toMatchObject({ kind: 'error', text: expect.stringContaining('compromised release') })
    expect(world.calls.install).toHaveLength(0)
    world.dispose()
  })

  it('refuses a source the entry does not declare', async () => {
    const githubOnly = entry({ id: 'gh', displayName: 'GH', install: { rows: [{ name: 'gh-pkg', github: { repo: 'a/b', ref: 'r' } }] } })
    const world = await mountWorld({ index: [githubOnly] })
    await world.run('/plugin install gh --source npm')
    expect(world.notices.at(-1)).toBe('"GH" has no npm install source')
    expect(world.calls.install).toHaveLength(0)
    world.dispose()
  })

  it('serializes overlapping operations through the in-flight guard', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const world = await mountWorld({
      index: [entry()],
      installResult: async () => { await gate; return restartResult({ bundle: 'dsh-loop', target: 'dsh-loop' }) },
    })
    const first = world.run('/plugin install loop')
    await vi.waitFor(() => expect(world.manager.installBundle).toHaveBeenCalledTimes(1))
    expect(await world.run('/plugin install loop')).toEqual({ kind: 'success' })
    await vi.waitFor(() => expect(world.notices).toContain('a plugin operation is already running'))
    release?.()
    await first
    expect(world.manager.installBundle).toHaveBeenCalledTimes(1)
    world.dispose()
  })
})

describe('/plugin native ChangeResult rendering', () => {
  it('shows restart-required as the pending restart banner', async () => {
    const world = await mountWorld({ index: [entry()] })
    const model = await openMarket(world)
    focusBrowserRow(world, 'loop')
    invokeMarketAction(world, 'install')
    await vi.waitFor(() => expect(marketFeedback(model)).toContain('installed; restart Mayfly and start a new session to apply'))
    expect(JSON.stringify(model.node)).toContain('1 change applies after you restart Mayfly')
    expect(world.calls.install).toHaveLength(1)
    world.dispose()
  })

  it('shows an applied change without asking for a restart', async () => {
    const world = await mountWorld({
      index: [entry()],
      installResult: spec => ({ changed: true, application: 'applied', stage: 'enable', target: spec, bundle: 'dsh-loop' }),
    })
    await world.run('/plugin install loop')
    expect(world.notices.at(-1)).toBe('installed')
    const model = await openMarket(world)
    expect(JSON.stringify(model.node)).not.toContain('change applies after you restart')
    world.dispose()
  })

  it('renders a failed native operation with its diagnostic', async () => {
    const world = await mountWorld({
      index: [entry()],
      installResult: spec => ({ changed: false, application: 'failed', stage: 'install', target: spec, error: { code: 'operation-error', diagnostic: 'pnpm: network down' } }),
    })
    await world.run('/plugin install loop')
    expect(world.notices.at(-1)).toBe('install failed: pnpm: network down')
    world.dispose()
  })

  it('lists the pending builds a failed installation left behind', async () => {
    const world = await mountWorld({
      index: [entry()],
      installResult: spec => ({
        changed: false, application: 'failed', stage: 'install', target: spec,
        error: { code: 'operation-error' },
        packageResult: { exitCode: 1, output: 'ERR_PNPM_BLOCKED', truncated: false, logPath: '/tmp/install.log' },
        pendingBuilds: ['node-pty', 'esbuild'],
      }),
    })
    await world.run('/plugin install loop')
    expect(world.notices.at(-1)).toBe('install failed: ERR_PNPM_BLOCKED — pending builds: node-pty, esbuild')
    world.dispose()
  })

  it('renders the native incompatible-version refusal with the offending packages', async () => {
    const world = await mountWorld({
      index: [entry()],
      installResult: spec => ({
        changed: false, application: 'failed', stage: 'install', target: spec,
        error: {
          code: 'incompatible-version',
          incompatible: [{ name: 'dsh-loop', version: '0.2.0', runtimeVersion: '0.2.1', requirements: { 'engines.dsh': '>=0.3' } }],
        },
      }),
    })
    await world.run('/plugin install loop')
    expect(world.notices.at(-1)).toBe('install failed: incompatible with this DSH: dsh-loop@0.2.0')
    world.dispose()
  })

  it('reports a rejected native service call instead of letting it escape the key', async () => {
    const world = await mountWorld({
      index: [entry()],
      installResult: () => { throw new Error('profile is locked') },
    })
    await world.run('/plugin install loop')
    expect(world.notices.at(-1)).toBe('install failed: profile is locked')
    world.dispose()
  })

  it('renders a cancelled installation as a warning, not a failure', async () => {
    const world = await mountWorld({
      index: [entry()],
      installResult: spec => ({ changed: false, application: 'cancelled', stage: 'install', target: spec }),
    })
    await world.run('/plugin install loop')
    expect(world.notices.at(-1)).toBe('installation cancelled')
    world.dispose()
  })
})

describe('/plugin installed, update, and removal rows', () => {
  it('derives the Installed and Updates tabs from native bundles', async () => {
    const world = await mountWorld({
      index: [entry()],
      bundles: [bundle({ name: 'dsh-loop', version: '0.1.3' })],
    })
    const model = await openMarket(world)
    const json = JSON.stringify(model.node)
    expect(json).toContain('"id":"installed","label":"Installed","count":1')
    expect(json).toContain('"id":"updates","label":"Updates 1","attention":true')
    selectBrowserTab(world, 'updates')
    const pagePath = marketPage(model)
    const list = model.choice({ pagePath, controlId: `plugins-${pagePath[0]!.itemId}` })
    expect(JSON.stringify(list?.definition.items)).toContain('0.1.3→0.1.4')
    world.dispose()
  })

  it('updates an installed entry through installBundle', async () => {
    const world = await mountWorld({
      index: [entry()],
      bundles: [bundle({ name: 'dsh-loop', version: '0.1.3' })],
      installResult: spec => restartResult({ target: spec, bundle: 'dsh-loop', version: '0.1.4' }),
    })
    const model = await openMarket(world)
    selectBrowserTab(world, 'updates')
    focusBrowserRow(world, 'loop')
    invokeMarketAction(world, 'install')
    await vi.waitFor(() => expect(marketFeedback(model)).toContain('updated; restart Mayfly and start a new session to apply'))
    expect(world.calls.install[0]?.spec).toBe('dsh-loop')
    renderMarket(world)
    const pagePath = marketPage(model)
    const list = model.choice({ pagePath, controlId: `plugins-${pagePath[0]!.itemId}` })
    expect(JSON.stringify(list?.definition.items)).not.toContain('0.1.3→0.1.4')
    world.dispose()
  })

  it('reports an already up-to-date entry instead of reinstalling it', async () => {
    const world = await mountWorld({
      index: [entry()],
      bundles: [bundle({ name: 'dsh-loop', version: '0.1.4' })],
    })
    const model = await openMarket(world)
    selectBrowserTab(world, 'installed')
    expect(model.availableActions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionId: 'install', pagePath: marketPage(model), enabled: false, disabledReason: 'Already installed in this profile' }),
    ]))
    await world.run('/plugin install loop')
    expect(world.notices.at(-1)).toBe('"Loop" is already installed and up to date')
    expect(world.calls.install).toHaveLength(0)
    world.dispose()
  })

  it('removes an installed entry through removeBundle', async () => {
    const world = await mountWorld({
      index: [entry()],
      bundles: [bundle({ name: 'dsh-loop', version: '0.1.4' })],
    })
    const model = await openMarket(world)
    selectBrowserTab(world, 'installed')
    focusBrowserRow(world, 'loop')
    invokeMarketAction(world, 'remove')
    expect(JSON.stringify(model.decisionNode)).toContain('Remove the selected plugin?')
    model.answerDecision(true)
    await vi.waitFor(() => expect(marketFeedback(model)).toContain('removed; restart Mayfly and start a new session to apply'))
    expect(world.calls.remove).toEqual(['dsh-loop'])
    world.dispose()
  })

  it('removes every installed row of a multi-row entry', async () => {
    const multi = entry({
      id: 'multi', displayName: 'Multi Row',
      install: { rows: [{ name: 'multi-a', npm: { spec: 'multi-a' } }, { name: 'multi-b', npm: { spec: 'multi-b' } }] },
    })
    const world = await mountWorld({
      index: [multi],
      bundles: [bundle({ name: 'multi-a' }), bundle({ name: 'multi-b' })],
    })
    expect(await world.run('/plugin uninstall multi')).toEqual({ kind: 'success' })
    expect(world.calls.remove).toEqual(['multi-a', 'multi-b'])
    world.dispose()
  })

  it('removes only the installed rows of a partially installed entry', async () => {
    const multi = entry({
      id: 'multi', displayName: 'Multi Row',
      install: { rows: [{ name: 'multi-a', npm: { spec: 'multi-a' } }, { name: 'multi-b', npm: { spec: 'multi-b' } }] },
    })
    const world = await mountWorld({ index: [multi], bundles: [bundle({ name: 'multi-a' })] })
    const model = await openMarket(world)
    selectBrowserTab(world, 'installed')
    focusBrowserRow(world, 'multi')
    invokeMarketAction(world, 'remove')
    model.answerDecision(true)
    await vi.waitFor(() => expect(world.calls.remove).toEqual(['multi-a']))
    world.dispose()
  })

  it('refuses to remove an entry that is not installed', async () => {
    const world = await mountWorld({ index: [entry()] })
    expect(await world.run('/plugin uninstall loop')).toMatchObject({ kind: 'error', text: expect.stringContaining('not installed') })
    expect(world.calls.remove).toHaveLength(0)
    world.dispose()
  })

  it('shows a native non-removable bundle as unavailable with its reason', async () => {
    const protectedBundle = bundle({ name: 'dsh-loop', removable: false, readOnlyReason: 'management-required' })
    const world = await mountWorld({ index: [entry()], bundles: [protectedBundle] })
    const model = await openMarket(world)
    selectBrowserTab(world, 'installed')
    expect(model.availableActions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionId: 'remove', pagePath: marketPage(model), enabled: false, disabledReason: 'the plugin manager protects this bundle' }),
    ]))
    await world.run('/plugin uninstall loop')
    expect(world.notices.at(-1)).toBe('the plugin manager does not allow removing this bundle')
    expect(world.calls.remove).toHaveLength(0)
    world.dispose()
  })

  it('enables a deselected installed bundle with setBundleEnabled without reinstalling', async () => {
    const world = await mountWorld({
      index: [entry()],
      bundles: [bundle({ name: 'dsh-loop', version: '0.1.4', enabled: false })],
    })
    await openMarket(world)
    selectBrowserTab(world, 'updates')
    focusBrowserRow(world, 'loop')
    invokeMarketAction(world, 'install')
    await vi.waitFor(() => expect(world.calls.enable).toEqual([{ name: 'dsh-loop', enabled: true }]))
    expect(world.calls.install).toHaveLength(0)
    world.dispose()
  })

  it('lists an installed bundle the index does not know and removes it natively', async () => {
    const world = await mountWorld({ index: [], bundles: [bundle({ name: 'custom-plugin', version: '2.0.0' })] })
    const model = await openMarket(world)
    selectBrowserTab(world, 'installed')
    const pagePath = marketPage(model)
    const list = model.choice({ pagePath, controlId: `plugins-${pagePath[0]!.itemId}` })
    expect(JSON.stringify(list?.definition.items)).toContain('custom-plugin')
    focusBrowserRow(world, 'unlisted:custom-plugin')
    invokeMarketAction(world, 'remove')
    model.answerDecision(true)
    await vi.waitFor(() => expect(world.calls.remove).toEqual(['custom-plugin']))
    world.dispose()
  })

  it('updates every updatable row through native calls', async () => {
    const first = entry()
    const second = entry({
      id: 'other', displayName: 'Other',
      install: { rows: [{ name: 'dsh-other', npm: { spec: 'dsh-other' } }] },
      npm: { 'dsh-other': { latestVersion: '2.0.0' } },
      verified: { at: '2026-09-04', packages: [{ name: 'dsh-other', version: '2.0.0' }] },
    })
    const world = await mountWorld({
      index: [first, second],
      bundles: [bundle({ name: 'dsh-loop', version: '0.1.3' }), bundle({ name: 'dsh-other', version: '1.0.0' })],
    })
    const model = await openMarket(world)
    selectBrowserTab(world, 'updates')
    invokeMarketAction(world, 'update-all')
    model.answerDecision(true)
    await vi.waitFor(() => expect(world.calls.install).toHaveLength(2))
    await vi.waitFor(() => expect(marketFeedback(model)).toContain('updated 2 plugins; restart Mayfly and start a new session to apply'))
    world.dispose()
  })
})

describe('/plugin native service availability', () => {
  it('shows an unavailable panel and refuses operations without pluginManager', async () => {
    const world = await mountWorld({ index: [entry()], withManager: false })
    const model = await openMarket(world)
    expect(JSON.stringify(model.node)).toContain('plugin manager is unavailable: the native plugin service is not mounted')
    expect(await world.run('/plugin install loop')).toMatchObject({ kind: 'error', text: expect.stringContaining('plugin manager is unavailable') })
    expect(world.spawns).toHaveLength(0)
    expect(world.calls.install).toHaveLength(0)
    world.dispose()
  })

  it('shows an unavailable panel when the native bundle list cannot be read', async () => {
    const world = await mountWorld({
      index: [entry()],
      listBundles: async () => { throw new Error('profile is locked') },
    })
    const model = await openMarket(world)
    expect(JSON.stringify(model.node)).toContain('could not read installed plugins: profile is locked')
    world.dispose()
  })
})

describe('/plugin catalog and refresh', () => {
  it('loads the catalog and opens the grouped browse panel', async () => {
    const world = await mountWorld({ index: [entry()] })
    const model = await openMarket(world)
    const json = JSON.stringify(model.node)
    expect(json).toContain('"id":"browse","label":"Browse","count":1')
    const pagePath = marketPage(model)
    const list = model.choice({ pagePath, controlId: `plugins-${pagePath[0]!.itemId}` })
    expect(JSON.stringify(list?.definition.items)).toContain('Loop')
    expect(JSON.stringify(list?.definition.items)).toContain('official')
    world.dispose()
  })

  it('shows the offline panel when nothing can be fetched', async () => {
    const world = await mountWorld({ offline: true })
    const model = await openMarket(world)
    expect(JSON.stringify(model.node)).toContain('marketplace is offline')
    world.dispose()
  })

  it('hides removed entries unless the profile still carries them', async () => {
    const world = await mountWorld({ index: [entry(), entry({ id: 'gone', displayName: 'Gone', status: 'removed', statusNote: 'security' })] })
    const model = await openMarket(world)
    expect(JSON.stringify(model.node)).not.toContain('Gone')
    world.dispose()
  })

  it('refreshes both the catalog and the native bundle list', async () => {
    const world = await mountWorld({ index: [entry()] })
    const model = await openMarket(world)
    const reads = world.manager.listBundles.mock.calls.length
    invokeMarketAction(world, 'refresh')
    await vi.waitFor(() => expect(marketFeedback(model)).toContain('refreshed 1 entries'))
    expect(world.manager.listBundles.mock.calls.length).toBeGreaterThan(reads)
    expect(updaterInternals.fetchText).toHaveBeenCalled()
    world.dispose()
  })

  it('reports refresh failures in the argument path', async () => {
    const world = await mountWorld({ index: [entry()] })
    expect(await world.run('/plugin refresh')).toEqual({ kind: 'success', text: 'refreshed 1 entries' })
    const offline = await mountWorld({ offline: true })
    expect(await offline.run('/plugin refresh')).toMatchObject({ kind: 'error', text: expect.stringContaining('refresh failed') })
    world.dispose()
    offline.dispose()
  })

  it('finds entries by package name and rejects unknown ids and malformed verbs', async () => {
    const world = await mountWorld({ index: [entry()] })
    expect(await world.run('/plugin info dsh-loop')).toEqual({ kind: 'success' })
    expect(await world.run('/plugin install nope')).toMatchObject({ kind: 'error', text: 'unknown plugin: nope' })
    expect(await world.run('/plugin install')).toMatchObject({ kind: 'error', text: expect.stringContaining('usage') })
    expect(await world.run('/plugin install loop --source')).toMatchObject({ kind: 'error', text: expect.stringContaining('usage') })
    expect(await world.run('/plugin info')).toMatchObject({ kind: 'error', text: expect.stringContaining('usage') })
    expect(await world.run('/plugin dance')).toMatchObject({ kind: 'error', text: expect.stringContaining('usage') })
    world.dispose()
  })
})

describe('/plugin detail panel', () => {
  it('opens the detail with catalog display metadata and no CLI install command', async () => {
    const world = await mountWorld({ index: [entry()] })
    expect(await world.run('/plugin info loop')).toEqual({ kind: 'success' })
    const json = JSON.stringify((world.overlay() as { currentNode(): unknown }).currentNode())
    expect(json).toContain('Loop')
    expect(json).toContain('loop_create')
    expect(json).toContain('/loop')
    expect(json).toContain('dsh >=0.1.0-rc.5')
    expect(json).not.toContain('Install command')
    expect(json).not.toContain('dsh plugin --profile')
    expect(json).not.toContain('running')
    world.dispose()
  })

  it('shows the ACP automation note without suggesting an install command', async () => {
    const acp = entry({
      id: 'acp', displayName: 'ACP Server',
      install: { rows: [{ name: '@deepseek-ai/dsh-acp', npm: { spec: '@deepseek-ai/dsh-acp' } }] },
    })
    const world = await mountWorld({ index: [acp] })
    await world.run('/plugin info acp')
    const json = JSON.stringify((world.overlay() as { currentNode(): unknown }).currentNode())
    expect(json).toContain('dedicated non-Mayfly profile')
    expect(json).not.toContain('Install command')
    world.dispose()
  })

  it('contains detail creation after the browse parent closes', async () => {
    const world = await mountWorld({ index: [entry()] })
    await openMarket(world)
    const root = world.ctx.mayflyOverlays.list().find(item => item.id === 'mayfly.plugin-market')!
    const context = { surfaceId: root.id, operationId: 'detail', source: root.source, revision: root.revision, signal: new AbortController().signal, report: vi.fn() }
    const pending = root.definition.onEvent!.action!({ kind: 'selection-accept', pagePath: [], controlId: 'plugins-browse', selectedIds: ['loop'] }, context)
    world.ctx.mayflyOverlays.close(root.id)
    await pending
    await new Promise(resolve => setImmediate(resolve))
    expect(world.ctx.mayflyOverlays.list()).toEqual([])
    world.dispose()
  })
})
