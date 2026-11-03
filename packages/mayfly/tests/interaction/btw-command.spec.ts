/**
 * `/btw` side-conversation ownership: a seeded Agent held for the whole side
 * conversation, the inherited-inbox guard, registration only while the fork
 * provider exists, and disposal on close, replacement, and unload.
 * @module btw-command
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { MayflyCurrentAgentService } from '../../src/app/current-agent.ts'
import { MayflyConversationsService } from '../../src/app/conversation-views.ts'
import * as btw from '../../src/interaction/btw-command.ts'
import { fakeAgent, type FakeAgent } from '../helpers.ts'
import { PaneFakeCommands } from '../transcript/pane-fakes.ts'
import {
  assistantEvent,
  event,
  resetSeq,
  stepEnd,
  stepStart,
  turnEnd,
  turnStart,
  userEvent,
} from '../transcript/helpers.ts'

interface CreatedBtw {
  readonly spec: CreateAgentOptions
  readonly agent: FakeAgent
  readonly handle: AgentHandle
  readonly dispose: ReturnType<typeof vi.fn>
  readonly clear: ReturnType<typeof vi.fn>
}

async function boot(options: {
  readonly hold?: boolean
  readonly ignoreAbort?: boolean
  readonly reject?: unknown
  readonly providers?: readonly string[]
  readonly events?: readonly SessionEvent[]
  readonly headerModel?: string
  readonly headerEffort?: string
  readonly cwd?: string
  readonly clearFailure?: unknown
  readonly followupFailure?: unknown
  readonly inherited?: boolean
} = {}) {
  const ctx = new Context()
  const commands = new PaneFakeCommands()
  const parent = fakeAgent('primary', {
    events: [...options.events ?? []],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.headerModel === undefined ? {} : { headerModel: options.headerModel }),
    ...(options.headerEffort === undefined ? {} : { headerEffort: options.headerEffort }),
  })
  const live = new Map<string, Agent>([[String(parent.id), parent]])
  const created: CreatedBtw[] = []
  let releases: (() => void)[] = []
  let providers = [...options.providers ?? ['fork']]
  const create = vi.fn((spec: CreateAgentOptions) => {
    if (options.reject !== undefined) return Promise.reject(options.reject)
    const agent = fakeAgent(`child-${String(created.length + 1)}`)
    if (options.inherited === true) {
      ;(agent.inbox.nextTurn as unknown[]).push({
        id: 'inherited',
        role: 'user',
        content: [{ type: 'text', text: 'parent queue' }],
        source: { kind: 'user' },
      })
    }
    const clear = vi.fn(() => {
      if (options.clearFailure !== undefined) throw options.clearFailure
      ;(agent.inbox.nextTurn as unknown[]).length = 0
      ;(agent.inbox.nextStep as unknown[]).length = 0
    })
    ;(agent.inbox as unknown as { clear: () => void }).clear = clear
    if (options.followupFailure !== undefined) {
      agent.followup.mockImplementation(() => { throw options.followupFailure })
    }
    const dispose = vi.fn(async () => { live.delete(String(agent.id)) })
    const handle: AgentHandle = { agent, dispose }
    live.set(String(agent.id), agent)
    created.push({ spec, agent, handle, dispose, clear })
    if (options.hold !== true) return Promise.resolve(handle)
    return new Promise<AgentHandle>((resolve, reject) => {
      const abort = (): void => {
        if (options.ignoreAbort === true) return
        live.delete(String(agent.id))
        reject(new Error('aborted'))
      }
      spec.signal?.addEventListener('abort', abort, { once: true })
      releases.push(() => {
        spec.signal?.removeEventListener('abort', abort)
        resolve(handle)
      })
    })
  })
  const begin = vi.fn()
  const list = vi.fn(() => [...providers])
  const mount = vi.fn(async () => ({ id: 'mounted' }))
  const currentSelection = vi.fn(() => ({ provider: 'mock', model: 'mock-default' }))
  ctx.reflect.provide('commands', commands)
  ctx.reflect.provide('mayflyRequests', { begin })
  ctx.reflect.provide('subagents', { list })
  ctx.reflect.provide('agents', { create, get: (id: unknown) => live.get(String(id)) })
  ctx.reflect.provide('agentDefaultModel', { currentSelection })
  ctx.reflect.provide('agentPresets', { mount })
  const conversations = new MayflyConversationsService(ctx)
  const current = new MayflyCurrentAgentService(ctx, conversations)
  conversations.selectPrimary(parent)
  const fiber = await ctx.plugin(btw)
  return {
    ctx, commands, conversations, current, parent, live, created, create, begin, mount, currentSelection, fiber,
    release: () => { for (const release of releases.splice(0)) release() },
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
    absent.ctx.emit('subagent/provider-removed', 'fork')
    absent.setProviders(['fork'])
    absent.ctx.emit('subagent/provider-added', {} as never)
    expect(absent.commands.definitions.has('btw')).toBe(true)
    absent.ctx.emit('subagent/provider-added', {} as never)
    absent.setProviders([])
    absent.ctx.emit('subagent/provider-removed', 'fork')
    expect(absent.commands.definitions.has('btw')).toBe(false)
    await absent.dispose()
  })

  it('creates one seeded Agent for the exact primary and opens its side conversation', async () => {
    resetSeq()
    const events = [
      userEvent('parent question'),
      event('agent-preset/selected', { agentPreset: 'minimal' }),
      turnStart(1),
      stepStart(1, 1),
      assistantEvent(1, 1, [{ type: 'text', text: 'parent answer' }]),
      stepEnd(1, 1),
      turnEnd(1),
    ].map((row, seq) => ({ ...row, seq })) as SessionEvent[]
    const test = await boot({ events, headerModel: 'parent-model', headerEffort: 'high', cwd: '/repo' })
    expect(await test.commands.run('btw', 'inspect this')).toEqual({ kind: 'success', text: 'asked the side question' })

    expect(test.create).toHaveBeenCalledOnce()
    const spec = test.created[0]!.spec
    expect(String(spec.sessionId)).toMatch(/^btw-/u)
    expect(spec.meta).toMatchObject({ cwd: '/repo', parentSession: test.parent.id, isSeeded: true })
    expect(spec.inheritedEventCount).toBe(7)
    expect(spec.seed).toHaveLength(8)
    expect(spec.seed?.at(-1)).toMatchObject({ type: 'session/end-seed' })
    expect(spec.agentOptions).toMatchObject({ model: 'parent-model', reasoningEffort: 'high' })
    expect(spec.signal).toBeInstanceOf(AbortSignal)
    await spec.setup?.(test.ctx, test.created[0]!.agent)
    expect(test.mount).toHaveBeenCalledWith(test.ctx, 'minimal')

    expect(test.current.primary()).toBe(test.parent)
    expect(test.current.current()).toBe(test.created[0]!.agent)
    expect(test.conversations.displayed()).toMatchObject({
      kind: 'btw', parentSessionId: String(test.parent.id), access: 'interactive', residency: 'displayed',
    })
    expect(btwView(test)).toMatchObject({ historyFloorSeq: 6, label: 'inspect this' })
    expect(test.begin).toHaveBeenCalledWith('btw')
    expect(test.created[0]!.agent.followup).toHaveBeenCalledOnce()
    expect(test.created[0]!.agent.followup.mock.calls[0]![0]).toMatchObject({
      content: [{ type: 'text', text: 'inspect this' }],
    })

    await test.dispose()
    expect(test.created[0]!.handle.dispose).toHaveBeenCalledOnce()
  })

  it('skips seed metadata and the history floor for an empty parent log', async () => {
    const test = await boot()
    expect(await test.commands.run('btw', 'question')).toMatchObject({ kind: 'success' })
    const spec = test.created[0]!.spec
    expect(spec.inheritedEventCount).toBeUndefined()
    expect(spec.seed).toEqual([])
    expect(spec.meta).not.toHaveProperty('isSeeded')
    expect(btwView(test)).not.toHaveProperty('historyFloorSeq')
    await test.dispose()
  })

  it('keeps the side conversation open after the answer settles', async () => {
    const test = await boot()
    await test.commands.run('btw', 'question')
    const child = test.created[0]!.agent
    test.ctx.emit('agent/status', { agent: child, status: 'idle' })
    expect(btwView(test)).toBeDefined()
    expect(test.current.current()).toBe(child)
    expect(test.conversations.displayed()).toMatchObject({ kind: 'btw', access: 'interactive' })
    expect(test.created[0]!.handle.dispose).not.toHaveBeenCalled()
    await test.dispose()
  })

  it('clears the inherited parent queue before asking the question', async () => {
    const test = await boot({ inherited: true })
    ;(test.parent.inbox.nextTurn as unknown[]).push({
      id: 'parent-queued',
      role: 'user',
      content: [{ type: 'text', text: 'parent queue' }],
      source: { kind: 'user' },
    })
    expect(await test.commands.run('btw', 'only me')).toMatchObject({ kind: 'success' })
    const created = test.created[0]!
    expect(created.clear).toHaveBeenCalledOnce()
    expect(created.agent.inbox.nextTurn).toHaveLength(0)
    expect(created.agent.inbox.nextStep).toHaveLength(0)
    expect(created.agent.followup).toHaveBeenCalledOnce()
    expect(created.agent.followup.mock.calls[0]![0]).toMatchObject({
      content: [{ type: 'text', text: 'only me' }],
    })
    expect(created.clear.mock.invocationCallOrder[0]!).toBeLessThan(created.agent.followup.mock.invocationCallOrder[0]!)
    // The parent's own queue is untouched: it still belongs to the primary.
    expect(test.parent.inbox.nextTurn).toHaveLength(1)
    await test.dispose()
  })

  it('replaces an open BTW and disposes the previous Agent', async () => {
    const test = await boot()
    expect(await test.commands.run('btw', 'first question')).toMatchObject({ kind: 'success' })
    expect(await test.commands.run('btw', 'replacement question')).toMatchObject({ kind: 'success' })
    expect(test.create).toHaveBeenCalledTimes(2)
    expect(test.created[0]!.handle.dispose).toHaveBeenCalledOnce()
    expect(test.current.current()).toBe(test.created[1]!.agent)
    expect(btwView(test)).toMatchObject({ label: 'replacement question' })
    await test.dispose()
    expect(test.created[1]!.handle.dispose).toHaveBeenCalledOnce()
  })

  it('closes the side conversation and disposes its Agent, and reports nothing open', async () => {
    const test = await boot()
    await test.commands.run('btw', 'question')
    expect(await test.commands.run('btw', '')).toEqual({ kind: 'success', text: 'dismissed the side question' })
    expect(test.current.current()).toBe(test.parent)
    expect(btwView(test)).toBeUndefined()
    await vi.waitFor(() => { expect(test.created[0]!.handle.dispose).toHaveBeenCalledOnce() })
    expect(await test.commands.run('btw', '')).toEqual({ kind: 'error', text: 'no side question is open' })
    await test.dispose()
  })

  it('disposes the Agent when the side conversation closes through F8', async () => {
    const test = await boot()
    await test.commands.run('btw', 'question')
    test.conversations.close()
    await vi.waitFor(() => { expect(test.created[0]!.handle.dispose).toHaveBeenCalledOnce() })
    expect(test.current.current()).toBe(test.parent)
    await test.dispose()
  })

  it('aborts a pending create when the global close action fires', async () => {
    const test = await boot({ hold: true })
    const pending = test.commands.run('btw', 'slow question')
    await vi.waitFor(() => { expect(test.create).toHaveBeenCalledOnce() })
    test.ctx.emit('mayfly/request-close-conversation')
    expect(await pending).toEqual({ kind: 'error', text: 'the side question was replaced before it opened' })
    expect(btwView(test)).toBeUndefined()
    await test.dispose()
  })

  it('disposes a late Agent after the request generation was replaced', async () => {
    const test = await boot({ hold: true, ignoreAbort: true })
    const pending = test.commands.run('btw', 'slow question')
    await vi.waitFor(() => { expect(test.create).toHaveBeenCalledOnce() })
    test.ctx.emit('mayfly/request-close-conversation')
    test.release()
    expect(await pending).toEqual({ kind: 'error', text: 'the side question was replaced before it opened' })
    await vi.waitFor(() => { expect(test.created[0]!.handle.dispose).toHaveBeenCalledOnce() })
    await test.dispose()
  })

  it('discards a late Agent once the primary it asked from was replaced', async () => {
    const test = await boot({ hold: true, ignoreAbort: true })
    const pending = test.commands.run('btw', 'slow question')
    await vi.waitFor(() => { expect(test.create).toHaveBeenCalledOnce() })
    const next = fakeAgent('next-primary')
    test.live.set(String(next.id), next)
    test.conversations.selectPrimary(next)
    test.release()
    expect(await pending).toEqual({ kind: 'error', text: 'the side question was replaced before it opened' })
    expect(test.created[0]!.handle.dispose).toHaveBeenCalledOnce()
    expect(btwView(test)).toBeUndefined()
    await test.dispose()
  })

  it('replaces a still-pending request when a new /btw arrives', async () => {
    const test = await boot({ hold: true })
    const first = test.commands.run('btw', 'first question')
    await vi.waitFor(() => { expect(test.create).toHaveBeenCalledTimes(1) })
    const second = test.commands.run('btw', 'second question')
    expect(await first).toEqual({ kind: 'error', text: 'the side question was replaced before it opened' })
    test.release()
    expect(await second).toMatchObject({ kind: 'success' })
    expect(test.created).toHaveLength(2)
    expect(test.current.current()).toBe(test.created[1]!.agent)
    await test.dispose()
  })

  it('closes an open side question when the fork provider is removed', async () => {
    const test = await boot()
    await test.commands.run('btw', 'question')
    test.setProviders([])
    test.ctx.emit('subagent/provider-removed', 'fork')
    await vi.waitFor(() => { expect(test.created[0]!.handle.dispose).toHaveBeenCalledOnce() })
    expect(btwView(test)).toBeUndefined()
    expect(test.commands.definitions.has('btw')).toBe(false)
    await test.dispose()
  })

  it('reports create failures without changing the primary selection', async () => {
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
    for (const failure of [new Error('dispose failed'), 'bare dispose failure']) {
      await test.commands.run('btw', 'question')
      const warn = vi.spyOn(test.ctx.logger, 'warn')
      test.created.at(-1)!.dispose.mockRejectedValueOnce(failure)
      expect(await test.commands.run('btw', '')).toMatchObject({ kind: 'success' })
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('dispose failed')))
    }
    await test.dispose()
  })

  it('cleans up a pending create when the plugin unloads', async () => {
    const test = await boot({ hold: true, ignoreAbort: true })
    const pending = test.commands.run('btw', 'late question')
    await vi.waitFor(() => { expect(test.create).toHaveBeenCalledOnce() })
    await test.dispose()
    test.release()
    expect(await pending).toEqual({ kind: 'error', text: 'the side question was replaced before it opened' })
    expect(test.created[0]!.handle.dispose).toHaveBeenCalledOnce()
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
    await vi.waitFor(() => { expect(test.created[0]!.handle.dispose).toHaveBeenCalledOnce() })
    expect(btwView(test)).toBeUndefined()
    expect(test.current.current()).toBe(test.parent)
    await test.dispose()
  })

  it('refuses a side question once the fork provider vanished before the command was removed', async () => {
    const test = await boot()
    test.setProviders([])
    expect(await test.commands.run('btw', 'question')).toEqual({ kind: 'error', text: 'side questions need the native fork subagent provider' })
    expect(test.create).not.toHaveBeenCalled()
    await test.dispose()
  })

  it('reports inherited-inbox clear failures and disposes the fresh Agent', async () => {
    for (const failure of [new Error('clear failed'), 'bare clear failure']) {
      const test = await boot({ clearFailure: failure })
      expect(await test.commands.run('btw', 'question')).toEqual({
        kind: 'error',
        text: `could not start the side session: ${failure instanceof Error ? failure.message : failure}`,
      })
      expect(test.created[0]!.handle.dispose).toHaveBeenCalledOnce()
      expect(btwView(test)).toBeUndefined()
      await test.dispose()
    }
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
      expect(test.created[0]!.handle.dispose).toHaveBeenCalledOnce()
      await test.dispose()
    }
  })

  it('reports question-delivery failures, closes the view, and disposes', async () => {
    for (const failure of [new Error('followup failed'), 'bare followup failure']) {
      const test = await boot({ followupFailure: failure })
      expect(await test.commands.run('btw', 'question')).toEqual({
        kind: 'error',
        text: `could not ask the side question: ${failure instanceof Error ? failure.message : failure}`,
      })
      expect(btwView(test)).toBeUndefined()
      expect(test.created[0]!.handle.dispose).toHaveBeenCalledOnce()
      await test.dispose()
    }
  })

  it('disposes the held Agent when another side conversation replaces the BTW view', async () => {
    const test = await boot()
    await test.commands.run('btw', 'question')
    // A directly opened BTW view for another live session replaces the owned one in the registry.
    test.live.set('other-session', fakeAgent('other-session'))
    test.conversations.open({ kind: 'btw', sessionId: 'other-session', parentSessionId: String(test.parent.id), label: 'other' })
    await vi.waitFor(() => { expect(test.created[0]!.handle.dispose).toHaveBeenCalledOnce() })
    await test.dispose()
  })

  it('keeps the held Agent when the snapshot still names it beside another side view', async () => {
    const test = await boot()
    test.conversations.open({ kind: 'subagent', sessionId: 'child-x', parentSessionId: String(test.parent.id), label: 'child', mode: 'continuable' })
    await test.commands.run('btw', 'question')
    expect(test.created[0]!.handle.dispose).not.toHaveBeenCalled()
    // Closing the BTW leaves the subagent view: the subscription evaluates a non-BTW view before disposing.
    expect(await test.commands.run('btw', '')).toMatchObject({ kind: 'success' })
    await vi.waitFor(() => { expect(test.created[0]!.handle.dispose).toHaveBeenCalledOnce() })
    await test.dispose()
  })
})
