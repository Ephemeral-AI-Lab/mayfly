/** Reply surfaces preserve drafts across renderer gaps and reject stale addresses.
 * @module @ephemeral-ai/mayfly/tests/interaction/subagent-reply
 */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import * as reply from '../../src/interaction/subagent-reply.ts'
import { informationFixture } from './information-fixture.ts'
import { nativeAction } from './native-action-fixture.ts'

it('admits only the displayed continuable address and fences a changed view before sending', async () => {
  const bench = await informationFixture(new Context())
  const prompt = vi.fn()
  bench.ctx.provide('subagents', { prompt } as never)
  await bench.ctx.plugin(reply)
  const target = { kind: 'subagent' as const, sessionId: 'cold', parentSessionId: 'current', label: 'Cold', mode: 'continuable' as const }
  try {
    bench.ctx.emit('mayfly/request-subagent-reply', target)
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
    for (const alternate of [
      { ...target, sessionId: 'different' },
      { ...target, parentSessionId: 'different' },
      { ...target, mode: 'one-shot' as const },
    ]) {
      bench.ctx.mayflyConversations.open(alternate)
      bench.ctx.emit('mayfly/request-subagent-reply', target)
      expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
    }
    bench.ctx.mayflyConversations.open(target)
    bench.ctx.emit('mayfly/request-subagent-reply', target)
    const model = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.subagent.reply')!
    bench.ctx.emit('mayfly/request-subagent-reply', target)
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(1)
    const submit = (fields: unknown[]) => ({ kind: 'submit', pagePath: [], controlId: 'reply', submission: { actionId: 'send', draftRevision: 0, source: [], forms: [{ pagePath: [], formId: 'reply', draftRevision: 0, fields }] } }) as never
    expect(await nativeAction(model, submit([]))).toMatchObject({ kind: 'failed' })
    expect(await nativeAction(model, submit([{ id: 'message', value: 'hello' }, { id: 'delivery', value: 'invalid' }]))).toMatchObject({ kind: 'failed' })
    const primary = bench.ctx.mayflyConversations.snapshot().views[0]!
    const spy = vi.spyOn(bench.ctx.mayflyConversations, 'displayed').mockReturnValue(primary)
    expect(await nativeAction(model, submit([{ id: 'message', value: 'stale' }]))).toMatchObject({ kind: 'cancelled' })
    spy.mockRestore()
    expect(prompt).not.toHaveBeenCalled()
    bench.ctx.mayflyConversations.close()
    expect(model.disposed).toBe(true)
  } finally { await bench.ctx.fiber.dispose() }
})

it('sends live-member guidance with Steer and retires a form after an exact-Agent replacement', async () => {
  const bench = await informationFixture(new Context())
  const prompt = vi.fn(async () => ({ messageId: 'accepted' }))
  bench.ctx.provide('subagents', { prompt } as never)
  await bench.ctx.plugin(reply)
  const target = { kind: 'subagent' as const, sessionId: 'other', parentSessionId: 'current', label: 'Other', mode: 'continuable' as const }
  try {
    bench.ctx.mayflyConversations.open(target)
    bench.ctx.emit('mayfly/request-subagent-reply', target)
    const model = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.subagent.reply')!
    model.edit({ pagePath: [], formId: 'reply', fieldId: 'message' }, 'Change direction now')
    model.edit({ pagePath: [], formId: 'reply', fieldId: 'delivery' }, 'steer')
    model.invoke('send')
    await vi.waitFor(() => expect(model.disposed).toBe(true))
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ childSessionId: 'other', delivery: 'steer' }), expect.any(AbortSignal))
    bench.ctx.emit('mayfly/request-subagent-reply', target)
    const stale = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.subagent.reply')!
    bench.agents.set(bench.other.id, { ...bench.other } as typeof bench.other)
    bench.ctx.mayflyCurrentAgent.current()
    expect(stale.disposed).toBe(true)
  } finally { await bench.ctx.fiber.dispose() }
})

it('seeds the reply form with an editor draft and reports the sent draft back', async () => {
  const bench = await informationFixture(new Context())
  const prompt = vi.fn(async () => ({ messageId: 'accepted' }))
  bench.ctx.provide('subagents', { prompt } as never)
  await bench.ctx.plugin(reply)
  const target = { kind: 'subagent' as const, sessionId: 'seeded', parentSessionId: 'current', label: 'Seeded', mode: 'continuable' as const }
  const sent = vi.fn()
  bench.ctx.on('mayfly/subagent-reply-sent', sent)
  try {
    bench.ctx.mayflyConversations.open(target)
    bench.ctx.emit('mayfly/request-subagent-reply', target, 'draft from the editor')
    expect(JSON.stringify(bench.ctx.mayflyOverlays.list()[0]!.node)).toContain('draft from the editor')
    const model = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.subagent.reply')!
    model.edit({ pagePath: [], formId: 'reply', fieldId: 'message' }, 'edited before sending')
    model.invoke('send')
    await vi.waitFor(() => expect(model.disposed).toBe(true))
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ content: [{ type: 'text', text: 'edited before sending' }] }), expect.any(AbortSignal))
    // The editor still holds the original draft, which the form has now sent.
    expect(sent).toHaveBeenCalledWith('draft from the editor')
  } finally { await bench.ctx.fiber.dispose() }
})

it('completes non-submit events and reports failed native prompts in the form', async () => {
  const bench = await informationFixture(new Context())
  const prompt = vi.fn().mockRejectedValueOnce(new Error('child is gone')).mockRejectedValueOnce('bare failure')
  bench.ctx.provide('subagents', { prompt } as never)
  await bench.ctx.plugin(reply)
  const target = { kind: 'subagent' as const, sessionId: 'failing', parentSessionId: 'current', label: 'Failing', mode: 'continuable' as const }
  try {
    bench.ctx.mayflyConversations.open(target)
    bench.ctx.emit('mayfly/request-subagent-reply', target)
    const model = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.subagent.reply')!
    expect(await nativeAction(model, { kind: 'activate', pagePath: [], controlId: 'reply-actions', actionId: 'close' } as never)).toEqual({ kind: 'completed' })
    const submit = { kind: 'submit', pagePath: [], controlId: 'reply', submission: { actionId: 'send', draftRevision: 0, source: [], forms: [{ pagePath: [], formId: 'reply', draftRevision: 0, fields: [{ id: 'message', value: 'try again' }] }] } } as never
    expect(await nativeAction(model, submit)).toEqual({ kind: 'failed', message: 'child is gone' })
    expect(await nativeAction(model, submit)).toEqual({ kind: 'failed', message: 'bare failure' })
  } finally { await bench.ctx.fiber.dispose() }
})
