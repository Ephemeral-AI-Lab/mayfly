/**
 * Tests for the `mayfly-commands` plugin over the real command runtime:
 * `/quit` exit requests, `/sessions <id>` resume emission / `/new`/`/fork`
 * event emission, the `/sessions` picker overlay, the `/help` overlay, and
 * disposal.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as uiProvider from '../../../ui/src/provider.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import * as commandsPlugin from '../../src/interaction/commands-plugin.ts'
import { mountUiRegistryObservers, UiInteractionService } from '../../src/core/ui-interaction-state.ts'
import type { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import type {} from '../../src/app/index.ts'
import { fakeMayflyContext, KEY, type FakeMayflyComponents } from './fakes.ts'
import { InteractionStateService } from '../../src/interaction/runtime-state.ts'
import { DEFAULT_SETTINGS } from '../../src/interaction/settings.ts'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'
import { INTERACTION_LOCALE } from '../../src/interaction/locale.ts'
import { registerTempDirCleanup } from '../core/temp-dir.ts'
import { renderRequest } from './request-fixture.ts'

registerTempDirCleanup()
const roots: Context[] = []
afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await root.fiber.dispose()
})

async function mountInteractionOwner(ctx: Context): Promise<void> {
  await ctx.plugin({
    name: 'test-ui-interaction-owner',
    apply(owner: Context) {
      const service = new UiInteractionService(owner)
      owner.effect(() => () => service.dispose())
      mountUiRegistryObservers(owner)
    },
  })
  await Promise.resolve()
}

/** The structural slice of `sessionQuery` the `/sessions` titles read. */
interface TitleQueryFake {
  readTitleSnapshots(
    sessionIds: readonly { toString(): string }[],
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<
    | { sessionId: { toString(): string }, status: 'fulfilled', value: { title?: { title: string } } }
    | { sessionId: { toString(): string }, status: 'rejected', reason: unknown }
  >>
}

async function mount(options: {
  appExit?: (code: number) => void
  agentStatus?: 'idle' | 'running'
  attach?: boolean
  persistence?: { list(options?: { signal?: AbortSignal }): Promise<{ header: SessionHeader }[]> }
  sessionQuery?: TitleQueryFake
  locale?: 'en' | 'zh'
} = {}): Promise<{
  ctx: Context
  components: FakeMayflyComponents
  agent: Agent
  fiber: { dispose(): Promise<void> }
  locale: MayflyLocaleService | undefined
}> {
  const { ctx, components } = fakeMayflyContext()
  roots.push(ctx)
  const locale = options.locale === undefined
    ? undefined
    : new MayflyLocaleService(ctx, { systemLocale: options.locale })
  locale?.register('interaction', INTERACTION_LOCALE)
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  if (options.appExit !== undefined) ctx.provide('appExit', options.appExit)
  const session = ctx.sessions.create(SessionId('commands-spec'))
  const agent = { id: session.id, session, status: options.agentStatus ?? 'idle' } as unknown as Agent
  if (options.attach !== false) ctx.provide('testSession', { current: agent, modelRef: undefined })
  if (options.persistence !== undefined) {
    ctx.provide('sessionPersistence', options.persistence as unknown as SessionPersistence)
  }
  if (options.sessionQuery !== undefined) {
    ctx.provide('sessionQuery', options.sessionQuery as unknown as SessionQueryEngine)
  }
  await mountInteractionOwner(ctx)
  const fiber = await ctx.plugin(commandsPlugin)
  return { ctx, components, agent, fiber, locale }
}

const signal = (): AbortSignal => new AbortController().signal
const flushCommands = (): Promise<void> => new Promise(resolve => { setImmediate(resolve) })

/** Provide native command dependencies without mounting Mayfly display services. */
function provideAppBoundary(ctx: Context): void {
  const active = (): Agent | null => ctx.get('testSession')?.current ?? null
  ctx.provide('mayflyCurrentAgent', {
    current: active,
    primary: active,
    view: () => ({ primarySessionId: active() === null ? null : String(active()!.id), displayed: 'primary', auxiliary: null, revision: 0 }),
    revision: () => 0,
    closeAuxiliary: () => null,
    subscribe: (listener: (agent: Agent | null, revision: number) => void) => {
      listener(active(), 0)
      return () => {}
    },
  } as never)
  ctx.provide('mayflySkillsCatalog', {
    userInvocable: () => [],
    refresh: () => Promise.resolve(),
    setForTest: () => {},
  } as never)
  ctx.provide('sessionProjections', { snapshot: () => ({ asOfSeq: 0, values: {} }), onChanged: () => () => {} } as never)
  ctx.provide('sessionController', { selectModel: async () => { throw new Error('no session') } } as never)
  ctx.provide('tools', { schemas: () => [] } as never)
  ctx.provide('workspaceRegistry', { archivedSessionIds: [] } as never)
}

interface SurfaceDriver {
  readonly model: UiSurfaceModel
  readonly closed: boolean
  render(width: number): string[]
  handleInput(data: string): void
  invalidate(): void
}

const surfaceDrivers = new WeakMap<UiSurfaceModel, SurfaceDriver>()

/** Drive a registered overlay through the shared model and compiler. */
function overlay(ctx: Context, id?: string): SurfaceDriver {
  const entry = id === undefined
    ? ctx.mayflyOverlays.list().at(-1)
    : ctx.mayflyOverlays.list().find(candidate => candidate.id === id)
  if (entry === undefined) throw new Error('no overlay registered')
  const model = ctx.mayflyUiInteraction.get('overlay', entry.id)
  if (model === undefined) throw new Error('no overlay model')
  const existing = surfaceDrivers.get(model)
  if (existing !== undefined) return existing
  let width = 80
  let compiled = renderRequest(model)
  const runtime = compiled.runtime
  let renderedRevision = model.revision
  let renderedWidth = width
  const current = () => {
    if (renderedRevision !== model.revision || renderedWidth !== width) {
      compiled = renderRequest(model, { columns: width, rows: 24 }, runtime)
      renderedRevision = model.revision
      renderedWidth = width
    }
    return compiled
  }
  const driver: SurfaceDriver = {
    model,
    get closed() { return model.disposed },
    render(nextWidth) { width = nextWidth; return current().component.render(width) },
    handleInput(data) { current().input(data) },
    invalidate() { current().component.invalidate() },
  }
  surfaceDrivers.set(model, driver)
  return driver
}

describe('mayfly-commands plugin', () => {
  it('/quit requests exit through the launcher appExit hook', async () => {
    const exit = vi.fn()
    const { ctx, agent } = await mount({ appExit: exit })
    const execution = await ctx.commands.execute(agent, '/quit', [], signal())
    expect(exit).toHaveBeenCalledWith(0)
    expect(execution?.result).toEqual({ kind: 'success' })
  })

  it('/quit reports an error when the launcher provided no appExit', async () => {
    const { ctx, agent } = await mount()
    const execution = await ctx.commands.execute(agent, '/quit', [], signal())
    const result = execution?.result
    expect(result?.kind).toBe('error')
    if (result?.kind === 'error') expect(result.text).toContain('appExit')
  })

  it('/q and /exit are aliases of /quit, not registered commands (kimi style)', async () => {
    const { ctx, agent } = await mount({ appExit: () => {} })
    // The alias relation lives in the Mayfly-side metadata registry, and only
    // `/quit` is a real registration: the input layer rewrites an alias line
    // before dispatch, so the harness registry stays canonical-only.
    expect(ctx.mayflyInteractionState.aliases.canonicalOf('q')).toBe('quit')
    expect(ctx.mayflyInteractionState.aliases.canonicalOf('exit')).toBe('quit')
    expect(ctx.mayflyInteractionState.aliases.canonicalOf('quit')).toBeUndefined()
    expect(ctx.commands.find(agent, 'q')).toBeUndefined()
    expect(ctx.commands.find(agent, 'exit')).toBeUndefined()
    expect(await ctx.commands.execute(agent, '/q', [], signal())).toBeUndefined()
  })

  it('/mode runs the Shift+Tab plan cycle through the command surface', async () => {
    const { ctx, agent } = await mount()
    const execution = await ctx.commands.execute(agent, '/mode', [], signal())
    expect(execution?.result).toEqual({ kind: 'success' })
  })

  it('/sessions <id> emits mayfly/request-resume with the trimmed id', async () => {
    const { ctx, agent } = await mount()
    const onResume = vi.fn()
    ctx.on('mayfly/request-resume', onResume)
    const execution = await ctx.commands.execute(agent, '/sessions  abc-123 ', [], signal())
    expect(onResume).toHaveBeenCalledWith('abc-123')
    expect(execution?.result).toEqual({ kind: 'success', text: 'resuming session abc-123' })
  })

  it('/new emits mayfly/request-new', async () => {
    const { ctx, agent } = await mount()
    const onNew = vi.fn()
    ctx.on('mayfly/request-new', onNew)
    const execution = await ctx.commands.execute(agent, '/new', [], signal())
    expect(onNew).toHaveBeenCalledOnce()
    expect(onNew).toHaveBeenCalledWith(undefined)
    expect(execution?.result).toEqual({ kind: 'success', text: 'starting a new session' })
  })

  it('/new <preset> emits with the preset after roster validation', async () => {
    const { ctx, agent } = await mount()
    ctx.provide('agentPresets', { list: async () => [{ id: 'minimal', name: 'Minimal' }, { id: 'broken', broken: 'Invalid' }] } as never)
    const onNew = vi.fn()
    ctx.on('mayfly/request-new', onNew)
    const execution = await ctx.commands.execute(agent, '/new minimal', [], signal())
    expect(onNew).toHaveBeenCalledWith('minimal')
    expect(execution?.result).toEqual({ kind: 'success', text: 'starting a new session' })
  })

  it('/new refuses unknown and broken presets without emitting', async () => {
    const { ctx, agent } = await mount()
    ctx.provide('agentPresets', { list: async () => [{ id: 'minimal' }, { id: 'broken', broken: 'Invalid' }] } as never)
    const onNew = vi.fn()
    ctx.on('mayfly/request-new', onNew)
    expect(await ctx.commands.execute(agent, '/new bogus', [], signal())).toMatchObject({ result: { kind: 'error', text: 'unknown agent preset bogus' } })
    expect(await ctx.commands.execute(agent, '/new broken', [], signal())).toMatchObject({ result: { kind: 'error', text: 'unknown agent preset broken' } })
    expect(onNew).not.toHaveBeenCalled()
    // No roster mounted: no preset can be proven usable.
    const bare = await mount()
    const bareNew = vi.fn()
    bare.ctx.on('mayfly/request-new', bareNew)
    expect(await bare.ctx.commands.execute(bare.agent, '/new minimal', [], signal())).toMatchObject({ result: { kind: 'error' } })
    expect(bareNew).not.toHaveBeenCalled()
  })

  it('/new reports roster discovery failures as command errors', async () => {
    const { ctx, agent } = await mount()
    ctx.provide('agentPresets', { list: async () => { throw new Error('roster offline') } } as never)
    const onNew = vi.fn()
    ctx.on('mayfly/request-new', onNew)
    expect(await ctx.commands.execute(agent, '/new minimal', [], signal())).toMatchObject({ result: { kind: 'error', text: 'roster offline' } })
    expect(onNew).not.toHaveBeenCalled()
    const bare = await mount()
    bare.ctx.provide('agentPresets', { list: async () => { throw 'roster offline' } } as never)
    expect(await bare.ctx.commands.execute(bare.agent, '/new minimal', [], signal())).toMatchObject({ result: { kind: 'error', text: 'roster offline' } })
  })

  it('/new emits nothing when its signal aborts around validation', async () => {
    const { ctx, agent } = await mount()
    const onNew = vi.fn()
    ctx.on('mayfly/request-new', onNew)
    const command = ctx.commands.find(agent, 'new')!
    const aborted = new AbortController()
    aborted.abort()
    expect(await command.handler({ agent, rawInput: 'minimal', signal: aborted.signal } as never)).toEqual({ kind: 'success' })
    const during = new AbortController()
    ctx.provide('agentPresets', { list: async () => { during.abort(); return [{ id: 'minimal' }] } } as never)
    expect(await command.handler({ agent, rawInput: 'minimal', signal: during.signal } as never)).toEqual({ kind: 'success' })
    expect(onNew).not.toHaveBeenCalled()
  })

  it('/clear is the /new alias, not a registration', async () => {
    const { ctx, agent } = await mount()
    // The S27 alias relation: the input layer rewrites `/clear` to `/new`
    // before dispatch (kimi's one-command-two-names rule), so the harness
    // registry stays canonical-only and the session log records /new.
    expect(ctx.mayflyInteractionState.aliases.canonicalOf('clear')).toBe('new')
    expect(ctx.commands.find(agent, 'clear')).toBeUndefined()
    expect(await ctx.commands.execute(agent, '/clear', [], signal())).toBeUndefined()
    const onNew = vi.fn()
    ctx.on('mayfly/request-new', onNew)
    const rewritten = await ctx.commands.execute(agent, '/new', [], signal())
    expect(onNew).toHaveBeenCalledOnce()
    expect(rewritten?.result).toEqual({ kind: 'success', text: 'starting a new session' })
  })

  it('/fork emits mayfly/request-fork while the current session is idle', async () => {
    const { ctx, agent } = await mount()
    const onFork = vi.fn()
    ctx.on('mayfly/request-fork', onFork)
    const execution = await ctx.commands.execute(agent, '/fork', [], signal())
    expect(onFork).toHaveBeenCalledOnce()
    expect(execution?.result).toEqual({ kind: 'success', text: 'forking the current session' })
  })

  it('/fork refuses while the current session is running', async () => {
    const { ctx, agent } = await mount({ agentStatus: 'running' })
    const onFork = vi.fn()
    ctx.on('mayfly/request-fork', onFork)
    const execution = await ctx.commands.execute(agent, '/fork', [], signal())
    expect(onFork).not.toHaveBeenCalled()
    expect(execution?.result).toEqual({ kind: 'error', text: 'cannot fork while the agent is running' })
  })

  it('/fork still emits when no session is attached (the app layer refuses)', async () => {
    const { ctx, agent } = await mount({ attach: false })
    const onFork = vi.fn()
    ctx.on('mayfly/request-fork', onFork)
    const execution = await ctx.commands.execute(agent, '/fork', [], signal())
    expect(onFork).toHaveBeenCalledOnce()
    expect(execution?.result).toEqual({ kind: 'success', text: 'forking the current session' })
  })

  it('/rewind opens direct user turns and emits the selected safe boundary', async () => {
    const { ctx, agent } = await mount()
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'fix the login flow' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('assistant/message', {
      turn: 1,
      step: 0,
      message: {
        id: 'rewind-answer' as never,
        role: 'assistant',
        content: [{ type: 'text', text: 'login flow fixed' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      },
    }, { surfaceOp: 'append' })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    agent.session.append('turn/start', { turn: 2 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'second ask' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const onRewind = vi.fn()
    ctx.on('mayfly/request-rewind', onRewind)
    const execution = await ctx.commands.execute(agent, '/rewind', [], signal())
    expect(execution?.result).toEqual({ kind: 'success' })
    const opened = ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.rewind')!
    expect((await ctx.commands.execute(agent, '/rewind', [], signal()))?.result).toEqual({ kind: 'success' })
    expect(ctx.mayflyOverlays.list().find(entry => entry.id === opened.id)!.focusRevision).toBeGreaterThan(opened.focusRevision)
    const panel = overlay(ctx, 'mayfly.rewind')
    const rows = panel.render(100)
    expect(rows.some(row => row.includes('Rewind current session'))).toBe(true)
    expect(rows.some(row => row.includes('Turn 2 · second ask') && row.includes('rewinds 1 message'))).toBe(true)
    expect(rows.some(row => row.includes('Turn 1 · fix the login flow') && row.includes('login flow fixed') && row.includes('rewinds 3 messages'))).toBe(true)
    expect(rows.some(row => row.includes('The original session stays available'))).toBe(true)
    panel.handleInput(KEY.enter)
    await flushCommands()
    expect(onRewind).toHaveBeenCalledWith(String(agent.id), 4)
    expect(panel.closed).toBe(true)
  })

  it('/rewind handles unavailable, running, empty, and cancelled states', async () => {
    const detached = await mount({ attach: false })
    expect((await detached.ctx.commands.execute(detached.agent, '/rewind', [], signal()))?.result)
      .toEqual({ kind: 'error', text: 'no active session' })
    const running = await mount({ agentStatus: 'running' })
    expect((await running.ctx.commands.execute(running.agent, '/rewind', [], signal()))?.result)
      .toEqual({ kind: 'error', text: 'cannot rewind while the agent is running' })
    const empty = await mount()
    expect((await empty.ctx.commands.execute(empty.agent, '/rewind', [], signal()))?.result)
      .toEqual({ kind: 'success', text: 'no user turns to rewind' })
    empty.agent.session.append('turn/start', { turn: 1 })
    empty.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'cancel me' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await empty.ctx.commands.execute(empty.agent, '/rewind', [], signal())
    const panel = overlay(empty.ctx, 'mayfly.rewind')
    panel.handleInput(KEY.escape)
    await flushCommands()
    expect(panel.closed).toBe(true)
  })

  it('/help lists the registered commands and key bindings in an overlay', async () => {
    const { ctx, agent } = await mount()
    const execution = await ctx.commands.execute(agent, '/help', [], signal())
    expect(execution?.result).toEqual({ kind: 'success' })
    const opened = ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.help')!
    expect((await ctx.commands.execute(agent, '/help', [], signal()))?.result).toEqual({ kind: 'success' })
    expect(ctx.mayflyOverlays.list().find(entry => entry.id === opened.id)!.focusRevision).toBeGreaterThan(opened.focusRevision)
    // The canonical Help surface owns chrome and semantic rows. The sections
    // overflow the window, so a `showing` line replaces the tail.
    const panel = overlay(ctx, 'mayfly.help')
    const rows = panel.render(80)
    expect(rows.join('\n')).toContain('help')
    expect(rows.join('\n')).toContain('Commands')
    expect(rows.join('\n')).toContain('/plugin')
    expect(rows.join('\n')).toContain('/update')
    expect(rows.join('\n')).toContain('/effort (/thinking)')
    expect(rows.join('\n')).toContain('/mode')
    expect(rows.some(row => row.includes('Keys'))).toBe(true)
    // The command roster grew past the first window; scroll down to the
    // Keys rows the window no longer shows on the first paint.
    for (let i = 0; i < 5; i += 1) panel.handleInput(KEY.down)
    expect(panel.render(80).some(row => row.includes('enter') && row.includes('Submit input'))).toBe(true)
    panel.invalidate()
    panel.handleInput(KEY.escape)
    await flushCommands()
    expect(panel.closed).toBe(true)
  })

  it('/help handles no current Agent', async () => {
    const { ctx, agent } = await mount()
    ;(ctx.get('testSession') as { current: Agent | null }).current = null
    await ctx.commands.execute(agent, '/help', [], signal())
    const panel = overlay(ctx, 'mayfly.help')
    expect(panel.render(80).join('\n')).toContain('Keys')
    panel.handleInput(KEY.escape)
  })

  it('/help switches language in place while preserving the open overlay', async () => {
    const { ctx, agent, locale } = await mount({ locale: 'en' })
    await ctx.commands.execute(agent, '/help', [], signal())
    const open = overlay(ctx, 'mayfly.help')
    expect(open.render(80).join('\n')).toContain('Commands')
    open.handleInput(KEY.down)

    locale!.setPreference('zh')
    const localized = open.render(80).join('\n')
    expect(localized).toContain('帮助')
    expect(localized).toContain('命令')
    expect(localized).toContain('浏览、安装与管理插件')
    open.handleInput(KEY.escape)
  })

  it('/help falls back to the action id when a binding has no description', async () => {
    const { ctx, agent } = await mount()
    const keymap = ctx.get('mayflyKeymap')
    const unregister = keymap?.register([{ id: 'spec.custom', keys: 'f9' }])
    await ctx.commands.execute(agent, '/help', [], signal())
    // The f9 row is the last key binding, beyond the first window; extra
    // Downs clamp at the scroll floor; use a generous count so additions to
    // the command/key roster do not hide the final binding.
    const panel = overlay(ctx, 'mayfly.help')
    panel.render(80)
    for (let i = 0; i < 50; i += 1) panel.handleInput(KEY.down)
    const rows = panel.render(80)
    expect(rows.join('\n')).toContain('f9')
    expect(rows.join('\n')).toContain('spec.custom')
    unregister?.()
    panel.handleInput(KEY.escape)
  })

  it('/help closes on Escape while unrelated input is ignored', async () => {
    const { ctx, agent } = await mount()
    await ctx.commands.execute(agent, '/help', [], signal())
    const panel = overlay(ctx, 'mayfly.help')
    panel.handleInput('x')
    expect(panel.closed).toBe(false)
    panel.handleInput(KEY.escape)
    await flushCommands()
    expect(panel.closed).toBe(true)
  })

  it('/help truncates rows to the render width', async () => {
    const { ctx, components, agent } = await mount()
    await ctx.commands.execute(agent, '/help', [], signal())
    const panel = overlay(ctx, 'mayfly.help')
    const rows = panel.render(10)
    // The overlay's own truncation (headings, two-column rows, and the
    // showing tail) keeps every content row inside the width; the frame's
    // title and rules are width-exact by construction. The fake theme's
    // markers add two columns per styled row, so the invariant allows the
    // inflation (the real theme's SGR is zero-width).
    expect(rows.slice(2, -1).every(row => components.visibleWidth(row) <= 12)).toBe(true)
    panel.handleInput(KEY.escape)
  })

  it('/help reports the missing keymap without requiring renderer services', async () => {
    const ctx = new Context()
    roots.push(ctx)
    new InteractionStateService(ctx, DEFAULT_SETTINGS)
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    const session = ctx.sessions.create(SessionId('commands-bare-help'))
    const agent = { id: session.id, session } as unknown as Agent
    provideAppBoundary(ctx)
    await ctx.plugin(uiProvider)
    await mountInteractionOwner(ctx)
    await ctx.plugin(commandsPlugin)
    const execution = await ctx.commands.execute(agent, '/help', [], signal())
    expect(execution?.result).toEqual({
      kind: 'error',
      text: 'help is unavailable: the Mayfly keymap is not mounted',
    })
  })

  it('unregisters every command when the fiber disposes', async () => {
    const { ctx, agent, fiber } = await mount({ appExit: () => {} })
    for (const name of ['quit', 'new', 'fork', 'sessions', 'help', 'theme', 'mode']) {
      expect(ctx.commands.find(agent, name)).toBeDefined()
    }
    await fiber.dispose()
    for (const name of ['quit', 'new', 'fork', 'sessions', 'help', 'theme', 'mode']) {
      expect(ctx.commands.find(agent, name)).toBeUndefined()
    }
    // The alias metadata follows the fiber: the relation is gone too, so a
    // later mount can re-register it without tripping the conflict guard.
    expect(ctx.mayflyInteractionState.aliases.canonicalOf('q')).toBeUndefined()
    expect(ctx.mayflyInteractionState.aliases.canonicalOf('exit')).toBeUndefined()
  })

})
it('opens the native session browser from the bare sessions command', async () => {
  const bench = await mount()
  Object.assign(bench.ctx.sessionController, { list: async () => ({ items: [] }) })
  const result = await bench.ctx.commands.execute(bench.agent, '/sessions', [], signal())
  expect(result?.result).toEqual({ kind: 'success' })
  expect(bench.ctx.mayflyOverlays.list().some(item => item.id === 'mayfly.sessions')).toBe(true)
})
