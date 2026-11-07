/** The settings overlay of an ordinary external consumer: opened from its editor action, saved into plugin state.
 * @module @mayfly-example/overlay/tests/interaction
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MayflyOverlayEntry } from '../../../packages/ui/src/contracts.ts'
import * as provider from '../../../packages/ui/src/provider.ts'
import * as frontend from '../../../packages/mayfly/src/frontend/index.ts'
import * as overlay from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const flush = () => new Promise<void>(resolve => { setImmediate(resolve) })
const address = (itemId: string) => ({ pagePath: [{ controlId: 'settings-pages', itemId }], formId: 'settings' })

async function setup(open = true) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(provider)
  await ctx.plugin(frontend)
  const consumer = await ctx.plugin(overlay)
  const extension = () => ctx.mayflyEditorExtensions.list().find(entry => entry.id === 'example.overlay.open')
  const activate = async (actionId = 'open') => {
    const entry = extension()!
    await entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: actionId, actionId }, {
      surfaceId: entry.id, operationId: 'example-open', source: [], revision: entry.revision, signal: new AbortController().signal, report: vi.fn(),
    })
  }
  if (open) await activate()
  return { ctx, consumer, extension, activate, model: () => ctx.mayflyUiInteraction.get('overlay', overlay.overlayRequest.id) }
}

const requestContext = (entry: MayflyOverlayEntry, signal = new AbortController().signal) => ({
  surfaceId: entry.id, operationId: 'example-test', source: entry.source, revision: entry.revision, signal, report: vi.fn(),
})

function submission(entry: MayflyOverlayEntry, forms: readonly unknown[] = [], source = entry.source) {
  return { actionId: 'save', source, forms }
}

describe('external settings overlay', () => {
  it('declares its opening action on a modifier key beside the editor', async () => {
    const { extension } = await setup(false)
    expect(extension()!.decoration.actions).toEqual([{ id: 'open', label: 'Example settings', key: overlay.OPEN_KEY }])
    expect(overlay.OPEN_KEY).toBe('alt+o')
  })

  it('saves both pages once into plugin state and reads them back when reopened', async () => {
    const { ctx, model: currentModel, activate } = await setup()
    const model = currentModel()!
    expect(model).toBeDefined()
    model.edit({ ...address('connection'), fieldId: 'name' }, 'Primary')
    model.activateTab({ pagePath: [], controlId: 'settings-pages' }, 'workspace')
    model.edit({ ...address('workspace'), fieldId: 'name' }, 'Secondary')
    model.edit({ ...address('workspace'), fieldId: 'limit' }, '250')
    model.invoke('save')
    model.invoke('save')
    await flush()
    expect(model.dirty).toBe(false)
    expect(ctx.mayflyOverlays.list()[0]!.update.reason).toBe('ack')
    expect(ctx.mayflyOverlays.list()[0]!.source).toEqual([{ resourceId: 'mayfly-example-overlay.settings', revision: 1 }])
    model.invoke('cancel')
    await flush()
    expect(ctx.mayflyOverlays.list()).toEqual([])
    await activate()
    const reopened = ctx.mayflyUiInteraction.get('overlay', overlay.overlayRequest.id)!
    expect(reopened).not.toBe(model)
    expect(reopened.form(address('connection'))!.fields.name!.value).toBe('Primary')
    expect(reopened.form(address('workspace'))!.fields.name!.value).toBe('Secondary')
  })

  it('focuses the open overlay on a repeated action, keeps its draft, and confirms before discarding', async () => {
    const { ctx, model: currentModel, activate } = await setup()
    const model = currentModel()!
    const initial = ctx.mayflyOverlays.list()[0]!
    model.edit({ ...address('connection'), fieldId: 'name' }, 'Draft')
    await activate()
    expect(ctx.mayflyUiInteraction.get('overlay', overlay.overlayRequest.id)).toBe(model)
    expect(ctx.mayflyOverlays.list()[0]!.focusRevision).toBeGreaterThan(initial.focusRevision)
    model.invoke('cancel')
    expect(model.decisionNode).toBeDefined()
    model.answerDecision(false)
    expect(model.form(address('connection'))!.fields.name!.value).toBe('Draft')
    model.invoke('cancel')
    model.answerDecision(true)
    await flush()
    expect(ctx.mayflyOverlays.list()).toEqual([])
  })

  it('ignores other editor actions', async () => {
    const { ctx, activate } = await setup(false)
    await activate('other')
    expect(ctx.mayflyOverlays.list()).toEqual([])
  })

  it('unloads its editor action, overlay, model, and saved values with the consumer Fiber', async () => {
    const { ctx, consumer, model: currentModel, extension } = await setup()
    const model = currentModel()!
    model.edit({ ...address('workspace'), fieldId: 'name' }, 'Transient')
    await consumer.dispose()
    expect(extension()).toBeUndefined()
    expect(ctx.mayflyOverlays.list()).toEqual([])
    expect(ctx.mayflyUiInteraction.list()).toEqual([])
    expect(model.disposed).toBe(true)
    await ctx.plugin(overlay)
    const entry = ctx.mayflyEditorExtensions.list()[0]!
    await entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'open', actionId: 'open' }, {
      surfaceId: entry.id, operationId: 'example-reopen', source: [], revision: entry.revision, signal: new AbortController().signal, report: vi.fn(),
    })
    expect(ctx.mayflyOverlays.list()[0]!.source).toEqual([{ resourceId: 'mayfly-example-overlay.settings', revision: 0 }])
  })

  it('defends direct action inputs, applies resets, and answers a stale form with a conflict', async () => {
    const bench = await setup()
    const entry = bench.ctx.mayflyOverlays.list()[0]!
    const action = entry.definition.onEvent!.action!
    expect(await action({ kind: 'activate', pagePath: [], controlId: 'noop', actionId: 'noop' }, requestContext(entry))).toEqual({ kind: 'completed' })
    const aborted = new AbortController()
    aborted.abort()
    expect(await action({ kind: 'submit', pagePath: [], controlId: 'submit', submission: submission(entry) as never }, requestContext(entry, aborted.signal))).toEqual({ kind: 'cancelled' })
    expect(await action({ kind: 'submit', pagePath: [], controlId: 'submit', submission: submission(entry, [], []) as never }, requestContext(entry))).toMatchObject({ kind: 'conflict' })

    for (const forms of [
      [{ pagePath: [], formId: 'other', fields: [] }],
      [{ pagePath: [{ controlId: 'settings-pages', itemId: 'other' }], formId: 'settings', fields: [] }],
      [{ pagePath: address('connection').pagePath, formId: 'settings', fields: [{ id: 'unknown', value: 1, change: 'set' }] }],
      [{ pagePath: address('connection').pagePath, formId: 'settings', fields: [{ id: 'name', value: ' ', change: 'set' }] }],
      [{ pagePath: address('connection').pagePath, formId: 'settings', fields: [{ id: 'transport', value: 'carrier', change: 'set' }] }],
      [{ pagePath: address('workspace').pagePath, formId: 'settings', fields: [{ id: 'limit', value: 0, change: 'set' }] }],
    ]) expect(await action({ kind: 'submit', pagePath: [], controlId: 'submit', submission: submission(entry, forms) as never }, requestContext(entry))).toMatchObject({ kind: 'failed' })

    const changed = await action({ kind: 'submit', pagePath: [], controlId: 'submit', submission: submission(entry, [
      { pagePath: address('connection').pagePath, formId: 'settings', fields: [{ id: 'name', value: 'Changed', change: 'set' }, { id: 'enabled', value: false, change: 'set' }] },
    ]) as never }, requestContext(entry))
    expect(changed).toMatchObject({ kind: 'accepted', source: [{ revision: 1 }] })
    // The form still carries revision 0: a second save from it would overwrite the first.
    expect(await action({ kind: 'submit', pagePath: [], controlId: 'submit', submission: submission(entry) as never }, requestContext(entry))).toMatchObject({ kind: 'conflict' })
    const reset = await action({ kind: 'submit', pagePath: [], controlId: 'submit', submission: submission(entry, [
      { pagePath: address('connection').pagePath, formId: 'settings', fields: [{ id: 'name', value: 'Changed', change: 'reset' }, { id: 'enabled', value: false, change: 'unchanged' }] },
    ], [{ resourceId: 'mayfly-example-overlay.settings', revision: 1 }]) as never }, requestContext(entry))
    expect(reset).toMatchObject({ kind: 'accepted', source: [{ revision: 2 }] })
    await bench.activate()
    bench.ctx.mayflyOverlays.close(overlay.overlayRequest.id)
    await bench.activate()
    const reopened = bench.ctx.mayflyUiInteraction.get('overlay', overlay.overlayRequest.id)!
    expect(reopened.form(address('connection'))!.fields.name!.value).toBe(overlay.defaults.connection.name)
    expect(reopened.form(address('connection'))!.fields.enabled!.value).toBe(false)
  })
})
