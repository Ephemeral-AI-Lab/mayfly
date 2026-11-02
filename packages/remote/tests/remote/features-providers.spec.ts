import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteAuthorizationInteraction } from '../../src/remote/features/providers.ts'
import { RemoteProvidersController } from '../../src/remote/features/providers.ts'
import { configurationFixture, deferred, namespace } from './configuration-fixture.ts'
const mocks = vi.hoisted(() => ({ open: vi.fn(), metadata: vi.fn(async (_ctx: unknown, _signal: AbortSignal): Promise<unknown> => undefined) }))
vi.mock('../../src/remote/panels/browser.ts', () => ({ openRemoteBrowser: mocks.open }))
vi.mock('@ephemeral-ai/mayfly/configuration-panels', async original => ({ ...await original<Record<string, unknown>>(), loadModelsDevIndex: mocks.metadata }))
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); mocks.metadata.mockReset(); mocks.metadata.mockResolvedValue(undefined) })

function fixture(options: { readonly custom?: boolean, readonly writable?: boolean, readonly external?: boolean, readonly missingAuthorization?: boolean } = {}) {
  const profile = { displayName: 'DeepSeek', api: 'openai-completions', baseURL: 'https://api.example/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'chat', contextWindow: 128000, customFlag: 'preserve' }], reasoning: 'low' }
  let settings: SettingsDescribeValue = { writable: options.writable ?? true, hasDocument: true, namespaces: [namespace('llm-pi-ai', { revision: 7, value: { providers: { deepseek: profile } } })] }
  const test = configurationFixture(mocks.open, { namespaces: settings.namespaces })
  test.describe.mockImplementation(async () => ({ ok: true, value: settings }))
  const configs = [{ provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'deepseek'], declared: options.custom ?? true },
    { provider: 'known', displayName: 'Known', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'known'] },
    { provider: 'oauth', displayName: 'OAuth', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'oauth'], nativeAuth: { oauth: true } }]
  const listProviders = vi.fn(async (): Promise<unknown> => ({ ok: true, value: [{ id: 'deepseek', name: 'DeepSeek' }] }))
  const configurable = vi.fn(async (): Promise<unknown> => ({ ok: true, value: configs }))
  const discover = vi.fn(async (_ns: unknown, _request: unknown, _signal?: AbortSignal): Promise<unknown> => ({ ok: true, value: [{ id: 'advertised', contextWindow: 200000 }] }))
  let configured = true
  const credentialDescribe = vi.fn(async (refs: readonly string[]): Promise<unknown> => ({ ok: true, value: Object.fromEntries(refs.map(ref => [ref, { configured, writable: options.external !== true, source: options.external ? 'environment' : 'store' }])) }))
  const set = vi.fn(async (_ref: unknown, _key: unknown): Promise<unknown> => { configured = true; return { ok: true, value: undefined } })
  const unset = vi.fn(async (_ref: unknown): Promise<unknown> => { configured = false; return { ok: true, value: undefined } })
  Object.assign(test.client.remote, { llm: { listProviders, listConfigurableProviders: configurable, discoverModels: discover }, credentials: { describe: credentialDescribe, set, unset } })
  test.mutate.mockImplementation(async (ns: string, operations: readonly unknown[] = [], expected = 7): Promise<unknown> => {
    const current = settings.namespaces.find(candidate => candidate.ns === ns)!
    if (current.revision !== expected) return { ok: false, error: { code: 'settings/conflict', message: 'revision moved' } }
    const value = structuredClone(current.value) as Record<string, unknown>
    for (const op of operations as SettingsPathOpView[]) {
      let cursor = value
      for (const part of op.path.slice(0, -1)) { cursor[part] ??= {}; cursor = cursor[part] as Record<string, unknown> }
      if (op.op === 'set') cursor[op.path.at(-1)!] = op.value
      else delete cursor[op.path.at(-1)!]
    }
    const saved = { ...current, value: value as SettingsNamespaceView['value'], revision: current.revision + 1 }
    settings = { ...settings, namespaces: settings.namespaces.map(candidate => candidate.ns === ns ? saved : candidate) }
    return { ok: true, value: saved }
  })
  const authorize = vi.fn(async (_client: unknown, _key: unknown, _method: unknown, _interaction: RemoteAuthorizationInteraction, _signal?: AbortSignal): Promise<'authorized' | 'cancelled'> => 'authorized')
  const account = vi.fn(async () => {})
  const copy = vi.fn(async (_text: string) => {})
  const created = vi.fn(async (_route: string) => {})
  const controller = new RemoteProvidersController(test.context, account, options.missingAuthorization ? undefined : { authorize }, undefined, { copy }, created)
  cleanups.push(() => { controller.dispose(); test.dispose() })
  const form = (page: string, fields: readonly unknown[]) => ({ pagePath: [{ controlId: 'provider-pages', itemId: page }], formId: 'provider', draftRevision: 1, fields })
  const submit = (forms: readonly unknown[], selections: readonly unknown[] = [], index = test.opened.length - 1) => test.act({ kind: 'submit', submission: { source: test.browser(index).source?.() ?? [], forms, selections } }, undefined, index)
  const endpointSubmission = (connection: Readonly<Record<string, unknown>> = {}, models: readonly string[] = ['manual'], extra: Readonly<Record<string, unknown>> = {}) => ({
    source: test.browser().source?.() ?? [], forms: [
      { pagePath: [{ controlId: 'provider-tabs', itemId: 'connection' }], formId: 'connection', draftRevision: 1, fields: Object.entries({ route: 'custom', protocol: 'openai-completions', baseURL: 'https://endpoint.example', key: 'fresh-key', ...connection }).map(([id, value]) => ({ id, value, change: 'set' })) },
      { pagePath: [{ controlId: 'provider-tabs', itemId: 'models' }], formId: 'models', draftRevision: 1, fields: [{ id: 'context', value: 64000, change: 'set' }, { id: 'efforts', value: ['low', 'high'], change: 'set' }] },
    ], selections: [{ pagePath: [{ controlId: 'provider-tabs', itemId: 'models' }], controlId: 'advertised-models', selectedIds: models }], ...extra,
  })
  const openCustom = async () => { await controller.openAdd(test.client); await test.act({ kind: 'selection-accept', controlId: 'provider-source', selectedIds: ['custom'] }) }
  return { ...test, controller, profile, listProviders, configurable, discover, credentialDescribe, setCredential: set, unsetCredential: unset, authorize, account, copy, created, form, submit, endpointSubmission, openCustom,
    settings: () => settings,
    changeSettings: (value: SettingsDescribeValue) => { settings = value },
  }
}

