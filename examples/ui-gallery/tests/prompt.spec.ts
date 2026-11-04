/** Real provider preparation, acknowledgement and retirement for the gallery prompt.
 * @module @mayfly-example/ui-gallery/tests/prompt
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MayflyPaneRegistration, MayflyUiActionEvent, MayflyUiEventContext, MayflyUiObservationEvent } from '../../../packages/ui/src/contracts.ts'
import { apply as applyApi } from '../../../packages/ui/src/provider.ts'
import * as gallery from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose(); vi.restoreAllMocks() })

/** Events as supplied by the renderer before adding the current page address. */
type Unpaged<Event> = Event extends unknown ? Omit<Event, 'pagePath'> : never
const submit = (text: string): Unpaged<MayflyUiActionEvent> => ({
  kind: 'submit', controlId: 'gallery-prompt', submission: { actionId: 'gallery-prompt', draftRevision: 7, source: [], forms: [{ pagePath: [], formId: 'gallery-prompt', draftRevision: 7, fields: [{ id: 'text', change: 'set', value: text }] }] },
})
const showCompletions: Unpaged<MayflyUiActionEvent> = { kind: 'activate', controlId: 'gallery-prompt-actions', actionId: 'gallery-prompt-completions' }

async function boot(delay?: Promise<void>) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin({ name: 'example-test-api', apply: applyApi })
  const register = ctx.mayflyPanes.register
  let handle!: MayflyPaneRegistration
  const registration = vi.spyOn(ctx.mayflyPanes, 'register').mockImplementation(function (this: typeof ctx.mayflyPanes, definition, initial) {
    if (definition.id !== 'example.ui-gallery.prompt') return register.call(this, definition, initial)
    const action = definition.onEvent!.action!
    const result = register.call(this, delay === undefined ? definition : {
      ...definition,
      onEvent: { ...definition.onEvent, action: async (event, context) => {
        const reply = await action(event, context)
        await delay
        return reply
      } },
    }, initial)
    handle = result
    return result
  })
  const fiber = await ctx.plugin(gallery)
  registration.mockRestore()
  const entry = () => ctx.mayflyPanes.list().find(pane => pane.id === 'example.ui-gallery.prompt')!
  let operation = 0
  const context = (signal = new AbortController().signal): MayflyUiEventContext => ({ surfaceId: entry().id, operationId: `prompt-${String(++operation)}`, source: entry().source, revision: entry().revision, signal, report: vi.fn() })
  const promptOf = (node: unknown) => (JSON.parse(JSON.stringify(node)).children[1].node.child) as { tokens: { id: string }[], recall: { text: string }[], completions?: { items: { id: string, label: string }[] }, reset: { rev: number, value: string } }
  const prompt = () => promptOf(entry().node)
  const prepare = async (event: Unpaged<MayflyUiActionEvent | MayflyUiObservationEvent>, signal?: AbortSignal) => entry().events.prepare({ ...event, pagePath: [] } as MayflyUiActionEvent | MayflyUiObservationEvent, context(signal))
  const observe = async (event: Unpaged<MayflyUiObservationEvent>) => {
    const prepared = await prepare(event)
    expect(prepared.reply).toBeUndefined()
    expect(prepared.publish()).toBe(false)
  }
  const act = async (event: Unpaged<MayflyUiActionEvent>) => {
    const prepared = await prepare(event)
    expect(prepared.publish()).toBe(true)
    return prepared.reply
  }
  let draft = 0
  const type = (text: string) => observe({ kind: 'value-change', controlId: 'text', formId: 'gallery-prompt', value: text, draftRevision: ++draft })
  const changes = vi.fn()
  ctx.mayflyPanes.subscribe(changes)
  changes.mockClear()
  return { ctx, fiber, handle, entry, prompt, promptOf, prepare, context, observe, act, type, changes }
}

