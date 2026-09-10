/** Native provider path writes and credential settlement from the shared editor surface.
 * @module @ephemeral-ai/mayfly/tests/interaction/provider-edit
 */
import { Context } from '@deepseek-ai/cordis'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as uiProvider from '../../../ui/src/provider.ts'
import type { MayflyOverlayEntry } from '../../../ui/src/contracts.ts'
import { providerFixture } from './provider-fixture.ts'
import { openProviderEditor } from '../../src/interaction/provider-edit.ts'
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const flush = () => new Promise<void>(resolve => { setImmediate(resolve) })
const address = (itemId: string) => ({ pagePath: [{ controlId: 'provider-pages', itemId }], formId: 'provider' })
const profile = { displayName: 'Original', api: 'openai-completions', baseURL: 'https://old.example/v1', apiKeyEnv: 'CUSTOM_KEY', models: [{ id: 'one', contextWindow: 4000 }], headers: { untouched: 'value' } }

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  const bench = await providerFixture(ctx, { custom: profile })
  await bench.commands.entries.get('provider')!.handler({ rawInput: 'edit custom', signal: new AbortController().signal } as never)
  const entry = ctx.mayflyOverlays.list()[0]!
  const model = ctx.mayflyUiInteraction.get('overlay', entry.id)!
  expect(entry.definition.presentation).toBe('editor')
  return { ...bench, model }
}

const requestContext = (entry: MayflyOverlayEntry, actionSignal = new AbortController().signal, source = entry.source) => ({
  surfaceId: entry.id, operationId: 'provider-edit-test', source, revision: entry.revision, signal: actionSignal, report: vi.fn(),
})

function saveSubmission(entry: MayflyOverlayEntry, options: {
  source?: typeof entry.source
  name?: unknown
  includeName?: boolean
  baseURL?: unknown
  key?: unknown
  extraFields?: readonly { id: string, value: unknown, change: 'set' | 'unchanged', pagePath?: readonly { controlId: string, itemId: string }[] }[]
} = {}) {
  return {
    actionId: 'save', source: options.source ?? entry.source,
    forms: [
      { pagePath: address('connection').pagePath, formId: 'provider', fields: [
        ...(options.includeName === false ? [] : [{ id: 'name', value: 'name' in options ? options.name : 'Changed', change: 'set' as const }]),
        ...('baseURL' in options ? [{ id: 'baseURL', value: options.baseURL, change: 'set' as const }] : []),
        ...(options.extraFields ?? []).map(field => ({ id: field.id, value: field.value, change: field.change })),
      ] },
      { pagePath: address('credentials').pagePath, formId: 'provider', fields: 'key' in options ? [{ id: 'key', value: options.key, change: 'set' as const }] : [] },
    ],
  }
}

async function directSetup(options: {
  profiles?: Record<string, unknown>
  llm?: unknown
  signal?: AbortSignal
  route?: string
} = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const bench = await providerFixture(ctx, options.profiles ?? { custom: profile }, options.llm)
  const route = options.route ?? 'custom'
  const opened = await openProviderEditor(ctx, route, options.signal)
  const entry = ctx.mayflyOverlays.list().find(item => item.id === `mayfly.provider.${Buffer.from(route).toString('hex')}`)
  return { ...bench, opened, entry, model: entry === undefined ? undefined : ctx.mayflyUiInteraction.get('overlay', entry.id) }
}

