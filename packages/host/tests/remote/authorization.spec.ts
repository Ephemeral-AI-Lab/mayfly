/**
 * Decision tests for the authorization stream: the prompt round-trip through
 * the invocation uplink, the refusal codes, and per-key cancellation.
 * @module
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { cancelAuthorization, authorize } from '../../src/remote/authorization.ts'
import { AuthorizationError, AuthorizationService, type AuthorizationNotice, type AuthorizationOutcome, type AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { expectFrozenJson } from './frozen-frame.ts'

const nativeContexts: Context[] = []
afterEach(async () => { await Promise.all(nativeContexts.splice(0).map(ctx => ctx.fiber.dispose())) })

/** One answer the client pushes up the uplink. */
type UplinkAnswer = { operationId: string, promptId: string, type: 'answer' | 'decline', value?: string }

/** A controllable uplink the test pushes answers into. */
function uplink(): { iterable: AsyncIterable<UplinkAnswer>, push(answer: UplinkAnswer): void, close(): void, fail(error: unknown): void } {
  const buffered: UplinkAnswer[] = []
  const waiting: { resolve(result: IteratorResult<UplinkAnswer>): void, reject(error: unknown): void }[] = []
  let done = false
  return {
    iterable: {
      [Symbol.asyncIterator]: (): AsyncIterator<UplinkAnswer> => ({
        next: (): Promise<IteratorResult<UplinkAnswer>> => new Promise((resolve, reject) => {
          const value = buffered.shift()
          if (value !== undefined) resolve({ value, done: false })
          else if (done) resolve({ value: undefined, done: true })
          else waiting.push({ resolve, reject })
        }),
        return: async (): Promise<IteratorResult<UplinkAnswer>> => {
          done = true
          for (const settle of waiting.splice(0)) settle.resolve({ value: undefined, done: true })
          return { value: undefined, done: true }
        },
      }),
    },
    push: (answer: UplinkAnswer): void => {
      const settle = waiting.shift()
      if (settle !== undefined) settle.resolve({ value: answer, done: false })
      else buffered.push(answer)
    },
    close: (): void => {
      done = true
      for (const settle of waiting.splice(0)) settle.resolve({ value: undefined, done: true })
    },
    fail: (error: unknown): void => { done = true; for (const settle of waiting.splice(0)) settle.reject(error) },
  }
}

