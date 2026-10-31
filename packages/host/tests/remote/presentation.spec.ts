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
})

describe('presentTools', () => {
  /** A context resolving every requested session to one shared Agent. */
  function ctx(): { ctx: Context, resolutions: { count: () => number } } {
    let count = 0
    const shared = agent()
    const session = { id: 'session-1', header: { origin: 'user' } }
    const registered = { ...shared, session }
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
})
