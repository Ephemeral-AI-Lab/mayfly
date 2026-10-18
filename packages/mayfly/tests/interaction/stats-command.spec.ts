/** `/stats` end to end over the native session, the session query index, and
 * the provider account read: registration, tabs, range/workspace actions,
 * copy, repaint scheduling, and close/unload lifetimes.
 * @module @ephemeral-ai/mayfly/tests/interaction/stats-command
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { SessionObservation, SessionRecord } from '@deepseek-ai/dsh-session-query'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setClipboardOsc52Emitter, setClipboardTextWriter } from '../../src/interaction/clipboard-write.ts'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'
import { setModelsDevLoader, type ModelsDevIndex } from '../../src/interaction/models-dev.ts'
import { MAYFLY_VERSION } from '../../src/transcript/banner-content.ts'
import { balanceInternals } from '../../src/interaction/stats-account.ts'
import { apply } from '../../src/interaction/stats-command.ts'
import { DEFAULT_SETTINGS, type MayflySettings } from '../../src/interaction/settings.ts'
import { fakeMayflyContext } from './fakes.ts'
import { flush } from '../helpers.ts'

const DAY = 1_800_000_000_000
const originalFetchBalance = balanceInternals.fetchBalance
const contexts: Context[] = []

afterEach(async () => {
  setClipboardTextWriter(undefined)
  setClipboardOsc52Emitter(undefined)
  setModelsDevLoader(undefined)
  balanceInternals.fetchBalance = originalFetchBalance
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

const signal = (): AbortSignal => new AbortController().signal

function record(id: string, cwd = '/repo', createdAt = DAY): SessionRecord {
  return { header: { id, cwd, createdAt } as never, live: false, persisted: true }
}

const turnEvent = (time: number, seq = 1) => ({ type: 'turn/start', seq, time, data: {} })
const messageEvent = (time: number, provider: string, model: string, seq = 2) => ({
  type: 'assistant/message', seq, time,
  data: {
    usage: { inputTokens: 100, cacheReadTokens: 10, cacheWriteTokens: 5, outputTokens: 20 },
    message: { source: { provider, model } },
  },
})

function observation(id: string, cwd: string, events: readonly unknown[], revision = 'r1'): SessionObservation {
  return {
    header: { id, cwd, createdAt: DAY } as never, source: 'prepared', inheritedEventCount: 0, events, cursor: 2, revision,
    [Symbol.dispose]: vi.fn(),
  } as unknown as SessionObservation
}

interface BenchOptions {
  readonly cwd?: string
  /** A model selection for the session; `false` leaves it unset. */
  readonly model?: { readonly provider: string, readonly model: string } | false
  readonly locale?: 'en' | 'zh'
  readonly settings?: Partial<MayflySettings>
  readonly records?: readonly SessionRecord[]
  readonly events?: readonly unknown[]
  readonly displayVersion?: string | false
  readonly failList?: Error | string
  readonly failObserve?: Error
  readonly snapshotThrows?: boolean
  readonly llmThrows?: boolean | string | Error
  readonly captureProjections?: boolean
}

