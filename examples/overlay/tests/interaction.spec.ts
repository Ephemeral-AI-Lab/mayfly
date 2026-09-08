/** Real native-settings edits from an ordinary external overlay consumer.
 * @module @mayfly-example/overlay/tests/interaction
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MayflyOverlayEntry } from '../../../packages/ui/src/contracts.ts'
import * as provider from '../../../packages/ui/src/provider.ts'
import * as frontend from '../../../packages/mayfly/src/frontend/index.ts'
import * as overlay from '../src/index.ts'
import { MemorySettings } from './settings.ts'

class Commands extends Service {
  open: (() => unknown) | undefined
  constructor(ctx: Context) { super(ctx, 'commands') }
  register(command: { readonly handler: () => unknown }): () => void {
    this.open = command.handler
    return this.ctx.effect(() => () => { this.open = undefined })
  }
}

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const flush = () => new Promise<void>(resolve => { setImmediate(resolve) })
const address = (itemId: string) => ({ pagePath: [{ controlId: 'settings-pages', itemId }], formId: 'settings' })

async function setup(open = true) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(Commands)
  await ctx.plugin(provider)
  await ctx.plugin(frontend)
  const consumer = await ctx.plugin(overlay)
  const commands = ctx.commands as unknown as Commands
  if (open) commands.open!()
  return { ctx, consumer, commands, settings: ctx.settings as MemorySettings, model: () => ctx.mayflyUiInteraction.get('overlay', overlay.overlayRequest.id) }
}

const requestContext = (entry: MayflyOverlayEntry, signal = new AbortController().signal) => ({
  surfaceId: entry.id, operationId: 'example-test', source: entry.source, revision: entry.revision, signal, report: vi.fn(),
})

function submission(entry: MayflyOverlayEntry, forms: readonly unknown[] = [], source = entry.source) {
  return { actionId: 'save', source, forms }
}

describe('external settings overlay', () => {
  it('saves both pages once through the native namespace and reads them back when reopened', async () => {
    const { ctx, model: currentModel, settings, commands } = await setup()
    const model = currentModel()!
    expect(model).toBeDefined()
    model.edit({ ...address('connection'), fieldId: 'name' }, 'Primary')
    model.activateTab({ pagePath: [], controlId: 'settings-pages' }, 'workspace')
    model.edit({ ...address('workspace'), fieldId: 'name' }, 'Secondary')
    model.edit({ ...address('workspace'), fieldId: 'limit' }, '250')
    expect(settings.writes).toBe(0)
    model.invoke('save')
    model.invoke('save')
    await flush()
    expect(settings.writes).toBe(1)
    expect(settings.get(overlay.SETTINGS_NAMESPACE)).toEqual({ connection: { name: 'Primary', transport: 'local', enabled: true }, workspace: { name: 'Secondary', limit: 250 } })
    expect(model.dirty).toBe(false)
    expect(ctx.mayflyOverlays.list()[0]!.update.reason).toBe('ack')
    model.invoke('cancel')
    await flush()
    expect(ctx.mayflyOverlays.list()).toEqual([])
    commands.open!()
    const reopened = ctx.mayflyUiInteraction.get('overlay', overlay.overlayRequest.id)!
    expect(reopened).not.toBe(model)
    expect(reopened.form(address('workspace'))!.fields.name!.value).toBe('Secondary')
  })

  it('retains a live draft on repeated command entry and requires confirmation before discarding', async () => {
    const { ctx, model: currentModel, commands, settings } = await setup()
    const model = currentModel()!
    model.edit({ ...address('connection'), fieldId: 'name' }, 'Draft')
    commands.open!()
    expect(ctx.mayflyUiInteraction.get('overlay', overlay.overlayRequest.id)).toBe(model)
    model.invoke('cancel')
    expect(model.decisionNode).toBeDefined()
    model.answerDecision(false)
    expect(model.form(address('connection'))!.fields.name!.value).toBe('Draft')
    model.invoke('cancel')
    model.answerDecision(true)
    await flush()
    expect(ctx.mayflyOverlays.list()).toEqual([])
    expect(settings.writes).toBe(0)
  })

  it('shows a conflict from an external native write and preserves the unsaved field', async () => {
    const { model: currentModel, settings } = await setup()
    const model = currentModel()!
    model.edit({ ...address('connection'), fieldId: 'name' }, 'Draft')
    await settings.mutate(overlay.SETTINGS_NAMESPACE, [{ op: 'set', path: ['connection', 'name'], value: 'External' }])
    expect(model.form(address('connection'))!.fields.name).toMatchObject({ value: 'Draft', conflict: true })
    model.invoke('save')
    await flush()
    expect(settings.writes).toBe(1)
    model.updateForm(address('connection'), { kind: 'resolve-conflict', fieldId: 'name', choice: 'draft' })
    model.invoke('save')
    await flush()
    expect(settings.writes).toBe(2)
    expect(model.dirty).toBe(false)
    expect(settings.get(overlay.SETTINGS_NAMESPACE)).toMatchObject({ connection: { name: 'Draft' } })
  })

  it('unloads its command, namespace, registration, and model through the consumer Fiber', async () => {
    const { ctx, consumer, commands, model: currentModel, settings } = await setup()
    const model = currentModel()!
    model.edit({ ...address('workspace'), fieldId: 'name' }, 'Transient')
    await consumer.dispose()
    expect(commands.open).toBeUndefined()
    expect(ctx.mayflyOverlays.list()).toEqual([])
    expect(ctx.mayflyUiInteraction.list()).toEqual([])
    expect(model.disposed).toBe(true)
    expect(settings.describe()).toEqual([])
  })

  it('refreshes only its namespace before, during, and after an active overlay', async () => {
    const bench = await setup(false)
    await bench.settings.mutate(overlay.SETTINGS_NAMESPACE, [{ op: 'set', path: ['connection', 'name'], value: 'Before open' }])
    bench.ctx.emit('settings/updated', 'other' as never)
    bench.ctx.emit('settings/document-updated', 'other' as never)
    expect(bench.model()).toBeUndefined()
    bench.commands.open!()
    const initial = bench.ctx.mayflyOverlays.list()[0]!
    bench.commands.open!()
    expect(bench.ctx.mayflyOverlays.list()[0]!.focusRevision).toBeGreaterThan(initial.focusRevision)
    await bench.settings.mutate(overlay.SETTINGS_NAMESPACE, [{ op: 'set', path: ['workspace', 'name'], value: 'Live' }])
    expect(bench.ctx.mayflyOverlays.list()[0]!.revision).toBeGreaterThan(initial.revision)
    bench.ctx.mayflyOverlays.close(overlay.overlayRequest.id)
    await bench.settings.mutate(overlay.SETTINGS_NAMESPACE, [{ op: 'set', path: ['workspace', 'name'], value: 'Closed' }])
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])
  })

  it('defends direct action inputs and accepts reset and no-op submissions', async () => {
    const bench = await setup()
    const entry = bench.ctx.mayflyOverlays.list()[0]!
    const action = entry.definition.onEvent!.action!
    expect(await action({ kind: 'activate', pagePath: [], controlId: 'noop', actionId: 'noop' }, requestContext(entry))).toEqual({ kind: 'completed' })
    const aborted = new AbortController()
    aborted.abort()
    expect(await action({ kind: 'submit', submission: submission(entry) as never }, requestContext(entry, aborted.signal))).toEqual({ kind: 'cancelled' })
    expect(await action({ kind: 'submit', submission: submission(entry, [], []) as never }, requestContext(entry))).toMatchObject({ kind: 'conflict' })

    for (const forms of [
      [{ pagePath: [], formId: 'other', fields: [] }],
      [{ pagePath: [{ controlId: 'settings-pages', itemId: 'other' }], formId: 'settings', fields: [] }],
      [{ pagePath: address('connection').pagePath, formId: 'settings', fields: [{ id: 'unknown', value: 1, change: 'set' }] }],
    ]) expect(await action({ kind: 'submit', submission: submission(entry, forms) as never }, requestContext(entry))).toMatchObject({ kind: 'failed' })

    const accepted = await action({ kind: 'submit', submission: submission(entry, [
      { pagePath: address('connection').pagePath, formId: 'settings', fields: [{ id: 'name', value: 'Default', change: 'reset' }, { id: 'enabled', value: true, change: 'unchanged' }] },
      { pagePath: address('workspace').pagePath, formId: 'settings', fields: [{ id: 'limit', value: 100, change: 'unchanged' }] },
    ]) as never }, requestContext(entry))
    expect(accepted).toMatchObject({ kind: 'accepted' })
    expect(await action({ kind: 'submit', submission: submission(entry, [
      { pagePath: address('connection').pagePath, formId: 'settings', fields: [{ id: 'enabled', value: true, change: 'unchanged' }] },
    ]) as never }, requestContext(entry))).toMatchObject({ kind: 'accepted' })
  })

  it('contains cancellation after mutate and maps conflict and persistence failures', async () => {
    const form = [{ pagePath: address('connection').pagePath, formId: 'settings', fields: [{ id: 'name', value: 'Changed', change: 'set' }] }]

    const cancelled = await setup()
    const cancelledEntry = cancelled.ctx.mayflyOverlays.list()[0]!
    const original = cancelled.settings.mutate.bind(cancelled.settings)
    const gate = Promise.withResolvers<void>()
    const mutate = vi.spyOn(cancelled.settings, 'mutate').mockImplementationOnce(async (...args) => { await gate.promise; return original(...args) })
    const controller = new AbortController()
    const pending = cancelledEntry.definition.onEvent!.action!({ kind: 'submit', submission: submission(cancelledEntry, form) as never }, requestContext(cancelledEntry, controller.signal))
    await vi.waitFor(() => expect(mutate).toHaveBeenCalled())
    controller.abort()
    gate.resolve()
    expect(await pending).toEqual({ kind: 'cancelled' })

    for (const [error, kind] of [
      [new SettingsConflictError(overlay.SETTINGS_NAMESPACE as never, 0, 1), 'conflict'],
      [new Error('disk failed'), 'failed'],
    ] as const) {
      const bench = await setup()
      const entry = bench.ctx.mayflyOverlays.list()[0]!
      vi.spyOn(bench.settings, 'mutate').mockRejectedValueOnce(error)
      expect(await entry.definition.onEvent!.action!({ kind: 'submit', submission: submission(entry, form) as never }, requestContext(entry))).toMatchObject({ kind })
    }

    const rejected = await setup()
    const rejectedEntry = rejected.ctx.mayflyOverlays.list()[0]!
    const failure = Promise.withResolvers<never>()
    const failedMutate = vi.spyOn(rejected.settings, 'mutate').mockReturnValueOnce(failure.promise)
    const rejectedController = new AbortController()
    const result = rejectedEntry.definition.onEvent!.action!({ kind: 'submit', submission: submission(rejectedEntry, form) as never }, requestContext(rejectedEntry, rejectedController.signal))
    await vi.waitFor(() => expect(failedMutate).toHaveBeenCalled())
    rejectedController.abort()
    failure.reject(new Error('cancelled'))
    expect(await result).toEqual({ kind: 'cancelled' })
  })
})
