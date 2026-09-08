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
import type { SessionHeader } from '@deepseek-ai/dsh-session'
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
  persistence?: { list(signal?: AbortSignal): Promise<SessionHeader[]> }
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
}

/** The cwd the picker scopes to: the test runner's own directory. */
const HERE = process.cwd()

function header(id: string, createdAt: number, cwd?: string, parentSession?: string): SessionHeader {
  return {
    version: 1,
    id: SessionId(id),
    createdAt,
    ...cwd === undefined ? {} : { cwd },
    ...parentSession === undefined ? {} : { parentSession: SessionId(parentSession) },
  }
}

/** A fulfilled batch-title result for `readTitleSnapshots` fakes. */
function titled(id: string, title?: string): {
  sessionId: { toString(): string }
  status: 'fulfilled'
  value: { title?: { title: string } }
} {
  return {
    sessionId: SessionId(id),
    status: 'fulfilled',
    ...title === undefined ? {} : { value: { title: { title } } },
  }
}

/** A rejected batch-title result for `readTitleSnapshots` fakes. */
function rejected(id: string): {
  sessionId: { toString(): string }
  status: 'rejected'
  reason: string
} {
  return { sessionId: SessionId(id), status: 'rejected', reason: 'log unreadable' }
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

  it('/sessions <id> emits mayfly/request-resume with the trimmed id', async () => {
    const { ctx, agent } = await mount()
    const onResume = vi.fn()
    ctx.on('mayfly/request-resume', onResume)
    const execution = await ctx.commands.execute(agent, '/sessions  abc-123 ', [], signal())
    expect(onResume).toHaveBeenCalledWith('abc-123')
    expect(execution?.result).toEqual({ kind: 'success', text: 'resuming session abc-123' })
  })

  it('/sessions without an id opens the picker, and /resume is its alias', async () => {
    const { ctx, agent } = await mount({
      persistence: { list: () => Promise.resolve([header('s1', 1, HERE)]) },
    })
    const onResume = vi.fn()
    ctx.on('mayfly/request-resume', onResume)
    // Bare /sessions is the picker path — it opens the overlay and never
    // emits the resume request.
    const execution = await ctx.commands.execute(agent, '/sessions', [], signal())
    expect(execution?.result).toEqual({ kind: 'success' })
    expect(onResume).not.toHaveBeenCalled()
    const entry = ctx.mayflyOverlays.list().find(item => item.id === 'mayfly.sessions')!
    const context = { surfaceId: entry.id, operationId: 'empty', source: entry.source, revision: entry.revision, signal: signal(), report: vi.fn() }
    expect(await entry.definition.onEvent!.action!({ kind: 'selection-accept', pagePath: [], controlId: 'sessions', selectedIds: [] }, context)).toEqual({ kind: 'completed' })
    // The alias rewrites to /sessions with the id argument intact.
    expect(ctx.mayflyInteractionState.aliases.canonicalOf('resume')).toBe('sessions')
  })

  it('/new emits mayfly/request-new', async () => {
    const { ctx, agent } = await mount()
    const onNew = vi.fn()
    ctx.on('mayfly/request-new', onNew)
    const execution = await ctx.commands.execute(agent, '/new', [], signal())
    expect(onNew).toHaveBeenCalledOnce()
    expect(execution?.result).toEqual({ kind: 'success', text: 'starting a new session' })
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
    const onRewind = vi.fn()
    ctx.on('mayfly/request-rewind', onRewind)
    const execution = await ctx.commands.execute(agent, '/rewind', [], signal())
    expect(execution?.result).toEqual({ kind: 'success' })
    const opened = ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.rewind')!
    expect((await ctx.commands.execute(agent, '/rewind', [], signal()))?.result).toEqual({ kind: 'success' })
    expect(ctx.mayflyOverlays.list().find(entry => entry.id === opened.id)!.focusRevision).toBeGreaterThan(opened.focusRevision)
    const panel = overlay(ctx, 'mayfly.rewind')
    const rows = panel.render(72)
    expect(rows.some(row => row.includes('Rewind current session'))).toBe(true)
    expect(rows.some(row => row.includes('Turn 1 · fix the login flow'))).toBe(true)
    expect(rows.some(row => row.includes('login flow fixed'))).toBe(true)
    expect(rows.some(row => row.includes('The original session stays available'))).toBe(true)
    panel.handleInput(KEY.enter)
    await flushCommands()
    expect(onRewind).toHaveBeenCalledWith(String(agent.id), 0)
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

  it('/sessions errors when session persistence is unavailable', async () => {
    const { ctx, agent } = await mount()
    const execution = await ctx.commands.execute(agent, '/sessions', [], signal())
    expect(execution?.result).toEqual({ kind: 'error', text: 'session persistence is unavailable' })
  })

  it('/sessions reports a listing failure as an error', async () => {
    const { ctx, agent } = await mount({
      persistence: { list: () => Promise.reject(new Error('disk gone')) },
    })
    const execution = await ctx.commands.execute(agent, '/sessions', [], signal())
    expect(execution?.result).toEqual({ kind: 'error', text: 'could not list sessions: disk gone' })
  })

  it('/sessions reports a non-Error listing failure as an error', async () => {
    const { ctx, agent } = await mount({
      persistence: { list: () => Promise.reject('plain failure') },
    })
    const execution = await ctx.commands.execute(agent, '/sessions', [], signal())
    expect(execution?.result).toEqual({ kind: 'error', text: 'could not list sessions: plain failure' })
  })

  it('/sessions answers "no sessions in this directory" for an empty or all-foreign listing', async () => {
    const { ctx, agent } = await mount({
      persistence: { list: () => Promise.resolve([header('s-away', 1_000, '/elsewhere'), header('s-bare', 2_000)]) },
    })
    const execution = await ctx.commands.execute(agent, '/sessions', [], signal())
    expect(execution?.result).toEqual({ kind: 'success', text: 'no sessions in this directory' })
    expect(ctx.mayflyOverlays.list()).toHaveLength(0)
    const empty = await mount({ persistence: { list: () => Promise.resolve([]) } })
    const bare = await empty.ctx.commands.execute(empty.agent, '/sessions', [], signal())
    expect(bare?.result).toEqual({ kind: 'success', text: 'no sessions in this directory' })
  })

  it('/sessions scopes to this cwd, lists newest-first, and marks the live one', async () => {
    const { ctx, agent } = await mount({
      persistence: {
        list: () => Promise.resolve([
          header('s-old', 1_000, HERE),
          header(String(agent.id), 3_000, HERE),
          header('s-mid', 2_000, HERE),
          header('s-away', 9_000, '/elsewhere'),
          header('s-bare', 8_000),
        ]),
      },
    })
    const execution = await ctx.commands.execute(agent, '/sessions', [], signal())
    expect(execution?.result).toEqual({ kind: 'success' })
    // The framed picker: rules, the filtered title hint, and the untitled
    // rows (`id · date`, the constant cwd dropped — D46) with the `❯ `
    // pointer plus the `← current` badge on the live session. The foreign
    // and cwd-less rows never render.
    const panel = overlay(ctx, 'mayfly.sessions')
    const rows = panel.render(72)
    expect(rows.some(row => row.includes('Sessions'))).toBe(true)
    expect(rows.some(row => row.includes('Enter choose'))).toBe(true)
    expect(rows.some(row => row.includes('Type filter'))).toBe(true)
    expect(rows.some(row => row.includes(`${agent.id} · 1970-01-01 00:00`) && row.includes('← current'))).toBe(true)
    expect(rows.some(row => row.includes('s-mid · 1970-01-01 00:00'))).toBe(true)
    expect(rows.some(row => row.includes('s-old · 1970-01-01 00:00'))).toBe(true)
    expect(rows.some(row => row.includes('s-away'))).toBe(false)
    expect(rows.some(row => row.includes('s-bare'))).toBe(false)
    panel.handleInput(KEY.escape)
    await flushCommands()
    expect(panel.closed).toBe(true)
  })

  it('/sessions leads titled rows with the title and demotes the id to the description', async () => {
    const { ctx, agent } = await mount({
      persistence: {
        list: () => Promise.resolve([
          header('s-fix', 3_000, HERE),
          header(String(agent.id), 2_000, HERE),
          header('s-plain', 1_000, HERE),
        ]),
      },
      sessionQuery: {
        readTitleSnapshots: async () => [
          titled('s-fix', 'Fix the questionnaire width crash'),
          titled(String(agent.id), 'Kimi-style welcome banner'),
          rejected('s-plain'),
        ],
      },
    })
    await ctx.commands.execute(agent, '/sessions', [], signal())
    const rows = overlay(ctx, 'mayfly.sessions').render(88)
    expect(rows.some(row => row.includes('Fix the questionnaire width crash') && row.includes('— s-fix · 1970-01-01 00:00'))).toBe(true)
    // The live session (older than s-fix) is second, led by its title with
    // the current badge; a rejected observation degrades to the id form.
    expect(rows.some(row => row.includes('Kimi-style welcome banner') && row.includes(`— ${agent.id} · 1970-01-01 00:00`) && row.includes('← current'))).toBe(true)
    const plainRow = rows.find(row => row.includes('s-plain · 1970-01-01 00:00'))
    expect(plainRow).toBeDefined()
    expect(plainRow).toContain('s-plain · 1970-01-01 00:00')
  })

  it('/sessions renders persisted parentSession lineage as a tree', async () => {
    const { ctx, agent } = await mount({
      persistence: {
        list: () => Promise.resolve([
          header('root', 1_000, HERE),
          header('child-a', 3_000, HERE, 'root'),
          header('child-b', 2_000, HERE, 'root'),
        ]),
      },
    })
    await ctx.commands.execute(agent, '/sessions', [], signal())
    const panel = overlay(ctx, 'mayfly.sessions')
    const collapsed = panel.render(90)
    expect(panel.model.choice({ pagePath: [], controlId: 'sessions' })?.expandedIds).toEqual([])
    expect(collapsed.some(row => row.includes('root · 1970-01-01 00:00'))).toBe(true)
    expect(collapsed.some(row => row.includes('child-a'))).toBe(false)
    panel.handleInput(KEY.space)
    await flushCommands()
    const expanded = panel.render(90)
    expect(panel.model.choice({ pagePath: [], controlId: 'sessions' })?.expandedIds).toEqual(['root'])
    expect(expanded.some(row => row.includes('child-a'))).toBe(true)
    expect(expanded.some(row => row.includes('child-b'))).toBe(true)
  })

  it('/sessions opens with the id form when no sessionQuery is mounted', async () => {
    const { ctx, agent } = await mount({
      persistence: { list: () => Promise.resolve([header('s-one', 1_000, HERE)]) },
    })
    const execution = await ctx.commands.execute(agent, '/sessions', [], signal())
    expect(execution?.result).toEqual({ kind: 'success' })
    const rows = overlay(ctx, 'mayfly.sessions').render(60)
    expect(rows.some(row => row.includes('s-one · 1970-01-01 00:00'))).toBe(true)
  })

  it('/sessions works without a currently attached Mayfly session', async () => {
    const { ctx, agent } = await mount({
      attach: false,
      persistence: { list: () => Promise.resolve([header('s-one', 1_000, HERE)]) },
    })
    const onResume = vi.fn()
    ctx.on('mayfly/request-resume', onResume)
    await ctx.commands.execute(agent, '/sessions', [], signal())
    const panel = overlay(ctx, 'mayfly.sessions')
    panel.handleInput(KEY.enter)
    await flushCommands()
    expect(onResume).toHaveBeenCalledWith('s-one')
    expect(panel.closed).toBe(true)
  })

  it('/sessions resolves titles only for the newest sessions under the limit', async () => {
    const requested: string[] = []
    const { ctx, agent } = await mount({
      persistence: {
        list: () => Promise.resolve([
          header('s-new', 3_000, HERE),
          header('s-old', 1_000, HERE),
        ]),
      },
      sessionQuery: {
        readTitleSnapshots: async ids => {
          requested.push(...ids.map(String))
          return []
        },
      },
    })
    commandsPlugin.setSessionTitleLimit(1)
    try {
      expect(commandsPlugin.currentSessionTitleLimit()).toBe(1)
      await ctx.commands.execute(agent, '/sessions', [], signal())
      // Newest-first: only the newest id is worth a full-log parse when
      // the cap is 1; the older row keeps the id form.
      expect(requested).toEqual(['s-new'])
    } finally {
      commandsPlugin.setSessionTitleLimit(undefined)
    }
    expect(commandsPlugin.currentSessionTitleLimit()).toBe(commandsPlugin.DEFAULT_SESSION_TITLE_LIMIT)
  })

  it('/sessions degrades to the id form when the whole title batch fails', async () => {
    const { ctx, agent } = await mount({
      persistence: {
        list: () => Promise.resolve([header('s-one', 1_000, HERE), header('s-two', 2_000, HERE)]),
      },
      sessionQuery: {
        readTitleSnapshots: async () => {
          throw new Error('persistence backend gone')
        },
      },
    })
    const execution = await ctx.commands.execute(agent, '/sessions', [], signal())
    expect(execution?.result).toEqual({ kind: 'success' })
    const rows = overlay(ctx, 'mayfly.sessions').render(60)
    expect(rows.some(row => row.includes('s-two · 1970-01-01 00:00'))).toBe(true)
    expect(rows.some(row => row.includes('s-one · 1970-01-01 00:00'))).toBe(true)
  })

  it('/sessions keeps the skeleton when title hydration returns malformed data', async () => {
    const { ctx, agent } = await mount({
      persistence: { list: () => Promise.resolve([header('s-one', 1_000, HERE)]) },
      sessionQuery: {
        readTitleSnapshots: async () => undefined as never,
      },
    })
    await ctx.commands.execute(agent, '/sessions', [], signal())
    await flushCommands()
    const rows = overlay(ctx, 'mayfly.sessions').render(60)
    expect(rows.some(row => row.includes('s-one · 1970-01-01 00:00'))).toBe(true)
  })

  it('/sessions hydrates only the visible title page as the cursor advances', async () => {
    const headers = Array.from({ length: 10 }, (_, index) => header(`s-${index}`, 10_000 - index, HERE))
    const calls: string[][] = []
    const secondPage = Promise.withResolvers<ReadonlyArray<ReturnType<typeof titled>>>()
    const { ctx, agent } = await mount({
      persistence: { list: () => Promise.resolve(headers) },
      sessionQuery: {
        readTitleSnapshots: async ids => {
          calls.push(ids.map(String))
          if (calls.length === 2) return secondPage.promise
          return ids.map(id => titled(String(id), `Title ${String(id)}`))
        },
      },
    })
    await ctx.commands.execute(agent, '/sessions', [], signal())
    expect(calls).toEqual([
      headers.slice(0, 8).map(item => String(item.id)),
      headers.slice(8).map(item => String(item.id)),
    ])
    const panel = overlay(ctx, 'mayfly.sessions')
    for (let index = 0; index < 6; index += 1) panel.handleInput(KEY.down)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(headers.slice(8).map(item => String(item.id)))
    secondPage.resolve(headers.slice(8).map(item => titled(String(item.id), `Title ${String(item.id)}`)))
    await vi.waitFor(() => expect(panel.render(80).some(row => row.includes('Title s-8'))).toBe(true))
    const rows = panel.render(80)
    expect(rows.some(row => row.includes('Title s-8'))).toBe(true)
  })

  it('/sessions remains usable with more than 200 persisted rows', async () => {
    const headers = Array.from({ length: 500 }, (_, index) => header(`large-${String(index)}`, 1_000 - index, HERE))
    const { ctx, agent } = await mount({ persistence: { list: () => Promise.resolve(headers) } })
    const onResume = vi.fn()
    ctx.on('mayfly/request-resume', onResume)

    const execution = await ctx.commands.execute(agent, '/sessions', [], signal())
    expect(execution?.result).toEqual({ kind: 'success' })
    const largePanel = overlay(ctx, 'mayfly.sessions')
    expect(largePanel.render(80).join('\n')).toContain('(1/500)')
    expect(largePanel.render(80).join('\n')).not.toContain('Mayfly UI rejected')

    largePanel.handleInput('\x1b[F')
    largePanel.handleInput(KEY.enter)
    await flushCommands()
    expect(onResume).toHaveBeenCalledWith('large-499')
  })

  it('/sessions drops a late page hydration after the picker fiber unloads', async () => {
    const headers = Array.from({ length: 10 }, (_, index) => header(`late-${index}`, 10_000 - index, HERE))
    const gate = Promise.withResolvers<ReadonlyArray<ReturnType<typeof titled>>>()
    let call = 0
    const { ctx, agent, fiber } = await mount({
      persistence: { list: () => Promise.resolve(headers) },
      sessionQuery: {
        readTitleSnapshots: async ids => {
          call += 1
          if (call === 2) return gate.promise
          return ids.map(id => titled(String(id), `Title ${String(id)}`))
        },
      },
    })
    await ctx.commands.execute(agent, '/sessions', [], signal())
    const panel = overlay(ctx, 'mayfly.sessions')
    for (let index = 0; index < 8; index += 1) panel.handleInput(KEY.down)
    await fiber.dispose()
    gate.resolve([])
    await flushCommands()
    expect(ctx.mayflyOverlays.list()).toHaveLength(0)
  })

  it('/sessions filters rows by the typed query and clears it before cancelling', async () => {
    const { ctx, agent } = await mount({
      persistence: {
        list: () => Promise.resolve([header('s-fix', 2_000, HERE), header('s-banner', 1_000, HERE)]),
      },
      sessionQuery: {
        readTitleSnapshots: async () => [titled('s-fix', 'Fix width crash'), titled('s-banner', 'Banner rework')],
      },
    })
    await ctx.commands.execute(agent, '/sessions', [], signal())
    const panel = overlay(ctx, 'mayfly.sessions')
    for (const char of 'Banner') panel.handleInput(char)
    const rows = panel.render(60)
    expect(rows.some(row => row.includes('Banner rework'))).toBe(true)
    expect(rows.some(row => row.includes('Fix width crash'))).toBe(false)
    // Escape clears the query first; only the second press cancels.
    panel.handleInput(KEY.escape)
    expect(panel.closed).toBe(false)
    panel.handleInput(KEY.escape)
    await flushCommands()
    expect(panel.closed).toBe(true)
  })

  it('/sessions emits mayfly/request-resume when another session is picked', async () => {
    const { ctx, agent } = await mount({
      persistence: { list: () => Promise.resolve([header('s-other', 2_000, HERE), header(String(agent.id), 3_000, HERE)]) },
    })
    const onResume = vi.fn()
    ctx.on('mayfly/request-resume', onResume)
    await ctx.commands.execute(agent, '/sessions', [], signal())
    const panel = overlay(ctx, 'mayfly.sessions')
    panel.handleInput(KEY.down)
    panel.handleInput(KEY.enter)
    await flushCommands()
    expect(panel.closed).toBe(true)
    expect(onResume).toHaveBeenCalledWith('s-other')
  })

  it('/sessions keeps the picker open with local feedback when the live session is picked', async () => {
    const { ctx, agent } = await mount({
      persistence: { list: () => Promise.resolve([header(String(agent.id), 3_000, HERE)]) },
    })
    const onResume = vi.fn()
    ctx.on('mayfly/request-resume', onResume)
    await ctx.commands.execute(agent, '/sessions', [], signal())
    const panel = overlay(ctx, 'mayfly.sessions')
    panel.handleInput(KEY.enter)
    await flushCommands()
    expect(panel.closed).toBe(false)
    expect(onResume).not.toHaveBeenCalled()
    expect(panel.model.feedbackSnapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'info', message: 'Already the current session' }),
    ]))
  })

  it('/sessions shows no overlay when the fiber unloads while the listing is in flight', async () => {
    const gate = Promise.withResolvers<SessionHeader[]>()
    const { ctx, agent, fiber } = await mount({
      persistence: { list: () => gate.promise },
    })
    const pending = ctx.commands.execute(agent, '/sessions', [], signal())
    await fiber.dispose()
    gate.resolve([header('s-late', 1_000, HERE)])
    const execution = await pending
    expect(execution?.result).toEqual({ kind: 'success' })
    expect(ctx.mayflyOverlays.list()).toHaveLength(0)
  })

  it('/sessions waits for first-page title hydration and ignores a late result after unload', async () => {
    const gate = Promise.withResolvers<ReadonlyArray<{ sessionId: { toString(): string }, status: 'fulfilled', value: { title?: { title: string } } }>>()
    const { ctx, agent, fiber } = await mount({
      persistence: { list: () => Promise.resolve([header('s-late', 1_000, HERE)]) },
      sessionQuery: { readTitleSnapshots: () => gate.promise },
    })
    const pending = ctx.commands.execute(agent, '/sessions', [], signal())
    await flushCommands()
    expect(ctx.mayflyOverlays.list()).toHaveLength(0)
    await fiber.dispose()
    gate.resolve([])
    const execution = await pending
    expect(execution?.result).toEqual({ kind: 'success' })
    await flushCommands()
    expect(ctx.mayflyOverlays.list()).toHaveLength(0)
  })

  it('/sessions and /rewind publish headless surfaces while the renderer is absent', async () => {
    const ctx = new Context()
    roots.push(ctx)
    new InteractionStateService(ctx, DEFAULT_SETTINGS)
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([header('s-one', 1_000, process.cwd())]),
    } as unknown as SessionPersistence)
    const session = ctx.sessions.create(SessionId('commands-bare'))
    const agent = { id: session.id, session } as unknown as Agent
    provideAppBoundary(ctx)
    await ctx.plugin(uiProvider)
    await mountInteractionOwner(ctx)
    await ctx.plugin(commandsPlugin)
    const execution = await ctx.commands.execute(agent, '/sessions', [], signal())
    expect(execution?.result).toEqual({ kind: 'success' })
    expect(ctx.mayflyOverlays.list().map(entry => entry.id)).toContain('mayfly.sessions')
    ctx.mayflyOverlays.close('mayfly.sessions')
    ;(agent as unknown as { status: string }).status = 'idle'
    ctx.provide('testSession', { current: agent, modelRef: undefined })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'rewind without a screen' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect((await ctx.commands.execute(agent, '/rewind', [], signal()))?.result).toEqual({ kind: 'success' })
    expect(ctx.mayflyOverlays.list().map(entry => entry.id)).toContain('mayfly.rewind')
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
    expect(rows.some(row => row.includes('Keys'))).toBe(true)
    expect(rows.some(row => row.includes('enter') && row.includes('Submit input'))).toBe(true)
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
    for (const name of ['quit', 'new', 'fork', 'sessions', 'help', 'theme']) {
      expect(ctx.commands.find(agent, name)).toBeDefined()
    }
    await fiber.dispose()
    for (const name of ['quit', 'new', 'fork', 'sessions', 'help', 'theme']) {
      expect(ctx.commands.find(agent, name)).toBeUndefined()
    }
    // The alias metadata follows the fiber: the relation is gone too, so a
    // later mount can re-register it without tripping the conflict guard.
    expect(ctx.mayflyInteractionState.aliases.canonicalOf('q')).toBeUndefined()
    expect(ctx.mayflyInteractionState.aliases.canonicalOf('exit')).toBeUndefined()
  })

})