describe('reference provider roster and editors', () => {
  it('opens the exact configured-provider roster and routes its native selections', async () => {
    const test = fixture()
    await test.controller.open()
    expect(test.browser()).toMatchObject({ id: 'mayfly.providers', scope: { kind: 'app', targetId: 'provider-configuration' } })
    expect(test.render()).toContain('"id":"providers"')
    expect(test.render()).toContain('1 models · key configured')
    expect(test.render()).not.toContain('dormant')
    expect(await test.act({ kind: 'selection-accept', controlId: 'providers', selectedIds: ['deepseek'] })).toEqual({ kind: 'completed' })
    expect(test.browser().id).toBe(`mayfly.provider.${Buffer.from('deepseek').toString('hex')}`)
    expect(test.render()).toContain('"id":"provider-pages"')
    expect(test.render()).toContain('"activeId":"models"')
    expect(test.render()).toContain('Connection')
    expect(test.render()).toContain('Credentials')
    expect(test.render()).toContain('Clear the stored API key?')
    expect(test.render()).not.toContain('fresh-key')
  })

  it('preserves the reference distinction between known and custom connection forms', async () => {
    const known = fixture({ custom: false })
    await known.controller.openEditor(known.client, 'deepseek')
    expect(known.render()).not.toContain('"id":"baseURL"')
    const custom = fixture({ custom: true })
    await custom.controller.openEditor(custom.client, 'deepseek')
    expect(custom.render()).toContain('"id":"baseURL"')
    expect(custom.render()).toContain('"confirmLabel":"Delete provider"')
    custom.ctx.mayflyOverlays.focus.mockReturnValueOnce(true)
    expect(await custom.controller.openEditor(custom.client, 'deepseek')).toBe(true)
    expect(custom.opened).toHaveLength(1)
  })

  it('refreshes native settings writability before accepting a draft or deleting a provider', async () => {
    const test = fixture()
    await test.controller.openEditor(test.client, 'deepseek')
    test.changeSettings({ ...test.settings(), writable: false })
    expect(await test.submit([test.form('connection', [{ id: 'name', value: 'Renamed', change: 'set' }])])).toMatchObject({ kind: 'failed', message: 'Settings are read-only' })
    expect(test.render()).toContain('Settings are read-only')
    expect(await test.act({ kind: 'activate', actionId: 'delete' })).toMatchObject({ kind: 'failed', message: 'Settings are read-only' })
    expect(test.mutate).not.toHaveBeenCalled()
  })

  it('uses native provider route/name matching for the shared filtered model picker', async () => {
    const test = fixture()
    await test.controller.openModels(test.client, 'DEEPSEEK')
    await test.controller.openModels(test.client, 'OAuth')
    expect(test.created.mock.calls).toEqual([['deepseek'], ['oauth']])
    await test.controller.openModels(test.client, 'missing')
    expect(test.notice.set).toHaveBeenCalledWith('Unknown provider')
    const late = deferred<unknown>()
    test.listProviders.mockReturnValueOnce(late.promise)
    const pending = test.controller.openModels(test.client, 'deepseek')
    test.reconnect()
    late.resolve({ ok: true, value: [{ id: 'deepseek', name: 'DeepSeek' }] })
    await pending
    expect(test.created).toHaveBeenCalledTimes(2)
  })

  it('fences native destructive continuations and preserves external credentials', async () => {
    const external = fixture({ external: true })
    await external.controller.remove(external.client, 'deepseek')
    expect(external.mutate).toHaveBeenCalledOnce()
    expect(external.unsetCredential).not.toHaveBeenCalled()
    await expect(external.controller.unsetCredential(external.client, 'DEEPSEEK_API_KEY')).rejects.toThrow('The credential source is read-only')
    const late = fixture()
    const pendingDescribe = deferred<unknown>()
    late.describe.mockReturnValueOnce(pendingDescribe.promise)
    const pending = late.controller.remove(late.client, 'deepseek')
    late.detach()
    pendingDescribe.resolve({ ok: true, value: late.settings() })
    await pending
    expect(late.mutate).not.toHaveBeenCalled()
    expect(late.unsetCredential).not.toHaveBeenCalled()
  })

  it('writes only changed native paths and merges selected model metadata while keeping the editor open', async () => {
    const test = fixture()
    await test.controller.openEditor(test.client, 'deepseek')
    await vi.waitFor(() => { expect(test.render()).toContain('advertised') })
    const reply = await test.submit([test.form('connection', [{ id: 'name', value: 'Renamed', change: 'set' }]), test.form('models', [{ id: 'reasoning', value: 'default', change: 'set' }])], [{ pagePath: [{ controlId: 'provider-pages', itemId: 'models' }], controlId: 'advertised-models', selectedIds: ['chat', 'advertised'] }])
    expect(reply).toMatchObject({ kind: 'accepted', feedback: { message: 'provider "deepseek" updated' } })
    expect(test.mutate).toHaveBeenCalledOnce()
    expect(test.mutate).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'deepseek', 'displayName'], value: 'Renamed' },
      { op: 'unset', path: ['providers', 'deepseek', 'reasoning'] },
      { op: 'set', path: ['providers', 'deepseek', 'models'], value: [{ id: 'chat', contextWindow: 128000, customFlag: 'preserve' }, { id: 'advertised', contextWindow: 200000 }] },
    ], 7)
    expect(test.opened[0]!.panel.closed).toBe(false)
    expect(test.setCredential).not.toHaveBeenCalled()
  })

  it('keeps model additions/discovery in drafts and saves models.dev metadata only on Save', async () => {
    const test = fixture()
    await test.controller.openEditor(test.client, 'deepseek')
    mocks.metadata.mockResolvedValueOnce({ lookup: () => ({ contextWindow: 1000000, efforts: ['low', 'high'] }) })
    const reply = await test.act({ kind: 'submit', submission: { actionId: 'add-model', source: [], forms: [{ pagePath: [{ controlId: 'provider-pages', itemId: 'models' }], formId: 'custom-model', draftRevision: 1, fields: [{ id: 'model-id', value: 'manual', change: 'set' }] }] } })
    expect(reply).toMatchObject({ kind: 'accepted', feedback: { message: 'Model "manual" added — save to persist' } })
    expect(test.render()).toContain('manual')
    expect(test.mutate).not.toHaveBeenCalled()
    await test.submit([], [{ pagePath: [{ controlId: 'provider-pages', itemId: 'models' }], controlId: 'advertised-models', selectedIds: ['manual'] }])
    expect(test.mutate).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'set', path: ['providers', 'deepseek', 'models'], value: [{ id: 'manual', contextWindow: 1000000, reasoningEfforts: { low: 'low', high: 'high' } }] }], 7)
  })

  it('rejects stale settings/credential observations and invalid URLs without writing', async () => {
    const test = fixture()
    await test.controller.openEditor(test.client, 'deepseek')
    expect(await test.submit([test.form('connection', [{ id: 'baseURL', change: 'set', value: 'file:///private' }])])).toMatchObject({ kind: 'invalid' })
    const source = test.browser().source!()
    test.emit('credentials/reference-updated', 'DEEPSEEK_API_KEY')
    const reply = await test.act({ kind: 'submit', submission: { source, forms: [test.form('credentials', [{ id: 'key', value: 'fresh-key', change: 'set' }])] } })
    expect(reply).toMatchObject({ kind: 'conflict', message: 'The credential changed elsewhere; review before saving' })
    test.changeSettings({ ...test.settings(), namespaces: test.settings().namespaces.map(item => ({ ...item, revision: 20 })) })
    expect(await test.act({ kind: 'submit', submission: { source, forms: [] } })).toMatchObject({ kind: 'conflict' })
    expect(test.mutate).not.toHaveBeenCalled()
    expect(test.setCredential).not.toHaveBeenCalled()
  })

  it('uses shared confirmation metadata for clearing/deletion and never clears external credentials', async () => {
    const test = fixture({ external: true })
    await test.controller.openEditor(test.client, 'deepseek')
    expect(await test.act({ kind: 'activate', actionId: 'delete' })).toMatchObject({ kind: 'accepted', feedback: { severity: 'warning', message: 'Provider removed; its external credential remains unchanged' } })
    expect(test.mutate).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'unset', path: ['providers', 'deepseek'] }], 7)
    expect(test.unsetCredential).not.toHaveBeenCalled()
    const local = fixture()
    await local.controller.openEditor(local.client, 'deepseek')
    expect(await local.act({ kind: 'activate', actionId: 'clear-key' })).toMatchObject({ kind: 'accepted', feedback: { message: 'Stored API key cleared' } })
    expect(local.unsetCredential).toHaveBeenCalledWith('DEEPSEEK_API_KEY')
  })

  it('does not save credentials after a cancelled partial settings write and redacts credential errors', async () => {
    const test = fixture()
    await test.controller.openEditor(test.client, 'deepseek')
    test.setCredential.mockRejectedValueOnce(new Error('fresh-key was refused'))
    const partial = await test.submit([test.form('connection', [{ id: 'name', value: 'Changed', change: 'set' }]), test.form('credentials', [{ id: 'key', value: 'fresh-key', change: 'set' }])])
    expect(partial).toMatchObject({ kind: 'failed', message: 'Provider settings saved, but the credential could not be saved' })
    expect(JSON.stringify(partial)).not.toContain('fresh-key')
    const delayed = deferred<unknown>()
    test.mutate.mockReturnValueOnce(delayed.promise)
    const pending = test.submit([test.form('connection', [{ id: 'name', value: 'Late', change: 'set' }]), test.form('credentials', [{ id: 'key', value: 'later-key', change: 'set' }])])
    await vi.waitFor(() => { expect(test.mutate).toHaveBeenCalledTimes(2) })
    test.detach()
    delayed.resolve({ ok: true, value: namespace('llm-pi-ai', { revision: 9 }) })
    expect(await pending).toMatchObject({ kind: 'cancelled' })
    expect(test.setCredential).toHaveBeenCalledOnce()
    expect(test.events.get('credentials/reference-updated')?.size).toBe(0)
  })
})

