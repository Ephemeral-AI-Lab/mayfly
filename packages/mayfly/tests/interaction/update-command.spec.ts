/**
 * Tests for `/update` (D52) over the real command runtime: the busy,
 * screen, and in-flight guards, every early-exit verdict (bad version,
 * missing tag, below-floor tag, up to date, link pollution, stale host,
 * cooldown window), the registry failure classes (network, E404,
 * unparseable) with the hint-line progress and retry notices, the
 * Yes/No confirmation and its Esc cancel, the full success path (swap,
 * panel, boot-check cache write), the rollback outcomes (including the
 * installed-set fallback when the registry does not know the old
 * release), the downgrade full-set transaction, a thrown swap settling
 * the panel, and the progress panel's own rendering and close
 * discipline.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inc } from 'semver'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SettingsProvider, { type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtempTracked, registerTempDirCleanup } from '../core/temp-dir.ts'

registerTempDirCleanup()
import { MAYFLY_VERSION } from '../../src/transcript/banner-content.ts'
import * as updateCheck from '../../src/interaction/updater/check.ts'
import { updaterInternals, type InteractiveChild, type SpawnOutcome } from '../../src/interaction/updater/io.ts'
import {
  applyUpdateProgress,
  createUpdateProgressState,
  registerUpdateCommand,
  updatePanelModel,
  updatePanelSummary,
} from '../../src/interaction/update-command.ts'
import * as settingsPlugin from '../../src/interaction/settings.ts'
import { fakeMayflyContext, KEY } from './fakes.ts'
import { InteractionStateService } from '../../src/interaction/runtime-state.ts'
import { mountUiRegistryObservers, UiInteractionService } from '../../src/core/ui-interaction-state.ts'
import type { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'
import { INTERACTION_LOCALE } from '../../src/interaction/locale.ts'
import { checkCooldown, checkHostLine, repairRecipe } from '../../src/interaction/updater/preflight.ts'
import { classifyInstallFailure } from '../../src/interaction/updater/swap.ts'
import { renderRequest } from './request-fixture.ts'

/** The real seams, restored after every test. */
const REAL = { ...updaterInternals }
const flushUpdate = (): Promise<void> => new Promise(resolve => { setImmediate(resolve) })

afterEach(() => {
  Object.assign(updaterInternals, REAL)
})

/** The package managed by the updater. */
const RC2_NAMES = ['@ephemeral-ai/mayfly']
const RC3_NAMES = RC2_NAMES

/** Version roles used by the update scenarios across release bumps. */
const CURRENT_VERSION = MAYFLY_VERSION
const TARGET_VERSION = inc(CURRENT_VERSION, 'prerelease')!
const AHEAD_VERSION = inc(TARGET_VERSION, 'prerelease')!

/** A spawn success. */
function ok(): SpawnOutcome {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
}

/** A scripted interactive child that echoes and quits on demand. */
class FakeChild implements InteractiveChild {
  private exitedValue: SpawnOutcome | undefined
  private readonly resolveExit: (outcome: SpawnOutcome) => void
  readonly exited: Promise<SpawnOutcome>

  constructor() {
    this.exited = new Promise(resolve => {
      this.resolveExit = resolve
    })
  }

  write(data: string): void {
    if (data.includes('/quit')) {
      this.exitedValue ??= ok()
      this.resolveExit(this.exitedValue)
    }
  }

  output(): string {
    return 'deepseek-chat marker'
  }

  kill(): void {
    this.exitedValue ??= { code: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true }
    this.resolveExit(this.exitedValue)
  }
}

/** The registry document variants the tests switch between. */
function packumentJson(options: { channelTag?: string; time?: Record<string, string> } = {}): string {
  // The dependency blocks mirror the consolidated bundle: Mayfly UI is a
  // normal dependency, not an independently coordinated update target.
  const dshDeps = { '@deepseek-ai/dsh-agent-presets': '0.1.1-rc.2' }
  const rc2Deps = { ...dshDeps, '@ephemeral-ai/mayfly-ui': `^${CURRENT_VERSION}` }
  return JSON.stringify({
    'dist-tags': { latest: options.channelTag ?? CURRENT_VERSION },
    versions: {
      '0.1.0-alpha.0': { dependencies: { '@deepseek-ai/dsh-agent-presets': '0.1.1-rc.1' } },
      [AHEAD_VERSION]: { dependencies: { ...rc2Deps, '@ephemeral-ai/mayfly-ui': `^${AHEAD_VERSION}` } },
      [CURRENT_VERSION]: { dependencies: { ...rc2Deps, '@ephemeral-ai/mayfly-ui': `^${CURRENT_VERSION}` } },
      [TARGET_VERSION]: { dependencies: { ...rc2Deps, '@ephemeral-ai/mayfly-ui': `^${TARGET_VERSION}` } },
    },
    time: {
      '0.1.0-alpha.0': '2026-08-20T00:00:00.000Z',
      [AHEAD_VERSION]: '2026-08-22T00:00:00.000Z',
      [CURRENT_VERSION]: '2026-08-22T00:00:00.000Z',
      [TARGET_VERSION]: '2026-08-23T00:00:00.000Z',
      ...options.time,
    },
  })
}

