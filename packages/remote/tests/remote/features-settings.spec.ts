import Schema from '@deepseek-ai/schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsDescribeValue } from '@deepseek-ai/dsh-api-remotes/client'
import type { MayflySettingsDocument } from '@ephemeral-ai/mayfly-host/types'
import { RemoteSettingsController, remoteMayflySettingsPersistence } from '../../src/remote/features/settings.ts'
import { RemoteCallError } from '../../src/remote/features/official.ts'
import { remoteSettingsSecretPath, remoteSettingsWithoutSecrets } from '../../src/remote/features/settings-model.ts'
import { configurationFixture, deferred, namespace, schemaJson } from './configuration-fixture.ts'
const mocks = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../../src/remote/panels/browser.ts', () => ({ openRemoteBrowser: mocks.open }))
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

const document = (overrides: Partial<MayflySettingsDocument> = {}): MayflySettingsDocument => ({ writable: true, revision: 'original', content: 'original content', ...overrides })
function fixture(options: Parameters<typeof configurationFixture>[1] & { readonly withDocuments?: boolean, readonly withEdit?: boolean } = {}) {
  const test = configurationFixture(mocks.open, options)
  const readDocument = vi.fn(async (_client: unknown, _signal?: AbortSignal) => document())
  const writeDocument = vi.fn(async (_client: unknown, content: string, _revision: string, _signal?: AbortSignal) => document({ content, revision: 'saved' }))
  const edit = vi.fn(async (_client: unknown, _content: string, _signal: AbortSignal): Promise<string | undefined> => 'edited')
  const controller = new RemoteSettingsController(test.context, options.withDocuments === false ? undefined : { readDocument, writeDocument }, options.withEdit === false ? undefined : edit)
  cleanups.push(() => { controller.dispose(); test.dispose() })
  const submit = (ns = 'mayfly', fields: readonly unknown[] = [{ id: '["theme"]', change: 'set', value: 'tide' }], source = test.browser().source!()) => test.act({
    kind: 'submit', submission: { source, forms: [{ pagePath: [{ controlId: 'namespaces', itemId: ns }], formId: 'settings-form', draftRevision: 1, fields }] },
  })
  return { ...test, controller, readDocument, writeDocument, edit, submit }
}