describe('reference provider setup', () => {
  it('opens the numbered source chooser, filters dormant known/OAuth routes, and uses exact endpoint steps', async () => {
    const test = fixture()
    await test.controller.openAdd(test.client)
    expect(test.browser().id).toBe('mayfly.provider.add')
    expect(test.render()).toContain('"id":"provider-source"')
    expect(test.render()).toContain('"numbered":true')
    await test.act({ kind: 'selection-accept', selectedIds: ['oauth'] })
    expect(test.browser().id).toBe('mayfly.provider.add.oauth')
    expect(test.render()).toContain('OAuth')
    expect(test.render()).not.toContain('DeepSeek')
    const custom = fixture()
    await custom.openCustom()
    expect(custom.browser().id).toBe('mayfly.provider.add.custom')
    expect(custom.render()).toContain('"id":"provider-tabs"')
    expect(custom.render()).toContain('"id":"models","label":"Models","disabled":true')
    expect(custom.render()).toContain('"id":"next"')
    expect(custom.render()).not.toContain('model-a,model-b')
  })

  it('performs cancellable discovery without writes and invalidates it when connection input changes', async () => {
    const test = fixture()
    await test.openCustom()
    const pending = deferred<unknown>()
    test.discover.mockReturnValueOnce(pending.promise)
    expect(await test.act({ kind: 'activate', actionId: 'next', inputs: test.endpointSubmission() })).toMatchObject({ kind: 'completed', navigate: [{ controlId: 'provider-tabs', itemId: 'models' }] })
    expect(test.render()).toContain('discovering models…')
    expect(test.mutate).not.toHaveBeenCalled()
    test.observe({ kind: 'value-change', controlId: 'baseURL' })
    expect(test.discover.mock.calls[0]![2]?.aborted).toBe(true)
    pending.resolve({ ok: true, value: [{ id: 'late-model' }] })
    await Promise.resolve(); await Promise.resolve()
    expect(test.render()).not.toContain('late-model')
    expect(test.render()).toContain('The connection changed — run discovery again')
  })

  it('saves selected model defaults plus a separate write-only credential only after explicit submission', async () => {
    const test = fixture()
    await test.openCustom()
    const reply = await test.act({ kind: 'submit', submission: test.endpointSubmission() })
    expect(reply).toMatchObject({ kind: 'accepted', dismiss: true })
    expect(test.mutate).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'set', path: ['providers', 'custom'], value: { api: 'openai-completions', baseURL: 'https://endpoint.example', apiKeyEnv: 'CUSTOM_API_KEY', models: [{ id: 'manual', contextWindow: 64000, reasoningEfforts: { low: 'low', high: 'high' } }] } }], 7)
    expect(test.setCredential).toHaveBeenCalledExactlyOnceWith('CUSTOM_API_KEY', 'fresh-key')
    expect(test.created).toHaveBeenCalledWith('custom')
    expect(test.render()).not.toContain('fresh-key')
  })

  it('rejects invalid routes/URLs, stale revisions, and duplicate providers without writes', async () => {
    const test = fixture()
    await test.openCustom()
    for (const input of [{ route: 'Bad Route' }, { baseURL: 'file:///private' }, { route: 'deepseek' }]) expect(await test.act({ kind: 'submit', submission: test.endpointSubmission(input) })).toMatchObject({ kind: 'invalid' })
    expect(await test.act({ kind: 'submit', submission: test.endpointSubmission({}, [], { source: [] }) })).toMatchObject({ kind: 'conflict' })
    expect(test.mutate).not.toHaveBeenCalled()
    expect(test.setCredential).not.toHaveBeenCalled()
  })

  it('retains a created profile after credential failure and never repeats its native settings write', async () => {
    const test = fixture()
    await test.openCustom()
    test.setCredential.mockRejectedValueOnce(new Error('fresh-key refused'))
    expect(await test.act({ kind: 'submit', submission: test.endpointSubmission() })).toMatchObject({ kind: 'failed', message: 'Provider created, but its credential could not be saved', acceptedFields: expect.any(Array) })
    expect(await test.act({ kind: 'submit', submission: test.endpointSubmission() })).toMatchObject({ kind: 'accepted', dismiss: true })
    expect(test.mutate).toHaveBeenCalledOnce()
    expect(test.setCredential).toHaveBeenCalledTimes(2)
  })
})