describe('provider editor', () => {
  it('discovers endpoint models and saves the selected set while retaining stored metadata', async () => {
    const discover = vi.fn(async () => [{ id: 'one', name: 'One' }, { id: 'loaded', name: 'Loaded' }])
    const bench = await directSetup({ llm: { listConfigurableProviders: () => [], discoverModels: discover } })
    expect(discover).toHaveBeenCalledWith('llm-pi-ai', expect.objectContaining({ provider: 'custom', baseURL: 'https://old.example/v1' }), expect.anything())
    expect(JSON.stringify(bench.entry?.node)).toContain('loaded')
    bench.model!.updateChoice({ pagePath: address('models').pagePath, controlId: 'advertised-models' }, { kind: 'select', ids: ['one', 'loaded'] })
    bench.model!.invoke('save')
    await flush()
    expect(bench.settings.get('llm-pi-ai')).toMatchObject({ providers: { custom: { models: [{ id: 'one', contextWindow: 4000 }, { id: 'loaded' }] } } })
  })

  it('keeps stored configuration editable when endpoint discovery fails', async () => {
    const discover = vi.fn(async () => { throw new Error('endpoint unreachable') })
    const bench = await directSetup({ llm: { listConfigurableProviders: () => [], discoverModels: discover } })
    expect(bench.opened).toBe(true)
    expect(JSON.stringify(bench.entry?.node)).toContain('one')
  })

  it('falls through listing bases when the first endpoint path refuses', async () => {
    const discover = vi.fn(async (_ns: string, request: { readonly baseURL?: string }) =>
      request.baseURL === 'https://old.example/v1' ? [] : [{ id: 'fallback' }])
    const bench = await directSetup({ llm: { listConfigurableProviders: () => [], discoverModels: discover } })
    expect(discover).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(bench.entry?.node)).toContain('fallback')
  })

  it('discovers catalog models for a route without a base URL', async () => {
    const discover = vi.fn(async () => [{ id: 'catalog' }])
    const bench = await directSetup({ profiles: { custom: { apiKeyEnv: 'CUSTOM_KEY', models: [{ id: 'one' }] } }, llm: { listConfigurableProviders: () => [], discoverModels: discover } })
    expect(discover).toHaveBeenCalledWith('llm-pi-ai', { provider: 'custom', api: 'openai-completions' }, expect.anything())
    expect(JSON.stringify(bench.entry?.node)).toContain('catalog')
  })

  it('stages a custom model from the form and writes it with the next save', async () => {
    const bench = await directSetup()
    const entry = bench.entry!
    const action = entry.definition.onEvent!.action!
    const added = await action({ kind: 'submit', submission: {
      actionId: 'add-custom-model', source: entry.source,
      forms: [{ pagePath: address('models').pagePath, formId: 'provider', fields: [
        { id: 'custom-model-id', value: 'custom-x', change: 'set' as const },
        { id: 'custom-context', value: 8192, change: 'set' as const },
        { id: 'custom-efforts', value: ['low', 'high'], change: 'set' as const },
      ] }],
    } }, requestContext(entry))
    expect(added).toMatchObject({ kind: 'accepted', feedback: { message: 'Model "custom-x" added' } })
    expect(JSON.stringify((added as { node?: unknown }).node)).toContain('custom-x')
    expect(bench.settings.get('llm-pi-ai')).toMatchObject({ providers: { custom: { models: [{ id: 'one', contextWindow: 4000 }] } } })

    expect(await action({ kind: 'submit', submission: {
      actionId: 'save', source: entry.source, forms: [],
      selections: [{ pagePath: address('models').pagePath, controlId: 'advertised-models', selectedIds: ['one', 'custom-x'] }],
    } }, requestContext(entry))).toMatchObject({ kind: 'accepted' })
    expect(bench.settings.get('llm-pi-ai')).toMatchObject({ providers: { custom: { models: [
      { id: 'one', contextWindow: 4000 },
      { id: 'custom-x', contextWindow: 8192, reasoningEfforts: { low: 'low', high: 'high' } },
    ] } } })
  })

  it('rejects a custom model with a blank id', async () => {
    const bench = await directSetup()
    const entry = bench.entry!
    expect(await entry.definition.onEvent!.action!({ kind: 'submit', submission: {
      actionId: 'add-custom-model', source: entry.source,
      forms: [{ pagePath: address('models').pagePath, formId: 'provider', fields: [] }],
    } }, requestContext(entry))).toMatchObject({ kind: 'invalid', errors: [expect.objectContaining({ fieldId: 'custom-model-id' })] })
  })

  it('stages a hand-added model with only an id', async () => {
    const bench = await directSetup()
    const entry = bench.entry!
    const action = entry.definition.onEvent!.action!
    expect(await action({ kind: 'submit', submission: {
      actionId: 'add-custom-model', source: entry.source,
      forms: [{ pagePath: address('models').pagePath, formId: 'provider', fields: [{ id: 'custom-model-id', value: 'solo', change: 'set' as const }] }],
    } }, requestContext(entry))).toMatchObject({ kind: 'accepted' })
    expect(await action({ kind: 'submit', submission: {
      actionId: 'save', source: entry.source, forms: [],
      selections: [{ pagePath: address('models').pagePath, controlId: 'advertised-models', selectedIds: ['one', 'solo'] }],
    } }, requestContext(entry))).toMatchObject({ kind: 'accepted' })
    expect(bench.settings.get('llm-pi-ai')).toMatchObject({ providers: { custom: { models: [{ id: 'one', contextWindow: 4000 }, { id: 'solo' }] } } })
  })

  it('saves and clears the route default thinking effort', async () => {
    const bench = await directSetup()
    const entry = bench.entry!
    const action = entry.definition.onEvent!.action!
    const effort = (value: string) => ({ actionId: 'save', source: entry.source, forms: [{ pagePath: address('models').pagePath, formId: 'provider', fields: [{ id: 'reasoning', value, change: 'set' as const }] }] })
    expect(await action({ kind: 'submit', submission: effort('high') }, requestContext(entry))).toMatchObject({ kind: 'accepted' })
    expect(bench.settings.get('llm-pi-ai')).toMatchObject({ providers: { custom: { reasoning: 'high' } } })
    const current = bench.ctx.mayflyOverlays.list().find(item => item.id === entry.id)!
    expect(await current.definition.onEvent!.action!({ kind: 'submit', submission: { actionId: 'save', source: current.source, forms: [{ pagePath: address('models').pagePath, formId: 'provider', fields: [{ id: 'reasoning', value: 'default', change: 'set' as const }] }] } }, requestContext(current))).toMatchObject({ kind: 'accepted' })
    expect((bench.settings.get('llm-pi-ai') as { providers: { custom: Record<string, unknown> } }).providers.custom.reasoning).toBeUndefined()
  })

  it('writes a discovery selection for a profile with no stored models', async () => {
    const discover = vi.fn(async () => [{ id: 'solo', contextWindow: 64000, maxTokens: 4096 }])
    const bench = await directSetup({ profiles: { custom: { apiKeyEnv: 'CUSTOM_KEY' } }, llm: { listConfigurableProviders: () => [], discoverModels: discover } })
    const entry = bench.entry!
    expect(JSON.stringify(entry.node)).toContain('solo')
    expect(await entry.definition.onEvent!.action!({ kind: 'submit', submission: { actionId: 'save', source: entry.source, forms: [], selections: [{ pagePath: address('models').pagePath, controlId: 'advertised-models', selectedIds: ['solo'] }] } }, requestContext(entry))).toMatchObject({ kind: 'accepted' })
    expect(bench.settings.get('llm-pi-ai')).toMatchObject({ providers: { custom: { models: [{ id: 'solo', contextWindow: 64000, maxTokens: 4096 }] } } })
  })

  it('keeps string stored model ids and folds in discovered and hand-added facts', async () => {
    const discover = vi.fn(async () => [{ id: 'named', contextWindow: 128000 }])
    const bench = await directSetup({
      profiles: { custom: { apiKeyEnv: 'CUSTOM_KEY', models: [{ contextWindow: 4000 }, { id: 'named', maxTokens: 2048 }] } },
      llm: { listConfigurableProviders: () => [], discoverModels: discover },
    })
    const entry = bench.entry!
    expect(JSON.stringify(entry.node)).toContain('named')
    expect(await entry.definition.onEvent!.action!({ kind: 'submit', submission: { actionId: 'save', source: entry.source, forms: [], selections: [{ pagePath: address('models').pagePath, controlId: 'advertised-models', selectedIds: ['named', 'extra'] }] } }, requestContext(entry))).toMatchObject({ kind: 'accepted' })
    expect(bench.settings.get('llm-pi-ai')).toMatchObject({ providers: { custom: { models: [
      { id: 'named', contextWindow: 128000, maxTokens: 2048 },
      { id: 'extra' },
    ] } } })
  })

  it('opens without app, skills, theme, or renderer and writes only changed native paths', async () => {
    const { ctx, model, settings, credentials } = await setup()
    expect(ctx.get('mayflyCurrentAgent')).toBeUndefined()
    expect(ctx.get('mayflyScreen')).toBeUndefined()
    const before = settings.writes
    model.edit({ ...address('connection'), fieldId: 'name' }, 'Renamed')
    model.edit({ ...address('credentials'), fieldId: 'key' }, 'new-secret')
    expect(JSON.stringify(ctx.mayflyOverlays.list()[0]!.node)).not.toContain('stored-secret')
    model.invoke('save')
    model.invoke('save')
    await flush()
    expect(settings.writes).toBe(before + 1)
    expect(credentials.values.get('CUSTOM_KEY')).toBe('new-secret')
    expect(settings.get('llm-pi-ai')).toMatchObject({ providers: { custom: { displayName: 'Renamed', models: [{ id: 'one', contextWindow: 4000 }], headers: { untouched: 'value' }, apiKeyEnv: 'CUSTOM_KEY' } } })
    expect(model.dirty).toBe(false)
    expect(model.form(address('credentials'))!.fields.key!.value).toBe('')
  })

  it('acknowledges the settings portion of a failed credential save and retries only the credential', async () => {
    const { model, settings, credentials } = await setup()
    const before = settings.writes
    credentials.failWrite = true
    model.edit({ ...address('connection'), fieldId: 'name' }, 'Renamed')
    model.edit({ ...address('credentials'), fieldId: 'key' }, 'retry-secret')
    model.invoke('save')
    await flush()
    expect(model.form(address('connection'))!.fields.name).toMatchObject({ value: 'Renamed', change: 'unchanged', conflict: false })
    expect(model.form(address('credentials'))!.fields.key).toMatchObject({ value: 'retry-secret', change: 'set' })
    expect(model.feedbackSnapshot().at(-1)?.message).toContain('settings saved')
    credentials.failWrite = false
    model.invoke('save')
    await flush()
    expect(settings.writes).toBe(before + 1)
    expect(credentials.values.get('CUSTOM_KEY')).toBe('retry-secret')
    expect(model.dirty).toBe(false)
    expect(model.feedbackSnapshot().every(item => item.severity !== 'error')).toBe(true)
  })

  it('retains drafts through refresh conflicts and repeat command entry', async () => {
    const { ctx, model, settings } = await setup()
    model.edit({ ...address('connection'), fieldId: 'name' }, 'Draft')
    expect(await openProviderEditor(ctx, 'custom')).toBe(true)
    expect(ctx.mayflyUiInteraction.list()).toContain(model)
    await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'custom', 'displayName'], value: 'External' }])
    await flush()
    expect(model.form(address('connection'))!.fields.name).toMatchObject({ value: 'Draft', conflict: true })
    const before = settings.writes
    model.invoke('save')
    await flush()
    expect(settings.writes).toBe(before)
  })

  it('preserves the original credential reference when deleting and returns from No unchanged', async () => {
    const { model, credentials, settings } = await setup()
    model.invoke('delete')
    model.answerDecision(false)
    expect(credentials.values.has('CUSTOM_KEY')).toBe(true)
    model.invoke('delete')
    model.answerDecision(true)
    await flush()
    expect(settings.get('llm-pi-ai')).toMatchObject({ providers: {} })
    expect(credentials.values.has('CUSTOM_KEY')).toBe(false)
    expect(model.form(address('credentials'))).toBeUndefined()
  })

  it('returns false for incomplete services and opens without a caller signal', async () => {
    const empty = new Context()
    contexts.push(empty)
    expect(await openProviderEditor(empty, 'custom')).toBe(false)

    const withoutCredentials = new Context()
    contexts.push(withoutCredentials)
    await withoutCredentials.plugin(uiProvider)
    withoutCredentials.provide('settings', {} as never)
    expect(await openProviderEditor(withoutCredentials, 'custom')).toBe(false)

    const withoutOverlays = new Context()
    contexts.push(withoutOverlays)
    withoutOverlays.provide('settings', {} as never)
    withoutOverlays.provide('credentials', {} as never)
    expect(await openProviderEditor(withoutOverlays, 'custom')).toBe(false)

    const bench = await directSetup()
    expect(bench.opened).toBe(true)
    expect(bench.entry).toBeDefined()
  })

  it('fails loudly when the namespace disappears or keeps changing while loading', async () => {
    const missing = new Context()
    contexts.push(missing)
    const missingBench = await providerFixture(missing, { custom: profile })
    await missingBench.namespace.dispose()
    await expect(openProviderEditor(missing, 'custom')).rejects.toThrow('Provider settings are unavailable')

    const changing = new Context()
    contexts.push(changing)
    const changingBench = await providerFixture(changing, { custom: profile })
    const describe = changingBench.settings.describe.bind(changingBench.settings)
    let revision = 0
    vi.spyOn(changingBench.settings, 'describe').mockImplementation(() => describe().map(item => ({ ...item, revision: revision++ })))
    await expect(openProviderEditor(changing, 'custom')).rejects.toThrow('Provider changed while loading')
  })

  it('renders fallback fields, known providers, read-only state, and unconfigured credentials', async () => {
    const fallback = await directSetup({ profiles: { custom: { apiKeyEnv: 'MISSING_KEY' } } })
    expect(JSON.stringify(fallback.entry!.node)).toContain('Not configured')
    expect(JSON.stringify(fallback.entry!.node)).toContain('"value":"custom"')
    expect(JSON.stringify(fallback.entry!.node)).toContain('"id":"baseURL"')

    const known = await directSetup({
      llm: { listConfigurableProviders: () => [{ settingsNs: 'llm-pi-ai', provider: 'custom' }] },
    })
    expect(JSON.stringify(known.entry!.node)).not.toContain('"id":"baseURL"')

    const readonly = new Context()
    contexts.push(readonly)
    const readonlyBench = await providerFixture(readonly, { custom: profile })
    Object.defineProperty(readonlyBench.settings, 'writable', { value: false })
    vi.spyOn(readonlyBench.credentials, 'describe').mockResolvedValue({ configured: false, writable: false, source: 'environment' })
    expect(await openProviderEditor(readonly, 'custom')).toBe(true)
    const node = JSON.stringify(readonly.mayflyOverlays.list()[0]!.node)
    expect(node).toContain('"disabled":true')
    expect(node).toContain('Not configured')
  })

  it('focuses a concurrently opened editor after its initial read', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const bench = await providerFixture(ctx, { custom: profile })
    const original = bench.credentials.describe.bind(bench.credentials)
    const firstRead = Promise.withResolvers<Awaited<ReturnType<typeof original>>>()
    vi.spyOn(bench.credentials, 'describe').mockReturnValueOnce(firstRead.promise).mockImplementation(original)
    const first = openProviderEditor(ctx, 'custom')
    await vi.waitFor(() => expect(bench.credentials.describe).toHaveBeenCalledOnce())
    expect(await openProviderEditor(ctx, 'custom')).toBe(true)
    firstRead.resolve(await original('CUSTOM_KEY' as never))
    expect(await first).toBe(true)
    expect(ctx.mayflyOverlays.list()).toHaveLength(1)
    expect(ctx.mayflyOverlays.list()[0]!.focusRevision).toBe(1)
  })

  it('reprojects changed credential references and removed profiles', async () => {
    const changed = await directSetup()
    await changed.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'custom', 'apiKeyEnv'], value: 'OTHER_KEY' }])
    await flush()
    const changedEntry = changed.ctx.mayflyOverlays.list().find(item => item.id === changed.entry!.id)!
    expect(changedEntry.update.reason).toBe('replace')
    expect(JSON.stringify(changedEntry.node)).toContain('credential reference changed')

    const removed = await directSetup()
    await removed.settings.mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', 'custom'] }])
    await flush()
    expect(JSON.stringify(removed.ctx.mayflyOverlays.list()[0]!.node)).toContain('no longer available')
  })

  it('ignores unrelated native events and stale refresh generations', async () => {
    const bench = await directSetup()
    await flush()
    const startRevision = bench.ctx.mayflyOverlays.list()[0]!.revision
    bench.ctx.emit('settings/document-updated', 'other' as never)
    bench.ctx.emit('settings/updated', 'other' as never)
    bench.ctx.emit('credentials/reference-updated', 'OTHER_KEY' as never)
    await flush()
    expect(bench.ctx.mayflyOverlays.list()[0]!.revision).toBe(startRevision)

    const first = Promise.withResolvers<{ configured: boolean, writable: boolean, source: string }>()
    const second = Promise.withResolvers<{ configured: boolean, writable: boolean, source: string }>()
    vi.spyOn(bench.credentials, 'describe').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    bench.ctx.emit('settings/updated', 'llm-pi-ai' as never)
    bench.ctx.emit('settings/document-updated', 'llm-pi-ai' as never)
    second.resolve({ configured: true, writable: true, source: 'memory' })
    await flush()
    const freshRevision = bench.ctx.mayflyOverlays.list()[0]!.revision
    first.resolve({ configured: true, writable: true, source: 'memory' })
    await flush()
    expect(bench.ctx.mayflyOverlays.list()[0]!.revision).toBe(freshRevision)
  })

  it('returns false for a missing profile and defends every stale action boundary', async () => {
    const missing = await directSetup({ profiles: {} })
    expect(missing.opened).toBe(false)

    const bench = await directSetup()
    const entry = bench.entry!
    const action = entry.definition.onEvent!.action!
    expect(await action(
      { kind: 'selection-accept', pagePath: [], controlId: 'noop', selectedIds: ['noop'] },
      requestContext(entry),
    )).toEqual({ kind: 'completed' })

    const preAborted = new AbortController()
    preAborted.abort()
    expect(await action(
      { kind: 'activate', pagePath: [], controlId: 'provider-actions', actionId: 'noop' },
      requestContext(entry, preAborted.signal),
    )).toEqual({ kind: 'cancelled' })

    const ownerAbort = new AbortController()
    const owned = await directSetup({ signal: ownerAbort.signal })
    const ownedAction = owned.entry!.definition.onEvent!.action!
    ownerAbort.abort()
    expect(await ownedAction(
      { kind: 'activate', pagePath: [], controlId: 'provider-actions', actionId: 'noop' },
      requestContext(owned.entry!),
    )).toEqual({ kind: 'cancelled' })

    expect(await action(
      { kind: 'activate', pagePath: [], controlId: 'provider-actions', actionId: 'noop' },
      requestContext(entry),
    )).toEqual({ kind: 'completed' })

    expect(await action(
      { kind: 'submit', submission: saveSubmission(entry, { source: [] }) },
      requestContext(entry),
    )).toMatchObject({ kind: 'conflict' })
    expect(await action(
      { kind: 'submit', submission: saveSubmission(entry, { source: [{ resourceId: 'llm-pi-ai', revision: -1 }, { resourceId: 'credential-observation', revision: 0 }] }) },
      requestContext(entry),
    )).toMatchObject({ kind: 'conflict' })

    await bench.settings.mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', 'custom'] }])
    expect(await action(
      { kind: 'activate', pagePath: [], controlId: 'provider-actions', actionId: 'noop' },
      requestContext(entry, undefined, bench.ctx.mayflyOverlays.list()[0]!.source),
    )).toMatchObject({ kind: 'conflict' })

    const changed = await directSetup()
    const changedAction = changed.entry!.definition.onEvent!.action!
    await changed.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'custom', 'apiKeyEnv'], value: 'OTHER_KEY' }])
    expect(await changedAction(
      { kind: 'activate', pagePath: [], controlId: 'provider-actions', actionId: 'noop' },
      requestContext(changed.entry!, undefined, changed.ctx.mayflyOverlays.list()[0]!.source),
    )).toMatchObject({ kind: 'conflict' })
  })

  it('clears credentials and fences stale credential observations', async () => {
    const bench = await directSetup()
    const entry = bench.entry!
    const action = entry.definition.onEvent!.action!
    bench.ctx.emit('credentials/reference-updated', 'CUSTOM_KEY' as never)
    await flush()
    expect(await action(
      { kind: 'activate', pagePath: [], controlId: 'credential-actions', actionId: 'clear-key' },
      requestContext(entry),
    )).toMatchObject({ kind: 'conflict' })

    const current = bench.ctx.mayflyOverlays.list()[0]!
    const cleared = await current.definition.onEvent!.action!(
      { kind: 'activate', pagePath: [], controlId: 'credential-actions', actionId: 'clear-key' },
      requestContext(current),
    )
    expect(cleared).toMatchObject({ kind: 'accepted', feedback: { message: 'Stored API key cleared' } })
    expect(bench.credentials.values.has('CUSTOM_KEY')).toBe(false)
  })

  it('warns when deleting a provider whose credential source is read-only', async () => {
    const bench = await directSetup()
    vi.spyOn(bench.credentials, 'describe').mockResolvedValue({ configured: true, writable: false, source: 'environment' })
    const entry = bench.entry!
    expect(await entry.definition.onEvent!.action!(
      { kind: 'activate', pagePath: [], controlId: 'provider-actions', actionId: 'delete' },
      requestContext(entry),
    )).toMatchObject({ kind: 'accepted', feedback: { severity: 'warning' } })
    expect(bench.settings.get('llm-pi-ai')).toMatchObject({ providers: {} })
    expect(bench.credentials.values.has('CUSTOM_KEY')).toBe(true)
  })

  it('maps delete conflicts and credential cleanup failures', async () => {
    const conflict = await directSetup()
    vi.spyOn(conflict.settings, 'mutate').mockRejectedValueOnce(new SettingsConflictError('llm-pi-ai' as never, 0, 1))
    expect(await conflict.entry!.definition.onEvent!.action!(
      { kind: 'activate', pagePath: [], controlId: 'provider-actions', actionId: 'delete' },
      requestContext(conflict.entry!),
    )).toMatchObject({ kind: 'conflict' })

    const clearFailure = await directSetup()
    vi.spyOn(clearFailure.credentials, 'unset').mockRejectedValueOnce(new Error('unavailable'))
    expect(await clearFailure.entry!.definition.onEvent!.action!(
      { kind: 'activate', pagePath: [], controlId: 'credential-actions', actionId: 'clear-key' },
      requestContext(clearFailure.entry!),
    )).toMatchObject({ kind: 'failed', message: 'The stored credential could not be cleared' })

    const deleteFailure = await directSetup()
    vi.spyOn(deleteFailure.credentials, 'unset').mockRejectedValueOnce(new Error('unavailable'))
    expect(await deleteFailure.entry!.definition.onEvent!.action!(
      { kind: 'activate', pagePath: [], controlId: 'provider-actions', actionId: 'delete' },
      requestContext(deleteFailure.entry!),
    )).toMatchObject({ kind: 'failed', message: 'Provider removed, but the stored credential could not be cleared' })
  })

  it('contains delete cancellation after settings, credential, and failed writes', async () => {
    const afterSettings = await directSetup()
    const originalMutate = afterSettings.settings.mutate.bind(afterSettings.settings)
    const settingsGate = Promise.withResolvers<void>()
    const mutate = vi.spyOn(afterSettings.settings, 'mutate').mockImplementationOnce(async (...args) => { await settingsGate.promise; return originalMutate(...args) })
    const settingsAbort = new AbortController()
    const settingsResult = afterSettings.entry!.definition.onEvent!.action!(
      { kind: 'activate', pagePath: [], controlId: 'provider-actions', actionId: 'delete' },
      requestContext(afterSettings.entry!, settingsAbort.signal),
    )
    await vi.waitFor(() => expect(mutate).toHaveBeenCalled())
    settingsAbort.abort()
    settingsGate.resolve()
    expect(await settingsResult).toEqual({ kind: 'cancelled' })

    const afterCredential = await directSetup()
    const unsetGate = Promise.withResolvers<void>()
    const unset = vi.spyOn(afterCredential.credentials, 'unset').mockReturnValueOnce(unsetGate.promise)
    const credentialAbort = new AbortController()
    const credentialResult = afterCredential.entry!.definition.onEvent!.action!(
      { kind: 'activate', pagePath: [], controlId: 'credential-actions', actionId: 'clear-key' },
      requestContext(afterCredential.entry!, credentialAbort.signal),
    )
    await vi.waitFor(() => expect(unset).toHaveBeenCalled())
    credentialAbort.abort()
    unsetGate.resolve()
    expect(await credentialResult).toEqual({ kind: 'cancelled' })

    const failed = await directSetup()
    const rejection = Promise.withResolvers<never>()
    const failedUnset = vi.spyOn(failed.credentials, 'unset').mockReturnValueOnce(rejection.promise)
    const failedAbort = new AbortController()
    const failedResult = failed.entry!.definition.onEvent!.action!(
      { kind: 'activate', pagePath: [], controlId: 'credential-actions', actionId: 'clear-key' },
      requestContext(failed.entry!, failedAbort.signal),
    )
    await vi.waitFor(() => expect(failedUnset).toHaveBeenCalled())
    failedAbort.abort()
    rejection.reject(new Error('cancelled'))
    expect(await failedResult).toEqual({ kind: 'cancelled' })
  })

  it('validates and normalizes editable endpoint URLs with name fallbacks', async () => {
    for (const baseURL of ['not a URL', 'file:///tmp/provider']) {
      const invalid = await directSetup()
      expect(await invalid.entry!.definition.onEvent!.action!(
        { kind: 'submit', submission: saveSubmission(invalid.entry!, { baseURL }) },
        requestContext(invalid.entry!),
      )).toMatchObject({ kind: 'invalid' })
    }

    const valid = await directSetup({ profiles: { custom: { baseURL: 'https://old.example/v1', apiKeyEnv: 'CUSTOM_KEY' } } })
    expect(await valid.entry!.definition.onEvent!.action!(
      { kind: 'submit', submission: saveSubmission(valid.entry!, { name: '   ', baseURL: 'http://new.example/v1/', key: '' }) },
      requestContext(valid.entry!),
    )).toMatchObject({ kind: 'accepted' })
    expect(valid.settings.get('llm-pi-ai')).toMatchObject({ providers: { custom: { displayName: 'custom', baseURL: 'http://new.example/v1' } } })

    const known = await directSetup({ llm: { listConfigurableProviders: () => [{ settingsNs: 'llm-pi-ai', provider: 'custom' }] } })
    expect(await known.entry!.definition.onEvent!.action!(
      { kind: 'submit', submission: saveSubmission(known.entry!, { baseURL: 'https://ignored.example', key: 42 }) },
      requestContext(known.entry!),
    )).toMatchObject({ kind: 'accepted' })
    expect(known.settings.get('llm-pi-ai')).toMatchObject({ providers: { custom: { baseURL: 'https://old.example/v1' } } })
  })

  it('ignores unchanged and malformed forged fields while allowing an empty credential update', async () => {
    const bench = await directSetup()
    const entry = bench.entry!
    const raw = saveSubmission(entry, { includeName: false, key: '' })
    raw.forms.push({ pagePath: [], formId: 'provider', fields: [
      { id: 'ignored', value: 'value', change: 'set' },
      { id: 'name', value: 42, change: 'set' },
      { id: 'baseURL', value: 42, change: 'set' },
      { id: 'key', value: 42, change: 'set' },
      { id: 'unchanged', value: 'same', change: 'unchanged' },
    ] })
    expect(await entry.definition.onEvent!.action!(
      { kind: 'submit', submission: raw },
      requestContext(entry),
    )).toMatchObject({ kind: 'accepted' })
    expect(bench.settings.writes).toBe(1)
    expect(bench.credentials.writes).toBe(0)
  })

  it('fences read-only and changed credentials before saving', async () => {
    const readonly = await directSetup()
    vi.spyOn(readonly.credentials, 'describe').mockResolvedValue({ configured: true, writable: false, source: 'environment' })
    expect(await readonly.entry!.definition.onEvent!.action!(
      { kind: 'submit', submission: saveSubmission(readonly.entry!, { key: 'replacement' }) },
      requestContext(readonly.entry!),
    )).toMatchObject({ kind: 'conflict' })

    const changed = await directSetup()
    const staleSource = changed.entry!.source
    changed.ctx.emit('credentials/reference-updated', 'CUSTOM_KEY' as never)
    await flush()
    const current = changed.ctx.mayflyOverlays.list()[0]!
    expect(await current.definition.onEvent!.action!(
      { kind: 'submit', submission: saveSubmission(current, { source: staleSource, key: 'replacement' }) },
      requestContext(current),
    )).toMatchObject({ kind: 'conflict' })
  })

  it('contains save cancellation after settings, credentials, and rejected writes', async () => {
    const afterSettings = await directSetup()
    const originalMutate = afterSettings.settings.mutate.bind(afterSettings.settings)
    const settingsGate = Promise.withResolvers<void>()
    const mutate = vi.spyOn(afterSettings.settings, 'mutate').mockImplementationOnce(async (...args) => { await settingsGate.promise; return originalMutate(...args) })
    const settingsAbort = new AbortController()
    const settingsResult = afterSettings.entry!.definition.onEvent!.action!(
      { kind: 'submit', submission: saveSubmission(afterSettings.entry!) },
      requestContext(afterSettings.entry!, settingsAbort.signal),
    )
    await vi.waitFor(() => expect(mutate).toHaveBeenCalled())
    settingsAbort.abort()
    settingsGate.resolve()
    expect(await settingsResult).toEqual({ kind: 'cancelled' })

    const afterCredential = await directSetup()
    const credentialGate = Promise.withResolvers<void>()
    const set = vi.spyOn(afterCredential.credentials, 'set').mockReturnValueOnce(credentialGate.promise)
    const credentialAbort = new AbortController()
    const credentialResult = afterCredential.entry!.definition.onEvent!.action!(
      { kind: 'submit', submission: saveSubmission(afterCredential.entry!, { includeName: false, key: 'replacement' }) },
      requestContext(afterCredential.entry!, credentialAbort.signal),
    )
    await vi.waitFor(() => expect(set).toHaveBeenCalled())
    credentialAbort.abort()
    credentialGate.resolve()
    expect(await credentialResult).toEqual({ kind: 'cancelled' })

    const rejected = await directSetup()
    const failure = Promise.withResolvers<never>()
    const rejectedMutate = vi.spyOn(rejected.settings, 'mutate').mockReturnValueOnce(failure.promise)
    const rejectedAbort = new AbortController()
    const rejectedResult = rejected.entry!.definition.onEvent!.action!(
      { kind: 'submit', submission: saveSubmission(rejected.entry!) },
      requestContext(rejected.entry!, rejectedAbort.signal),
    )
    await vi.waitFor(() => expect(rejectedMutate).toHaveBeenCalled())
    rejectedAbort.abort()
    failure.reject(new Error('cancelled'))
    expect(await rejectedResult).toEqual({ kind: 'cancelled' })
  })

  it('maps save conflicts and both partial failure states', async () => {
    const conflict = await directSetup()
    vi.spyOn(conflict.settings, 'mutate').mockRejectedValueOnce(new SettingsConflictError('llm-pi-ai' as never, 0, 1))
    expect(await conflict.entry!.definition.onEvent!.action!(
      { kind: 'submit', submission: saveSubmission(conflict.entry!) },
      requestContext(conflict.entry!),
    )).toMatchObject({ kind: 'conflict' })

    const settingsFailure = await directSetup()
    vi.spyOn(settingsFailure.settings, 'mutate').mockRejectedValueOnce(new Error('disk failed'))
    expect(await settingsFailure.entry!.definition.onEvent!.action!(
      { kind: 'submit', submission: saveSubmission(settingsFailure.entry!) },
      requestContext(settingsFailure.entry!),
    )).toMatchObject({ kind: 'failed', message: 'Provider configuration could not be saved' })

    const credentialFailure = await directSetup()
    vi.spyOn(credentialFailure.credentials, 'set').mockRejectedValueOnce(new Error('credential failed'))
    const result = await credentialFailure.entry!.definition.onEvent!.action!(
      { kind: 'submit', submission: saveSubmission(credentialFailure.entry!, { baseURL: 'https://new.example/v1', key: 'replacement' }) },
      requestContext(credentialFailure.entry!),
    )
    expect(result).toMatchObject({
      kind: 'failed',
      acceptedFields: expect.arrayContaining([
        expect.objectContaining({ fieldId: 'name' }),
        expect.objectContaining({ fieldId: 'baseURL' }),
      ]),
      message: 'Provider settings saved, but the credential could not be saved',
    })
  })

  it('cleans listeners when its own overlay closes and ignores other removals', async () => {
    const bench = await directSetup()
    const other = bench.ctx.mayflyOverlays.open({ id: 'other', presentation: 'editor', capturing: true }, { kind: 'text', content: 'other' })
    other.close()
    expect(bench.ctx.mayflyOverlays.close(bench.entry!.id)).toBe(true)
    bench.ctx.emit('settings/updated', 'llm-pi-ai' as never)
    await flush()
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])
  })
})
