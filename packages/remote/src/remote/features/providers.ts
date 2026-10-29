/**
 * Provider directory, editing, discovery, and write-only credential operations
 * through official LLM, settings, and credentials Remotes.
 * @module @ephemeral-ai/mayfly/remote/features/providers
 */

import type {
  CredentialInfo,
  LlmConfigurableProvider,
  LlmDiscoveredModel,
  LlmModelDiscoveryRequest,
  LlmProviderInfo,
  SettingsDescribeValue,
  SettingsNamespaceView,
  SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { HostClient } from '../../client/types.ts'
import type { RemoteFeatureContext } from './contracts.ts'
import {
  onRemoteSettingsDocumentUpdated,
  RemoteFeatureController,
  RemoteFeatureOperation,
  remoteErrorMessage,
  remoteValue,
} from './official.ts'
import { openRemoteFeaturePanel, type RemoteMountedPanel, type RemotePanelModel } from './panel.ts'
import {
  deriveRemoteProviderKeyRef,
  normalizeRemoteProviderBaseURL,
  remoteProviderAddress,
  remoteProviderContainer,
  remoteProviderDiscoveryBases,
  remoteProviderProfileAt,
  REMOTE_PROVIDER_ROUTE,
  type RemoteProviderProfile,
} from './provider-profile.ts'

/** Generic OAuth operation streams are not mounted by the official Client assembly. */
export const REMOTE_AUTHORIZATION_GAP = 'Generic provider authorization requires the Host authorization operation-stream DTO.'
/** API keys never reach the TUI; API-key balance requires a Host-side providerBalance DTO. */
export const REMOTE_PROVIDER_BALANCE_GAP = 'Official API-key provider balance requires a Host providerBalance DTO; Remote never receives the key.'

const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const
const EFFORTS = ['default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const ACCOUNT_PROVIDER = 'deepseek-account'

type SettingValue = Extract<SettingsPathOpView, { readonly op: 'set' }>['value']

/** One redacted provider directory snapshot. */
export interface RemoteProviderDirectory {
  readonly live: readonly LlmProviderInfo[]
  readonly configurable: readonly LlmConfigurableProvider[]
  readonly settings: SettingsDescribeValue
}

/** Read every credential reference named by the native provider directory. */
export function remoteProviderCredentialRefs(directory: RemoteProviderDirectory): readonly string[] {
  const refs = new Set(['DEEPSEEK_API_KEY'])
  for (const provider of directory.live) refs.add(deriveRemoteProviderKeyRef(provider.id))
  for (const entry of directory.configurable) {
    const descriptor = directory.settings.namespaces.find((candidate: SettingsNamespaceView) => candidate.ns === entry.settingsNs)
    const profile = descriptor === undefined ? undefined : remoteProviderProfileAt(descriptor.value, entry.settingsPath)
    if (typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0) refs.add(profile.apiKeyEnv)
  }
  return [...refs]
}

/** Provider controller for one feature mount. */
export class RemoteProvidersController extends RemoteFeatureController {
  constructor(context: RemoteFeatureContext, private readonly openAccount?: (client: HostClient) => Promise<void>) {
    super(context)
  }

  /** Read a complete redacted provider directory for an attached Host. */
  async directory(client: HostClient): Promise<RemoteProviderDirectory | undefined> {
    const operation = this.hostOperation(client)
    if (operation === undefined) return undefined
    try {
      const [live, configurable, settings] = await Promise.all([
        remoteValue(client.remote.llm.listProviders()),
        remoteValue(client.remote.llm.listConfigurableProviders()),
        remoteValue(client.remote.settings.describe()),
      ])
      return operation.valid() ? { live, configurable, settings } : undefined
    } finally { operation.dispose() }
  }

  /** Discover one draft endpoint; a one-shot key is never retained in feature state. */
  async discover(client: HostClient, settingsNs: string, request: LlmModelDiscoveryRequest): Promise<readonly LlmDiscoveredModel[]> {
    const operation = this.hostOperation(client)
    if (operation === undefined) return []
    try { return await this.discoverInOperation(operation, settingsNs, request) }
    catch (error) { throw new Error(remoteErrorMessage(error, request.apiKey === undefined ? [] : [request.apiKey])) }
    finally { operation.dispose() }
  }

  /** Store a write-only credential after checking its current writable/configured state. */
  async setCredential(client: HostClient, ref: string, value: string, replace = false): Promise<void> {
    const operation = this.hostOperation(client)
    if (operation === undefined) return
    try {
      const info = await remoteValue(client.remote.credentials.describe([ref]))
      if (!operation.valid()) return
      const credential = info[ref]
      if (credential === undefined || !credential.writable) throw new Error(this.context.t('The credential source is read-only'))
      if (credential.configured && !replace) throw new Error(this.context.t('A credential was configured elsewhere; review before replacing it'))
      await remoteValue(client.remote.credentials.set(ref, value))
    } catch (error) {
      throw new Error(remoteErrorMessage(error, [value]))
    } finally { operation.dispose() }
  }

  /** Clear a credential without reading or returning its value. */
  async unsetCredential(client: HostClient, ref: string): Promise<void> {
    const operation = this.hostOperation(client)
    if (operation === undefined) return
    try { await remoteValue(client.remote.credentials.unset(ref)) }
    finally { operation.dispose() }
  }

  /** Remove a provider profile, then clear only its configured stored credential. */
  async remove(client: HostClient, route: string): Promise<void> {
    const operation = this.hostOperation(client)
    if (operation === undefined) return
    try {
      const [configurable, settings] = await Promise.all([
        remoteValue(client.remote.llm.listConfigurableProviders()),
        remoteValue(client.remote.settings.describe()),
      ])
      const address = remoteProviderAddress(configurable, route)
      if (address === undefined || address.path.length === 0) throw new Error(this.context.t('The provider has no editable configuration'))
      const descriptor = settings.namespaces.find((candidate: SettingsNamespaceView) => candidate.ns === address.ns)
      const profile = descriptor === undefined ? undefined : remoteProviderProfileAt(descriptor.value, address.path)
      if (descriptor === undefined || profile === undefined) throw new Error(this.context.t('Provider configuration is no longer available'))
      const projected = JSON.stringify(profile)
      const latest = await remoteValue(client.remote.settings.describe())
      const current = latest.namespaces.find((candidate: SettingsNamespaceView) => candidate.ns === address.ns)
      if (current === undefined || current.revision !== descriptor.revision || JSON.stringify(remoteProviderProfileAt(current.value, address.path)) !== projected) {
        throw new Error(this.context.t('Provider settings changed elsewhere'))
      }
      await remoteValue(client.remote.settings.mutate(address.ns, [{ op: 'unset', path: [...address.path] }], descriptor.revision))
      const ref = profile.apiKeyEnv ?? deriveRemoteProviderKeyRef(route)
      try {
        const credential = await remoteValue(client.remote.credentials.describe([ref]))
        if (credential[ref]?.configured === true) await remoteValue(client.remote.credentials.unset(ref))
      } catch (error) {
        throw new Error(`${this.context.t('Provider removed, but the stored credential could not be cleared')}: ${remoteErrorMessage(error)}`)
      }
      if (operation.valid()) this.context.notice.set(this.context.t('Provider removed'))
    } finally { operation.dispose() }
  }

  /** Explicit unsupported API-key balance behavior; Platform account balance lives in account.ts. */
  apiKeyBalance(): never { throw new Error(REMOTE_PROVIDER_BALANCE_GAP) }

  /** Open the merged live/dormant provider roster. */
  async open(client = this.context.hosts.current()?.client ?? this.context.hosts.list()[0]): Promise<void> {
    if (client === undefined) return
    const directory = await this.directory(client).catch((error: unknown) => {
      this.context.notice.set(remoteErrorMessage(error))
      return undefined
    })
    if (directory === undefined) return
    const routes = new Map<string, { readonly name: string, readonly live: boolean, readonly detail?: string | undefined }>()
    for (const entry of directory.configurable) routes.set(entry.provider, {
      name: entry.displayName,
      live: directory.live.some(provider => provider.id === entry.provider),
      detail: entry.nativeAuth?.oauth === true ? REMOTE_AUTHORIZATION_GAP : entry.error,
    })
    for (const provider of directory.live) routes.set(provider.id, { ...routes.get(provider.id), name: provider.name, live: true })
    let mounted: RemoteMountedPanel | undefined
    const model: RemotePanelModel = {
      title: this.context.t('Providers'),
      rows: [
        ...[...routes.entries()].map(([route, entry]) => ({
          id: route,
          text: entry.name,
          current: entry.live,
          detail: [entry.live ? 'live' : 'dormant', entry.detail].filter((part): part is string => part !== undefined).join(' · '),
        })),
        { id: '__add__', text: this.context.t('Custom endpoint') },
      ],
      hint: '↑↓ select · Enter configure · Esc close',
    }
    mounted = openRemoteFeaturePanel(this.context, model, (action, route) => {
      if (action !== 'accept' || route === undefined) return
      mounted?.lease.close()
      if (route === '__add__') { void this.openAdd(client); return }
      if (route === ACCOUNT_PROVIDER && this.openAccount !== undefined) { void this.openAccount(client); return }
      void this.openEditor(client, route)
    }, () => {})
  }

  /** Open one adapter-addressed profile editor with explicit revision checks. */
  async openEditor(client: HostClient, route: string): Promise<boolean> {
    const operation = this.hostOperation(client)
    if (operation === undefined) return false
    try {
      const [configurable, settings] = await Promise.all([
        remoteValue(client.remote.llm.listConfigurableProviders()),
        remoteValue(client.remote.settings.describe()),
      ])
      const address = remoteProviderAddress(configurable, route)
      if (address === undefined || address.path.length === 0 || address.container === undefined) {
        if (operation.valid()) this.context.notice.set(this.context.t('The provider has no editable configuration'))
        operation.dispose()
        return false
      }
      const descriptor = settings.namespaces.find((candidate: SettingsNamespaceView) => candidate.ns === address.ns)
      if (descriptor === undefined) throw new Error(this.context.t('Provider configuration is no longer available'))
      const profile = remoteProviderProfileAt(descriptor.value, address.path)
      if (profile === undefined) { operation.dispose(); return false }
      const ref = profile.apiKeyEnv ?? deriveRemoteProviderKeyRef(route)
      const credentials = await remoteValue(client.remote.credentials.describe([ref]))
      const credential = credentials[ref]
      if (credential === undefined || !operation.valid()) { operation.dispose(); return false }
      this.mountEditor(operation, client, route, address.ns, address.path, descriptor, profile, ref, credential, settings.writable)
      return true
    } catch (error) {
      if (operation.valid()) this.context.notice.set(remoteErrorMessage(error))
      operation.dispose()
      return false
    }
  }

  /** Open custom endpoint creation over the adapter-declared route dictionary. */
  async openAdd(client: HostClient): Promise<void> {
    const operation = this.hostOperation(client)
    if (operation === undefined) return
    try {
      const [configurable, settings] = await Promise.all([
        remoteValue(client.remote.llm.listConfigurableProviders()),
        remoteValue(client.remote.settings.describe()),
      ])
      const container = remoteProviderContainer(configurable)
      if (container === undefined) throw new Error(this.context.t('The provider has no editable configuration'))
      const descriptor = settings.namespaces.find((candidate: SettingsNamespaceView) => candidate.ns === container.ns)
      if (descriptor === undefined || !operation.valid()) { operation.dispose(); return }
      this.mountAdd(operation, client, container.ns, container.path, descriptor, settings.writable)
    } catch (error) {
      if (operation.valid()) this.context.notice.set(remoteErrorMessage(error))
      operation.dispose()
    }
  }

  private mountEditor(
    operation: RemoteFeatureOperation,
    client: HostClient,
    route: string,
    ns: string,
    path: readonly string[],
    initialDescriptor: SettingsNamespaceView,
    initialProfile: RemoteProviderProfile,
    ref: string,
    initialCredential: CredentialInfo,
    writable: boolean,
  ): void {
    let descriptor = initialDescriptor
    let discovered: readonly LlmDiscoveredModel[] = []
    let credentialRevision = 0
    let stale = false
    let mounted: RemoteMountedPanel | undefined
    let discoverySequence = 0
    const projection = JSON.stringify([initialProfile, initialCredential.configured, initialCredential.writable])
    const initialProjection = projection
    const view = (): RemotePanelModel => ({
      title: this.context.t('Configure {route}', { route }),
      subtitle: stale ? this.context.t('Provider settings changed elsewhere') : `${ns} · revision ${descriptor.revision}`,
      fields: [
        { id: 'name', label: this.context.t('Provider Name'), kind: 'input', value: initialProfile.displayName ?? route, disabled: !writable },
        { id: 'baseURL', label: this.context.t('Base URL'), kind: 'input', value: initialProfile.baseURL ?? '', disabled: !writable },
        { id: 'reasoning', label: this.context.t('Default thinking effort'), kind: 'select', value: initialProfile.reasoning ?? 'default', options: EFFORTS.map(id => ({ id, label: id })), disabled: !writable },
        { id: 'models', label: this.context.t('Models'), kind: 'input', value: (initialProfile.models ?? []).flatMap(model => typeof model.id === 'string' ? [model.id] : []).join(','), placeholder: 'model-a,model-b', disabled: !writable },
        { id: 'key', label: this.context.t('API key'), kind: 'secret', placeholder: initialCredential.configured ? this.context.t('Configured; leave unchanged') : this.context.t('Not configured'), disabled: !initialCredential.writable },
      ],
      footer: discovered.length === 0 ? undefined : discovered.map(model => `${model.id}${model.contextWindow === undefined ? '' : ` · ${model.contextWindow} tokens`}`).join('\n'),
      hint: 'Ctrl+R discover · Ctrl+X clear key · Enter last field save · Esc close',
    })
    const save = async (values: Readonly<Record<string, string>>): Promise<void> => {
      if (!operation.valid() || !writable) return
      const latest = await remoteValue(client.remote.settings.describe())
      const current = latest.namespaces.find((candidate: SettingsNamespaceView) => candidate.ns === ns)
      const currentProfile = current === undefined ? undefined : remoteProviderProfileAt(current.value, path)
      const currentProjection = JSON.stringify([currentProfile, initialCredential.configured, initialCredential.writable])
      if (current === undefined || current.revision !== descriptor.revision || currentProjection !== initialProjection || credentialRevision !== 0 || stale) {
        throw new Error(this.context.t('Provider settings changed elsewhere'))
      }
      const models = parseModelIds(values.models ?? '').map(id => ({
        ...(initialProfile.models ?? []).find(model => model.id === id),
        ...discovered.find(model => model.id === id),
        id,
      }))
      const nextProfile: Record<string, unknown> = {
        ...initialProfile,
        displayName: values.name?.trim() || route,
        ...values.baseURL === undefined ? {} : { baseURL: values.baseURL.trim() },
        models,
      }
      if (values.reasoning === 'default') delete nextProfile.reasoning
      else nextProfile.reasoning = values.reasoning
      const updated = await remoteValue(client.remote.settings.mutate(ns, [{ op: 'set', path: [...path], value: nextProfile as SettingValue }], descriptor.revision))
      descriptor = updated
      const key = values.key ?? ''
      if (key.length > 0) {
        try { await remoteValue(client.remote.credentials.set(ref, key)) }
        catch (error) { throw new Error(`${this.context.t('Provider settings saved, but the credential could not be saved')}: ${remoteErrorMessage(error, [key])}`) }
      }
      if (operation.valid()) {
        this.context.notice.set(this.context.t('provider "{route}" updated', { route }))
        mounted?.lease.close()
      }
    }
    const discover = async (values: Readonly<Record<string, string>>): Promise<void> => {
      const generation = ++discoverySequence
      const key = values.key ?? ''
      const baseURL = values.baseURL?.trim() ?? ''
      try {
        const bases = baseURL === '' ? [undefined] : remoteProviderDiscoveryBases(baseURL)
        let found: readonly LlmDiscoveredModel[] = []
        for (const base of bases) {
          found = await this.discoverInOperation(operation, ns, {
            provider: route,
            api: 'openai-completions',
            ...base === undefined ? {} : { baseURL: base },
            ...key === '' ? {} : { apiKey: key },
          })
          if (found.length > 0) break
        }
        if (generation !== discoverySequence || !operation.valid()) return
        discovered = found
        mounted?.panel.update(view())
      } catch (error) {
        if (operation.valid()) this.context.notice.set(remoteErrorMessage(error, [key]))
      }
    }
    mounted = openRemoteFeaturePanel(this.context, view(), (action, _id, values) => {
      if (!operation.valid()) { mounted?.lease.close(); return }
      if (action === 'submit') void save(values).catch((error: unknown) => { if (operation.valid()) this.context.notice.set(remoteErrorMessage(error, [values.key ?? ''])) })
      else if (action === 'refresh') void discover(values)
      else if (action === 'delete') void remoteValue(client.remote.credentials.unset(ref)).then(() => {
        if (operation.valid()) { initialCredential = { ...initialCredential, configured: false }; this.context.notice.set(this.context.t('Stored API key cleared')); mounted?.lease.close() }
      }).catch((error: unknown) => { if (operation.valid()) this.context.notice.set(remoteErrorMessage(error)) })
    }, () => { discoverySequence += 1; operation.dispose() })
    const offSettings = onRemoteSettingsDocumentUpdated(client, (updated) => {
      if (String(updated) === ns) { stale = true; mounted?.panel.update(view()) }
    })
    const offCredential = client.remote.$on('credentials/reference-updated', (updated) => {
      if (String(updated) === ref) { credentialRevision += 1; stale = true; mounted?.panel.update(view()) }
    })
    operation.onDispose(offSettings)
    operation.onDispose(offCredential)
  }

  private mountAdd(
    operation: RemoteFeatureOperation,
    client: HostClient,
    ns: string,
    container: readonly string[],
    descriptor: SettingsNamespaceView,
    writable: boolean,
  ): void {
    let discovered: readonly LlmDiscoveredModel[] = []
    let listingBase: string | undefined
    let stale = false
    let mounted: RemoteMountedPanel | undefined
    const view = (): RemotePanelModel => ({
      title: this.context.t('Custom endpoint'),
      subtitle: stale ? this.context.t('Provider settings changed elsewhere') : `${ns} · revision ${descriptor.revision}`,
      fields: [
        { id: 'route', label: this.context.t('Provider Name'), kind: 'input', disabled: !writable },
        { id: 'protocol', label: this.context.t('Protocol'), kind: 'select', value: PROTOCOLS[0], options: PROTOCOLS.map(id => ({ id, label: id })), disabled: !writable },
        { id: 'baseURL', label: this.context.t('Base URL'), kind: 'input', disabled: !writable },
        { id: 'models', label: this.context.t('Models'), kind: 'input', placeholder: 'model-a,model-b', disabled: !writable },
        { id: 'key', label: this.context.t('API key'), kind: 'secret', disabled: !writable },
      ],
      footer: discovered.length === 0 ? undefined : discovered.map(model => model.id).join('\n'),
      hint: 'Ctrl+R discover · Enter last field save · Esc close',
    })
    const save = async (values: Readonly<Record<string, string>>): Promise<void> => {
      const route = values.route?.trim() ?? ''
      const protocol = values.protocol ?? PROTOCOLS[0]
      const baseURL = values.baseURL?.trim() ?? ''
      const key = values.key ?? ''
      if (!REMOTE_PROVIDER_ROUTE.test(route)) throw new Error(this.context.t('Provider names use lowercase letters, digits, and hyphens'))
      const parsed = new URL(baseURL)
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(this.context.t('Enter an HTTP or HTTPS URL'))
      if (key === '') throw new Error(this.context.t('A value is required'))
      const latest = await remoteValue(client.remote.settings.describe())
      const current = latest.namespaces.find((candidate: SettingsNamespaceView) => candidate.ns === ns)
      if (current === undefined || current.revision !== descriptor.revision || stale) throw new Error(this.context.t('Provider settings changed elsewhere'))
      if (remoteProviderProfileAt(current.value, [...container, route]) !== undefined) throw new Error(this.context.t('This provider already exists'))
      const ids = parseModelIds(values.models ?? '')
      const profile: Record<string, unknown> = {
        api: protocol,
        baseURL: normalizeRemoteProviderBaseURL(protocol, baseURL, listingBase),
        apiKeyEnv: deriveRemoteProviderKeyRef(route),
        models: ids.map(id => ({ ...discovered.find(model => model.id === id), id })),
      }
      await remoteValue(client.remote.settings.mutate(ns, [{ op: 'set', path: [...container, route], value: profile as SettingValue }], descriptor.revision))
      try { await remoteValue(client.remote.credentials.set(deriveRemoteProviderKeyRef(route), key)) }
      catch (error) { throw new Error(`${this.context.t('Provider created, but its credential could not be saved')}: ${remoteErrorMessage(error, [key])}`) }
      if (operation.valid()) {
        this.context.notice.set(this.context.t('provider "{route}" added', { route }))
        mounted?.lease.close()
      }
    }
    const discover = async (values: Readonly<Record<string, string>>): Promise<void> => {
      const key = values.key ?? ''
      const protocol = values.protocol ?? PROTOCOLS[0]
      const baseURL = values.baseURL?.trim() ?? ''
      try {
        let found: readonly LlmDiscoveredModel[] = []
        for (const base of remoteProviderDiscoveryBases(baseURL)) {
          found = await this.discoverInOperation(operation, ns, {
            api: protocol === 'anthropic-messages' ? 'openai-completions' : protocol,
            baseURL: base,
            ...key === '' ? {} : { apiKey: key },
          })
          if (found.length > 0) { listingBase = base; break }
        }
        if (!operation.valid()) return
        discovered = found
        mounted?.panel.update(view())
      } catch (error) {
        if (operation.valid()) this.context.notice.set(remoteErrorMessage(error, [key]))
      }
    }
    mounted = openRemoteFeaturePanel(this.context, view(), (action, _id, values) => {
      if (action === 'submit') void save(values).catch((error: unknown) => { if (operation.valid()) this.context.notice.set(remoteErrorMessage(error, [values.key ?? ''])) })
      else if (action === 'refresh') void discover(values)
    }, () => { operation.dispose() })
    const offSettings = onRemoteSettingsDocumentUpdated(client, (updated) => {
      if (String(updated) === ns) { stale = true; mounted?.panel.update(view()) }
    })
    operation.onDispose(offSettings)
  }

  private async discoverInOperation(
    operation: RemoteFeatureOperation,
    settingsNs: string,
    request: LlmModelDiscoveryRequest,
  ): Promise<readonly LlmDiscoveredModel[]> {
    const models = await remoteValue(operation.client.remote.llm.discoverModels(settingsNs, request, operation.signal))
    if (!operation.valid()) return []
    return models
  }
}

function parseModelIds(value: string): readonly string[] {
  return [...new Set(value.split(/[\s,]+/u).map(id => id.trim()).filter(id => id !== ''))]
}
