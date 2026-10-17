/** Native provider onboarding with shared drafts, model discovery, and explicit final writes.
 * @module @ephemeral-ai/mayfly/interaction/provider-add
 */
import type { Context } from '@deepseek-ai/cordis'
import { isDeepStrictEqual } from 'node:util'
import { credentialRef, credentialKeyId } from '@deepseek-ai/dsh-credentials'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import { ui, type MayflyFormAddress, type MayflyOverlayHandle, type MayflySubmission, type MayflyUiActionReply, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { loadModelsDevIndex } from './models-dev.ts'
import { persistProviders, providerAddress, providerContainer, providerDescriptor, providerDirectory, providerProfileAt, sameProviderPath } from './provider-store.ts'
import { deriveKeyRef, normalizeBaseURL } from './provider-profile.ts'
import { openUiOverlay } from './ui-overlay.ts'
import { openAuthorization } from './authorization-ui.ts'
import { interactionTranslator } from './locale.ts'

const ENDPOINT_PROTOCOLS = ['anthropic-messages', 'openai-completions', 'openai-responses'] as const
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const ROUTE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const address = (formId: string): MayflyFormAddress => ({ pagePath: [{ controlId: 'provider-tabs', itemId: formId }], formId })

function values(submission: MayflySubmission, formId: string) {
  return Object.fromEntries(submission.forms.find(form => form.formId === formId)?.fields.map(field => [field.id, field.value]) ?? [])
}

function discoveryBases(baseURL: string): string[] {
  const base = baseURL.replace(/\/+$/, '')
  return [...new Set([base, `${base}/v1`, base.replace(/\/v1$/, '')])]
}

function describeFailure(error: unknown, key: string): string {
  const parts: string[] = []
  let current = error
  for (let count = 0; count < 5 && current instanceof Error; count += 1) { parts.push(current.message); current = current.cause }
  const message = parts.join(': ') || 'Model discovery failed'
  return key.length === 0 ? message : message.replaceAll(key, '[redacted]')
}

function openEndpoint(ctx: Context, known: string | undefined, onCreated: (route: string) => void, signal?: AbortSignal): MayflyOverlayHandle {
  const settings = ctx.get('settings')!
  const credentials = ctx.get('credentials')!
  const llm = ctx.get('llm')!
  const t = interactionTranslator(ctx)
  /* The native directory owns the settings address: a known route names its
   * own profile path, while a new route joins the dict a catalog adapter
   * declares. A composition with no such adapter has nowhere to write. */
  const declared = known === undefined ? undefined : providerAddress(ctx, known)
  const container = known === undefined ? providerContainer(ctx) : declared?.container === undefined ? undefined : { ns: declared.ns, container: declared.container }
  if (known === undefined ? container === undefined : declared === undefined || declared.container === undefined) {
    throw new Error('Provider configuration is unavailable: no configurable provider route dict is declared')
  }
  const ns = known === undefined ? container!.ns : declared!.ns
  const containerPath = known === undefined ? container!.container : declared!.container!
  const profilePath = (route: string): readonly string[] => known === undefined ? [...containerPath, route] : declared!.path
  const id = known === undefined ? 'mayfly.provider.add.custom' : `mayfly.provider.add.${Buffer.from(known).toString('hex')}`
  if (ctx.mayflyOverlays.focus(id)) throw new Error('Provider setup is already open')
  let advertised: readonly LlmDiscoveredModel[] = []
  let listingBase: string | undefined
  let metadata = new Map<string, { readonly contextWindow?: number, readonly maxTokens?: number, readonly reasoningEfforts?: Record<string, string> | false }>()
  /** Hand-declared models pending the first save, keyed by model id. */
  const customModels = new Map<string, { readonly contextWindow?: number, readonly maxTokens?: number, readonly reasoningEfforts?: Record<string, string> | false }>()
  let created: { readonly route: string, readonly profile: Record<string, unknown> } | undefined
  /** The Models step stays disabled until the connection page validates once. */
  let unlocked = false
  let discoveryState: 'idle' | 'running' | 'failed' | 'done' = 'idle'
  let discoveryError = ''
  let discoveryGeneration = 0
  let discoveryAbort: AbortController | undefined
  let handle: MayflyOverlayHandle
  const descriptor = () => {
    const found = providerDescriptor(settings, ns)
    if (found === undefined) throw new Error(`Provider settings are unavailable: "${ns}" is not described`)
    return found
  }
  const source = () => [{ resourceId: ns, revision: descriptor().revision }]
  const modelsPagePath = [{ controlId: 'provider-tabs', itemId: 'models' }]
  const customModelAddress: MayflyFormAddress = { pagePath: modelsPagePath, formId: 'custom-model' }
  const modelRows = () => [...advertised.map(model => ({ id: model.id, label: model.id, ...(model.contextWindow === undefined ? {} : { detail: `${model.contextWindow} tokens` }) })),
    ...[...customModels.entries()].map(([modelId, facts]) => ({ id: modelId, label: modelId, ...(facts.contextWindow === undefined ? {} : { detail: `${facts.contextWindow} tokens` }) }))]
  const view = (): MayflyUiNode => ui.stack.column([
    ui.tabs({ id: 'provider-tabs', activeId: 'connection', items: [
      { id: 'connection', label: t('Connection') }, ...known === undefined ? [{ id: 'models', label: t('Models'), disabled: !unlocked }] : [],
    ] }),
    ui.child(ui.stack.column([
      ui.form({ id: 'connection', fields: [
        { kind: 'input', id: 'route', label: t('Provider Name'), value: known ?? created?.route ?? '', required: true, disabled: known !== undefined || created !== undefined },
        ...known === undefined ? [
          { kind: 'select' as const, id: 'protocol', label: t('Protocol'), value: String(created?.profile.api ?? 'openai-completions'), options: ENDPOINT_PROTOCOLS.map(protocol => ({ id: protocol, label: protocol })), disabled: created !== undefined },
          { kind: 'input' as const, id: 'baseURL', label: t('Base URL'), value: String(created?.profile.baseURL ?? ''), required: true, disabled: created !== undefined },
        ] : [],
        { kind: 'secret' as const, id: 'key', label: t('API key'), value: '', required: true },
      ] }),
      ...known === undefined ? [ui.actions({ id: 'connection-actions', items: [
        { id: 'next', label: t('Next step'), intent: 'primary', read: [address('connection')], disabled: created !== undefined },
      ] })] : [],
    ], { gap: 1 }), { tab: { controlId: 'provider-tabs', itemId: 'connection' } }),
    ...known !== undefined ? [] : [ui.child(ui.stack.column([
      ...discoveryState === 'running' ? [ui.loader({ message: t('discovering models…') })]
        : discoveryState === 'failed' ? [ui.text(`${t('model discovery unavailable — add models by id below')} — ${discoveryError}`, { tone: 'muted' })]
        : unlocked && discoveryState === 'idle' ? [ui.text(t('The connection changed — run discovery again'), { tone: 'muted' })] : [],
      ui.list({ id: 'advertised-models', role: 'choose', mode: 'multiple', minSelected: 1, filterable: true,
        selectedIds: created === undefined ? [...advertised.map(model => model.id), ...customModels.keys()] : (created.profile.models as { id: string }[]).map(model => model.id),
        items: modelRows(), empty: ui.empty({ title: t('No models discovered') }) }),
      ui.form({ id: 'models', fields: [
        { kind: 'number', id: 'context', label: t('Default context window'), value: null, min: 1, step: 1, unit: 'tokens' },
        { kind: 'multiselect', id: 'efforts', label: t('Thinking efforts'), value: [], options: THINKING_LEVELS.map(level => ({ id: level, label: level })) },
      ] }),
      ui.form({ id: 'custom-model', fields: [
        { kind: 'input', id: 'model-id', label: t('+ model id'), value: '', placeholder: t('model id'), disabled: created !== undefined },
      ] }),
      ui.actions({ id: 'model-actions', items: [
        { id: 'add-model', label: t('Add model'), submit: [customModelAddress], disabled: created !== undefined },
        { id: 'discover', label: t('Discover models'), read: [address('connection')], disabled: created !== undefined },
      ] }),
    ]), { tab: { controlId: 'provider-tabs', itemId: 'models' } })],
    ui.actions({ id: 'provider-setup-actions', items: [
      { id: 'save', label: t('Save'), intent: 'primary', submit: [address('connection'), ...known === undefined ? [address('models')] : []], ...(known === undefined ? { selections: [{ pagePath: modelsPagePath, controlId: 'advertised-models' }] } : {}) },
      { id: 'cancel', label: t('Cancel'), dismiss: true },
    ] }),
  ], { gap: 1 })
  /** Probe the endpoint outside the action task so the Models page shows live progress. */
  const runDiscovery = async (input: { readonly protocol: string, readonly baseURL: string, readonly key: string }): Promise<void> => {
    discoveryAbort?.abort()
    const controller = new AbortController()
    discoveryAbort = controller
    const generation = ++discoveryGeneration
    discoveryState = 'running'
    discoveryError = ''
    const combined = signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal])
    let found: readonly LlmDiscoveredModel[] | undefined
    let failure: unknown
    for (const api of new Set([input.protocol === 'anthropic-messages' ? 'openai-completions' : input.protocol, 'openai-completions'])) {
      for (const base of discoveryBases(input.baseURL)) {
        try {
          const models = await llm.discoverModels(ns, { api, baseURL: base, apiKey: input.key }, combined)
          if (models.length > 0) { found = models; listingBase = base; break }
        } catch (error) { if (combined.aborted) return; failure ??= error }
      }
      if (found !== undefined) break
    }
    if (generation !== discoveryGeneration || combined.aborted) return
    if (found === undefined) {
      discoveryState = 'failed'
      discoveryError = describeFailure(failure, input.key)
    } else {
      const catalog = await loadModelsDevIndex(ctx, combined)
      if (generation !== discoveryGeneration || combined.aborted) return
      advertised = found
      metadata = new Map(found.map(model => {
        const matched = catalog?.lookup(model.id)
        const contextWindow = model.contextWindow ?? matched?.contextWindow
        const maxTokens = model.maxTokens ?? matched?.maxTokens
        return [model.id, {
          ...(contextWindow === undefined ? {} : { contextWindow }),
          ...(maxTokens === undefined ? {} : { maxTokens }),
          ...(matched?.efforts !== undefined ? { reasoningEfforts: Object.fromEntries(matched.efforts.map(level => [level, level])) } : matched?.nonReasoning === true ? { reasoningEfforts: false as const } : {}),
        }]
      }))
      discoveryState = 'done'
    }
    /* Closed handles make set() a no-op, so repainting is safe unconditionally. */
    handle.set(view(), { source: source() })
  }
  /** Stage one hand-declared model; the first save writes it with any catalog facts. */
  const addModel = async (fields: readonly { id: string, value?: unknown }[], cancellation: AbortSignal): Promise<MayflyUiActionReply> => {
    const modelId = String(fields.find(field => field.id === 'model-id')?.value ?? '').trim()
    const field = { ...customModelAddress, fieldId: 'model-id' }
    if (modelId === '') return { kind: 'invalid', errors: [{ ...field, message: t('Enter a model ID') }] }
    if (customModels.has(modelId) || advertised.some(model => model.id === modelId)) return { kind: 'invalid', errors: [{ ...field, message: t('Already listed') }] }
    const matched = (await loadModelsDevIndex(ctx, cancellation))?.lookup(modelId)
    if (cancellation.aborted) return { kind: 'cancelled' }
    customModels.set(modelId, {
      ...(matched?.contextWindow === undefined ? {} : { contextWindow: matched.contextWindow }),
      ...(matched?.maxTokens === undefined ? {} : { maxTokens: matched.maxTokens }),
      ...(matched?.efforts !== undefined ? { reasoningEfforts: Object.fromEntries(matched.efforts.map(level => [level, level])) } : matched?.nonReasoning === true ? { reasoningEfforts: false as const } : {}),
    })
    return { kind: 'accepted', node: view(), source: source(), feedback: { severity: 'success', message: t('Model "{model}" added — save to persist', { model: modelId }) } }
  }
  const handler = async (submission: MayflySubmission, operation: 'discover' | 'save', cancellation: AbortSignal): Promise<MayflyUiActionReply> => {
    const connection = values(submission, 'connection')
    const route = known ?? String(connection.route ?? '').trim()
    const key = String(connection.key ?? '')
    const protocol = known === undefined ? String(connection.protocol) : undefined
    const baseURL = String(connection.baseURL ?? '')
    if (!ROUTE_ID.test(route)) return { kind: 'invalid', errors: [{ ...address('connection'), fieldId: 'route', message: t('Provider names use lowercase letters, digits, and hyphens') }] }
    const current = descriptor()
    if (created === undefined && providerProfileAt(current.value, profilePath(route)) !== undefined) return { kind: 'invalid', errors: [{ ...address('connection'), fieldId: 'route', message: t('This provider already exists') }] }
    if (known === undefined) {
      try { const url = new URL(baseURL); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol') }
      catch { return { kind: 'invalid', errors: [{ ...address('connection'), fieldId: 'baseURL', message: t('Enter an HTTP or HTTPS URL') }] } }
    }
    if (operation === 'discover') {
      unlocked = true
      void runDiscovery({ protocol: protocol!, baseURL, key })
      /* A reply's snapshot publishes only after this handler returns, so an
       * `accepted` frame here could land after the probe's own `handle.set`
       * and revert the settled result. Publish the unlocked/loading frame
       * directly and answer `completed`: every later repaint flows through
       * the same handle in call order. */
      handle.set(view(), { source: source() })
      return { kind: 'completed', navigate: modelsPagePath }
    }
    const expected = submission.source.find(stamp => stamp.resourceId === ns)?.revision
    if (typeof expected !== 'number' || expected !== current.revision) return { kind: 'conflict', node: view(), source: source(), message: t('Provider settings changed elsewhere') }
    if (created !== undefined) {
      const stored = providerProfileAt(current.user, profilePath(created.route))
      if (created.route !== route || !isDeepStrictEqual(stored, created.profile)) return { kind: 'conflict', node: view(), source: source(), message: t('The created provider changed; reopen its configuration') }
    }
    const modelDefaults = values(submission, 'models')
    const selected = submission.selections?.find(selection => selection.controlId === 'advertised-models')?.selectedIds ?? []
    const profile: Record<string, unknown> = known === undefined ? {
      api: protocol, baseURL: normalizeBaseURL(protocol!, baseURL, listingBase), apiKeyEnv: deriveKeyRef(route),
      models: selected.map(id => {
        const facts = metadata.get(id) ?? customModels.get(id) ?? {}
        const contextWindow = facts.contextWindow ?? (typeof modelDefaults.context === 'number' ? modelDefaults.context : undefined)
        const reasoningEfforts = facts.reasoningEfforts ?? (Array.isArray(modelDefaults.efforts) && modelDefaults.efforts.length > 0 ? Object.fromEntries(modelDefaults.efforts.map(level => [level, level])) : undefined)
        return { id, ...facts, ...(contextWindow === undefined ? {} : { contextWindow }), ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }) }
      }),
    } : { apiKeyEnv: deriveKeyRef(route) }
    try {
      if (created === undefined) {
        await persistProviders(settings, ns, [{ op: 'set', path: profilePath(route), value: profile }], expected)
        created = { route, profile }
      }
      if (cancellation.aborted) return { kind: 'cancelled' }
      await credentials.set(credentialRef(deriveKeyRef(route)), key)
      if (cancellation.aborted) return { kind: 'cancelled' }
      onCreated(route)
      return { kind: 'accepted', node: view(), source: source(), dismiss: true, feedback: { severity: 'success', message: t('provider "{route}" added', { route }) } }
    } catch (error) {
      if (cancellation.aborted) return { kind: 'cancelled' }
      return error instanceof SettingsConflictError
        ? { kind: 'conflict', node: view(), source: source(), message: t('Provider settings changed elsewhere') }
        : { kind: 'failed', node: view(), source: source(), ...(created === undefined ? {} : { acceptedFields: submission.forms.filter(form => form.formId === 'connection').flatMap(form => form.fields.filter(field => field.id !== 'key').map(field => ({ ...address('connection'), fieldId: field.id }))) }), message: t(created === undefined ? 'Provider could not be added' : 'Provider created, but its credential could not be saved') }
    }
  }
  handle = openUiOverlay(ctx, {
    id, title: t(known === undefined ? 'Custom endpoint' : 'Configure {route}', { route: known ?? '' }), presentation: 'editor', capturing: true,
    scope: { kind: 'app', targetId: known ?? 'provider-creation' }, source: source(),
    onEvent: {
      observe: event => {
      if (event.kind === 'value-change' && known === undefined && created === undefined && ['protocol', 'baseURL', 'key'].includes(event.controlId) && (advertised.length > 0 || discoveryState !== 'idle')) {
        advertised = []; metadata.clear(); listingBase = undefined; discoveryState = 'idle'; discoveryError = ''
        discoveryGeneration += 1; discoveryAbort?.abort()
        handle.set(view(), { source: source() })
      }
      },
      action: (event, context) => {
        if (event.kind === 'submit') return event.submission.actionId === 'add-model'
          ? addModel(event.submission.forms.flatMap(form => form.fields), context.signal)
          : handler(event.submission, 'save', context.signal)
        return event.kind === 'activate' && (event.actionId === 'next' || event.actionId === 'discover') && event.inputs !== undefined
          ? handler(event.inputs, 'discover', context.signal) : { kind: 'completed' }
      },
    },
  }, view(), { signal, reopen: 'replace', onClosed: () => discoveryAbort?.abort() })
  return handle
}

