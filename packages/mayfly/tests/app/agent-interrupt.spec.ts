/** Agent-tree interruption over the native runtime ownership graph. @module app/tests/agent-interrupt */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { interruptAgentTree } from '../../src/app/agent-interrupt.ts'
import type { MayflyAgentViewSnapshot } from '../../src/app/current-agent.ts'

function fakeAgent(id: string, status: 'idle' | 'running', parentId?: string): Agent {
  return {
    id: SessionId(id),
    status,
    cancel: vi.fn(),
    session: { header: parentId === undefined ? {} : { parentSession: SessionId(parentId) } },
  } as unknown as Agent
}

function primaryView(agent: Agent): MayflyAgentViewSnapshot {
  return { primarySessionId: String(agent.id), displayed: 'primary', auxiliary: null, revision: 1 }
}

function harness(
  agents: readonly Agent[],
  interrupt = vi.fn(),
  interruptByParent = vi.fn(),
): Context {
  const ctx = new Context()
  ctx.provide('agents', {
    list: () => [...agents],
  } as never)
  ctx.provide('subagents', { interrupt, interruptByParent } as never)
  return ctx
}

describe('interruptAgentTree', () => {
  it('interrupts the running primary and all running nested descendants', () => {
    const root = fakeAgent('root', 'running')
    const child = fakeAgent('child', 'running', 'root')
    const nested = fakeAgent('nested', 'running', 'child')
    const idle = fakeAgent('idle', 'idle', 'root')
    const unrelated = fakeAgent('unrelated', 'running')
    const orphan = fakeAgent('orphan', 'running', 'missing')
    const cycleA = fakeAgent('cycle-a', 'running', 'cycle-b')
    const cycleB = fakeAgent('cycle-b', 'running', 'cycle-a')
    const interrupt = vi.fn()
    const ctx = harness([root, nested, child, idle, unrelated, orphan, cycleA, cycleB], interrupt)

    expect(interruptAgentTree(ctx, root, primaryView(root))).toEqual({ requested: true, failures: [] })
    expect(root.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(interrupt).toHaveBeenCalledTimes(2)
    expect(interrupt.mock.calls).toEqual(expect.arrayContaining([
      [child.id, { kind: 'ancestor', agent: root }],
      [nested.id, { kind: 'ancestor', agent: root }],
    ]))
  })

  it('still interrupts a running descendant when the selected Agent is idle', () => {
    const root = fakeAgent('root', 'idle')
    const child = fakeAgent('child', 'running', 'root')
    const interrupt = vi.fn()
    const ctx = harness([root, child], interrupt)

    expect(interruptAgentTree(ctx, root, primaryView(root))).toEqual({ requested: true, failures: [] })
    expect(root.cancel).not.toHaveBeenCalled()
    expect(interrupt).toHaveBeenCalledWith(child.id, { kind: 'ancestor', agent: root })
  })

  it('uses the direct parent address for a selected continuable child', () => {
    const child = fakeAgent('child', 'running')
    const nested = fakeAgent('nested', 'running', 'child')
    const interrupt = vi.fn()
    const interruptByParent = vi.fn()
    const ctx = harness([child, nested], interrupt, interruptByParent)
    const view: MayflyAgentViewSnapshot = {
      primarySessionId: 'parent',
      displayed: 'auxiliary',
      auxiliary: {
        kind: 'subagent', sessionId: 'child', parentSessionId: 'parent', label: 'worker',
        mode: 'continuable', access: 'interactive',
      },
      revision: 2,
    }

    expect(interruptAgentTree(ctx, child, view)).toEqual({ requested: true, failures: [] })
    expect(interruptByParent).toHaveBeenCalledWith(child.id, SessionId('parent'), 'continuable')
    expect(child.cancel).not.toHaveBeenCalled()
    expect(interrupt).toHaveBeenCalledWith(nested.id, { kind: 'ancestor', agent: child })
  })

  it('does nothing when neither the selected Agent nor a descendant is running', () => {
    const root = fakeAgent('root', 'idle')
    const child = fakeAgent('child', 'idle', 'root')
    const interrupt = vi.fn()
    const ctx = harness([root, child], interrupt)
    expect(interruptAgentTree(ctx, root, primaryView(root))).toEqual({ requested: false, failures: [] })
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('contains individual failures and preserves inbox work for retraction', () => {
    const root = fakeAgent('root', 'running')
    const child = fakeAgent('child', 'running', 'root')
    vi.mocked(root.cancel).mockImplementation(() => { throw new Error('root refused') })
    const interrupt = vi.fn(() => { throw 'child refused' })
    const ctx = harness([root, child], interrupt)

    expect(interruptAgentTree(ctx, root, primaryView(root), { keepInbox: true })).toEqual({
      requested: true,
      failures: ['current Agent: root refused', 'subagent child: child refused'],
    })
    expect(root.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
  })
})
