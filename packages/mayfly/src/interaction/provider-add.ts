/** Native provider onboarding with shared drafts, model discovery, and explicit final writes.
 * @module @ephemeral-ai/mayfly/interaction/provider-add
 */
import type { Context } from '@deepseek-ai/cordis'
import { isDeepStrictEqual } from 'node:util'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import { ui, type MayflyFormAddress, type MayflyOverlayHandle, type MayflySubmission, type MayflyUiActionReply, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { loadModelsDevIndex } from './models-dev.ts'
import { deriveKeyRef, normalizeBaseURL, providerProfile } from './provider-profile.ts'
import { openUiOverlay } from './ui-overlay.ts'
import { openAuthorization } from './authorization-ui.ts'
import { interactionTranslator } from './locale.ts'

export const ENDPOINT_PROTOCOLS = ['anthropic-messages', 'openai-completions', 'openai-responses'] as const
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const NAMESPACE = 'llm-pi-ai'
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
  const id = known === undefined ? 'mayfly.provider.add.custom' : `mayfly.provider.add.${Buffer.from(known).toString('hex')}`
  if (ctx.mayflyOverlays.focus(id)) throw new Error('Provider setup is already open')
  let advertised: readonly LlmDiscoveredModel[] = []
  let listingBase: string | undefined
  let metadata = new Map<string, { readonly contextWindow?: number, readonly maxTokens?: number, readonly reasoningEfforts?: Record<string, string> | false }>()
  let created: { readonly route: string, readonly profile: Record<string, unknown> } | undefined
  let handle: MayflyOverlayHandle
  const descriptor = () => settings.describe().find(item => String(item.ns) === NAMESPACE)!
  const source = () => [{ resourceId: NAMESPACE, revision: descriptor().revision }]
  const view = (): MayflyUiNode => ui.stack.column([
    ui.tabs({ id: 'provider-tabs', activeId: 'connection', items: [
      { id: 'connection', label: t('Connection') }, ...known === undefined ? [{ id: 'models', label: t('Models') }] : [], { id: 'credentials', label: t('Credentials') },
    ] }),
    ui.child(ui.form({ id: 'connection', fields: [
      { kind: 'input', id: 'route', label: t('Provider Name'), value: known ?? created?.route ?? '', required: true, disabled: known !== undefined || created !== undefined },
      ...known === undefined ? [
        { kind: 'select' as const, id: 'protocol', label: t('Protocol'), value: String(created?.profile.api ?? 'openai-completions'), options: ENDPOINT_PROTOCOLS.map(protocol => ({ id: protocol, label: protocol })), disabled: created !== undefined },
        { kind: 'input' as const, id: 'baseURL', label: t('Base URL'), value: String(created?.profile.baseURL ?? ''), required: true, disabled: created !== undefined },
      ] : [],
    ] }), { tab: { controlId: 'provider-tabs', itemId: 'connection' } }),
    ...known !== undefined ? [] : [ui.child(ui.stack.column([
      ui.list({ id: 'advertised-models', role: 'choose', mode: 'multiple', minSelected: 1, selectedIds: created === undefined ? [] : (created.profile.models as { id: string }[]).map(model => model.id), items: advertised.map(model => ({ id: model.id, label: model.id, ...(model.contextWindow === undefined ? {} : { detail: `${model.contextWindow} tokens` }) })), empty: ui.empty({ title: t('No models discovered') }) }),
      ui.form({ id: 'models', fields: [
        { kind: 'number', id: 'context', label: t('Default context window'), value: null, min: 1, step: 1, unit: 'tokens' },
        { kind: 'multiselect', id: 'efforts', label: t('Thinking efforts'), value: [], options: THINKING_LEVELS.map(level => ({ id: level, label: level })) },
      ] }),
    ]), { tab: { controlId: 'provider-tabs', itemId: 'models' } })],
    ui.child(ui.form({ id: 'credentials', fields: [{ kind: 'secret', id: 'key', label: t('API key'), value: '', required: true }] }), { tab: { controlId: 'provider-tabs', itemId: 'credentials' } }),
    ui.actions({ id: 'provider-setup-actions', items: [
      ...known === undefined ? [{ id: 'discover', label: t('Discover models'), read: [address('connection'), address('credentials')], disabled: created !== undefined }] : [],
      { id: 'save', label: t('Save'), intent: 'primary', submit: [address('connection'), ...known === undefined ? [address('models')] : [], address('credentials')], ...(known === undefined ? { selections: [{ pagePath: [{ controlId: 'provider-tabs', itemId: 'models' }], controlId: 'advertised-models' }] } : {}), disabled: known === undefined && advertised.length === 0 },
      { id: 'cancel', label: t('Cancel'), dismiss: true },
    ] }),
  ], { gap: 1 })
  const handler = async (submission: MayflySubmission, operation: 'discover' | 'save', cancellation: AbortSignal): Promise<MayflyUiActionReply> => {
    const connection = values(submission, 'connection')
    const secret = values(submission, 'credentials')
    const route = known ?? String(connection.route ?? '').trim()
    const key = String(secret.key ?? '')
    const protocol = known === undefined ? String(connection.protocol) : undefined
    const baseURL = String(connection.baseURL ?? '')
    if (!ROUTE_ID.test(route)) return { kind: 'invalid', errors: [{ ...address('connection'), fieldId: 'route', message: t('Provider names use lowercase letters, digits, and hyphens') }] }
    const current = descriptor()
    if (created === undefined && providerProfile(current.value, route) !== undefined) return { kind: 'invalid', errors: [{ ...address('connection'), fieldId: 'route', message: t('This provider already exists') }] }
    if (known === undefined) {
      try { const url = new URL(baseURL); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol') }
      catch { return { kind: 'invalid', errors: [{ ...address('connection'), fieldId: 'baseURL', message: t('Enter an HTTP or HTTPS URL') }] } }
    }
    if (operation === 'discover') {
      let found: readonly LlmDiscoveredModel[] | undefined
      let failure: unknown
      for (const api of new Set([protocol === 'anthropic-messages' ? 'openai-completions' : protocol!, 'openai-completions'])) {
        for (const base of discoveryBases(baseURL)) {
          try {
            const models = await llm.discoverModels(NAMESPACE, { api, baseURL: base, apiKey: key }, cancellation)
            cancellation.throwIfAborted()
            if (models.length > 0) { found = models; listingBase = base; break }
          } catch (error) { if (cancellation.aborted) return { kind: 'cancelled' }; failure ??= error }
        }
        if (found !== undefined) break
      }
      if (found === undefined) return { kind: 'failed', message: describeFailure(failure, key) }
      const catalog = await loadModelsDevIndex(ctx, cancellation)
      if (cancellation.aborted) return { kind: 'cancelled' }
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
      return { kind: 'accepted', node: view(), source: source(), navigate: [{ controlId: 'provider-tabs', itemId: 'models' }] }
    }
    const expected = submission.source.find(stamp => stamp.resourceId === NAMESPACE)?.revision
    if (typeof expected !== 'number' || expected !== current.revision) return { kind: 'conflict', node: view(), source: source(), message: t('Provider settings changed elsewhere') }
    if (created !== undefined) {
      const stored = providerProfile(current.user, created.route)
      if (created.route !== route || !isDeepStrictEqual(stored, created.profile)) return { kind: 'conflict', node: view(), source: source(), message: t('The created provider changed; reopen its configuration') }
    }
    const modelDefaults = values(submission, 'models')
    const selected = submission.selections?.find(selection => selection.controlId === 'advertised-models')?.selectedIds ?? []
    const profile: Record<string, unknown> = known === undefined ? {
      api: protocol, baseURL: normalizeBaseURL(protocol!, baseURL, listingBase), apiKeyEnv: deriveKeyRef(route),
      models: selected.map(id => {
        const facts = metadata.get(id) ?? {}
        const contextWindow = facts.contextWindow ?? (typeof modelDefaults.context === 'number' ? modelDefaults.context : undefined)
        const reasoningEfforts = facts.reasoningEfforts ?? (Array.isArray(modelDefaults.efforts) && modelDefaults.efforts.length > 0 ? Object.fromEntries(modelDefaults.efforts.map(level => [level, level])) : undefined)
        return { id, ...facts, ...(contextWindow === undefined ? {} : { contextWindow }), ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }) }
      }),
    } : { apiKeyEnv: deriveKeyRef(route) }
    try {
      if (created === undefined) {
        await settings.mutate(NAMESPACE, [{ op: 'set', path: ['providers', route], value: profile }], expected)
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
        : { kind: 'failed', node: view(), source: source(), ...(created === undefined ? {} : { acceptedFields: submission.forms.filter(form => form.formId === 'connection').flatMap(form => form.fields.map(field => ({ ...address('connection'), fieldId: field.id }))) }), message: t(created === undefined ? 'Provider could not be added' : 'Provider created, but its credential could not be saved') }
    }
  }
  handle = openUiOverlay(ctx, {
    id, title: t(known === undefined ? 'Custom endpoint' : 'Configure {route}', { route: known ?? '' }), presentation: 'editor', capturing: true,
    scope: { kind: 'app', targetId: known ?? 'provider-creation' }, source: source(),
    onEvent: {
      observe: event => {
      if (event.kind === 'value-change' && known === undefined && created === undefined && ['protocol', 'baseURL', 'key'].includes(event.controlId) && advertised.length > 0) {
        advertised = []; metadata.clear(); listingBase = undefined
        if (!handle.closed) handle.set(view(), { source: source() })
      }
      },
      action: (event, context) => event.kind === 'submit' ? handler(event.submission, 'save', context.signal)
        : event.kind === 'activate' && event.actionId === 'discover' && event.inputs !== undefined ? handler(event.inputs, 'discover', context.signal) : { kind: 'completed' },
    },
  }, view(), signal)
  return handle
}

