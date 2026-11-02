import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteAuthorizationInteraction } from '../../src/remote/features/providers.ts'
import { RemoteProvidersController, remoteProviderCredentialRefs } from '../../src/remote/features/providers.ts'
import { mountRemoteProviderSetup } from '../../src/remote/features/provider-add.ts'
import { RemoteFeatureOperation } from '../../src/remote/features/official.ts'
import { REMOTE_CONFIGURATION_LOCALE } from '../../src/remote/features/locale.ts'
import { configurationFixture, deferred, namespace } from './configuration-fixture.ts'
const mocks = vi.hoisted(() => ({ open: vi.fn(), metadata: vi.fn(async (_ctx: unknown, _signal: AbortSignal): Promise<unknown> => undefined) }))
vi.mock('../../src/remote/panels/browser.ts', () => ({ openRemoteBrowser: mocks.open }))
vi.mock('@ephemeral-ai/mayfly/configuration-panels', async original => ({ ...await original<Record<string, unknown>>(), loadModelsDevIndex: mocks.metadata }))
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); mocks.metadata.mockReset(); mocks.metadata.mockResolvedValue(undefined) })

function fixture(options: { readonly custom?: boolean, readonly writable?: boolean, readonly external?: boolean, readonly missingAuthorization?: boolean, readonly bare?: boolean, readonly balance?: boolean } = {}) {
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
  const balance = vi.fn(async () => ({ status: 'unavailable' as const, reason: 'no-key' as const }))
  const controller = new RemoteProvidersController(test.context, options.bare ? undefined : account, options.missingAuthorization ? undefined : { authorize }, options.balance ? { balance } : undefined, options.bare ? undefined : { copy }, options.bare ? undefined : created)
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
  return { ...test, controller, profile, configs, balance, listProviders, configurable, discover, credentialDescribe, setCredential: set, unsetCredential: unset, authorize, account, copy, created, form, submit, endpointSubmission, openCustom,
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

const good = <T>(value: T) => ({ ok: true as const, value })
const failed = (message = 'native refused', code = 'denied') => ({ ok: false as const, error: { code, message } })
const tick = async () => { await new Promise<void>(done => setImmediate(done)) }
function replaceProfile(test: ReturnType<typeof fixture>, profile: SettingsNamespaceView['value'], revision = 7) {
  test.changeSettings({ ...test.settings(), namespaces: [namespace('llm-pi-ai', { revision, value: { providers: { deepseek: profile } } })] })
}

describe('native provider controller boundaries', () => {
  it('derives every native credential reference without inventing values from malformed or missing profiles', async () => {
    const test = fixture()
    const directory = (await test.controller.directory(test.client))!
    expect(remoteProviderCredentialRefs(directory)).toEqual(['DEEPSEEK_API_KEY'])
    expect(remoteProviderCredentialRefs({ live: [{ ...directory.live[0]!, id: 'odd-provider' }], configurable: [
      { ...directory.configurable[0]!, provider: 'absent', settingsNs: 'missing', settingsPath: ['absent'] },
      { ...directory.configurable[0]!, provider: 'empty', settingsNs: 'native', settingsPath: ['empty'] },
      { ...directory.configurable[0]!, provider: 'custom', settingsNs: 'native', settingsPath: ['custom'] },
    ], settings: { ...directory.settings, namespaces: [namespace('native', { value: { empty: { apiKeyEnv: '' }, custom: { apiKeyEnv: 'CUSTOM_REF' } } })] } })).toEqual(['DEEPSEEK_API_KEY', 'ODD_PROVIDER_API_KEY', 'CUSTOM_REF'])
  })

  it('refuses every detached public operation and optional capabilities before native I/O', async () => {
    const test = fixture({ balance: true })
    test.detach()
    expect(await test.controller.directory(test.client)).toBeUndefined()
    expect(await test.controller.discover(test.client, 'native', {})).toEqual([])
    await test.controller.setCredential(test.client, 'REF', 'secret')
    await test.controller.unsetCredential(test.client, 'REF')
    await test.controller.remove(test.client, 'route')
    expect(await test.controller.balance(test.client)).toBeUndefined()
    await test.controller.openModels(test.client, 'native'); await test.controller.open(); await test.controller.open(test.client)
    expect(await test.controller.openEditor(test.client, 'native')).toBe(false)
    await test.controller.openAdd(test.client); await test.controller.openAuthorize(test.client, 'native')
    expect(test.listProviders).not.toHaveBeenCalled(); expect(test.credentialDescribe).not.toHaveBeenCalled(); expect(test.balance).not.toHaveBeenCalled()
    const bare = fixture({ bare: true, missingAuthorization: true })
    expect(await bare.controller.balance(bare.client)).toBeUndefined()
    await bare.controller.openAuthorize(bare.client, 'native'); expect(bare.notice.set).toHaveBeenCalledWith(expect.stringContaining('authorization'))
    bare.ctx.mayflyOverlays.focus.mockReturnValue(true)
    await bare.controller.open(); await bare.controller.openAdd(bare.client)
    expect(bare.opened).toHaveLength(0)
  })

  it('redacts one-shot discovery and credential failures and never replaces a changed credential implicitly', async () => {
    const test = fixture()
    test.discover.mockRejectedValueOnce(new Error('secret-key refused'))
    await expect(test.controller.discover(test.client, 'native', { apiKey: 'secret-key' })).rejects.toThrow('[redacted] refused')
    test.discover.mockResolvedValueOnce(failed('ordinary failure'))
    await expect(test.controller.discover(test.client, 'native', {})).rejects.toThrow('ordinary failure')
    expect(await test.controller.discover(test.client, 'native', {})).toEqual([{ id: 'advertised', contextWindow: 200000 }])
    test.discover.mockImplementationOnce(async () => { test.reconnect(); return good([{ id: 'retired' }]) })
    expect(await test.controller.discover(test.client, 'native', {})).toEqual([])
    await expect(test.controller.setCredential(test.client, 'REF', 'secret')).rejects.toThrow('configured elsewhere')
    await test.controller.setCredential(test.client, 'REF', 'secret', true)
    expect(test.setCredential).toHaveBeenCalledWith('REF', 'secret')
    test.credentialDescribe.mockResolvedValueOnce(good({ REF: { configured: false, writable: true } }))
    test.setCredential.mockRejectedValueOnce(new Error('secret rejected'))
    await expect(test.controller.setCredential(test.client, 'REF', 'secret')).rejects.toThrow('[redacted] rejected')
    test.credentialDescribe.mockResolvedValueOnce(good({}))
    await expect(test.controller.setCredential(test.client, 'REF', 'secret')).rejects.toThrow('read-only')
    test.credentialDescribe.mockResolvedValueOnce(good({ REF: { configured: false, writable: true } }))
    await test.controller.unsetCredential(test.client, 'REF'); expect(test.unsetCredential).toHaveBeenCalledWith('REF')
    test.credentialDescribe.mockImplementationOnce(async () => { test.reconnect(); return good({ REF: { configured: false, writable: true } }) })
    await test.controller.setCredential(test.client, 'REF', 'late')
    expect(test.setCredential).toHaveBeenCalledTimes(2)
    test.credentialDescribe.mockImplementationOnce(async () => { test.reconnect(); return good({ REF: { writable: true } }) })
    await test.controller.unsetCredential(test.client, 'REF'); expect(test.unsetCredential).toHaveBeenCalledOnce()
  })

  it('rechecks native profile address, write permission and exact revision before removal', async () => {
    for (const mode of ['readonly', 'missing-address', 'root-address', 'missing-descriptor', 'missing-profile', 'latest-readonly', 'latest-missing', 'latest-revision', 'latest-profile'] as const) {
      const test = fixture()
      if (mode === 'readonly') test.changeSettings({ ...test.settings(), writable: false })
      if (mode === 'missing-address') test.configurable.mockResolvedValueOnce(good([]))
      if (mode === 'root-address') test.configurable.mockResolvedValueOnce(good([{ provider: 'deepseek', settingsNs: 'llm-pi-ai', settingsPath: [] }]))
      if (mode === 'missing-descriptor') test.changeSettings({ ...test.settings(), namespaces: [] })
      if (mode === 'missing-profile') replaceProfile(test, null)
      if (mode.startsWith('latest')) test.describe.mockResolvedValueOnce(good(test.settings())).mockImplementationOnce(async () => good({ ...test.settings(), ...mode === 'latest-readonly' ? { writable: false } : { namespaces: mode === 'latest-missing' ? [] : [namespace('llm-pi-ai', { revision: mode === 'latest-revision' ? 8 : 7, value: { providers: { deepseek: { ...test.profile, displayName: 'other' } } } })] } }))
      await expect(test.controller.remove(test.client, 'deepseek')).rejects.toThrow(mode.includes('readonly') ? 'read-only' : mode.startsWith('latest') ? 'changed elsewhere' : mode.includes('address') ? 'no editable configuration' : 'no longer available')
      expect(test.mutate).not.toHaveBeenCalled(); expect(test.unsetCredential).not.toHaveBeenCalled()
    }
  })

  it('fences each removal continuation and reports partial credential failures without replaying the write', async () => {
    for (const stage of ['latest', 'write', 'credential']) {
      const test = fixture()
      if (stage === 'latest') test.describe.mockResolvedValueOnce(good(test.settings())).mockImplementationOnce(async () => { test.reconnect(); return good(test.settings()) })
      if (stage === 'write') test.mutate.mockImplementationOnce(async () => { test.reconnect(); return good(namespace()) })
      if (stage === 'credential') test.credentialDescribe.mockImplementationOnce(async () => { test.reconnect(); return good({ DEEPSEEK_API_KEY: { configured: true, writable: true } }) })
      await test.controller.remove(test.client, 'deepseek')
      expect(test.mutate).toHaveBeenCalledTimes(stage === 'latest' ? 0 : 1); expect(test.unsetCredential).not.toHaveBeenCalled(); expect(test.notice.set).not.toHaveBeenCalled()
    }
    const noRef = fixture(); replaceProfile(noRef, { models: [] })
    await noRef.controller.remove(noRef.client, 'deepseek'); expect(noRef.unsetCredential).toHaveBeenCalledWith('DEEPSEEK_API_KEY'); expect(noRef.notice.set).toHaveBeenCalledWith('Provider removed')
    const absent = fixture(); absent.credentialDescribe.mockResolvedValueOnce(good({})); await absent.controller.remove(absent.client, 'deepseek'); expect(absent.unsetCredential).not.toHaveBeenCalled()
    const partial = fixture(); partial.unsetCredential.mockRejectedValueOnce(new Error('store refused'))
    await expect(partial.controller.remove(partial.client, 'deepseek')).rejects.toThrow('Provider removed, but the stored credential could not be cleared: store refused')
    expect(partial.mutate).toHaveBeenCalledOnce()
    const changed = fixture(); changed.unsetCredential.mockImplementationOnce(async () => { changed.reconnect(); return good(undefined) }); await changed.controller.remove(changed.client, 'deepseek'); expect(changed.notice.set).not.toHaveBeenCalled()
  })

  it('keeps native balance reads bound to their Host generation and supports a model-picker-free composition', async () => {
    const test = fixture({ balance: true, bare: true })
    expect(await test.controller.balance(test.client)).toEqual({ status: 'unavailable', reason: 'no-key' })
    test.balance.mockImplementationOnce(async () => { test.reconnect(); return { status: 'unavailable', reason: 'no-key' } })
    expect(await test.controller.balance(test.client)).toBeUndefined()
    await test.controller.openModels(test.client, 'deepseek')
    expect(test.created).not.toHaveBeenCalled()
  })

  it('renders sparse native roster rows, opens account routes and refuses an uneditable native selection', async () => {
    const test = fixture()
    test.listProviders.mockResolvedValue(good([{ id: 'deepseek-account', name: 'Account' }, { id: 'bare', name: '' }, { id: 'empty', name: 'Empty' }, { id: 'deepseek', name: 'DeepSeek' }]))
    test.configurable.mockResolvedValue(good([...test.configs, { provider: 'empty', displayName: 'Empty', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'empty'] }]))
    test.changeSettings({ ...test.settings(), namespaces: [namespace('llm-pi-ai', { value: { providers: { deepseek: { models: [] }, empty: {} } } })] })
    test.credentialDescribe.mockImplementation(async refs => refs[0] === 'BARE_API_KEY' ? failed('credential unavailable') : good({ [refs[0]!]: { configured: false, writable: true } }))
    await test.controller.open()
    expect(test.render()).toContain('no models'); expect(test.render()).toContain('no key set'); expect(test.render()).toContain('"label":"bare"')
    expect(await test.act({ kind: 'selection-accept', controlId: 'providers', selectedIds: ['deepseek-account'] })).toMatchObject({ kind: 'completed' }); expect(test.account).toHaveBeenCalledWith(test.client)
    expect(await test.act({ kind: 'selection-accept', controlId: 'providers', selectedIds: ['bare'] })).toMatchObject({ kind: 'failed' })
    for (const event of [{ kind: 'activate', actionId: 'other' }, { kind: 'selection-accept', controlId: 'other', selectedIds: [] }, { kind: 'selection-accept', controlId: 'providers', selectedIds: [] }, { kind: 'selection-accept', controlId: 'providers', selectedIds: ['foreign'] }]) expect(await test.act(event)).toMatchObject({ kind: 'completed' })
    const abort = new AbortController(); abort.abort(); expect(await test.act({ kind: 'activate', actionId: 'add' }, abort.signal)).toMatchObject({ kind: 'cancelled' })
    const roster = test.opened.length - 1
    expect(await test.act({ kind: 'activate', actionId: 'add' }, undefined, roster)).toMatchObject({ kind: 'completed' }); expect(test.browser().id).toBe('mayfly.provider.add')
    test.reconnect(); expect(await test.act({ kind: 'activate', actionId: 'add' }, undefined, roster)).toMatchObject({ kind: 'cancelled' })
  })

  it('refreshes the roster from latest native settings and discards older, failed and detached reads', async () => {
    const test = fixture()
    await test.controller.open()
    const older = deferred<unknown>(), newer = deferred<unknown>()
    test.listProviders.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    test.emit('settings/document-updated', 'llm-pi-ai', 8); test.emit('settings/document-updated', 'llm-pi-ai', 9)
    newer.resolve(good([{ id: 'latest', name: 'Latest' }])); await tick()
    older.resolve(good([{ id: 'stale', name: 'Stale' }])); await tick()
    expect(test.render()).toContain('Latest'); expect(test.render()).not.toContain('Stale')
    test.listProviders.mockRejectedValueOnce(new Error('background unavailable')); test.emit('settings/document-updated', 'llm-pi-ai', 10); await tick(); expect(test.render()).toContain('Latest')
    test.listProviders.mockImplementationOnce(async () => { test.reconnect(); return good([]) }); test.emit('settings/document-updated', 'llm-pi-ai', 11); await tick()
    expect(test.opened[0]!.panel.closed).toBe(true)
    const retiring = fixture(); retiring.credentialDescribe.mockImplementationOnce(async () => { retiring.reconnect(); return good({}) }); await retiring.controller.open(); expect(retiring.opened).toHaveLength(0)
    const failing = fixture(); failing.listProviders.mockRejectedValueOnce(new Error('directory unavailable')); await failing.controller.open(); expect(failing.notice.set).toHaveBeenCalledWith('directory unavailable')
    const lateFailure = fixture(); lateFailure.listProviders.mockImplementationOnce(async () => { lateFailure.reconnect(); throw new Error('retired') }); await lateFailure.controller.open(); expect(lateFailure.notice.set).not.toHaveBeenCalled()
  })

  it('retires late initial directory/editor reads and refuses unavailable native profiles', async () => {
    for (const view of ['roster', 'setup'] as const) {
      const test = fixture(); test.listProviders.mockImplementationOnce(async () => { test.reconnect(); return good([]) })
      if (view === 'roster') await test.controller.open(); else await test.controller.openAdd(test.client)
      expect(test.opened).toHaveLength(0)
    }
    for (const mode of ['late-settings', 'missing-descriptor', 'missing-profile', 'missing-credential', 'late-credential', 'failed', 'late-failed'] as const) {
      const test = fixture()
      if (mode === 'late-settings') test.describe.mockImplementationOnce(async () => { test.reconnect(); return good(test.settings()) })
      if (mode === 'missing-descriptor') test.changeSettings({ ...test.settings(), namespaces: [] })
      if (mode === 'missing-profile') replaceProfile(test, null)
      if (mode === 'missing-credential') test.credentialDescribe.mockResolvedValueOnce(good({}))
      if (mode === 'late-credential') test.credentialDescribe.mockImplementationOnce(async () => { test.reconnect(); return good({ DEEPSEEK_API_KEY: { configured: true, writable: true } }) })
      if (mode === 'failed') test.configurable.mockRejectedValueOnce(new Error('native failed'))
      if (mode === 'late-failed') test.configurable.mockImplementationOnce(async () => { test.reconnect(); throw new Error('retired failure') })
      expect(await test.controller.openEditor(test.client, 'deepseek')).toBe(false)
      expect(test.opened).toHaveLength(0)
      expect(test.notice.set).toHaveBeenCalledTimes(mode === 'failed' ? 1 : 0)
    }
    const roster = fixture(); await roster.controller.open(); expect(roster.browser().isCurrent?.()).toBe(true)
  })

  it('routes native OAuth picker selection and fences retired chooser actions', async () => {
    const test = fixture(); await test.controller.openAdd(test.client)
    const source = 0
    await test.act({ kind: 'selection-accept', selectedIds: ['oauth'] }, undefined, source)
    const picker = 1
    expect(await test.act({ kind: 'selection-accept', selectedIds: ['oauth'] }, undefined, picker)).toMatchObject({ kind: 'completed' }); expect(test.browser().id).toContain('mayfly.authorization.')
    const abort = new AbortController(); abort.abort()
    expect(await test.act({ kind: 'selection-accept', selectedIds: ['known'] }, abort.signal, picker)).toMatchObject({ kind: 'cancelled' })
    expect(await test.act({ kind: 'selection-accept', selectedIds: ['custom'] }, abort.signal, source)).toMatchObject({ kind: 'cancelled' })
    test.reconnect()
    expect(await test.act({ kind: 'selection-accept', selectedIds: ['known'] }, undefined, picker)).toMatchObject({ kind: 'cancelled' })
    expect(await test.act({ kind: 'selection-accept', selectedIds: ['custom'] }, undefined, source)).toMatchObject({ kind: 'cancelled' })
  })

  it('keeps setup errors local to the current Host and refuses vanished known-provider addresses', async () => {
    for (const mode of ['container', 'failure', 'late-failure'] as const) {
      const test = fixture()
      if (mode === 'container') test.configurable.mockResolvedValueOnce(good([]))
      if (mode === 'failure') test.listProviders.mockRejectedValueOnce(new Error('native directory failed'))
      if (mode === 'late-failure') test.listProviders.mockImplementationOnce(async () => { test.reconnect(); throw new Error('retired') })
      await test.controller.openAdd(test.client)
      expect(test.opened).toHaveLength(0); expect(test.notice.set).toHaveBeenCalledTimes(mode === 'late-failure' ? 0 : 1)
    }
    for (const mode of ['late-read', 'missing-container', 'missing-descriptor', 'failure', 'late-failure', 'known-vanished'] as const) {
      const test = fixture(); await test.controller.openAdd(test.client)
      if (mode === 'known-vanished') await test.act({ kind: 'selection-accept', selectedIds: ['known'] })
      if (mode === 'late-read') test.configurable.mockImplementationOnce(async () => { test.reconnect(); return good(test.configs) })
      if (mode === 'missing-container' || mode === 'known-vanished') test.configurable.mockResolvedValueOnce(good([]))
      if (mode === 'missing-descriptor') test.changeSettings({ ...test.settings(), namespaces: [] })
      if (mode === 'failure') test.configurable.mockRejectedValueOnce(new Error('endpoint unavailable'))
      if (mode === 'late-failure') test.configurable.mockImplementationOnce(async () => { test.reconnect(); throw new Error('retired') })
      await test.act({ kind: 'selection-accept', selectedIds: [mode === 'known-vanished' ? 'known' : 'custom'] })
      expect(test.opened).toHaveLength(mode === 'known-vanished' ? 2 : 1)
      expect(test.notice.set).toHaveBeenCalledTimes(mode === 'late-read' || mode === 'late-failure' ? 0 : 1)
    }
  })
})

describe('native provider editor drafts and generations', () => {
  const addModel = (id?: unknown) => ({ kind: 'submit', submission: { actionId: 'add-model', source: [], forms: [{ pagePath: [], formId: 'custom-model', fields: id === undefined ? [] : [{ id: 'model-id', value: id, change: 'set' }] }] } })

  it('keeps unchanged selected models free of writes and supports an empty native profile', async () => {
    const test = fixture(); await test.controller.openEditor(test.client, 'deepseek')
    expect(await test.submit([], [{ controlId: 'advertised-models', pagePath: [], selectedIds: ['chat'] }])).toMatchObject({ kind: 'accepted' })
    expect(test.mutate).not.toHaveBeenCalled()
    expect(await test.submit([], [{ controlId: 'advertised-models', pagePath: [], selectedIds: ['replacement'] }])).toMatchObject({ kind: 'accepted' })
    expect(test.mutate).toHaveBeenCalledOnce()
    const empty = fixture(); replaceProfile(empty, {}); await empty.controller.openEditor(empty.client, 'deepseek'); expect(empty.render()).toContain('"value":"deepseek"')
  })

  it('keeps every model metadata shape in drafts and normalizes only explicitly edited native fields', async () => {
    const test = fixture()
    replaceProfile(test, { models: [{ id: 4 }, { id: 'plain' }], reasoning: 'unrecognized' })
    test.discover.mockResolvedValue(good([{ id: 'advertised', maxTokens: 4096 }, { id: 'windowed', contextWindow: 1234 }]))
    await test.controller.openEditor(test.client, 'deepseek'); await tick()
    expect(test.browser().isCurrent?.()).toBe(true); expect(test.render()).toContain('"value":"deepseek"'); expect(test.render()).toContain('"value":"default"')
    expect(await test.act(addModel())).toMatchObject({ kind: 'invalid' })
    for (const [id, facts] of [['reasoning', { contextWindow: 8192, maxTokens: 1024, efforts: ['high'] }], ['nonreasoning', { nonReasoning: true }], ['unknown', undefined]] as const) {
      mocks.metadata.mockResolvedValueOnce(facts === undefined ? undefined : { lookup: () => facts })
      expect(await test.act(addModel(id))).toMatchObject({ kind: 'accepted' })
    }
    expect(await test.act(addModel('unknown'))).toMatchObject({ kind: 'invalid', errors: [{ message: 'Already listed' }] })
    const reply = await test.submit([
      test.form('connection', [{ id: 'name', value: '  ', change: 'set' }, { id: 'baseURL', value: 'https://endpoint.example/v1///', change: 'set' }, { id: 'ignored', value: 'ignore', change: 'set' }, { id: 'name', value: 'unchanged', change: 'unchanged' }]),
      test.form('models', [{ id: 'reasoning', value: 'high', change: 'set' }]),
      { pagePath: [], formId: 'ignored', fields: [{ id: 'other', value: 1, change: 'set' }] },
      test.form('credentials', [{ id: 'key', value: '', change: 'set' }]),
    ], [{ pagePath: [], controlId: 'advertised-models', selectedIds: ['advertised', 'reasoning', 'nonreasoning', 'unknown'] }])
    expect(reply).toMatchObject({ kind: 'accepted' })
    expect(test.mutate).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'deepseek', 'displayName'], value: 'deepseek' },
      { op: 'set', path: ['providers', 'deepseek', 'baseURL'], value: 'https://endpoint.example/v1' },
      { op: 'set', path: ['providers', 'deepseek', 'reasoning'], value: 'high' },
      { op: 'set', path: ['providers', 'deepseek', 'models'], value: [{ id: 'advertised', maxTokens: 4096 }, { id: 'reasoning', contextWindow: 8192, maxTokens: 1024, reasoningEfforts: { high: 'high' } }, { id: 'nonreasoning', reasoningEfforts: false }, { id: 'unknown' }] },
    ], 7)
    expect(test.setCredential).not.toHaveBeenCalled()
    expect(await test.act({ kind: 'selection-accept', controlId: 'ignored', selectedIds: [] })).toMatchObject({ kind: 'completed' })
    expect(await test.act({ kind: 'activate', actionId: 'ignored' })).toMatchObject({ kind: 'completed' })
  })

  it('refreshes settings and credential observations while retaining newer revisions and vanished-profile feedback', async () => {
    const test = fixture()
    await test.controller.openEditor(test.client, 'deepseek'); await tick()
    test.emit('credentials/reference-updated', 'unrelated')
    test.emit('settings/document-updated', 'unrelated', 8)
    const originalReads = test.describe.mock.calls.length
    expect(test.describe).toHaveBeenCalledTimes(originalReads)
    const old = deferred<unknown>()
    test.describe.mockReturnValueOnce(old.promise)
    test.emit('settings/document-updated', 'llm-pi-ai', 8)
    replaceProfile(test, { ...test.profile, displayName: 'Newest' }, 9)
    test.emit('settings/document-updated', 'llm-pi-ai', 9); await tick()
    old.resolve(good({ ...test.settings(), namespaces: [namespace('llm-pi-ai', { revision: 8, value: { providers: { deepseek: test.profile } } })] })); await tick()
    expect(test.render()).toContain('Newest')
    replaceProfile(test, test.profile, 6); test.emit('settings/document-updated', 'llm-pi-ai', 6); await tick(); expect(test.render()).toContain('Newest')
    test.describe.mockResolvedValueOnce(failed('background refused')); test.emit('settings/document-updated', 'llm-pi-ai', 10); await tick(); expect(test.render()).toContain('Newest')
    replaceProfile(test, { ...test.profile, apiKeyEnv: 'REPLACEMENT' }, 10); test.emit('settings/document-updated', 'llm-pi-ai', 10); await tick(); expect(test.render()).toContain('Provider credential reference changed')
    expect(await test.submit([])).toMatchObject({ kind: 'conflict', message: 'Provider configuration changed; reopen the provider' })
    replaceProfile(test, null, 11); test.emit('settings/document-updated', 'llm-pi-ai', 11); await tick(); expect(test.render()).toContain('Provider configuration is no longer available')
    expect(await test.submit([])).toMatchObject({ kind: 'conflict' })
    test.changeSettings({ ...test.settings(), namespaces: [] }); expect(await test.submit([])).toMatchObject({ kind: 'failed', message: 'Provider configuration could not be saved' })
    const missing = fixture(); await missing.controller.openEditor(missing.client, 'deepseek'); missing.credentialDescribe.mockResolvedValue(good({})); expect(await missing.submit([])).toMatchObject({ kind: 'failed' })
  })

  it('treats discovery as a cancellable native read and retains manual model entry when every endpoint refuses', async () => {
    const test = fixture()
    test.discover.mockRejectedValueOnce(new Error('listing failed')).mockResolvedValueOnce(good([])).mockResolvedValueOnce(good([]))
    await test.controller.openEditor(test.client, 'deepseek'); await tick()
    expect(test.render()).toContain('model discovery unavailable')
    expect(await test.act({ kind: 'activate', actionId: 'discover' })).toMatchObject({ kind: 'completed' }); await tick(); expect(test.render()).toContain('advertised')
    const late = deferred<unknown>(); test.discover.mockReturnValueOnce(late.promise)
    await test.act({ kind: 'activate', actionId: 'discover' }); expect(test.render()).toContain('discovering models')
    await test.act({ kind: 'activate', actionId: 'discover' }); await tick()
    expect(test.discover.mock.calls.at(-2)![2]?.aborted).toBe(true)
    late.resolve(good([{ id: 'retired-model' }])); await tick(); expect(test.render()).not.toContain('retired-model')
    const retiring = deferred<unknown>(); test.discover.mockReturnValueOnce(retiring.promise); await test.act({ kind: 'activate', actionId: 'discover' }); test.reconnect()
    retiring.resolve(failed('retired failure')); await tick(); expect(test.opened[0]!.panel.closed).toBe(true)
  })

  it('keeps clear/delete confirmations revision checked and reports native partial failures exactly', async () => {
    const test = fixture()
    await test.controller.openEditor(test.client, 'deepseek')
    const source = test.browser().source!()
    test.emit('credentials/reference-updated', 'DEEPSEEK_API_KEY'); await tick()
    expect(await test.browser().action!({ kind: 'activate', actionId: 'delete', controlId: 'actions', pagePath: [] }, { surfaceId: test.browser().id, source, revision: 1, operationId: 'stale', signal: new AbortController().signal, report() {} })).toMatchObject({ kind: 'conflict', message: 'The credential changed elsewhere; review before continuing' })
    test.unsetCredential.mockRejectedValueOnce(new Error('store unavailable'))
    expect(await test.act({ kind: 'activate', actionId: 'delete' })).toMatchObject({ kind: 'failed', message: 'Provider removed, but the stored credential could not be cleared' })
    const external = fixture({ external: true }); await external.controller.openEditor(external.client, 'deepseek'); expect(await external.act({ kind: 'activate', actionId: 'clear-key' })).toMatchObject({ kind: 'accepted', feedback: { message: 'The external credential cannot be cleared here' } })
    const deleted = fixture(); await deleted.controller.openEditor(deleted.client, 'deepseek'); expect(await deleted.act({ kind: 'activate', actionId: 'delete' })).toMatchObject({ kind: 'accepted', feedback: { message: 'Provider removed' } })
    const failedWrite = fixture(); await failedWrite.controller.openEditor(failedWrite.client, 'deepseek'); failedWrite.mutate.mockResolvedValueOnce(failed('revision conflict', 'settings/conflict'))
    expect(await failedWrite.submit([failedWrite.form('connection', [{ id: 'name', value: 'new', change: 'set' }])])).toMatchObject({ kind: 'conflict' })
    failedWrite.mutate.mockResolvedValueOnce(failed('storage unavailable'))
    expect(await failedWrite.submit([failedWrite.form('connection', [{ id: 'name', value: 'new', change: 'set' }])])).toMatchObject({ kind: 'failed', message: 'Provider configuration could not be saved' })
    const readonly = fixture({ external: true }); await readonly.controller.openEditor(readonly.client, 'deepseek'); expect(await readonly.submit([readonly.form('credentials', [{ id: 'key', value: 'fresh', change: 'set' }])])).toMatchObject({ kind: 'conflict' })
  })

  it('cancels editor continuations at every native read/write boundary without retrying a sent write', async () => {
    for (const stage of ['settings-read', 'credential-read', 'custom-model', 'delete-write', 'unset-write', 'delete-refresh', 'external-refresh', 'secret-write', 'save-refresh', 'catch-read', 'catch-failure'] as const) {
      const test = fixture({ external: stage === 'external-refresh' })
      await test.controller.openEditor(test.client, 'deepseek'); await tick()
      const abort = new AbortController()
      const retire = () => { abort.abort() }
      let event: Record<string, unknown> = { kind: 'submit', submission: { source: test.browser().source!(), forms: [test.form('credentials', [{ id: 'key', value: 'fresh', change: 'set' }])] } }
      if (stage === 'settings-read') test.describe.mockImplementationOnce(async () => { test.reconnect(); return good(test.settings()) })
      if (stage === 'credential-read') test.credentialDescribe.mockImplementationOnce(async () => { test.reconnect(); return good({}) })
      if (stage === 'custom-model') { event = addModel('late'); mocks.metadata.mockImplementationOnce(async () => { retire(); return undefined }) }
      if (stage === 'delete-write') { event = { kind: 'activate', actionId: 'delete' }; test.mutate.mockImplementationOnce(async () => { retire(); return good(namespace()) }) }
      if (stage === 'unset-write') { event = { kind: 'activate', actionId: 'clear-key' }; test.unsetCredential.mockImplementationOnce(async () => { retire(); return good(undefined) }) }
      if (stage === 'delete-refresh' || stage === 'external-refresh') { event = { kind: 'activate', actionId: 'clear-key' }; test.describe.mockResolvedValueOnce(good(test.settings())).mockImplementationOnce(async () => { test.reconnect(); return good(test.settings()) }) }
      if (stage === 'secret-write') test.setCredential.mockImplementationOnce(async () => { retire(); return good(undefined) })
      if (stage === 'save-refresh') test.describe.mockResolvedValueOnce(good(test.settings())).mockImplementationOnce(async () => { test.reconnect(); return good(test.settings()) })
      if (stage === 'catch-read') { test.setCredential.mockRejectedValueOnce(new Error('write refused')); test.describe.mockResolvedValueOnce(good(test.settings())).mockImplementationOnce(async () => { test.reconnect(); return good(test.settings()) }) }
      if (stage === 'catch-failure') test.setCredential.mockImplementationOnce(async () => { retire(); throw new Error('retired error') })
      expect(await test.act(event, abort.signal)).toMatchObject({ kind: 'cancelled' })
    }
    const cancelled = fixture(); await cancelled.controller.openEditor(cancelled.client, 'deepseek'); const abort = new AbortController(); abort.abort(); expect(await cancelled.act({ kind: 'activate', actionId: 'delete' }, abort.signal)).toMatchObject({ kind: 'cancelled' })
  })
})