describe('ui gallery prompt', () => {
  it('registers a bottom prompt with attachment, recall and explicit completion action', async () => {
    const f = await boot()
    expect(f.entry().definition.placement).toBe('bottom')
    expect(f.prompt().tokens.map(token => token.id)).toEqual(['image-1'])
    expect(f.prompt().recall.map(item => item.text)).toEqual(['run the width scan again', 'bump the changelog too'])
    expect(f.prompt().completions).toBeUndefined()
    expect(JSON.stringify(f.entry().node)).toContain('Show completions')
  })

  it('records observed drafts without any registry upsert, then acknowledges completion snapshots explicitly', async () => {
    const f = await boot()
    const initial = f.entry()
    await f.type('/')
    await f.type('/se')
    await f.observe({ kind: 'tab-change', controlId: 'tabs', tabId: 'one' })
    expect(f.entry()).toBe(initial)
    expect(f.changes).not.toHaveBeenCalled()
    const prepared = await f.prepare(showCompletions)
    expect(prepared.reply).toMatchObject({ kind: 'accepted', source: [] })
    expect(f.entry()).toBe(initial)
    expect(f.changes).not.toHaveBeenCalled()
    expect(prepared.publish()).toBe(true)
    expect(prepared.publish()).toBe(false)
    expect(f.changes).toHaveBeenCalledOnce()
    expect(f.entry().update).toMatchObject({ reason: 'ack', operationId: 'prompt-4', draftRevision: initial.revision, source: [] })
    expect(f.prompt().completions!.items.map(item => item.label)).toEqual(['/sessions'])
    expect(f.prompt().reset).toEqual({ rev: 0, value: '/se' })
    await f.type('hello')
    await f.act(showCompletions)
    expect(f.prompt().completions).toBeUndefined()
    await f.type('hello #r')
    await f.act(showCompletions)
    expect(f.prompt().completions!.items.map(item => item.label)).toEqual(['#review'])
  })

  it('accepts file and command completions through one ACK without a handler-side publication', async () => {
    const f = await boot()
    await f.type('explain @no')
    await f.act(showCompletions)
    expect(f.prompt().completions!.items.map(item => item.label)).toEqual(['@notes.md'])
    const before = f.entry()
    const prepared = await f.prepare({ kind: 'completion-accept', controlId: 'gallery-prompt', itemId: 'notes' })
    expect(prepared.reply).toMatchObject({ kind: 'accepted', source: [] })
    expect(f.entry()).toBe(before)
    expect(prepared.publish()).toBe(true)
    expect(f.prompt().tokens.map(token => token.id)).toEqual(['image-1', 'file-2'])
    expect(f.prompt().reset).toEqual({ rev: 1, value: 'explain ' })
    await f.type('/tr')
    await f.act(showCompletions)
    await expect(f.act({ kind: 'completion-accept', controlId: 'gallery-prompt', itemId: 'trace' })).resolves.toMatchObject({ kind: 'accepted' })
    expect(f.prompt().reset).toEqual({ rev: 2, value: '/trace ' })
    await expect(f.act({ kind: 'completion-accept', controlId: 'gallery-prompt', itemId: 'missing' })).resolves.toEqual({ kind: 'cancelled' })
    await expect(f.act({ kind: 'completion-dismiss', controlId: 'gallery-prompt' })).resolves.toEqual({ kind: 'completed' })
  })

  it('removes tokens only when their structured action snapshot is published', async () => {
    const f = await boot()
    const before = f.entry()
    const prepared = await f.prepare({ kind: 'token-remove', controlId: 'gallery-prompt', tokenId: 'image-1' })
    expect(prepared.reply).toMatchObject({ kind: 'accepted', feedback: { severity: 'info', message: 'Removed the attachment' } })
    expect(f.entry()).toBe(before)
    expect(prepared.publish()).toBe(true)
    expect(f.prompt().tokens).toEqual([])
    expect(f.entry().update.reason).toBe('ack')
  })

  it('acknowledges submission history, clearing and singular or empty attachment feedback', async () => {
    const f = await boot()
    await f.observe({ kind: 'recall-change', controlId: 'gallery-prompt', source: 'history', index: 0 })
    const before = f.entry()
    const sent = await f.prepare(submit('also update the footer'))
    expect(sent.reply).toMatchObject({ kind: 'accepted', feedback: { severity: 'success', message: 'Sent with 1 attachment' } })
    expect(f.entry()).toBe(before)
    expect(sent.publish()).toBe(true)
    expect(f.prompt().tokens).toEqual([])
    expect(f.prompt().reset).toEqual({ rev: 1, value: '' })
    expect(f.prompt().recall.map(item => item.text)).toEqual(['also update the footer', 'run the width scan again', 'bump the changelog too'])
    expect(f.entry().update).toMatchObject({ reason: 'ack', draftRevision: 7 })
    await f.observe({ kind: 'recall-change', controlId: 'gallery-prompt', source: 'draft', index: -1 })
    await expect(f.act(submit('   '))).resolves.toMatchObject({ kind: 'accepted', feedback: { message: 'Sent' } })
    expect(f.prompt().recall).toHaveLength(3)
  })

  it('counts multiple attachments and settles unrelated actions quietly', async () => {
    const f = await boot()
    await f.type('@no')
    await f.act(showCompletions)
    await f.act({ kind: 'completion-accept', controlId: 'gallery-prompt', itemId: 'notes' })
    await expect(f.act(submit('look'))).resolves.toMatchObject({ feedback: { message: 'Sent with 2 attachments' } })
    await expect(f.act({ kind: 'dismiss' })).resolves.toEqual({ kind: 'completed' })
    await expect(f.act({ kind: 'activate', controlId: 'other', actionId: 'other' })).resolves.toEqual({ kind: 'completed' })
  })

  it.each(['replace', 'caller', 'fiber'] as const)('prevents a prepared old action from publishing after %s retirement', async reason => {
    const f = await boot()
    const caller = new AbortController()
    const before = f.entry()
    const prepared = await f.prepare(submit('late prepared reply'), caller.signal)
    if (reason === 'replace') f.handle.set(before.node, { reason: 'replace' })
    if (reason === 'caller') caller.abort()
    if (reason === 'fiber') await f.fiber.dispose()
    const changes = f.changes.mock.calls.length
    expect(prepared.publish()).toBe(false)
    expect(f.changes).toHaveBeenCalledTimes(changes)
    if (reason === 'fiber') expect(f.ctx.mayflyPanes.list()).toEqual([])
    else expect(f.entry().node).toBe(before.node)
  })

  it.each(['replace', 'caller', 'fiber'] as const)('fences an unfinished action and late settlement after %s retirement', async reason => {
    for (const rejects of [false, true]) {
      const delay = Promise.withResolvers<void>()
      const f = await boot(delay.promise)
      const caller = new AbortController()
      const before = f.entry()
      const pending = f.prepare(submit('late native-like reply'), caller.signal)
      await Promise.resolve()
      await Promise.resolve()
      if (reason === 'replace') f.handle.set(before.node, { reason: 'replace' })
      if (reason === 'caller') caller.abort()
      if (reason === 'fiber') await f.fiber.dispose()
      const result = await pending
      expect(result.reply).toBeUndefined()
      expect(result.publish()).toBe(false)
      const changes = f.changes.mock.calls.length
      if (rejects) delay.reject(new Error('late retired action failure'))
      else delay.resolve()
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(f.changes).toHaveBeenCalledTimes(changes)
      if (reason === 'fiber') expect(f.ctx.mayflyPanes.list()).toEqual([])
      else expect(f.entry().node).toBe(before.node)
    }
  })
})
