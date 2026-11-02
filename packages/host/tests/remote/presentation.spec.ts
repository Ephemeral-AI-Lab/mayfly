/**
 * Decision tests for batch tool presentation: per-entry degradation, the
 * duplicate-entry refusal, and per-session Agent reuse.
 * @module
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { parseToolArguments, presentTool, presentTools } from '../../src/remote/presentation.ts'
import type { MayflyToolPresentationInput } from '../../src/types.ts'

/** One presentation input carrying only what the module reads. */
function input(sessionId: string, callId: string, overrides: Partial<MayflyToolPresentationInput> = {}): MayflyToolPresentationInput {
  return {
    sessionId: sessionId as never,
    callId,
    name: 'bash',
    arguments: '{"command":"ls"}',
    updatedSeq: 5,
    // A settled call carries a result the result presenter renders.
    result: { content: [{ type: 'text', text: 'ok' }], isError: false },
    ...overrides,
  } as MayflyToolPresentationInput
}

/** An Agent whose tool presenter answers (or throws) for one name. */
function agent(behaviour: Partial<{ readonly card: string, readonly throwOnCall: boolean }> = {}): Agent {
  // An explicitly undefined rawInput would refuse the whole snapshot (that is
  // the json contract), so the key only exists on a generic card.
  const view = behaviour.card === 'generic'
    ? { card: 'generic', text: 'ran', rawInput: { command: 'ls' } }
    : { card: behaviour.card ?? 'custom', text: 'ran' }
  return {
    id: 'session-1',
    ctx: {
      tools: {
        get: (): { presentCall?: (args: unknown) => unknown, presentResult?: (args: unknown, result: unknown) => unknown } => ({
          presentCall: behaviour.throwOnCall === true ? (): never => { throw new Error('presenter broke') } : (): unknown => view,
          presentResult: (): unknown => ({ card: 'result', text: 'ok' }),
        }),
      },
    },
  } as unknown as Agent
}

describe('parseToolArguments', () => {
  it('parses raw JSON and refuses malformed text without throwing', () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 })
    expect(parseToolArguments('not json')).toBeUndefined()
  })
})

describe('presentTool', () => {
  it('carries the call and result views of a healthy presenter', () => {
    const presentation = presentTool(agent(), input('session-1', 'c1'))
    expect(presentation.updatedSeq).toBe(5)
    expect(presentation.call).toMatchObject({ card: 'custom', text: 'ran' })
    expect(presentation.result).toMatchObject({ card: 'result' })
  })

  it('keeps a generic card only when its raw input is lossless JSON', () => {
    const presentation = presentTool(agent({ card: 'generic' }), input('session-1', 'c1'))
    expect(presentation.call).toMatchObject({ card: 'generic', rawInput: { command: 'ls' } })
  })

  it('degrades only the view whose presenter threw', () => {
    const broken = agent({ throwOnCall: true })
    const presentation = presentTool(broken, input('session-1', 'c1'))
    expect(presentation.call).toBeUndefined()
    // The result view still resolved.
    expect(presentation.result).toMatchObject({ card: 'result' })
  })

  it('omits the result view when the entry carries none', () => {
    const presentation = presentTool(agent(), { ...input('session-1', 'c1'), result: undefined })
    expect(presentation.result).toBeUndefined()
    expect(Object.hasOwn(presentation, 'result')).toBe(false)
  })

  it('keeps a generic call without rawInput and isolates result presenter failures', () => {
    const presenter = { ctx: { tools: { get: () => ({
      presentCall: () => ({ card: 'generic', title: 'Tool' }),
      presentResult: () => { throw new Error('bad result presenter') },
    }) } } } as unknown as Agent
    expect(presentTool(presenter, input('s', 'c'))).toEqual({ updatedSeq: 5, call: { card: 'generic', title: 'Tool' } })
  })

  it('drops non-JSON generic rawInput rather than leaking a callback', () => {
    const presenter = { ctx: { tools: { get: () => ({
      presentCall: () => ({ card: 'generic', rawInput: { callback: () => undefined } }),
    }) } } } as unknown as Agent
    expect(presentTool(presenter, input('s', 'c'))).toEqual({ updatedSeq: 5 })
  })
})