describe('Remote exact reference settings rail', () => {
  it('projects the shared rail, forms, source revisions, and external-editor action', async () => {
    const test = fixture({ namespaces: [namespace(), namespace('shell', { schema: schemaJson(Schema.object({ timeoutMs: Schema.number().default(100) })), value: { timeoutMs: 100 } })] })
    await test.controller.open()
    expect(test.browser()).toMatchObject({ id: 'mayfly.settings', scope: { kind: 'app', targetId: 'settings' }, dismissal: 'confirm-dirty' })
    const wire = test.render()
    expect(wire).toContain('"id":"namespaces"')
    expect(wire).toContain('settings-form')
    expect(wire).toContain('Shell timeout (ms)')
    expect(wire).toContain('Open settings.yaml in $EDITOR')
    expect(test.browser().source!()).toEqual([
      { resourceId: 'settings/mayfly', revision: 7 }, { resourceId: 'settings/mayfly/fields', revision: expect.any(String) },
      { resourceId: 'settings/shell', revision: 7 }, { resourceId: 'settings/shell/fields', revision: expect.any(String) },
    ])
    await test.submit()
    expect(test.browser().source!()).toContainEqual({ resourceId: 'settings/shell', revision: 7 })
    test.locale.setPreference('zh')
    expect(test.render()).toContain('设置')
    expect(test.render()).toContain('Shell 超时（毫秒）')
  })

  it('focuses and switches an existing rail, filters opaque namespaces, and has an exact empty state', async () => {
    const test = fixture({ namespaces: [namespace(), namespace('opaque', { schema: schemaJson(Schema.any()), value: { private: 'hidden' } })] })
    await test.controller.open()
    await test.controller.openNamespace(test.client, 'mayfly')
    expect(test.opened).toHaveLength(1)
    expect(test.ctx.mayflyOverlays.focus).toHaveBeenCalledWith('mayfly.settings')
    expect(test.emitTab).toHaveBeenCalledWith({ kind: 'tab-change', pagePath: [], controlId: 'namespaces', tabId: 'mayfly' })
    expect(test.render()).not.toContain('private')
    expect(test.render()).not.toContain('opaque')
    const empty = fixture({ namespaces: [] })
    await empty.controller.open()
    expect(empty.render()).toContain('No settings namespaces')
    const unknown = fixture()
    await unknown.controller.openNamespace(unknown.client, 'absent')
    expect(unknown.opened).toHaveLength(0)
  })

  it('saves typed path changes once, acknowledges fresh source revisions, and keeps the rail open', async () => {
    const test = fixture()
    await test.controller.open()
    const reply = await test.submit()
    expect(test.mutate).toHaveBeenCalledExactlyOnceWith('mayfly', [{ op: 'set', path: ['theme'], value: 'tide' }], 7)
    expect(reply).toMatchObject({ kind: 'accepted', feedback: { severity: 'success', message: 'Settings saved' }, source: [{ resourceId: 'settings/mayfly', revision: 8 }, { resourceId: 'settings/mayfly/fields', revision: expect.any(String) }] })
    expect(test.opened[0]!.close).not.toHaveBeenCalled()
  })

  it('handles unchanged/reset submissions and refuses missing or unavailable forms', async () => {
    const test = fixture()
    await test.controller.open()
    expect(await test.submit('mayfly', [{ id: '["theme"]', change: 'unchanged', value: 'dark' }])).toMatchObject({ kind: 'accepted' })
    expect(test.mutate).not.toHaveBeenCalled()
    expect(await test.submit('mayfly', [{ id: '["theme"]', change: 'reset' }])).toMatchObject({ kind: 'accepted' })
    expect(test.mutate).toHaveBeenCalledWith('mayfly', [{ op: 'unset', path: ['theme'] }], 7)
    expect(await test.act({ kind: 'submit', submission: { source: [], forms: [] } })).toMatchObject({ kind: 'failed' })
    expect(await test.submit('absent')).toMatchObject({ kind: 'cancelled', dismiss: true })
    expect(await test.act({ kind: 'activate', actionId: 'other' })).toEqual({ kind: 'completed' })
  })

  it('refuses descriptor, schema/base, and dynamic-choice drift without refresh-and-retry writes', async () => {
    for (const drift of ['descriptor', 'fields', 'choices']) {
      const ns = drift === 'choices' ? 'permission' : 'mayfly'
      const initial = namespace(ns, drift === 'choices' ? { schema: schemaJson(Schema.object({ defaultPreset: Schema.string() })), value: { defaultPreset: 'safe' } } : {})
      const test = fixture({ namespaces: [initial] })
      await test.controller.open()
      const source = test.browser().source!()
      if (drift === 'choices') test.catalog.mockResolvedValueOnce({ ok: true, value: { options: [{ value: 'new' }] } })
      else test.setSettings({ writable: true, hasDocument: true, namespaces: [drift === 'descriptor' ? { ...initial, revision: 8 } : { ...initial, base: { theme: 'light' } }] })
      expect(await test.submit(ns, [], source)).toMatchObject({ kind: 'conflict', message: 'Settings changed elsewhere; review before saving' })
      expect(test.mutate).not.toHaveBeenCalled()
    }
  })

  it('returns native concurrent-write conflicts with latest sources, and redacts unknown failures', async () => {
    const test = fixture()
    await test.controller.open()
    test.mutate.mockResolvedValueOnce({ ok: false, error: { code: 'settings/conflict', message: 'revision changed' } })
    expect(await test.submit()).toMatchObject({ kind: 'conflict' })
    expect(test.mutate).toHaveBeenCalledOnce()
    test.mutate.mockRejectedValueOnce(new Error('secret-value-from-host'))
    const reply = await test.submit()
    expect(reply).toMatchObject({ kind: 'failed', message: 'Settings could not be saved' })
    expect(JSON.stringify(reply)).not.toContain('secret-value-from-host')
  })

  it('never exposes saved secrets or defaults, accepts only explicit fresh secret changes', async () => {
    const test = fixture({ namespaces: [namespace('credentials', { schema: schemaJson(Schema.object({ apiKey: Schema.string().role('secret').default('secret-default'), opaque: Schema.any() })), value: { apiKey: 'saved-secret', opaque: { private: 'opaque-secret' } }, secrets: [{ path: ['apiKey'], set: true }] })] })
    await test.controller.open()
    expect(test.render()).not.toMatch(/secret-default|saved-secret|opaque-secret/)
    expect(test.render()).toContain('Configured; leave unchanged')
    expect(await test.submit('credentials', [{ id: '["apiKey"]', change: 'set', value: 'new-explicit-secret' }])).toMatchObject({ kind: 'accepted' })
    expect(test.mutate).toHaveBeenCalledWith('credentials', [{ op: 'set', path: ['apiKey'], value: 'new-explicit-secret' }], 7)
    expect(test.render()).not.toContain('new-explicit-secret')
  })

  it('orders background reads and preserves rail selection through updates', async () => {
    const test = fixture({ namespaces: [namespace(), namespace('shell')] })
    await test.controller.open()
    test.observe({ kind: 'tab-change', pagePath: [], controlId: 'namespaces', tabId: 'shell' })
    const first = deferred<unknown>()
    test.describe.mockReturnValueOnce(first.promise)
    test.emit('settings/document-updated', 'mayfly', 8)
    test.describe.mockResolvedValueOnce({ ok: true, value: { writable: true, hasDocument: true, namespaces: [namespace('shell', { revision: 9 })] } satisfies SettingsDescribeValue })
    test.emit('settings/document-updated', 'shell', 9)
    await vi.waitFor(() => { expect(test.browser().source!()[0]?.revision).toBe(9) })
    first.resolve({ ok: true, value: { writable: true, hasDocument: true, namespaces: [namespace()] } })
    await Promise.resolve(); await Promise.resolve()
    expect(test.browser().source!()[0]?.revision).toBe(9)
    expect(test.render()).toContain('"activeId":"shell"')
  })

  it('drops delayed opens and submits on detach, reconnect, disposal, or action abort', async () => {
    const test = fixture()
    const first = deferred<unknown>()
    test.describe.mockReturnValueOnce(first.promise)
    const opening = test.controller.open()
    test.reconnect()
    first.resolve({ ok: true, value: { writable: true, hasDocument: true, namespaces: [namespace()] } })
    await opening
    expect(test.opened).toHaveLength(0)
    await test.controller.open()
    const read = deferred<unknown>()
    test.describe.mockReturnValueOnce(read.promise)
    const saving = test.submit()
    test.detach()
    read.resolve({ ok: true, value: { writable: true, hasDocument: true, namespaces: [namespace()] } })
    expect(await saving).toMatchObject({ kind: 'cancelled' })
    expect(test.mutate).not.toHaveBeenCalled()
    expect([...test.events.values()].every(listeners => listeners.size === 0)).toBe(true)
    await test.controller.open()
    expect(test.opened).toHaveLength(1)
  })

  it('handles failed reads, missing Hosts, read-only fields, and absent document integration', async () => {
    const failed = fixture()
    failed.describe.mockRejectedValueOnce(new Error('offline'))
    await failed.controller.open()
    expect(failed.notice.set).toHaveBeenCalledWith('offline')
    failed.detach()
    await failed.controller.open()
    expect(failed.opened).toHaveLength(0)
    const readOnly = fixture({ withDocuments: false })
    readOnly.setSettings({ writable: false, hasDocument: false, namespaces: [namespace()] })
    await readOnly.controller.open()
    expect(readOnly.render()).toContain('"disabled":true')
    expect(await readOnly.submit()).toMatchObject({ kind: 'failed' })
    expect(readOnly.mutate).not.toHaveBeenCalled()
    expect(await readOnly.act({ kind: 'activate', actionId: 'open-file' })).toMatchObject({ kind: 'failed' })
  })
})

