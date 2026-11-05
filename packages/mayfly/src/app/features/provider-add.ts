/** Shared provider setup steps over official settings and credential writes.
 * @module @ephemeral-ai/mayfly/remote/features/provider-add
 */
import { isDeepStrictEqual } from 'node:util'
import type { LlmDiscoveredModel, SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { loadModelsDevIndex } from '../../interaction/models-dev.ts'
import { panel, tabs, ui, type MayflyFormAddress, type MayflySubmission, type MayflyUiActionReply } from '@ephemeral-ai/mayfly-ui'
import type { RemoteFeatureContext } from './contracts.ts'
import { onRemoteSettingsDocumentUpdated, RemoteCallError, type RemoteFeatureOperation, remoteErrorMessage, remoteValue } from './official.ts'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import { deriveRemoteProviderKeyRef, normalizeRemoteProviderBaseURL, remoteProviderDiscoveryBases, remoteProviderProfileAt, REMOTE_PROVIDER_ROUTE } from './provider-profile.ts'
const PROTOCOLS = ['anthropic-messages', 'openai-completions', 'openai-responses'] as const
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const address = (formId: string): MayflyFormAddress => ({ pagePath: [{ controlId: 'provider-tabs', itemId: formId }], formId })
type SettingValue = Extract<SettingsPathOpView, { op: 'set' }>['value']
interface ModelFacts { readonly contextWindow?: number, readonly maxTokens?: number, readonly reasoningEfforts?: Record<string, string> | false }
/** Native settings address and the exact-generation owner for one setup. */
interface RemoteProviderSetupOptions {
  readonly operation: RemoteFeatureOperation
  readonly descriptor: SettingsNamespaceView
  readonly container: readonly string[]
  readonly writable: boolean
  readonly known?: string
  readonly knownPath?: readonly string[]
  readonly onCreated?: (route: string) => Promise<void>
}
function values(submission: MayflySubmission, id: string): Readonly<Record<string, unknown>> { return Object.fromEntries(submission.forms.find(form => form.formId === id)?.fields.map(field => [field.id, field.value]) ?? []) }

/** Open the reference connection/models setup; discovery never writes a profile or credential. */
export function mountRemoteProviderSetup(context: RemoteFeatureContext, options: RemoteProviderSetupOptions): void {
  const { operation, known } = options
  const client = operation.client
  const ns = options.descriptor.ns
  const t = context.t
  let descriptor = options.descriptor
  let writable = options.writable
  let advertised: readonly LlmDiscoveredModel[] = []
  let listingBase: string | undefined
  let metadata = new Map<string, ModelFacts>()
  const customModels = new Map<string, ModelFacts>()
  let created: { readonly route: string, readonly profile: Record<string, unknown> } | undefined
  let unlocked = false
  let discoveryState: 'idle' | 'running' | 'failed' | 'done' = 'idle'
  let discoveryError = ''
  let discoveryGeneration = 0
  let refreshGeneration = 0
  let discoveryAbort: AbortController | undefined
  let mounted: RemoteBrowserPanel | undefined
  const profilePath = (route: string) => known === undefined ? [...options.container, route] : [...options.knownPath ?? [...options.container, known]]
  const source = () => [{ resourceId: ns, revision: descriptor.revision }]
  const modelPath = [{ controlId: 'provider-tabs', itemId: 'models' }]
  const customAddress: MayflyFormAddress = { pagePath: modelPath, formId: 'custom-model' }
  const view = () => panel({ title: t(known === undefined ? 'Custom endpoint' : 'Configure {route}', { route: known ?? '' }), escapeLabel: 'cancel', body: ui.stack.column([
    tabs({ tabs: { id: 'provider-tabs', activeId: 'connection', items: [{ id: 'connection', label: t('Connection') }, ...known === undefined ? [{ id: 'models', label: t('Models'), disabled: !unlocked }] : []] }, pages: {
      connection: ui.stack.column([
        ui.form({ id: 'connection', fields: [{ kind: 'input', id: 'route', label: t('Provider Name'), value: known ?? created?.route ?? '', required: true, disabled: !writable || known !== undefined || created !== undefined },
          ...known === undefined ? [{ kind: 'select' as const, id: 'protocol', label: t('Protocol'), value: String(created?.profile.api ?? 'openai-completions'), options: PROTOCOLS.map(id => ({ id, label: id })), disabled: !writable || created !== undefined }, { kind: 'input' as const, id: 'baseURL', label: t('Base URL'), value: String(created?.profile.baseURL ?? ''), required: true, disabled: !writable || created !== undefined }] : [],
          { kind: 'secret', id: 'key', label: t('API key'), value: '', required: true, disabled: !writable },
        ] }),
        ...known === undefined ? [ui.actions({ id: 'connection-actions', items: [{ id: 'next', label: t('Next step'), hintLabel: t('Next step'), key: 'ctrl+enter', hidden: true, intent: 'primary', read: [address('connection')], disabled: !writable || created !== undefined }] })] : [],
      ], { gap: 1 }),
      ...known === undefined ? { models: ui.stack.column([
        ...discoveryState === 'running' ? [ui.loader({ message: t('discovering models…') })] : discoveryState === 'failed' ? [ui.text(`${t('model discovery unavailable — add models by id below')} — ${discoveryError}`, { tone: 'muted' })] : unlocked && discoveryState === 'idle' ? [ui.text(t('The connection changed — run discovery again'), { tone: 'muted' })] : [],
        ui.list({ id: 'advertised-models', role: 'choose', mode: 'multiple', minSelected: 1, filterable: true, selectedIds: created === undefined ? [...advertised.map(model => model.id), ...customModels.keys()] : (created.profile.models as { id: string }[]).map(model => model.id), items: [...advertised.map(model => ({ id: model.id, label: model.id, ...model.contextWindow === undefined ? {} : { detail: `${model.contextWindow} tokens` } })), ...[...customModels].map(([id, facts]) => ({ id, label: id, ...facts.contextWindow === undefined ? {} : { detail: `${facts.contextWindow} tokens` } }))], empty: ui.empty({ title: t('No models discovered') }) }),
        ui.form({ id: 'models', fields: [{ kind: 'number', id: 'context', label: t('Default context window'), value: null, min: 1, step: 1, unit: 'tokens', disabled: !writable }, { kind: 'multiselect', id: 'efforts', label: t('Thinking efforts'), value: [], options: LEVELS.map(id => ({ id, label: id })), disabled: !writable }] }),
        ui.form({ id: 'custom-model', fields: [{ kind: 'input', id: 'model-id', label: t('+ model id'), value: '', placeholder: t('model id'), disabled: !writable || created !== undefined }] }),
        ui.actions({ id: 'model-actions', items: [{ id: 'add-model', label: t('Add model'), hintLabel: t('Add model'), key: 'ctrl+a', hidden: true, submit: [customAddress], disabled: !writable || created !== undefined }, { id: 'discover', label: t('Discover models'), hintLabel: t('Discover models'), key: 'ctrl+r', hidden: true, read: [address('connection')], disabled: !writable || created !== undefined }] }),
      ], { gap: 1 }) } : {},
    } }),
    ui.actions({ id: 'provider-setup-actions', items: [{ id: 'save', label: t('Save'), hintLabel: t('save'), semantic: 'save', hidden: true, intent: 'primary', submit: [address('connection'), ...known === undefined ? [address('models')] : []], disabled: !writable, ...known === undefined ? { selections: [{ pagePath: modelPath, controlId: 'advertised-models' }] } : {} }] }),
  ], { gap: 1 }) })
  const snapshot = () => ({ node: view(), source: source() })
  const read = async () => {
    const settings = await remoteValue(client.remote.settings.describe())
    if (!operation.valid()) return undefined
    const next = settings.namespaces.find(item => item.ns === ns)
    if (next === undefined) throw new Error('Provider settings are unavailable')
    return { descriptor: next, writable: settings.writable }
  }
  const refresh = async (): Promise<void> => {
    const generation = ++refreshGeneration
    try {
      const next = await read()
      if (next === undefined || !operation.valid() || generation !== refreshGeneration || next.descriptor.revision < descriptor.revision) return
      descriptor = next.descriptor; writable = next.writable; mounted?.refresh()
    } catch { /* Preserve drafts on a failed background read. */ }
  }
  const runDiscovery = async (input: { protocol: string, baseURL: string, key: string }): Promise<void> => {
    discoveryAbort?.abort()
    const controller = new AbortController()
    discoveryAbort = controller
    const generation = ++discoveryGeneration
    const signal = AbortSignal.any([operation.signal, controller.signal])
    discoveryState = 'running'; discoveryError = ''
    let found: readonly LlmDiscoveredModel[] | undefined
    let failure: unknown
    for (const api of new Set([input.protocol === 'anthropic-messages' ? 'openai-completions' : input.protocol, 'openai-completions'])) {
      for (const baseURL of remoteProviderDiscoveryBases(input.baseURL)) {
        try { const result = await remoteValue(client.remote.llm.discoverModels(ns, { api, baseURL, apiKey: input.key }, signal)); if (result.length > 0) { found = result; listingBase = baseURL; break } }
        catch (error) { if (signal.aborted) return; failure ??= error }
      }
      if (found !== undefined) break
    }
    if (!operation.valid() || signal.aborted || generation !== discoveryGeneration) return
    if (found === undefined) { discoveryState = 'failed'; discoveryError = failure === undefined ? t('Model discovery failed') : remoteErrorMessage(failure, [input.key], 'Model discovery failed') }
    else {
      const catalog = await loadModelsDevIndex(context.ctx, signal)
      if (!operation.valid() || signal.aborted || generation !== discoveryGeneration) return
      advertised = found
      metadata = new Map(found.map(model => { const match = catalog?.lookup(model.id); const contextWindow = model.contextWindow ?? match?.contextWindow; const maxTokens = model.maxTokens ?? match?.maxTokens; return [model.id, { ...contextWindow === undefined ? {} : { contextWindow }, ...maxTokens === undefined ? {} : { maxTokens }, ...match?.efforts !== undefined ? { reasoningEfforts: Object.fromEntries(match.efforts.map(id => [id, id])) } : match?.nonReasoning === true ? { reasoningEfforts: false } : {} }] }))
      discoveryState = 'done'
    }
    mounted?.refresh()
  }
  const handler = async (submission: MayflySubmission, action: 'discover' | 'save', signal: AbortSignal): Promise<MayflyUiActionReply> => {
    // The action owner admitted this synchronous handoff; every native await
    // below rechecks both that owner and the action signal before continuing.
    const connection = values(submission, 'connection')
    const route = known ?? String(connection.route ?? '').trim()
    const key = String(connection.key ?? '')
    const protocol = known === undefined ? String(connection.protocol) : undefined
    const baseURL = String(connection.baseURL ?? '')
    if (!REMOTE_PROVIDER_ROUTE.test(route)) return { kind: 'invalid', errors: [{ ...address('connection'), fieldId: 'route', message: t('Provider names use lowercase letters, digits, and hyphens') }] }
    if (known === undefined) {
      try { const url = new URL(baseURL); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol') }
      catch { return { kind: 'invalid', errors: [{ ...address('connection'), fieldId: 'baseURL', message: t('Enter an HTTP or HTTPS URL') }] } }
    }
    if (action === 'discover') {
      unlocked = true; void runDiscovery({ protocol: protocol!, baseURL, key }); mounted?.refresh()
      return { kind: 'completed', navigate: modelPath }
    }
    try {
      const next = await read()
      if (next === undefined || !operation.valid() || signal.aborted) return { kind: 'cancelled' }
      descriptor = next.descriptor; writable = next.writable
      const expected = submission.source.find(stamp => stamp.resourceId === ns)?.revision
      if (typeof expected !== 'number' || expected !== descriptor.revision) return { kind: 'conflict', ...snapshot(), message: t('Provider settings changed elsewhere') }
      if (!writable) return { kind: 'failed', message: t('Settings are read-only') }
      const stored = remoteProviderProfileAt(descriptor.value, profilePath(route))
      if (created === undefined && stored !== undefined) return { kind: 'invalid', errors: [{ ...address('connection'), fieldId: 'route', message: t('This provider already exists') }] }
      if (created !== undefined && (created.route !== route || !isDeepStrictEqual(stored, created.profile))) return { kind: 'conflict', ...snapshot(), message: t('The created provider changed; reopen its configuration') }
      const defaults = values(submission, 'models')
      const selected = submission.selections?.find(item => item.controlId === 'advertised-models')?.selectedIds ?? []
      const profile: Record<string, unknown> = known === undefined ? { api: protocol, baseURL: normalizeRemoteProviderBaseURL(protocol!, baseURL, listingBase), apiKeyEnv: deriveRemoteProviderKeyRef(route), models: selected.map(id => {
        const facts = metadata.get(id) ?? customModels.get(id) ?? {}
        const contextWindow = facts.contextWindow ?? (typeof defaults.context === 'number' ? defaults.context : undefined)
        const reasoningEfforts = facts.reasoningEfforts ?? (Array.isArray(defaults.efforts) && defaults.efforts.length > 0 ? Object.fromEntries(defaults.efforts.map(level => [level, level])) : undefined)
        return { id, ...facts, ...contextWindow === undefined ? {} : { contextWindow }, ...reasoningEfforts === undefined ? {} : { reasoningEfforts } }
      }) } : { apiKeyEnv: deriveRemoteProviderKeyRef(route) }
      if (created === undefined) { descriptor = await remoteValue(client.remote.settings.mutate(ns, [{ op: 'set', path: profilePath(route), value: profile as SettingValue }], expected)); created = { route, profile } }
      if (!operation.valid() || signal.aborted) return { kind: 'cancelled' }
      await remoteValue(client.remote.credentials.set(deriveRemoteProviderKeyRef(route), key))
      if (!operation.valid() || signal.aborted) return { kind: 'cancelled' }
      await options.onCreated?.(route)
      if (!operation.valid() || signal.aborted) return { kind: 'cancelled' }
      return { kind: 'accepted', ...snapshot(), dismiss: true, feedback: { severity: 'success', message: t('provider "{route}" added', { route }) } }
    } catch (error) {
      if (!operation.valid() || signal.aborted) return { kind: 'cancelled' }
      return error instanceof RemoteCallError && error.code === 'settings/conflict' ? { kind: 'conflict', ...snapshot(), message: t('Provider settings changed elsewhere') }
        : { kind: 'failed', ...snapshot(), ...created === undefined ? {} : { acceptedFields: submission.forms.filter(form => form.formId === 'connection').flatMap(form => form.fields.filter(field => field.id !== 'key').map(field => ({ ...address('connection'), fieldId: field.id }))) }, message: t(created === undefined ? 'Provider could not be added' : 'Provider created, but its credential could not be saved') }
    }
  }
  mounted = openRemoteBrowser(context, {
    id: known === undefined ? 'mayfly.provider.add.custom' : `mayfly.provider.add.${Buffer.from(known).toString('hex')}`, scope: { kind: 'app', targetId: known ?? 'provider-creation' }, signal: operation.signal, dismissal: 'confirm-dirty', isCurrent: () => operation.valid(), view, source,
    observe: event => { if (event.kind === 'value-change' && known === undefined && created === undefined && ['protocol', 'baseURL', 'key'].includes(event.controlId) && (advertised.length > 0 || discoveryState !== 'idle')) { advertised = []; metadata.clear(); listingBase = undefined; discoveryState = 'idle'; discoveryError = ''; discoveryGeneration += 1; discoveryAbort?.abort(); mounted?.refresh() } },
    action: async (event, eventContext): Promise<MayflyUiActionReply> => {
      if (!operation.valid() || eventContext.signal.aborted) return { kind: 'cancelled' }
      if (event.kind === 'submit' && event.submission.actionId === 'add-model') {
        const id = String(event.submission.forms.flatMap(form => form.fields).find(field => field.id === 'model-id')?.value ?? '').trim()
        const field = { ...customAddress, fieldId: 'model-id' }
        if (id === '') return { kind: 'invalid', errors: [{ ...field, message: t('Enter a model ID') }] }
        if (customModels.has(id) || advertised.some(model => model.id === id)) return { kind: 'invalid', errors: [{ ...field, message: t('Already listed') }] }
        const match = (await loadModelsDevIndex(context.ctx, AbortSignal.any([operation.signal, eventContext.signal])))?.lookup(id)
        if (!operation.valid() || eventContext.signal.aborted) return { kind: 'cancelled' }
        customModels.set(id, { ...match?.contextWindow === undefined ? {} : { contextWindow: match.contextWindow }, ...match?.maxTokens === undefined ? {} : { maxTokens: match.maxTokens }, ...match?.efforts !== undefined ? { reasoningEfforts: Object.fromEntries(match.efforts.map(id => [id, id])) } : match?.nonReasoning === true ? { reasoningEfforts: false } : {} })
        return { kind: 'accepted', ...snapshot(), feedback: { severity: 'success', message: t('Model "{model}" added — save to persist', { model: id }) } }
      }
      if (event.kind === 'submit') return handler(event.submission, 'save', eventContext.signal)
      if (event.kind === 'activate' && (event.actionId === 'next' || event.actionId === 'discover') && event.inputs !== undefined) return handler(event.inputs, 'discover', eventContext.signal)
      return { kind: 'completed' }
    },
    onClosed: () => operation.dispose(),
  })
  operation.onDispose(() => { discoveryAbort?.abort(); mounted?.close() })
  operation.onDispose(onRemoteSettingsDocumentUpdated(client, changed => { if (changed === ns) void refresh() }))
}
