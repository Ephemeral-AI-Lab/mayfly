/** `/rename` writes a user-pinned session title through the native controller.
 * @module @ephemeral-ai/mayfly/tests/interaction/rename-command
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerRenameCommand } from '../../src/interaction/rename-command.ts'
import { informationFixture } from './information-fixture.ts'
import { flushRequests as flushOneRequest } from './request-fixture.ts'

const flushRequests = async () => { await flushOneRequest(); await flushOneRequest() }
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

async function setup(options: { readonly title?: string } = {}) {
  const ctx = new Context(); contexts.push(ctx)
  const bench = await informationFixture(ctx)
  const controller = {
    rename: vi.fn(async ({ title }: { readonly sessionId: unknown, readonly title: string }) => ({ title, seq: 7 })),
  }
  ctx.provide('sessionController', controller as never)
  vi.spyOn(ctx.sessionProjections, 'snapshot').mockReturnValue({
    asOfSeq: 0, values: options.title === undefined ? {} : { title: options.title },
  } as never)
  const dispose = registerRenameCommand(ctx)
  const run = (line: string) => ctx.commands.execute(bench.agent, line, [], new AbortController().signal)
  const model = () => ctx.mayflyUiInteraction.get('overlay', 'mayfly.rename')!
  return { ...bench, ctx, controller, dispose, run, model }
}

describe('registerRenameCommand', () => {
  it('renames the current session directly from the argument', async () => {
    const bench = await setup()
    const execution = await bench.run('/rename   My session  ')
    expect(bench.controller.rename).toHaveBeenCalledWith({ sessionId: 'current', title: 'My session' })
    expect(execution?.result).toEqual({ kind: 'success', text: 'renamed session to My session' })
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
  })

  it('opens a prefilled editor on the bare command and dismisses on save', async () => {
    const bench = await setup({ title: 'Old name' })
    const execution = await bench.run('/rename')
    expect(execution?.result).toEqual({ kind: 'success' })
    await flushRequests()
    expect(JSON.stringify(bench.model().node)).toContain('Old name')
    bench.model().edit({ pagePath: [], formId: 'session-rename', fieldId: 'title' }, '  Edited name  ')
    bench.model().invoke('save')
    await flushRequests()
    expect(bench.controller.rename).toHaveBeenCalledWith({ sessionId: 'current', title: 'Edited name' })
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
  })

  it('rejects empty names, stale agents, and failed renames without dismissing', async () => {
    const bench = await setup()
    bench.controller.rename.mockRejectedValueOnce(new Error('title rejected'))
    const failed = await bench.run('/rename bad')
    expect(failed?.result).toEqual({ kind: 'error', text: 'title rejected' })
    bench.controller.rename.mockRejectedValueOnce('plain failure')
    expect((await bench.run('/rename bad'))?.result).toEqual({ kind: 'error', text: 'plain failure' })
    await bench.run('/rename')
    await flushRequests()
    bench.model().invoke('save')
    await flushRequests()
    expect(bench.model().feedbackSnapshot().some(item => item.message.includes('Enter a session name'))).toBe(true)
    bench.model().edit({ pagePath: [], formId: 'session-rename', fieldId: 'title' }, 'Second')
    bench.ctx.mayflyConversations.selectPrimary(null)
    bench.model().invoke('save')
    await flushRequests()
    expect(bench.model().feedbackSnapshot().some(item => item.message.includes('run /rename again'))).toBe(true)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    bench.controller.rename.mockRejectedValueOnce(new Error('rename refused'))
    bench.model().invoke('save')
    await flushRequests()
    expect(bench.model().feedbackSnapshot().some(item => item.message.includes('rename refused'))).toBe(true)
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(1)
  })

  it('reports when no session is live and tolerates non-activation events', async () => {
    const bench = await setup()
    bench.ctx.mayflyConversations.selectPrimary(null)
    expect((await bench.run('/rename new'))?.result).toEqual({ kind: 'error', text: 'no session is live yet' })
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await bench.run('/rename')
    await flushRequests()
    bench.model().emit({ kind: 'dismiss', pagePath: [] } as never)
    await flushRequests()
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
    await bench.run('/rename')
    await flushRequests()
    bench.model().invoke('close')
    await flushRequests()
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
    bench.dispose()
  })
})