describe('Remote raw settings editor', () => {
  it('edits directly with the original document revision and refreshes the open rail', async () => {
    const test = fixture()
    await test.controller.open()
    expect(await test.act({ kind: 'activate', actionId: 'open-file' })).toMatchObject({ kind: 'completed', feedback: { message: 'Settings file saved' } })
    expect(test.edit).toHaveBeenCalledWith(test.client, 'original content', expect.any(AbortSignal))
    expect(test.writeDocument).toHaveBeenCalledWith(test.client, 'edited', 'original', expect.any(AbortSignal))
    expect(test.opened[0]!.refresh).toHaveBeenCalled()
    await test.controller.openDocument(test.client)
    expect(test.notice.set).toHaveBeenCalledWith('Settings file saved')
  })

  it('never writes after cancellation, unchanged text, read-only status, or detach during editing', async () => {
    const test = fixture()
    test.edit.mockResolvedValueOnce(undefined)
    await test.controller.openDocument(test.client)
    test.edit.mockResolvedValueOnce('original content')
    await test.controller.openDocument(test.client)
    test.readDocument.mockResolvedValueOnce(document({ writable: false }))
    await test.controller.openDocument(test.client)
    expect(test.notice.set).toHaveBeenCalledWith('Settings are read-only')
    const pending = deferred<string | undefined>()
    test.edit.mockReturnValueOnce(pending.promise)
    const editing = test.controller.openDocument(test.client)
    await vi.waitFor(() => { expect(test.edit).toHaveBeenCalledTimes(3) })
    test.detach()
    pending.resolve('late content')
    await editing
    expect(test.writeDocument).not.toHaveBeenCalled()
  })

  it('propagates action cancellation into the editor and rejects an original-revision conflict', async () => {
    const test = fixture()
    await test.controller.open()
    const signal = new AbortController()
    const pending = deferred<string | undefined>()
    test.edit.mockReturnValueOnce(pending.promise)
    const editing = test.act({ kind: 'activate', actionId: 'open-file' }, signal.signal)
    await vi.waitFor(() => { expect(test.edit).toHaveBeenCalledOnce() })
    signal.abort()
    expect(test.edit.mock.calls[0]![2].aborted).toBe(true)
    pending.resolve('late')
    expect(await editing).toEqual({ kind: 'cancelled' })
    expect(test.writeDocument).not.toHaveBeenCalled()
    test.writeDocument.mockRejectedValueOnce(new RemoteCallError('mayflyHost/settings-conflict', 'moved'))
    expect(await test.act({ kind: 'activate', actionId: 'open-file' })).toEqual({ kind: 'failed', message: 'The settings file changed while the editor was open' })
    expect(test.writeDocument).toHaveBeenCalledOnce()
  })

  it('reports missing integration and safe read failures without opening a preview', async () => {
    const missing = fixture({ withEdit: false })
    await missing.controller.openDocument(missing.client)
    expect(missing.notice.set).toHaveBeenCalledWith('no editor configured ($VISUAL/$EDITOR)')
    const noDocument = fixture({ withDocuments: false })
    await noDocument.controller.openDocument(noDocument.client)
    expect(noDocument.notice.set).toHaveBeenCalledWith('settings file unavailable')
    const failed = fixture()
    failed.readDocument.mockRejectedValueOnce(new Error('private settings text'))
    await failed.controller.openDocument(failed.client)
    expect(failed.notice.set).toHaveBeenCalledWith('Settings file could not be edited')
    expect(failed.opened).toHaveLength(0)
  })
})

