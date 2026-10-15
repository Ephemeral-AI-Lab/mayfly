/** The interrupt stops the selected Agent's current turn only. @module app/tests/agent-interrupt */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { interruptAgent, isAgentRunning } from '../../src/app/agent-interrupt.ts'
import { fakeAgent } from '../helpers.ts'
import type { MayflyConversationView } from '../../src/app/conversation-views.ts'

function primaryView(agent: Agent): MayflyConversationView {
  return { kind: 'primary', id: `session:${String(agent.id)}`, sessionId: String(agent.id), access: 'interactive', residency: 'displayed' }
}

function harness(interrupt = vi.fn(), interruptByParent = vi.fn()): Context {
  const ctx = new Context()
  ctx.provide('subagents', { interrupt, interruptByParent } as never)
  return ctx
}

describe('interruptAgent', () => {
  it('cancels the running Agent with its queued and steering messages kept, and touches no subagent', () => {
    const root = fakeAgent('root', { status: 'running' })
    const interrupt = vi.fn()
    const ctx = harness(interrupt)

    expect(interruptAgent(ctx, root, primaryView(root))).toEqual({ requested: true, failures: [] })
    expect(root.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('does nothing for an idle Agent, even when a subagent runs', () => {
    const root = fakeAgent('root', { status: 'idle' })
    const interrupt = vi.fn()
    const ctx = harness(interrupt)

    expect(interruptAgent(ctx, root, primaryView(root))).toEqual({ requested: false, failures: [] })
    expect(root.cancel).not.toHaveBeenCalled()
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('uses the direct parent address for a displayed continuable child, and only for it', () => {
    const child = fakeAgent('child', { status: 'running' })
    const interrupt = vi.fn()
    const interruptByParent = vi.fn()
    const ctx = harness(interrupt, interruptByParent)
    const view: MayflyConversationView = {
      kind: 'subagent', id: 'session:child', sessionId: 'child', parentSessionId: 'parent', label: 'worker',
      mode: 'continuable', access: 'interactive', residency: 'displayed',
    }

    expect(interruptAgent(ctx, child, view)).toEqual({ requested: true, failures: [] })
    expect(interruptByParent).toHaveBeenCalledWith(child.id, SessionId('parent'), 'continuable')
    expect(child.cancel).not.toHaveBeenCalled()
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('reports a refusal instead of throwing', () => {
    const root = fakeAgent('root', { status: 'running' })
    vi.mocked(root.cancel).mockImplementation(() => { throw new Error('root refused') })

    expect(interruptAgent(harness(), root, primaryView(root))).toEqual({ requested: true, failures: ['current Agent: root refused'] })
  })
})

describe('isAgentRunning', () => {
  it('follows the selected Agent alone', () => {
    expect(isAgentRunning(fakeAgent('root', { status: 'running' }))).toBe(true)
    expect(isAgentRunning(fakeAgent('root', { status: 'idle' }))).toBe(false)
  })
})
