/** App-scoped provider editing through native settings/credentials and shared editor overlays.
 * @module @ephemeral-ai/mayfly/interaction/provider-edit
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialInfo } from '@deepseek-ai/dsh-credentials'
import { SettingsConflictError, type SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import { ui, type MayflyFormAddress, type MayflyOverlayHandle, type MayflySourceStamp, type MayflyUiActionReply, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { deriveKeyRef, normalizeBaseURL, providerProfile, type ProviderProfile } from './provider-profile.ts'
import { loadModelsDevIndex } from './models-dev.ts'
import { interactionTranslator, observeInteractionLocale } from './locale.ts'
import { openUiOverlay } from './ui-overlay.ts'

const NAMESPACE = 'llm-pi-ai'
const address = (itemId: string): MayflyFormAddress => ({ pagePath: [{ controlId: 'provider-pages', itemId }], formId: 'provider' })
const modelSelection = { pagePath: [{ controlId: 'provider-pages', itemId: 'models' }], controlId: 'advertised-models' }
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
/** Select sentinel for "keep the provider's own default"; the route field stays unset. */
const PROVIDER_DEFAULT_EFFORT = 'default'

interface ProviderView {
  readonly profile: ProviderProfile | undefined
  readonly revision: number
  readonly ref: string
  readonly credential: CredentialInfo
}

/** One hand-declared model pending the next save. */
interface CustomModel {
  readonly contextWindow?: number
  readonly maxTokens?: number
  readonly reasoningEfforts?: Record<string, string> | false
}

/** Candidate listing bases for one endpoint (the listing is always `${base}/models`). */
function discoveryBases(baseURL: string): readonly string[] {
  const base = baseURL.replace(/\/+$/, '')
  return [...new Set([base, `${base}/v1`, base.replace(/\/v1$/, '')])]
}