describe('programmatic native settings writes', () => {
  it('returns only current describe results and ignores a late read after reconnect', async () => {
    const test = fixture()
    expect(await test.controller.describe(test.client)).toMatchObject({ writable: true, namespaces: [{ ns: 'mayfly' }] })
    const pending = deferred<unknown>()
    test.describe.mockReturnValueOnce(pending.promise)
    const reading = test.controller.describe(test.client)
    test.reconnect()
    pending.resolve({ ok: true, value: { writable: true, hasDocument: true, namespaces: [namespace()] } })
    await expect(reading).resolves.toBeUndefined()
  })

  it.each(['update', 'replace', 'mutate'] as const)('fences %s before admission, after revision read, and after native write', async method => {
    const invoke = (test: ReturnType<typeof fixture>) => method === 'mutate'
      ? test.controller.mutate(test.client, 'mayfly', [], test.controller.revision(namespace(), true))
      : test.controller[method](test.client, 'mayfly', { theme: 'tide' }, test.controller.revision(namespace(), true))
    const detached = fixture()
    detached.detach()
    await expect(invoke(detached)).rejects.toThrow('Host is no longer attached')
    expect(detached.describe).not.toHaveBeenCalled()

    const reading = fixture()
    const read = deferred<unknown>()
    reading.describe.mockReturnValueOnce(read.promise)
    const waitingForRevision = invoke(reading)
    reading.reconnect()
    read.resolve({ ok: true, value: { writable: true, hasDocument: true, namespaces: [namespace()] } })
    await expect(waitingForRevision).rejects.toThrow('Host is no longer attached')
    expect(reading[method]).not.toHaveBeenCalled()

    const writing = fixture()
    const write = deferred<unknown>()
    writing[method].mockReturnValueOnce(write.promise)
    const saving = invoke(writing)
    await vi.waitFor(() => { expect(writing[method]).toHaveBeenCalledOnce() })
    writing.reconnect()
    write.resolve({ ok: true, value: namespace('mayfly', { revision: 8 }) })
    await expect(saving).rejects.toThrow('Host is no longer attached')
    expect(writing[method]).toHaveBeenCalledOnce()
  })

  it('rejects the absent Host-owned Mayfly schema and permits unset of a secret path', async () => {
    const test = fixture({ namespaces: [] })
    await expect(test.controller.update(test.client, 'mayfly', {}, { descriptor: 0, fields: '' })).rejects.toThrow('mayfly-host must register')
    const credentials = namespace('credentials', { secrets: [{ path: ['apiKey'], set: true }] })
    test.setSettings({ writable: true, hasDocument: true, namespaces: [credentials] })
    await test.controller.mutate(test.client, 'credentials', [{ op: 'unset', path: ['apiKey'] }], test.controller.revision(credentials, true))
    expect(test.mutate).toHaveBeenCalledWith('credentials', [{ op: 'unset', path: ['apiKey'] }], 7)
  })

  it('checks native descriptor/schema revisions and fences late reads before every write', async () => {
    const test = fixture()
    const revision = test.controller.revision(namespace(), true)
    await test.controller.update(test.client, 'mayfly', { theme: 'light' }, revision)
    await test.controller.replace(test.client, 'mayfly', { theme: 'light' }, revision)
    await test.controller.mutate(test.client, 'mayfly', [{ op: 'set', path: ['theme'], value: 'light' }], revision)
    expect(test.update).toHaveBeenCalledWith('mayfly', { theme: 'light' }, 7)
    expect(test.replace).toHaveBeenCalledWith('mayfly', { theme: 'light' }, 7)
    expect(test.mutate).toHaveBeenCalledOnce()
    await expect(test.controller.mutate(test.client, 'mayfly', [], { ...revision, fields: 'stale' })).rejects.toThrow('changed elsewhere')
    await expect(test.controller.mutate(test.client, 'absent', [], revision)).rejects.toThrow('unavailable')
    const pending = deferred<unknown>()
    test.describe.mockReturnValueOnce(pending.promise)
    const write = test.controller.update(test.client, 'mayfly', { theme: 'light' }, revision)
    test.detach()
    pending.resolve({ ok: true, value: { writable: true, hasDocument: true, namespaces: [namespace()] } })
    await expect(write).rejects.toThrow('no longer attached')
    expect(test.update).toHaveBeenCalledOnce()
    await expect(test.controller.describe(test.client)).resolves.toBeUndefined()
  })

  it('strips schema secrets through supported containers and refuses programmatic secret writes', async () => {
    const schema = schemaJson(Schema.object({ apiKey: Schema.string().role('secret'), visible: Schema.string(), items: Schema.array(Schema.object({ secret: Schema.string().role('secret'), label: Schema.string() })), dict: Schema.dict(Schema.string().role('secret')) }))
    const descriptor = namespace('credentials', { schema, secrets: [{ path: ['apiKey'], set: true }] })
    const test = fixture({ namespaces: [descriptor] })
    const revision = test.controller.revision(descriptor, true)
    await expect(test.controller.mutate(test.client, 'credentials', [{ op: 'set', path: ['apiKey'], value: 'secret' }], revision)).rejects.toThrow('credential controls')
    expect(remoteSettingsSecretPath(descriptor, ['apiKey'])).toBe(true)
    expect(remoteSettingsSecretPath(descriptor, ['visible'])).toBe(false)
    expect(remoteSettingsWithoutSecrets(schema, { apiKey: 'private', visible: 'yes', items: [{ secret: 'private', label: 'ok' }], dict: { a: 'private' } })).toEqual({ visible: 'yes', items: [{ label: 'ok' }], dict: {} })
  })

  it('reports Host schema availability from real namespaces only', () => {
    expect(remoteMayflySettingsPersistence({ writable: true, hasDocument: true, namespaces: [namespace()] })).toBe('available')
    expect(remoteMayflySettingsPersistence({ writable: true, hasDocument: true, namespaces: [] })).toBe('host-schema-required')
  })

  it('strips secrets through unions, intersections, transforms, and dictionary objects', () => {
    const secret = { type: 'string', meta: { role: 'secret' } }
    const schema = { type: 'object', dict: {
      union: { type: 'union', list: [{ type: 'object', dict: { secret, visible: { type: 'string' } } }, { type: 'any' }] },
      intersection: { type: 'intersect', list: [{ type: 'any' }, { type: 'object', dict: { secret } }] },
      transformed: { type: 'transform', inner: secret },
      dict: { type: 'dict', inner: { type: 'object', dict: { secret } } },
      unknownUnion: { type: 'union' },
      unknownObject: { type: 'object' },
    } }
    expect(remoteSettingsWithoutSecrets(schema, {
      union: { secret: 'hidden', visible: 'kept' }, intersection: { secret: 'hidden', retained: 1 }, transformed: 'hidden',
      dict: { first: { secret: 'hidden', visible: true } }, unknownUnion: 'forward compatible', unknownObject: { retained: 2 }, extra: null,
    })).toEqual({ union: { visible: 'kept' }, intersection: { retained: 1 }, dict: { first: { visible: true } }, unknownUnion: 'forward compatible', unknownObject: { retained: 2 }, extra: null })
    expect(remoteSettingsWithoutSecrets({ type: 'array', inner: secret }, { first: 'hidden' })).toEqual({})
    expect(remoteSettingsWithoutSecrets({ type: 'object' }, ['left untouched'])).toEqual(['left untouched'])
    expect(remoteSettingsWithoutSecrets({ type: 'array', inner: secret }, null)).toBeNull()
  })
})