async function bench(options: BenchOptions = {}) {
  const { ctx } = fakeMayflyContext()
  contexts.push(ctx)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('stats-spec'), {
    meta: { cwd: options.cwd ?? '/repo', createdAt: Date.UTC(2026, 9, 14, 3, 4) },
  })
  const agent = { id: session.id, session, status: 'idle' } as unknown as Agent
  const state: { current: Agent | null, modelRef?: { current: { provider: string, model: string } } } = {
    current: agent,
    ...options.model === false ? {} : { modelRef: { current: options.model ?? { provider: 'deepseek-official', model: 'deepseek-chat' } } },
  }
  ctx.provide('testSession', state)
  const listSessions = vi.fn(options.failList === undefined ? async () => [...options.records ?? []] : async () => { throw options.failList })
  const observeSession = vi.fn(async (id: unknown) => {
    if (options.failObserve !== undefined) throw options.failObserve
    return observation(String(id), options.cwd ?? '/repo', options.events ?? [turnEvent(Date.now())])
  })
  ctx.provide('sessionQuery', { listSessions, observeSession } as never)
  let fetchCount = 0
  let fetchPending: Promise<void> | undefined
  let accountResult: { status: number, body: unknown } = { status: 200, body: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1.00' }] } }
  balanceInternals.fetchBalance = async () => {
    fetchCount += 1
    if (fetchPending !== undefined) await fetchPending
    return accountResult
  }
  ctx.provide('credentials', {
    resolve: async () => ({ value: 'secret' }),
    describe: async () => ({ configured: true }),
  } as never)
  if (options.llmThrows !== undefined && options.llmThrows !== false) {
    ctx.provide('llm', { listProviders: () => { throw options.llmThrows }, listConfigurableProviders: () => [] } as never)
  } else {
    ctx.provide('llm', {
      listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
      listConfigurableProviders: () => [],
    } as never)
  }
  if (options.snapshotThrows === true) {
    ctx.sessionProjections.snapshot = () => { throw new Error('projection unavailable') }
  }
  const projectionListeners: ((session: unknown, key: string) => void)[] = []
  if (options.captureProjections === true) {
    const original = ctx.sessionProjections.onChanged
    ctx.sessionProjections.onChanged = ((listener: (session: unknown, key: string) => void) => {
      projectionListeners.push(listener)
      return original(listener)
    }) as typeof ctx.sessionProjections.onChanged
  }
  ctx.mayflyInteractionState.settingsSource = () => ({ ...DEFAULT_SETTINGS, ...options.settings })
  const locale = new MayflyLocaleService(ctx, { systemLocale: options.locale ?? 'en' })
  const pluginConfig = options.displayVersion === false ? undefined : { displayVersion: options.displayVersion ?? 'test-build' }
  await ctx.plugin({ name: 'test-stats', inject: ['commands', 'mayflyOverlays'], apply }, pluginConfig)
  await flush()
  const command = () => ctx.commands.find(agent, 'stats')!
  const run = (invocationSignal: AbortSignal = signal()) => ctx.commands.execute(agent, '/stats', [], invocationSignal)
  const overlay = () => ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.stats')
  const node = (): string => {
    const entry = overlay()
    if (entry === undefined) throw new Error('no stats overlay')
    return JSON.stringify(entry.node)
  }
  const context = (entry: NonNullable<ReturnType<typeof overlay>>) => ({
    surfaceId: entry.id, operationId: 'stats-test', source: entry.source, revision: entry.revision, signal: signal(), report: vi.fn(),
  })
  const action = async (actionId: string, kind: 'activate' | 'other' = 'activate') => {
    const entry = overlay()!
    return entry.definition.onEvent!.action!(
      { kind, pagePath: [], controlId: 'stats-keys-history', actionId } as never,
      context(entry),
    )
  }
  const observe = (event: Record<string, unknown>): void => {
    const entry = overlay()!
    void entry.definition.onEvent!.observe!(event as never, context(entry))
  }
  return {
    ctx, agent, state, session, locale, listSessions, observeSession, command, run, overlay, node, action, observe, projectionListeners,
    fetch: (result?: { status: number, body: unknown }) => { if (result !== undefined) accountResult = result; return fetchCount },
    gateFetch: (gate: Promise<void>) => { fetchPending = gate },
    setState: (next: Agent | null) => { state.current = next },
  }
}