/** One command world: temp profile at rc.2, scripted spawns, mounted command. */
async function mountWorld(options: {
  packument?: string
  dependencies?: string
  hostVersion?: string
  cooldownProbe?: string
  installBehavior?: (specs: string[]) => SpawnOutcome
  agentStatus?: 'idle' | 'running'
  withScreen?: boolean
  sessionCurrent?: 'agent' | 'null'
} = {}) {
  const home = mkdtempTracked('mayfly-updater-cmd-')
  const root = join(home, '.dsh', 'profiles', 'mayfly')
  mkdirSync(join(root, 'node_modules', '@ephemeral-ai', 'mayfly'), { recursive: true })
  writeFileSync(join(root, 'node_modules', '@ephemeral-ai', 'mayfly', 'cordis.patch.yml'), "rows:\n")
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'profile', dependencies: { '@ephemeral-ai/mayfly': CURRENT_VERSION } }))
  const installAt = (version: string): void => {
    // rc.2 shipped the five-package set; rc.3 and everything after carry six.
    for (const name of version === '0.1.0-rc.2' ? RC2_NAMES : RC3_NAMES) {
      const dir = join(root, 'node_modules', name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
    }
  }
  installAt(CURRENT_VERSION)

  const now = Date.parse('2026-08-25T00:00:00.000Z')
  let clock = now
  const spawns: Array<{ cmd: string; args: string[] }> = []
  updaterInternals.env = { DSH_HOME: join(home, '.dsh'), DSH_BIN: '/usr/bin/dsh' }
  updaterInternals.homedir = () => home
  // A stepping clock: the boot smoke's degraded window polls `now()`, and
  // a frozen clock with instant sleeps would spin forever.
  updaterInternals.now = () => {
    clock += 250
    return clock
  }
  updaterInternals.sleep = () => Promise.resolve()
  updaterInternals.spawnOnce = ((cmd: string, args: readonly string[], opts?: { cwd?: string; timeoutMs?: number }) => {
    spawns.push({ cmd, args: [...args] })
    void opts
    if (cmd === 'npm') {
      const dependencies = args[2] === 'dependencies' ? options.dependencies : undefined
      return Promise.resolve({ ...ok(), stdout: dependencies ?? options.packument ?? packumentJson({ channelTag: TARGET_VERSION }) })
    }
    if (args[0] === '--version') {
      return Promise.resolve({ ...ok(), stdout: `${options.hostVersion ?? 'dsh 0.1.1-rc.2 (node v24)'}\n` })
    }
    if (cmd === 'pnpm') {
      if (options.cooldownProbe === 'missing') {
        return Promise.resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: 'ENOENT' })
      }
      if (options.cooldownProbe === 'fail') {
        return Promise.resolve({ code: 1, signal: null, stdout: '', stderr: 'not a pnpm project', timedOut: false })
      }
      if (options.cooldownProbe === 'blank') {
        return Promise.resolve({ ...ok(), stdout: '\n' })
      }
      return Promise.resolve({ ...ok(), stdout: `${options.cooldownProbe ?? '1440'}\n` })
    }
    if (args[0] === 'plugin') {
      const specs = args.filter(arg => arg.startsWith('@ephemeral-ai/'))
      const behavior = options.installBehavior ?? (targetSpecs => {
        installAt(targetSpecs[0]?.endsWith(`@${TARGET_VERSION}`) === true ? TARGET_VERSION : CURRENT_VERSION)
        return ok()
      })
      return Promise.resolve(behavior(specs))
    }
    if (cmd === process.execPath) return Promise.resolve(ok())
    return Promise.resolve(ok())
  }) as typeof updaterInternals.spawnOnce
  updaterInternals.spawnInteractive = (() => new FakeChild()) as typeof updaterInternals.spawnInteractive

  const mayfly = options.withScreen === false ? undefined : fakeMayflyContext()
  const ctx = mayfly?.ctx ?? new Context()
  let interaction: UiInteractionService | undefined
  if (mayfly !== undefined) {
    interaction = new UiInteractionService(ctx)
    mountUiRegistryObservers(ctx)
    await Promise.resolve()
  }
  if (mayfly === undefined) new InteractionStateService(ctx, settingsPlugin.DEFAULT_SETTINGS)
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  const session = ctx.sessions.create(SessionId('update-spec'))
  const agent = { id: session.id, session, status: options.agentStatus ?? 'idle' } as unknown as Agent
  ctx.provide('testSession', { current: options.sessionCurrent === 'null' ? null : agent, modelRef: undefined })
  const disposeCommand = registerUpdateCommand(ctx)
  return {
    ctx,
    screen: mayfly?.screen as FakeScreen,
    agent,
    root,
    home,
    now,
    spawns,
    installAt,
    dispose: () => {
      disposeCommand()
      if (mayfly !== undefined) for (const overlay of ctx.mayflyOverlays.list()) ctx.mayflyOverlays.close(overlay.id)
      interaction?.dispose()
    },
    /** Execute /update and return its result. */
    run: async (line = '/update') => {
      const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
      return execution?.result
    },
    /** Wait for the first dialog surface and drive it through the shared model. */
    waitOverlay: async (): Promise<unknown> => {
      for (let i = 0; i < 100; i += 1) {
        const entry = mayfly === undefined ? undefined : ctx.mayflyOverlays.list().at(-1)
        if (entry !== undefined) {
          const model = ctx.mayflyUiInteraction.get('overlay', entry.id)
          if (model !== undefined) {
            return {
              render: (width: number) => renderRequest(model, { columns: width, rows: 24 }).component.render(width),
              handleInput: (data: string) => renderRequest(model).input(data),
            }
          }
        }
        await new Promise(resolve => setTimeout(resolve, 2))
      }
      throw new Error('no overlay mounted')
    },
    waitSurface: async (id: string): Promise<UiSurfaceModel> => {
      for (let index = 0; index < 100; index += 1) {
        const model = ctx.mayflyUiInteraction.get('overlay', id)
        if (model !== undefined) return model
        await new Promise(resolve => setTimeout(resolve, 2))
      }
      throw new Error(`no surface registered: ${id}`)
    },
  }
}