describe('settings rail read and write retirement', () => {
  it('acquires no subscriptions after the browser closes during mounting', async () => {
    const test = fixture()
    mocks.open.mockImplementationOnce((_context, options) => {
      options.onClosed?.()
      return { closed: true, close: vi.fn(), refresh: vi.fn() }
    })
    await test.controller.open()
    expect(test.client.remote.$on).not.toHaveBeenCalled()
    await test.controller.open()
    expect(test.opened).toHaveLength(1)
    expect(test.browser().isCurrent()).toBe(true)
    test.detach()
    expect(test.browser().isCurrent()).toBe(false)
    await test.controller.openNamespace(test.client, 'mayfly')
    expect(test.opened).toHaveLength(1)
  })

  it('keeps usable dynamic choices when one native catalog fails and filters broken presets', async () => {
    const test = fixture()
    test.presets.mockResolvedValueOnce({ ok: true, value: { presets: [{ id: 'ready' }, { id: 'broken', broken: 'missing provider' }] } })
    await test.controller.open()
    test.catalog.mockRejectedValueOnce(new Error('permission catalog unavailable'))
    test.presets.mockRejectedValueOnce(new Error('agent catalog unavailable'))
    await test.act({ kind: 'activate', actionId: 'refresh' })
    expect(test.render()).toContain('Settings')
    expect(test.notice.set).not.toHaveBeenCalled()
  })

  it('refreshes explicitly, tolerates removed namespaces, and contains background read failures', async () => {
    const test = fixture()
    await test.controller.open()
    test.observe({ kind: 'focus-change', pagePath: [], controlId: 'namespaces' })
    test.observe({ kind: 'tab-change', pagePath: [{ controlId: 'nested', itemId: 'tab' }], controlId: 'namespaces', tabId: 'ignored' })
    test.observe({ kind: 'tab-change', pagePath: [], controlId: 'other', tabId: 'ignored' })
    expect(await test.act({ kind: 'activate', actionId: 'refresh' })).toEqual({ kind: 'completed' })
    test.setSettings({ writable: true, hasDocument: true, namespaces: [] })
    test.emit('permission-presets/catalog-changed')
    await vi.waitFor(() => { expect(test.render()).toContain('No settings namespaces') })
    test.describe.mockRejectedValueOnce(new Error('background offline'))
    test.emit('settings/document-updated', 'mayfly', 9)
    await vi.waitFor(() => { expect(test.notice.set).toHaveBeenCalledWith('background offline') })
    test.opened[0]!.close()
    await test.controller.open()
    expect(test.opened).toHaveLength(2)
    await test.controller.open()
    expect(test.opened).toHaveLength(2)
    test.detach()
    await test.controller.openDocument(test.client)
  })

  it('rejects missing namespace identity and already-aborted actions before native work', async () => {
    const test = fixture()
    await test.controller.open()
    expect(await test.act({ kind: 'submit', submission: { source: [], forms: [{ formId: 'settings-form', pagePath: [], fields: [] }] } })).toMatchObject({ kind: 'failed' })
    const abort = new AbortController()
    abort.abort()
    expect(await test.act({ kind: 'activate', actionId: 'refresh' }, abort.signal)).toEqual({ kind: 'cancelled' })
  })

  it.each(['resolve', 'reject'] as const)('retires a native settings mutation that settles with %s after caller cancellation', async settlement => {
    const test = fixture()
    await test.controller.open()
    const pending = Promise.withResolvers<unknown>()
    test.mutate.mockReturnValueOnce(pending.promise)
    const abort = new AbortController()
    const saving = test.act({ kind: 'submit', submission: { source: test.browser().source!(), forms: [{ formId: 'settings-form', pagePath: [{ controlId: 'namespaces', itemId: 'mayfly' }], fields: [{ id: '["theme"]', change: 'set', value: 'tide' }] }] } }, abort.signal)
    await vi.waitFor(() => { expect(test.mutate).toHaveBeenCalledOnce() })
    abort.abort()
    if (settlement === 'resolve') pending.resolve({ ok: true, value: namespace('mayfly', { revision: 8 }) })
    else pending.reject(new Error('late private error'))
    expect(await saving).toEqual({ kind: 'cancelled' })
    expect(test.browser().source!()[0]?.revision).toBe(7)
    expect(test.notice.set).not.toHaveBeenCalled()
  })

  it('preserves a native conflict when its follow-up refresh fails or is retired', async () => {
    const test = fixture()
    await test.controller.open()
    test.mutate.mockResolvedValueOnce({ ok: false, error: { code: 'settings/conflict', message: 'changed' } })
    test.describe.mockResolvedValueOnce({ ok: true, value: { writable: true, hasDocument: true, namespaces: [namespace()] } }).mockRejectedValueOnce(new Error('refresh offline'))
    expect(await test.submit()).toMatchObject({ kind: 'conflict' })

    const read = Promise.withResolvers<unknown>()
    test.mutate.mockResolvedValueOnce({ ok: false, error: { code: 'settings/conflict', message: 'changed' } })
    test.describe.mockResolvedValueOnce({ ok: true, value: { writable: true, hasDocument: true, namespaces: [namespace()] } }).mockReturnValueOnce(read.promise)
    const saving = test.submit()
    await vi.waitFor(() => { expect(test.describe).toHaveBeenCalledTimes(5) })
    test.detach()
    read.resolve({ ok: true, value: { writable: true, hasDocument: true, namespaces: [namespace()] } })
    expect(await saving).toEqual({ kind: 'cancelled' })
  })

  it('drops stale background failures and competing delayed opens', async () => {
    const test = fixture()
    const delayed = Promise.withResolvers<unknown>()
    test.describe.mockReturnValueOnce(delayed.promise)
    const opening = test.controller.open()
    await test.controller.open()
    delayed.resolve({ ok: true, value: { writable: true, hasDocument: true, namespaces: [namespace()] } })
    await opening
    expect(test.opened).toHaveLength(1)
    const refresh = Promise.withResolvers<unknown>()
    test.describe.mockReturnValueOnce(refresh.promise)
    test.emit('permission-presets/catalog-changed')
    test.detach()
    refresh.reject(new Error('obsolete background error'))
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(test.notice.set).not.toHaveBeenCalled()

    const failed = fixture()
    const failure = Promise.withResolvers<unknown>()
    failed.describe.mockReturnValueOnce(failure.promise)
    const lateOpen = failed.controller.open()
    failed.detach()
    failure.reject(new Error('obsolete opening error'))
    await lateOpen
    expect(failed.notice.set).not.toHaveBeenCalled()
  })

  it('does not edit or acknowledge a retired document read or write', async () => {
    const reading = fixture()
    const read = Promise.withResolvers<MayflySettingsDocument>()
    reading.readDocument.mockReturnValueOnce(read.promise)
    const opening = reading.controller.openDocument(reading.client)
    reading.reconnect()
    read.resolve(document())
    await opening
    expect(reading.edit).not.toHaveBeenCalled()
    expect(reading.notice.set).not.toHaveBeenCalled()

    const writing = fixture()
    const write = Promise.withResolvers<MayflySettingsDocument>()
    writing.writeDocument.mockReturnValueOnce(write.promise)
    const saving = writing.controller.openDocument(writing.client)
    await vi.waitFor(() => { expect(writing.writeDocument).toHaveBeenCalledOnce() })
    writing.detach()
    write.resolve(document({ revision: 'saved' }))
    await saving
    expect(writing.notice.set).not.toHaveBeenCalled()

    const failing = fixture()
    const failure = Promise.withResolvers<MayflySettingsDocument>()
    failing.readDocument.mockReturnValueOnce(failure.promise)
    const load = failing.controller.openDocument(failing.client)
    failing.detach()
    failure.reject(new Error('obsolete private error'))
    await load
    expect(failing.notice.set).not.toHaveBeenCalled()
  })
})
