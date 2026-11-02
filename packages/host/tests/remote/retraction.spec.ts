/**
 * Decision tests for the retraction guard: which turns may be cancelled, when
 * persistence waits for the authoritative close, and what the fold tracks.
 * @module
 */
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { RetractionCoordinator, mayflyRetractionProjectionDefinition, retractTurn } from '../../src/remote/retraction.ts'

/** The fold is exported through the projection definition's apply. */
const fold = mayflyRetractionProjectionDefinition.apply

/** One session event with only the fields the fold reads. */
function event(type: string, data: object, seq = 1): object {
  return { type, data, seq } as never
}

/** A coordinator harness with stub registries and a captured append. */
function harness(options: Partial<{
  readonly status: string
  readonly toolActivity: boolean
  readonly messageIds: readonly string[]
  readonly open: object | null
}> = {}) {
  const appended: object[] = []
  const listeners = new Map<string, (session: unknown, event: unknown) => void>()
  let disposers: Array<() => void> = []
  const session = {
    id: 'session-1',
    surface: { nodes: [10, 12, 14, 20] },
    append: vi.fn((_type: string, _data: object, _opts?: object): undefined => undefined),
  }
  const agent: Agent = {
    id: 'session-1',
    status: options.status ?? 'running',
    session,
    cancel: vi.fn((): void => {}),
  } as unknown as Agent
  const ctx = {
    on: (name: string, listener: (session: unknown, event: unknown) => void): (() => void) => {
      listeners.set(name, listener)
      const dispose = (): void => { listeners.delete(name) }
      disposers.push(dispose)
      return dispose
    },
    agents: { get: (): Agent => agent },
    sessions: { get: (): unknown => session },
    effect: (fn: () => () => void): (() => void) => {
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    },
    sessionProjections: { snapshot: (): { values: { mayflyRetraction: { open: object | null } } } => ({
      values: { mayflyRetraction: { open: 'open' in options ? options.open : {
        turn: 3, startSeq: 10, step: 1, messageIds: options.messageIds ?? ['m-1'], toolActivity: options.toolActivity ?? false,
      } } },
    }) },
    logger: { warn: vi.fn((): void => {}) },
  } as unknown as Context
  const coordinator = new RetractionCoordinator(ctx)
  // Listeners here take one argument; the session/event pair shape is not needed.
  const emit = (name: string, first: unknown, second?: unknown): void => { listeners.get(name)?.(first, second) }
  return { coordinator, agent, session, appended, emit, ctx, dispose: (): void => { for (const dispose of disposers) dispose() } }
}