/** Open a live configuration surface with a write-only credential field. */
export async function openProviderEditor(ctx: Context, route: string, signal?: AbortSignal): Promise<boolean> {
  const settings = ctx.get('settings')
  const credentials = ctx.get('credentials')
  const overlays = ctx.get('mayflyOverlays')
  if (settings === undefined || credentials === undefined || overlays === undefined) return false
  const id = `mayfly.provider.${Buffer.from(route).toString('hex')}`
  const existing = overlays.list().find(entry => entry.id === id)
  if (existing !== undefined) {
    overlays.focus(id)
    return true
  }
  const lifetime = new AbortController()
  const cancellation = signal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, signal])
  const releaseLifetime = ctx.effect(() => () => lifetime.abort())
  const t = interactionTranslator(ctx)
  let credentialRevision = 0
  let refreshGeneration = 0
  let handle: MayflyOverlayHandle | undefined
  let openedRef: string | undefined
  let settingsRemoved = false
  let cleanup = (): void => {}
  /** Endpoint-advertised models; advisory, so a failed probe keeps stored configuration editable. */
  let discoveredModels: readonly LlmDiscoveredModel[] = []
  /** Hand-added models pending the next Save, keyed by model id. */
  const customModels = new Map<string, CustomModel>()
  const configuredIds = (profile: ProviderProfile | undefined): readonly string[] =>
    (profile?.models ?? []).flatMap(model => typeof model.id === 'string' ? [model.id] : [])
  /** Every row the Models list offers: advertised, stored, and hand-added. */
  const advertisedIds = (profile: ProviderProfile | undefined): readonly string[] =>
    [...new Set([...discoveredModels.map(model => model.id), ...configuredIds(profile), ...customModels.keys()])]
  const modelDetail = (modelId: string, profile: ProviderProfile | undefined): string | undefined => {
    const stored = (profile?.models ?? []).find(model => model.id === modelId)
    const contextWindow = customModels.get(modelId)?.contextWindow
      ?? (typeof stored?.contextWindow === 'number' ? stored.contextWindow : undefined)
      ?? discoveredModels.find(model => model.id === modelId)?.contextWindow
    return contextWindow === undefined ? undefined : `${String(contextWindow)} tokens`
  }
  /** Persist one selected row, keeping stored overrides and folding hand-added facts on top. */
  const modelEntry = (modelId: string, profile: ProviderProfile | undefined): Record<string, unknown> => {
    const stored = (profile?.models ?? []).find(model => model.id === modelId)
    const discovered = discoveredModels.find(model => model.id === modelId)
    const custom = customModels.get(modelId)
    return {
      ...(discovered?.contextWindow === undefined ? {} : { contextWindow: discovered.contextWindow }),
      ...(discovered?.maxTokens === undefined ? {} : { maxTokens: discovered.maxTokens }),
      ...stored,
      ...(custom?.contextWindow === undefined ? {} : { contextWindow: custom.contextWindow }),
      ...(custom?.maxTokens === undefined ? {} : { maxTokens: custom.maxTokens }),
      ...(custom?.reasoningEfforts === undefined ? {} : { reasoningEfforts: custom.reasoningEfforts }),
      id: modelId,
    }
  }
  const defaultEffort = (profile: ProviderProfile | undefined): string =>
    profile?.reasoning !== undefined && (THINKING_LEVELS as readonly string[]).includes(profile.reasoning)
      ? profile.reasoning
      : PROVIDER_DEFAULT_EFFORT
  const read = async (): Promise<ProviderView> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      cancellation.throwIfAborted()
      const descriptor = settings.describe().find(item => String(item.ns) === NAMESPACE)
      if (descriptor === undefined) throw new Error('Provider settings are unavailable')
      const profile = providerProfile(descriptor.value, route)
      const ref = profile?.apiKeyEnv ?? openedRef ?? deriveKeyRef(route)
      const credential = await credentials.describe(credentialRef(ref))
      cancellation.throwIfAborted()
      const current = settings.describe().find(item => String(item.ns) === NAMESPACE)
      if (current?.revision === descriptor.revision) return { profile, revision: descriptor.revision, ref, credential }
    }
    throw new Error('Provider changed while loading')
  }
  const source = (view: ProviderView): readonly MayflySourceStamp[] => [{ resourceId: NAMESPACE, revision: view.revision }, { resourceId: 'credential-observation', revision: credentialRevision }]
  const known = ctx.get('llm')?.listConfigurableProviders().some(item => item.settingsNs === NAMESPACE && item.provider === route) === true
  /** Models-tab discovery visibility: idle while unprobed, then running/failed/done. */
  let discoveryState: 'idle' | 'running' | 'failed' | 'done' = 'idle'
  const node = (view: ProviderView): MayflyUiNode => {
    if (view.profile === undefined || (openedRef !== undefined && view.ref !== openedRef)) return ui.stack.column([
      ui.text(t(view.profile === undefined ? 'Provider configuration is no longer available' : 'Provider credential reference changed; reopen the provider')),
      ui.actions({ id: 'provider-closed-actions', items: [{ id: 'close', label: t('Close'), dismiss: true }] }),
    ])
    const writable = settings.writable
    const selectedModels = [...new Set([...configuredIds(view.profile), ...customModels.keys()])]
    const readonly = writable ? {} : { disabled: true, disabledReason: t('Settings are read-only') }
    return ui.stack.column([
      ui.tabs({ id: 'provider-pages', activeId: 'models', items: [{ id: 'models', label: t('Models') }, { id: 'connection', label: t('Connection') }, { id: 'credentials', label: t('Credentials') }] }),
      ui.child(ui.stack.column([
        ui.list({
          id: 'advertised-models', role: 'choose', mode: 'multiple', selectedIds: selectedModels,
          items: advertisedIds(view.profile).map(modelId => {
            const detail = modelDetail(modelId, view.profile)
            return { id: modelId, label: modelId, ...(detail === undefined ? {} : { detail }) }
          }),
          empty: ui.empty({ title: t('No models discovered') }),
        }),
        ...discoveryState === 'running' ? [ui.loader({ message: t('discovering models…') })]
          : discoveryState === 'failed' ? [ui.text(t('model discovery unavailable — add models by id below'), { tone: 'muted' })] : [],
        ui.form({ id: 'provider', fields: [
          { kind: 'select', id: 'reasoning', label: t('Default thinking effort'), value: defaultEffort(view.profile), options: [{ id: PROVIDER_DEFAULT_EFFORT, label: t('Provider default') }, ...THINKING_LEVELS.map(level => ({ id: level, label: level }))], disabled: !writable },
        ] }),
        ui.form({ id: 'custom-model', fields: [
          { kind: 'input', id: 'model-id', label: t('+ model id'), value: '', placeholder: t('model id'), disabled: !writable },
        ] }),
        ui.actions({ id: 'model-actions', items: [{ id: 'add-model', label: t('Add model'), submit: [{ pagePath: [{ controlId: 'provider-pages', itemId: 'models' }], formId: 'custom-model' }], ...readonly }] }),
      ], { gap: 1 }), { tab: { controlId: 'provider-pages', itemId: 'models' } }),
      ui.child(ui.form({ id: 'provider', fields: [
        { kind: 'input', id: 'name', label: t('Provider Name'), value: view.profile.displayName ?? route, required: true, disabled: !writable },
        ...known ? [] : [{ kind: 'input' as const, id: 'baseURL', label: t('Base URL'), value: view.profile.baseURL ?? '', required: true, disabled: !writable }],
      ] }), { tab: { controlId: 'provider-pages', itemId: 'connection' } }),
      ui.child(ui.stack.column([
        ui.fields([{ label: t('Credential'), value: [{ text: view.ref }] }, { label: t('Status'), value: [{ text: t(view.credential.configured ? 'Configured' : 'Not configured') }] }]),
        ui.form({ id: 'provider', fields: [{ kind: 'secret', id: 'key', label: t('API key'), value: '', placeholder: t('Leave unchanged'), disabled: !view.credential.writable }] }),
        ui.actions({ id: 'credential-actions', items: [{ id: 'clear-key', label: t('Clear stored API key'), intent: 'danger', disabled: !view.credential.writable || !view.credential.configured, confirm: t('Clear the stored API key?') }] }),
      ]), { tab: { controlId: 'provider-pages', itemId: 'credentials' } }),
      ui.actions({ id: 'provider-actions', items: [
        { id: 'save', label: t('Save'), intent: 'primary', submit: [address('connection'), address('models'), address('credentials')], selections: [modelSelection], ...readonly },
        { id: 'cancel', label: t('Cancel'), dismiss: true },
        { id: 'delete', label: t('Delete provider'), intent: 'danger', ...readonly, confirm: t('Delete provider "{route}"?', { route }) },
      ] }),
    ], { gap: 1 })
  }
  const reply = (view: ProviderView): { readonly node: MayflyUiNode, readonly source: readonly MayflySourceStamp[] } => ({ node: node(view), source: source(view) })
  const refresh = async (): Promise<void> => {
    const generation = ++refreshGeneration
    try {
      const view = await read()
      if (cancellation.aborted || handle === undefined || handle.closed || generation !== refreshGeneration) return
      handle.set(node(view), { reason: view.ref !== openedRef ? 'replace' : 'data', source: source(view) })
    } catch { /* explicit operations present failures; stale background reads cannot replace drafts */ }
  }
  /** Stage one hand-declared model; Save writes it. Catalog metadata fills the blanks. */
  const addModel = async (fields: readonly { id: string, value?: unknown }[], signal: AbortSignal): Promise<MayflyUiActionReply> => {
    const modelId = String(fields.find(field => field.id === 'model-id')?.value ?? '').trim()
    const field = { pagePath: [{ controlId: 'provider-pages', itemId: 'models' }], formId: 'custom-model', fieldId: 'model-id' }
    if (modelId === '') return { kind: 'invalid', errors: [{ ...field, message: t('Enter a model ID') }] }
    if (customModels.has(modelId)) return { kind: 'invalid', errors: [{ ...field, message: t('Already listed') }] }
    const matched = (await loadModelsDevIndex(ctx, signal))?.lookup(modelId)
    /* v8 ignore next -- a cancellation racing the awaited catalog read is a lifetime path */
    if (signal.aborted || cancellation.aborted) return { kind: 'cancelled' }
    customModels.set(modelId, {
      ...(matched?.contextWindow === undefined ? {} : { contextWindow: matched.contextWindow }),
      ...(matched?.maxTokens === undefined ? {} : { maxTokens: matched.maxTokens }),
      ...(matched?.efforts !== undefined ? { reasoningEfforts: Object.fromEntries(matched.efforts.map(level => [level, level])) } : matched?.nonReasoning === true ? { reasoningEfforts: false as const } : {}),
    })
    try {
      const view = await read()
      /* v8 ignore next -- a submission resolving after the editor closed finds its lifetime already released */
      if (!cancellation.aborted && !signal.aborted) return { kind: 'accepted', ...reply(view), feedback: { severity: 'success', message: t('Model "{model}" added — save to persist', { model: modelId }) } }
    } catch { /* staging is in-memory; a failed re-read leaves the next refresh to repaint */ }
    return { kind: 'completed', feedback: { severity: 'success', message: t('Model "{model}" added — save to persist', { model: modelId }) } }
  }
  /** Probe the endpoint's model listing after the editor opens; findings repaint the Models tab. */
  const discover = (profile: ProviderProfile): void => {
    const llm = ctx.get('llm')
    if (llm === undefined) return
    // The listing is an OpenAI-style `${base}/models` even when the route
    // speaks another protocol, so probe the candidate bases with the one
    // readable listing protocol; a catalog route with no baseURL answers
    // from the adapter's own registry.
    const bases = profile.baseURL === undefined ? [] : discoveryBases(profile.baseURL)
    discoveryState = 'running'
    void refresh()
    void (async () => {
      for (const base of bases.length === 0 ? [undefined] : bases) {
        if (cancellation.aborted) return
        try {
          const found = await llm.discoverModels(NAMESPACE, {
            provider: route,
            api: 'openai-completions',
            ...(base === undefined ? {} : { baseURL: base }),
          }, cancellation)
          if (found.length > 0) { discoveredModels = found; discoveryState = 'done'; await refresh(); return }
        } catch { /* discovery is advisory; an unreachable endpoint leaves stored configuration editable */ }
      }
      if (!cancellation.aborted) { discoveryState = 'failed'; await refresh() }
    })()
  }
  try {
    const initial = await read()
    if (initial.profile === undefined) { releaseLifetime(); return false }
    openedRef = initial.ref
    const offSettings = ctx.on('settings/document-updated', ns => { if (String(ns) === NAMESPACE) void refresh() })
    const offValues = ctx.on('settings/updated', ns => { if (String(ns) === NAMESPACE) void refresh() })
    const offCredential = ctx.on('credentials/reference-updated', ref => {
      if (String(ref) === openedRef) { credentialRevision += 1; void refresh() }
    })
    const offLocale = observeInteractionLocale(ctx, () => { void refresh() })
    cleanup = ctx.effect(() => () => { offSettings(); offValues(); offCredential(); offLocale(); releaseLifetime() })
    handle = openUiOverlay(ctx, {
      id, title: t('Configure {route}', { route }), presentation: 'editor', capturing: true,
      scope: { kind: 'app', targetId: `${NAMESPACE}/${route}` }, source: source(initial),
      onEvent: { action: async (event, context): Promise<MayflyUiActionReply> => {
        if (event.kind !== 'submit' && event.kind !== 'activate') return { kind: 'completed' }
        /* v8 ignore next -- a cancellation racing the awaited native read is a lifetime path */
        if (context.signal.aborted || cancellation.aborted) return { kind: 'cancelled' }
        if (event.kind === 'submit' && event.submission.actionId === 'add-model') {
          return addModel(event.submission.forms.flatMap(form => form.fields), context.signal)
        }
        const view = await read()
        /* v8 ignore next -- a cancellation racing the awaited native read is a lifetime path */
        if (context.signal.aborted || cancellation.aborted) return { kind: 'cancelled' }
        if (view.profile === undefined || view.ref !== openedRef) return { kind: 'conflict', ...reply(view), message: t('Provider configuration changed; reopen the provider') }
        const stamps = event.kind === 'submit' ? event.submission.source : context.source
        const expected = stamps.find(stamp => stamp.resourceId === NAMESPACE)?.revision
        const expectedCredential = stamps.find(stamp => stamp.resourceId === 'credential-observation')?.revision
        if (typeof expected !== 'number' || expected !== view.revision) return { kind: 'conflict', ...reply(view), message: t('Provider settings changed elsewhere') }
        if (event.kind === 'activate') {
          if (event.actionId !== 'delete' && event.actionId !== 'clear-key') return { kind: 'completed' }
          if (expectedCredential !== credentialRevision) return { kind: 'conflict', ...reply(view), message: t('The credential changed elsewhere; review before continuing') }
          try {
            if (event.actionId === 'delete') {
              await settings.mutate(NAMESPACE, [{ op: 'unset', path: ['providers', route] }], expected)
              settingsRemoved = true
            }
            /* v8 ignore next -- a cancellation racing the awaited native read is a lifetime path */
            if (context.signal.aborted || cancellation.aborted) return { kind: 'cancelled' }
            if (!view.credential.writable) return { kind: 'accepted', ...reply(await read()), feedback: { severity: 'warning', message: t('Provider removed; its external credential remains unchanged') } }
            await credentials.unset(credentialRef(openedRef!))
            /* v8 ignore next -- a cancellation racing the awaited native read is a lifetime path */
            if (context.signal.aborted || cancellation.aborted) return { kind: 'cancelled' }
            return { kind: 'accepted', ...reply(await read()), feedback: { severity: 'success', message: t(event.actionId === 'delete' ? 'Provider removed' : 'Stored API key cleared') } }
          } catch (error) {
            /* v8 ignore next -- a cancellation racing the awaited native read is a lifetime path */
            if (context.signal.aborted || cancellation.aborted) return { kind: 'cancelled' }
            return error instanceof SettingsConflictError
              ? { kind: 'conflict', ...reply(await read()), message: t('Provider settings changed elsewhere') }
              : { kind: 'failed', ...reply(await read()), message: t(settingsRemoved ? 'Provider removed, but the stored credential could not be cleared' : 'The stored credential could not be cleared') }
          }
        }
        const ops: SettingsPathOp[] = []
        let key: string | undefined
        for (const form of event.submission.forms) for (const field of form.fields) {
          if (field.change === 'unchanged') continue
          const page = form.pagePath[0]?.itemId
          if (page === 'credentials' && field.id === 'key' && typeof field.value === 'string') key = field.value
          else if (page === 'connection' && field.id === 'name' && typeof field.value === 'string') ops.push({ op: 'set', path: ['providers', route, 'displayName'], value: field.value.trim() || route })
          else if (page === 'connection' && field.id === 'baseURL' && typeof field.value === 'string' && !known) {
            try {
              const url = new URL(field.value)
              if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol')
            } catch { return { kind: 'invalid', errors: [{ ...address('connection'), fieldId: 'baseURL', message: t('Enter an HTTP or HTTPS URL') }] } }
            ops.push({ op: 'set', path: ['providers', route, 'baseURL'], value: normalizeBaseURL(view.profile.api ?? 'openai-completions', field.value) })
          } else if (page === 'models' && field.id === 'reasoning' && typeof field.value === 'string') {
            ops.push(field.value === PROVIDER_DEFAULT_EFFORT
              ? { op: 'unset', path: ['providers', route, 'reasoning'] }
              : { op: 'set', path: ['providers', route, 'reasoning'], value: field.value })
          }
        }
        const selected = event.submission.selections?.find(item => item.controlId === 'advertised-models')?.selectedIds
        if (selected !== undefined) {
          const configured = configuredIds(view.profile)
          const unchanged = customModels.size === 0 && selected.length === configured.length && selected.every(modelId => configured.includes(modelId))
          if (!unchanged) ops.push({ op: 'set', path: ['providers', route, 'models'], value: selected.map(modelId => modelEntry(modelId, view.profile)) })
        }
        if (key !== undefined && (!view.credential.writable || expectedCredential !== credentialRevision)) return { kind: 'conflict', ...reply(view), message: t('The credential changed elsewhere; review before saving') }
        let settingsWritten = false
        try {
          if (ops.length > 0) { await settings.mutate(NAMESPACE, ops, expected); settingsWritten = true }
          /* v8 ignore next -- a cancellation racing the awaited native read is a lifetime path */
          if (context.signal.aborted || cancellation.aborted) return { kind: 'cancelled' }
          if (key !== undefined && key.length > 0) await credentials.set(credentialRef(openedRef!), key)
          /* v8 ignore next -- a cancellation racing the awaited native read is a lifetime path */
          if (context.signal.aborted || cancellation.aborted) return { kind: 'cancelled' }
          return { kind: 'accepted', ...reply(await read()), feedback: { severity: 'success', message: t('provider "{route}" updated', { route }) } }
        } catch (error) {
          /* v8 ignore next -- a cancellation racing the awaited native read is a lifetime path */
          if (context.signal.aborted || cancellation.aborted) return { kind: 'cancelled' }
          return error instanceof SettingsConflictError
            ? { kind: 'conflict', ...reply(await read()), message: t('Provider settings changed elsewhere') }
              : { kind: 'failed', ...reply(await read()), ...(settingsWritten ? { acceptedFields: ops.map(op => ({ ...address('connection'), fieldId: op.path.at(-1) === 'displayName' ? 'name' : 'baseURL' })) } : {}), message: t(settingsWritten ? 'Provider settings saved, but the credential could not be saved' : 'Provider configuration could not be saved') }
        }
      } },
    }, node(initial), { signal: cancellation, reopen: 'focus', onClosed: () => cleanup() })
    if (handle === undefined) { cleanup(); return true }
    discover(initial.profile)
    return true
  } catch (error) { cleanup(); releaseLifetime(); throw error }
}