describe('native provider setup admission and discovery', () => {
  const addModel = (id?: string) => ({ kind: 'submit', submission: { actionId: 'add-model', forms: [{ pagePath: [], formId: 'custom-model', fields: id === undefined ? [] : [{ id: 'model-id', value: id, change: 'set' }] }], source: [] } })

  it('configures a dormant known native route without custom endpoint or model fields', async () => {
    const test = fixture({ bare: true })
    await test.controller.openAdd(test.client); expect(test.browser().isCurrent?.()).toBe(true)
    expect(await test.act({ kind: 'activate', actionId: 'ignored' })).toMatchObject({ kind: 'completed' })
    await test.act({ kind: 'selection-accept', selectedIds: ['unknown'] }); expect(test.opened).toHaveLength(1)
    await test.act({ kind: 'selection-accept', selectedIds: ['known'] })
    expect(test.render()).toContain('Known provider'); expect(test.browser().isCurrent?.()).toBe(true)
    expect(await test.act({ kind: 'activate', actionId: 'ignored' })).toMatchObject({ kind: 'completed' })
    expect(await test.act({ kind: 'selection-accept', selectedIds: [] })).toMatchObject({ kind: 'completed' })
    expect(await test.act({ kind: 'selection-accept', selectedIds: ['foreign'] })).toMatchObject({ kind: 'completed' })
    await test.act({ kind: 'selection-accept', selectedIds: ['known'] })
    expect(test.browser().id).toBe(`mayfly.provider.add.${Buffer.from('known').toString('hex')}`)
    expect(test.render()).toContain('Configure known'); expect(test.render()).not.toContain('"id":"models"')
    test.observe({ kind: 'value-change', controlId: 'key' })
    const submission = { source: test.browser().source!(), forms: [{ formId: 'connection', pagePath: [], fields: [{ id: 'key', value: 'native-key', change: 'set' }] }] }
    expect(await test.act({ kind: 'submit', submission })).toMatchObject({ kind: 'accepted' })
    expect(test.mutate).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'set', path: ['providers', 'known'], value: { apiKeyEnv: 'KNOWN_API_KEY' } }], 7)
    expect(test.setCredential).toHaveBeenCalledWith('KNOWN_API_KEY', 'native-key'); expect(test.created).not.toHaveBeenCalled()
    const aborted = new AbortController(); aborted.abort(); expect(await test.act({ kind: 'activate', actionId: 'unknown' }, aborted.signal)).toMatchObject({ kind: 'cancelled' })
  })

  it('discovers native endpoints using protocol fallbacks and saves authoritative metadata before user defaults', async () => {
    const test = fixture()
    await test.openCustom()
    mocks.metadata.mockResolvedValue({ lookup: (id: string) => id === 'thinking' ? { contextWindow: 8192, maxTokens: 2048, efforts: ['high'] } : id === 'plain' ? { nonReasoning: true } : undefined })
    test.discover.mockResolvedValueOnce(good([])).mockResolvedValueOnce(good([{ id: 'thinking' }, { id: 'plain', contextWindow: 32768 }, { id: 'unknown' }, { id: 'native', contextWindow: 9000, maxTokens: 4000 }]))
    await test.act({ kind: 'activate', actionId: 'next', inputs: test.endpointSubmission({ protocol: 'anthropic-messages' }) }); await tick()
    expect(test.discover.mock.calls[0]![1]).toMatchObject({ api: 'openai-completions' })
    expect(test.render()).toContain('32768 tokens'); expect(test.render()).toContain('thinking'); expect(test.browser().isCurrent?.()).toBe(true)
    expect(await test.act(addModel('thinking'))).toMatchObject({ kind: 'invalid', errors: [{ message: 'Already listed' }] })
    const submission = test.endpointSubmission({ protocol: 'anthropic-messages' }, ['thinking', 'plain', 'unknown', 'native'])
    expect(await test.act({ kind: 'submit', submission })).toMatchObject({ kind: 'accepted' })
    expect(test.mutate.mock.calls[0]![1]).toEqual([{ op: 'set', path: ['providers', 'custom'], value: { api: 'anthropic-messages', baseURL: 'https://endpoint.example', apiKeyEnv: 'CUSTOM_API_KEY', models: [
      { id: 'thinking', contextWindow: 8192, maxTokens: 2048, reasoningEfforts: { high: 'high' } }, { id: 'plain', contextWindow: 32768, reasoningEfforts: false }, { id: 'unknown', contextWindow: 64000, reasoningEfforts: { low: 'low', high: 'high' } }, { id: 'native', contextWindow: 9000, maxTokens: 4000, reasoningEfforts: { low: 'low', high: 'high' } },
    ] } }])
  })

  it('preserves failed discovery as redacted feedback and admits manual model ids without Host writes', async () => {
    const test = fixture(); await test.openCustom()
    test.discover.mockResolvedValue(good([]))
    await test.act({ kind: 'activate', actionId: 'discover', inputs: test.endpointSubmission({ protocol: 'openai-responses' }) }); await tick()
    expect(test.render()).toContain('model discovery unavailable'); expect(test.render()).toContain('Model discovery failed'); expect(test.render()).not.toContain('— undefined')
    expect(REMOTE_CONFIGURATION_LOCALE.zh['Model discovery failed']).toBe('模型发现失败')
    expect(test.discover.mock.calls.some(call => (call[1] as { api?: string }).api === 'openai-completions')).toBe(true)
    expect(await test.act(addModel())).toMatchObject({ kind: 'invalid', errors: [{ message: 'Enter a model ID' }] })
    for (const [id, facts] of [['thinking', { contextWindow: 1000, maxTokens: 100, efforts: ['low'] }], ['plain', { nonReasoning: true }], ['unknown', undefined]] as const) {
      mocks.metadata.mockResolvedValueOnce(facts === undefined ? undefined : { lookup: () => facts })
      expect(await test.act(addModel(id))).toMatchObject({ kind: 'accepted' })
    }
    expect(await test.act(addModel('plain'))).toMatchObject({ kind: 'invalid', errors: [{ message: 'Already listed' }] })
    expect(test.render()).toContain('1000 tokens'); expect(test.mutate).not.toHaveBeenCalled()
    const input = test.endpointSubmission({}, ['thinking', 'plain', 'unknown'])
    input.forms[1]!.fields = []
    expect(await test.act({ kind: 'submit', submission: input })).toMatchObject({ kind: 'accepted' })
    expect(test.mutate.mock.calls[0]![1]).toEqual([{ op: 'set', path: ['providers', 'custom'], value: { api: 'openai-completions', baseURL: 'https://endpoint.example', apiKeyEnv: 'CUSTOM_API_KEY', models: [{ id: 'thinking', contextWindow: 1000, maxTokens: 100, reasoningEfforts: { low: 'low' } }, { id: 'plain', reasoningEfforts: false }, { id: 'unknown' }] } }])
    test.observe({ kind: 'value-change', controlId: 'baseURL' }); expect(test.render()).toContain('"disabled":true')
    expect(await test.act({ kind: 'activate', actionId: 'discover' })).toMatchObject({ kind: 'completed' })
  })

  it('uses the documented container fallback for a known route and redacts refused discovery keys', async () => {
    const known = fixture()
    const operation = new RemoteFeatureOperation(known.context, known.client)
    mountRemoteProviderSetup(known.context, { operation, descriptor: known.settings().namespaces[0]!, container: ['providers'], writable: true, known: 'known' })
    cleanups.push(() => operation.dispose())
    expect(await known.act({ kind: 'submit', submission: { source: known.browser().source!(), forms: [{ formId: 'connection', pagePath: [], fields: [] }] } })).toMatchObject({ kind: 'accepted' })
    expect(known.mutate).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'set', path: ['providers', 'known'], value: { apiKeyEnv: 'KNOWN_API_KEY' } }], 7)
    const test = fixture(); await test.openCustom(); test.discover.mockResolvedValue(failed('fresh-key refused'))
    await test.act({ kind: 'activate', actionId: 'next', inputs: test.endpointSubmission() }); await tick()
    expect(test.render()).toContain('[redacted] refused'); expect(test.render()).not.toContain('fresh-key')
  })

  it('retains native drafts through settings refreshes, writability changes, missing namespaces and create conflicts', async () => {
    const test = fixture(); await test.openCustom()
    test.emit('settings/document-updated', 'other', 8)
    const old = deferred<unknown>(); test.describe.mockReturnValueOnce(old.promise); test.emit('settings/document-updated', 'llm-pi-ai', 8)
    test.changeSettings({ ...test.settings(), namespaces: test.settings().namespaces.map(item => ({ ...item, revision: 9 })) }); test.emit('settings/document-updated', 'llm-pi-ai', 9); await tick()
    old.resolve(good({ ...test.settings(), namespaces: [namespace('llm-pi-ai', { revision: 8 })] })); await tick(); expect(test.browser().source?.()[0]?.revision).toBe(9)
    test.describe.mockResolvedValueOnce(good({ ...test.settings(), namespaces: [namespace('llm-pi-ai', { revision: 6 })] })); test.emit('settings/document-updated', 'llm-pi-ai', 6); await tick(); expect(test.browser().source?.()[0]?.revision).toBe(9)
    test.describe.mockResolvedValueOnce(failed('background unavailable')); test.emit('settings/document-updated', 'llm-pi-ai', 10); await tick(); expect(test.browser().source?.()[0]?.revision).toBe(9)
    test.changeSettings({ ...test.settings(), writable: false }); expect(await test.act({ kind: 'submit', submission: test.endpointSubmission() })).toMatchObject({ kind: 'failed', message: 'Settings are read-only' })
    test.changeSettings({ ...test.settings(), writable: true, namespaces: [] }); expect(await test.act({ kind: 'submit', submission: test.endpointSubmission() })).toMatchObject({ kind: 'failed', message: 'Provider could not be added' })
    const conflict = fixture(); await conflict.openCustom(); conflict.mutate.mockResolvedValueOnce(failed('revision moved', 'settings/conflict')); expect(await conflict.act({ kind: 'submit', submission: conflict.endpointSubmission() })).toMatchObject({ kind: 'conflict' })
    conflict.mutate.mockRejectedValueOnce(new Error('native refused')); expect(await conflict.act({ kind: 'submit', submission: conflict.endpointSubmission() })).toMatchObject({ kind: 'failed', message: 'Provider could not be added' })
    const changed = fixture(); await changed.openCustom(); changed.setCredential.mockResolvedValueOnce(failed('credential unavailable')); await changed.act({ kind: 'submit', submission: changed.endpointSubmission() }); replaceProfile(changed, { ...changed.profile }, 8)
    expect(await changed.act({ kind: 'submit', submission: changed.endpointSubmission() })).toMatchObject({ kind: 'conflict', message: 'The created provider changed; reopen its configuration' })
  })

  it('fences setup reads, model metadata, saved profiles and credential/callback continuations', async () => {
    for (const stage of ['settings', 'write', 'key', 'created', 'metadata', 'failure'] as const) {
      const test = fixture(); await test.openCustom()
      const abort = new AbortController()
      let event: Record<string, unknown> = { kind: 'submit', submission: test.endpointSubmission() }
      if (stage === 'settings') test.describe.mockImplementationOnce(async () => { test.reconnect(); return good(test.settings()) })
      if (stage === 'write') test.mutate.mockImplementationOnce(async () => { abort.abort(); return good(namespace()) })
      if (stage === 'key') test.setCredential.mockImplementationOnce(async () => { abort.abort(); return good(undefined) })
      if (stage === 'created') test.created.mockImplementationOnce(async () => { abort.abort() })
      if (stage === 'metadata') { event = addModel('late'); mocks.metadata.mockImplementationOnce(async () => { abort.abort(); return undefined }) }
      if (stage === 'failure') test.mutate.mockImplementationOnce(async () => { abort.abort(); throw new Error('retired') })
      expect(await test.act(event, abort.signal)).toMatchObject({ kind: 'cancelled' })
    }
    const discovery = fixture(); await discovery.openCustom(); const metadata = deferred<unknown>(); mocks.metadata.mockReturnValueOnce(metadata.promise)
    await discovery.act({ kind: 'activate', actionId: 'next', inputs: discovery.endpointSubmission() }); await tick(); discovery.observe({ kind: 'value-change', controlId: 'key' }); metadata.resolve({ lookup: () => ({ contextWindow: 111 }) }); await tick(); expect(discovery.render()).not.toContain('111 tokens')
    const failure = fixture(); await failure.openCustom(); const native = deferred<unknown>(); failure.discover.mockReturnValueOnce(native.promise); await failure.act({ kind: 'activate', actionId: 'next', inputs: failure.endpointSubmission() }); failure.reconnect(); native.resolve(failed('retired')); await tick(); expect(failure.opened.at(-1)?.panel.closed).toBe(true)
    const missing = fixture(); await missing.openCustom(); expect(await missing.act({ kind: 'submit', submission: { source: [], forms: [] } })).toMatchObject({ kind: 'invalid' })
  })
})

