/** Native provider creation through shared form and collection interactions.
 * @module @ephemeral-ai/mayfly/tests/interaction/provider-add
 */
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as uiProvider from '../../../ui/src/provider.ts'
import { ENDPOINT_PROTOCOLS, openProviderSetup } from '../../src/interaction/provider-add.ts'
import { deriveKeyRef, normalizeBaseURL, providerProfile } from '../../src/interaction/provider-profile.ts'
import { buildIndex, setModelsDevLoader } from '../../src/interaction/models-dev.ts'
import { providerFixture } from './provider-fixture.ts'

const contexts: Context[] = []
afterEach(async () => { setModelsDevLoader(undefined); for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const flush = () => new Promise<void>(resolve => { setImmediate(resolve) })
const address = (formId: string) => ({ pagePath: [{ controlId: 'provider-tabs', itemId: formId }], formId })

async function setup(
  discover = vi.fn().mockResolvedValue([{ id: 'one', contextWindow: 4000 }, { id: 'two' }]),
  listProviders = () => [] as { id: string, name: string }[],
) {
  const ctx = new Context()
  contexts.push(ctx)
  setModelsDevLoader(async () => undefined)
  const llm = {
    listProviders,
    listConfigurableProviders: () => [{ settingsNs: 'llm-deepseek', provider: 'deepseek-official', displayName: 'DeepSeek' }, { settingsNs: 'llm-pi-ai', provider: 'anthropic', displayName: 'Anthropic' }],
    discoverModels: discover,
  }
  const bench = await providerFixture(ctx, {}, llm)
  const created = vi.fn()
  openProviderSetup(ctx, created)
  const choose = async (kind: string) => {
    ctx.mayflyUiInteraction.get('overlay', 'mayfly.provider.add')!.emit({ kind: 'selection-accept', pagePath: [], controlId: 'provider-source', selectedIds: [kind] })
    await flush()
  }
  const custom = async () => {
    await choose('custom')
    const model = ctx.mayflyUiInteraction.get('overlay', 'mayfly.provider.add.custom')!
    model.edit({ ...address('connection'), fieldId: 'route' }, 'gateway')
    model.edit({ ...address('connection'), fieldId: 'baseURL' }, 'https://gateway.example/v1')
    model.edit({ ...address('credentials'), fieldId: 'key' }, 'private-key')
    await flush()
    return model
  }
  return { ...bench, discover, created, choose, custom }
}

const context = (entry: ReturnType<Context['mayflyOverlays']['list']>[number], actionSignal = new AbortController().signal) => ({
  surfaceId: entry.id, operationId: 'provider-add-test', source: entry.source, revision: entry.revision, signal: actionSignal, report: vi.fn(),
})

function submission(entry: ReturnType<Context['mayflyOverlays']['list']>[number], options: {
  route?: unknown
  key?: unknown
  baseURL?: unknown
  selectedIds?: readonly string[]
  source?: typeof entry.source
} = {}) {
  return {
    actionId: 'save', source: options.source ?? entry.source,
    forms: [
      { pagePath: address('connection').pagePath, formId: 'connection', fields: [
        { id: 'route', value: 'route' in options ? options.route : 'gateway', change: 'set' as const },
        { id: 'protocol', value: 'openai-completions', change: 'set' as const },
        { id: 'baseURL', value: 'baseURL' in options ? options.baseURL : 'https://gateway.example/v1', change: 'set' as const },
      ] },
      { pagePath: address('models').pagePath, formId: 'models', fields: [
        { id: 'context', value: null, change: 'unchanged' as const },
        { id: 'efforts', value: [], change: 'unchanged' as const },
      ] },
      { pagePath: address('credentials').pagePath, formId: 'credentials', fields: [
        { id: 'key', value: 'key' in options ? options.key : 'private-key', change: 'set' as const },
      ] },
    ],
    selections: [{ pagePath: address('models').pagePath, controlId: 'advertised-models', selectedIds: options.selectedIds ?? ['one'] }],
  }
}

async function customEntry(bench: Awaited<ReturnType<typeof setup>>) {
  await bench.choose('custom')
  return bench.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.provider.add.custom')!
}

describe('provider creation', () => {
  it('keeps the conventional credential reference and supported protocols', () => {
    expect(deriveKeyRef('my-gateway')).toBe('MY_GATEWAY_API_KEY')
    expect(deriveKeyRef('anthropic')).toBe('ANTHROPIC_API_KEY')
    expect(ENDPOINT_PROTOCOLS).toEqual(['anthropic-messages', 'openai-completions', 'openai-responses'])
    expect(normalizeBaseURL('anthropic-messages', 'https://api.example/v1/')).toBe('https://api.example')
    expect(normalizeBaseURL('openai-responses', 'https://api.example', 'https://api.example/v1')).toBe('https://api.example/v1')
    expect(normalizeBaseURL('openai-completions', 'https://api.example/')).toBe('https://api.example')
    for (const value of [null, 'invalid', {}, { providers: null }, { providers: 'invalid' }, { providers: {} }, { providers: { route: null } }, { providers: { route: 'invalid' } }]) {
      expect(providerProfile(value, 'route')).toBeUndefined()
    }
    expect(providerProfile({ providers: { route: { displayName: 'Route' } } }, 'route')).toEqual({ displayName: 'Route' })
  })

  it('uses the native pi-ai provider directory for known-vendor setup', async () => {
    const bench = await setup()
    await bench.choose('known')
    const picker = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.provider.add.known')!
    expect(picker.choice({ pagePath: [], controlId: 'providers' })!.definition.items.map(item => item.id)).toEqual(['anthropic'])
    picker.emit({ kind: 'selection-accept', pagePath: [], controlId: 'providers', selectedIds: ['anthropic'] })
    await flush()
    const model = bench.ctx.mayflyUiInteraction.get('overlay', `mayfly.provider.add.${Buffer.from('anthropic').toString('hex')}`)!
    model.edit({ ...address('credentials'), fieldId: 'key' }, 'vendor-key')
    expect(bench.settings.writes).toBe(0)
    model.invoke('save')
    model.invoke('save')
    await flush()
    expect(bench.settings.writes).toBe(1)
    expect(bench.settings.get('llm-pi-ai')).toEqual({ providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } } })
    expect(bench.credentials.values.get('ANTHROPIC_API_KEY')).toBe('vendor-key')
    expect(bench.created).toHaveBeenCalledOnce()
  })

  it('discovers without writing and saves the actual selected models with typed defaults', async () => {
    const bench = await setup()
    const model = await bench.custom()
    model.invoke('discover')
    await flush()
    expect(bench.discover).toHaveBeenCalledWith('llm-pi-ai', { api: 'openai-completions', baseURL: 'https://gateway.example/v1', apiKey: 'private-key' }, expect.any(AbortSignal))
    expect(bench.settings.writes).toBe(0)
    expect(model.form(address('credentials'))!.fields.key!.value).toBe('private-key')
    expect(model.activeTab({ pagePath: [], controlId: 'provider-tabs' })).toBe('models')
    model.invoke('save')
    await flush()
    expect(bench.settings.writes).toBe(0)
    model.updateChoice({ pagePath: address('models').pagePath, controlId: 'advertised-models' }, { kind: 'select', ids: ['one', 'two'] })
    model.edit({ ...address('models'), fieldId: 'context' }, '8000')
    model.edit({ ...address('models'), fieldId: 'efforts' }, ['high'])
    model.invoke('save')
    await flush()
    expect(bench.settings.get('llm-pi-ai')).toMatchObject({ providers: { gateway: { api: 'openai-completions', baseURL: 'https://gateway.example/v1', apiKeyEnv: 'GATEWAY_API_KEY', models: [
      { id: 'one', contextWindow: 4000, reasoningEfforts: { high: 'high' } }, { id: 'two', contextWindow: 8000, reasoningEfforts: { high: 'high' } },
    ] } } })
    expect(bench.credentials.values.get('GATEWAY_API_KEY')).toBe('private-key')
    expect(model.disposed).toBe(true)
  })

  it('retains input on discovery failure and redacts the key from provider errors', async () => {
    const bench = await setup(vi.fn().mockRejectedValue(new Error('Rejected private-key')))
    const model = await bench.custom()
    model.invoke('discover')
    await flush()
    expect(model.form(address('credentials'))!.fields.key!.value).toBe('private-key')
    expect(model.feedbackSnapshot().at(-1)?.message).toContain('[redacted]')
    expect(JSON.stringify(model.feedbackSnapshot())).not.toContain('private-key')
    expect(bench.settings.writes).toBe(0)
  })

  it('cancels a superseded discovery and prevents its late catalog from being published', async () => {
    const old = Promise.withResolvers<{ id: string }[]>()
    const discover = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue([{ id: 'new' }])
    const bench = await setup(discover)
    const model = await bench.custom()
    model.invoke('discover')
    await flush()
    const signal = discover.mock.calls[0]![2] as AbortSignal
    model.edit({ ...address('connection'), fieldId: 'baseURL' }, 'https://new.example/v1')
    expect(signal.aborted).toBe(true)
    await flush()
    model.invoke('discover')
    await flush()
    old.resolve([{ id: 'old' }])
    await flush()
    expect(model.choice({ pagePath: address('models').pagePath, controlId: 'advertised-models' })!.definition.items.map(item => item.id)).toEqual(['new'])
    expect(bench.settings.writes).toBe(0)
  })

  it('requires renewed discovery when its endpoint inputs change', async () => {
    const bench = await setup()
    const model = await bench.custom()
    model.invoke('discover')
    await flush()
    model.updateChoice({ pagePath: address('models').pagePath, controlId: 'advertised-models' }, { kind: 'select', ids: ['one'] })
    model.edit({ ...address('credentials'), fieldId: 'key' }, 'new-key')
    await flush()
    model.invoke('save')
    await flush()
    expect(bench.settings.writes).toBe(0)
    expect(model.choice({ pagePath: address('models').pagePath, controlId: 'advertised-models' })!.definition.items).toEqual([])
  })

  it('keeps the created profile after credential failure and retries only the unfinished write', async () => {
    const bench = await setup()
    const model = await bench.custom()
    model.invoke('discover')
    await flush()
    model.updateChoice({ pagePath: address('models').pagePath, controlId: 'advertised-models' }, { kind: 'select', ids: ['one'] })
    bench.credentials.failWrite = true
    model.invoke('save')
    await flush()
    expect(bench.settings.writes).toBe(1)
    expect(model.form(address('credentials'))!.fields.key!.value).toBe('private-key')
    expect(model.form(address('connection'))!.fields.route!.change).toBe('unchanged')
    expect(bench.created).not.toHaveBeenCalled()
    bench.credentials.failWrite = false
    model.invoke('save')
    await flush()
    expect(bench.settings.writes).toBe(1)
    expect(bench.credentials.values.get('GATEWAY_API_KEY')).toBe('private-key')
    expect(bench.created).toHaveBeenCalledOnce()
  })

  it('uses discovery fallback endpoints and protocol-specific stored URLs', async () => {
    const discover = vi.fn().mockRejectedValueOnce(new Error('unlisted')).mockResolvedValue([{ id: 'one' }])
    const bench = await setup(discover)
    const model = await bench.custom()
    model.edit({ ...address('connection'), fieldId: 'protocol' }, 'anthropic-messages')
    model.invoke('discover')
    await flush()
    expect(discover.mock.calls[0]![1].api).toBe('openai-completions')
    model.updateChoice({ pagePath: address('models').pagePath, controlId: 'advertised-models' }, { kind: 'select', ids: ['one'] })
    model.invoke('save')
    await flush()
    expect(bench.settings.get('llm-pi-ai')).toMatchObject({ providers: { gateway: { api: 'anthropic-messages', baseURL: 'https://gateway.example' } } })
  })

  it('uses catalog model facts before optional numeric and effort defaults', async () => {
    const bench = await setup()
    setModelsDevLoader(async () => buildIndex({ vendor: { models: { two: { limit: { context: 32000, output: 1000 }, reasoning: false } } } }))
    const model = await bench.custom()
    model.invoke('discover')
    await flush()
    model.updateChoice({ pagePath: address('models').pagePath, controlId: 'advertised-models' }, { kind: 'select', ids: ['two'] })
    model.edit({ ...address('models'), fieldId: 'context' }, '100')
    model.invoke('save')
    await flush()
    expect(bench.settings.get('llm-pi-ai')).toMatchObject({ providers: { gateway: { models: [{ id: 'two', contextWindow: 32000, maxTokens: 1000, reasoningEfforts: false }] } } })
  })

  it('rejects invalid routes and URLs and cannot overwrite an externally-created provider', async () => {
    const bench = await setup()
    const model = await bench.custom()
    model.edit({ ...address('connection'), fieldId: 'route' }, 'INVALID')
    model.invoke('discover')
    await flush()
    expect(bench.discover).not.toHaveBeenCalled()
    model.edit({ ...address('connection'), fieldId: 'route' }, 'gateway')
    model.edit({ ...address('connection'), fieldId: 'baseURL' }, 'file:///tmp/x')
    model.invoke('discover')
    await flush()
    expect(bench.discover).not.toHaveBeenCalled()
    model.edit({ ...address('connection'), fieldId: 'baseURL' }, 'https://valid.example')
    model.invoke('discover')
    await flush()
    model.updateChoice({ pagePath: address('models').pagePath, controlId: 'advertised-models' }, { kind: 'select', ids: ['one'] })
    await bench.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'gateway'], value: { displayName: 'External' } }])
    model.invoke('save')
    await flush()
    expect(bench.settings.get('llm-pi-ai')).toMatchObject({ providers: { gateway: { displayName: 'External' } } })
    expect(bench.credentials.writes).toBe(0)
  })

  it('requires all native services and focuses an existing source chooser', async () => {
    const incomplete: Context[] = []
    const fresh = () => { const ctx = new Context(); contexts.push(ctx); incomplete.push(ctx); return ctx }
    expect(() => openProviderSetup(fresh(), vi.fn())).toThrow('Provider setup requires settings, credentials, llm, and overlays')

    const withoutSettings = fresh()
    await withoutSettings.plugin(uiProvider)
    expect(() => openProviderSetup(withoutSettings, vi.fn())).toThrow('Provider setup requires settings, credentials, llm, and overlays')

    const withoutLlm = fresh()
    await withoutLlm.plugin(uiProvider)
    withoutLlm.provide('settings', {} as never)
    expect(() => openProviderSetup(withoutLlm, vi.fn())).toThrow('Provider setup requires settings, credentials, llm, and overlays')

    const withoutCredentials = fresh()
    await withoutCredentials.plugin(uiProvider)
    withoutCredentials.provide('settings', {} as never)
    withoutCredentials.provide('llm', {} as never)
    expect(() => openProviderSetup(withoutCredentials, vi.fn())).toThrow('Provider setup requires settings, credentials, llm, and overlays')

    const bench = await setup()
    const before = bench.ctx.mayflyOverlays.list()[0]!.focusRevision
    openProviderSetup(bench.ctx, bench.created)
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(1)
    expect(bench.ctx.mayflyOverlays.list()[0]!.focusRevision).toBeGreaterThan(before)
  })

  it('handles repeated pickers and defensive non-selection events', async () => {
    const bench = await setup(undefined, () => [{ id: 'active', name: 'Active' }])
    const source = bench.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.provider.add')!
    expect(await source.definition.onEvent!.action!(
      { kind: 'activate', pagePath: [], controlId: 'noop', actionId: 'noop' },
      context(source),
    )).toEqual({ kind: 'completed' })

    await bench.choose('known')
    const picker = bench.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.provider.add.known')!
    const focus = picker.focusRevision
    await bench.choose('known')
    expect(bench.ctx.mayflyOverlays.list().find(entry => entry.id === picker.id)!.focusRevision).toBeGreaterThan(focus)
    expect(await picker.definition.onEvent!.action!(
      { kind: 'activate', pagePath: [], controlId: 'noop', actionId: 'noop' },
      context(picker),
    )).toEqual({ kind: 'completed' })

    await bench.choose('custom')
    expect(() => source.definition.onEvent!.action!(
      { kind: 'selection-accept', pagePath: [], controlId: 'provider-source', selectedIds: ['custom'] },
      context(source),
    )).toThrow('Provider setup is already open')
    const endpoint = bench.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.provider.add.custom')!
    expect(await endpoint.definition.onEvent!.action!(
      { kind: 'activate', pagePath: [], controlId: 'noop', actionId: 'noop' },
      context(endpoint),
    )).toEqual({ kind: 'completed' })
  })

  it('reports empty discovery failures without exposing an absent key', async () => {
    const bench = await setup(vi.fn().mockRejectedValue(null))
    const entry = await customEntry(bench)
    const action = entry.definition.onEvent!.action!
    const missingRoute = await action(
      { kind: 'submit', submission: submission(entry, { route: null }) },
      context(entry),
    )
    expect(missingRoute).toMatchObject({ kind: 'invalid' })
    const failed = await action(
      { kind: 'activate', pagePath: [], controlId: 'provider-setup-actions', actionId: 'discover', inputs: submission(entry, { key: null }) },
      context(entry),
    )
    expect(failed).toEqual({ kind: 'failed', message: 'Model discovery failed' })
  })

  it('contains cancellation after catalog loading and both persistence boundaries', async () => {
    const catalog = Promise.withResolvers<ReturnType<typeof buildIndex>>()
    const load = vi.fn(() => catalog.promise)
    const discovery = await setup()
    setModelsDevLoader(load)
    const discoveryEntry = await customEntry(discovery)
    const discoveryAbort = new AbortController()
    const discoveryResult = discoveryEntry.definition.onEvent!.action!(
      { kind: 'activate', pagePath: [], controlId: 'provider-setup-actions', actionId: 'discover', inputs: submission(discoveryEntry) },
      context(discoveryEntry, discoveryAbort.signal),
    )
    await vi.waitFor(() => expect(load).toHaveBeenCalled())
    discoveryAbort.abort()
    catalog.resolve(buildIndex({}))
    expect(await discoveryResult).toEqual({ kind: 'cancelled' })

    setModelsDevLoader(async () => undefined)
    const afterSettings = await setup()
    const settingsEntry = await customEntry(afterSettings)
    const settingsGate = Promise.withResolvers<void>()
    const originalMutate = afterSettings.settings.mutate.bind(afterSettings.settings)
    const mutate = vi.spyOn(afterSettings.settings, 'mutate')
    mutate.mockImplementationOnce(async (...args) => { await settingsGate.promise; return originalMutate(...args) })
    const settingsAbort = new AbortController()
    const settingsResult = settingsEntry.definition.onEvent!.action!(
      { kind: 'submit', submission: submission(settingsEntry) },
      context(settingsEntry, settingsAbort.signal),
    )
    await vi.waitFor(() => expect(mutate).toHaveBeenCalled())
    settingsAbort.abort()
    settingsGate.resolve()
    expect(await settingsResult).toEqual({ kind: 'cancelled' })

    const afterCredential = await setup()
    const credentialEntry = await customEntry(afterCredential)
    const write = Promise.withResolvers<void>()
    vi.spyOn(afterCredential.credentials, 'set').mockReturnValueOnce(write.promise)
    const credentialAbort = new AbortController()
    const credentialResult = credentialEntry.definition.onEvent!.action!(
      { kind: 'submit', submission: submission(credentialEntry) },
      context(credentialEntry, credentialAbort.signal),
    )
    await vi.waitFor(() => expect(afterCredential.credentials.set).toHaveBeenCalled())
    credentialAbort.abort()
    write.resolve()
    expect(await credentialResult).toEqual({ kind: 'cancelled' })
  })

  it('maps write conflicts, failures, and aborted failures before creation', async () => {
    const cases = [
      { error: new SettingsConflictError('llm-pi-ai' as never, 0, 1), expected: 'conflict' },
      { error: new Error('disk failed'), expected: 'failed' },
    ] as const
    for (const item of cases) {
      const bench = await setup()
      const entry = await customEntry(bench)
      vi.spyOn(bench.settings, 'mutate').mockRejectedValueOnce(item.error)
      expect(await entry.definition.onEvent!.action!(
        { kind: 'submit', submission: submission(entry) },
        context(entry),
      )).toMatchObject({ kind: item.expected })
    }

    const bench = await setup()
    const entry = await customEntry(bench)
    const failure = Promise.withResolvers<never>()
    vi.spyOn(bench.settings, 'mutate').mockReturnValueOnce(failure.promise)
    const abort = new AbortController()
    const result = entry.definition.onEvent!.action!(
      { kind: 'submit', submission: submission(entry) },
      context(entry, abort.signal),
    )
    abort.abort()
    failure.reject(new Error('cancelled write'))
    expect(await result).toEqual({ kind: 'cancelled' })
  })

  it('rejects stale source stamps and changed partial creations', async () => {
    const stale = await setup()
    const staleEntry = await customEntry(stale)
    const missing = await staleEntry.definition.onEvent!.action!(
      { kind: 'submit', submission: submission(staleEntry, { source: [] }) },
      context(staleEntry),
    )
    expect(missing).toMatchObject({ kind: 'conflict' })
    const old = await staleEntry.definition.onEvent!.action!(
      { kind: 'submit', submission: submission(staleEntry, { source: [{ resourceId: 'llm-pi-ai', revision: -1 }] }) },
      context(staleEntry),
    )
    expect(old).toMatchObject({ kind: 'conflict' })

    const changed = await setup()
    const model = await changed.custom()
    model.invoke('discover')
    await flush()
    model.updateChoice({ pagePath: address('models').pagePath, controlId: 'advertised-models' }, { kind: 'select', ids: ['one'] })
    changed.credentials.failWrite = true
    model.invoke('save')
    await flush()
    const entry = changed.ctx.mayflyOverlays.list().find(item => item.id === 'mayfly.provider.add.custom')!
    const routeChanged = await entry.definition.onEvent!.action!(
      { kind: 'submit', submission: submission(entry, { route: 'other' }) },
      context(entry),
    )
    expect(routeChanged).toMatchObject({ kind: 'conflict' })
    await changed.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'gateway', 'displayName'], value: 'External' }])
    const profileChanged = await entry.definition.onEvent!.action!(
      { kind: 'submit', submission: submission(changed.ctx.mayflyOverlays.list().find(item => item.id === entry.id)!) },
      context(changed.ctx.mayflyOverlays.list().find(item => item.id === entry.id)!),
    )
    expect(profileChanged).toMatchObject({ kind: 'conflict' })
  })

  it('uses catalog effort metadata and tolerates a forged missing model fact', async () => {
    const bench = await setup()
    setModelsDevLoader(async () => buildIndex({ vendor: { models: { one: { reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] } } } }))
    const model = await bench.custom()
    model.invoke('discover')
    await flush()
    model.updateChoice({ pagePath: address('models').pagePath, controlId: 'advertised-models' }, { kind: 'select', ids: ['one'] })
    model.invoke('save')
    await flush()
    expect(bench.settings.get('llm-pi-ai')).toMatchObject({ providers: { gateway: { models: [{ id: 'one', reasoningEfforts: { low: 'low', high: 'high' } }] } } })

    const forged = await setup()
    const entry = await customEntry(forged)
    expect(await entry.definition.onEvent!.action!(
      { kind: 'submit', submission: submission(entry, { selectedIds: ['missing'] }) },
      context(entry),
    )).toMatchObject({ kind: 'accepted' })
    expect(forged.settings.get('llm-pi-ai')).toMatchObject({ providers: { gateway: { models: [{ id: 'missing' }] } } })
  })

  it('contains matching observations after the endpoint closes', async () => {
    const bench = await setup()
    const model = await bench.custom()
    model.invoke('discover')
    await flush()
    const entry = bench.ctx.mayflyOverlays.list().find(item => item.id === 'mayfly.provider.add.custom')!
    const observe = entry.definition.onEvent!.observe!
    entry.definition.onEvent!.observe!({ kind: 'selection-toggle', pagePath: [], controlId: 'noop', selectedIds: [] }, context(entry))
    bench.ctx.mayflyOverlays.close(entry.id)
    observe({ kind: 'value-change', pagePath: address('connection').pagePath, controlId: 'baseURL', value: 'https://late.example' }, context(entry))
    expect(bench.ctx.mayflyOverlays.list().some(item => item.id === entry.id)).toBe(false)
  })

  it('lists OAuth providers and completes their native authorization setup', async () => {
    const bench = await setup(undefined, () => [{ id: 'active', name: 'Active' }])
    await bench.ctx.plugin(AuthorizationService)
    const register = (namespace: string, route: string, methods: { id: string, label: string }[]) => {
      const key = credentialKey(namespace, route)
      bench.ctx.authorization.registerFlow({
        key, label: route, methods,
        run: async () => { await bench.credentials.modifyRecord(key, async () => ({ kind: 'api-key', key: `${route}-token` })) },
      })
    }
    register('llm-pi-ai', 'oauth-provider', [{ id: 'oauth', label: 'OAuth' }])
    register('llm-pi-ai', 'active', [{ id: 'oauth', label: 'OAuth' }])
    register('other', 'foreign', [{ id: 'oauth', label: 'OAuth' }])
    register('llm-pi-ai', 'api-key-only', [{ id: 'api-key', label: 'API key' }])

    await bench.choose('oauth')
    const picker = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.provider.add.oauth')!
    expect(JSON.stringify(picker.node)).toContain('oauth-provider')
    expect(JSON.stringify(picker.node)).not.toMatch(/active|foreign|api-key-only/)
    picker.emit({ kind: 'selection-accept', pagePath: [], controlId: 'providers', selectedIds: ['oauth-provider'] })
    await flush()
    const authorization = bench.ctx.mayflyUiInteraction.list('overlay').find(model => model.id.startsWith('mayfly.authorization.'))!
    authorization.invoke('start')
    await flush()
    expect(bench.settings.get('llm-pi-ai')).toMatchObject({ providers: { 'oauth-provider': {} } })
    expect(bench.created).toHaveBeenCalledWith('oauth-provider')

    bench.ctx.mayflyOverlays.close(authorization.id)
    picker.emit({ kind: 'selection-accept', pagePath: [], controlId: 'providers', selectedIds: ['oauth-provider'] })
    await flush()
    const repeated = bench.ctx.mayflyUiInteraction.list('overlay').find(model => model.id.startsWith('mayfly.authorization.'))!
    repeated.invoke('start')
    await flush()
    expect(bench.created).toHaveBeenCalledTimes(2)
  })

  it('shows an empty OAuth picker when authorization is unavailable', async () => {
    const bench = await setup()
    await bench.choose('oauth')
    expect(JSON.stringify(bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.provider.add.oauth')!.node)).toContain('No providers available')
  })
})
