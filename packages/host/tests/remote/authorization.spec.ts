/**
 * Decision tests for the authorization stream: the prompt round-trip through
 * the invocation uplink, the refusal codes, and per-key cancellation.
 * @module
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { cancelAuthorization, authorize } from '../../src/remote/authorization.ts'
import { AuthorizationError } from '@deepseek-ai/dsh-authorization'

/** One answer the client pushes up the uplink. */
type UplinkAnswer = { operationId: string, promptId: string, type: 'answer' | 'decline', value?: string }

/** A controllable uplink the test pushes answers into. */
function uplink(): { iterable: AsyncIterable<UplinkAnswer>, push(answer: UplinkAnswer): void, close(): void } {
  const buffered: UplinkAnswer[] = []
  const waiting: ((result: IteratorResult<UplinkAnswer>) => void)[] = []
  let done = false
  return {
    iterable: {
      [Symbol.asyncIterator]: (): AsyncIterator<UplinkAnswer> => ({
        next: (): Promise<IteratorResult<UplinkAnswer>> => new Promise(resolve => {
          const value = buffered.shift()
          if (value !== undefined) resolve({ value, done: false })
          else if (done) resolve({ value: undefined, done: true })
          else waiting.push(resolve)
        }),
        return: async (): Promise<IteratorResult<UplinkAnswer>> => {
          done = true
          for (const settle of waiting.splice(0)) settle({ value: undefined, done: true })
          return { value: undefined, done: true }
        },
      }),
    },
    push: (answer: UplinkAnswer): void => {
      const settle = waiting.shift()
      if (settle !== undefined) settle({ value: answer, done: false })
      else buffered.push(answer)
    },
    close: (): void => {
      done = true
      for (const settle of waiting.splice(0)) settle({ value: undefined, done: true })
    },
  }
}

/** A harness with one described authorization flow and its captured begin interaction. */
function harness(overrides: Partial<{
  readonly methods: readonly { id: string }[]
  readonly inFlight: boolean
  readonly beginError?: unknown
  readonly outcome: { status: string }
}> = {}): {
  ctx: Context
  uplink: ReturnType<typeof uplink>
  begin: (interaction: { prompt(prompt: { kind: string, message: string, placeholder?: string, options?: readonly { id: string, label: string }[], signal?: AbortSignal }): Promise<string> }): Promise<{ status: string }>
  cancel: ReturnType<typeof vi.fn>
} {
  const link = uplink()
  let capturedPrompt: ((prompt: { kind: string, message: string, placeholder?: string, options?: readonly { id: string, label: string }[], signal?: AbortSignal }) => Promise<string>) | undefined
  let lastAnswer: string | undefined
  const cancel = vi.fn()
  const ctx = {
    authorization: {
      describe: (): { methods: readonly { id: string }[], inFlight: boolean } | undefined => {
        // An explicitly empty list is a Host without the flow; omitted means
        // the default single OAuth flow.
        const methods = overrides.methods === undefined ? [{ id: 'oauth' }] : overrides.methods
        return methods.length === 0 ? undefined : { methods, inFlight: overrides.inFlight ?? false }
      },
      begin: async (request: { interaction: { notify(): void, prompt(prompt: never): Promise<string> } }): Promise<{ status: string }> => {
        if (overrides.beginError !== undefined) throw overrides.beginError
        capturedPrompt = request.interaction.prompt as typeof capturedPrompt
        // Drive the captured prompt exactly once: the native flow asks, and
        // the run settles only once the client answers it.
        const answer = await request.interaction.prompt({
          kind: 'secret',
          message: 'paste the key',
        } as never)
        lastAnswer = answer
        return overrides.outcome ?? { status: 'granted' }
      },
      cancel,
    },
    invocation: { uplink: <T>(): AsyncIterable<T> => link.iterable as AsyncIterable<T> },
  } as unknown as Context
  return {
    ctx,
    uplink: link,
    cancel,
    /** The answer the native flow received for its one prompt. */
    answer: (): string | undefined => lastAnswer,
  }
}

/** Drain a stream to arrays of frames, stopping at settled or the first rejection. */
async function drain(stream: AsyncGenerator): Promise<{ frames: unknown[], error?: unknown }> {
  const frames: unknown[] = []
  try {
    for await (const frame of stream) frames.push(frame)
    return { frames }
  } catch (error) {
    return { frames, error }
  }
}