describe('mayflyRetractionProjectionDefinition', () => {
  it('pins its key and excludes itself from the wire summary', () => {
    expect(mayflyRetractionProjectionDefinition.key).toBe('mayflyRetraction')
    expect(mayflyRetractionProjectionDefinition.wire.summary).toBe(false)
  })

  it('tracks one open turn and closes it on its own turn end', () => {
    let state = mayflyRetractionProjectionDefinition.init('session-1' as never, { id: 'session-1' } as never)
    expect(state.open).toBeNull()
    state = fold(state, event('turn/start', { turn: 2 }, 10) as never)
    expect(state.open).toMatchObject({ turn: 2, startSeq: 10, step: 0, toolActivity: false })
    // Another turn's close does not close this one.
    state = fold(state, event('turn/end', { turn: 9 }, 12) as never)
    expect(state.open).not.toBeNull()
    state = fold(state, event('turn/end', { turn: 2 }, 14) as never)
    expect(state.open).toBeNull()
  })

  it('marks tool activity from calls, results, and tool-call blocks', () => {
    let state = fold(mayflyRetractionProjectionDefinition.init('session-1' as never, { id: 'session-1' } as never), event('turn/start', { turn: 1 }, 1) as never)
    state = fold(state, event('tool/call', { turn: 1 }) as never)
    expect(state.open?.toolActivity).toBe(true)
    state = fold(mayflyRetractionProjectionDefinition.init('session-1' as never, { id: 'session-1' } as never), event('turn/start', { turn: 1 }, 1) as never)
    state = fold(state, event('assistant/message', { turn: 1, message: { content: [{ type: 'tool-call' }] } }) as never)
    expect(state.open?.toolActivity).toBe(true)
  })

  it('collects user message ids only for the open turn', () => {
    let state = fold(mayflyRetractionProjectionDefinition.init('session-1' as never, { id: 'session-1' } as never), event('turn/start', { turn: 1 }, 1) as never)
    state = fold(state, event('user/message', { source: { kind: 'user' }, id: 'm-1' }) as never)
    state = fold(state, event('user/message', { source: { kind: 'agent' }, id: 'm-2' }) as never)
    expect(state.open?.messageIds).toEqual(['m-1'])
  })

  it('ignores unrelated and tool-free events while preserving the matching current step', () => {
    const empty = { open: null }
    expect(fold(empty, event('user/message', { source: { kind: 'user' }, id: 'm' }) as never)).toBe(empty)
    let state = fold(empty, event('turn/start', { turn: 1 }) as never)
    for (const item of [event('step/start', { turn: 2, step: 9 }), event('tool/result', { turn: 2 }), event('assistant/message', { turn: 2, message: { content: [] } }), event('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'answer' }] } }), event('session/title', {})]) expect(fold(state, item as never)).toBe(state)
    state = fold(state, event('step/start', { turn: 1, step: 4 }) as never)
    expect(state.open?.step).toBe(4)
    expect(mayflyRetractionProjectionDefinition.wire.view(state)).toBe(state)
  })
})

describe('RetractionCoordinator.tryRetract', () => {
  it('cancels a running tool-free turn carrying the message', () => {
    const { coordinator, agent } = harness()
    expect(coordinator.tryRetract(agent, 'm-1')).toBe(true)
    expect(agent.cancel).toHaveBeenCalledOnce()
  })

  it('refuses a turn that already used a tool', () => {
    const { coordinator, agent } = harness({ toolActivity: true })
    expect(coordinator.tryRetract(agent, 'm-1')).toBe(false)
    expect(agent.cancel).not.toHaveBeenCalled()
  })

  it('refuses an id the turn does not carry', () => {
    const { coordinator, agent } = harness()
    expect(coordinator.tryRetract(agent, 'm-other')).toBe(false)
  })

  it('refuses an idle agent and a second retraction while one is pending', () => {
    const { coordinator, agent } = harness()
    expect(coordinator.tryRetract(agent, 'm-1')).toBe(true)
    // A second request for the same agent while the first is pending.
    expect(coordinator.tryRetract(agent, 'm-1')).toBe(false)
    const idle = harness({ status: 'idle' })
    expect(idle.coordinator.tryRetract(idle.agent, 'm-1')).toBe(false)
  })

  it('refuses a closed projection or unloaded coordinator', () => {
    const closed = harness({ open: null })
    expect(closed.coordinator.tryRetract(closed.agent, 'm-1')).toBe(false)
    const retired = harness()
    retired.dispose()
    expect(retired.coordinator.tryRetract(retired.agent, 'm-1')).toBe(false)
  })
})

describe('RetractionCoordinator persistence', () => {
  it('skips persistence after owner unload or when the turn has no visible surface', async () => {
    const retired = harness()
    retired.coordinator.tryRetract(retired.agent, 'm-1')
    retired.emit('session/event', retired.session, { type: 'turn/end', data: { turn: 3 }, seq: 30 })
    retired.dispose()
    await Promise.resolve()
    expect(retired.session.append).not.toHaveBeenCalled()
    const invisible = harness()
    invisible.session.surface.nodes = []
    invisible.coordinator.tryRetract(invisible.agent, 'm-1')
    invisible.emit('session/event', invisible.session, { type: 'turn/end', data: { turn: 3 }, seq: 30 })
    await Promise.resolve()
    expect(invisible.session.append).not.toHaveBeenCalled()
  })

  it('logs append failures without throwing from a late microtask', async () => {
    for (const failure of [new Error('journal closed'), 'write rejected']) {
      const h = harness()
      h.session.append.mockImplementation(() => { throw failure })
      h.coordinator.tryRetract(h.agent, 'm-1')
      h.emit('session/event', h.session, { type: 'turn/end', data: { turn: 3 }, seq: 30 })
      await Promise.resolve()
      expect(h.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining(failure instanceof Error ? failure.message : failure))
    }
  })

  it('ignores an unregistered Agent and a foreign Session object at turn close', async () => {
    const h = harness()
    h.coordinator.tryRetract(h.agent, 'm-1')
    h.emit('session/event', h.session, { type: 'step/start', data: { turn: 3, step: 1 }, seq: 29 })
    h.emit('session/event', { ...h.session }, { type: 'turn/end', data: { turn: 3 }, seq: 30 })
    h.ctx.agents.get = (() => undefined) as typeof h.ctx.agents.get
    h.emit('session/event', h.session, { type: 'turn/end', data: { turn: 3 }, seq: 30 })
    await Promise.resolve()
    expect(h.session.append).not.toHaveBeenCalled()
  })
  it('waits for the authoritative turn end, then replaces the turn\'s surface nodes', async () => {
    const { coordinator, agent, session, emit } = harness()
    coordinator.tryRetract(agent, 'm-1')
    // Persistence happens on the turn end of the pending turn only.
    emit('session/event', session, { type: 'turn/end', data: { turn: 99 }, seq: 30 })
    expect(session.append).not.toHaveBeenCalled()
    emit('session/event', session, { type: 'turn/end', data: { turn: 3 }, seq: 30 })
    await new Promise(resolve => setTimeout(resolve, 10))
    const args = vi.mocked(session.append).mock.calls.at(-1) as unknown as [string, object, object]
    expect(args[0]).toBe('developer/message')
    // The replacement spans exactly the turn's nodes, excluding the markers.
    expect(args[2]).toMatchObject({ surfaceOp: { op: 'replace', startSeq: 12, endSeq: 20 } })
  })

  it('drops the pending entry when the agent is disposed', async () => {
    const { coordinator, agent, session, emit, ctx } = harness()
    coordinator.tryRetract(agent, 'm-1')
    // The disposed listener takes one destructured argument.
    emit('agent/disposed', { agent })
    emit('session/event', session, { type: 'turn/end', data: { turn: 3 }, seq: 30 })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(session.append).not.toHaveBeenCalled()
    void ctx
  })
})

describe('retractTurn', () => {
  it('resolves the exact Agent before applying the guard', async () => {
    const { coordinator, agent, ctx } = harness()
    agent.cancel = vi.fn((): void => {})
    const value = await retractTurn(ctx, coordinator, SessionId('session-1'), 'm-1', new AbortController().signal)
    expect(value).toBe(true)
  })
})
