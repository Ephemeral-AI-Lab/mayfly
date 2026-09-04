/**
 * `/btw` auxiliary-Agent ownership, switching, cancellation, and cleanup.
 * @module btw-command
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { MayflyCurrentAgentService } from '../../src/app/current-agent.ts'
import * as btw from '../../src/interaction/btw-command.ts'
import { PaneFakeCommands } from '../transcript/pane-fakes.ts'

interface FakeAgent extends Agent {
  readonly session: {
    readonly header: { readonly cwd: string, readonly agentPreset: string }
    snapshotEvents(): []
    requestHeader(): undefined
  }
  readonly options: { readonly provider: string, readonly model: string }
  readonly status: 'idle'
  readonly followup: ReturnType<typeof vi.fn>
}

function agent(id: string): FakeAgent {
  return {
    id: SessionId(id),
    session: {
      header: { cwd: '/repo', agentPreset: 'default' },
      snapshotEvents: () => [],
      requestHeader: () => undefined,
    },
    options: { provider: 'mock', model: 'mock' },
    status: 'idle',
    followup: vi.fn(),
  } as unknown as FakeAgent
}

async function boot(options: { hold?: boolean, ignoreAbort?: boolean, reject?: unknown } = {}) {
  const ctx = new Context()
  const commands = new PaneFakeCommands()
  const live = new Map<string, FakeAgent>()
  const parent = agent('primary')
  live.set(String(parent.id), parent)
  const handles: Array<{ agent: FakeAgent, dispose: ReturnType<typeof vi.fn> }> = []
  let release: (() => void) | undefined
  const create = vi.fn((request: { readonly sessionId: ReturnType<typeof SessionId>, readonly signal?: AbortSignal }) => {
    if (options.reject !== undefined) return Promise.reject(options.reject)
    const child = agent(String(request.sessionId))
    live.set(String(child.id), child)
    const handle = {
      agent: child,
      dispose: vi.fn(async () => { live.delete(String(child.id)) }),
    }
    handles.push(handle)
    if (options.hold !== true) return Promise.resolve(handle as unknown as AgentHandle)
    return new Promise<AgentHandle>((resolve, reject) => {
      const abort = (): void => {
        if (options.ignoreAbort === true) return
        live.delete(String(child.id))
        reject(new Error('aborted'))
      }
      request.signal?.addEventListener('abort', abort, { once: true })
      release = () => {
        request.signal?.removeEventListener('abort', abort)
        resolve(handle as unknown as AgentHandle)
      }
    })
  })
  const agents = { get: (id: unknown) => live.get(String(id)), create }
  ctx.reflect.provide('commands', commands)
  ctx.reflect.provide('agents', agents)
  ctx.reflect.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  const presetMount = vi.fn(() => Promise.resolve())
  ctx.reflect.provide('agentPresets', { mount: presetMount })
  const begin = vi.fn()
  ctx.reflect.provide('mayflyRequests', { begin })
  const current = new MayflyCurrentAgentService(ctx)
  current.select(parent)
  const fiber = await ctx.plugin(btw)
  return { ctx, commands, current, parent, live, handles, create, begin, presetMount, release: () => release?.(), dispose: () => fiber.dispose() }
}

describe('mayfly-btw-command', () => {
  it('creates an owned Agent and displays it through the current-Agent service', async () => {
    const test = await boot()
    expect(await test.commands.run('btw', 'inspect this')).toEqual({ kind: 'success', text: 'asked the side question' })
    const child = test.handles[0]!.agent
    expect(test.current.primary()).toBe(test.parent)
    expect(test.current.current()).toBe(child)
    expect(test.current.view()).toMatchObject({
      displayed: 'auxiliary',
      auxiliary: { kind: 'btw', parentSessionId: String(test.parent.id), access: 'interactive' },
    })
    expect(child.followup).toHaveBeenCalledOnce()
    expect(test.begin).toHaveBeenCalledWith('btw')

    expect(test.current.toggleAuxiliary()).toBe(true)
    expect(test.current.current()).toBe(test.parent)
    expect(test.current.toggleAuxiliary()).toBe(true)
    expect(test.current.current()).toBe(child)
    await test.dispose()
    expect(test.handles[0]!.dispose).toHaveBeenCalledOnce()
  })

  it('closes immediately and disposes the owned Agent in the background', async () => {
    const test = await boot()
    await test.commands.run('btw', 'question')
    expect(await test.commands.run('btw', '')).toEqual({ kind: 'success', text: 'dismissed the side question' })
    expect(test.current.current()).toBe(test.parent)
    expect(test.current.view().auxiliary).toBeNull()
    await vi.waitFor(() => { expect(test.handles[0]!.dispose).toHaveBeenCalledOnce() })
    await test.dispose()
  })

  it('aborts a pending creation when the global close action fires', async () => {
    const test = await boot({ hold: true })
    const pending = test.commands.run('btw', 'slow question')
    await vi.waitFor(() => { expect(test.create).toHaveBeenCalledOnce() })
    test.ctx.emit('mayfly/request-close-agent-view')
    expect(await pending).toEqual({ kind: 'error', text: 'the side question was replaced before it opened' })
    expect(test.current.current()).toBe(test.parent)
    expect(test.current.view().auxiliary).toBeNull()
    await test.dispose()
  })

  it('ignores the global close action when no creation is pending', async () => {
    const test = await boot()
    test.ctx.emit('mayfly/request-close-agent-view')
    expect(test.create).not.toHaveBeenCalled()
    await test.dispose()
  })

  it('disposes a late handle after the command generation was replaced', async () => {
    const test = await boot({ hold: true, ignoreAbort: true })
    const pending = test.commands.run('btw', 'slow question')
    await vi.waitFor(() => { expect(test.create).toHaveBeenCalledOnce() })
    test.ctx.emit('mayfly/request-close-agent-view')
    test.release()
    expect(await pending).toEqual({ kind: 'error', text: 'the side question was replaced before it opened' })
    await vi.waitFor(() => { expect(test.handles[0]!.dispose).toHaveBeenCalledOnce() })
    await test.dispose()
  })

  it('reports creation failures without changing the primary selection', async () => {
    const test = await boot({ reject: new Error('factory unavailable') })
    expect(await test.commands.run('btw', 'question')).toEqual({
      kind: 'error', text: 'could not start the side session: factory unavailable',
    })
    expect(test.current.current()).toBe(test.parent)
    expect(test.current.view().auxiliary).toBeNull()
    await test.dispose()
  })

  it('inherits the active model and latest preset while bounding the view label', async () => {
    const test = await boot()
    const seed = [
      { type: 'session/start', data: {} },
      { type: 'agent-preset/selected', data: { agentPreset: 'reviewer' } },
    ]
    Object.assign(test.parent.session, {
      snapshotEvents: () => seed,
      requestHeader: () => ({ config: { provider: 'provider-x', model: 'model-y', reasoningEffort: 'high' } }),
    })
    const question = `first line\n${'x'.repeat(80)}`
    expect(await test.commands.run('btw', question)).toMatchObject({ kind: 'success' })
    const request = test.create.mock.calls[0]![0] as unknown as {
      readonly seed: unknown[]
      readonly inheritedEventCount: number
      readonly meta: { readonly isSeeded: boolean }
      readonly agentOptions: { readonly provider: string, readonly model: string, readonly reasoningEffort: string }
      readonly setup: (ctx: Context) => Promise<void>
    }
    expect(request).toMatchObject({
      seed,
      inheritedEventCount: 2,
      meta: { isSeeded: true },
      agentOptions: { provider: 'provider-x', model: 'model-y', reasoningEffort: 'high' },
    })
    const agentCtx = new Context()
    await request.setup(agentCtx)
    expect(test.presetMount).toHaveBeenCalledWith(agentCtx, 'reviewer')
    const label = test.current.view().auxiliary?.label ?? ''
    expect(label).toHaveLength(60)
    expect(label.endsWith('...')).toBe(true)
    expect(label).not.toContain('\n')
    await test.dispose()
  })

  it('reports empty-close and absent-parent requests', async () => {
    const test = await boot()
    expect(await test.commands.run('btw', '')).toEqual({ kind: 'error', text: 'no side question is open' })
    test.current.select(null)
    expect(await test.commands.run('btw', 'question')).toEqual({ kind: 'error', text: 'no active session for a side question' })
    await test.dispose()
  })

  it('disposes the Agent when its initial followup is rejected', async () => {
    for (const reason of [new Error('followup failed'), 'bare followup failure']) {
      const test = await boot()
      test.create.mockImplementationOnce(async (request) => {
        const child = agent(String(request.sessionId))
        child.followup.mockImplementationOnce(() => { throw reason })
        const handle = { agent: child, dispose: vi.fn(async () => {}) }
        test.live.set(String(child.id), child)
        test.handles.push(handle)
        return handle as unknown as AgentHandle
      })
      expect(await test.commands.run('btw', 'question')).toEqual({
        kind: 'error', text: `could not ask the side question: ${reason instanceof Error ? reason.message : reason}`,
      })
      expect(test.handles[0]!.dispose).toHaveBeenCalledOnce()
      expect(test.current.view().auxiliary).toBeNull()
      await test.dispose()
    }
  })

  it('contains disposal failures and cleans up a handle that resolves after unload', async () => {
    const failedDispose = await boot()
    const warn = vi.spyOn(failedDispose.ctx.logger, 'warn')
    await failedDispose.commands.run('btw', 'question')
    failedDispose.handles[0]!.dispose.mockRejectedValueOnce(new Error('dispose failed'))
    expect(await failedDispose.commands.run('btw', '')).toMatchObject({ kind: 'success' })
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('dispose failed')))
    await failedDispose.dispose()

    const bareDispose = await boot()
    const bareWarn = vi.spyOn(bareDispose.ctx.logger, 'warn')
    await bareDispose.commands.run('btw', 'question')
    bareDispose.handles[0]!.dispose.mockRejectedValueOnce('bare dispose failure')
    await bareDispose.commands.run('btw', '')
    await vi.waitFor(() => expect(bareWarn).toHaveBeenCalledWith(expect.stringContaining('bare dispose failure')))
    await bareDispose.dispose()

    const late = await boot({ hold: true, ignoreAbort: true })
    const pending = late.commands.run('btw', 'late question')
    await vi.waitFor(() => expect(late.create).toHaveBeenCalledOnce())
    await late.dispose()
    late.release()
    expect(await pending).toEqual({ kind: 'error', text: 'the side question was replaced before it opened' })
    expect(late.handles[0]!.dispose).toHaveBeenCalledOnce()
  })

  it('normalizes a bare creation failure', async () => {
    const test = await boot({ reject: 'bare factory failure' })
    expect(await test.commands.run('btw', 'question')).toEqual({
      kind: 'error', text: 'could not start the side session: bare factory failure',
    })
    await test.dispose()
  })

  it('falls back to the process cwd when the parent header omits it', async () => {
    const test = await boot()
    Object.assign(test.parent.session, { header: { agentPreset: 'default' } })
    await test.commands.run('btw', 'question')
    expect(test.create.mock.calls[0]?.[0]).toMatchObject({ meta: { cwd: process.cwd() } })
    await test.dispose()
  })
})