describe('/update guards', () => {
  it('translates outcomes and progress without changing their structured status', async () => {
    const world = await mountWorld({ agentStatus: 'running' })
    const locale = new MayflyLocaleService(world.ctx, { systemLocale: 'zh' })
    locale.register('interaction', INTERACTION_LOCALE)
    const t = locale.bind('interaction')
    expect(await world.run()).toEqual({ kind: 'error', text: '代理正在运行，请等当前轮次结束后再更新' })
    const state = createUpdateProgressState()
    applyUpdateProgress(state, { step: 'install', state: 'start' })
    expect(JSON.stringify(updatePanelModel(state, '1.0.0', '1.0.1', t))).toContain('安装')
    state.blockedMessage = 'E404 raw diagnostic'
    const blocked = updatePanelModel(state, '1.0.0', '1.0.1', t)
    expect(blocked.title).toBe('更新 Mayfly')
    expect(JSON.stringify(blocked)).toContain('E404 raw diagnostic')
    expect(updatePanelSummary(state, t)).toBe('更新无法继续，未进行任何修改')
    expect(checkCooldown('1.0.1', { publishedAt: 0, now: 60_000, cooldownMinutes: 10 }, t)).toMatchObject({
      code: 'cooldown', blocking: true, message: expect.stringContaining('禁止安装'),
    })
    expect(classifyInstallFailure('EACCES: /raw/path', t)).toBe('配置目录不可写，请修复权限后重试')
    expect(checkHostLine({ hostVersion: '0.1.0', requiredLine: '0.2.0', launcher: true }, t)).toMatchObject({
      blocking: true, message: expect.stringContaining('npm i -g @ephemeral-ai/mayfly-cli'),
    })
    expect(repairRecipe(['@ephemeral-ai/mayfly'], '1.0.1', t)).toContain('dsh plugin --profile <name> add @ephemeral-ai/mayfly@1.0.1')
    locale.setPreference('en')
    expect(updatePanelModel(state, '1.0.0', '1.0.1', t).title).toBe('Update Mayfly')
    locale.dispose()
    world.dispose()
  })

  it('refuses while the agent is running', async () => {
    const world = await mountWorld({ agentStatus: 'running' })
    const result = await world.run()
    expect(result).toEqual({ kind: 'error', text: 'the agent is running — wait for the current turn to finish before updating' })
    world.dispose()
  })

  it('refuses without the Mayfly screen', async () => {
    const world = await mountWorld({ withScreen: false })
    const result = await world.run()
    expect(result?.kind).toBe('error')
    if (result?.kind === 'error') expect(result.text).toContain('not mounted')
    world.dispose()
  })

  it('refuses when the dsh CLI cannot be found', async () => {
    const world = await mountWorld()
    updaterInternals.env = { DSH_HOME: join(world.home, '.dsh') }
    updaterInternals.spawnOnce = ((cmd: string) => {
      if (cmd === 'dsh') {
        return Promise.resolve({ code: 1, signal: null, stdout: '', stderr: 'not found', timedOut: false })
      }
      if (cmd === 'npm') return Promise.resolve({ ...ok(), stdout: packumentJson({ channelTag: TARGET_VERSION }) })
      return Promise.resolve(ok())
    }) as typeof updaterInternals.spawnOnce
    const result = await world.run()
    if (result?.kind === 'error') expect(result.text).toContain('cannot find the dsh CLI')
    else throw new Error('expected error')
    world.dispose()
  })

  it('reports an unreachable registry', async () => {
    const world = await mountWorld()
    updaterInternals.spawnOnce = () =>
      Promise.resolve({ code: 1, signal: null, stdout: '', stderr: 'ETIMEDOUT', timedOut: false })
    const result = await world.run()
    if (result?.kind === 'error') expect(result.text).toContain('could not read the registry')
    else throw new Error('expected error')
    world.dispose()
  })

  it('reports an E404 registry answer as a mirror misconfiguration', async () => {
    const world = await mountWorld()
    updaterInternals.spawnOnce = () =>
      Promise.resolve({ code: 1, signal: null, stdout: '', stderr: 'npm error code E404\nnpm error 404 Not Found', timedOut: false })
    const result = await world.run()
    if (result?.kind === 'error') {
      expect(result.text).toContain('could not read the registry')
      expect(result.text).toContain('E404')
      expect(result.text).toContain('npmrc registry/mirror')
    } else throw new Error('expected error')
    world.dispose()
  })

  it('reports an unparseable registry answer', async () => {
    const world = await mountWorld()
    updaterInternals.spawnOnce = () =>
      Promise.resolve({ ...ok(), stdout: '<html>maintenance</html>' })
    const result = await world.run()
    if (result?.kind === 'error') expect(result.text).toContain('unparseable answer')
    else throw new Error('expected error')
    world.dispose()
  })
})

