/** Shared provider tabs, drafts, and native revision-checked writes.
 * @module @ephemeral-ai/mayfly/remote/features/provider-editor
 */
import type { CredentialInfo, LlmDiscoveredModel, SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { loadModelsDevIndex } from '@ephemeral-ai/mayfly/configuration-panels'
import { panel, tabs, ui, type MayflyFieldAddress, type MayflyFormAddress, type MayflyUiActionReply } from '@ephemeral-ai/mayfly-ui'
import type { RemoteFeatureContext } from './contracts.ts'
import { onRemoteSettingsDocumentUpdated, RemoteCallError, type RemoteFeatureOperation, remoteValue } from './official.ts'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import { deriveRemoteProviderKeyRef, normalizeRemoteProviderBaseURL, remoteProviderDiscoveryBases, remoteProviderProfileAt, type RemoteProviderProfile } from './provider-profile.ts'

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const address = (itemId: string): MayflyFormAddress => ({ pagePath: [{ controlId: 'provider-pages', itemId }], formId: 'provider' })
type SettingValue = Extract<SettingsPathOpView, { op: 'set' }>['value']
interface ProviderView { readonly descriptor: SettingsNamespaceView, readonly profile: RemoteProviderProfile | undefined, readonly ref: string, readonly credential: CredentialInfo, readonly writable: boolean }
interface CustomModel { readonly contextWindow?: number, readonly maxTokens?: number, readonly reasoningEfforts?: Record<string, string> | false }

/** A provider editor belongs to one exact attached Host operation. */
export interface RemoteProviderEditorOptions {
  readonly operation: RemoteFeatureOperation
  readonly route: string
  readonly ns: string
  readonly path: readonly string[]
  readonly known: boolean
  readonly descriptor: SettingsNamespaceView
  readonly profile: RemoteProviderProfile
  readonly credential: CredentialInfo
  readonly writable: boolean
}

/** Mount the reference Models/Connection/Credentials tabs without retaining native objects. */
export function mountRemoteProviderEditor(context: RemoteFeatureContext, options: RemoteProviderEditorOptions): void {
  const { operation, route, ns, path, known } = options
  const client = operation.client
  const t = context.t
  const openedRef = options.profile.apiKeyEnv ?? deriveRemoteProviderKeyRef(route)
  let current: ProviderView = { descriptor: options.descriptor, profile: options.profile, ref: openedRef, credential: options.credential, writable: options.writable }
  let credentialRevision = 0
  let refreshGeneration = 0
  let discoveryGeneration = 0
  let discoveryAbort: AbortController | undefined
  let discoveryState: 'idle' | 'running' | 'failed' | 'done' = 'idle'
  let discovered: readonly LlmDiscoveredModel[] = []
  const customModels = new Map<string, CustomModel>()
  let mounted: RemoteBrowserPanel | undefined
  const configuredIds = (profile = current.profile): readonly string[] => (profile?.models ?? []).flatMap(model => typeof model.id === 'string' ? [model.id] : [])
  const source = () => [{ resourceId: ns, revision: current.descriptor.revision }, { resourceId: 'credential-observation', revision: credentialRevision }]
  const node = () => {
    const profile = current.profile
    if (profile === undefined || current.ref !== openedRef) return panel({ title: t('Configure {route}', { route }), escapeLabel: 'cancel', body: ui.stack.column([ui.text(t(profile === undefined ? 'Provider configuration is no longer available' : 'Provider credential reference changed; reopen the provider'))]) })
    const readonly = current.writable ? {} : { disabled: true, disabledReason: t('Settings are read-only') }
    const ids = [...new Set([...discovered.map(model => model.id), ...configuredIds(), ...customModels.keys()])]
    return panel({ title: t('Configure {route}', { route }), escapeLabel: 'cancel', body: ui.stack.column([
      tabs({ tabs: { id: 'provider-pages', activeId: 'models', items: [{ id: 'models', label: t('Models') }, { id: 'connection', label: t('Connection') }, { id: 'credentials', label: t('Credentials') }] }, pages: {
        models: ui.stack.column([
          ui.list({ id: 'advertised-models', role: 'choose', mode: 'multiple', selectedIds: [...new Set([...configuredIds(), ...customModels.keys()])], items: ids.map(id => {
            const stored = profile.models?.find(model => model.id === id)
            const contextWindow = customModels.get(id)?.contextWindow ?? (typeof stored?.contextWindow === 'number' ? stored.contextWindow : undefined) ?? discovered.find(model => model.id === id)?.contextWindow
            return { id, label: id, ...contextWindow === undefined ? {} : { detail: `${contextWindow} tokens` } }
          }), empty: ui.empty({ title: t('No models discovered') }) }),
          ...discoveryState === 'running' ? [ui.loader({ message: t('discovering models…') })] : discoveryState === 'failed' ? [ui.text(t('model discovery unavailable — add models by id below'), { tone: 'muted' })] : [],
          ui.form({ id: 'provider', fields: [{ kind: 'select', id: 'reasoning', label: t('Default thinking effort'), value: profile.reasoning !== undefined && (LEVELS as readonly string[]).includes(profile.reasoning) ? profile.reasoning : 'default', options: [{ id: 'default', label: t('Provider default') }, ...LEVELS.map(id => ({ id, label: id }))], disabled: !current.writable }] }),
          ui.form({ id: 'custom-model', fields: [{ kind: 'input', id: 'model-id', label: t('+ model id'), value: '', placeholder: t('model id'), disabled: !current.writable }] }),
          ui.actions({ id: 'model-actions', items: [{ id: 'add-model', label: t('Add model'), hintLabel: t('Add model'), key: 'ctrl+a', hidden: true, submit: [{ pagePath: [{ controlId: 'provider-pages', itemId: 'models' }], formId: 'custom-model' }], ...readonly }, { id: 'discover', label: t('Discover models'), hintLabel: t('Discover models'), key: 'ctrl+r', hidden: true, ...readonly }] }),
        ], { gap: 1 }),
        connection: ui.form({ id: 'provider', fields: [{ kind: 'input', id: 'name', label: t('Provider Name'), value: profile.displayName ?? route, required: true, disabled: !current.writable }, ...known ? [] : [{ kind: 'input' as const, id: 'baseURL', label: t('Base URL'), value: profile.baseURL ?? '', required: true, disabled: !current.writable }]] }),
        credentials: ui.stack.column([
          ui.fields([{ label: t('Credential'), value: [{ text: current.ref }] }, { label: t('Status'), value: [{ text: t(current.credential.configured ? 'Configured' : 'Not configured') }] }]),
          ui.form({ id: 'provider', fields: [{ kind: 'secret', id: 'key', label: t('API key'), value: '', placeholder: t('Leave unchanged'), disabled: !current.credential.writable }] }),
          ui.actions({ id: 'credential-actions', items: [{ id: 'clear-key', label: t('Clear stored API key'), hintLabel: t('delete'), key: 'ctrl+x', hidden: true, intent: 'danger', disabled: !current.credential.writable || !current.credential.configured, confirm: t('Clear the stored API key?') }] }),
        ]),
      } }),
      ui.actions({ id: 'provider-actions', items: [{ id: 'save', label: t('Save'), hintLabel: t('save'), semantic: 'save', hidden: true, intent: 'primary', submit: [address('connection'), address('models'), address('credentials')], selections: [{ pagePath: [{ controlId: 'provider-pages', itemId: 'models' }], controlId: 'advertised-models' }], ...readonly }, { id: 'delete', label: t('Delete provider'), hintLabel: t('delete'), key: 'ctrl+x', hidden: true, intent: 'danger', ...readonly, confirm: { title: t('Delete provider "{route}"?', { route }), detail: t('Remove the provider configuration and its stored API key.'), confirmLabel: t('Delete provider'), tone: 'danger' } }] }),
    ], { gap: 1 }) })
  }
  const snapshot = () => ({ node: node(), source: source() })
  const read = async (): Promise<ProviderView | undefined> => {
    const settings = await remoteValue(client.remote.settings.describe())
    if (!operation.valid()) return
    const descriptor = settings.namespaces.find(candidate => candidate.ns === ns)
    if (descriptor === undefined) throw new Error('Provider settings are unavailable')
    const profile = remoteProviderProfileAt(descriptor.value, path)
    const ref = profile?.apiKeyEnv ?? openedRef
    const credentials = await remoteValue(client.remote.credentials.describe([ref]))
    if (!operation.valid()) return
    const credential = credentials[ref]
    if (credential === undefined) throw new Error('Provider credential is unavailable')
    return { descriptor, profile, ref, credential, writable: settings.writable }
  }
  const refresh = async (): Promise<void> => {
    const generation = ++refreshGeneration
    try { const next = await read(); if (next !== undefined && operation.valid() && generation === refreshGeneration && next.descriptor.revision >= current.descriptor.revision) { current = next; mounted?.refresh() } }
    catch { /* Explicit actions report failures; stale background reads retain drafts. */ }
  }
  const discover = async (profile: RemoteProviderProfile): Promise<void> => {
    discoveryAbort?.abort()
    const controller = new AbortController()
    discoveryAbort = controller
    const signal = AbortSignal.any([operation.signal, controller.signal])
    const generation = ++discoveryGeneration
    discoveryState = 'running'; mounted?.refresh()
    try {
      const bases = profile.baseURL === undefined ? [undefined] : remoteProviderDiscoveryBases(profile.baseURL)
      let found: readonly LlmDiscoveredModel[] = []
      for (const base of bases) {
        try { found = await remoteValue(client.remote.llm.discoverModels(ns, { provider: route, api: 'openai-completions', ...base === undefined ? {} : { baseURL: base } }, signal)) }
        catch { if (signal.aborted) return }
        if (found.length > 0) break
      }
      if (signal.aborted || !operation.valid() || generation !== discoveryGeneration) return
      discovered = found; discoveryState = found.length === 0 ? 'failed' : 'done'; mounted?.refresh()
    } catch { if (!signal.aborted && operation.valid() && generation === discoveryGeneration) { discoveryState = 'failed'; mounted?.refresh() } }
  }
  mounted = openRemoteBrowser(context, {
    id: `mayfly.provider.${Buffer.from(route).toString('hex')}`, scope: { kind: 'app', targetId: `${ns}/${route}` }, signal: operation.signal, dismissal: 'confirm-dirty', isCurrent: () => operation.valid(), view: node, source,
    action: async (event, eventContext): Promise<MayflyUiActionReply> => {
      const signal = eventContext.signal
      if (!operation.valid() || signal.aborted) return { kind: 'cancelled' }
      if (event.kind !== 'submit' && event.kind !== 'activate') return { kind: 'completed' }
      if (event.kind === 'submit' && event.submission.actionId === 'add-model') {
        const modelId = String(event.submission.forms.flatMap(form => form.fields).find(field => field.id === 'model-id')?.value ?? '').trim()
        const field = { pagePath: [{ controlId: 'provider-pages', itemId: 'models' }], formId: 'custom-model', fieldId: 'model-id' }
        if (modelId === '') return { kind: 'invalid', errors: [{ ...field, message: t('Enter a model ID') }] }
        if (customModels.has(modelId)) return { kind: 'invalid', errors: [{ ...field, message: t('Already listed') }] }
        const match = (await loadModelsDevIndex(context.ctx, AbortSignal.any([signal, operation.signal])))?.lookup(modelId)
        if (!operation.valid() || signal.aborted) return { kind: 'cancelled' }
        customModels.set(modelId, { ...match?.contextWindow === undefined ? {} : { contextWindow: match.contextWindow }, ...match?.maxTokens === undefined ? {} : { maxTokens: match.maxTokens }, ...match?.efforts !== undefined ? { reasoningEfforts: Object.fromEntries(match.efforts.map(id => [id, id])) } : match?.nonReasoning === true ? { reasoningEfforts: false } : {} })
        return { kind: 'accepted', ...snapshot(), feedback: { severity: 'success', message: t('Model "{model}" added — save to persist', { model: modelId }) } }
      }
      refreshGeneration += 1
      let writtenFields: MayflyFieldAddress[] = []
      let settingsWritten = false
      let settingsRemoved = false
      try {
        const next = await read()
        if (next !== undefined) current = next
        if (!operation.valid() || signal.aborted) return { kind: 'cancelled' }
        if (current.profile === undefined || current.ref !== openedRef) return { kind: 'conflict', ...snapshot(), message: t('Provider configuration changed; reopen the provider') }
        if (event.kind === 'activate' && event.actionId === 'discover') { void discover(current.profile); return { kind: 'completed' } }
        const stamps = event.kind === 'submit' ? event.submission.source : eventContext.source
        const expected = stamps.find(stamp => stamp.resourceId === ns)?.revision
        const expectedCredential = stamps.find(stamp => stamp.resourceId === 'credential-observation')?.revision
        if (typeof expected !== 'number' || expected !== current.descriptor.revision) return { kind: 'conflict', ...snapshot(), message: t('Provider settings changed elsewhere') }
        if (event.kind === 'activate') {
          if (event.actionId !== 'delete' && event.actionId !== 'clear-key') return { kind: 'completed' }
          if (expectedCredential !== credentialRevision) return { kind: 'conflict', ...snapshot(), message: t('The credential changed elsewhere; review before continuing') }
          if (!current.writable && event.actionId === 'delete') return { kind: 'failed', message: t('Settings are read-only') }
          if (event.actionId === 'delete') { await remoteValue(client.remote.settings.mutate(ns, [{ op: 'unset', path: [...path] }], expected)); settingsRemoved = true }
          if (!operation.valid() || signal.aborted) return { kind: 'cancelled' }
          if (!current.credential.writable) {
            const updated = await read()
            if (updated !== undefined) current = updated
            if (!operation.valid() || signal.aborted) return { kind: 'cancelled' }
            return { kind: 'accepted', ...snapshot(), feedback: { severity: 'warning', message: t(event.actionId === 'delete' ? 'Provider removed; its external credential remains unchanged' : 'The external credential cannot be cleared here') } }
          }
          await remoteValue(client.remote.credentials.unset(openedRef))
          if (!operation.valid() || signal.aborted) return { kind: 'cancelled' }
          const updated = await read()
          if (updated !== undefined) current = updated
          if (!operation.valid() || signal.aborted) return { kind: 'cancelled' }
          return { kind: 'accepted', ...snapshot(), feedback: { severity: 'success', message: t(event.actionId === 'delete' ? 'Provider removed' : 'Stored API key cleared') } }
        }
        const ops: SettingsPathOpView[] = []
        let key: string | undefined
        for (const form of event.submission.forms) for (const field of form.fields) {
          if (field.change === 'unchanged') continue
          const page = form.pagePath[0]?.itemId
          if (page === 'credentials' && field.id === 'key' && typeof field.value === 'string') key = field.value
          else if (page === 'connection' && field.id === 'name' && typeof field.value === 'string') ops.push({ op: 'set', path: [...path, 'displayName'], value: field.value.trim() || route })
          else if (page === 'connection' && field.id === 'baseURL' && typeof field.value === 'string' && !known) {
            try { const url = new URL(field.value); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol') }
            catch { return { kind: 'invalid', errors: [{ ...address('connection'), fieldId: 'baseURL', message: t('Enter an HTTP or HTTPS URL') }] } }
            ops.push({ op: 'set', path: [...path, 'baseURL'], value: normalizeRemoteProviderBaseURL(current.profile.api ?? 'openai-completions', field.value) })
          } else if (page === 'models' && field.id === 'reasoning' && typeof field.value === 'string') ops.push(field.value === 'default' ? { op: 'unset', path: [...path, 'reasoning'] } : { op: 'set', path: [...path, 'reasoning'], value: field.value })
        }
        const selected = event.submission.selections?.find(selection => selection.controlId === 'advertised-models')?.selectedIds
        const configured = configuredIds()
        if (selected !== undefined && !(customModels.size === 0 && selected.length === configured.length && selected.every(id => configured.includes(id)))) ops.push({ op: 'set', path: [...path, 'models'], value: selected.map(id => { const found = discovered.find(model => model.id === id); return { ...found?.contextWindow === undefined ? {} : { contextWindow: found.contextWindow }, ...found?.maxTokens === undefined ? {} : { maxTokens: found.maxTokens }, ...current.profile!.models?.find(model => model.id === id), ...customModels.get(id), id } }) as SettingValue })
        if (key !== undefined && (!current.credential.writable || expectedCredential !== credentialRevision)) return { kind: 'conflict', ...snapshot(), message: t('The credential changed elsewhere; review before saving') }
        if (ops.length > 0 && !current.writable) return { kind: 'failed', message: t('Settings are read-only') }
        if (ops.length > 0) {
          const saved = await remoteValue(client.remote.settings.mutate(ns, ops, expected))
          current = { ...current, descriptor: saved, profile: remoteProviderProfileAt(saved.value, path) }
          settingsWritten = true
          writtenFields = ops.flatMap(op => { const field = op.path.at(-1); return field === 'displayName' || field === 'baseURL' ? [{ ...address('connection'), fieldId: field === 'displayName' ? 'name' : 'baseURL' }] : field === 'reasoning' ? [{ ...address('models'), fieldId: 'reasoning' }] : [] })
        }
        if (!operation.valid() || signal.aborted) return { kind: 'cancelled' }
        if (key !== undefined && key.length > 0) await remoteValue(client.remote.credentials.set(openedRef, key))
        if (!operation.valid() || signal.aborted) return { kind: 'cancelled' }
        const updated = await read()
        if (updated !== undefined) current = updated
        if (!operation.valid() || signal.aborted) return { kind: 'cancelled' }
        return { kind: 'accepted', ...snapshot(), feedback: { severity: 'success', message: t('provider "{route}" updated', { route }) } }
      } catch (error) {
        if (!operation.valid() || signal.aborted) return { kind: 'cancelled' }
        try { const latest = await read(); if (latest !== undefined) current = latest } catch { /* Keep the last confirmed native revision. */ }
        if (!operation.valid() || signal.aborted) return { kind: 'cancelled' }
        return error instanceof RemoteCallError && error.code === 'settings/conflict' ? { kind: 'conflict', ...snapshot(), message: t('Provider settings changed elsewhere') }
          : { kind: 'failed', ...snapshot(), ...settingsWritten ? { acceptedFields: writtenFields } : {}, message: t(settingsRemoved ? 'Provider removed, but the stored credential could not be cleared' : settingsWritten ? 'Provider settings saved, but the credential could not be saved' : 'Provider configuration could not be saved') }
      }
    },
    onClosed: () => operation.dispose(),
  })
  operation.onDispose(() => { discoveryAbort?.abort(); mounted?.close() })
  operation.onDispose(onRemoteSettingsDocumentUpdated(client, nsChanged => { if (nsChanged === ns) void refresh() }))
  operation.onDispose(client.remote.$on('credentials/reference-updated', ref => { if (ref === openedRef) { credentialRevision += 1; void refresh() } }))
  void discover(options.profile)
}