describe('registration and guards', () => {
  it('registers /stats, opens one panel, and focuses it instead of opening a second', async () => {
    const b = await bench()
    expect(b.command().description).toContain('Show this session')
    expect(await b.run()).toMatchObject({ result: { kind: 'success' } })
    const first = b.overlay()!
    expect(JSON.stringify(first.node)).toContain('Stats')
    expect(JSON.stringify(first.node)).toContain('test-build')
    expect(JSON.stringify(first.node)).toContain('Working directory')
    const focus = first.focusRevision
    expect(await b.run()).toMatchObject({ result: { kind: 'success' } })
    expect(b.ctx.mayflyOverlays.list()).toHaveLength(1)
    expect(b.overlay()!.focusRevision).toBeGreaterThan(focus)
  })

  it('ignores an aborted invocation and an unloaded Fiber', async () => {
    const b = await bench()
    const command = b.command()
    const aborted = new AbortController()
    aborted.abort()
    expect(await command.handler({ agent: b.agent, rawInput: '', signal: aborted.signal } as never)).toEqual({ kind: 'success' })
    expect(b.overlay()).toBeUndefined()
    await b.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(b.ctx), 1)
    expect(await command.handler({ agent: b.agent, rawInput: '', signal: signal() } as never)).toEqual({ kind: 'success' })
  })

  it('uses the package version when no display version is configured', async () => {
    const b = await bench({ displayVersion: false })
    await b.run()
    expect(b.node()).toContain(MAYFLY_VERSION)
    expect(b.node()).toContain('Harness 0.2.1-rc.2')
  })

  it('refuses a non-current Agent with the live-session error', async () => {
    const b = await bench()
    b.setState(null)
    expect(await b.run()).toMatchObject({ result: { kind: 'error', text: 'no session is live yet' } })
    expect(b.overlay()).toBeUndefined()
  })

  it('falls back to the unavailable session facts when the projection read throws', async () => {
    const b = await bench({ snapshotThrows: true })
    expect(await b.run()).toMatchObject({ result: { kind: 'success' } })
    expect(b.node()).toContain('Session information unavailable')
    expect(b.node()).toContain('not set')
  })
})

describe('session tab', () => {
  it('folds the live log into turn and token facts and remembers an unchanged log', async () => {
    const b = await bench()
    await b.run()
    expect(b.node()).not.toContain('By model')
    b.session.append('turn/start', { turn: 1 })
    b.session.append('turn/start', { turn: 1 })
    const message = (provider: string, model: string): void => {
      b.session.append('assistant/message', {
        turn: 1,
        step: 0,
        message: createAssistantMessage({ content: [], source: { provider, model } }),
        stream: [],
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 5 },
      }, { surfaceOp: 'append' })
    }
    message('deepseek', 'deepseek-v4-flash')
    message('deepseek', 'deepseek-v4-pro')
    b.ctx.emit('agent/status', { agent: b.agent, status: 'idle' })
    await vi.waitFor(() => expect(b.node()).toContain('By model'))
    expect(b.node()).toContain('deepseek/deepseek-v4-flash')
    expect(b.node()).toContain('deepseek/deepseek-v4-pro')
    const revision = b.overlay()!.revision
    b.ctx.emit('agent/status', { agent: b.agent, status: 'idle' })
    await new Promise(resolve => { setTimeout(resolve, 150) })
    expect(b.overlay()!.revision).toBeGreaterThan(revision)
    message('deepseek', 'deepseek-v4-flash')
    b.ctx.emit('agent/status', { agent: b.agent, status: 'idle' })
    await vi.waitFor(() => expect(b.node()).toContain('By model'))
  })
})