describe('/update early verdicts', () => {
  it('rejects a malformed version argument', async () => {
    const world = await mountWorld()
    const result = await world.run('/update banana')
    if (result?.kind === 'error') expect(result.text).toContain('not a version')
    else throw new Error('expected error')
    world.dispose()
  })

  it.each(['object', 'array'])('answers up to date from an %s without touching the profile', async format => {
    const document: unknown = JSON.parse(packumentJson({ channelTag: CURRENT_VERSION }))
    const world = await mountWorld({ packument: JSON.stringify(format === 'array' ? [document] : document) })
    const result = await world.run()
    expect(result).toEqual({ kind: 'success', text: `up to date (v${CURRENT_VERSION}; latest tag: ${CURRENT_VERSION})` })
    expect(world.spawns.some(call => call.args[0] === 'plugin')).toBe(false)
    world.dispose()
  })

  it('rejects a missing channel tag', async () => {
    const world = await mountWorld({ packument: packumentJson({ channelTag: CURRENT_VERSION }) })
    const result = await world.run('/update 0.9.9')
    expect(result).toEqual({ kind: 'success' })
    expect(overlayRows(world.ctx)).toContain('is not published')
    world.dispose()
  })

  it('refuses a target below the Mayfly floor', async () => {
    const world = await mountWorld()
    const result = await world.run('/update 0.1.0-alpha.0')
    expect(result).toEqual({ kind: 'success' })
    expect(overlayRows(world.ctx)).toContain("Mayfly's first release")
    world.dispose()
  })

  it('refuses a channel tag that does not parse as a version', async () => {
    const world = await mountWorld({ packument: JSON.stringify({
      'dist-tags': { latest: 'banana' },
      versions: { banana: {} },
      time: {},
    }) })
    const result = await world.run()
    if (result?.kind === 'error') expect(result.text).toContain('does not parse')
    else throw new Error('expected error')
    world.dispose()
  })

  it('blocks on a missing-package profile with the repair recipe', async () => {
    // A half-missing tree: the set-consistency gate blocks, and with the
    // bundle install itself gone the panel header falls back to the
    // running version for its from→to row.
    const world = await mountWorld()
    const { rmSync } = await import('node:fs')
    rmSync(join(world.root, 'node_modules', '@ephemeral-ai', 'mayfly', 'package.json'))
    const result = await world.run(`/update ${CURRENT_VERSION}`)
    expect(result).toEqual({ kind: 'success' })
    const rows = overlayRows(world.ctx)
    expect(rows).toContain('the @ephemeral-ai/mayfly package is not installed')
    expect(rows).toContain('repair: dsh plugin')
    expect(rows).toContain(`v${CURRENT_VERSION} → v${CURRENT_VERSION}`)
    world.dispose()
  })

  it('answers up to date when the channel tag points below the running version', async () => {
    // The tag-below-floor shape only bites once the floor rises above the
    // running version; for a current tree it reads as plain up-to-date.
    const world = await mountWorld({ packument: packumentJson({ channelTag: CURRENT_VERSION }) })
    const result = await world.run()
    expect(result).toEqual({ kind: 'success', text: `up to date (v${CURRENT_VERSION}; latest tag: ${CURRENT_VERSION})` })
    world.dispose()
  })

  it('blocks a link-polluted profile on the panel with the repair recipe', async () => {
    const world = await mountWorld()
    const manifest = JSON.parse(String(updaterInternals.readTextFile(join(world.root, 'package.json')))) as Record<string, unknown>
    manifest.dependencies = { '@ephemeral-ai/mayfly': 'link:../../mayfly/packages/mayfly' }
    updaterInternals.writeTextFile(join(world.root, 'package.json'), JSON.stringify(manifest))
    const result = await world.run()
    // The verdict speaks through the panel (a result line would truncate
    // the recipe); the command itself resolves success-no-text.
    expect(result).toEqual({ kind: 'success' })
    const rows = overlayRows(world.ctx)
    expect(rows).toContain('the profile mixes link/file specs (@ephemeral-ai/mayfly)')
    expect(rows).toContain('repair: dsh plugin')
    expect(rows).toContain('nothing was changed')
    // Esc closes the blocked panel through the bound restore path.
    const blocked = await world.waitSurface('mayfly.update.blocked')
    blocked.requestClose()
    await flushUpdate()
    expect(blocked.disposed).toBe(true)
    world.dispose()
  })

  it('blocks on a stale host with the exact upgrade command on the panel', async () => {
    const world = await mountWorld({ hostVersion: 'dsh 0.1.1-rc.1' })
    const result = await world.run()
    expect(result).toEqual({ kind: 'success' })
    expect(overlayRows(world.ctx)).toContain('npm i -g @deepseek-ai/dsh@0.1.1-rc.2')
    world.dispose()
  })

  it.each(['/update', `/update ${TARGET_VERSION}`])('checks the harness pin from npm 12 for %s', async command => {
    const world = await mountWorld({
      packument: JSON.stringify([{
        'dist-tags': { latest: TARGET_VERSION },
        versions: [CURRENT_VERSION, TARGET_VERSION],
        time: { [TARGET_VERSION]: '2026-08-23T00:00:00.000Z' },
      }]),
      dependencies: JSON.stringify([{ '@deepseek-ai/dsh-agent-presets': '0.1.2-alpha.5' }]),
      hostVersion: 'dsh 0.1.2-alpha.4',
    })
    expect(await world.run(command)).toEqual({ kind: 'success' })
    expect(overlayRows(world.ctx)).toContain('npm i -g @deepseek-ai/dsh@0.1.2-alpha.5')
    expect(world.spawns.filter(call => call.cmd === 'npm').map(call => call.args)).toEqual([
      ['view', '@ephemeral-ai/mayfly', '--json'],
      ['view', `@ephemeral-ai/mayfly@${TARGET_VERSION}`, 'dependencies', '--json'],
    ])
    expect(world.spawns.some(call => call.args[0] === 'plugin')).toBe(false)
    world.dispose()
  })

  it('blocks inside the cooldown window with the ETA on the panel', async () => {
    const world = await mountWorld({
      packument: packumentJson({ channelTag: TARGET_VERSION, time: { [TARGET_VERSION]: '2026-08-24T23:00:00.000Z' } }),
    })
    const result = await world.run()
    expect(result).toEqual({ kind: 'success' })
    const rows = overlayRows(world.ctx)
    expect(rows).toContain('minimumReleaseAge')
    expect(rows).toContain('2026-08-25 23:00')
    world.dispose()
  })

  it('follows the settings channel when one is configured', async () => {
    const world = await mountWorld()
    class MemorySettings extends SettingsProvider {
      readonly writable = true
      private doc: Record<string, unknown> = {}
      protected async load(): Promise<Record<string, unknown>> {
        return this.doc
      }
      protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
        this.doc[String(ns)] = section
      }
    }
    const settings = new MemorySettings(world.ctx)
    settingsPlugin.apply(world.ctx)
    updateCheck.apply(world.ctx)
    await new Promise(resolve => setTimeout(resolve, 5))
    await settings.update('mayfly', { updateChannel: 'beta' })
    await new Promise(resolve => setTimeout(resolve, 5))
    const result = await world.run()
    if (result?.kind === 'error') expect(result.text).toContain('no "beta" tag')
    else throw new Error('expected error')
    world.dispose()
  })
})