describe('reference OAuth authorization lifecycle', () => {
  it('renders persistent instructions, copies them, and sends answers only after shared acknowledgement', async () => {
    const test = fixture()
    const replied = vi.fn()
    test.authorize.mockImplementationOnce(async (_client, _key, _method, interaction) => {
      interaction.notice({ message: 'Follow browser', url: 'https://auth.example/start', code: 'ABCD' })
      const answer = await interaction.prompt({ kind: 'secret', message: 'Authorization code', placeholder: 'Paste' })
      replied(answer)
      return 'authorized'
    })
    await test.controller.openAuthorize(test.client, 'oauth')
    const running = test.act({ kind: 'activate', actionId: 'start' }, undefined, 0)
    await vi.waitFor(() => { expect(test.opened).toHaveLength(2) })
    expect(test.render(0)).toContain('Follow browser')
    expect(test.render(1)).toContain('"id":"authorization-answer"')
    await test.act({ kind: 'activate', actionId: 'copy-code' }, undefined, 1)
    expect(test.copy).toHaveBeenCalledWith('ABCD')
    const answer = await test.act({ kind: 'submit', submission: { forms: [{ formId: 'authorization-answer', pagePath: [], fields: [{ id: 'answer', value: 'response', change: 'set' }] }] } }, undefined, 1)
    expect(answer).toMatchObject({ kind: 'accepted', dismiss: true })
    expect(replied).not.toHaveBeenCalled()
    test.ack(test.browser(1).id)
    expect(await running).toMatchObject({ kind: 'accepted', feedback: { message: 'Authorization completed' } })
    expect(replied).toHaveBeenCalledExactlyOnceWith({ type: 'answer', value: 'response' })
    expect(test.mutate).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'set', path: ['providers', 'oauth'], value: {} }], 7)
    expect(test.created).toHaveBeenCalledWith('oauth')
    expect(test.registryListeners.size).toBe(0)
  })

  it('declines a dismissed prompt and clears every pending reply on Host retirement', async () => {
    const test = fixture()
    const replied = vi.fn()
    test.authorize.mockImplementationOnce(async (_client, _key, _method, interaction) => {
      const answer = await interaction.prompt({ kind: 'select', message: 'Choose', options: [{ id: 'one', label: 'One' }] })
      replied(answer)
      return 'cancelled'
    })
    await test.controller.openAuthorize(test.client, 'oauth')
    const running = test.act({ kind: 'activate', actionId: 'start' }, undefined, 0)
    await vi.waitFor(() => { expect(test.opened).toHaveLength(2) })
    expect(test.render(1)).toContain('"id":"authorization-options"')
    test.opened[1]!.close()
    expect(await running).toMatchObject({ kind: 'accepted', feedback: { message: 'Authorization cancelled' } })
    expect(replied).toHaveBeenCalledWith({ type: 'decline' })
    const next = fixture()
    next.authorize.mockImplementationOnce(async (_client, _key, _method, interaction) => { await interaction.prompt({ kind: 'text', message: 'Enter' }); return 'authorized' })
    await next.controller.openAuthorize(next.client, 'oauth')
    const pending = next.act({ kind: 'activate', actionId: 'start' }, undefined, 0)
    await vi.waitFor(() => { expect(next.opened).toHaveLength(2) })
    next.detach()
    expect(await pending).toMatchObject({ kind: 'cancelled' })
    expect(next.mutate).not.toHaveBeenCalled()
    expect(next.registryListeners.size).toBe(0)
  })
})
