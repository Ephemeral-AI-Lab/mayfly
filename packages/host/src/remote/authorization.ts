/** Structured native authorization operations with addressed prompt answers and cancellation. @module */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { AuthorizationDeclinedError, AuthorizationError, type AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { RemoteError, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import type { MayflyAuthorizationAnswer, MayflyAuthorizationFrame, MayflyAuthorizationPrompt, MayflyAuthorizationRequest } from '../types.ts'
import { ChangeQueue } from './queue.ts'

interface PendingPrompt {
  readonly resolve: (value: string) => void
  readonly reject: (error: unknown) => void
}

function failure(key: string, error: unknown): RemoteError<'mayflyHost/authorization-failed'> {
  void error
  return new RemoteError('mayflyHost/authorization-failed', `authorization for "${key}" failed`, { key })
}

function unavailable(key: string): RemoteError<'mayflyHost/authorization-unavailable'> {
  return new RemoteError('mayflyHost/authorization-unavailable', `no authorization flow or requested method exists for "${key}"`, { key })
}

function inFlight(key: string): RemoteError<'mayflyHost/authorization-in-flight'> {
  return new RemoteError('mayflyHost/authorization-in-flight', `authorization for "${key}" is already running`, { key })
}

function mapFailure(key: string, error: unknown): unknown {
  if (error instanceof AuthorizationError) {
    if (error.code === 'NO_FLOW' || error.code === 'UNKNOWN_METHOD') return unavailable(key)
    if (error.code === 'ALREADY_IN_FLIGHT') return inFlight(key)
  }
  return failure(key, error)
}

function publicPrompt(request: AuthorizationPrompt): MayflyAuthorizationPrompt {
  switch (request.kind) {
    case 'text':
    case 'secret':
      return { kind: request.kind, message: request.message, ...request.placeholder === undefined ? {} : { placeholder: request.placeholder } }
    case 'select':
      return { kind: 'select', message: request.message, options: request.options.map(option => ({ ...option })) }
  }
}

function authorizationKey(value: string): ReturnType<typeof credentialKey> {
  const parts = value.split('/')
  if (parts.length !== 2) throw unavailable(value)
  try {
    return credentialKey(parts[0]!, parts[1]!)
  } catch {
    throw unavailable(value)
  }
}

/** Run one native authorization operation; secret answers travel only from uplink to the native prompt. */
export async function* authorize(ctx: Context, request: MayflyAuthorizationRequest, signal: AbortSignal): RemoteStream<MayflyAuthorizationFrame> {
  const key = authorizationKey(request.key)
  const entry = ctx.authorization.describe(key)
  if (entry === undefined || request.method !== undefined && !entry.methods.some(method => method.id === request.method)) throw unavailable(key)
  if (entry.inFlight) throw inFlight(key)
  const invocation = ctx.invocation
  if (invocation === undefined) throw new RemoteError('gateway/internal', 'authorization requires a Remote invocation', {})
  const uplink = invocation.uplink<MayflyAuthorizationAnswer>()
  const iterator = uplink[Symbol.asyncIterator]()
  const operationId = randomUUID()
  const frames = new ChangeQueue<MayflyAuthorizationFrame>(signal)
  const pending = new Map<string, PendingPrompt>()
  let sequence = 0
  const task = (async () => {
    try {
      const outcome = await ctx.authorization.begin({
        key,
        ...request.method === undefined ? {} : { method: request.method },
        signal,
        interaction: {
          notify: notice => { frames.push({ type: 'notice', operationId, notice }) },
          prompt: async prompt => {
            const promptId = `${operationId}:${String(++sequence)}`
            const deferred = Promise.withResolvers<string>()
            pending.set(promptId, deferred)
            frames.push({ type: 'prompt', operationId, promptId, prompt: publicPrompt(prompt) })
            const withdraw = (): void => { deferred.reject(new Error('Authorization prompt withdrawn')) }
            prompt.signal?.addEventListener('abort', withdraw, { once: true })
            signal.addEventListener('abort', withdraw, { once: true })
            if (prompt.signal?.aborted === true || signal.aborted) withdraw()
            try {
              return await deferred.promise
            } finally {
              prompt.signal?.removeEventListener('abort', withdraw)
              signal.removeEventListener('abort', withdraw)
              pending.delete(promptId)
              frames.push({ type: 'prompt-ended', operationId, promptId })
            }
          },
        },
      })
      frames.push({ type: 'settled', operationId, status: outcome.status })
      frames.finish()
    } catch (error) {
      frames.fail(mapFailure(key, error))
    }
  })()
  const answers = (async () => {
    try {
      while (true) {
        const next = await iterator.next()
        if (next.done === true) break
        const answer = next.value
        if (answer.operationId !== operationId) continue
        const prompt = pending.get(answer.promptId)
        if (prompt === undefined) continue
        if (answer.type === 'answer') prompt.resolve(answer.value)
        else prompt.reject(new AuthorizationDeclinedError())
      }
    } catch (error) {
      for (const prompt of pending.values()) prompt.reject(error)
      frames.fail(error)
    }
  })()
  try {
    yield { type: 'started', operationId }
    while (true) {
      const next = await frames.next()
      if (next.done === true) break
      yield next.value
    }
    await task
  } finally {
    ctx.authorization.cancel(key)
    for (const prompt of pending.values()) prompt.reject(new Error('Authorization operation closed'))
    pending.clear()
    frames.finish()
    await iterator.return?.()
    await Promise.allSettled([task, answers])
  }
}

/** Cancel the native attempt for one credential without affecting any other flow. */
export function cancelAuthorization(ctx: Context, request: MayflyAuthorizationRequest, signal: AbortSignal): void {
  signal.throwIfAborted()
  ctx.authorization.cancel(authorizationKey(request.key))
}