describe('/update confirm and swap', () => {
  it('updates end to end after selecting Yes', async () => {
    const world = await mountWorld()
    // A default-model service gives the boot smoke its marker (the
    // degraded no-marker path is the swap spec's territory).
    world.ctx.provide('agentDefaultModel', { currentSelection: () => ({ model: 'deepseek-chat marker', provider: 'x' }) })
    const pending = world.ctx.commands.execute(world.agent, '/update', [], new AbortController().signal)
    const overlay = await world.waitOverlay()
    const form = overlay as { handleInput(data: string): void, render(width: number): string[] }
    // The subtitle carries the publish age and host line.
    expect(form.render(100).join('\n')).toContain('published')
    form.handleInput(KEY.left)
    form.handleInput(KEY.enter)
    const execution = await pending
    expect(execution?.result?.kind).toBe('success')
    if (execution?.result?.kind === 'success') expect(execution.result.text).toContain('restart dsh to apply')
    // The install was one exact-version transaction.
    const install = world.spawns.find(call => call.args[0] === 'plugin')
    expect(install?.args).toEqual(['plugin', '--profile', 'mayfly', 'add', `@ephemeral-ai/mayfly@${TARGET_VERSION}`])
    // The boot check stops offering what this session installed.
    const state = updaterInternals.readTextFile(join(world.home, '.dsh', 'storages', 'mayfly-update', 'state.json'))
    expect(state).toContain(`"lastNotifiedVersion": "${TARGET_VERSION}"`)
    // The progress panel stays readable; Esc closes it through the bound
    // restore path.
    const progress = await world.waitSurface('mayfly.update.progress')
    progress.requestClose()
    await flushUpdate()
    expect(progress.disposed).toBe(true)
    world.dispose()
  })

  it.each(['object', 'array'])('cancels cleanly after reading npm results as an %s', async format => {
    const document = {
      'dist-tags': { latest: TARGET_VERSION },
      versions: [CURRENT_VERSION, TARGET_VERSION],
      time: { [TARGET_VERSION]: '2026-08-23T00:00:00.000Z' },
    }
    const dependencies = { '@deepseek-ai/dsh-agent-presets': '0.1.1-rc.2' }
    const world = await mountWorld({
      packument: JSON.stringify(format === 'array' ? [document] : document),
      dependencies: JSON.stringify(format === 'array' ? [dependencies] : dependencies),
    })
    const pending = world.ctx.commands.execute(world.agent, '/update', [], new AbortController().signal)
    const overlay = await world.waitOverlay()
    ;(overlay as { handleInput(data: string): void }).handleInput(KEY.escape)
    const execution = await pending
    expect(execution?.result).toEqual({ kind: 'success', text: 'update cancelled' })
    expect(world.spawns.some(call => call.args[0] === 'plugin')).toBe(false)
    world.dispose()
  })

  it('selects No by default and never installs after cancellation', async () => {
    const world = await mountWorld()
    const pending = world.ctx.commands.execute(world.agent, '/update', [], new AbortController().signal)
    const overlay = await world.waitOverlay()
    const form = overlay as { handleInput(data: string): void, render(width: number): string[] }
    expect(form.render(100).join('\n')).toContain('Yes')
    expect(form.render(100).join('\n')).toContain('No')
    form.handleInput(KEY.enter)
    const execution = await pending
    expect(execution?.result).toEqual({ kind: 'success', text: 'update cancelled' })
    expect(world.spawns.some(call => call.args[0] === 'plugin')).toBe(false)
    world.dispose()
  })

  it('returns the rollback outcome when the install fails', async () => {
    const world = await mountWorld({
      installBehavior: specs => {
        if (specs[0]?.endsWith(`@${TARGET_VERSION}`) === true) {
          return { code: 1, signal: null, stdout: '', stderr: 'ERR_PNPM minimumReleaseAge refused', timedOut: false }
        }
        world.installAt(CURRENT_VERSION)
        return ok()
      },
    })
    const pending = world.ctx.commands.execute(world.agent, '/update', [], new AbortController().signal)
    const overlay = await world.waitOverlay()
    const form = overlay as { handleInput(data: string): void }
    form.handleInput(KEY.left)
    form.handleInput(KEY.enter)
    const execution = await pending
    // The result line stays a short summary; the panel carries the recipe.
    expect(execution?.result).toEqual({ kind: 'error', text: `update failed — rolled back to v${CURRENT_VERSION}` })
    const rows = overlayRows(world.ctx)
    expect(rows).toContain('cooldown window')
    expect(rows).toContain(`rolled back to ${CURRENT_VERSION}`)
    world.dispose()
  })

  it('reports the recipe-in-panel summary when the rollback itself fails', async () => {
    const world = await mountWorld({
      installBehavior: () => ({ code: 1, signal: null, stdout: '', stderr: 'ERR_PNPM broken', timedOut: false }),
    })
    const pending = world.ctx.commands.execute(world.agent, '/update', [], new AbortController().signal)
    const overlay = await world.waitOverlay()
    const form = overlay as { handleInput(data: string): void }
    form.handleInput(KEY.left)
    form.handleInput(KEY.enter)
    const execution = await pending
    expect(execution?.result).toEqual({ kind: 'error', text: 'update failed — the repair recipe is in the update panel' })
    expect(overlayRows(world.ctx)).toContain('manual repair')
    world.dispose()
  })

  it('shows the hours form of the publish age outside the window', async () => {
    const world = await mountWorld({
      packument: packumentJson({ channelTag: TARGET_VERSION, time: { [TARGET_VERSION]: '2026-08-24T19:00:00.000Z' } }),
      cooldownProbe: '60',
    })
    const pending = world.ctx.commands.execute(world.agent, '/update', [], new AbortController().signal)
    const overlay = await world.waitOverlay()
    const form = overlay as { handleInput(data: string): void, render(width: number): string[] }
    expect(form.render(100).join('\n')).toContain('published 5h ago')
    form.handleInput(KEY.escape)
    await pending
    world.dispose()
  })

  it('carries a newer-minor host warning into the confirm subtitle', async () => {
    const world = await mountWorld({
      hostVersion: 'dsh 0.2.0',
      cooldownProbe: '60',
    })
    const pending = world.ctx.commands.execute(world.agent, '/update', [], new AbortController().signal)
    const overlay = await world.waitOverlay()
    const form = overlay as { handleInput(data: string): void, render(width: number): string[] }
    const subtitle = form.render(120).join('\n')
    expect(subtitle).toContain('different major/minor')
    expect(subtitle).toContain('dsh 0.2.0')
    form.handleInput(KEY.escape)
    await pending
    world.dispose()
  })

  it('relays the unprobeable-host and unknown-publish-time warnings into the subtitle', async () => {
    // No publish time for the target and an unreadable host probe: both
    // gates warn instead of blocking, and the warnings ride the subtitle.
    const noTimePackument = JSON.stringify({
      'dist-tags': { latest: TARGET_VERSION },
      versions: {
        [CURRENT_VERSION]: { dependencies: { '@deepseek-ai/dsh-agent-presets': '0.1.1-rc.2' } },
        [AHEAD_VERSION]: { dependencies: { '@deepseek-ai/dsh-agent-presets': '0.1.1-rc.2' } },
        [TARGET_VERSION]: { dependencies: { '@deepseek-ai/dsh-agent-presets': '0.1.1-rc.2' } },
      },
      time: { [CURRENT_VERSION]: '2026-08-20T00:00:00.000Z' },
    })
    const world = await mountWorld({ packument: noTimePackument })
    updaterInternals.spawnOnce = ((cmd: string, args: readonly string[]) => {
      if (args[0] === '--version') {
        return Promise.resolve({ code: 1, signal: null, stdout: '', stderr: '', timedOut: false })
      }
      if (cmd === 'npm') return Promise.resolve({ ...ok(), stdout: noTimePackument })
      if (cmd === 'pnpm') return Promise.resolve({ ...ok(), stdout: '60\n' })
      if (args[0] === 'plugin') {
        world.installAt(CURRENT_VERSION)
        return Promise.resolve(ok())
      }
      return Promise.resolve(ok())
    }) as typeof updaterInternals.spawnOnce
    const pending = world.ctx.commands.execute(world.agent, '/update', [], new AbortController().signal)
    const overlay = await world.waitOverlay()
    const form = overlay as { handleInput(data: string): void, render(width: number): string[] }
    // Both warnings ride the one subtitle line; render wide enough that
    // the panel does not truncate the second one away.
    const subtitle = form.render(240).join('\n')
    expect(subtitle).toContain(`v${CURRENT_VERSION} → v${TARGET_VERSION}`)
    expect(subtitle).toContain('could not determine the installed dsh CLI version')
    expect(subtitle).toContain('publish time unknown')
    expect(subtitle).not.toContain('h ago')
    form.handleInput(KEY.escape)
    await pending
    world.dispose()
  })

  it('treats a missing pnpm probe as the default window', async () => {
    const world = await mountWorld({
      cooldownProbe: 'missing',
      packument: packumentJson({ channelTag: TARGET_VERSION, time: { [TARGET_VERSION]: '2026-08-24T23:00:00.000Z' } }),
    })
    const result = await world.run()
    expect(result).toEqual({ kind: 'success' })
    expect(overlayRows(world.ctx)).toContain('minimumReleaseAge')
    world.dispose()
  })

  it('treats a failing or blank pnpm probe as the default window', async () => {
    for (const probe of ['fail', 'blank'] as const) {
      const world = await mountWorld({
        cooldownProbe: probe,
      packument: packumentJson({ channelTag: TARGET_VERSION, time: { [TARGET_VERSION]: '2026-08-24T23:00:00.000Z' } }),
      })
      const result = await world.run()
      expect(result, probe).toEqual({ kind: 'success' })
      expect(overlayRows(world.ctx), probe).toContain('minimumReleaseAge')
      world.dispose()
    }
  })

  it('refuses a second concurrent run and releases the guard after settle', async () => {
    const world = await mountWorld()
    const pending = world.ctx.commands.execute(world.agent, '/update', [], new AbortController().signal)
    const confirmation = await world.waitSurface('mayfly.update.confirm')
    // While the first run parks at the confirm form, a second /update is refused.
    const second = await world.run()
    expect(second).toEqual({ kind: 'error', text: 'an update is already in progress' })
    confirmation.requestClose()
    const execution = await pending
    expect(execution?.result).toEqual({ kind: 'success', text: 'update cancelled' })
    expect(confirmation.disposed).toBe(true)
    // The guard released with the settle: a third run reaches the confirm again.
    const third = world.ctx.commands.execute(world.agent, '/update', [], new AbortController().signal)
    const next = await world.waitSurface('mayfly.update.confirm')
    expect(next).not.toBe(confirmation)
    next.requestClose()
    const thirdExecution = await third
    expect(thirdExecution?.result).toEqual({ kind: 'success', text: 'update cancelled' })
    world.dispose()
  })

  it('settles confirmation cancellation when its registry entry is closed', async () => {
    const world = await mountWorld()
    const pending = world.ctx.commands.execute(world.agent, '/update', [], new AbortController().signal)
    await world.waitSurface('mayfly.update.confirm')
    expect(world.ctx.mayflyOverlays.close('mayfly.update.confirm')).toBe(true)
    await expect(pending).resolves.toMatchObject({ result: { kind: 'success', text: 'update cancelled' } })
    const retry = world.ctx.commands.execute(world.agent, '/update', [], new AbortController().signal)
    const confirmation = await world.waitSurface('mayfly.update.confirm')
    confirmation.requestClose()
    await expect(retry).resolves.toMatchObject({ result: { kind: 'success', text: 'update cancelled' } })
    world.dispose()
  })

  it('settles confirmation cancellation when its owning context unloads', async () => {
    const world = await mountWorld()
    const pending = world.ctx.commands.execute(world.agent, '/update', [], new AbortController().signal)
    await world.waitSurface('mayfly.update.confirm')
    await world.ctx.fiber.dispose()
    await expect(pending).resolves.toMatchObject({ result: { kind: 'success', text: 'update cancelled' } })
  })

  it('ignores unrelated confirmation and progress events and settles confirmation once', async () => {
    const world = await mountWorld()
    const pending = world.ctx.commands.execute(world.agent, '/update', [], new AbortController().signal)
    await world.waitSurface('mayfly.update.confirm')
    const confirmation = world.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.update.confirm')!
    const context = { surfaceId: confirmation.id, operationId: 'direct', source: confirmation.source, revision: confirmation.revision, signal: new AbortController().signal, report: vi.fn() }
    expect(await confirmation.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'noop', actionId: 'noop' }, context)).toEqual({ kind: 'completed' })
    const decline = { kind: 'activate' as const, pagePath: [], controlId: 'update-confirm-actions', actionId: 'no' }
    expect(await confirmation.definition.onEvent!.action!(decline, context)).toEqual({ kind: 'completed', dismiss: true })
    expect(await confirmation.definition.onEvent!.action!(decline, context)).toEqual({ kind: 'completed', dismiss: true })
    await expect(pending).resolves.toMatchObject({ result: { kind: 'success', text: 'update cancelled' } })
    world.ctx.mayflyOverlays.close(confirmation.id)

    const next = world.ctx.commands.execute(world.agent, '/update', [], new AbortController().signal)
    const model = await world.waitSurface('mayfly.update.confirm')
    model.invoke('yes')
    const progress = await world.waitSurface('mayfly.update.progress')
    const progressEntry = world.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.update.progress')!
    const progressContext = { ...context, surfaceId: progressEntry.id, source: progressEntry.source, revision: progressEntry.revision }
    expect(await progressEntry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'noop', actionId: 'noop' }, progressContext)).toEqual({ kind: 'completed' })
    await next
    progress.requestClose()
    world.dispose()
  })

  it('settles a confirmation closed during initial publication', async () => {
    const world = await mountWorld()
    world.ctx.mayflyOverlays.subscribe(delta => { if (delta.kind === 'upsert' && delta.entry.id === 'mayfly.update.confirm') world.ctx.mayflyOverlays.close(delta.entry.id) })
    const pending = world.ctx.commands.execute(world.agent, '/update', [], new AbortController().signal)
    await expect(pending).resolves.toMatchObject({ result: { kind: 'success', text: 'update cancelled' } })
    world.dispose()
  })

  it('keeps the progress surface open while the swap runs and closes it after settlement', async () => {
    const world = await mountWorld()
    const release = Promise.withResolvers<void>()
    const spawn = updaterInternals.spawnOnce
    updaterInternals.spawnOnce = ((cmd: string, args: readonly string[], options?: { cwd?: string, timeoutMs?: number }) => {
      if (args[0] !== 'plugin') return spawn(cmd, args, options)
      return release.promise.then(() => spawn(cmd, args, options))
    }) as typeof updaterInternals.spawnOnce
    const pending = world.ctx.commands.execute(world.agent, '/update', [], new AbortController().signal)
    const confirmation = await world.waitSurface('mayfly.update.confirm')
    confirmation.invoke('yes')
    const progress = await world.waitSurface('mayfly.update.progress')
    progress.requestClose()
    await flushUpdate()
    expect(progress.disposed).toBe(false)
    expect(progress.feedbackSnapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'error', message: 'The update is still running' }),
    ]))
    release.resolve()
    await expect(pending).resolves.toMatchObject({ result: { kind: 'success' } })
    progress.requestClose()
    await flushUpdate()
    expect(progress.disposed).toBe(true)
    world.dispose()
  })

  it('settles the panel when the swap itself throws', async () => {
    const world = await mountWorld()
    // The snapshot's atomic rename dying (ENOSPC class) must not strand an
    // unsettled panel — it refuses to close mid-swap by design.
    updaterInternals.rename = () => {
      throw new Error('ENOSPC: no space left on device')
    }
    const pending = world.ctx.commands.execute(world.agent, '/update', [], new AbortController().signal)
    const overlay = await world.waitOverlay()
    const form = overlay as { handleInput(data: string): void }
    form.handleInput(KEY.left)
    form.handleInput(KEY.enter)
    const execution = await pending
    expect(execution?.result).toEqual({ kind: 'error', text: 'update failed — the repair recipe is in the update panel' })
    const rows = overlayRows(world.ctx)
    expect(rows).toContain('the swap crashed')
    expect(rows).toContain('ENOSPC')
    expect(rows).toContain('the snapshot is at')
    const progress = await world.waitSurface('mayfly.update.progress')
    progress.requestClose()
    await flushUpdate()
    expect(progress.disposed).toBe(true)
    world.dispose()
  })

  it('settles the panel with a stringified message when the throw is not an Error', async () => {
    const world = await mountWorld()
    updaterInternals.rename = () => {
      throw 'disk full'
    }
    const pending = world.ctx.commands.execute(world.agent, '/update', [], new AbortController().signal)
    const overlay = await world.waitOverlay()
    const form = overlay as { handleInput(data: string): void }
    form.handleInput(KEY.left)
    form.handleInput(KEY.enter)
    const execution = await pending
    expect(execution?.result).toEqual({ kind: 'error', text: 'update failed — the repair recipe is in the update panel' })
    expect(overlayRows(world.ctx)).toContain('the swap crashed: disk full')
    const progress = await world.waitSurface('mayfly.update.progress')
    progress.requestClose()
    world.dispose()
  })

  it('flashes the registry-check progress and retry notices in the hint line', async () => {
    const world = await mountWorld()
    const notices: string[] = []
    const off = world.ctx.mayflyUiInteraction.subscribe(() => {
      const message = world.ctx.mayflyUiInteraction.notificationSnapshot().find(item => item.operationId === 'registry')?.message
      if (message !== undefined && notices.at(-1) !== message) notices.push(message)
    })
    const stub = updaterInternals.spawnOnce
    let npmFailures = 2
    updaterInternals.spawnOnce = ((cmd: string, args: readonly string[], opts?: { cwd?: string; timeoutMs?: number }) => {
      if (cmd === 'npm' && npmFailures > 0) {
        npmFailures -= 1
        return Promise.resolve({ code: 1, signal: null, stdout: '', stderr: 'ETIMEDOUT', timedOut: false })
      }
      return stub(cmd, args, opts)
    }) as typeof updaterInternals.spawnOnce
    const pending = world.ctx.commands.execute(world.agent, '/update', [], new AbortController().signal)
    const overlay = await world.waitOverlay()
    expect(notices).toContain('checking the registry for @ephemeral-ai/mayfly updates…')
    expect(notices).toContain('registry unreachable, retrying (2/3)…')
    expect(notices).toContain('registry unreachable, retrying (3/3)…')
    ;(overlay as { handleInput(data: string): void }).handleInput(KEY.escape)
    await pending
    off()
    world.dispose()
  })

  it('falls back to the latest channel when the settings channel is blank', async () => {
    const world = await mountWorld()
    class MemorySettings extends SettingsProvider {
      readonly writable = true
      private doc: Record<string, unknown> = {}
      protected async load(): Promise<Record<string, unknown>> {
        return this.doc
      }
      protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
        this.doc[String(ns)] = section
      }
    }
    const settings = new MemorySettings(world.ctx)
    // apply() registers the 'mayfly' settings namespace; the boot check's
    // notice mounts as a dock child, never an overlay, so it cannot race
    // the confirm form below.
    settingsPlugin.apply(world.ctx)
    updateCheck.apply(world.ctx)
    await new Promise(resolve => setTimeout(resolve, 5))
    await settings.update('mayfly', { updateChannel: '' })
    await new Promise(resolve => setTimeout(resolve, 5))
    const pending = world.ctx.commands.execute(world.agent, '/update', [], new AbortController().signal)
    const overlay = await world.waitOverlay()
    ;(overlay as { handleInput(data: string): void }).handleInput(KEY.escape)
    const execution = await pending
    expect(execution?.result).toEqual({ kind: 'success', text: 'update cancelled' })
    world.dispose()
  })

  it('proceeds when no session is current', async () => {
    const world = await mountWorld({ sessionCurrent: 'null' })
    const pending = world.ctx.commands.execute(world.agent, '/update', [], new AbortController().signal)
    const overlay = await world.waitOverlay()
    ;(overlay as { handleInput(data: string): void }).handleInput(KEY.escape)
    const execution = await pending
    expect(execution?.result).toEqual({ kind: 'success', text: 'update cancelled' })
    world.dispose()
  })

  it('a downgrade target reinstalls the main package in one transaction', async () => {
    const world = await mountWorld()
    // Move the profile ahead of the target to exercise a downgrade.
    rmSync(join(world.root, 'node_modules', '@ephemeral-ai'), { recursive: true, force: true })
    world.installAt(AHEAD_VERSION)
    const manifest = JSON.parse(String(updaterInternals.readTextFile(join(world.root, 'package.json')))) as Record<string, unknown>
    manifest.dependencies = { '@ephemeral-ai/mayfly': AHEAD_VERSION }
    updaterInternals.writeTextFile(join(world.root, 'package.json'), JSON.stringify(manifest))
    world.ctx.provide('agentDefaultModel', { currentSelection: () => ({ model: 'deepseek-chat marker', provider: 'x' }) })
    const pending = world.ctx.commands.execute(world.agent, `/update ${TARGET_VERSION}`, [], new AbortController().signal)
    const overlay = await world.waitOverlay()
    const form = overlay as { handleInput(data: string): void, render(width: number): string[] }
    // The downgrade warning rides the subtitle's tail; render wide enough
    // that the publish-age and host-line parts do not truncate it away.
    expect(form.render(260).join('\n')).toContain('downgrade reinstalls @ephemeral-ai/mayfly')
    form.handleInput(KEY.left)
    form.handleInput(KEY.enter)
    const execution = await pending
    expect(execution?.result?.kind).toBe('success')
    const install = world.spawns.find(call => call.args[0] === 'plugin')
    expect(install?.args).toEqual(['plugin', '--profile', 'mayfly', 'add', `${RC2_NAMES[0]}@${TARGET_VERSION}`])
    const progress = await world.waitSurface('mayfly.update.progress')
    progress.requestClose()
    world.dispose()
  })

  it('rolls back the main package when the registry does not know the old release', async () => {
    // The npm-view packument shape: versions are bare strings, so every
    // per-release deps block rides the targeted query — which here answers
    // nothing useful, leaving the from-release a one-member set and the
    // rollback set the discovered install.
    const npmViewPackument = JSON.stringify({
      'dist-tags': { latest: TARGET_VERSION },
      versions: [CURRENT_VERSION, AHEAD_VERSION, TARGET_VERSION],
      time: { [CURRENT_VERSION]: '2026-08-20T00:00:00.000Z', [TARGET_VERSION]: '2026-08-23T00:00:00.000Z' },
    })
    const world = await mountWorld({
      packument: npmViewPackument,
      installBehavior: specs => {
        if (specs[0]?.endsWith(`@${TARGET_VERSION}`) === true) {
          return { code: 1, signal: null, stdout: '', stderr: 'ERR_PNPM broken', timedOut: false }
        }
        world.installAt(CURRENT_VERSION)
        return ok()
      },
    })
    world.ctx.provide('agentDefaultModel', { currentSelection: () => ({ model: 'deepseek-chat marker', provider: 'x' }) })
    const pending = world.ctx.commands.execute(world.agent, '/update', [], new AbortController().signal)
    const overlay = await world.waitOverlay()
    const form = overlay as { handleInput(data: string): void }
    form.handleInput(KEY.left)
    form.handleInput(KEY.enter)
    const execution = await pending
    expect(execution?.result).toEqual({ kind: 'error', text: `update failed — rolled back to v${CURRENT_VERSION}` })
    const reinstall = world.spawns.filter(call => call.args[0] === 'plugin').at(-1)
    expect(reinstall?.args.slice(4)).toEqual([`@ephemeral-ai/mayfly@${CURRENT_VERSION}`])
    world.dispose()
  })
})