describe('live session and projections', () => {
  it('replaces the stored copy of the live session with its live digest', async () => {
    const b = await bench({ records: [record('stats-spec')] })
    await b.run()
    b.session.append('turn/start', { turn: 1 })
    b.observe({ kind: 'tab-change', tabId: 'history' })
    await vi.waitFor(() => expect(b.listSessions).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(b.node()).toContain('"label":"Sessions","value":[{"text":"1"}]'))
    expect(b.node()).not.toContain('"label":"Sessions","value":[{"text":"2"}]')
  })

  it('drops the live digest when the workspace scope no longer matches it', async () => {
    const b = await bench({ records: [record('stored', '/elsewhere')] })
    await b.run()
    b.session.append('turn/start', { turn: 1 })
    const events = b.session.snapshotEvents()
    ;(b.agent as unknown as { session: unknown }).session = {
      ...b.session,
      header: { ...b.session.header, cwd: '/elsewhere' },
      snapshotEvents: () => events,
    }
    b.observe({ kind: 'tab-change', tabId: 'history' })
    await vi.waitFor(() => expect(b.listSessions).toHaveBeenCalledTimes(1))
    expect(await b.action('workspace')).toMatchObject({ kind: 'accepted' })
    await vi.waitFor(() => expect(b.node()).toContain('/elsewhere'))
    await vi.waitFor(() => expect(b.listSessions).toHaveBeenCalledTimes(2))
  })

  it('schedules a repaint for a matching projection or status change only', async () => {
    setModelsDevLoader(async () => undefined)
    const b = await bench({ captureProjections: true, model: false })
    await b.run()
    await flush(4)
    const revision = b.overlay()!.revision
    b.projectionListeners[0]!(b.agent.session, 'sessionStats')
    await vi.waitFor(() => expect(b.overlay()!.revision).toBeGreaterThan(revision))
    const settled = b.overlay()!.revision
    b.projectionListeners[0]!({}, 'other')
    b.ctx.emit('agent/status', { agent: { id: 'other' } as unknown as Agent, status: 'idle' })
    await new Promise(resolve => { setTimeout(resolve, 150) })
    expect(b.overlay()!.revision).toBe(settled)
  })
})

describe('tabs and actions', () => {
  it('switches tabs, ignores unknown tab events, and honors refresh/range/unknown actions', async () => {
    const b = await bench()
    await b.run()
    b.observe({ kind: 'selection-accept' })
    b.observe({ kind: 'tab-change', tabId: 'bogus' })
    expect(b.node()).toContain('"activeId":"session"')
    const refreshed = await b.action('refresh')
    expect(refreshed).toMatchObject({ kind: 'accepted' })
    expect(JSON.stringify(refreshed)).toContain('"activeId":"session"')
    const week = await b.action('range')
    expect(week).toMatchObject({ kind: 'accepted' })
    expect(JSON.stringify(week)).toContain('"text":"Last 7 days","tone":"primary","styles":["strong"]')
    const month = await b.action('range')
    expect(JSON.stringify(month)).toContain('"text":"Last 30 days","tone":"primary","styles":["strong"]')
    const all = await b.action('range')
    expect(JSON.stringify(all)).toContain('"text":"All time","tone":"primary","styles":["strong"]')
    expect(await b.action('unknown')).toEqual({ kind: 'completed' })
    expect(await b.action('ignored', 'other')).toEqual({ kind: 'completed' })
    b.observe({ kind: 'tab-change', tabId: 'account' })
    expect(b.node()).toContain('"activeId":"account"')
    b.observe({ kind: 'tab-change', tabId: 'account' })
    b.observe({ kind: 'tab-change', tabId: 'session' })
    expect(b.node()).toContain('"activeId":"session"')
  })

  it('starts the index once when the first figures tab opens and restarts it for the workspace scope', async () => {
    const b = await bench()
    await b.run()
    b.observe({ kind: 'tab-change', tabId: 'history' })
    await vi.waitFor(() => expect(b.listSessions).toHaveBeenCalledTimes(1))
    b.observe({ kind: 'tab-change', tabId: 'models' })
    await new Promise(resolve => { setTimeout(resolve, 20) })
    expect(b.listSessions).toHaveBeenCalledTimes(1)
    const workspace = await b.action('workspace')
    expect(workspace).toMatchObject({ kind: 'accepted' })
    expect(JSON.stringify(workspace)).toContain('this workspace')
    await vi.waitFor(() => expect(b.listSessions).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(b.node()).toContain('this workspace'))
    const all = await b.action('workspace')
    expect(all).toMatchObject({ kind: 'accepted' })
    expect(JSON.stringify(all)).toContain('all workspaces')
    await vi.waitFor(() => expect(b.listSessions).toHaveBeenCalledTimes(3))
  })
})

