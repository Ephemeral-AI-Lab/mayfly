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
      bench.ctx.mayflyCurrentAgent.openAuxiliary(alternate)
      bench.ctx.emit('mayfly/request-subagent-reply', target)
      expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
    }
    bench.ctx.mayflyCurrentAgent.openAuxiliary(target)
    bench.ctx.emit('mayfly/request-subagent-reply', target)
    const model = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.subagent.reply')!
    bench.ctx.emit('mayfly/request-subagent-reply', target)
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(1)
    const submit = (fields: unknown[]) => ({ kind: 'submit', pagePath: [], controlId: 'reply', submission: { actionId: 'send', draftRevision: 0, source: [], forms: [{ pagePath: [], formId: 'reply', draftRevision: 0, fields }] } }) as never
    expect(await nativeAction(model, submit([]))).toMatchObject({ kind: 'failed' })
    const original = bench.ctx.mayflyCurrentAgent.view()
    const spy = vi.spyOn(bench.ctx.mayflyCurrentAgent, 'view').mockReturnValue({ ...original, displayed: 'primary' })
    expect(await nativeAction(model, submit([{ id: 'message', value: 'stale' }]))).toMatchObject({ kind: 'cancelled' })
    spy.mockRestore()
    expect(prompt).not.toHaveBeenCalled()
    bench.ctx.mayflyCurrentAgent.closeAuxiliary()
    expect(model.disposed).toBe(true)
  } finally { await bench.ctx.fiber.dispose() }
})