describe('native authorization instruction and prompt ownership', () => {
  it('keeps URL/code instructions current and only copies data from the live authorization surface', async () => {
    const test = fixture()
    await test.controller.openAuthorize(test.client, 'oauth')
    expect(test.browser().isCurrent?.()).toBe(true)
    expect(await test.act({ kind: 'activate', actionId: 'copy-url' })).toMatchObject({ kind: 'failed', message: 'Authorization instructions are no longer available' })
    expect(await test.act({ kind: 'selection-accept', selectedIds: [] })).toMatchObject({ kind: 'completed' })
    let interaction!: RemoteAuthorizationInteraction
    const pending = deferred<'authorized' | 'cancelled'>()
    test.authorize.mockImplementationOnce(async (_client, _key, _method, value) => { interaction = value; return await pending.promise })
    const start = test.act({ kind: 'activate', actionId: 'start' })
    interaction.notice({ message: 'Initial instructions' }); expect(test.render()).toContain('Initial instructions')
    interaction.notice({ message: 'Browser instructions', url: 'https://auth.example/one', code: 'ONE' }); expect(test.render()).toContain('ONE')
    interaction.notice({ message: 'Waiting' }); expect(test.render()).toContain('https://auth.example/one'); expect(test.render()).toContain('ONE')
    expect(await test.act({ kind: 'activate', actionId: 'copy-url' })).toMatchObject({ kind: 'completed' }); expect(test.copy).toHaveBeenCalledWith('https://auth.example/one')
    interaction.notice({ message: 'New browser', url: 'https://auth.example/two' }); expect(test.render()).not.toContain('ONE')
    expect(await test.act({ kind: 'activate', actionId: 'copy-code' })).toMatchObject({ kind: 'failed' })
    test.copy.mockRejectedValueOnce(new Error('clipboard unavailable')); expect(await test.act({ kind: 'activate', actionId: 'copy-url' })).toMatchObject({ kind: 'failed', message: 'The link could not be copied — select it in the panel instead' })
    const copyAbort = new AbortController(); test.copy.mockImplementationOnce(async () => { copyAbort.abort(); throw new Error('retired caller copy') }); expect(await test.act({ kind: 'activate', actionId: 'copy-url' }, copyAbort.signal)).toMatchObject({ kind: 'cancelled' })
    expect(await test.act({ kind: 'activate', actionId: 'start' })).toMatchObject({ kind: 'completed' })
    const lateCopy = deferred<void>(); test.copy.mockReturnValueOnce(lateCopy.promise); const copying = test.act({ kind: 'activate', actionId: 'copy-url' })
    const lateError = Promise.withResolvers<void>(); test.copy.mockReturnValueOnce(lateError.promise); const failingCopy = test.act({ kind: 'activate', actionId: 'copy-url' })
    test.reconnect(); lateCopy.resolve(); lateError.reject(new Error('retired owner copy')); expect(await copying).toMatchObject({ kind: 'cancelled' }); expect(await failingCopy).toMatchObject({ kind: 'cancelled' })
    interaction.notice({ message: 'Retired instructions', url: 'https://retired.example' }); expect(await interaction.prompt({ kind: 'text', message: 'Retired prompt' })).toBeUndefined()
    pending.resolve('authorized'); expect(await start).toMatchObject({ kind: 'cancelled' }); expect(test.mutate).not.toHaveBeenCalled()
    expect(await test.act({ kind: 'activate', actionId: 'start' })).toMatchObject({ kind: 'cancelled' })
    const bare = fixture({ bare: true }); bare.authorize.mockImplementationOnce(async (_client, _key, _method, value) => { value.notice({ message: 'Copy manually', code: 'MANUAL' }); await value.prompt({ kind: 'text', message: 'Continue' }); return 'cancelled' })
    await bare.controller.openAuthorize(bare.client, 'oauth'); const bareStart = bare.act({ kind: 'activate', actionId: 'start' }); await tick()
    expect(await bare.act({ kind: 'activate', actionId: 'copy-code' }, undefined, 0)).toMatchObject({ kind: 'failed', message: 'The link could not be copied — select it in the panel instead' }); bare.opened[1]!.close(); await bareStart
  })

  it('acknowledges select/text answers exactly and ignores unrelated events and acknowledgements', async () => {
    const test = fixture()
    const replies: unknown[] = []
    test.authorize.mockImplementationOnce(async (_client, _key, _method, interaction) => {
      interaction.notice({ message: 'Choose native account', url: 'https://auth.example', code: 'CODE' })
      replies.push(await interaction.prompt({ kind: 'select', message: 'Choose', options: [{ id: 'one', label: 'One', description: 'First account' }] }))
      replies.push(await interaction.prompt({ kind: 'text', message: 'Enter token' }))
      return 'cancelled'
    })
    await test.controller.openAuthorize(test.client, 'oauth'); const started = test.act({ kind: 'activate', actionId: 'start' }, undefined, 0); await tick()
    expect(test.browser().isCurrent?.()).toBe(true); expect(test.render()).toContain('First account')
    expect(await test.act({ kind: 'activate', actionId: 'copy-url' })).toMatchObject({ kind: 'completed' })
    expect(await test.act({ kind: 'activate', actionId: 'copy-code' })).toMatchObject({ kind: 'completed' })
    expect(await test.act({ kind: 'activate', actionId: 'ignored' })).toMatchObject({ kind: 'completed' })
    expect(await test.act({ kind: 'submit', submission: { forms: [] } })).toMatchObject({ kind: 'completed' })
    expect(await test.act({ kind: 'selection-accept', selectedIds: ['one'] })).toMatchObject({ kind: 'accepted' })
    expect(test.render()).toContain('"selectedIds":["one"]')
    test.ack('unrelated'); test.ack(test.browser().id, 'other-operation'); expect(replies).toEqual([])
    for (const listener of test.registryListeners) listener({ kind: 'remove', id: test.browser().id })
    test.ack(test.browser().id); await tick(); expect(replies).toEqual([{ type: 'answer', value: 'one' }])
    expect(test.render()).toContain('"kind":"input"')
    const signal = new AbortController(); signal.abort(); expect(await test.act({ kind: 'activate', actionId: 'copy-url' }, signal.signal)).toMatchObject({ kind: 'cancelled' })
    expect(await test.act({ kind: 'selection-accept', selectedIds: [] })).toMatchObject({ kind: 'completed' })
    expect(await test.act({ kind: 'submit', submission: { forms: [{ formId: 'answer', fields: [{ id: 'answer', value: 'text reply' }] }] } })).toMatchObject({ kind: 'accepted' })
    test.ack(test.browser().id); await started
    expect(replies).toEqual([{ type: 'answer', value: 'one' }, { type: 'answer', value: 'text reply' }]); expect(test.registryListeners.size).toBe(0)
    const empty = fixture(); empty.authorize.mockImplementationOnce(async (_client, _key, _method, interaction) => { await interaction.prompt({ kind: 'select', message: 'No accounts' }); return 'cancelled' }); await empty.controller.openAuthorize(empty.client, 'oauth'); const emptyStart = empty.act({ kind: 'activate', actionId: 'start' }, undefined, 0); await tick(); expect(empty.render()).toContain('No authorization options'); empty.opened[1]!.close(); await emptyStart
  })

  it('retries only provider setup after native authorization succeeded and never repeats sign-in', async () => {
    const test = fixture()
    test.mutate.mockResolvedValueOnce(failed('profile write refused'))
    await test.controller.openAuthorize(test.client, 'oauth')
    expect(await test.act({ kind: 'activate', actionId: 'start' })).toMatchObject({ kind: 'failed', message: 'Signed in, but provider setup could not be completed' })
    expect(test.render()).toContain('Finish setup')
    expect(await test.act({ kind: 'activate', actionId: 'start' })).toMatchObject({ kind: 'accepted', feedback: { message: 'Authorization completed' } })
    expect(test.authorize).toHaveBeenCalledOnce(); expect(test.mutate).toHaveBeenCalledTimes(2)
    expect(await test.act({ kind: 'activate', actionId: 'start' })).toMatchObject({ kind: 'completed' })
    const failure = fixture(); failure.authorize.mockRejectedValueOnce(new Error('native authorization unavailable')); await failure.controller.openAuthorize(failure.client, 'oauth'); expect(await failure.act({ kind: 'activate', actionId: 'start' })).toMatchObject({ kind: 'failed', message: 'Authorization could not be completed' })
    const existing = fixture({ bare: true }); await existing.controller.openAuthorize(existing.client, 'deepseek'); expect(await existing.act({ kind: 'activate', actionId: 'start' })).toMatchObject({ kind: 'accepted' }); expect(existing.mutate).not.toHaveBeenCalled()
  })

  it('retires native authorization failures, setup reads and setup writes after caller or Host replacement', async () => {
    for (const stage of ['authorization', 'setup-read', 'setup-write', 'callback', 'failure'] as const) {
      const test = fixture(); await test.controller.openAuthorize(test.client, 'oauth')
      const abort = new AbortController()
      if (stage === 'authorization') test.authorize.mockImplementationOnce(async () => { abort.abort(); return 'authorized' })
      if (stage === 'setup-read') test.configurable.mockImplementationOnce(async () => { test.reconnect(); return good(test.configs) })
      if (stage === 'setup-write') test.mutate.mockImplementationOnce(async () => { test.reconnect(); return good(namespace()) })
      if (stage === 'callback') test.created.mockImplementationOnce(async () => { abort.abort() })
      if (stage === 'failure') test.authorize.mockImplementationOnce(async () => { abort.abort(); throw new Error('retired') })
      expect(await test.act({ kind: 'activate', actionId: 'start' }, abort.signal)).toMatchObject({ kind: 'cancelled' })
    }
    for (const mode of ['address', 'root', 'descriptor'] as const) {
      const test = fixture(); await test.controller.openAuthorize(test.client, 'oauth')
      if (mode === 'address') test.configurable.mockResolvedValueOnce(good([]))
      if (mode === 'root') test.configurable.mockResolvedValueOnce(good([{ provider: 'oauth', settingsNs: 'llm-pi-ai', settingsPath: [] }]))
      if (mode === 'descriptor') test.changeSettings({ ...test.settings(), namespaces: [] })
      expect(await test.act({ kind: 'activate', actionId: 'start' })).toMatchObject({ kind: 'failed', message: 'Signed in, but provider setup could not be completed' })
      expect(test.mutate).not.toHaveBeenCalled()
    }
  })

  it('releases ACK observers when a prompt is already closed during mounting', async () => {
    const test = fixture()
    test.authorize.mockImplementationOnce(async (_client, _key, _method, interaction) => { expect(await interaction.prompt({ kind: 'text', message: 'Closing prompt' })).toEqual({ type: 'decline' }); return 'cancelled' })
    await test.controller.openAuthorize(test.client, 'oauth')
    const nativeOpen = mocks.open.getMockImplementation()!
    mocks.open.mockImplementationOnce((context, options) => { const child = nativeOpen(context, options); child.close(); return child })
    expect(await test.act({ kind: 'activate', actionId: 'start' }, undefined, 0)).toMatchObject({ kind: 'accepted' })
    expect(test.registryListeners.size).toBe(0)
    test.dispose(); expect(test.registryListeners.size).toBe(0)
  })

  it('keeps the newest native prompt alive when an older prompt is independently declined', async () => {
    const test = fixture()
    const answers: unknown[] = []
    let interaction!: RemoteAuthorizationInteraction
    test.authorize.mockImplementationOnce(async (_client, _key, _method, value) => {
      interaction = value
      const first = value.prompt({ kind: 'text', message: 'First native question' })
      const second = value.prompt({ kind: 'text', message: 'Second native question' })
      answers.push(await first, await second)
      return 'cancelled'
    })
    await test.controller.openAuthorize(test.client, 'oauth'); const running = test.act({ kind: 'activate', actionId: 'start' }, undefined, 0); await tick()
    test.opened[1]!.close()
    interaction.notice({ message: 'Updated instructions' })
    expect(test.opened[2]!.refresh).toHaveBeenCalled(); expect(test.render(2)).toContain('Updated instructions')
    test.opened[2]!.close(); await running
    expect(answers).toEqual([{ type: 'decline' }, { type: 'decline' }]); expect(test.registryListeners.size).toBe(0)
  })
})
