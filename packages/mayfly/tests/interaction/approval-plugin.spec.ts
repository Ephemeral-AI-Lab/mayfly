/** Native approval outcomes, acknowledgement ordering, and shared decision input.
 * @module @ephemeral-ai/mayfly/tests/interaction/approval-plugin
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestFixture, renderRequest, flushRequests } from './request-fixture.ts'

const contexts: Context[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup() { const ctx = new Context(); contexts.push(ctx); return requestFixture(ctx) }
const feedback = [] as const

describe('native approval UI', () => {
  it('ignores stray grants before arming, preserves the deadline on renderer reload, and defaults to rejection', async () => {
    const bench = await setup()
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const pending = bench.approve({ reason: 'writes files' })
    const model = bench.model('mayfly.approval.')
    model.present(1000)
    const renderer = renderRequest(model)
    expect(renderer.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'decisions', itemId: 'reject' })
    renderer.input('1')
    renderer.input('2')
    renderer.input('\r')
    expect(model.disposed).toBe(false)
    const reload = renderRequest(model)
    reload.input('2')
    reload.runtime.dispose()
    now.mockReturnValue(1300)
    renderer.input('\r')
    await expect(pending).resolves.toBe('rejected')
    expect(model.disposed).toBe(true)
    renderer.runtime.dispose()
  })

  it('renders the localized displayReason over the raw reason when the asker supplies one', async () => {
    const bench = await setup()
    const pending = bench.approve({ reason: 'raw reason', displayReason: { en: 'Shown reason', zh: '中文理由' } })
    const model = bench.model('mayfly.approval.')
    const renderer = renderRequest(model)
    // No mayflyLocale service in the fixture → falls back to the `en` entry.
    expect(renderer.component.render(80).join('\n')).toContain('Shown reason')
    expect(renderer.component.render(80).join('\n')).not.toContain('raw reason')
    renderer.runtime.dispose()
    model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'decisions', selectedIds: ['reject'] })
    await expect(pending).resolves.toBe('rejected')
  })

  it('prefers the active locale entry of displayReason', async () => {
    const bench = await setup()
    bench.ctx.mayflyLocale.setPreference('zh')
    const pending = bench.approve({ reason: 'raw reason', displayReason: { en: 'Shown reason', zh: '中文理由' } })
    const model = bench.model('mayfly.approval.')
    const renderer = renderRequest(model)
    expect(renderer.component.render(80).join('\n')).toContain('中文理由')
    renderer.runtime.dispose()
    model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'decisions', selectedIds: ['reject'] })
    await expect(pending).resolves.toBe('rejected')
  })

  it('falls back to the en displayReason entry for unlisted locales and absent locale services', async () => {
    const bench = await setup()
    bench.ctx.mayflyLocale.setPreference('zh')
    const pending = bench.approve({ displayReason: { en: 'Shown reason' } })
    const model = bench.model('mayfly.approval.')
    const renderer = renderRequest(model)
    expect(renderer.component.render(80).join('\n')).toContain('Shown reason')
    renderer.runtime.dispose()
    model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'decisions', selectedIds: ['reject'] })
    await expect(pending).resolves.toBe('rejected')

    // Clearing the implementation value reads back as an absent service.
    const store = (bench.front as never as { store: Record<string, { value: unknown }> }).store
    store['mayflyLocale']!.value = undefined
    const second = bench.approve({ displayReason: { en: 'Shown again' } })
    const secondModel = bench.model('mayfly.approval.')
    const secondRenderer = renderRequest(secondModel)
    expect(secondRenderer.component.render(80).join('\n')).toContain('Shown again')
    secondRenderer.runtime.dispose()
    secondModel.emit({ kind: 'selection-accept', pagePath: [], controlId: 'decisions', selectedIds: ['reject'] })
    await expect(second).resolves.toBe('rejected')
  })

  it('allows once without adding a session allowance and requires an explicit session grant', async () => {
    const bench = await setup()
    const first = bench.approve()
    bench.model('mayfly.approval.').emit({ kind: 'selection-accept', pagePath: [], controlId: 'decisions', selectedIds: ['allow-once'] })
    await expect(first).resolves.toBe('allowed-once')
    const second = bench.approve()
    bench.model('mayfly.approval.').emit({ kind: 'selection-accept', pagePath: [], controlId: 'decisions', selectedIds: ['allow-session'] })
    await expect(second).resolves.toBe('allowed-once')
    await expect(bench.approve()).resolves.toBe('allowed-once')
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
    const aborted = new AbortController()
    aborted.abort()
    await expect(bench.approve({ signal: aborted.signal })).resolves.toBe('cancelled')
  })

  it('retains inline feedback across renderer reload and rejects without steering an unsubmitted draft', async () => {
    const bench = await setup()
    const pending = bench.approve()
    const model = bench.model('mayfly.approval.')
    model.edit({ pagePath: [], formId: 'feedback-form', fieldId: 'reason' }, 'too risky')
    const first = renderRequest(model)
    expect(first.component.render(80).join('\n')).toContain('too risky')
    first.runtime.dispose()
    const second = renderRequest(model)
    expect(second.component.render(80).join('\n')).toContain('too risky')
    second.input('\x1b')
    await expect(pending).resolves.toBe('rejected')
    expect(bench.steer).not.toHaveBeenCalled()
    second.runtime.dispose()
  })

  it.each(['', '  first line\nsecond line  '])('submits feedback exactly once and preserves text: %j', async reason => {
    const bench = await setup()
    const pending = bench.approve()
    const model = bench.model('mayfly.approval.')
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
    model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'decisions', selectedIds: ['allow-session'] })
    controller.abort()
    await expect(pending).resolves.toBe('cancelled')
    model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'decisions', selectedIds: ['allow-session'] })
    const next = bench.approve()
    bench.model('mayfly.approval.').emit({ kind: 'selection-accept', pagePath: [], controlId: 'decisions', selectedIds: ['reject'] })
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
    bench.model('mayfly.approval.').emit({ kind: 'selection-accept', pagePath: [], controlId: 'decisions', selectedIds: ['allow-once'] })
    await expect(first).resolves.toBe('allowed-once')
    expect(JSON.stringify(bench.model('mayfly.approval.').node)).toContain('Approve read?')
    bench.model('mayfly.approval.').requestClose()
    await expect(last).resolves.toBe('rejected')
  })

  it('applies a session grant to already queued requests for the same tool', async () => {
    const bench = await setup()
    const first = bench.approve()
    const second = bench.approve()
    bench.model('mayfly.approval.').emit({ kind: 'selection-accept', pagePath: [], controlId: 'decisions', selectedIds: ['allow-session'] })
    await expect(first).resolves.toBe('allowed-once')
    await expect(second).resolves.toBe('allowed-once')
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])
  })

  it.each(['selection', 'same-id', 'app-unload', 'frontend-unload'] as const)('retires active and queued work after %s', async mode => {
    const bench = await setup()
    const first = bench.approve()
    const old = bench.model('mayfly.approval.')
    const second = bench.approve({ toolName: 'write' })
    if (mode === 'selection') bench.ctx.mayflyConversations.selectPrimary(bench.other)
    else if (mode === 'same-id') {
      const replacement = { ...bench.agent } as Agent
      bench.agents.set(bench.agent.id, replacement)
      bench.ctx.mayflyConversations.selectPrimary(replacement)
    } else await (mode === 'app-unload' ? bench.app : bench.front).dispose()
    await expect(first).resolves.toBe('cancelled')
    await expect(second).resolves.toBe('cancelled')
    old.emit({ kind: 'selection-accept', pagePath: [], controlId: 'decisions', selectedIds: ['allow-once'] })
    expect(old.disposed).toBe(true)
  })

  it('delegates other Agents and keeps session allowances across view switches until the Agent is disposed', async () => {
    const bench = await setup()
    await expect(bench.approve({ agent: bench.other })).resolves.toBe('unavailable')
    const first = bench.approve()
    bench.model('mayfly.approval.').emit({ kind: 'selection-accept', pagePath: [], controlId: 'decisions', selectedIds: ['allow-session'] })
    await first
    bench.ctx.mayflyConversations.selectPrimary(bench.other)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await expect(bench.approve()).resolves.toBe('allowed-once')
    bench.ctx.emit('agent/disposed' as never, { agent: bench.agent } as never)
    // The fixture keeps the disposed object registered, so it can be displayed again.
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    const second = bench.approve()
    bench.model('mayfly.approval.').requestClose()
    await expect(second).resolves.toBe('rejected')
    bench.ctx.mayflyConversations.selectPrimary(null)
    await expect(bench.approve()).resolves.toBe('unavailable')
  })

  it('refreshes translated chrome while a feedback draft and its focus survive', async () => {
    const bench = await setup()
    bench.ctx.mayflyLocale.setPreference('en')
    const pending = bench.approve()
    const model = bench.model('mayfly.approval.')
    model.edit({ pagePath: feedback, formId: 'feedback-form', fieldId: 'reason' }, '草稿')
    bench.ctx.mayflyLocale.setPreference('zh')
    await flushRequests()
    expect(model.form({ pagePath: feedback, formId: 'feedback-form' })!.fields.reason!.value).toBe('草稿')
    expect(model.choice({ pagePath: [], controlId: 'decisions' })?.focusedId).toBe('reject')
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
    bench.model('mayfly.approval.').emit({ kind: 'selection-accept', pagePath: [], controlId: 'decisions', selectedIds: ['reject'] })
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
    bench.model('mayfly.approval.').emit({ kind: 'selection-accept', pagePath: [], controlId: 'decisions', selectedIds: ['reject'] })
    await expect(first).resolves.toBe('rejected')
    await expect(queued).resolves.toBe('cancelled')
  })

  it('maps an accepted callback failure to unavailable', async () => {
    const bench = await setup()
    bench.agent.steer = vi.fn(() => { throw new Error('steer failed') }) as never
    const pending = bench.approve()
    const model = bench.model('mayfly.approval.')
    model.edit({ pagePath: feedback, formId: 'feedback-form', fieldId: 'reason' }, 'reason')
    model.invoke('send-feedback', feedback)
    await expect(pending).resolves.toBe('unavailable')
  })
})


it('does not grant malformed or unrelated submissions', async () => {
  const bench = await setup()
  const pending = bench.approve()
  const model = bench.model('mayfly.approval.')
  const entry = bench.ctx.mayflyOverlays.list().find(value => value.id === model.id)!
  const context = { surfaceId: entry.id, source: entry.source, revision: entry.revision, operationId: 'invalid', signal: new AbortController().signal, report: vi.fn() }
  for (const actionId of ['decide', 'unrelated']) {
    const reply = await entry.definition.onEvent!.action!({ kind: 'submit', pagePath: [], controlId: 'feedback-form', submission: { actionId, draftRevision: 0, source: [], forms: [], selections: [{ pagePath: [], controlId: 'decisions', selectedIds: ['missing'] }] } }, context)
    expect(reply).toMatchObject({ kind: 'completed' })
    expect(model.disposed).toBe(false)
  }
  model.requestClose()
  await expect(pending).resolves.toBe('rejected')
})
