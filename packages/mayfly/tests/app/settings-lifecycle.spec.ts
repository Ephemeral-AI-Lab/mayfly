/** Actual settings overlays, dirty drafts, ACK publication, and exact native Host generations.
 * @module @ephemeral-ai/mayfly-remote/tests/settings-lifecycle
 */
import Schema from '@deepseek-ai/schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { visibleWidth } from '../../src/core.ts'
import { RemoteSettingsController } from '../../src/app/features/settings.ts'
import { CordisRemoteLocalPresentation } from '../../src/app/features/presentation.ts'
import { good, taskFixture, tick } from './task-feature-fixture.ts'
import { namespace, schemaJson } from './configuration-fixture.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const f = await taskFixture()
  let descriptor = namespace('mayfly', {
    schema: schemaJson(Schema.object({ theme: Schema.string().default('dark'), apiKey: Schema.string().role('secret').default('native-secret-default') })),
    value: { theme: 'dark', apiKey: 'native-saved-secret' }, secrets: [{ path: ['apiKey'], set: true }],
  })
  const describe = vi.fn(async () => good({ writable: true, hasDocument: true, namespaces: [descriptor] } satisfies SettingsDescribeValue))
  const mutate = vi.fn(async (_ns: string, operations: readonly SettingsPathOpView[], revision: number): Promise<{ readonly ok: true, readonly value: SettingsNamespaceView }> => {
    expect(revision).toBe(descriptor.revision)
    expect(operations).toEqual([{ op: 'set', path: ['theme'], value: 'tide' }])
    descriptor = { ...descriptor, revision: revision + 1, value: { theme: 'tide' }, user: { theme: 'tide' } }
    return good(descriptor)
  })
  Object.assign(f.client.remote, {
    settings: { describe, mutate },
    permissionPresets: { catalog: async () => good({ options: [] }) },
    agentPresets: { list: async () => good({ presets: [] }) },
  })
  const presentation = new CordisRemoteLocalPresentation(f.options)
  const controller = new RemoteSettingsController({ ...f.options, presentation })
  cleanups.push(async () => { controller.dispose(); presentation.dispose(); await f.dispose() })
  const form = { pagePath: [{ controlId: 'namespaces', itemId: 'mayfly' }], formId: 'settings-form' }
  return { ...f, controller, describe, mutate, form }
}

describe('settings native UI lifecycle', () => {
  it('retains a dirty draft through No, publishes a native save ACK, and keeps secrets out of the surface', async () => {
    const f = await fixture()
    await f.controller.open()
    await tick()
    const model = f.ctx.mayflyUiInteraction.get('overlay', 'mayfly.settings')!
    const entry = f.ctx.mayflyOverlays.list()[0]!
    for (const width of [12, 40, 80, 120]) expect(f.render(entry.node, width).every(line => visibleWidth(line) <= width)).toBe(true)
    expect(JSON.stringify(entry.node)).not.toMatch(/native-saved-secret|native-secret-default/)
    model.edit({ ...f.form, fieldId: '["theme"]' }, 'tide')
    expect(model.formsDirty).toBe(true)
    model.requestClose()
    expect(model.decisionNode).toBeDefined()
    model.answerDecision(false)
    expect(model.form(f.form)?.fields['["theme"]']?.value).toBe('tide')
    model.invoke('save', f.form.pagePath)
    await vi.waitFor(() => { expect(model.operationSnapshot().some(operation => operation.actionId === 'save' && operation.phase === 'succeeded')).toBe(true) })
    expect(model.formsDirty).toBe(false)
    expect(f.ctx.mayflyOverlays.list()[0]?.source).toContainEqual({ resourceId: 'settings/mayfly', revision: 8 })
    expect(f.mutate).toHaveBeenCalledOnce()
    expect(JSON.stringify(f.ctx.mayflyOverlays.list()[0]?.node)).not.toMatch(/native-saved-secret|native-secret-default/)
  })

  it('retires a pending native save on reconnect without granting a late acknowledgement or retry', async () => {
    const f = await fixture()
    await f.controller.open()
    const model = f.ctx.mayflyUiInteraction.get('overlay', 'mayfly.settings')!
    const pending = Promise.withResolvers<{ readonly ok: true, readonly value: SettingsNamespaceView }>()
    f.mutate.mockReturnValueOnce(pending.promise)
    model.edit({ ...f.form, fieldId: '["theme"]' }, 'tide')
    model.invoke('save', f.form.pagePath)
    await vi.waitFor(() => { expect(f.mutate).toHaveBeenCalledOnce() })
    f.reconnect()
    expect(model.disposed).toBe(true)
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    pending.resolve(good(namespace('mayfly', { revision: 8, value: { theme: 'late native write' } })))
    await tick(); await tick()
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    expect(f.mutate).toHaveBeenCalledOnce()
    expect(f.options.notice.set).not.toHaveBeenCalled()
    await f.controller.open()
    expect(f.ctx.mayflyUiInteraction.get('overlay', 'mayfly.settings')).not.toBe(model)
    expect(f.ctx.mayflyOverlays.list()[0]?.source).toContainEqual({ resourceId: 'settings/mayfly', revision: 7 })
  })
})