describe('session index', () => {
  it('moves through indexing progress to both stored sessions', async () => {
    const b = await bench({
      records: [record('a'), record('b')],
      events: [turnEvent(Date.now()), messageEvent(Date.now(), 'deepseek', 'deepseek-v4-flash')],
    })
    await b.run()
    b.observe({ kind: 'tab-change', tabId: 'history' })
    await vi.waitFor(() => expect(b.listSessions).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(b.node()).toContain('"label":"Sessions","value":[{"text":"2"}]'))
    expect(b.observeSession).toHaveBeenCalledTimes(2)
    expect(b.node()).toContain('Sessions')
  })

  it('reports failed session reads and a failed listing', async () => {
    const failedReads = await bench({ records: [record('a')], failObserve: new Error('corrupt log') })
    const warn = vi.spyOn(failedReads.ctx.logger, 'warn').mockImplementation(() => {})
    await failedReads.run()
    failedReads.observe({ kind: 'tab-change', tabId: 'history' })
    await vi.waitFor(() => expect(failedReads.node()).toContain('1 sessions could not be read'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('corrupt log'))

    const failedList = await bench({ failList: new Error('query down') })
    const listWarn = vi.spyOn(failedList.ctx.logger, 'warn').mockImplementation(() => {})
    await failedList.run()
    failedList.observe({ kind: 'tab-change', tabId: 'history' })
    await vi.waitFor(() => expect(failedList.node()).toContain('Could not read the stored sessions: query down'))
    expect(listWarn).toHaveBeenCalledWith(expect.stringContaining('stats: index failed: query down'))
  })

  it('contains a listing rejection after the panel closed and a string failure', async () => {
    const late = Promise.withResolvers<SessionRecord[]>()
    const closed = await bench()
    closed.listSessions.mockImplementationOnce(() => late.promise)
    await closed.run()
    closed.observe({ kind: 'tab-change', tabId: 'history' })
    await vi.waitFor(() => expect(closed.listSessions).toHaveBeenCalledTimes(1))
    closed.ctx.mayflyOverlays.close('mayfly.stats')
    late.reject(new Error('late failure'))
    await flush(4)
    expect(closed.overlay()).toBeUndefined()

    const stringFailure = await bench({ failList: 'query exploded' })
    const warn = vi.spyOn(stringFailure.ctx.logger, 'warn').mockImplementation(() => {})
    await stringFailure.run()
    stringFailure.observe({ kind: 'tab-change', tabId: 'history' })
    await vi.waitFor(() => expect(stringFailure.node()).toContain('Could not read the stored sessions: query exploded'))
    expect(warn).toHaveBeenCalledWith('stats: index failed: query exploded')
  })

  it('retires an index read when the panel closes first', async () => {
    const gate = Promise.withResolvers<void>()
    const b = await bench()
    b.listSessions.mockImplementationOnce(async () => { await gate.promise; return [record('late')] })
    await b.run()
    b.observe({ kind: 'tab-change', tabId: 'history' })
    await vi.waitFor(() => expect(b.listSessions).toHaveBeenCalledTimes(1))
    b.ctx.mayflyOverlays.close('mayfly.stats')
    gate.resolve()
    await flush(4)
    expect(b.overlay()).toBeUndefined()
  })
})

describe('account tab', () => {
  it('loads the provider balance, reuses a fresh read, and keeps it across tabs', async () => {
    const b = await bench()
    await b.run()
    await vi.waitFor(() => expect(b.node()).toContain('configured (DEEPSEEK_API_KEY)'))
    expect(b.node()).toContain('¥ 1.00')
    expect(b.fetch()).toBe(1)
    b.observe({ kind: 'tab-change', tabId: 'account' })
    expect(b.node()).toContain('"activeId":"account"')
    b.observe({ kind: 'tab-change', tabId: 'history' })
    b.observe({ kind: 'tab-change', tabId: 'account' })
    await new Promise(resolve => { setTimeout(resolve, 20) })
    expect(b.fetch()).toBe(1)
  })

  it('shows the checking state, skips a second concurrent read, and publishes the result', async () => {
    const gate = Promise.withResolvers<void>()
    const b = await bench()
    b.gateFetch(gate.promise)
    await b.run()
    await vi.waitFor(() => expect(b.node()).toContain('checking balance…'))
    b.observe({ kind: 'tab-change', tabId: 'account' })
    b.observe({ kind: 'tab-change', tabId: 'session' })
    b.observe({ kind: 'tab-change', tabId: 'account' })
    await new Promise(resolve => { setTimeout(resolve, 20) })
    expect(b.fetch()).toBe(1)
    gate.resolve()
    await vi.waitFor(() => expect(b.node()).toContain('¥ 1.00'))
  })

  it('shows no balance when the model route is unknown, and a network reason when the read fails', async () => {
    const unknown = await bench({ model: false })
    await unknown.run()
    unknown.observe({ kind: 'tab-change', tabId: 'account' })
    expect(unknown.node()).toContain('not set')
    expect(unknown.fetch()).toBe(0)

    const failed = await bench()
    balanceInternals.fetchBalance = async () => { throw new Error('offline') }
    await failed.run()
    await vi.waitFor(() => expect(failed.node()).toContain('unavailable (network)'))
  })

  it('retries a failed read after the model route is shown again and logs a snapshot failure', async () => {
    const b = await bench()
    b.fetch({ status: 500, body: {} })
    await b.run()
    await vi.waitFor(() => expect(b.node()).toContain('unavailable (network)'))
    b.observe({ kind: 'tab-change', tabId: 'history' })
    b.observe({ kind: 'tab-change', tabId: 'account' })
    await vi.waitFor(() => expect(b.fetch()).toBe(2))

    const broken = await bench({ llmThrows: 'llm registry down' })
    const warn = vi.spyOn(broken.ctx.logger, 'warn').mockImplementation(() => {})
    await broken.run()
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('stats: account read failed: llm registry down')))
    expect(broken.node()).toContain('deepseek-official')
  })

  it('logs an Error snapshot failure once and ignores a read started after close', async () => {
    const b = await bench({ llmThrows: new Error('registry exploded') })
    const warn = vi.spyOn(b.ctx.logger, 'warn').mockImplementation(() => {})
    await b.run()
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('stats: account read failed: registry exploded'))
    const definition = b.overlay()!.definition
    b.ctx.mayflyOverlays.close('mayfly.stats')
    void definition.onEvent!.observe!({ kind: 'tab-change', tabId: 'account' } as never, {
      surfaceId: 'mayfly.stats', operationId: 'closed', source: [], revision: 0, signal: signal(), report: vi.fn(),
    })
    await flush(4)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('does not publish a late account read after the panel closes', async () => {
    const gate = Promise.withResolvers<void>()
    const b = await bench()
    b.gateFetch(gate.promise)
    await b.run()
    await vi.waitFor(() => expect(b.node()).toContain('checking balance…'))
    b.ctx.mayflyOverlays.close('mayfly.stats')
    gate.resolve()
    await flush(4)
    expect(b.ctx.mayflyOverlays.list()).toEqual([])
  })
})