/** A harness with one described authorization flow and its captured begin interaction. */
function harness(overrides: Partial<{
  readonly methods: readonly { id: string }[]
  readonly inFlight: boolean
  readonly beginError?: unknown
  readonly outcome: AuthorizationOutcome
  readonly prompt: AuthorizationPrompt
  readonly notice: AuthorizationNotice
}> = {}): {
  ctx: Context
  uplink: ReturnType<typeof uplink>
  cancel: ReturnType<typeof vi.fn>
  answer(): string | undefined
  signal(): AbortSignal | undefined
} {
  const link = uplink()
  let capturedPrompt: ((prompt: { kind: string, message: string, placeholder?: string, options?: readonly { id: string, label: string }[], signal?: AbortSignal }) => Promise<string>) | undefined
  let lastAnswer: string | undefined
  let attemptSignal: AbortSignal | undefined
  const cancel = vi.fn()
  const ctx = {
    authorization: {
      describe: (): { methods: readonly { id: string }[], inFlight: boolean } | undefined => {
        // An explicitly empty list is a Host without the flow; omitted means
        // the default single OAuth flow.
        const methods = overrides.methods === undefined ? [{ id: 'oauth' }] : overrides.methods
        return methods.length === 0 ? undefined : { methods, inFlight: overrides.inFlight ?? false }
      },
      begin: async (request: { signal: AbortSignal, interaction: { notify(notice: AuthorizationNotice): void, prompt(prompt: never): Promise<string> } }): Promise<AuthorizationOutcome> => {
        attemptSignal = request.signal
        if (overrides.beginError !== undefined) throw overrides.beginError
        capturedPrompt = request.interaction.prompt as typeof capturedPrompt
        // Drive the captured prompt exactly once: the native flow asks, and
        // the run settles only once the client answers it.
        if (overrides.notice !== undefined) request.interaction.notify(overrides.notice)
        const answer = await request.interaction.prompt((overrides.prompt ?? {
          kind: 'secret',
          message: 'paste the key',
        }) as never)
        lastAnswer = answer
        return overrides.outcome ?? { status: 'authorized' }
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
    signal: (): AbortSignal | undefined => attemptSignal,
  }
}

/** Drain a stream to arrays of frames, stopping at settled or the first rejection. */
async function drain(stream: AsyncIterable<unknown>): Promise<{ frames: unknown[], error?: unknown }> {
  const frames: unknown[] = []
  try {
    for await (const frame of stream) frames.push(frame)
    return { frames }
  } catch (error) {
    return { frames, error }
  }
}

describe('authorize', () => {
  it('forwards selected native methods, text placeholders, notices and addressed answers', async () => {
    const notice = { message: 'Open browser', url: 'https://login.example' }
    const h = harness({ prompt: { kind: 'text', message: 'device code', placeholder: 'ABCD' }, notice })
    const native = vi.spyOn(h.ctx.authorization, 'begin')
    const iterator = authorize(h.ctx, { key: 'deepseek/api' as never, method: 'oauth' }, new AbortController().signal)[Symbol.asyncIterator]()
    const started = (await iterator.next()).value!
    expect(Object.isFrozen(notice)).toBe(false)
    notice.message = 'native producer changed after enqueue'
    const publishedNotice = (await iterator.next()).value
    expect(publishedNotice).toMatchObject({ type: 'notice', notice: { message: 'Open browser' } })
    const prompt = (await iterator.next()).value as { operationId: string, promptId: string }
    expect(prompt).toMatchObject({ type: 'prompt', prompt: { kind: 'text', placeholder: 'ABCD' } })
    h.uplink.push({ operationId: 'another operation', promptId: prompt.promptId, type: 'answer', value: 'wrong operation' })
    h.uplink.push({ operationId: prompt.operationId, promptId: 'retired prompt', type: 'answer', value: 'wrong prompt' })
    h.uplink.push({ ...prompt, type: 'answer', value: 'ABCD' })
    const frames = await drain({ [Symbol.asyncIterator]: () => iterator })
    expect(frames.error).toBeUndefined()
    expect(h.answer()).toBe('ABCD')
    expect(native).toHaveBeenCalledWith(expect.objectContaining({ method: 'oauth' }))
    expect(started).toMatchObject({ operationId: prompt.operationId })
    for (const frame of [started, publishedNotice, prompt, ...frames.frames]) expectFrozenJson(frame)
  })

  it('rejects a non-JSON native notice without publishing or freezing its alias', async () => {
    const notice = { message: 'native', callback: () => {} }
    const h = harness({ notice })
    const result = await drain(authorize(h.ctx, { key: 'deepseek/api' as never }, new AbortController().signal))
    expect(result.frames).toMatchObject([{ type: 'started' }])
    expect(result.error).toMatchObject({ code: 'mayflyHost/authorization-failed' })
    expect(Object.isFrozen(notice)).toBe(false)
  })

  it('copies native select choices and rejects only the addressed declined prompt', async () => {
    const options = [{ id: 'work', label: 'Work', description: 'organization account' }]
    const h = harness({ prompt: { kind: 'select', message: 'Account', options } })
    const iterator = authorize(h.ctx, { key: 'deepseek/api' as never }, new AbortController().signal)[Symbol.asyncIterator]()
    await iterator.next()
    const prompt = (await iterator.next()).value as { operationId: string, promptId: string, prompt: { options: typeof options } }
    expect(prompt.prompt.options).toEqual(options)
    expect(prompt.prompt.options[0]).not.toBe(options[0])
    h.uplink.push({ operationId: prompt.operationId, promptId: prompt.promptId, type: 'decline' })
    const outcome = await drain({ [Symbol.asyncIterator]: () => iterator })
    expect(outcome.error).toMatchObject({ code: 'mayflyHost/authorization-failed' })
    expect(h.answer()).toBeUndefined()
  })

  it('withdraws an individual prompt and closes a flow when its uplink fails', async () => {
    for (const before of [false, true]) {
      const controller = new AbortController()
      if (before) controller.abort()
      const h = harness({ prompt: { kind: 'secret', message: 'key', signal: controller.signal } })
      const iterator = authorize(h.ctx, { key: 'deepseek/api' as never }, new AbortController().signal)[Symbol.asyncIterator]()
      await iterator.next()
      if (!before) { await iterator.next(); controller.abort() }
      const outcome = await drain({ [Symbol.asyncIterator]: () => iterator })
      expect(outcome.error).toMatchObject({ code: 'mayflyHost/authorization-failed' })
      expect(h.signal()?.aborted).toBe(true)
      expect(h.cancel).not.toHaveBeenCalled()
    }
    const broken = harness()
    const iterator = authorize(broken.ctx, { key: 'deepseek/api' as never }, new AbortController().signal)[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.next()
    broken.uplink.fail(new Error('uplink ended'))
    const outcome = await drain({ [Symbol.asyncIterator]: () => iterator })
    expect(outcome.error).toBeInstanceOf(Error)
    expect(broken.signal()?.aborted).toBe(true)
    expect(broken.cancel).not.toHaveBeenCalled()
  })

  it('allows a completed uplink and maps native races to the documented refusal codes', async () => {
    for (const [code, expected] of [['UNKNOWN_METHOD', 'mayflyHost/authorization-unavailable'], ['ALREADY_IN_FLIGHT', 'mayflyHost/authorization-in-flight']] as const) {
      const h = harness({ beginError: new AuthorizationError('flow changed', code) })
      h.uplink.close()
      expect((await drain(authorize(h.ctx, { key: 'deepseek/api' as never }, new AbortController().signal))).error).toMatchObject({ code: expected })
    }
    const missingInvocation = harness()
    Object.defineProperty(missingInvocation.ctx, 'invocation', { value: undefined })
    expect((await drain(authorize(missingInvocation.ctx, { key: 'deepseek/api' as never }, new AbortController().signal))).error).toMatchObject({ code: 'gateway/internal' })
    expect((await drain(authorize(harness().ctx, { key: '/api' as never }, new AbortController().signal))).error).toMatchObject({ code: 'mayflyHost/authorization-unavailable' })
  })
  it('runs a prompt round-trip: started, prompt, answer, prompt-ended, settled', async () => {
    const h = harness()
    const stream = authorize(h.ctx, { key: 'deepseek/api' as never }, new AbortController().signal)
    const iterator = stream[Symbol.asyncIterator]()
    const started = await iterator.next()
    expect(started.value).toMatchObject({ type: 'started' })
    const operationId = (started.value as { operationId: string }).operationId
    // The native flow asks one secret prompt.
    const promptFrame = await iterator.next()
    expect(promptFrame.value).toMatchObject({ type: 'prompt', operationId, prompt: { kind: 'secret', message: 'paste the key' } })
    const promptId = (promptFrame.value as { promptId: string }).promptId
    // The answer travels only uplink-to-prompt; the run settles once it lands.
    h.uplink.push({ operationId, promptId, type: 'answer', value: 'sk-typed' })
    const ended = await iterator.next()
    expect(ended.value).toMatchObject({ type: 'prompt-ended', promptId })
    const settled = await iterator.next()
    expect(settled.value).toMatchObject({ type: 'settled', status: 'authorized' })
    expect(h.answer()).toBe('sk-typed')
    const done = await iterator.next()
    expect(done.done).toBe(true)
  })

  it('refuses a key without a flow and a method the flow does not offer', async () => {
    const noFlow = harness({ methods: [] })
    const outcome = await drain(authorize(noFlow.ctx, { key: 'unknown/service' as never }, new AbortController().signal))
    expect(outcome.error).toMatchObject({ code: 'mayflyHost/authorization-unavailable' })
    const wrongMethod = harness({ methods: [{ id: 'oauth' }] })
    const refused = await drain(authorize(wrongMethod.ctx, { key: 'deepseek/api' as never, method: 'device-code' }, new AbortController().signal))
    expect(refused.error).toMatchObject({ code: 'mayflyHost/authorization-unavailable' })
  })

  it('refuses a malformed key and an already-running flow with the named codes', async () => {
    const malformed = harness()
    const outcome = await drain(authorize(malformed.ctx, { key: 'no-slash-here' as never }, new AbortController().signal))
    expect(outcome.error).toMatchObject({ code: 'mayflyHost/authorization-unavailable' })
    const running = harness({ inFlight: true })
    const busy = await drain(authorize(running.ctx, { key: 'deepseek/api' as never }, new AbortController().signal))
    expect(busy.error).toMatchObject({ code: 'mayflyHost/authorization-in-flight' })
  })

  it('maps a native NO_FLOW and an unexpected failure to the closed codes', async () => {
    const denied = harness({ beginError: new AuthorizationError('no flow for this key', 'NO_FLOW') })
    const outcome = await drain(authorize(denied.ctx, { key: 'deepseek/api' as never }, new AbortController().signal))
    expect(outcome.error).toMatchObject({ code: 'mayflyHost/authorization-unavailable' })
    const broken = harness({ beginError: new Error('native plugin crashed') })
    const failed = await drain(authorize(broken.ctx, { key: 'deepseek/api' as never }, new AbortController().signal))
    expect(failed.error).toMatchObject({ code: 'mayflyHost/authorization-failed' })
  })

  it('withdraws only its native attempt on early stream return and leaves the caller signal untouched', async () => {
    const h = harness()
    const caller = new AbortController()
    const stream = authorize(h.ctx, { key: 'deepseek/api' as never }, caller.signal)
    const iterator = stream[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.return?.(undefined as never)
    expect(h.signal()?.aborted).toBe(true)
    expect(caller.signal.aborted).toBe(false)
    expect(h.cancel).not.toHaveBeenCalled()
  })
})

describe('cancelAuthorization', () => {
  it('cancels exactly the named key and refuses an aborted signal', async () => {
    const h = harness()
    cancelAuthorization(h.ctx, { key: 'deepseek/api' as never }, new AbortController().signal)
    expect(h.cancel).toHaveBeenCalledOnce()
    const controller = new AbortController()
    controller.abort()
    expect(() => cancelAuthorization(h.ctx, { key: 'deepseek/api' as never }, controller.signal)).toThrow()
    // A malformed key is refused, never passed to the native service.
    const before = h.cancel.mock.calls.length
    expect(() => cancelAuthorization(h.ctx, { key: 'bad' as never }, new AbortController().signal)).toThrow()
    expect(h.cancel.mock.calls.length).toBe(before)
  })
})

/** Real native concurrency and request-signal ownership, with no credential commit in cancelled flows. */
function nativeFixture() {
  const ctx = new Context()
  nativeContexts.push(ctx)
  ctx.provide('credentials', {} as never)
  const authorization = new AuthorizationService(ctx)
  const key = credentialKey('fixture', 'account')
  const attempts: AbortSignal[] = []
  authorization.registerFlow({
    key, label: 'Fixture', methods: [{ id: 'test', label: 'Test' }],
    async run(session) {
      attempts.push(session.signal)
      await session.prompt({ kind: 'secret', message: 'key', signal: session.signal })
    },
  })
  const link = uplink()
  const remote = ctx.extend({ invocation: { uplink: <T>() => link.iterable as AsyncIterable<T> } as never })
  const caller = new AbortController()
  const stream = () => authorize(remote, { key }, caller.signal)[Symbol.asyncIterator]()
  const independent = () => authorization.begin({
    key,
    interaction: {
      notify() {},
      prompt: request => new Promise<string>((_resolve, reject) => {
        request.signal!.addEventListener('abort', () => { reject(new Error('withdrawn')) }, { once: true })
      }),
    },
  })
  return { ctx, authorization, key, attempts, link, caller, stream, independent }
}

describe('native authorization attempt ownership', () => {
  it('leaves a newer same-key attempt running when a settled Remote stream finally closes', async () => {
    const f = nativeFixture()
    const stream = f.stream()
    await stream.next()
    const prompt = (await stream.next()).value as { operationId: string, promptId: string }
    f.link.push({ ...prompt, type: 'decline' })
    expect((await stream.next()).value).toMatchObject({ type: 'prompt-ended' })
    expect((await stream.next()).value).toMatchObject({ type: 'settled', status: 'cancelled' })
    expect(f.authorization.describe(f.key)?.inFlight).toBe(false)
    const newer = f.independent()
    expect(f.attempts).toHaveLength(2)
    expect(f.authorization.describe(f.key)?.inFlight).toBe(true)
    await stream.return?.(undefined as never)
    expect(f.attempts[1]!.aborted).toBe(false)
    expect(f.authorization.describe(f.key)?.inFlight).toBe(true)
    expect(f.caller.signal.aborted).toBe(false)
    cancelAuthorization(f.ctx, { key: f.key }, new AbortController().signal)
    expect(f.attempts[1]!.aborted).toBe(true)
    await expect(newer).resolves.toEqual({ status: 'cancelled' })
  })

  it('does not cancel a competing native attempt that wins between describe and begin', async () => {
    const f = nativeFixture()
    const describe = f.authorization.describe.bind(f.authorization)
    let competitor: ReturnType<typeof f.independent> | undefined
    vi.spyOn(f.authorization, 'describe').mockImplementationOnce(key => {
      const entry = describe(key)
      competitor = f.independent()
      return entry
    })
    const stream = f.stream()
    await stream.next()
    await expect(stream.next()).rejects.toMatchObject({ code: 'mayflyHost/authorization-in-flight' })
    expect(f.attempts).toHaveLength(1)
    expect(f.attempts[0]!.aborted).toBe(false)
    expect(describe(f.key)?.inFlight).toBe(true)
    cancelAuthorization(f.ctx, { key: f.key }, new AbortController().signal)
    await expect(competitor).resolves.toEqual({ status: 'cancelled' })
  })

  it('withdraws its own native attempt on early stream return without cancelling the caller', async () => {
    const f = nativeFixture()
    const stream = f.stream()
    await stream.next()
    expect(f.authorization.describe(f.key)?.inFlight).toBe(true)
    await stream.return?.(undefined as never)
    expect(f.attempts[0]!.aborted).toBe(true)
    expect(f.authorization.describe(f.key)?.inFlight).toBe(false)
    expect(f.caller.signal.aborted).toBe(false)
  })
})