describe('authorize', () => {
  it('runs a prompt round-trip: started, prompt, answer, prompt-ended, settled', async () => {
    const h = harness()
    const stream = authorize(h.ctx, { key: 'deepseek/api' }, new AbortController().signal)
    const started = await stream.next()
    expect(started.value).toMatchObject({ type: 'started' })
    const operationId = (started.value as { operationId: string }).operationId
    // The native flow asks one secret prompt.
    const promptFrame = await stream.next()
    expect(promptFrame.value).toMatchObject({ type: 'prompt', operationId, prompt: { kind: 'secret', message: 'paste the key' } })
    const promptId = (promptFrame.value as { promptId: string }).promptId
    // The answer travels only uplink-to-prompt; the run settles once it lands.
    h.uplink.push({ operationId, promptId, type: 'answer', value: 'sk-typed' })
    const ended = await stream.next()
    expect(ended.value).toMatchObject({ type: 'prompt-ended', promptId })
    const settled = await stream.next()
    expect(settled.value).toMatchObject({ type: 'settled', status: 'granted' })
    expect(h.answer()).toBe('sk-typed')
    const done = await stream.next()
    expect(done.done).toBe(true)
  })

  it('refuses a key without a flow and a method the flow does not offer', async () => {
    const noFlow = harness({ methods: [] })
    const outcome = await drain(authorize(noFlow.ctx, { key: 'unknown/service' }, new AbortController().signal))
    expect(outcome.error).toMatchObject({ code: 'mayflyHost/authorization-unavailable' })
    const wrongMethod = harness({ methods: [{ id: 'oauth' }] })
    const refused = await drain(authorize(wrongMethod.ctx, { key: 'deepseek/api', method: 'device-code' }, new AbortController().signal))
    expect(refused.error).toMatchObject({ code: 'mayflyHost/authorization-unavailable' })
  })

  it('refuses a malformed key and an already-running flow with the named codes', async () => {
    const malformed = harness()
    const outcome = await drain(authorize(malformed.ctx, { key: 'no-slash-here' }, new AbortController().signal))
    expect(outcome.error).toMatchObject({ code: 'mayflyHost/authorization-unavailable' })
    const running = harness({ inFlight: true })
    const busy = await drain(authorize(running.ctx, { key: 'deepseek/api' }, new AbortController().signal))
    expect(busy.error).toMatchObject({ code: 'mayflyHost/authorization-in-flight' })
  })

  it('maps a native NO_FLOW and an unexpected failure to the closed codes', async () => {
    const denied = harness({ beginError: new AuthorizationError('no flow for this key', 'NO_FLOW') })
    const outcome = await drain(authorize(denied.ctx, { key: 'deepseek/api' }, new AbortController().signal))
    expect(outcome.error).toMatchObject({ code: 'mayflyHost/authorization-unavailable' })
    const broken = harness({ beginError: new Error('native plugin crashed') })
    const failed = await drain(authorize(broken.ctx, { key: 'deepseek/api' }, new AbortController().signal))
    expect(failed.error).toMatchObject({ code: 'mayflyHost/authorization-failed' })
  })

  it('cancels the native attempt on early stream return', async () => {
    const h = harness()
    const stream = authorize(h.ctx, { key: 'deepseek/api' }, new AbortController().signal)
    await stream.next()
    await stream.return(undefined as never)
    expect(h.cancel).toHaveBeenCalled()
  })
})

describe('cancelAuthorization', () => {
  it('cancels exactly the named key and refuses an aborted signal', async () => {
    const h = harness()
    cancelAuthorization(h.ctx, { key: 'deepseek/api' }, new AbortController().signal)
    expect(h.cancel).toHaveBeenCalledOnce()
    const controller = new AbortController()
    controller.abort()
    expect(() => cancelAuthorization(h.ctx, { key: 'deepseek/api' }, controller.signal)).toThrow()
    // A malformed key is refused, never passed to the native service.
    const before = h.cancel.mock.calls.length
    expect(() => cancelAuthorization(h.ctx, { key: 'bad' }, new AbortController().signal)).toThrow()
    expect(h.cancel.mock.calls.length).toBe(before)
  })
})
