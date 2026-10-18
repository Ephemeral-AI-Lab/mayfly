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
function indexJson(entries: readonly MarketEntry[], generatedAt = '2026-09-04T00:00:00.000Z'): string {
  return JSON.stringify({ schemaVersion: 1, generatedAt, entries })
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
  generatedAt?: string
}

/** One command world: temp catalog home, a fake native manager, and the command mounted. */
async function mountWorld(options: WorldOptions = {}) {
  const home = mkdtempTracked('mayfly-plugin-cmd-')
  mkdirSync(join(home, '.dsh'), { recursive: true })
  let offline = options.offline === true
  updaterInternals.env = { DSH_HOME: join(home, '.dsh') }
  updaterInternals.homedir = () => home
  updaterInternals.now = () => 1_000_000
  updaterInternals.fetchText = vi.fn(async (url: string) => {
    if (offline) throw new Error(`registry responded 503 for ${url}`)
    if (url.includes('jsdelivr') || url.includes('raw.githubusercontent')) {
      if (options.index === undefined) throw new Error('no index scripted')
      return indexJson(options.index, options.generatedAt)
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
  const fiber = await ctx.plugin({ name: 'plugin-market-spec', inject: ['commands'], apply: c => registerPluginCommand(c) })
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
    setOffline: (next: boolean) => { offline = next },
    locale: ctx.get('mayflyLocale') as unknown as MayflyLocaleService | undefined,
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

describe('/plugin native management diagnostics', () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ['management-required', { code: 'management-required' }, 'the plugin manager protects this bundle'],
    ['unaddressable', { code: 'unaddressable' }, 'the plugin manager cannot address this bundle'],
    ['not-removable', { code: 'not-removable' }, 'this bundle is not removable'],
    ['not-bundle', { code: 'not-bundle' }, 'this package declares no bundle patch'],
    ['already-installed', { code: 'already-installed' }, 'this package is already installed'],
    ['stop-profile', { code: 'stop-profile' }, 'restart Mayfly before removing this running bundle'],
    ['bundle-in-use', { code: 'bundle-in-use' }, 'this bundle is still in use'],
    ['stale-approval', { code: 'stale-approval' }, 'a saved build approval is out of date'],
    ['invalid-spec', { code: 'invalid-spec' }, 'the package spec is invalid'],
    ['ambiguous-install', { code: 'ambiguous-install' }, 'the installation added more than one package'],
    ['unknown-plugin', { code: 'unknown-plugin' }, 'the plugin is no longer installed'],
    ['operation-error without diagnostic', { code: 'operation-error' }, 'the package operation failed'],
  ]

  it.each(cases)('renders the %s refusal in words', async (_name, error, message) => {
    const world = await mountWorld({
      index: [entry()],
      installResult: spec => ({ changed: false, application: 'failed', stage: 'install', target: spec, error: error as never }),
    })
    await world.run('/plugin install loop')
    expect(world.notices.at(-1)).toBe(`install failed: ${message}`)
    world.dispose()
  })

  it('falls back to the generic refusal without an error object and shortens a long diagnostic', async () => {
    const generic = await mountWorld({
      index: [entry()],
      installResult: spec => ({ changed: false, application: 'failed', stage: 'install', target: spec }),
    })
    await generic.run('/plugin install loop')
    expect(generic.notices.at(-1)).toBe('install failed: the native plugin manager refused the change')
    generic.dispose()

    const long = await mountWorld({
      index: [entry()],
      installResult: spec => ({
        changed: false, application: 'failed', stage: 'install', target: spec,
        error: { code: 'operation-error', diagnostic: `${'x'.repeat(200)} tail` },
      }),
    })
    await long.run('/plugin install loop')
    expect(long.notices.at(-1)).toContain('…')
    long.dispose()
  })

  it('reports an overridden native change as saved but not composed', async () => {
    const world = await mountWorld({
      index: [entry()],
      installResult: spec => ({ changed: true, application: 'overridden', stage: 'install', target: spec }),
    })
    await world.run('/plugin install loop')
    expect(world.notices.at(-1)).toBe('change saved but overridden by the composition')
    world.dispose()
  })
})

describe('/plugin native enable and removal diagnostics', () => {
  it('enables an on-demand installation without installing it again', async () => {
    const world = await mountWorld({
      index: [entry()],
      bundles: [bundle({ name: 'dsh-loop', availability: 'installation', installed: false, enabled: false })],
    })
    await world.run('/plugin install loop')
    expect(world.calls.enable).toEqual([{ name: 'dsh-loop', enabled: true }])
    expect(world.calls.install).toHaveLength(0)
    world.dispose()
  })

  it('renders a failed and a cancelled native removal', async () => {
    const failed = await mountWorld({
      index: [entry()], bundles: [bundle({ name: 'dsh-loop' })],
      removeResult: name => ({ changed: false, application: 'failed', stage: 'remove', target: name, error: { code: 'bundle-in-use' } }),
    })
    await failed.run('/plugin uninstall loop')
    expect(failed.notices.at(-1)).toBe('uninstall failed: this bundle is still in use')
    failed.dispose()

    const cancelled = await mountWorld({
      index: [entry()], bundles: [bundle({ name: 'dsh-loop' })],
      removeResult: name => ({ changed: false, application: 'cancelled', stage: 'remove', target: name }),
    })
    await cancelled.run('/plugin uninstall loop')
    expect(cancelled.notices.at(-1)).toBe('removal cancelled')
    cancelled.dispose()
  })

  it('reports a not-removable bundle without a manager reason', async () => {
    const world = await mountWorld({ index: [entry()], bundles: [bundle({ name: 'dsh-loop', removable: false })] })
    await world.run('/plugin uninstall loop')
    expect(world.notices.at(-1)).toBe('the plugin manager does not allow removing this bundle')
    expect(world.calls.remove).toHaveLength(0)
    world.dispose()
  })

  it('fails the removal when the native list changed after the row was built', async () => {
    const world = await mountWorld({ index: [entry()], bundles: [bundle({ name: 'dsh-loop' })] })
    const installed = world.bundles()
    world.manager.listBundles
      .mockResolvedValueOnce(installed)
      .mockResolvedValueOnce([bundle({ name: 'dsh-loop', removable: false, readOnlyReason: 'management-required' })])
    await world.run('/plugin uninstall loop')
    expect(world.notices.at(-1)).toContain('the plugin manager protects this bundle')
    expect(world.calls.remove).toHaveLength(0)
    world.dispose()
  })

  it('reports a removal when the native list no longer carries the package', async () => {
    const world = await mountWorld({ index: [entry()], bundles: [bundle({ name: 'dsh-loop' })] })
    world.manager.listBundles
      .mockResolvedValueOnce(world.bundles())
      .mockResolvedValueOnce([])
    await world.run('/plugin uninstall loop')
    expect(world.notices.at(-1)).toBe('"Loop" is not installed in this profile')
    expect(world.calls.remove).toHaveLength(0)
    world.dispose()
  })

  it('catches a rejected removal service call', async () => {
    const world = await mountWorld({ index: [entry()], bundles: [bundle({ name: 'dsh-loop' })] })
    world.manager.removeBundle.mockRejectedValueOnce(new Error('profile locked'))
    await world.run('/plugin uninstall loop')
    expect(world.notices.at(-1)).toBe('uninstall failed: profile locked')
    world.dispose()
  })
})

describe('/plugin argument verbs and detail actions', () => {
  it('opens the Installed and Updates tabs from the argument verbs', async () => {
    const world = await mountWorld({ index: [entry()], bundles: [bundle({ name: 'dsh-loop', version: '0.1.3' })] })
    expect(await world.run('/plugin list')).toEqual({ kind: 'success' })
    await vi.waitFor(() => { expect(world.surface()).toBeDefined() })
    expect(world.surface()!.activeTab({ pagePath: [], controlId: 'plugin-tabs' })).toBe('installed')
    world.dispose()

    const updates = await mountWorld({ index: [entry()], bundles: [bundle({ name: 'dsh-loop', version: '0.1.3' })] })
    expect(await updates.run('/plugin updates')).toEqual({ kind: 'success' })
    await vi.waitFor(() => { expect(updates.surface()).toBeDefined() })
    expect(updates.surface()!.activeTab({ pagePath: [], controlId: 'plugin-tabs' })).toBe('updates')
    updates.dispose()
  })

  it('refuses the browser, info, and refresh without their native services', async () => {
    const bare = await mountWorld({ index: [entry()], withScreen: false })
    expect(await bare.run('/plugin')).toMatchObject({ kind: 'error', text: expect.stringContaining('UI registry is not mounted') })
    expect(await bare.run('/plugin list')).toMatchObject({ kind: 'error', text: expect.stringContaining('UI registry is not mounted') })
    expect(await bare.run('/plugin info loop')).toMatchObject({ kind: 'error', text: expect.stringContaining('UI registry is not mounted') })
    bare.dispose()

    const noManager = await mountWorld({ index: [entry()], withManager: false })
    expect(await noManager.run('/plugin refresh')).toMatchObject({ kind: 'error', text: expect.stringContaining('plugin manager is unavailable') })
    expect(await noManager.run('/plugin info loop')).toMatchObject({ kind: 'error', text: expect.stringContaining('plugin manager is unavailable') })
    noManager.dispose()
  })

  it('loads the catalog on demand for info and install, and refuses removed or unknown ids', async () => {
    const world = await mountWorld({ index: [entry(), entry({ id: 'gone', displayName: 'Gone', status: 'removed', statusNote: 'compromised' })] })
    expect(await world.run('/plugin info loop')).toEqual({ kind: 'success' })
    expect(await world.run('/plugin info gone')).toEqual({ kind: 'success' })
    expect(await world.run('/plugin info nope')).toMatchObject({ kind: 'error', text: 'unknown plugin: nope' })
    expect(await world.run('/plugin uninstall gone')).toMatchObject({ kind: 'error', text: expect.stringContaining('not installed') })
    expect(await world.run('/plugin uninstall nope')).toMatchObject({ kind: 'error', text: 'unknown plugin: nope' })
    world.dispose()
  })

  it('refreshes from the argument path with a missing manager after the panel opened', async () => {
    const world = await mountWorld({ index: [entry()] })
    await openMarket(world)
    world.ctx.set('pluginManager', undefined as never)
    expect(await world.run('/plugin refresh')).toMatchObject({ kind: 'error', text: expect.stringContaining('plugin manager is unavailable') })
    world.dispose()
  })

  it('installs, updates, and removes from the detail panel', async () => {
    const world = await mountWorld({ index: [entry()], bundles: [bundle({ name: 'dsh-loop', version: '0.1.3' })] })
    expect(await world.run('/plugin info loop')).toEqual({ kind: 'success' })
    const detail = world.ctx.mayflyUiInteraction.get('overlay', 'mayfly.plugin-detail')!
    detail.invoke('install')
    await vi.waitFor(() => { expect(world.calls.install).toHaveLength(1) })
    await vi.waitFor(() => { expect(detail.feedbackSnapshot().at(-1)?.message).toContain('restart Mayfly') })
    detail.invoke('remove')
    expect(JSON.stringify(detail.decisionNode)).toContain('Remove the selected plugin?')
    detail.answerDecision(true)
    await vi.waitFor(() => { expect(world.calls.remove).toEqual(['dsh-loop']) })
    world.dispose()
  })

  it('shows a failed detail operation with its message and keeps the panel open', async () => {
    const world = await mountWorld({
      index: [entry()], bundles: [bundle({ name: 'dsh-loop', version: '0.1.3' })],
      installResult: () => { throw new Error('network down') },
    })
    await world.run('/plugin info loop')
    const detail = world.ctx.mayflyUiInteraction.get('overlay', 'mayfly.plugin-detail')!
    detail.invoke('install')
    await vi.waitFor(() => { expect(detail.feedbackSnapshot().at(-1)?.message).toContain('network down') })
    expect(world.ctx.mayflyUiInteraction.get('overlay', 'mayfly.plugin-detail')).toBeDefined()
    detail.requestClose()
    await new Promise(resolve => setImmediate(resolve))
    expect(world.ctx.mayflyUiInteraction.get('overlay', 'mayfly.plugin-detail')).toBeUndefined()
    world.dispose()
  })

  it('republishes the detail panel when the locale changes', async () => {
    const world = await mountWorld({ index: [entry()] })
    await world.run('/plugin info loop')
    const detail = world.ctx.mayflyUiInteraction.get('overlay', 'mayfly.plugin-detail')!
    const before = detail.revision
    world.locale!.setPreference('zh')
    await vi.waitFor(() => { expect(detail.revision).toBeGreaterThan(before) })
    world.dispose()
  })
})

/** The live marketplace registration, for events a test addresses directly. */
function marketEntry(world: World) {
  return world.ctx.mayflyOverlays.list().find(item => item.id === 'mayfly.plugin-market')!
}

async function prepareMarket(world: World, event: unknown, signal = new AbortController().signal) {
  const entry = marketEntry(world)
  return await entry.events.prepare(event as never, { surfaceId: entry.id, operationId: 'spec', source: [], revision: entry.revision, signal, report: vi.fn() })
}

const rowSelection = (id: string) => ({ kind: 'activate', pagePath: [], controlId: 'plugins-browse', actionId: 'install', inputs: { selections: [{ controlId: 'plugins-browse', pagePath: [], selectedIds: [id] }] } })

describe('/plugin market edge operations', () => {
  it('uses English when the frontend ships no locale service', async () => {
    const world = await mountWorld({ index: [entry()], withLocale: false })
    const model = await openMarket(world)
    expect(JSON.stringify(model.node)).toContain('Plugin marketplace')
    expect(JSON.stringify(model.node)).toContain('1 entries')
    world.dispose()
  })

  it('reports an offline catalog as an unknown plugin before any native call', async () => {
    const world = await mountWorld({ offline: true })
    expect(await world.run('/plugin install loop')).toMatchObject({ kind: 'error', text: 'unknown plugin: loop' })
    expect(world.calls.install).toHaveLength(0)
    world.dispose()
  })

  it('keeps the newest catalog load when two refreshes settle out of order', async () => {
    const world = await mountWorld({ index: [entry()], withScreen: false })
    const first = Promise.withResolvers<string>()
    const second = Promise.withResolvers<string>()
    updaterInternals.fetchText = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const reading = world.run('/plugin refresh')
    const writing = world.run('/plugin refresh')
    second.resolve(indexJson([entry({ id: 'second', displayName: 'Second' })]))
    await writing
    first.resolve(indexJson([entry()]))
    await reading
    world.dispose()
  })

  it('drops a refreshed native list when the fiber unloaded during the read', async () => {
    const world = await mountWorld({ index: [entry()], withManager: false })
    await world.run('/plugin info loop')
    world.dispose()
  })

  it('warns without a status footer when a restart-only change lands', async () => {
    const world = await mountWorld({ index: [entry()], withScreen: false })
    await world.run('/plugin install loop')
    expect(world.calls.install).toHaveLength(1)
    world.dispose()
  })

  it('records the restart chip once and updates its count', async () => {
    const world = await mountWorld({ index: [entry()] })
    await openMarket(world)
    focusBrowserRow(world, 'loop')
    invokeMarketAction(world, 'install')
    await vi.waitFor(() => { expect(world.calls.install).toHaveLength(1) })
    await vi.waitFor(() => { expect(JSON.stringify(world.surface()!.node)).toContain('1 change applies') })
    const entries = world.ctx.mayflyOverlays.list()
    expect(entries.some(item => item.id === 'mayfly.plugin-market')).toBe(true)
    world.dispose()
  })

  it('loads only a mixed-source multi-row entry it can address', async () => {
    const mixed = entry({
      id: 'mixed', displayName: 'Mixed',
      install: { rows: [{ name: 'npm-row', npm: { spec: 'npm-row' } }, { name: 'github-row', github: { repo: 'a/b', ref: 'main' } }] },
    })
    const world = await mountWorld({ index: [mixed] })
    await world.run('/plugin install mixed')
    expect(world.calls.install).toHaveLength(0)
    expect(world.notices.at(-1)).toBe('"Mixed" has no common install source for every package')
    world.dispose()
  })

  it('reports a multi-row update failure with the failing package name', async () => {
    const multi = entry({
      id: 'multi', displayName: 'Multi',
      install: { rows: [{ name: 'multi-a', npm: { spec: 'multi-a' } }, { name: 'multi-b', npm: { spec: 'multi-b' } }] },
      npm: { 'multi-a': { latestVersion: '1.0.0' }, 'multi-b': { latestVersion: '1.0.0' } },
    })
    const world = await mountWorld({
      index: [multi],
      bundles: [bundle({ name: 'multi-a', version: '0.0.1' }), bundle({ name: 'multi-b', version: '0.0.1' })],
      installResult: spec => ({ changed: false, application: 'failed', stage: 'install', target: spec, error: { code: 'not-bundle' } }),
    })
    await world.run('/plugin install multi')
    expect(world.notices.at(-1)).toContain('multi-a: this package declares no bundle patch')
    world.dispose()
  })

  it('refuses install on an unlisted installed bundle and on an entry with no source', async () => {
    const unlisted = await mountWorld({ index: [], bundles: [bundle({ name: 'custom-plugin' })] })
    expect(await unlisted.run('/plugin install custom-plugin')).toMatchObject({ kind: 'error', text: 'this bundle is not listed in the marketplace index' })
    unlisted.dispose()

    const sourceless = entry({ id: 'bare', displayName: 'Bare', install: { rows: [{ name: 'bare-pkg' }] } })
    const noSource = await mountWorld({ index: [sourceless] })
    await noSource.run('/plugin install bare')
    noSource.dispose()
  })

  it('reports missing and non-removable rows through the market actions', async () => {
    const world = await mountWorld({ index: [entry()] })
    await openMarket(world)
    expect((await prepareMarket(world, rowSelection('missing'))).reply).toMatchObject({ kind: 'failed', message: 'plugin operation failed' })
    expect((await prepareMarket(world, { kind: 'activate', pagePath: [], controlId: 'plugins-browse', actionId: 'remove', inputs: { selections: [{ controlId: 'plugins-browse', pagePath: [], selectedIds: ['loop'] }] } })).reply).toMatchObject({ kind: 'failed' })
    expect((await prepareMarket(world, { kind: 'activate', pagePath: [], controlId: 'plugins-browse', actionId: 'install', inputs: { selections: [{ controlId: 'plugins-browse', pagePath: [], selectedIds: ['acp'] }] } })).reply).toBeDefined()
    world.dispose()
  })

  it('does nothing for actions without an id or with an unknown action id', async () => {
    const world = await mountWorld({ index: [entry()] })
    await openMarket(world)
    expect((await prepareMarket(world, { kind: 'activate', pagePath: [], controlId: 'plugin-actions', actionId: 'install' })).reply).toMatchObject({ kind: 'completed' })
    expect((await prepareMarket(world, { kind: 'activate', pagePath: [], controlId: 'plugin-actions', actionId: 'bogus' })).reply).toMatchObject({ kind: 'completed' })
    expect((await prepareMarket(world, { kind: 'selection-accept', pagePath: [], controlId: 'plugins-browse', selectedIds: [] })).reply).toMatchObject({ kind: 'completed' })
    expect((await prepareMarket(world, { kind: 'selection-accept', pagePath: [], controlId: 'plugins-browse', selectedIds: ['gone'] })).reply).toMatchObject({ kind: 'completed' })
    world.dispose()
  })

  it('switches the install source and the group mode from the panel', async () => {
    const world = await mountWorld({ index: [entry()] })
    await openMarket(world)
    focusBrowserRow(world, 'loop')
    const switched = await prepareMarket(world, { kind: 'activate', pagePath: [], controlId: 'plugin-actions', actionId: 'source', inputs: { selections: [{ controlId: 'plugins-browse', pagePath: [], selectedIds: ['loop'] }] } })
    expect(switched.reply).toMatchObject({ kind: 'accepted', feedback: { message: 'install source: github' } })
    const grouped = await prepareMarket(world, { kind: 'activate', pagePath: [], controlId: 'plugin-actions', actionId: 'group', inputs: { selections: [{ controlId: 'plugins-browse', pagePath: [], selectedIds: ['loop'] }] } })
    expect(grouped.reply).toMatchObject({ kind: 'accepted' })
    world.dispose()
  })

  it('ignores an unknown source row and tracks tab and focus observations', async () => {
    const world = await mountWorld({ index: [entry()], bundles: [bundle({ name: 'custom-plugin' })] })
    await openMarket(world)
    selectBrowserTab(world, 'installed')
    focusBrowserRow(world, 'unlisted:custom-plugin')
    expect((await prepareMarket(world, { kind: 'activate', pagePath: [], controlId: 'plugin-actions', actionId: 'source', inputs: { selections: [{ controlId: 'plugins-installed', pagePath: [], selectedIds: ['unlisted:custom-plugin'] }] } })).reply).toMatchObject({ kind: 'completed' })
    await prepareMarket(world, { kind: 'tab-change', tabId: 'updates' })
    await prepareMarket(world, { kind: 'tab-change', tabId: 'updates' })
    await prepareMarket(world, { kind: 'tab-change', tabId: 'bogus' })
    await prepareMarket(world, { kind: 'focus-change', controlId: 'plugins-updates', itemId: 'custom-plugin' })
    await prepareMarket(world, { kind: 'focus-change', controlId: 'plugins-browse' })
    await prepareMarket(world, { kind: 'focus-change', controlId: 'unknown-list', itemId: 'x' })
    await prepareMarket(world, { kind: 'dismiss', pagePath: [] })
    world.dispose()
  })

  it('says there is nothing to update and stops a failing update-all run', async () => {
    const empty = await mountWorld({ index: [entry()] })
    await openMarket(empty)
    const emptyReply = await prepareMarket(empty, { kind: 'activate', pagePath: [], controlId: 'plugin-actions', actionId: 'update-all' })
    expect(emptyReply.reply).toMatchObject({ kind: 'accepted', feedback: { message: 'no plugin updates to apply' } })
    empty.dispose()

    const failing = await mountWorld({
      index: [entry()],
      bundles: [bundle({ name: 'dsh-loop', version: '0.1.3' })],
      installResult: spec => ({ changed: false, application: 'failed', stage: 'install', target: spec, error: { code: 'not-bundle' } }),
    })
    await openMarket(failing)
    const failingReply = await prepareMarket(failing, { kind: 'activate', pagePath: [], controlId: 'plugin-actions', actionId: 'update-all' })
    expect(failingReply.reply).toMatchObject({ kind: 'failed', message: expect.stringContaining('update all stopped at "Loop"') })
    failing.dispose()
  })

  it('reports manager loss, installed-list failures, and unloads during a panel refresh', async () => {
    const missing = await mountWorld({ index: [entry()], withManager: false })
    await openMarket(missing)
    const missingReply = await prepareMarket(missing, { kind: 'activate', pagePath: [], controlId: 'plugin-actions', actionId: 'refresh' })
    expect(missingReply.reply).toMatchObject({ kind: 'failed', message: 'plugin manager is unavailable: the native plugin service is not mounted' })
    missing.dispose()

    const failing = await mountWorld({ index: [entry()] })
    await openMarket(failing)
    failing.manager.listBundles.mockRejectedValueOnce(new Error('profile locked'))
    const failingReply = await prepareMarket(failing, { kind: 'activate', pagePath: [], controlId: 'plugin-actions', actionId: 'refresh' })
    expect(failingReply.reply).toMatchObject({ kind: 'failed', message: expect.stringContaining('refresh failed: profile locked') })
    failing.dispose()

    const unloaded = await mountWorld({ index: [entry()] })
    await openMarket(unloaded)
    const gate = Promise.withResolvers<string>()
    updaterInternals.fetchText = vi.fn(() => gate.promise)
    const refreshing = prepareMarket(unloaded, { kind: 'activate', pagePath: [], controlId: 'plugin-actions', actionId: 'refresh' })
    await vi.waitFor(() => { expect(updaterInternals.fetchText).toHaveBeenCalled() })
    unloaded.dispose()
    gate.resolve(indexJson([entry()]))
    expect(await refreshing).toMatchObject({ reply: undefined })
  })

  it('renders the stale and aged marketplace subtitles', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString()
    const aged = await mountWorld({ index: [entry()], generatedAt: twoHoursAgo })
    const agedModel = await openMarket(aged)
    expect(JSON.stringify(agedModel.node)).toContain('index updated 2h ago')
    aged.setOffline(true)
    invokeMarketAction(aged, 'refresh')
    await vi.waitFor(() => { expect(JSON.stringify(aged.surface()!.node)).toContain('⚠ offline · showing cached data from 2h ago') })
    aged.dispose()

    const days = await mountWorld({ index: [entry()], generatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() })
    const daysModel = await openMarket(days)
    expect(JSON.stringify(daysModel.node)).toContain('index updated 3d ago')
    days.dispose()

    const unknown = await mountWorld({ index: [entry()], generatedAt: 'not-a-date' })
    const unknownModel = await openMarket(unknown)
    expect(JSON.stringify(unknownModel.node)).toContain('1 entries')
    unknown.dispose()
  })

  it('renders a future-dated index as under an hour old', async () => {
    const world = await mountWorld({ index: [entry()], generatedAt: new Date(Date.now() + 3_600_000).toISOString() })
    const model = await openMarket(world)
    expect(JSON.stringify(model.node)).toContain('index updated under an hour ago')
    world.dispose()
  })

  it('drops a stale native bundle read that rejects after a newer read settled', async () => {
    const world = await mountWorld({ index: [entry()], withScreen: false })
    const stale = Promise.withResolvers<readonly BundleInfo[]>()
    world.manager.listBundles
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce([])
    const first = world.run('/plugin refresh')
    await vi.waitFor(() => { expect(world.manager.listBundles).toHaveBeenCalledTimes(1) })
    const second = world.run('/plugin refresh')
    await second
    stale.reject(new Error('too late'))
    await first
    world.dispose()
  })
})

describe('/plugin operation lifetimes', () => {
  it('abandons an install whose native bundle read lands after unload', async () => {
    const world = await mountWorld({ index: [entry()] })
    const gate = Promise.withResolvers<readonly BundleInfo[]>()
    const current = world.bundles()
    world.manager.listBundles
      .mockResolvedValueOnce(current)
      .mockReturnValueOnce(gate.promise)
    const running = world.run('/plugin install loop')
    await vi.waitFor(() => { expect(world.manager.listBundles).toHaveBeenCalledTimes(2) })
    world.dispose()
    gate.resolve(current)
    await running
    expect(world.calls.install).toHaveLength(0)
  })

  it('abandons an install whose native result lands after unload', async () => {
    const world = await mountWorld({ index: [entry()] })
    const gate = Promise.withResolvers<ChangeResult>()
    world.manager.installBundle.mockReturnValueOnce(gate.promise)
    const running = world.run('/plugin install loop')
    await vi.waitFor(() => { expect(world.manager.installBundle).toHaveBeenCalledOnce() })
    world.dispose()
    gate.resolve(restartResult({ target: 'dsh-loop', bundle: 'dsh-loop' }))
    await running
  })

  it('abandons a removal whose native list or result lands after unload', async () => {
    const listed = await mountWorld({ index: [entry()], bundles: [bundle({ name: 'dsh-loop' })] })
    const listGate = Promise.withResolvers<readonly BundleInfo[]>()
    const current = listed.bundles()
    listed.manager.listBundles
      .mockReturnValueOnce(Promise.resolve(current))
      .mockReturnValueOnce(listGate.promise)
    const listing = listed.run('/plugin uninstall loop')
    await vi.waitFor(() => { expect(listed.manager.listBundles).toHaveBeenCalledTimes(2) })
    listed.dispose()
    listGate.resolve(current)
    await listing
    expect(listed.calls.remove).toHaveLength(0)

    const removed = await mountWorld({ index: [entry()], bundles: [bundle({ name: 'dsh-loop' })] })
    const removeGate = Promise.withResolvers<ChangeResult>()
    removed.manager.removeBundle.mockReturnValueOnce(removeGate.promise)
    const removing = removed.run('/plugin uninstall loop')
    await vi.waitFor(() => { expect(removed.manager.removeBundle).toHaveBeenCalledOnce() })
    removed.dispose()
    removeGate.resolve(restartResult({ stage: 'remove', target: 'dsh-loop' }))
    await removing
  })

  it('abandons the argument refresh, info, and install when unload lands in the awaits', async () => {
    const refresh = await mountWorld({ index: [entry()], withScreen: false })
    const refreshGate = Promise.withResolvers<string>()
    updaterInternals.fetchText = vi.fn(() => refreshGate.promise)
    const refreshing = refresh.run('/plugin refresh')
    await vi.waitFor(() => { expect(updaterInternals.fetchText).toHaveBeenCalled() })
    refresh.dispose()
    refreshGate.resolve(indexJson([entry()]))
    await refreshing

    const info = await mountWorld({ index: [entry()] })
    const infoGate = Promise.withResolvers<string>()
    updaterInternals.fetchText = vi.fn(() => infoGate.promise)
    const reading = info.run('/plugin info loop')
    await vi.waitFor(() => { expect(updaterInternals.fetchText).toHaveBeenCalled() })
    info.dispose()
    infoGate.resolve(indexJson([entry()]))
    await reading

    const install = await mountWorld({ index: [entry()] })
    const installGate = Promise.withResolvers<string>()
    updaterInternals.fetchText = vi.fn(() => installGate.promise)
    const installing = install.run('/plugin install loop')
    await vi.waitFor(() => { expect(updaterInternals.fetchText).toHaveBeenCalled() })
    install.dispose()
    installGate.resolve(indexJson([entry()]))
    await installing
  })

  it('reports a lost manager and the unlisted, blocked, and sourceless market rows', async () => {
    const lost = await mountWorld({ index: [entry()] })
    await openMarket(lost)
    lost.ctx.set('pluginManager', undefined as never)
    const lostReply = await prepareMarket(lost, {
      kind: 'activate', pagePath: [], controlId: 'plugins-browse', actionId: 'install',
      inputs: { selections: [{ controlId: 'plugins-browse', pagePath: [], selectedIds: ['loop'] }] },
    })
    expect(lostReply.reply).toMatchObject({ kind: 'failed', message: 'plugin manager is unavailable: the native plugin service is not mounted' })
    lost.dispose()

    const unlisted = await mountWorld({ index: [], bundles: [bundle({ name: 'custom-plugin' })] })
    await openMarket(unlisted)
    const unlistedReply = await prepareMarket(unlisted, {
      kind: 'activate', pagePath: [], controlId: 'plugins-installed', actionId: 'install',
      inputs: { selections: [{ controlId: 'plugins-installed', pagePath: [], selectedIds: ['unlisted:custom-plugin'] }] },
    })
    expect(unlistedReply.reply).toMatchObject({ kind: 'failed', message: 'this bundle is not listed in the marketplace index' })
    unlisted.dispose()

    const blocked = await mountWorld({ index: [entry({
      id: 'acp', displayName: 'ACP Server',
      install: { rows: [{ name: '@deepseek-ai/dsh-acp', npm: { spec: '@deepseek-ai/dsh-acp' } }] },
    })] })
    await openMarket(blocked)
    const blockedReply = await prepareMarket(blocked, {
      kind: 'activate', pagePath: [], controlId: 'plugins-browse', actionId: 'install',
      inputs: { selections: [{ controlId: 'plugins-browse', pagePath: [], selectedIds: ['acp'] }] },
    })
    expect(blockedReply.reply).toMatchObject({ kind: 'failed', message: expect.stringContaining('owns stdio') })
    blocked.dispose()
  })

  it('keeps and reuses the focused row when the grouping changes', async () => {
    const world = await mountWorld({ index: [entry()] })
    await openMarket(world)
    await prepareMarket(world, { kind: 'focus-change', controlId: 'plugins-browse', itemId: 'loop' })
    const reply = await prepareMarket(world, { kind: 'activate', pagePath: [], controlId: 'plugin-actions', actionId: 'group' })
    expect(reply.reply).toMatchObject({ kind: 'accepted' })
    world.dispose()
  })

  it('abandons update-all when unload lands during the native result', async () => {
    const world = await mountWorld({ index: [entry()], bundles: [bundle({ name: 'dsh-loop', version: '0.1.3' })] })
    await openMarket(world)
    const gate = Promise.withResolvers<ChangeResult>()
    world.manager.installBundle.mockReturnValueOnce(gate.promise)
    const running = prepareMarket(world, { kind: 'activate', pagePath: [], controlId: 'plugin-actions', actionId: 'update-all' })
    await vi.waitFor(() => { expect(world.manager.installBundle).toHaveBeenCalledOnce() })
    world.dispose()
    gate.resolve(restartResult({ target: 'dsh-loop', bundle: 'dsh-loop' }))
    expect(await running).toMatchObject({ reply: undefined })
  })
})

describe('/plugin branch edges', () => {
  it('names an incompatible-version refusal that carries no package list', async () => {
    const world = await mountWorld({
      index: [entry()],
      installResult: spec => ({ changed: false, application: 'failed', stage: 'install', target: spec, error: { code: 'incompatible-version' } as never }),
    })
    await world.run('/plugin install loop')
    expect(world.notices.at(-1)).toBe('install failed: incompatible with this DSH:')
    world.dispose()
  })

  it('stringifies a non-Error bundle read for the argument refresh', async () => {
    const world = await mountWorld({ index: [entry()], withScreen: false })
    world.manager.listBundles.mockRejectedValueOnce('profile locked' as never)
    expect(await world.run('/plugin refresh')).toMatchObject({ kind: 'error', text: expect.stringContaining('profile locked') })
    world.dispose()
  })

  it('reports an immediately applied install without asking for a restart', async () => {
    const world = await mountWorld({
      index: [entry()],
      installResult: spec => ({ changed: true, application: 'applied', stage: 'install', target: spec }),
    })
    await world.run('/plugin install loop')
    expect(world.notices.at(-1)).toBe('installed')
    world.dispose()
  })

  it('reports the generic protection reason for a blocked bundle', async () => {
    const world = await mountWorld({ index: [entry()], bundles: [bundle({ name: 'dsh-loop' })] })
    world.manager.listBundles
      .mockResolvedValueOnce(world.bundles())
      .mockResolvedValueOnce([bundle({ name: 'dsh-loop', removable: false })])
    await world.run('/plugin uninstall loop')
    expect(world.notices.at(-1)).toContain('this bundle is not removable')
    expect(world.calls.remove).toHaveLength(0)
    world.dispose()
  })

  it('reports an immediately applied removal as removed', async () => {
    const world = await mountWorld({
      index: [entry()],
      bundles: [bundle({ name: 'dsh-loop' })],
      removeResult: name => ({ changed: true, application: 'applied', stage: 'remove', target: name }),
    })
    await world.run('/plugin uninstall loop')
    expect(world.notices.at(-1)).toBe('removed')
    expect(world.calls.remove).toEqual(['dsh-loop'])
    world.dispose()
  })

  it('derives rows while the first native bundle read is still pending', async () => {
    const world = await mountWorld({ index: [entry()] })
    const gate = Promise.withResolvers<readonly BundleInfo[]>()
    world.manager.listBundles.mockReturnValueOnce(gate.promise)
    expect(await world.run('/plugin')).toEqual({ kind: 'success' })
    const running = prepareMarket(world, rowSelection('loop'))
    gate.resolve([])
    expect(await running).toMatchObject({ reply: { kind: 'accepted' } })
    expect(world.calls.install).toHaveLength(1)
    world.dispose()
  })

  it('finds a removed entry the profile does not carry for the detail panel', async () => {
    const world = await mountWorld({
      index: [entry(), entry({ id: 'gone', displayName: 'Gone', status: 'removed', statusNote: 'compromised' })],
    })
    expect(await world.run('/plugin info gone')).toEqual({ kind: 'success' })
    expect(JSON.stringify(world.ctx.mayflyUiInteraction.get('overlay', 'mayfly.plugin-detail')!.node)).toContain('Gone')
    world.dispose()
  })

  it('names an update failure from the market action and catches a string rejection', async () => {
    const world = await mountWorld({ index: [entry()], bundles: [bundle({ name: 'dsh-loop', version: '0.1.3' })] })
    await openMarket(world)
    selectBrowserTab(world, 'updates')
    focusBrowserRow(world, 'loop')
    world.manager.installBundle.mockRejectedValueOnce('npm offline')
    invokeMarketAction(world, 'update')
    await vi.waitFor(() => { expect(marketFeedback(world.surface()!)).toContain('update failed: npm offline') })
    world.dispose()
  })

  it('substitutes npm for a github row and ignores a source action without a row', async () => {
    const githubOnly = entry({ id: 'gh', displayName: 'GH', install: { rows: [{ name: 'gh-pkg', github: { repo: 'a/b', ref: 'main' } }] } })
    const world = await mountWorld({ index: [githubOnly] })
    await openMarket(world)
    // A focus change on a tab that is not active does not repaint.
    await prepareMarket(world, { kind: 'focus-change', controlId: 'plugins-updates', itemId: 'gh' })
    focusBrowserRow(world, 'gh')
    const switched = await prepareMarket(world, {
      kind: 'activate', pagePath: [], controlId: 'plugin-actions', actionId: 'source',
      inputs: { selections: [{ controlId: 'plugins-browse', pagePath: [], selectedIds: ['gh'] }] },
    })
    expect(switched.reply).toMatchObject({ kind: 'accepted', feedback: { message: 'install source: npm' } })
    const missingId = await prepareMarket(world, { kind: 'activate', pagePath: [], controlId: 'plugin-actions', actionId: 'source' })
    expect(missingId.reply).toMatchObject({ kind: 'completed' })
    world.dispose()
  })

  it('subtitles a stale catalog without generatedAt and reports an offline market refresh', async () => {
    const world = await mountWorld({ index: [entry()] })
    updaterInternals.fetchText = vi.fn(async () => JSON.stringify({ schemaVersion: 1, entries: [entry()] }))
    const model = await openMarket(world)
    expect(JSON.stringify(model.node)).toContain('1 entries')
    updaterInternals.fetchText = vi.fn(async () => { throw new Error('registry down') })
    invokeMarketAction(world, 'refresh')
    await vi.waitFor(() => { expect(JSON.stringify(world.surface()!.node)).toContain('⚠ offline · showing cached data') })
    expect(JSON.stringify(world.surface()!.node)).not.toContain('showing cached data from')
    // A stale cache still counts as a refresh that served entries.
    expect(marketFeedback(world.surface()!)).toContain('refreshed 1 entries')

    const offline = await mountWorld({ offline: true })
    expect(await offline.run('/plugin')).toEqual({ kind: 'success' })
    await vi.waitFor(() => { expect(offline.surface()).toBeDefined() })
    const reply = await prepareMarket(offline, { kind: 'activate', pagePath: [], controlId: 'plugin-keys-offline', actionId: 'refresh' })
    expect(reply.reply).toMatchObject({ kind: 'failed', message: expect.stringContaining('refresh failed:') })
    offline.dispose()
    world.dispose()
  })

  it('does not publish into a marketplace panel closed before its first load', async () => {
    const world = await mountWorld({ index: [entry()] })
    const gate = Promise.withResolvers<string>()
    updaterInternals.fetchText = vi.fn(() => gate.promise)
    expect(await world.run('/plugin')).toEqual({ kind: 'success' })
    world.ctx.mayflyOverlays.close('mayfly.plugin-market')
    gate.resolve(indexJson([entry()]))
    await new Promise(resolve => setImmediate(resolve))
    expect(world.ctx.mayflyOverlays.list().map(item => item.id)).not.toContain('mayfly.plugin-market')
    world.dispose()
  })

  it('reports an update applied immediately as updated', async () => {
    const world = await mountWorld({
      index: [entry()],
      bundles: [bundle({ name: 'dsh-loop', version: '0.1.3' })],
      installResult: spec => ({ changed: true, application: 'applied', stage: 'install', target: spec }),
    })
    await world.run('/plugin install loop')
    expect(world.notices.at(-1)).toBe('updated')
    world.dispose()
  })

  it('reports the web-only warning through the open surface', async () => {
    const webOnly = entry({ id: 'panel', displayName: 'Panel', surfaces: { web: { clientModule: true } } })
    const world = await mountWorld({ index: [webOnly] })
    await openMarket(world)
    focusBrowserRow(world, 'panel')
    const reply = await prepareMarket(world, rowSelection('panel'))
    expect(reply.reply).toMatchObject({ kind: 'accepted', feedback: { severity: 'success' } })
    expect(world.calls.install).toHaveLength(1)
    world.dispose()
  })

  it('dismisses an unlisted detail after its successful removal', async () => {
    const world = await mountWorld({ index: [], bundles: [bundle({ name: 'custom-plugin' })] })
    expect(await world.run('/plugin info custom-plugin')).toEqual({ kind: 'success' })
    const detail = world.ctx.mayflyUiInteraction.get('overlay', 'mayfly.plugin-detail')!
    detail.invoke('remove')
    detail.answerDecision(true)
    await vi.waitFor(() => { expect(world.calls.remove).toEqual(['custom-plugin']) })
    await vi.waitFor(() => { expect(world.ctx.mayflyUiInteraction.get('overlay', 'mayfly.plugin-detail')).toBeUndefined() })
    world.dispose()
  })
})
