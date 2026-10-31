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
    append: vi.fn(),
  }
  const agent: Agent = {
    id: 'session-1',
    status: options.status ?? 'running',
    session,
    cancel: vi.fn(),
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
      values: { mayflyRetraction: { open: options.open ?? {
        turn: 3, startSeq: 10, step: 1, messageIds: options.messageIds ?? ['m-1'], toolActivity: options.toolActivity ?? false,
      } } },
    }) },
    logger: { warn: vi.fn() },
  } as unknown as Context
  const coordinator = new RetractionCoordinator(ctx)
  // Listeners here take one argument; the session/event pair shape is not needed.
  const emit = (name: string, first: unknown, second?: unknown): void => { listeners.get(name)?.(first, second) }
  return { coordinator, agent, session, appended, emit, ctx }
    .valueOf() as never as ReturnType<typeof harness> & { readonly appended: object[] }
}

describe('mayflyRetractionProjectionDefinition', () => {
  it('pins its key and excludes itself from the wire summary', () => {
    expect(mayflyRetractionProjectionDefinition.key).toBe('mayflyRetraction')
    expect(mayflyRetractionProjectionDefinition.wire.summary).toBe(false)
  })

  it('tracks one open turn and closes it on its own turn end', () => {
    let state = mayflyRetractionProjectionDefinition.init()
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
    let state = fold(mayflyRetractionProjectionDefinition.init(), event('turn/start', { turn: 1 }, 1) as never)
    state = fold(state, event('tool/call', { turn: 1 }) as never)
    expect(state.open?.toolActivity).toBe(true)
    state = fold(mayflyRetractionProjectionDefinition.init(), event('turn/start', { turn: 1 }, 1) as never)
    state = fold(state, event('assistant/message', { turn: 1, message: { content: [{ type: 'tool-call' }] } }) as never)
    expect(state.open?.toolActivity).toBe(true)
  })

  it('collects user message ids only for the open turn', () => {
    let state = fold(mayflyRetractionProjectionDefinition.init(), event('turn/start', { turn: 1 }, 1) as never)
    state = fold(state, event('user/message', { source: { kind: 'user' }, id: 'm-1' }) as never)
    state = fold(state, event('user/message', { source: { kind: 'agent' }, id: 'm-2' }) as never)
    expect(state.open?.messageIds).toEqual(['m-1'])
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
})

describe('RetractionCoordinator persistence', () => {
  it('waits for the authoritative turn end, then replaces the turn\'s surface nodes', async () => {
    const { coordinator, agent, session, emit } = harness()
    coordinator.tryRetract(agent, 'm-1')
    // Persistence happens on the turn end of the pending turn only.
    emit('session/event', session, { type: 'turn/end', data: { turn: 99 }, seq: 30 })
    expect(session.append).not.toHaveBeenCalled()
    emit('session/event', session, { type: 'turn/end', data: { turn: 3 }, seq: 30 })
    await new Promise(resolve => setTimeout(resolve, 10))
    const call = vi.mocked(session.append).mock.calls[0]
    expect(call[0]).toBe('developer/message')
    // The replacement spans exactly the turn's nodes, excluding the markers.
    expect(call[2]).toMatchObject({ surfaceOp: { op: 'replace', startSeq: 12, endSeq: 20 } })
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
    agent.cancel = vi.fn()
    const value = await retractTurn(ctx, coordinator, SessionId('session-1'), 'm-1', new AbortController().signal)
    expect(value).toBe(true)
  })
})
