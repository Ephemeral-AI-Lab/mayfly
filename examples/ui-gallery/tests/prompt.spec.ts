/** The gallery's prompt pane: a host that answers the prompt's events by republishing the node.
 * @module @mayfly-example/ui-gallery/tests/prompt
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MayflyUiActionEvent, MayflyUiEventContext, MayflyUiObservationEvent } from '../../../packages/ui/src/contracts.ts'
import { apply as applyApi } from '../../../packages/ui/src/provider.ts'
import * as gallery from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

async function boot() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin({ name: 'example-test-api', apply: applyApi })
  await ctx.plugin(gallery)
  const entry = () => ctx.mayflyPanes.list().find(pane => pane.id === 'example.ui-gallery.prompt')!
  const context = (): MayflyUiEventContext => ({ surfaceId: entry().id, operationId: 'prompt-test', source: entry().source, revision: entry().revision, signal: new AbortController().signal, report: vi.fn() })
  const promptOf = (node: unknown) => (JSON.parse(JSON.stringify(node)).children[1].node.child) as { tokens: { id: string }[], recall: { kind: string, text: string }[], completions?: { items: { id: string, label: string }[] }, reset: { rev: number, value: string } }
  const prompt = () => promptOf(entry().node)
  const observe = async (event: Omit<MayflyUiObservationEvent, 'pagePath'>) => entry().definition.onEvent!.observe!({ ...event, pagePath: [] } as MayflyUiObservationEvent, context())
  const act = async (event: Omit<MayflyUiActionEvent, 'pagePath'>) => entry().definition.onEvent!.action!({ ...event, pagePath: [] } as MayflyUiActionEvent, context())
  return { entry, prompt, promptOf, observe, act }
}

describe('ui gallery prompt', () => {
  it('registers a bottom pane beside the showcase', async () => {
    const { entry, prompt } = await boot()
    expect(entry().definition.placement).toBe('bottom')
    expect(prompt().tokens.map(token => token.id)).toEqual(['image-1'])
    expect(prompt().recall.map(item => item.kind)).toEqual(['queued', 'history', 'history'])
    expect(prompt().completions).toBeUndefined()
  })

  it('offers completions for the word being typed and takes them back when it stops matching', async () => {
    const { prompt, observe } = await boot()
    await observe({ kind: 'value-change', controlId: 'text', formId: 'gallery-prompt', value: '/', draftRevision: 1 })
    expect(prompt().completions!.items.map(item => item.label)).toEqual(['/model', '/sessions', '/trace'])
    await observe({ kind: 'value-change', controlId: 'text', formId: 'gallery-prompt', value: '/se', draftRevision: 2 })
    expect(prompt().completions!.items.map(item => item.label)).toEqual(['/sessions'])
    await observe({ kind: 'value-change', controlId: 'text', formId: 'gallery-prompt', value: 'hello', draftRevision: 3 })
    expect(prompt().completions).toBeUndefined()
    await observe({ kind: 'value-change', controlId: 'text', formId: 'gallery-prompt', value: 'hello #r', draftRevision: 4 })
    expect(prompt().completions!.items.map(item => item.label)).toEqual(['#review'])
  })

  it('turns an accepted file into a token and an accepted command into text, both through a reset', async () => {
    const { prompt, observe, act } = await boot()
    await observe({ kind: 'value-change', controlId: 'text', formId: 'gallery-prompt', value: 'explain @no', draftRevision: 1 })
    await expect(act({ kind: 'completion-accept', controlId: 'gallery-prompt', itemId: 'notes' })).resolves.toEqual({ kind: 'completed' })
    expect(prompt().tokens.map(token => token.id)).toEqual(['image-1', 'file-2'])
    expect(prompt().reset.value).toBe('explain ')
    await observe({ kind: 'value-change', controlId: 'text', formId: 'gallery-prompt', value: '/tr', draftRevision: 2 })
    await act({ kind: 'completion-accept', controlId: 'gallery-prompt', itemId: 'trace' })
    expect(prompt().reset).toMatchObject({ rev: 2, value: '/trace ' })
    await expect(act({ kind: 'completion-accept', controlId: 'gallery-prompt', itemId: 'missing' })).resolves.toEqual({ kind: 'cancelled' })
    await expect(act({ kind: 'completion-dismiss', controlId: 'gallery-prompt' })).resolves.toEqual({ kind: 'completed' })
  })

  it('removes a token on request', async () => {
    const { prompt, act } = await boot()
    await expect(act({ kind: 'token-remove', controlId: 'gallery-prompt', tokenId: 'image-1' })).resolves.toMatchObject({ kind: 'completed', feedback: { message: 'Removed the attachment' } })
    expect(prompt().tokens).toEqual([])
  })

  it('acknowledges a submit with a new node, a longer history, and a cleared prompt', async () => {
    const { promptOf, observe, act } = await boot()
    const submit = (text: string) => ({ kind: 'submit' as const, controlId: 'gallery-prompt', submission: { actionId: 'gallery-prompt', draftRevision: 1, source: [], forms: [{ pagePath: [], formId: 'gallery-prompt', draftRevision: 1, fields: [{ id: 'text', change: 'set' as const, value: text }, { id: 'tokens', change: 'set' as const, value: ['image-1'] }] }] } })
    await observe({ kind: 'recall-change', controlId: 'gallery-prompt', source: 'queued', index: 0 })
    const sent = await act(submit('also update the footer'))
    expect(sent).toMatchObject({ kind: 'accepted', feedback: { severity: 'success', message: 'Sent with 1 attachment' } })
    const acknowledged = promptOf((sent as { node: unknown }).node)
    expect(acknowledged.tokens).toEqual([])
    // The recalled queued message left the queue, and what was sent is the newest history entry.
    expect(acknowledged.recall.map(item => `${item.kind}:${item.text}`)).toEqual(['history:also update the footer', 'history:run the width scan again', 'history:bump the changelog too'])
    await observe({ kind: 'recall-change', controlId: 'gallery-prompt', source: 'draft', index: -1 })
    const blank = await act({ ...submit('plain'), submission: { ...submit('plain').submission, forms: [{ ...submit('plain').submission.forms[0]!, fields: [{ id: 'text', change: 'set' as const, value: '   ' }] }] } })
    expect(blank).toMatchObject({ feedback: { message: 'Sent' } })
    expect(promptOf((blank as { node: unknown }).node).recall).toHaveLength(3)
  })

  it('settles every other event quietly', async () => {
    const { act } = await boot()
    await expect(act({ kind: 'dismiss' })).resolves.toEqual({ kind: 'completed' })
  })
})