/** Open a source chooser; all configuration input remains in shared surface instances. */
export function openProviderSetup(ctx: Context, onCreated: (route: string) => void, signal?: AbortSignal): void {
  const overlays = ctx.get('mayflyOverlays')
  const settings = ctx.get('settings')
  const llm = ctx.get('llm')
  if (overlays === undefined || settings === undefined || llm === undefined || ctx.get('credentials') === undefined) throw new Error('Provider setup requires settings, credentials, llm, and overlays')
  if (overlays.focus('mayfly.provider.add')) return
  const t = interactionTranslator(ctx)
  openUiOverlay(ctx, {
    id: 'mayfly.provider.add', title: t('Add provider'), presentation: 'editor', capturing: true, scope: { kind: 'app', targetId: 'provider-creation' },
    onEvent: { action: event => {
      if (event.kind !== 'selection-accept') return { kind: 'completed' }
      const kind = event.selectedIds[0]
      if (kind === 'custom') { openEndpoint(ctx, undefined, onCreated, signal); return { kind: 'completed' } }
      const active = new Set(llm.listProviders().map(provider => provider.id))
      const rows = kind === 'oauth'
        ? (ctx.get('authorization')?.list() ?? []).filter(entry => String(entry.key).startsWith('llm-pi-ai/') && entry.methods.some(method => method.id === 'oauth')).map(entry => ({ id: String(entry.key).slice('llm-pi-ai/'.length), label: entry.label })).filter(entry => !active.has(entry.id))
        : llm.listConfigurableProviders().filter(provider => provider.settingsNs === NAMESPACE && !active.has(provider.provider)).map(provider => ({ id: provider.provider, label: provider.displayName }))
      const pickerId = `mayfly.provider.add.${kind}`
      if (overlays.focus(pickerId)) return { kind: 'completed' }
      openUiOverlay(ctx, {
        id: pickerId, title: t(kind === 'oauth' ? 'OAuth provider' : 'Known provider'), presentation: 'editor', capturing: true, scope: { kind: 'app', targetId: 'provider-creation' },
        onEvent: { action: selected => {
          if (selected.kind !== 'selection-accept') return { kind: 'completed' }
          const route = selected.selectedIds[0]!
          if (kind === 'oauth') openAuthorization(ctx, route, async () => {
            const descriptor = settings.describe().find(item => String(item.ns) === NAMESPACE)!
            if (providerProfile(descriptor.value, route) === undefined) await settings.mutate(NAMESPACE, [{ op: 'set', path: ['providers', route], value: {} }], descriptor.revision)
            onCreated(route)
          }, signal)
          else openEndpoint(ctx, route, onCreated, signal)
          return { kind: 'completed' }
        } },
      }, ui.list({ id: 'providers', role: 'browse', selectedIds: [], items: rows, filterable: true, empty: ui.empty({ title: t('No providers available') }) }), signal)
      return { kind: 'completed' }
    } },
  }, ui.list({ id: 'provider-source', role: 'browse', selectedIds: [], items: [{ id: 'known', label: t('Known provider') }, { id: 'custom', label: t('Custom endpoint') }, { id: 'oauth', label: t('OAuth provider') }] }), signal)
}
