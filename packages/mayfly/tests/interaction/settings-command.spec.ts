/** Native settings CAS, inheritance, editor workflows, and shared draft lifetime.
 * @module @ephemeral-ai/mayfly/tests/interaction/settings-command
 */
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openSettingsNamespace } from '../../src/interaction/settings-command.ts'
import { setExternalEditorLauncher } from '../../src/interaction/external-editor.ts'
import { settingsFixture, settingsField } from './settings-fixture.ts'
import { renderRequest, flushRequests } from './request-fixture.ts'
import { mkdtempTracked, registerTempDirCleanup } from '../core/temp-dir.ts'
import type { MayflyOverlayEntry } from '../../../ui/src/contracts.ts'

const contexts: Context[] = []
registerTempDirCleanup()
afterEach(async () => { setExternalEditorLauncher(undefined); vi.unstubAllEnvs(); for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup(schema?: Schema, base?: Record<string, unknown>) { const ctx = new Context(); contexts.push(ctx); return settingsFixture(ctx, schema, base) }
const field = settingsField
const actionContext = (entry: MayflyOverlayEntry, signal = new AbortController().signal) => ({ surfaceId: entry.id, operationId: 'settings-test', source: entry.source, revision: entry.revision, signal, report: vi.fn() })
const save = (entry: MayflyOverlayEntry, fields: readonly { id: string, change: 'set' | 'reset' | 'unchanged', value?: unknown }[] = []) => ({
  kind: 'submit' as const,
  submission: { actionId: 'save', source: entry.source, forms: [{ pagePath: [], formId: 'settings-form', fields }] },
})

describe('native settings UI', () => {
  it('browses native namespaces without a renderer or current Agent and focuses an existing editor', async () => {
    const bench = await setup()
    const invoke = () => bench.commands.entries.get('settings')!.handler({} as never)
    expect(invoke()).toEqual({ kind: 'success' })
    const browser = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.settings')!
    browser.emit({ kind: 'selection-accept', pagePath: [], controlId: 'namespaces', selectedIds: ['test-settings'] })
    await flushRequests()
    const model = await bench.open()
    model.edit(field('name'), 'draft')
    expect(await bench.open()).toBe(model)
    expect(invoke()).toEqual({ kind: 'success' })
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(2)
    expect(model.form(field('name'))!.fields[field('name').fieldId]!.value).toBe('draft')
  })

  it('saves a namespace once using typed path operations and preserves untouched data', async () => {
    const bench = await setup()
    await bench.settings.mutate('test-settings', [{ op: 'set', path: ['untouched'], value: { keep: true } }])
    const model = await bench.open()
    const mutate = vi.spyOn(bench.settings, 'mutate')
    model.edit(field('name'), '  exact text  ')
    model.edit(field('count'), '4')
    model.edit(field('mode'), JSON.stringify('slow'))
    model.edit(field('levels'), [JSON.stringify('high')])
    model.edit(field('enabled'), false)
    model.edit(field('nested', 'value'), 'changed')
    expect(mutate).not.toHaveBeenCalled()
    model.invoke('save')
    model.invoke('save')
    await flushRequests()
    expect(mutate).toHaveBeenCalledOnce()
    expect(mutate.mock.calls[0]![2]).toBe(1)
    expect(bench.settings.get('test-settings')).toMatchObject({ name: '  exact text  ', count: 4, mode: 'slow', levels: ['high'], enabled: false, nested: { value: 'changed' }, untouched: { keep: true } })
    expect(model.dirty).toBe(false)
    expect(model.feedbackSnapshot().at(-1)?.severity).toBe('success')
  })

  it('preserves equal-value explicit overrides and resets through the shared field tools', async () => {
    const bench = await setup(undefined, { name: 'composition' })
    const model = await bench.open()
    let renderer = renderRequest(model)
    const name = field('name').fieldId
    expect(renderer.focusTarget!.restoreFocusIdentity?.({ controlId: name, itemId: 'override', pagePath: [] })).toBe(true)
    renderer.input('\r')
    expect(model.form(field('name'))!.fields[name]).toMatchObject({ value: 'composition', change: 'set' })
    model.invoke('save')
    await flushRequests()
    expect(bench.settings.describe().find(item => item.ns === 'test-settings')!.user).toMatchObject({ name: 'composition' })
    renderer.runtime.dispose()
    renderer = renderRequest(model)
    expect(renderer.focusTarget!.restoreFocusIdentity?.({ controlId: name, itemId: 'reset', pagePath: [] })).toBe(true)
    renderer.input('\r')
    expect(model.form(field('name'))!.fields[name]).toMatchObject({ value: 'composition', change: 'reset' })
    model.invoke('save')
    await flushRequests()
    expect(bench.settings.describe().find(item => item.ns === 'test-settings')!.user).not.toHaveProperty('name')
    expect(bench.settings.get('test-settings')).toMatchObject({ name: 'composition' })
    expect(model.dirty).toBe(false)
    renderer.runtime.dispose()
  })

  it('observes raw document revisions even when resolved values do not change', async () => {
    const bench = await setup()
    const model = await bench.open()
    const values = vi.fn()
    bench.ctx.on('settings/updated', values)
    model.edit(field('name'), 'local')
    await bench.settings.mutate('test-settings', [{ op: 'set', path: ['enabled'], value: true }])
    await flushRequests()
    expect(values).not.toHaveBeenCalled()
    expect(model.source).toContainEqual({ resourceId: 'settings/test-settings', revision: 1 })
    expect(model.form(field('name'))!.fields[field('name').fieldId]!.value).toBe('local')
    model.invoke('save')
    await flushRequests()
    expect(bench.settings.describe().find(item => item.ns === 'test-settings')!.user).toEqual({ enabled: true, name: 'local' })
  })

  it('does not retry a stale revision and requires a shared conflict decision', async () => {
    const bench = await setup()
    const model = await bench.open()
    model.edit(field('name'), 'local')
    const mutate = vi.spyOn(bench.settings, 'mutate')
    const external = bench.settings.mutate('test-settings', [{ op: 'set', path: ['name'], value: 'external' }])
    model.invoke('save')
    await external
    await flushRequests()
    expect(bench.settings.get('test-settings')).toMatchObject({ name: 'external' })
    expect(model.form(field('name'))!.fields[field('name').fieldId]).toMatchObject({ value: 'local', conflict: true })
    const calls = mutate.mock.calls.length
    model.invoke('save')
    await flushRequests()
    expect(mutate).toHaveBeenCalledTimes(calls)
    const renderer = renderRequest(model)
    expect(renderer.focusTarget!.restoreFocusIdentity?.({ controlId: field('name').fieldId, itemId: 'draft', pagePath: [] })).toBe(true)
    renderer.input('\r')
    model.invoke('save')
    await flushRequests()
    expect(bench.settings.get('test-settings')).toMatchObject({ name: 'local' })
    renderer.runtime.dispose()
  })

  it('can take the authoritative value from the shared conflict controls', async () => {
    const bench = await setup()
    const model = await bench.open()
    model.edit(field('name'), 'local')
    await bench.settings.mutate('test-settings', [{ op: 'set', path: ['name'], value: 'external' }])
    await flushRequests()
    const renderer = renderRequest(model)
    renderer.focusTarget!.restoreFocusIdentity?.({ controlId: field('name').fieldId, itemId: 'source', pagePath: [] })
    renderer.input('\r')
    expect(model.form(field('name'))!.fields[field('name').fieldId]).toMatchObject({ value: 'external', conflict: false, change: 'unchanged' })
    expect(model.dirty).toBe(false)
    renderer.runtime.dispose()
  })

  it('refuses stale composition data even when a namespace is re-registered at the same raw revision', async () => {
    const bench = await setup(Schema.object({ name: Schema.string().default('old') }))
    const model = await bench.open()
    model.edit(field('name'), 'local')
    await bench.owner.dispose()
    await bench.ctx.plugin({ name: 'replacement-namespace', inject: ['settings'], apply(ctx: Context) { ctx.settings.register('test-settings', Schema.object({ name: Schema.string().default('new') })) } })
    model.invoke('save')
    await flushRequests()
    expect(bench.settings.writes).toBe(0)
    expect(bench.settings.get('test-settings')).toEqual({ name: 'new' })
    expect(model.form(field('name'))!.fields[field('name').fieldId]).toMatchObject({ value: 'local', conflict: true })
  })

  it('uses literal path arrays for dotted keys and nested properties', async () => {
    const bench = await setup(Schema.object({ 'a.b': Schema.string().default('flat'), a: Schema.object({ b: Schema.string().default('nested') }) }))
    const model = await bench.open()
    model.edit(field('a.b'), 'flat change')
    model.edit(field('a', 'b'), 'nested change')
    model.invoke('save')
    await flushRequests()
    expect(bench.settings.get('test-settings')).toEqual({ 'a.b': 'flat change', a: { b: 'nested change' } })
  })

  it('keeps optional boolean fields stable while setting and resetting their overrides', async () => {
    const bench = await setup(Schema.object({ optional: Schema.boolean() }))
    const model = await bench.open()
    model.edit(field('optional'), 'false')
    model.invoke('save')
    await flushRequests()
    expect(bench.settings.get('test-settings')).toEqual({ optional: false })
    expect(model.form(field('optional'))!.fields[field('optional').fieldId]).toMatchObject({ definition: { kind: 'select' }, value: 'false', change: 'unchanged' })
    model.updateForm(field('optional'), { kind: 'reset', fieldId: field('optional').fieldId })
    model.invoke('save')
    await flushRequests()
    expect(bench.settings.get('test-settings')).toEqual({})
    expect(model.dirty).toBe(false)
  })

  it('reprojects localized labels without dropping drafts or changing the field version', async () => {
    const bench = await setup()
    const model = await bench.open()
    const stamps = model.source
    model.edit(field('name'), 'draft')
    bench.ctx.mayflyLocale.setPreference('zh')
    await flushRequests()
    expect(model.source).toEqual(stamps)
    expect(model.form(field('name'))!.fields[field('name').fieldId]!.value).toBe('draft')
    expect(JSON.stringify(model.node)).toContain('保存')
    model.invoke('save')
    await flushRequests()
    expect(bench.settings.get('test-settings')).toMatchObject({ name: 'draft' })
  })

  it('preserves drafts after persistence failure and validates numeric intermediate input before writing', async () => {
    const bench = await setup()
    const model = await bench.open()
    const persist = vi.spyOn(bench.settings as unknown as { persist: () => Promise<void> }, 'persist')
    model.edit(field('count'), '-')
    model.invoke('save')
    await flushRequests()
    expect(persist).not.toHaveBeenCalled()
    model.edit(field('count'), '6')
    persist.mockRejectedValueOnce(new Error('disk failed with secret-looking diagnostic'))
    model.invoke('save')
    await flushRequests()
    expect(model.dirty).toBe(true)
    expect(model.feedbackSnapshot().at(-1)?.message).toBe('Settings could not be saved')
    model.invoke('save')
    await flushRequests()
    expect(bench.settings.get('test-settings')).toMatchObject({ count: 6 })
    expect(model.dirty).toBe(false)
  })

  it('uses write-only secrets, leaves them untouched on unrelated saves, and resets their overrides', async () => {
    const bench = await setup()
    await bench.settings.mutate('test-settings', [{ op: 'set', path: ['secret'], value: 'stored-private' }])
    const model = await bench.open()
    expect(JSON.stringify(model.node)).not.toMatch(/stored-private|private-default/)
    model.edit(field('name'), 'new')
    model.invoke('save')
    await flushRequests()
    expect(bench.settings.get('test-settings')).toMatchObject({ secret: 'stored-private' })
    model.edit(field('secret'), 'replacement')
    model.invoke('save')
    await flushRequests()
    expect(model.form(field('secret'))!.fields[field('secret').fieldId]!.value).toBe('')
    expect(bench.settings.get('test-settings')).toMatchObject({ secret: 'replacement' })
    model.updateForm(field('secret'), { kind: 'reset', fieldId: field('secret').fieldId })
    model.invoke('save')
    await flushRequests()
    expect(bench.settings.get('test-settings')).toMatchObject({ secret: 'private-default' })
  })

  it('protects drafts on close, survives renderer reconstruction, and withdraws after provider unload', async () => {
    const bench = await setup()
    const model = await bench.open()
    model.edit(field('name'), 'draft')
    let renderer = renderRequest(model)
    renderer.runtime.dispose()
    renderer = renderRequest(model)
    expect(renderer.component.render(80).join('\n')).toContain('draft')
    model.requestClose()
    expect(model.decisionNode).toBeDefined()
    model.answerDecision(false)
    expect(model.dirty).toBe(true)
    await bench.front.dispose()
    expect(model.disposed).toBe(true)
    model.invoke('save')
    expect(bench.settings.get('test-settings')).toMatchObject({ name: 'base' })
    renderer.runtime.dispose()
  })

  it('does not revive an editor after its asynchronous discovery owner unloads', async () => {
    const bench = await setup()
    const gate = Promise.withResolvers<never[]>()
    bench.ctx.provide('agentPresets', { list: () => gate.promise } as never)
    const child = await bench.ctx.plugin({ name: 'opener', inject: ['settings', 'mayflyOverlays'], apply(scope: Context) { scope.provide('testOpenSettings', () => openSettingsNamespace(scope, 'test-settings')) } })
    const pending = (bench.ctx.get('testOpenSettings') as () => Promise<boolean>)()
    await child.dispose()
    gate.resolve([])
    await expect(pending).resolves.toBe(false)
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])
  })

  it('closes a removed namespace when refreshed and disables writes on read-only providers', async () => {
    const bench = await setup()
    Object.defineProperty(bench.settings, 'writable', { value: false })
    const model = await bench.open()
    model.edit(field('name'), 'blocked')
    model.invoke('save')
    await flushRequests()
    expect(model.dirty).toBe(false)
    expect(bench.settings.writes).toBe(0)
    await bench.owner.dispose()
    model.invoke('refresh')
    await flushRequests()
    expect(model.disposed).toBe(true)
    await expect(openSettingsNamespace(bench.ctx, 'missing')).resolves.toBe(false)
  })

  it.each(['save', 'conflict', 'cancel', 'unload'] as const)('handles external document %s without overwriting a concurrent file', async outcome => {
    const bench = await setup()
    const dir = mkdtempTracked('settings-document-')
    const path = join(dir, 'settings.yaml')
    await writeFile(path, 'original\n')
    vi.spyOn(bench.settings, 'prepareDocument').mockResolvedValue(path)
    vi.stubEnv('VISUAL', 'test-editor')
    bench.ctx.provide('mayflyScreen', { suspend: async (task: () => Promise<unknown>) => task() } as never)
    const gate = Promise.withResolvers<string | undefined>()
    const launch = vi.fn(async () => gate.promise)
    setExternalEditorLauncher(launch)
    bench.commands.entries.get('settings')!.handler({} as never)
    const model = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.settings')!
    model.invoke('open-file')
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce())
    if (outcome === 'conflict') await writeFile(path, 'concurrent\n')
    if (outcome === 'unload') await bench.front.dispose()
    gate.resolve(outcome === 'cancel' ? undefined : 'edited\n')
    await vi.waitFor(async () => {
      expect(await readFile(path, 'utf8'), JSON.stringify(model.feedbackSnapshot())).toBe(outcome === 'save' ? 'edited\n' : outcome === 'conflict' ? 'concurrent\n' : 'original\n')
      if (outcome !== 'unload') expect(model.operationSnapshot().some(item => item.phase === 'running')).toBe(false)
    })
  })

  it('loads dynamic choices, rejects pre-aborted opens, and focuses a raced editor', async () => {
    const bench = await setup()
    const aborted = new AbortController()
    aborted.abort()
    expect(await openSettingsNamespace(bench.ctx, 'test-settings', aborted.signal)).toBe(false)

    bench.ctx.provide('permissionPresets', { names: ['safe', 'full'] } as never)
    bench.ctx.provide('agentPresets', { list: async () => [{ id: 'standard' }, { id: 'minimal' }] } as never)
    expect(await openSettingsNamespace(bench.ctx, 'test-settings')).toBe(true)
    bench.ctx.mayflyOverlays.close(`mayfly.settings.${Buffer.from('test-settings').toString('hex')}`)

    const gate = Promise.withResolvers<{ id: string }[]>()
    bench.ctx.set('agentPresets', { list: () => gate.promise } as never)
    const first = openSettingsNamespace(bench.ctx, 'test-settings')
    const second = openSettingsNamespace(bench.ctx, 'test-settings')
    gate.resolve([{ id: 'standard' }])
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(bench.ctx.mayflyOverlays.list().filter(entry => entry.id.includes(Buffer.from('test-settings').toString('hex')))).toHaveLength(1)

    bench.ctx.mayflyOverlays.close(`mayfly.settings.${Buffer.from('test-settings').toString('hex')}`)
    bench.ctx.set('agentPresets', { list: () => Promise.reject(new Error('roster unavailable')) } as never)
    expect(await openSettingsNamespace(bench.ctx, 'test-settings')).toBe(true)
  })

  it('defends namespace events, no-op saves, missing forms, and removed descriptors', async () => {
    const bench = await setup()
    await openSettingsNamespace(bench.ctx, 'test-settings')
    const entry = bench.ctx.mayflyOverlays.list().find(item => item.id.includes(Buffer.from('test-settings').toString('hex')))!
    const action = entry.definition.onEvent!.action!
    expect(await action({ kind: 'activate', pagePath: [], controlId: 'noop', actionId: 'noop' }, actionContext(entry))).toEqual({ kind: 'completed' })
    expect(await action({ kind: 'activate', pagePath: [], controlId: 'settings-actions', actionId: 'refresh' }, actionContext(entry))).toEqual({ kind: 'completed' })
    const aborted = new AbortController()
    aborted.abort()
    expect(await action(save(entry), actionContext(entry, aborted.signal))).toEqual({ kind: 'cancelled' })
    expect(await action(save(entry), actionContext(entry))).toMatchObject({ kind: 'accepted' })
    expect(await action({ kind: 'submit', submission: { actionId: 'save', source: entry.source, forms: [] } }, actionContext(entry))).toMatchObject({ kind: 'failed' })

    bench.ctx.emit('settings/updated', 'other' as never)
    bench.ctx.emit('settings/document-updated', 'other' as never)
    await bench.owner.dispose()
    expect(await action(save(entry), actionContext(entry))).toMatchObject({ kind: 'cancelled', dismiss: true })
  })

  it('contains save cancellation and namespace removal after persistence', async () => {
    const cancelled = await setup()
    await openSettingsNamespace(cancelled.ctx, 'test-settings')
    const entry = cancelled.ctx.mayflyOverlays.list().find(item => item.id.includes(Buffer.from('test-settings').toString('hex')))!
    const original = cancelled.settings.mutate.bind(cancelled.settings)
    const gate = Promise.withResolvers<void>()
    const mutate = vi.spyOn(cancelled.settings, 'mutate').mockImplementationOnce(async (...args) => { await gate.promise; return original(...args) })
    const controller = new AbortController()
    const pending = entry.definition.onEvent!.action!(save(entry, [{ id: field('name').fieldId, change: 'set', value: 'changed' }]), actionContext(entry, controller.signal))
    await vi.waitFor(() => expect(mutate).toHaveBeenCalled())
    controller.abort()
    gate.resolve()
    expect(await pending).toEqual({ kind: 'cancelled' })

    const removed = await setup()
    await openSettingsNamespace(removed.ctx, 'test-settings')
    const removedEntry = removed.ctx.mayflyOverlays.list().find(item => item.id.includes(Buffer.from('test-settings').toString('hex')))!
    const removedOriginal = removed.settings.mutate.bind(removed.settings)
    vi.spyOn(removed.settings, 'mutate').mockImplementationOnce(async (...args) => { const result = await removedOriginal(...args); await removed.owner.dispose(); return result })
    expect(await removedEntry.definition.onEvent!.action!(save(removedEntry, [{ id: field('name').fieldId, change: 'set', value: 'changed' }]), actionContext(removedEntry))).toMatchObject({ kind: 'cancelled', dismiss: true })

    const failed = await setup()
    await openSettingsNamespace(failed.ctx, 'test-settings')
    const failedEntry = failed.ctx.mayflyOverlays.list().find(item => item.id.includes(Buffer.from('test-settings').toString('hex')))!
    const rejection = Promise.withResolvers<never>()
    const failedMutate = vi.spyOn(failed.settings, 'mutate').mockReturnValueOnce(rejection.promise)
    const failedAbort = new AbortController()
    const failedResult = failedEntry.definition.onEvent!.action!(save(failedEntry, [{ id: field('name').fieldId, change: 'set', value: 'changed' }]), actionContext(failedEntry, failedAbort.signal))
    await vi.waitFor(() => expect(failedMutate).toHaveBeenCalled())
    failedAbort.abort()
    rejection.reject(new Error('cancelled'))
    expect(await failedResult).toEqual({ kind: 'cancelled' })

    const vanished = await setup()
    await openSettingsNamespace(vanished.ctx, 'test-settings')
    const vanishedEntry = vanished.ctx.mayflyOverlays.list().find(item => item.id.includes(Buffer.from('test-settings').toString('hex')))!
    const vanishedRejection = Promise.withResolvers<never>()
    const vanishedMutate = vi.spyOn(vanished.settings, 'mutate').mockReturnValueOnce(vanishedRejection.promise)
    const vanishedResult = vanishedEntry.definition.onEvent!.action!(save(vanishedEntry, [{ id: field('name').fieldId, change: 'set', value: 'changed' }]), actionContext(vanishedEntry))
    await vi.waitFor(() => expect(vanishedMutate).toHaveBeenCalled())
    await vanished.owner.dispose()
    vanishedRejection.reject(new Error('namespace removed'))
    expect(await vanishedResult).toMatchObject({ kind: 'cancelled', dismiss: true })
  })

  it('refreshes dynamic providers and contains superseded or closed refreshes', async () => {
    const bench = await setup()
    await openSettingsNamespace(bench.ctx, 'test-settings')
    const id = `mayfly.settings.${Buffer.from('test-settings').toString('hex')}`
    const first = Promise.withResolvers<{ id: string }[]>()
    const second = Promise.withResolvers<{ id: string }[]>()
    const list = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue([])
    bench.ctx.provide('agentPresets', { list } as never)
    await flushRequests()
    bench.ctx.emit('settings/updated', 'test-settings' as never)
    bench.ctx.emit('settings/document-updated', 'test-settings' as never)
    await vi.waitFor(() => expect(list).toHaveBeenCalled())
    second.resolve([])
    first.resolve([])
    await flushRequests()
    bench.ctx.mayflyOverlays.close(id)
    bench.ctx.emit('settings/updated', 'test-settings' as never)
    await flushRequests()
    expect(bench.ctx.mayflyOverlays.list().some(entry => entry.id === id)).toBe(false)
  })

  it('covers raw document guards and failures through the root handler', async () => {
    const readonly = await setup()
    Object.defineProperty(readonly.settings, 'writable', { value: false })
    readonly.commands.entries.get('settings')!.handler({} as never)
    let entry = readonly.ctx.mayflyOverlays.list().find(item => item.id === 'mayfly.settings')!
    expect(await entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'browser-actions', actionId: 'open-file' }, actionContext(entry))).toMatchObject({ kind: 'failed', message: 'Settings are read-only' })

    const bench = await setup()
    bench.commands.entries.get('settings')!.handler({} as never)
    entry = bench.ctx.mayflyOverlays.list().find(item => item.id === 'mayfly.settings')!
    const openFile = () => entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'browser-actions', actionId: 'open-file' }, actionContext(entry))
    expect(await openFile()).toMatchObject({ kind: 'failed', message: 'The terminal is unavailable' })
    bench.ctx.provide('mayflyScreen', { suspend: async (task: () => Promise<unknown>) => task() } as never)
    vi.stubEnv('VISUAL', '')
    vi.stubEnv('EDITOR', '')
    expect(await openFile()).toMatchObject({ kind: 'failed', message: 'no editor configured ($VISUAL/$EDITOR)' })
    vi.spyOn(bench.settings, 'get').mockReturnValue({ editorCommand: 'test-editor' })
    vi.spyOn(bench.settings, 'prepareDocument').mockResolvedValue(undefined)
    expect(await openFile()).toMatchObject({ kind: 'failed', message: 'settings file unavailable' })

    const dir = mkdtempTracked('settings-document-failure-')
    const path = join(dir, 'settings.yaml')
    await writeFile(path, 'original\n')
    vi.spyOn(bench.settings, 'prepareDocument').mockResolvedValue(path)
    setExternalEditorLauncher(async () => { throw new Error('editor failed') })
    expect(await openFile()).toMatchObject({ kind: 'failed', message: 'Settings file could not be edited' })

    const gate = Promise.withResolvers<never>()
    const launch = vi.fn(() => gate.promise)
    setExternalEditorLauncher(launch)
    const abort = new AbortController()
    const pending = entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'browser-actions', actionId: 'open-file' }, actionContext(entry, abort.signal))
    await vi.waitFor(() => expect(launch).toHaveBeenCalled())
    abort.abort()
    gate.reject(new Error('cancelled editor'))
    expect(await pending).toEqual({ kind: 'cancelled' })

    expect(await entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'browser-actions', actionId: 'refresh' }, actionContext(entry))).toEqual({ kind: 'completed' })
    expect(await entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'noop', actionId: 'noop' }, actionContext(entry))).toEqual({ kind: 'completed' })
    expect(await entry.definition.onEvent!.action!({ kind: 'selection-accept', pagePath: [], controlId: 'namespaces', selectedIds: ['missing'] }, actionContext(entry))).toMatchObject({ kind: 'failed' })
    bench.ctx.mayflyOverlays.close(entry.id)
  })

  it('closes namespace and root overlays from caller abort and initial listeners', async () => {
    const bench = await setup()
    const caller = new AbortController()
    expect(await openSettingsNamespace(bench.ctx, 'test-settings', caller.signal)).toBe(true)
    caller.abort()
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])

    const namespaceId = `mayfly.settings.${Buffer.from('test-settings').toString('hex')}`
    bench.ctx.mayflyOverlays.subscribe(delta => { if (delta.kind === 'upsert' && delta.entry.id === namespaceId) bench.ctx.mayflyOverlays.close(namespaceId) })
    expect(await openSettingsNamespace(bench.ctx, 'test-settings')).toBe(true)
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])

    bench.ctx.mayflyOverlays.subscribe(delta => { if (delta.kind === 'upsert' && delta.entry.id === 'mayfly.settings') bench.ctx.mayflyOverlays.close('mayfly.settings') })
    expect(bench.commands.entries.get('settings')!.handler({} as never)).toEqual({ kind: 'success' })
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])
  })

  it('marks restart-only namespaces in the browser', async () => {
    const bench = await setup()
    await bench.ctx.plugin({ name: 'restart-settings', inject: ['settings'], apply(ctx: Context) { ctx.settings.register('restart-settings', Schema.object({ value: Schema.string() }), { applies: 'restart' }) } })
    bench.commands.entries.get('settings')!.handler({} as never)
    expect(JSON.stringify(bench.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.settings')!.node)).toContain('restart to apply')
  })
})