/** Open a source chooser; all configuration input remains in shared surface instances. */
export function openProviderSetup(ctx: Context, onCreated: (route: string) => void, signal?: AbortSignal): void {
  const overlays = ctx.get('mayflyOverlays')
  const settings = ctx.get('settings')
  const llm = ctx.get('llm')
  if (overlays === undefined || settings === undefined || llm === undefined || ctx.get('credentials') === undefined) throw new Error('Provider setup requires settings, credentials, llm, and overlays')
  if (overlays.focus('mayfly.provider.add')) return
  const container = providerContainer(ctx)
  if (container === undefined) throw new Error('Provider setup is unavailable: no configurable provider route dict is declared')
  const directory = providerDirectory(ctx)
  const ownedBy = (entry: { readonly settingsNs: string, readonly settingsPath: readonly string[] }): boolean =>
    entry.settingsNs === container.ns && sameProviderPath(entry.settingsPath.slice(0, -1), container.container)
  const t = interactionTranslator(ctx)
  openUiOverlay(ctx, {
    id: 'mayfly.provider.add', title: t('Add provider'), presentation: 'editor', capturing: true, scope: { kind: 'app', targetId: 'provider-creation' },
    onEvent: { action: event => {
      if (event.kind !== 'selection-accept') return { kind: 'completed' }
      const kind = event.selectedIds[0]
      if (kind === 'custom') { openEndpoint(ctx, undefined, onCreated, signal); return { kind: 'completed' } }
      const active = new Set(llm.listProviders().map(provider => provider.id))
      const rows = kind === 'oauth'
        /* A flow's key id is the adapter's route. Offer only routes the native
           directory says can authenticate from a stored sign-in; the key
           namespace itself is never guessed. */
        ? (() => {
            const oauth = new Map(directory.filter(ownedBy).filter(entry => entry.nativeAuth?.oauth === true).map(entry => [entry.provider, entry]))
            return (ctx.get('authorization')?.list() ?? []).flatMap(flow => {
              const route = oauth.get(credentialKeyId(flow.key))
              return route === undefined || !flow.methods.some(method => method.id === 'oauth') || active.has(route.provider)
                ? [] : [{ id: route.provider, label: route.displayName }]
            })
          })()
        : directory.filter(entry => ownedBy(entry) && !active.has(entry.provider)).map(entry => ({ id: entry.provider, label: entry.displayName }))
      const pickerId = `mayfly.provider.add.${kind}`
      if (overlays.focus(pickerId)) return { kind: 'completed' }
      openUiOverlay(ctx, {
        id: pickerId, title: t(kind === 'oauth' ? 'OAuth provider' : 'Known provider'), presentation: 'editor', capturing: true, scope: { kind: 'app', targetId: 'provider-creation' },
        onEvent: { action: selected => {
          if (selected.kind !== 'selection-accept') return { kind: 'completed' }
          const route = selected.selectedIds[0]!
          if (kind === 'oauth') openAuthorization(ctx, route, async () => {
            const descriptor = providerDescriptor(settings, container.ns)
            if (descriptor === undefined) throw new Error(`Provider settings are unavailable: "${container.ns}" is not described`)
            if (providerProfileAt(descriptor.value, [...container.container, route]) === undefined) {
              await persistProviders(settings, container.ns, [{ op: 'set', path: [...container.container, route], value: {} }], descriptor.revision)
            }
            onCreated(route)
          }, signal)
          else openEndpoint(ctx, route, onCreated, signal)
          return { kind: 'completed' }
        } },
      }, ui.list({ id: 'providers', role: 'browse', selectedIds: [], items: rows, filterable: true, empty: ui.empty({ title: t('No providers available') }) }), { signal, reopen: 'focus' })
      return { kind: 'completed' }
    } },
  }, ui.list({ id: 'provider-source', role: 'browse', numbered: true, selectedIds: [], items: [{ id: 'known', label: t('Known provider') }, { id: 'custom', label: t('Custom endpoint') }, { id: 'oauth', label: t('OAuth provider') }] }), { signal, reopen: 'focus' })
}