/** Strip the fake theme's paint markers and any ANSI for row asserts. */
const plain = (rows: readonly string[]): string =>
  rows.join('\n').replace(/[\^_!]/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

/** The last overlay's rendered rows, cleaned, if one is mounted. */
function overlayRows(ctx: Context): string {
  const entry = ctx.mayflyOverlays.list().at(-1)
  const model = entry === undefined ? undefined : ctx.mayflyUiInteraction.get('overlay', entry.id)
  if (model === undefined) return ''
  const renderer = renderRequest(model, { columns: 120, rows: 24 })
  try { return plain(renderer.component.render(120)) } finally { renderer.runtime.dispose() }
}

describe('update panel model', () => {
  async function mount(state = createUpdateProgressState()) {
    const { ctx } = fakeMayflyContext()
    const interaction = new UiInteractionService(ctx)
    mountUiRegistryObservers(ctx)
    await flushUpdate()
    const view = () => updatePanelModel(state, '0.1.0-rc.6', '0.1.0-rc.7')
    const handle = ctx.mayflyOverlays.open({
      id: 'update-model', capturing: true, dismissal: 'discard', scope: { kind: 'app', targetId: 'update-model' },
      onEvent: { action: event => event.kind === 'dismiss'
        ? state.outcome === undefined && state.blockedMessage === undefined
          ? { kind: 'failed', message: 'The update is still running' }
          : { kind: 'completed', dismiss: true }
        : { kind: 'completed' } },
    }, view())
    const model = ctx.mayflyUiInteraction.get('overlay', 'update-model')!
    const publish = () => handle.set(view())
    const rows = (width = 80) => {
      const renderer = renderRequest(model, { columns: width, rows: 24 })
      try { return plain(renderer.component.render(width)) } finally { renderer.runtime.dispose() }
    }
    return { ctx, interaction, state, handle, model, publish, rows }
  }

  it('renders the step ladder, refuses close mid-swap, and closes after settle', async () => {
    const { state, model, publish, rows } = await mount()
    expect(updatePanelSummary(state)).toBe('update panel closed')
    applyUpdateProgress(state, { step: 'snapshot', state: 'ok' })
    applyUpdateProgress(state, { step: 'install', state: 'start' })
    publish()
    model.requestClose()
    await flushUpdate()
    expect(model.disposed).toBe(false)
    expect(model.feedbackSnapshot()).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', message: 'The update is still running' })]))
    expect(model.availableActions()).toEqual(expect.arrayContaining([expect.objectContaining({ actionId: 'close', enabled: false, disabledReason: 'The update is still running' })]))
    let rendered = rows()
    expect(rendered).toContain('v0.1.0-rc.6 → v0.1.0-rc.7')
    expect(rendered).toContain('✓ snapshot')
    expect(rendered).toContain('… install')
    expect(rendered).not.toContain('rollback')
    state.outcome = {
      kind: 'success', fromVersion: '0.1.0-rc.6', toVersion: '0.1.0-rc.7',
      message: 'updated — restart dsh to apply', logPath: '/tmp/update.log',
    }
    publish()
    rendered = rows()
    expect(rendered).toContain('restart dsh to apply')
    expect(rendered).toContain('log: /tmp/update.log')
    model.requestClose()
    await flushUpdate()
    expect(model.disposed).toBe(true)
    expect(updatePanelSummary(state)).toContain('restart dsh to apply')
  })

  it('renders blocked and rollback outcomes and summarizes failures', async () => {
    const blocked = createUpdateProgressState()
    blocked.blockedMessage = 'the profile mixes link/file specs (@ephemeral-ai/mayfly)\nrepair the profile'
    expect(updatePanelModel(blocked, 'old', 'new')).toMatchObject({ kind: 'surface', title: 'Update Mayfly', chrome: 'overlay' })
    expect(JSON.stringify(updatePanelModel(blocked, 'old', 'new'))).toContain('repair the profile')
    expect(updatePanelSummary(blocked)).toContain('update blocked')

    const state = createUpdateProgressState()
    applyUpdateProgress(state, { step: 'smoke-boot', state: 'fail' })
    applyUpdateProgress(state, { step: 'rollback', state: 'ok' })
    state.outcome = {
      kind: 'rolled-back', fromVersion: '0.1.0-rc.6', toVersion: '0.1.0-rc.7',
      message: 'boot smoke failed; rolled back', logPath: '/tmp/update.log',
    }
    const mounted = await mount(state)
    const rendered = mounted.rows()
    expect(rendered).toContain('✗ smoke: boot')
    expect(rendered).toContain('✓ rollback')
    expect(updatePanelSummary(state)).toContain('did not complete')
    mounted.model.invoke('close')
    await flushUpdate()
    expect(mounted.model.disposed).toBe(true)
  })
})
