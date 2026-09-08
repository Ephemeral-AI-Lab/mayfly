/** Native approval outcomes, acknowledgement ordering, and shared decision input.
 * @module @ephemeral-ai/mayfly/tests/interaction/approval-plugin
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestFixture, renderRequest, flushRequests } from './request-fixture.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup() { const ctx = new Context(); contexts.push(ctx); return requestFixture(ctx) }
const decision = [{ controlId: 'approval', itemId: 'decision' }]
const feedback = [{ controlId: 'approval', itemId: 'feedback' }]

describe('native approval UI', () => {
  it('defaults to rejection even with preceding scrollable context and ignores former digit shortcuts', async () => {
    const bench = await setup()
    const pending = bench.approve({ reason: 'writes files' })
    const model = bench.model('mayfly.approval.')
    const renderer = renderRequest(model)
    expect(renderer.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'reject' })
    renderer.input('1')
    renderer.input('2')
    expect(model.disposed).toBe(false)
    renderer.input('\r')
    await expect(pending).resolves.toBe('rejected')
    expect(model.disposed).toBe(true)
    renderer.runtime.dispose()
  })

  it('allows once without adding a session allowance and requires an explicit session grant', async () => {
    const bench = await setup()
    const first = bench.approve()
    bench.model('mayfly.approval.').invoke('allow-once', decision)
    await expect(first).resolves.toBe('allowed-once')
    const second = bench.approve()
    bench.model('mayfly.approval.').invoke('allow-session', decision)
    await expect(second).resolves.toBe('allowed-once')
    await expect(bench.approve()).resolves.toBe('allowed-once')
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
    const aborted = new AbortController()
    aborted.abort()
    await expect(bench.approve({ signal: aborted.signal })).resolves.toBe('cancelled')
  })

  it('keeps feedback on Back, rejects on the next Escape, and never steers unsubmitted text', async () => {
    const bench = await setup()
    const pending = bench.approve()
    const model = bench.model('mayfly.approval.')
    model.invoke('feedback', decision)
    expect(model.activeTab({ pagePath: [], controlId: 'approval' })).toBe('feedback')
    let renderer = renderRequest(model)
    renderer.component.render(80)
    renderer.input('too risky')
    expect(model.form({ pagePath: feedback, formId: 'feedback-form' })!.fields.reason!.value).toBe('too risky')
    renderer.input('\x1b')
    expect(model.activeTab({ pagePath: [], controlId: 'approval' })).toBe('decision')
    expect(model.decisionNode).toBeUndefined()
    renderer.runtime.dispose()
    model.invoke('feedback', decision)
    renderer = renderRequest(model)
    expect(renderer.component.render(80).join('\n')).toContain('too risky')
    renderer.input('\x1b')
    renderer.runtime.dispose()
    renderer = renderRequest(model)
    renderer.input('\x1b')
    await expect(pending).resolves.toBe('rejected')
    expect(bench.steer).not.toHaveBeenCalled()
    renderer.runtime.dispose()
  })

  it.each(['', '  first line\nsecond line  '])('submits feedback exactly once and preserves text: %j', async reason => {
    const bench = await setup()
    const pending = bench.approve()
    const model = bench.model('mayfly.approval.')
    model.invoke('feedback', decision)
    model.edit({ pagePath: feedback, formId: 'feedback-form', fieldId: 'reason' }, reason)
    model.invoke('send-feedback', feedback)
    model.invoke('send-feedback', feedback)
    expect(bench.steer).not.toHaveBeenCalled()
    await expect(pending).resolves.toBe('rejected')
    model.invoke('send-feedback', feedback)
    if (reason === '') expect(bench.steer).not.toHaveBeenCalled()
    else {
      expect(bench.steer).toHaveBeenCalledOnce()
      expect(bench.steer.mock.calls[0]![0]).toMatchObject({ content: [{ type: 'text', text: `User rejected bash: ${reason}` }], source: { kind: 'user' } })
    }
  })

  it('lets a real abort beat a prepared grant and cannot replay the retired endpoint', async () => {
    const bench = await setup()
    const controller = new AbortController()
    const pending = bench.approve({ signal: controller.signal })
    const model = bench.model('mayfly.approval.')
    model.invoke('allow-session', decision)
    controller.abort()
    await expect(pending).resolves.toBe('cancelled')
    model.invoke('allow-session', decision)
    const next = bench.approve()
    bench.model('mayfly.approval.').invoke('reject', decision)
    await expect(next).resolves.toBe('rejected')
  })

  it('queues native requests in FIFO order and removes a withdrawn queued request', async () => {
    const bench = await setup()
    const first = bench.approve()
    const abort = new AbortController()
    const skipped = bench.approve({ toolName: 'write', signal: abort.signal })
    const last = bench.approve({ toolName: 'read' })
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(1)
    abort.abort()
    await expect(skipped).resolves.toBe('cancelled')
    bench.model('mayfly.approval.').invoke('allow-once', decision)
    await expect(first).resolves.toBe('allowed-once')
    expect(JSON.stringify(bench.model('mayfly.approval.').node)).toContain('Approve read?')
    bench.model('mayfly.approval.').requestClose()
    await expect(last).resolves.toBe('rejected')
  })

  it('applies a session grant to already queued requests for the same tool', async () => {
    const bench = await setup()
    const first = bench.approve()
    const second = bench.approve()
    bench.model('mayfly.approval.').invoke('allow-session', decision)
    await expect(first).resolves.toBe('allowed-once')
    await expect(second).resolves.toBe('allowed-once')
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])
  })

  it.each(['selection', 'same-id', 'app-unload', 'frontend-unload'] as const)('retires active and queued work after %s', async mode => {
    const bench = await setup()
    const first = bench.approve()
    const old = bench.model('mayfly.approval.')
    const second = bench.approve({ toolName: 'write' })
    if (mode === 'selection') bench.ctx.mayflyCurrentAgent.select(bench.other)
    else if (mode === 'same-id') {
      const replacement = { ...bench.agent } as Agent
      bench.agents.set(bench.agent.id, replacement)
      bench.ctx.mayflyCurrentAgent.select(replacement)
    } else await (mode === 'app-unload' ? bench.app : bench.front).dispose()
    await expect(first).resolves.toBe('cancelled')
    await expect(second).resolves.toBe('cancelled')
    old.invoke('allow-once', decision)
    expect(old.disposed).toBe(true)
  })

  it('delegates other Agents and clears allowances when the exact selection changes', async () => {
    const bench = await setup()
    await expect(bench.approve({ agent: bench.other })).resolves.toBe('unavailable')
    const first = bench.approve()
    bench.model('mayfly.approval.').invoke('allow-session', decision)
    await first
    bench.ctx.mayflyCurrentAgent.select(bench.other)
    bench.ctx.mayflyCurrentAgent.select(bench.agent)
    const second = bench.approve()
    bench.model('mayfly.approval.').requestClose()
    await expect(second).resolves.toBe('rejected')
    bench.ctx.mayflyCurrentAgent.select(null)
    await expect(bench.approve()).resolves.toBe('unavailable')
  })

  it('refreshes translated chrome while a feedback draft and its focus survive', async () => {
    const bench = await setup()
    bench.ctx.mayflyLocale.setPreference('en')
    const pending = bench.approve()
    const model = bench.model('mayfly.approval.')
    model.invoke('feedback', decision)
    model.edit({ pagePath: feedback, formId: 'feedback-form', fieldId: 'reason' }, '草稿')
    bench.ctx.mayflyLocale.setPreference('zh')
    await flushRequests()
    expect(model.form({ pagePath: feedback, formId: 'feedback-form' })!.fields.reason!.value).toBe('草稿')
    expect(model.activeTab({ pagePath: [], controlId: 'approval' })).toBe('feedback')
    expect(JSON.stringify(model.node)).toContain('拒绝并反馈')
    model.invoke('send-feedback', feedback)
    await expect(pending).resolves.toBe('rejected')
  })

  it('ignores unrelated direct events before an approval answer exists', async () => {
    const bench = await setup()
    const pending = bench.approve()
    const entry = bench.ctx.mayflyOverlays.list()[0]!
    const context = { surfaceId: entry.id, operationId: 'noop', source: entry.source, revision: entry.revision, signal: new AbortController().signal, report: vi.fn() }
    expect(await entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'noop', actionId: 'noop' }, context)).toEqual({ kind: 'completed' })
    expect(await entry.definition.onEvent!.action!({ kind: 'submit', submission: { actionId: 'other', source: entry.source, forms: [] } }, context)).toEqual({ kind: 'completed' })
    bench.model('mayfly.approval.').invoke('reject', decision)
    await expect(pending).resolves.toBe('rejected')
  })

  it('rechecks exact Agent authority when a queued request starts', async () => {
    const bench = await setup()
    let reads = 0
    let changeAt = Number.POSITIVE_INFINITY
    vi.spyOn(bench.ctx.mayflyCurrentAgent, 'current').mockImplementation(() => ++reads >= changeAt ? bench.other : bench.agent)
    const first = bench.approve()
    const queued = bench.approve({ toolName: 'write' })
    changeAt = reads + 4
    bench.model('mayfly.approval.').invoke('reject', decision)
    await expect(first).resolves.toBe('rejected')
    await expect(queued).resolves.toBe('cancelled')
  })

  it('maps an accepted callback failure to unavailable', async () => {
    const bench = await setup()
    bench.agent.steer = vi.fn(() => { throw new Error('steer failed') }) as never
    const pending = bench.approve()
    const model = bench.model('mayfly.approval.')
    model.invoke('feedback', decision)
    model.edit({ pagePath: feedback, formId: 'feedback-form', fieldId: 'reason' }, 'reason')
    model.invoke('send-feedback', feedback)
    await expect(pending).resolves.toBe('unavailable')
  })
})