describe('copy', () => {
  it('copies the active tab summary through the native writer', async () => {
    const copied: string[] = []
    setClipboardTextWriter(async text => { copied.push(text) })
    setClipboardOsc52Emitter(() => false)
    const b = await bench()
    await b.run()
    expect(await b.action('copy')).toMatchObject({ kind: 'completed', feedback: { severity: 'success', message: 'copied the stats summary' } })
    expect(copied[0]).toContain('Working directory: /repo')
  })

  it('reports a non-Error copy failure as its text', async () => {
    setClipboardTextWriter(async () => { throw 'plain failure' })
    setClipboardOsc52Emitter(() => false)
    const b = await bench()
    await b.run()
    expect(await b.action('copy')).toMatchObject({ kind: 'failed', message: 'could not copy: plain failure' })
  })

  it('reports the unverified terminal escape and a failed copy', async () => {
    setClipboardTextWriter(async () => { throw new Error('no clipboard tool') })
    setClipboardOsc52Emitter(() => true)
    const b = await bench()
    await b.run()
    expect(await b.action('copy')).toMatchObject({
      kind: 'completed', feedback: { message: 'copied the stats summary via terminal escape sequence (unverified)' },
    })
    setClipboardOsc52Emitter(() => false)
    expect(await b.action('copy')).toMatchObject({ kind: 'failed', message: 'could not copy: no clipboard tool' })
  })
})

