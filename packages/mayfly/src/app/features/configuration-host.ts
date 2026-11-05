/**
 * Focused Host DTO adapters for the configuration feature family: merged model
 * catalog details, the Session-independent default model, resolved permission
 * bundles, the raw settings document, OAuth authorization streams, and the
 * API-key balance. Every call runs under one exact-generation operation scope
 * whose disposal drops late results and cancels local streams.
 * @module @ephemeral-ai/mayfly/app/features/configuration-host
 */

import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials/types'
import type {
  MayflyModelSelection,
  MayflyHostFeature,
  MayflyProviderBalance,
  MayflySettingsDocument,
} from '@ephemeral-ai/mayfly-host/types'
import { mayflyHostRemote } from '../../hosts/host-mount.ts'
import type { HostClient, SessionRef } from '../../client/types.ts'
import type { RemoteFeatureHosts } from './contracts.ts'
import { hasMayflyHostFeature, unavailableCapability } from './capabilities.ts'
import type { RemoteModelCatalogDetails, RemoteModelCatalogSource, RemoteDefaultModel } from './models.ts'
import { RemoteFeatureOperation, remoteValue } from './official.ts'
import type { RemotePermissionCatalogDetails, RemotePermissionDetailSource } from './permissions.ts'
import type { RemoteSettingsDocuments } from './settings.ts'
import type { RemoteAuthorizationInteraction, RemoteAuthorizationPromptView, RemoteProviderAuthorization, RemoteProviderBalanceSource } from './providers.ts'

function modelSelection(value: MayflyModelSelection): ModelSelection {
  return {
    provider: value.provider,
    model: value.model,
    ...value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort },
  }
}

