/** Published Gateway event delivery through its real Cordis Client plugin. @module */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionGenerationSource, ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { describe, expect, it, vi } from 'vitest'

// Exercise the same published Client packages as the split frontend. This is
// deliberately not a mock of ctx.remote or ClientRemoteEvents.
const clientRequire = createRequire(new URL('../../../mayfly/package.json', import.meta.url))
const registry = await import(pathToFileURL(clientRequire.resolve('@deepseek-ai/dsh-typert-registry/client')).href)
const gateway = await import(pathToFileURL(clientRequire.resolve('@deepseek-ai/dsh-api-gateway/client')).href)

interface EventRemote {
  $on(event: string, listener: (...args: unknown[]) => unknown): () => void
}

describe('published Gateway forwarded events', () => {
  it('delivers notifications and addressed approvals through actual plugin listeners and cleans them up', async () => {
    const ctx = new Context()
    const abort = new AbortController()
    const frames: unknown[] = []
    let wake: (() => void) | undefined
    let generation: ConnectionGenerationSource | undefined
    let running: Promise<void> | undefined
    const call = vi.fn<ConnectionHandle['rpc']['call']>().mockResolvedValue({ ok: true, value: undefined })
    const push = (frame: unknown): void => {
      frames.push(frame)
      wake?.()
    }
    const open: NonNullable<ConnectionHandle['rpc']['open']> = (_channel, endpoint, _payload, signal) => (async function* () {
      expect(endpoint).toBe('$events')
      const onAbort = (): void => { wake?.() }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        yield { type: 'ready', clientId: 'parity-client', host: { home: '/host' } }
        while (!signal.aborted) {
          if (frames.length > 0) yield frames.shift()
          else await new Promise<void>(resolve => { wake = resolve })
        }
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    })()
    try {
      await ctx.plugin(registry)
      ctx.provide('connection', {
        interactions: 'answer', isLoopback: true, rpc: { call, open },
        openWebSocket: () => { throw new Error('in-process stream must not open a socket') },
        generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
        state: { getSnapshot: () => undefined, subscribe: () => () => {} },
        reconnect: () => {},
        start: () => ({ stop: () => {} }),
        registerGenerationSource: (source: ConnectionGenerationSource) => {
          generation = source
          return () => { abort.abort() }
        },
      } satisfies ConnectionHandle)
      await ctx.plugin(gateway)
      const remote = ctx.get('remote') as EventRemote
      const changed = vi.fn()
      const unsubscribe = remote.$on('mayfly-test/changed', changed)
      const approval = vi.fn(() => 'allowed')
      remote.$on('mayfly-test/approval', approval)
      const target = ctx.extend()
      const typert = ctx.get('typert') as { contexts: { registerClient(name: string, adapter: { identity(candidate: Context): string | undefined, resolve(id: string): Context | undefined }): void } }
      typert.contexts.registerClient('agent', {
        identity: candidate => candidate === target ? 'agent-one' : undefined,
        resolve: id => id === 'agent-one' ? target : undefined,
      })
      await new Promise<void>(resolve => {
        if (generation === undefined) throw new Error('Gateway did not register events')
        running = Promise.resolve(generation(abort.signal, () => resolve()))
      })
      push({ type: 'emit', event: 'mayfly-test/changed', args: ['first'] })
      await vi.waitFor(() => { expect(changed).toHaveBeenCalledWith('first') })
      push({ type: 'waterfall', event: 'mayfly-test/approval', eventId: 'approval-one', agentId: 'agent-one', request: { prompt: 'Allow?' } })
      await vi.waitFor(() => { expect(call).toHaveBeenCalledWith('/api', '$events/result', { args: { clientId: 'parity-client', eventId: 'approval-one', outcome: { kind: 'result', value: 'allowed' } } }, expect.any(AbortSignal)) })
      expect(approval).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Allow?', agent: target, signal: expect.any(AbortSignal) }), expect.any(Function))
      unsubscribe()
      push({ type: 'emit', event: 'mayfly-test/changed', args: ['late'] })
      push({ type: 'waterfall', event: 'mayfly-test/approval', eventId: 'approval-missing', agentId: 'missing', request: {} })
      await vi.waitFor(() => { expect(call).toHaveBeenCalledTimes(2) })
      expect(changed).toHaveBeenCalledTimes(1)
      expect(call.mock.calls[1]?.[2]).toEqual({ args: { clientId: 'parity-client', eventId: 'approval-missing', outcome: { kind: 'next' } } })
    } finally {
      abort.abort()
      wake?.()
      await running
      await ctx.fiber.dispose()
    }
  })
})
