/** App-scoped provider editing through native settings/credentials and shared editor overlays.
 * @module @ephemeral-ai/mayfly/interaction/provider-edit
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialInfo } from '@deepseek-ai/dsh-credentials'
import { SettingsConflictError, type SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-llm'
import { ui, type MayflyFormAddress, type MayflyOverlayHandle, type MayflySourceStamp, type MayflyUiActionReply, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { deriveKeyRef, normalizeBaseURL, providerProfile, type ProviderProfile } from './provider-profile.ts'
import { interactionTranslator, observeInteractionLocale } from './locale.ts'

const NAMESPACE = 'llm-pi-ai'
const address = (itemId: string): MayflyFormAddress => ({ pagePath: [{ controlId: 'provider-pages', itemId }], formId: 'provider' })

interface ProviderView {
  readonly profile: ProviderProfile | undefined
  readonly revision: number
  readonly ref: string
  readonly credential: CredentialInfo
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
  const node = (view: ProviderView): MayflyUiNode => {
    if (view.profile === undefined || (openedRef !== undefined && view.ref !== openedRef)) return ui.stack.column([
      ui.text(t(view.profile === undefined ? 'Provider configuration is no longer available' : 'Provider credential reference changed; reopen the provider')),
      ui.actions({ id: 'provider-closed-actions', items: [{ id: 'close', label: t('Close'), dismiss: true }] }),
    ])
    const writable = settings.writable
    return ui.stack.column([
      ui.tabs({ id: 'provider-pages', activeId: 'connection', items: [{ id: 'connection', label: t('Connection') }, { id: 'credentials', label: t('Credentials') }] }),
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
        { id: 'save', label: t('Save'), intent: 'primary', submit: [address('connection'), address('credentials')], disabled: !writable },
        { id: 'cancel', label: t('Cancel'), dismiss: true },
        { id: 'delete', label: t('Delete provider'), intent: 'danger', disabled: !writable, confirm: t('Delete provider "{route}"?', { route }) },
      ] }),
    ], { gap: 1 })
  }
  const reply = (view: ProviderView): { readonly node: MayflyUiNode, readonly source: readonly MayflySourceStamp[] } => ({ node: node(view), source: source(view) })
  const refresh = async (): Promise<void> => {
    const generation = ++refreshGeneration
    try {
      const view = await read()
      if (cancellation.aborted || handle!.closed || generation !== refreshGeneration) return
      handle!.set(node(view), { reason: view.ref !== openedRef ? 'replace' : 'data', source: source(view) })
    } catch { /* explicit operations present failures; stale background reads cannot replace drafts */ }
  }
  try {
    const initial = await read()
    if (initial.profile === undefined) { releaseLifetime(); return false }
    if (overlays.focus(id)) { releaseLifetime(); return true }
    openedRef = initial.ref
    const offSettings = ctx.on('settings/document-updated', ns => { if (String(ns) === NAMESPACE) void refresh() })
    const offValues = ctx.on('settings/updated', ns => { if (String(ns) === NAMESPACE) void refresh() })
    const offCredential = ctx.on('credentials/reference-updated', ref => {
      if (String(ref) === openedRef) { credentialRevision += 1; void refresh() }
    })
    const offLocale = observeInteractionLocale(ctx, () => { void refresh() })
    cleanup = ctx.effect(() => () => { offSettings(); offValues(); offCredential(); offLocale(); releaseLifetime() })
    handle = overlays.open({
      id, title: t('Configure {route}', { route }), presentation: 'editor', capturing: true,
      scope: { kind: 'app', targetId: `${NAMESPACE}/${route}` }, source: source(initial),
      onEvent: { action: async (event, context): Promise<MayflyUiActionReply> => {
        if (event.kind !== 'submit' && event.kind !== 'activate') return { kind: 'completed' }
        if (context.signal.aborted || cancellation.aborted) return { kind: 'cancelled' }
        const view = await read()
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
            if (context.signal.aborted || cancellation.aborted) return { kind: 'cancelled' }
            if (!view.credential.writable) return { kind: 'accepted', ...reply(await read()), feedback: { severity: 'warning', message: t('Provider removed; its external credential remains unchanged') } }
            await credentials.unset(credentialRef(openedRef!))
            if (context.signal.aborted || cancellation.aborted) return { kind: 'cancelled' }
            return { kind: 'accepted', ...reply(await read()), feedback: { severity: 'success', message: t(event.actionId === 'delete' ? 'Provider removed' : 'Stored API key cleared') } }
          } catch (error) {
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
          }
        }
        if (key !== undefined && (!view.credential.writable || expectedCredential !== credentialRevision)) return { kind: 'conflict', ...reply(view), message: t('The credential changed elsewhere; review before saving') }
        let settingsWritten = false
        try {
          if (ops.length > 0) { await settings.mutate(NAMESPACE, ops, expected); settingsWritten = true }
          if (context.signal.aborted || cancellation.aborted) return { kind: 'cancelled' }
          if (key !== undefined && key.length > 0) await credentials.set(credentialRef(openedRef!), key)
          if (context.signal.aborted || cancellation.aborted) return { kind: 'cancelled' }
          return { kind: 'accepted', ...reply(await read()), feedback: { severity: 'success', message: t('provider "{route}" updated', { route }) } }
        } catch (error) {
          if (context.signal.aborted || cancellation.aborted) return { kind: 'cancelled' }
          return error instanceof SettingsConflictError
            ? { kind: 'conflict', ...reply(await read()), message: t('Provider settings changed elsewhere') }
              : { kind: 'failed', ...reply(await read()), ...(settingsWritten ? { acceptedFields: ops.map(op => ({ ...address('connection'), fieldId: op.path.at(-1) === 'displayName' ? 'name' : 'baseURL' })) } : {}), message: t(settingsWritten ? 'Provider settings saved, but the credential could not be saved' : 'Provider configuration could not be saved') }
        }
      } },
    }, node(initial))
    const closeOnAbort = () => handle?.close()
    cancellation.addEventListener('abort', closeOnAbort, { once: true })
    const offOverlay = overlays.subscribe(delta => {
      if (delta.kind === 'remove' && delta.id === id && handle!.closed) { cancellation.removeEventListener('abort', closeOnAbort); offOverlay(); cleanup() }
    })
    return true
  } catch (error) { cleanup(); releaseLifetime(); throw error }
}