/** Shared Host DTO adapters for one configuration feature mount. */
export class RemoteConfigurationHost implements
  RemoteModelCatalogSource,
  RemoteDefaultModel,
  RemotePermissionDetailSource,
  RemoteSettingsDocuments,
  RemoteProviderAuthorization,
  RemoteProviderBalanceSource {
  /** @param hosts - attached-Host accessor used to fence every operation scope. */
  constructor(
    private readonly hosts: RemoteFeatureHosts,
    private readonly onDefaultModelSelected?: (client: HostClient, selected: ModelSelection) => void,
  ) {}

  private scope(client: HostClient, parent?: AbortSignal): RemoteFeatureOperation | undefined {
    if (!this.hosts.list().includes(client)) return undefined
    return new RemoteFeatureOperation({ hosts: this.hosts }, client, undefined, parent)
  }

  private async feature(client: HostClient, feature: MayflyHostFeature, operation: RemoteFeatureOperation): Promise<boolean> {
    const present = await hasMayflyHostFeature(client, feature, operation.signal)
    if (!operation.valid()) throw new Error('Host is no longer attached')
    return present
  }

  /** @inheritdoc */
  async load(client: HostClient, parent?: AbortSignal): Promise<RemoteModelCatalogDetails | undefined> {
    const operation = this.scope(client, parent)
    if (operation === undefined) return undefined
    try {
      if (!await this.feature(client, 'modelCatalogDetails', operation)) return undefined
      const details = await remoteValue(mayflyHostRemote(client).modelCatalogDetails({}, operation.signal))
      if (!operation.valid()) return undefined
      const items = new Map(details.items.map(item => [JSON.stringify([item.provider, item.id]), item]))
      const lookup = (provider: string, model: string) => items.get(JSON.stringify([provider, model]))
      return {
        contextWindow: (provider, model) => lookup(provider, model)?.contextWindow,
        efforts: (provider, model) => lookup(provider, model)?.efforts,
        defaultEffort: (provider, model) => lookup(provider, model)?.defaultEffort,
      }
    } catch {
      return undefined
    } finally { operation.dispose() }
  }

  /** @inheritdoc */
  async read(client: HostClient, parent?: AbortSignal): Promise<ModelSelection> {
    const operation = this.scope(client, parent)
    if (operation === undefined) throw new Error('Host is no longer attached')
    try {
      if (!await this.feature(client, 'defaultModel', operation)) throw new Error(unavailableCapability('defaultModel'))
      const selected = await remoteValue(mayflyHostRemote(client).defaultModel({ operation: 'read' }, operation.signal))
      if (!operation.valid()) throw new Error('Host is no longer attached')
      return modelSelection(selected)
    } finally { operation.dispose() }
  }

  /** @inheritdoc */
  async select(client: HostClient, next: ModelSelection, parent?: AbortSignal): Promise<ModelSelection> {
    const operation = this.scope(client, parent)
    if (operation === undefined) throw new Error('Host is no longer attached')
    try {
      if (!await this.feature(client, 'defaultModel', operation)) throw new Error(unavailableCapability('defaultModel'))
      const selected = await remoteValue(mayflyHostRemote(client).defaultModel({
        operation: 'select',
        provider: next.provider,
        model: next.model,
        ...next.reasoningEffort === undefined ? {} : { reasoningEffort: next.reasoningEffort },
      }, operation.signal))
      if (!operation.valid()) throw new Error('Host is no longer attached')
      const confirmed = modelSelection(selected)
      this.onDefaultModelSelected?.(client, confirmed)
      return confirmed
    } finally { operation.dispose() }
  }

  /** @inheritdoc */
  async resolve(client: HostClient, selection?: SessionRef, parent?: AbortSignal): Promise<RemotePermissionCatalogDetails | undefined> {
    if (selection !== undefined && selection.host !== client.key) return undefined
    const operation = this.scope(client, parent)
    if (operation === undefined) return undefined
    try {
      if (!await this.feature(client, 'permissionCatalogDetails', operation)) return undefined
      const details = await remoteValue(mayflyHostRemote(client).permissionCatalogDetails(
        selection === undefined ? {} : { sessionId: selection.sessionId },
        operation.signal,
      ))
      if (!operation.valid()) return undefined
      return {
        yolo: details.yolo,
        spec: value => details.specs[value],
        detail: (value: string): string | undefined => {
          const spec = details.specs[value]
          return spec === undefined ? undefined : `sandbox ${spec.sandbox} · approval ${spec.approval}`
        },
      }
    } catch {
      return undefined
    } finally { operation.dispose() }
  }

  /** @inheritdoc */
  async readDocument(client: HostClient, parent?: AbortSignal): Promise<MayflySettingsDocument> {
    const operation = this.scope(client, parent)
    if (operation === undefined) throw new Error('Host is no longer attached')
    try {
      if (!await this.feature(client, 'settingsDocument', operation)) throw new Error(unavailableCapability('settingsDocument'))
      const document = await remoteValue(mayflyHostRemote(client).readSettingsDocument(operation.signal))
      if (!operation.valid()) throw new Error('Host is no longer attached')
      return document
    } finally { operation.dispose() }
  }

  /** @inheritdoc */
  async writeDocument(client: HostClient, content: string, expectedRevision: string, parent?: AbortSignal): Promise<MayflySettingsDocument> {
    const operation = this.scope(client, parent)
    if (operation === undefined) throw new Error('Host is no longer attached')
    try {
      if (!await this.feature(client, 'settingsDocument', operation)) throw new Error(unavailableCapability('settingsDocument'))
      const document = await remoteValue(mayflyHostRemote(client).writeSettingsDocument({ content, expectedRevision }, operation.signal))
      if (!operation.valid()) throw new Error('Host is no longer attached')
      return document
    } finally { operation.dispose() }
  }

  /** @inheritdoc */
  async balance(client: HostClient, parent?: AbortSignal): Promise<MayflyProviderBalance | undefined> {
    const operation = this.scope(client, parent)
    if (operation === undefined) return undefined
    try {
      if (!await this.feature(client, 'providerBalance', operation)) return undefined
      const balance = await remoteValue(mayflyHostRemote(client).providerBalance(operation.signal))
      return operation.valid() ? balance : undefined
    } catch {
      return undefined
    } finally { operation.dispose() }
  }

  /** @inheritdoc */
  async authorize(
    client: HostClient,
    key: string,
    method: string | undefined,
    interaction: RemoteAuthorizationInteraction,
    parent?: AbortSignal,
  ): Promise<'authorized' | 'cancelled'> {
    const operation = this.scope(client, parent)
    if (operation === undefined) return 'cancelled'
    try {
      if (!await this.feature(client, 'authorization', operation)) throw new Error(unavailableCapability('authorization'))
      const handle = mayflyHostRemote(client).authorize(
        { key: brandString<CredentialKey>(key), ...method === undefined ? {} : { method } },
        operation.signal,
      )
      let settled: 'authorized' | 'cancelled' | undefined
      try {
        for await (const frame of handle) {
          if (frame.type === 'notice') {
            if (operation.valid()) interaction.notice(frame.notice)
          } else if (frame.type === 'prompt') {
            const view: RemoteAuthorizationPromptView = frame.prompt.kind === 'select'
              ? { kind: 'select', message: frame.prompt.message, options: frame.prompt.options.map(option => ({ ...option })) }
              : {
                  kind: frame.prompt.kind,
                  message: frame.prompt.message,
                  ...frame.prompt.placeholder === undefined ? {} : { placeholder: frame.prompt.placeholder },
                }
            const reply = operation.valid() ? await interaction.prompt(view) : undefined
            if (operation.valid() && reply !== undefined && reply.type === 'answer') {
              handle.send({ type: 'answer', operationId: frame.operationId, promptId: frame.promptId, value: reply.value })
            } else {
              handle.send({ type: 'decline', operationId: frame.operationId, promptId: frame.promptId })
            }
          } else if (frame.type === 'settled') settled = frame.status
        }
      } finally {
        // Disposing cancels only this local stream; the Host ends its native attempt.
        handle.dispose()
      }
      return settled ?? 'cancelled'
    } finally { operation.dispose() }
  }
}