describe('locale and catalogs', () => {
  it('repaints in Chinese and back when the locale preference changes', async () => {
    const b = await bench()
    await b.run()
    expect(b.node()).toContain('Working directory')
    b.locale.setPreference('zh')
    await vi.waitFor(() => expect(b.node()).toContain('统计'))
    expect(b.node()).toContain('工作目录')
    b.locale.setPreference('en')
    await vi.waitFor(() => expect(b.node()).toContain('Working directory'))
  })

  it('loads the price catalog late and ignores a catalog failure', async () => {
    let loads = 0
    setModelsDevLoader(async (): Promise<ModelsDevIndex> => {
      loads += 1
      return { lookup: () => undefined, lookupCost: () => undefined }
    })
    const loaded = await bench({ model: false })
    await loaded.run()
    await vi.waitFor(() => expect(loads).toBe(1))
    setModelsDevLoader(async () => { throw new Error('catalog offline') })
    const failed = await bench({ model: false })
    await failed.run()
    await flush(4)
    expect(failed.overlay()).toBeDefined()
  })
})

describe('close and replacement', () => {
  it('closes the panel and drops the scheduled actions when the current Agent is replaced', async () => {
    const b = await bench()
    await b.run()
    b.ctx.emit('agent/status', { agent: b.agent, status: 'idle' })
    b.setState(null)
    b.ctx.emit('test/session-changed', null)
    await vi.waitFor(() => expect(b.overlay()).toBeUndefined())
  })

  it('aborts pending index and account reads when closed and survives a late locale change', async () => {
    const indexGate = Promise.withResolvers<void>()
    const accountGate = Promise.withResolvers<void>()
    const b = await bench()
    b.listSessions.mockImplementationOnce(async () => { await indexGate.promise; return [record('late')] })
    b.gateFetch(accountGate.promise)
    await b.run()
    b.observe({ kind: 'tab-change', tabId: 'history' })
    await vi.waitFor(() => expect(b.listSessions).toHaveBeenCalledTimes(1))
    b.ctx.mayflyOverlays.close('mayfly.stats')
    b.locale.setPreference('zh')
    indexGate.resolve()
    accountGate.resolve()
    await flush(6)
    expect(b.overlay()).toBeUndefined()
  })

  it('ignores a tab event delivered after the panel closed', async () => {
    const b = await bench()
    await b.run()
    const definition = b.overlay()!.definition
    b.ctx.mayflyOverlays.close('mayfly.stats')
    expect(() => definition.onEvent!.observe!({ kind: 'tab-change', tabId: 'history' } as never, {
      surfaceId: 'mayfly.stats', operationId: 'closed', source: [], revision: 0, signal: signal(), report: vi.fn(),
    })).not.toThrow()
    await flush(4)
    expect(b.overlay()).toBeUndefined()
  })

  it('clears a pending repaint when the panel is closed', async () => {
    const b = await bench()
    await b.run()
    b.ctx.emit('agent/status', { agent: b.agent, status: 'idle' })
    b.ctx.mayflyOverlays.close('mayfly.stats')
    await new Promise(resolve => { setTimeout(resolve, 150) })
    expect(b.overlay()).toBeUndefined()
  })
})
