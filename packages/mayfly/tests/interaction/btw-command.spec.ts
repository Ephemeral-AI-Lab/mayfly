/**
 * `/btw` side-conversation ownership over the native fork activation:
 * registration only while the provider exists, exact-parent requests, the
 * side conversation, and disposal on close, replacement, and unload.
 * @module btw-command
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it, vi } from 'vitest'
import { MayflyCurrentAgentService } from '../../src/app/current-agent.ts'
import { MayflyConversationsService } from '../../src/app/conversation-views.ts'
import * as btw from '../../src/interaction/btw-command.ts'
import { fakeAgent } from '../helpers.ts'
import { PaneFakeCommands } from '../transcript/pane-fakes.ts'

type ActivationFake = SubagentActivation & {
  readonly dispose: ReturnType<typeof vi.fn>
  readonly result: Promise<never>
}

async function boot(options: {
  readonly hold?: boolean
  readonly ignoreAbort?: boolean
  readonly reject?: unknown
  readonly providers?: readonly string[]
  readonly firstLiveSeq?: number
  readonly unregistered?: boolean
  readonly resultReject?: unknown
} = {}) {
  const ctx = new Context()
  const commands = new PaneFakeCommands()
  const parent = fakeAgent('primary')
  const live = new Map<string, Agent>([[String(parent.id), parent]])
  const activations: ActivationFake[] = []
  const children: Agent[] = []
  let release: (() => void) | undefined
  let providers = [...options.providers ?? ['fork']]
  const startActivation = vi.fn((spec: {
    readonly provider: string
    readonly label: string
    readonly request: { readonly parent: Agent, readonly prompt: readonly unknown[] }
    readonly delivery: string
    readonly signal: AbortSignal
  }) => {
    if (options.reject !== undefined) return Promise.reject(options.reject)
    const child = fakeAgent(`child-${String(activations.length + 1)}`)
    const session = child.session as unknown as { firstLiveSeq: number }
    session.firstLiveSeq = options.firstLiveSeq ?? 3
    if (options.unregistered !== true) live.set(String(child.id), child)
    children.push(child)
    let disposed = false
    const rejected = options.resultReject === undefined ? undefined : Promise.reject(options.resultReject)
    void rejected?.catch(() => {})
    const activation: ActivationFake = {
      childId: child.id,
      result: (rejected ?? new Promise<never>(() => {})) as Promise<never>,
      dispose: vi.fn(async () => {
        if (disposed) return
        disposed = true
        live.delete(String(child.id))
      }),
    }
    activations.push(activation)
    if (options.hold !== true) return Promise.resolve(activation)
    return new Promise<ActivationFake>((resolve, reject) => {
      const abort = (): void => {
        if (options.ignoreAbort === true) return
        live.delete(String(child.id))
        reject(new Error('aborted'))
      }
      spec.signal.addEventListener('abort', abort, { once: true })
      release = () => {
        spec.signal.removeEventListener('abort', abort)
        resolve(activation)
      }
    })
  })
  const begin = vi.fn()
  const list = vi.fn(() => [...providers])
  ctx.reflect.provide('commands', commands)
  ctx.reflect.provide('mayflyRequests', { begin })
  ctx.reflect.provide('subagents', { list, startActivation })
  ctx.reflect.provide('agents', { get: (id: unknown) => live.get(String(id)) })
  const conversations = new MayflyConversationsService(ctx)
  const current = new MayflyCurrentAgentService(ctx, conversations)
  conversations.selectPrimary(parent)
  const fiber = await ctx.plugin(btw)
  return {
    ctx, commands, conversations, current, parent, live, activations, children, startActivation, begin, fiber,
    release: () => release?.(),
    setProviders(next: readonly string[]) { providers = [...next] },
    dispose: () => fiber.dispose(),
  }
}

/** The open BTW conversation, if any. */
function btwView(test: { readonly conversations: MayflyConversationsService }) {
  return test.conversations.snapshot().views.find(view => view.kind === 'btw')
}

