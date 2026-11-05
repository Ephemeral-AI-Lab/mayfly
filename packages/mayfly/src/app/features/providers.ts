/**
 * Provider directory, editing, discovery, and write-only credential operations
 * through official LLM, settings, and credentials Remotes.
 * @module @ephemeral-ai/mayfly/remote/features/providers
 */

import type {
  LlmConfigurableProvider,
  LlmDiscoveredModel,
  LlmModelDiscoveryRequest,
  LlmProviderInfo,
  SettingsDescribeValue,
  SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { MayflyProviderBalance } from '@ephemeral-ai/mayfly-host/types'
import type { MayflyAuthorizationNotice } from '../../hosts/host-contract.ts'
import type { HostClient } from '../../client/types.ts'
import type { RemoteAccountLocalIO, RemoteFeatureContext } from './contracts.ts'
import { panel, ui, type MayflyListItem } from '@ephemeral-ai/mayfly-ui'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import { mountRemoteProviderEditor } from './provider-editor.ts'
import { mountRemoteProviderSetup } from './provider-add.ts'
import { mountRemoteProviderAuthorization } from './provider-authorization.ts'
import {
  onRemoteSettingsDocumentUpdated,
  RemoteFeatureController,
  RemoteFeatureOperation,
  remoteErrorMessage,
  remoteValue,
} from './official.ts'
import { unavailableCapability } from './capabilities.ts'
import {
  deriveRemoteProviderKeyRef,
  remoteProviderAddress,
  remoteProviderContainer,
  remoteProviderProfileAt,
} from './provider-profile.ts'

/** Presentation-safe progress notice carried by one authorization frame. */
export type RemoteAuthorizationNotice = MayflyAuthorizationNotice

/** Presentation-safe prompt data the authorization panel collects an answer for. */
export interface RemoteAuthorizationPromptView {
  readonly kind: 'text' | 'secret' | 'select'
  readonly message: string
  readonly placeholder?: string | undefined
  readonly options?: readonly { readonly id: string, readonly label: string, readonly description?: string | undefined }[] | undefined
}

/** One collected prompt answer; undefined settles as a decline. */
export type RemoteAuthorizationPromptReply =
  | { readonly type: 'answer', readonly value: string }
  | { readonly type: 'decline' }

/** UI callbacks driven by one Host authorization operation stream. */
export interface RemoteAuthorizationInteraction {
  notice(notice: RemoteAuthorizationNotice): void
  prompt(prompt: RemoteAuthorizationPromptView): Promise<RemoteAuthorizationPromptReply | undefined>
}

/** OAuth credential configuration through the Host authorization operation stream. */
export interface RemoteProviderAuthorization {
  authorize(
    client: HostClient,
    key: string,
    method: string | undefined,
    interaction: RemoteAuthorizationInteraction,
    parent?: AbortSignal,
  ): Promise<'authorized' | 'cancelled'>
}

/** Official API-key balance through the Host providerBalance DTO. */
export interface RemoteProviderBalanceSource {
  balance(client: HostClient, parent?: AbortSignal): Promise<MayflyProviderBalance | undefined>
}

const ACCOUNT_PROVIDER = 'deepseek-account'

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
  constructor(
    context: RemoteFeatureContext,
    private readonly openAccount?: (client: HostClient, parent?: AbortSignal) => Promise<void>,
    private readonly authorization?: RemoteProviderAuthorization,
    private readonly balanceSource?: RemoteProviderBalanceSource,
    private readonly localIO?: Pick<RemoteAccountLocalIO, 'copy'>,
    private readonly onCreated?: (route: string, parent?: AbortSignal) => Promise<void>,
  ) {
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
  async setCredential(client: HostClient, ref: string, value: string, replace = false, parent?: AbortSignal): Promise<void> {
    if (parent?.aborted) return
    const operation = this.hostOperation(client, parent)
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
    try {
      const credentials = await remoteValue(client.remote.credentials.describe([ref]))
      if (!operation.valid()) return
      if (credentials[ref]?.writable !== true) throw new Error(this.context.t('The credential source is read-only'))
      await remoteValue(client.remote.credentials.unset(ref))
    }
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
      if (!operation.valid()) return
      if (!settings.writable) throw new Error(this.context.t('Settings are read-only'))
      const address = remoteProviderAddress(configurable, route)
      if (address === undefined || address.path.length === 0) throw new Error(this.context.t('The provider has no editable configuration'))
      const descriptor = settings.namespaces.find((candidate: SettingsNamespaceView) => candidate.ns === address.ns)
      const profile = descriptor === undefined ? undefined : remoteProviderProfileAt(descriptor.value, address.path)
      if (descriptor === undefined || profile === undefined) throw new Error(this.context.t('Provider configuration is no longer available'))
      const projected = JSON.stringify(profile)
      const latest = await remoteValue(client.remote.settings.describe())
      if (!operation.valid()) return
      if (!latest.writable) throw new Error(this.context.t('Settings are read-only'))
      const current = latest.namespaces.find((candidate: SettingsNamespaceView) => candidate.ns === address.ns)
      if (current === undefined || current.revision !== descriptor.revision || JSON.stringify(remoteProviderProfileAt(current.value, address.path)) !== projected) {
        throw new Error(this.context.t('Provider settings changed elsewhere'))
      }
      await remoteValue(client.remote.settings.mutate(address.ns, [{ op: 'unset', path: [...address.path] }], descriptor.revision))
      if (!operation.valid()) return
      const ref = profile.apiKeyEnv ?? deriveRemoteProviderKeyRef(route)
      try {
        const credential = await remoteValue(client.remote.credentials.describe([ref]))
        if (!operation.valid()) return
        if (credential[ref]?.configured === true && credential[ref].writable) await remoteValue(client.remote.credentials.unset(ref))
      } catch (error) {
        throw new Error(`${this.context.t('Provider removed, but the stored credential could not be cleared')}: ${remoteErrorMessage(error)}`)
      }
      if (operation.valid()) this.context.notice.set(this.context.t('Provider removed'))
    } finally { operation.dispose() }
  }

  /** Read the official API-key balance, or undefined when the Host lacks the DTO. */
  async balance(client: HostClient): Promise<MayflyProviderBalance | undefined> {
    if (this.balanceSource === undefined) return undefined
    const operation = this.hostOperation(client)
    if (operation === undefined) return undefined
    try {
      const result = await this.balanceSource.balance(client, operation.signal)
      return operation.valid() ? result : undefined
    } finally { operation.dispose() }
  }

  /** Resolve a provider by native route/name and open the shared model picker. */
  async openModels(client: HostClient, name: string, parent?: AbortSignal): Promise<void> {
    if (parent?.aborted) return
    const operation = this.hostOperation(client, parent)
    if (operation === undefined) return
    try {
      const entries = await remoteValue(client.remote.llm.listProviders())
      if (!operation.valid()) return
      const query = name.toLowerCase()
      const match = entries.find(entry => entry.id.toLowerCase() === query) ?? entries.find(entry => entry.name.toLowerCase() === query)
      if (match === undefined) { this.context.notice.set(this.context.t('Unknown provider'), 'error'); return }
      // The model picker keeps the invocation after this resolver disposes.
      await this.onCreated?.(match.id, parent)
    } finally { operation.dispose() }
  }

  /** Resolve the public edit command and preserve its native refusal feedback. */
  async edit(client: HostClient, route: string, parent: AbortSignal): Promise<void> {
    const operation = this.hostOperation(client, parent)
    if (operation === undefined) return
    try {
      if (await this.openEditor(client, route, parent) || !operation.valid()) return
      if (route === ACCOUNT_PROVIDER && this.openAccount !== undefined) await this.openAccount(client, parent)
      else this.context.notice.set(this.context.t('The provider has no editable configuration'), 'error')
    } finally { operation.dispose() }
  }

  /** Open the reference configured-provider roster. Dormant routes are offered by Add provider. */
  async open(client = this.context.hosts.current()?.client ?? this.context.hosts.active?.() ?? this.context.hosts.list()[0], parent?: AbortSignal): Promise<void> {
    if (parent?.aborted || client === undefined || this.context.ctx.mayflyOverlays.focus('mayfly.providers')) return
    const operation = this.hostOperation(client, parent)
    if (operation === undefined) return
    try {
      let directory = await this.directory(client)
      if (directory === undefined || !operation.valid()) { operation.dispose(); return }
      let items: MayflyListItem[] = []
      let mounted: RemoteBrowserPanel | undefined
      let generation = 0
      const readItems = async (snapshot: RemoteProviderDirectory): Promise<MayflyListItem[]> => await Promise.all(snapshot.live.map(async provider => {
        const address = remoteProviderAddress(snapshot.configurable, provider.id)
        const descriptor = snapshot.settings.namespaces.find(candidate => candidate.ns === address?.ns)
        const profile = descriptor === undefined || address === undefined ? undefined : remoteProviderProfileAt(descriptor.value, address.path)
        const ref = profile?.apiKeyEnv ?? deriveRemoteProviderKeyRef(provider.id)
        const credentials = await remoteValue(client.remote.credentials.describe([ref])).catch(() => undefined)
        const credential = credentials?.[ref]
        const parts = [profile?.models === undefined ? undefined : profile.models.length === 0 ? this.context.t('no models') : this.context.t('{count} models', { count: profile.models.length }),
          credential === undefined || profile === undefined && !credential.configured ? undefined : this.context.t(credential.configured ? 'key configured' : 'no key set'),
        ].filter((part): part is string => part !== undefined)
        return { id: provider.id, label: provider.name || provider.id, ...parts.length === 0 ? {} : { detail: parts.join(' · ') } }
      }))
      items = await readItems(directory)
      if (!operation.valid()) { operation.dispose(); return }
      const view = () => panel({ title: this.context.t('Providers'), escapeLabel: 'close', body: ui.stack.column([
        ui.list({ id: 'providers', role: 'browse', selectedIds: [], filterable: true, filterMode: 'slash', items, empty: ui.empty({ title: this.context.t('No configured providers') }) }),
        ui.actions({ id: 'provider-list-actions', items: [{ id: 'add', label: this.context.t('Add provider'), hintLabel: this.context.t('add'), key: 'ctrl+a', hidden: true }] }),
      ]) })
      const refresh = async () => {
        const sequence = ++generation
        const next = await this.directory(client)
        if (next === undefined || !operation.valid()) return
        const nextItems = await readItems(next)
        if (!operation.valid() || sequence !== generation) return
        directory = next; items = nextItems; mounted?.refresh()
      }
      mounted = openRemoteBrowser(this.context, {
        id: 'mayfly.providers', scope: { kind: 'app', targetId: 'provider-configuration' }, signal: operation.signal, isCurrent: () => operation.valid(), view,
        action: async (event, context) => {
          if (!operation.valid() || context.signal.aborted) return { kind: 'cancelled' }
          if (event.kind === 'activate' && event.actionId === 'add') { await this.openAdd(client, parent); return { kind: 'completed' } }
          if (event.kind !== 'selection-accept' || event.controlId !== 'providers') return { kind: 'completed' }
          const route = event.selectedIds[0]
          if (route === undefined || !items.some(item => item.id === route)) return { kind: 'completed' }
          if (route === ACCOUNT_PROVIDER && this.openAccount !== undefined) { await this.openAccount(client, parent); return { kind: 'completed' } }
          return await this.openEditor(client, route, parent) ? { kind: 'completed' } : { kind: 'failed', message: this.context.t('The provider has no editable configuration') }
        },
        onClosed: () => operation.dispose(),
      })
      operation.onDispose(() => { mounted?.close() })
      operation.onDispose(onRemoteSettingsDocumentUpdated(client, () => { void refresh().catch(() => {}) }))
    } catch (error) { if (operation.valid()) this.context.notice.set(remoteErrorMessage(error)); operation.dispose() }
  }

  /** Open one adapter-addressed profile with reference tabs and revision-checked forms. */
  async openEditor(client: HostClient, route: string, parent?: AbortSignal): Promise<boolean> {
    if (parent?.aborted) return false
    if (this.context.ctx.mayflyOverlays.focus(`mayfly.provider.${Buffer.from(route).toString('hex')}`)) return true
    const operation = this.hostOperation(client, parent)
    if (operation === undefined) return false
    try {
      const [configurable, settings] = await Promise.all([remoteValue(client.remote.llm.listConfigurableProviders()), remoteValue(client.remote.settings.describe())])
      if (!operation.valid()) { operation.dispose(); return false }
      const address = remoteProviderAddress(configurable, route)
      if (address === undefined || address.path.length === 0 || address.container === undefined) { operation.dispose(); return false }
      const descriptor = settings.namespaces.find(candidate => candidate.ns === address.ns)
      const profile = descriptor === undefined ? undefined : remoteProviderProfileAt(descriptor.value, address.path)
      if (descriptor === undefined || profile === undefined) { operation.dispose(); return false }
      const ref = profile.apiKeyEnv ?? deriveRemoteProviderKeyRef(route)
      const credentials = await remoteValue(client.remote.credentials.describe([ref]))
      const credential = credentials[ref]
      if (credential === undefined || !operation.valid()) { operation.dispose(); return false }
      mountRemoteProviderEditor(this.context, { operation, route, ns: address.ns, path: address.path, known: address.declared !== true, descriptor, profile, credential, writable: settings.writable })
      return true
    } catch (error) { if (operation.valid()) this.context.notice.set(remoteErrorMessage(error)); operation.dispose(); return false }
  }

  /** Open the exact Known provider / Custom endpoint / OAuth source chooser. */
  async openAdd(client: HostClient, parent?: AbortSignal): Promise<void> {
    if (parent?.aborted || this.context.ctx.mayflyOverlays.focus('mayfly.provider.add')) return
    const operation = this.hostOperation(client, parent)
    if (operation === undefined) return
    try {
      const directory = await this.directory(client)
      if (directory === undefined || !operation.valid()) { operation.dispose(); return }
      const container = remoteProviderContainer(directory.configurable)
      if (container === undefined) throw new Error(this.context.t('The provider has no editable configuration'))
      const active = new Set(directory.live.map(provider => provider.id))
      const ownedBy = (entry: LlmConfigurableProvider) => entry.settingsNs === container.ns && JSON.stringify(entry.settingsPath.slice(0, -1)) === JSON.stringify(container.path)
      const openPicker = (kind: 'known' | 'oauth') => {
        const rows = directory.configurable.filter(entry => ownedBy(entry) && !active.has(entry.provider) && (kind === 'known' || entry.nativeAuth?.oauth === true))
        // The invocation owns navigation children after their source chooser
        // closes; each child captures its own exact Host generation.
        const childOperation = this.hostOperation(client, parent)!
        const child = openRemoteBrowser(this.context, {
          id: `mayfly.provider.add.${kind}`, scope: { kind: 'app', targetId: 'provider-creation' }, signal: childOperation.signal, isCurrent: () => childOperation.valid(),
          view: () => panel({ title: this.context.t(kind === 'oauth' ? 'OAuth provider' : 'Known provider'), escapeLabel: 'close', body: ui.list({ id: 'providers', role: 'browse', selectedIds: [], items: rows.map(entry => ({ id: entry.provider, label: entry.displayName })), filterable: true, empty: ui.empty({ title: this.context.t('No providers available') }) }) }),
          action: async (event, context) => {
            if (!childOperation.valid() || context.signal.aborted) return { kind: 'cancelled' }
            if (event.kind !== 'selection-accept') return { kind: 'completed' }
            const route = event.selectedIds[0]
            if (route === undefined || !rows.some(entry => entry.provider === route)) return { kind: 'completed' }
            if (kind === 'oauth') await this.openAuthorize(client, route, parent)
            else await this.openEndpoint(client, route, parent)
            return { kind: 'completed' }
          }, onClosed: () => childOperation.dispose(),
        })
        childOperation.onDispose(() => { child.close() })
      }
      const mounted = openRemoteBrowser(this.context, {
        id: 'mayfly.provider.add', scope: { kind: 'app', targetId: 'provider-creation' }, signal: operation.signal, isCurrent: () => operation.valid(),
        view: () => panel({ title: this.context.t('Add provider'), escapeLabel: 'close', body: ui.list({ id: 'provider-source', role: 'browse', numbered: true, selectedIds: [], items: [{ id: 'known', label: this.context.t('Known provider') }, { id: 'custom', label: this.context.t('Custom endpoint') }, { id: 'oauth', label: this.context.t('OAuth provider') }] }) }),
        action: async (event, context) => {
          if (!operation.valid() || context.signal.aborted) return { kind: 'cancelled' }
          if (event.kind !== 'selection-accept') return { kind: 'completed' }
          const kind = event.selectedIds[0]
          if (kind === 'custom') await this.openEndpoint(client, undefined, parent)
          else if (kind === 'known' || kind === 'oauth') openPicker(kind)
          return { kind: 'completed' }
        }, onClosed: () => operation.dispose(),
      })
      operation.onDispose(() => { mounted.close() })
    } catch (error) { if (operation.valid()) this.context.notice.set(remoteErrorMessage(error)); operation.dispose() }
  }

  private async openEndpoint(client: HostClient, known?: string, parent?: AbortSignal): Promise<void> {
    // Both callers are admitted chooser actions with no intervening await.
    const operation = this.hostOperation(client, parent)!
    try {
      const [configurable, settings] = await Promise.all([remoteValue(client.remote.llm.listConfigurableProviders()), remoteValue(client.remote.settings.describe())])
      if (!operation.valid()) { operation.dispose(); return }
      const declared = known === undefined ? undefined : remoteProviderAddress(configurable, known)
      const container = known === undefined ? remoteProviderContainer(configurable) : declared?.container === undefined ? undefined : { ns: declared.ns, path: declared.container }
      const descriptor = settings.namespaces.find(candidate => candidate.ns === container?.ns)
      if (container === undefined || descriptor === undefined) throw new Error(this.context.t('The provider has no editable configuration'))
      mountRemoteProviderSetup(this.context, { operation, descriptor, container: container.path, writable: settings.writable, ...known === undefined ? {} : { known, knownPath: declared!.path }, ...this.onCreated === undefined ? {} : { onCreated: (route: string) => this.onCreated!(route, parent) } })
    } catch (error) { if (operation.valid()) this.context.notice.set(remoteErrorMessage(error)); operation.dispose() }
  }

  /** Run OAuth through native Host authorization, acknowledging UI prompts before answering. */
  async openAuthorize(client: HostClient, route: string, parent?: AbortSignal): Promise<void> {
    if (parent?.aborted) return
    if (this.authorization === undefined) { this.context.notice.set(unavailableCapability('authorization')); return }
    const operation = this.hostOperation(client, parent)
    if (operation === undefined) return
    mountRemoteProviderAuthorization(this.context, operation, route, this.authorization, async () => {
      await this.ensureAuthorizedProfile(operation, route)
      if (operation.valid()) await this.onCreated?.(route, parent)
    }, this.localIO)
  }

  private async ensureAuthorizedProfile(operation: RemoteFeatureOperation, route: string): Promise<void> {
    const { client } = operation
    const [configurable, settings] = await Promise.all([remoteValue(client.remote.llm.listConfigurableProviders()), remoteValue(client.remote.settings.describe())])
    if (!operation.valid()) return
    const address = remoteProviderAddress(configurable, route)
    const descriptor = settings.namespaces.find(candidate => candidate.ns === address?.ns)
    if (address === undefined || address.path.length === 0 || descriptor === undefined) throw new Error(this.context.t('The provider has no editable configuration'))
    if (remoteProviderProfileAt(descriptor.value, address.path) !== undefined) return
    await remoteValue(client.remote.settings.mutate(address.ns, [{ op: 'set', path: [...address.path], value: {} }], descriptor.revision))
  }

  private async discoverInOperation(operation: RemoteFeatureOperation, settingsNs: string, request: LlmModelDiscoveryRequest): Promise<readonly LlmDiscoveredModel[]> {
    const models = await remoteValue(operation.client.remote.llm.discoverModels(settingsNs, request, operation.signal))
    return operation.valid() ? models : []
  }
}