describe('presentTools', () => {
  /** A context resolving every requested session to one shared Agent. */
  interface Resolutions { count(): number }
  function ctx(): { ctx: Context, resolutions: Resolutions } {
    let count = 0
    const shared = agent()
    const session = { id: 'session-1', header: { origin: 'user' } }
    const registered = { ...shared, session } as unknown as Agent
    const context = {
      agents: { get: (): Agent => registered },
      sessions: { get: (): unknown => session },
      sessionController: { resolveAgent: async (): Promise<never> => { throw new Error('unexpected') } },
    } as unknown as Context
    return { ctx: context, resolutions: { count: (): number => count } }
  }

  it('groups presentations by session and call id, resolving each session once', async () => {
    const { ctx: context } = ctx()
    const response = await presentTools(context, {
      entries: [input('session-1', 'c1'), input('session-1', 'c2')],
    }, new AbortController().signal)
    expect(response.presentations['session-1']).toHaveProperty('c1')
    expect(response.presentations['session-1']).toHaveProperty('c2')
    expect(Object.isFrozen(response)).toBe(true)
  })

  it('refuses a duplicate session/call entry before resolving anything', async () => {
    const { ctx: context } = ctx()
    await expect(presentTools(context, {
      entries: [input('session-1', 'c1'), input('session-1', 'c1')],
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'gateway/bad-request' })
  })

  it('refuses to start on an aborted signal', async () => {
    const { ctx: context } = ctx()
    const controller = new AbortController()
    controller.abort()
    await expect(presentTools(context, { entries: [input('session-1', 'c1')] }, controller.signal)).rejects.toThrow()
  })

  it('returns an empty aborted batch as cancellation too', async () => {
    const { ctx: context } = ctx()
    await expect(presentTools(context, { entries: [] }, AbortSignal.abort())).rejects.toThrow()
  })

  it('keeps live presentations while cold child entries use generic cards without activation', async () => {
    const { ctx: context } = ctx()
    const liveAgent = context.agents.get('session-1' as never)
    const liveSession = context.sessions.get('session-1' as never)
    const resolveAgent = vi.fn()
    const cold = { id: 'child-1', header: { origin: 'subagent' } }
    const mixed = {
      agents: { get: (id: string) => id === 'session-1' ? liveAgent : undefined },
      sessions: { get: (id: string) => id === 'session-1' ? liveSession : cold },
      sessionController: { resolveAgent },
    } as unknown as Context
    const response = await presentTools(mixed, { entries: [input('child-1', 'a'), input('session-1', 'b'), input('child-1', 'c')] }, new AbortController().signal)
    expect(response.presentations['child-1']).toEqual({ a: { updatedSeq: 5 }, c: { updatedSeq: 5 } })
    expect(response.presentations['session-1']?.['b']?.call).toBeDefined()
    expect(resolveAgent).not.toHaveBeenCalled()
  })

  it('does not hide non-child resolution errors as generic presentations', async () => {
    const context = {
      agents: { get: () => undefined }, sessions: { get: () => undefined },
      sessionController: { resolveAgent: async () => { throw new Error('transport failed') } },
    } as unknown as Context
    await expect(presentTools(context, { entries: [input('missing', 'a')] }, new AbortController().signal)).rejects.toThrow('transport failed')
  })

  it('discards a presentation if its presenter cancels the operation', async () => {
    const controller = new AbortController()
    const session = { id: 'session-1', header: { origin: 'user' } }
    const live = { ...agent(), session, ctx: { tools: { get: () => ({ presentCall: () => { controller.abort(new Error('cancelled presenter')); return undefined } }) } } }
    const context = { agents: { get: () => live }, sessions: { get: () => session } } as unknown as Context
    await expect(presentTools(context, { entries: [input('session-1', 'a')] }, controller.signal)).rejects.toThrow('cancelled presenter')
  })
})
