/** Public native Session history validates durable child addresses and passive tree reads. @module */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import { SessionId, SessionStore, type Session } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { SUBAGENT_DESCRIPTOR_VERSION, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { afterEach, expect, it, vi } from 'vitest'
import { subagentTree } from '../../src/remote/subagent.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

/** Search is unrelated to the native live-preferred point observations under test. */
class PointQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('unexpected search')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('unexpected event search')) }
}

/** Initialize the installed public service while supplying only its unrelated composition seams. */
class NativeSessionController extends SessionController {
  initialize(): Promise<void> { return this[Service.init]() }
}

class NativeSubagents extends SubagentRuntime {
  initialize(): Promise<void> { return this[Service.init]() }
}

async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  new PointQuery(ctx)
  const noop = () => () => {}
  ctx.provide('typert', { lookups: { configure: noop }, contexts: { configureHost: noop }, resources: { register: noop } } as never)
  ctx.provide('fileUploads', { registerAgentResolver: noop } as never)
  ctx.provide('attachments', { imageLimits: { maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1, maxImagePixels: 1, maxImageDimension: 1, mediaTypes: ['image/png'] } } as never)
  const subagents = new NativeSubagents(ctx, SubagentRuntime.Config({}))
  await subagents.initialize()
  const agents = new Map<string, Agent>()
  ctx.provide('agents', { get: (id: string) => agents.get(id) } as never)
  const controller = new NativeSessionController(ctx, {})
  await controller.initialize()
  const root = ctx.sessions.create(SessionId('root'), { meta: { cwd: '/workspace' } })
  const resident = (session: Session) => {
    const agent = { id: session.id, session, status: 'idle' } as Agent
    agents.set(session.id, agent)
    return agent
  }
  resident(root)
  const child = (parent: Session, name: string, mode: 'continuable' | 'one-shot', live = true) => {
    const session = ctx.sessions.create(SessionId(name), { meta: { cwd: '/workspace', origin: 'subagent', parentSession: parent.id } })
    session.append('subagent/descriptor', { version: SUBAGENT_DESCRIPTOR_VERSION, mode, provider: 'fixture', label: name })
    parent.append('subagent/catalog', { version: 0, childId: session.id, childCreatedAt: session.header.createdAt, mode, label: name })
    if (live) resident(session)
    return session
  }
  const workflows = { snapshot: () => ({ sessionId: root.id, runs: [] }) }
  const tree = () => subagentTree(ctx, { sessionId: root.id }, new AbortController().signal, workflows)
  return { ctx, root, child, controller, tree }
}

it('opens real direct and nested child histories with their durable parents while native ordinary addresses refuse them', async () => {
  const f = await fixture()
  const parent = f.child(f.root, 'parent', 'continuable')
  const nested = f.child(parent, 'nested', 'one-shot')
  f.child(f.root, 'cold', 'continuable', false)
  const ordinary = f.controller.follow({ address: { kind: 'session', sessionId: parent.id } }, new AbortController().signal)[Symbol.asyncIterator]()
  await expect(ordinary.next()).rejects.toMatchObject({ code: 'session/agent-busy', message: 'subagent Sessions require their durable parent address' })
  const wrongParent = f.controller.follow({ address: { kind: 'subagent', parentSessionId: f.root.id, childSessionId: nested.id, mode: 'one-shot' } }, new AbortController().signal)[Symbol.asyncIterator]()
  await expect(wrongParent.next()).rejects.toMatchObject({ code: 'subagent/unauthorized' })
  const follow = vi.spyOn(f.controller, 'follow')
  const resolve = vi.spyOn(f.controller, 'resolveAgent')
  expect(await f.tree()).toMatchObject([
    { id: parent.id, parentId: f.root.id, mode: 'continuable', live: true },
    { id: nested.id, parentId: parent.id, mode: 'one-shot', live: true },
    { id: 'cold', mode: 'continuable', live: false },
  ])
  expect(follow).toHaveBeenCalledTimes(2)
  expect(resolve).not.toHaveBeenCalled()
})