describe('mayfly-btw-command', () => {
  it('registers /btw only while the native fork provider is composed', async () => {
    const absent = await boot({ providers: [] })
    expect(absent.commands.definitions.has('btw')).toBe(false)
    absent.setProviders(['fork'])
    absent.ctx.emit('subagent/provider-added', {} as never)
    expect(absent.commands.definitions.has('btw')).toBe(true)
    absent.setProviders([])
    absent.ctx.emit('subagent/provider-removed', 'fork')
    expect(absent.commands.definitions.has('btw')).toBe(false)
    await absent.dispose()
  })

  it('starts one caller-delivery fork activation for the exact primary and opens its side conversation', async () => {
    const test = await boot()
    expect(await test.commands.run('btw', 'inspect this')).toEqual({ kind: 'success', text: 'asked the side question' })
    expect(test.startActivation).toHaveBeenCalledWith({
      provider: 'fork',
      label: 'btw',
      request: { parent: test.parent, prompt: [{ type: 'text', text: 'inspect this' }] },
      delivery: 'caller',
      signal: expect.any(AbortSignal),
    })
    expect(test.current.primary()).toBe(test.parent)
    expect(test.current.current()).toBe(test.children[0])
    expect(test.conversations.displayed()).toMatchObject({
      kind: 'btw', parentSessionId: String(test.parent.id), access: 'interactive', residency: 'displayed',
    })
    expect(btwView(test)).toMatchObject({ historyFloorSeq: 2 })
    expect(test.begin).toHaveBeenCalledWith('btw')
    await test.dispose()
    expect(test.activations[0]!.dispose).toHaveBeenCalledOnce()
  })

  it('replaces an open BTW and disposes the previous activation', async () => {
    const test = await boot()
    expect(await test.commands.run('btw', 'first question')).toMatchObject({ kind: 'success' })
    expect(await test.commands.run('btw', 'replacement question')).toMatchObject({ kind: 'success' })
    expect(test.startActivation).toHaveBeenCalledTimes(2)
    expect(test.activations[0]!.dispose).toHaveBeenCalledOnce()
    expect(test.current.current()).toBe(test.children[1])
    await test.dispose()
    expect(test.activations[1]!.dispose).toHaveBeenCalledOnce()
  })

  it('closes the side conversation and disposes its activation, and reports nothing open', async () => {
    const test = await boot()
    await test.commands.run('btw', 'question')
    expect(await test.commands.run('btw', '')).toEqual({ kind: 'success', text: 'dismissed the side question' })
    expect(test.current.current()).toBe(test.parent)
    expect(btwView(test)).toBeUndefined()
    await vi.waitFor(() => { expect(test.activations[0]!.dispose).toHaveBeenCalledOnce() })
    expect(await test.commands.run('btw', '')).toEqual({ kind: 'error', text: 'no side question is open' })
    await test.dispose()
  })

  it('disposes the activation when the side conversation closes through F8', async () => {
    const test = await boot()
    await test.commands.run('btw', 'question')
    test.conversations.close()
    await vi.waitFor(() => { expect(test.activations[0]!.dispose).toHaveBeenCalledOnce() })
    expect(test.current.current()).toBe(test.parent)
    await test.dispose()
  })

  it('aborts a pending start when the global close action fires', async () => {
    const test = await boot({ hold: true })
    const pending = test.commands.run('btw', 'slow question')
    await vi.waitFor(() => { expect(test.startActivation).toHaveBeenCalledOnce() })
    test.ctx.emit('mayfly/request-close-conversation')
    expect(await pending).toEqual({ kind: 'error', text: 'the side question was replaced before it opened' })
    expect(btwView(test)).toBeUndefined()
    await test.dispose()
  })

  it('disposes a late activation after the request generation was replaced', async () => {
    const test = await boot({ hold: true, ignoreAbort: true })
    const pending = test.commands.run('btw', 'slow question')
    await vi.waitFor(() => { expect(test.startActivation).toHaveBeenCalledOnce() })
    test.ctx.emit('mayfly/request-close-conversation')
    test.release()
    expect(await pending).toEqual({ kind: 'error', text: 'the side question was replaced before it opened' })
    await vi.waitFor(() => { expect(test.activations[0]!.dispose).toHaveBeenCalledOnce() })
    await test.dispose()
  })

  it('discards a late activation once the primary it asked from was replaced', async () => {
    const test = await boot({ hold: true, ignoreAbort: true })
    const pending = test.commands.run('btw', 'slow question')
    await vi.waitFor(() => { expect(test.startActivation).toHaveBeenCalledOnce() })
    const next = fakeAgent('next-primary')
    test.live.set(String(next.id), next)
    test.conversations.selectPrimary(next)
    test.release()
    expect(await pending).toEqual({ kind: 'error', text: 'the side question was replaced before it opened' })
    expect(test.activations[0]!.dispose).toHaveBeenCalledOnce()
    expect(btwView(test)).toBeUndefined()
    await test.dispose()
  })

  it('closes an open side question when the fork provider is removed', async () => {
    const test = await boot()
    await test.commands.run('btw', 'question')
    test.setProviders([])
    test.ctx.emit('subagent/provider-removed', 'fork')
    await vi.waitFor(() => { expect(test.activations[0]!.dispose).toHaveBeenCalledOnce() })
    expect(btwView(test)).toBeUndefined()
    expect(test.commands.definitions.has('btw')).toBe(false)
    await test.dispose()
  })

  it('reports start failures without changing the primary selection', async () => {
    for (const reject of [new Error('factory unavailable'), 'bare factory failure']) {
      const test = await boot({ reject })
      expect(await test.commands.run('btw', 'question')).toEqual({
        kind: 'error',
        text: `could not start the side session: ${reject instanceof Error ? reject.message : reject}`,
      })
      expect(test.current.current()).toBe(test.parent)
      expect(btwView(test)).toBeUndefined()
      await test.dispose()
    }
  })

  it('bounds the view label and keeps the side question on one line', async () => {
    const test = await boot()
    const question = `first line\n${'x'.repeat(80)}`
    expect(await test.commands.run('btw', question)).toMatchObject({ kind: 'success' })
    const label = btwView(test)?.label ?? ''
    expect(label).toHaveLength(60)
    expect(label.endsWith('...')).toBe(true)
    expect(label).not.toContain('\n')
    await test.dispose()
  })

  it('reports an absent primary and contains disposal failures', async () => {
    const test = await boot()
    test.conversations.selectPrimary(null)
    expect(await test.commands.run('btw', 'question')).toEqual({ kind: 'error', text: 'no active session for a side question' })
    test.conversations.selectPrimary(test.parent)
    await test.commands.run('btw', 'question')
    const warn = vi.spyOn(test.ctx.logger, 'warn')
    test.activations[0]!.dispose.mockRejectedValueOnce(new Error('dispose failed'))
    expect(await test.commands.run('btw', '')).toMatchObject({ kind: 'success' })
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('dispose failed')))
    await test.dispose()
  })

  it('cleans up a pending activation when the plugin unloads', async () => {
    const test = await boot({ hold: true, ignoreAbort: true })
    const pending = test.commands.run('btw', 'late question')
    await vi.waitFor(() => { expect(test.startActivation).toHaveBeenCalledOnce() })
    await test.dispose()
    test.release()
    expect(await pending).toEqual({ kind: 'error', text: 'the side question was replaced before it opened' })
    expect(test.activations[0]!.dispose).toHaveBeenCalledOnce()
  })

  it('ignores a global close request when nothing is open and closes an open side question', async () => {
    const idle = await boot()
    idle.ctx.emit('mayfly/request-close-conversation')
    expect(idle.current.current()).toBe(idle.parent)
    await idle.dispose()

    const test = await boot()
    await test.commands.run('btw', 'question')
    expect(btwView(test)).toBeDefined()
    test.ctx.emit('mayfly/request-close-conversation')
    await vi.waitFor(() => { expect(test.activations[0]!.dispose).toHaveBeenCalledOnce() })
    expect(btwView(test)).toBeUndefined()
    expect(test.current.current()).toBe(test.parent)
    await test.dispose()
  })

  it('refuses a side question once the fork provider vanished before the command was removed', async () => {
    const test = await boot()
    test.setProviders([])
    expect(await test.commands.run('btw', 'question')).toEqual({ kind: 'error', text: 'side questions need the native fork subagent provider' })
    expect(test.startActivation).not.toHaveBeenCalled()
    await test.dispose()
  })

  it('contains non-Error activation-result failures and disposal failures', async () => {
    for (const failure of [new Error('result failed'), 'bare result failure']) {
      const test = await boot({ resultReject: failure })
      const warn = vi.spyOn(test.ctx.logger, 'warn')
      expect(await test.commands.run('btw', 'question')).toMatchObject({ kind: 'success' })
      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledWith(`BTW activation ${String(test.children[0]!.id)} failed: ${failure instanceof Error ? failure.message : failure}`)
      })
      test.activations[0]!.dispose.mockRejectedValueOnce(failure)
      expect(await test.commands.run('btw', '')).toMatchObject({ kind: 'success' })
      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledWith(`could not dispose BTW activation ${String(test.children[0]!.id)}: ${failure instanceof Error ? failure.message : failure}`)
      })
      await test.dispose()
    }
  })

  it('disposes a start whose child never reached the Agent registry', async () => {
    const test = await boot({ unregistered: true })
    expect(await test.commands.run('btw', 'question')).toEqual({ kind: 'error', text: 'the side question was replaced before it opened' })
    expect(test.activations[0]!.dispose).toHaveBeenCalledOnce()
    expect(btwView(test)).toBeUndefined()
    await test.dispose()
  })

  it('skips the history floor for a child with no inherited live events', async () => {
    const test = await boot({ firstLiveSeq: 0 })
    expect(await test.commands.run('btw', 'question')).toMatchObject({ kind: 'success' })
    expect(btwView(test)).not.toHaveProperty('historyFloorSeq')
    await test.dispose()
  })

  it('reports side-conversation open failures for Error and non-Error throws', async () => {
    for (const failure of [new Error('open failed'), 'bare open failure']) {
      const test = await boot()
      const open = vi.spyOn(test.conversations, 'open').mockImplementationOnce(() => { throw failure })
      expect(await test.commands.run('btw', 'question')).toEqual({
        kind: 'error',
        text: `could not open the side session: ${failure instanceof Error ? failure.message : failure}`,
      })
      expect(open).toHaveBeenCalledOnce()
      expect(test.activations[0]!.dispose).toHaveBeenCalledOnce()
      await test.dispose()
    }
  })

  it('disposes the owned activation when another side conversation replaces the BTW view', async () => {
    const test = await boot()
    await test.commands.run('btw', 'question')
    // A directly opened BTW view for another live session replaces the owned one in the registry.
    test.live.set('other-session', fakeAgent('other-session'))
    test.conversations.open({ kind: 'btw', sessionId: 'other-session', parentSessionId: String(test.parent.id), label: 'other' })
    await vi.waitFor(() => { expect(test.activations[0]!.dispose).toHaveBeenCalledOnce() })
    await test.dispose()
  })

  it('keeps the owned activation when the snapshot still names it beside another side view', async () => {
    const test = await boot()
    test.conversations.open({ kind: 'subagent', sessionId: 'child-x', parentSessionId: String(test.parent.id), label: 'child', mode: 'continuable' })
    await test.commands.run('btw', 'question')
    expect(test.activations[0]!.dispose).not.toHaveBeenCalled()
    // Closing the BTW leaves the subagent view: the subscription evaluates a non-BTW view before disposing.
    expect(await test.commands.run('btw', '')).toMatchObject({ kind: 'success' })
    await vi.waitFor(() => { expect(test.activations[0]!.dispose).toHaveBeenCalledOnce() })
    await test.dispose()
  })
})
