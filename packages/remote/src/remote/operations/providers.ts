/**
 * `/provider` read and switch surface for the standalone frontend. The roster
 * comes from the official LLM directory; switching a provider means picking one
 * of its models, because a Host has no separate "active provider" state. The
 * picker therefore reads the official model catalog and commits through
 * `session/selectModel`, or through the Mayfly `defaultModel` DTO when no
 * Session is selected. Configuration and credentials stay with `/providers`.
 * @module @ephemeral-ai/mayfly/remote/operations/providers
 */

import type {
  LlmConfigurableProvider,
  LlmProviderInfo,
  ModelCatalog,
  ModelSelection,
} from '@deepseek-ai/dsh-api-remotes/client'
import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import type {
  MayflyTranslate,
  MayflyUiActionEvent,
  MayflyUiActionReply,
  MayflyUiNode,
  MayflyUiObservationEvent,
  MayflyUiScope,
} from '@ephemeral-ai/mayfly-ui'
import type { HostClient } from '../../client/types.ts'
import { RemoteConfigurationHost } from '../features/configuration-host.ts'
import type { RemoteFeatureSelection } from '../features.ts'
import { RemoteFeatureLifecycle } from '../features/lifecycle.ts'
import {
  currentRemoteModelSelection,
  formatRemoteContextWindow,
  remoteModelRows,
  type RemoteModelCatalogDetails,
} from '../features/models.ts'
import { remoteErrorMessage, remoteValue } from '../features/official.ts'
import { isRemoteFeatureSelection } from '../interactions/selection.ts'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import {
  REMOTE_PROVIDERS_LIST_ID,
  REMOTE_PROVIDERS_REFRESH_ID,
  REMOTE_PROVIDER_MODELS_LIST_ID,
  REMOTE_PROVIDER_MODELS_REFRESH_ID,
  remoteProviderListPanelNode,
  remoteProviderModelsPanelNode,
  type RemoteProviderModelRow,
  type RemoteProviderRow,
} from '../panels/operations/providers.ts'
import { registerRemoteOperationsLocale, type RemoteOperationsContext } from './support.ts'

const zh: Readonly<Record<string, string>> = {
  'List providers or switch to one by picking its model': '列出提供商，或选择其模型以切换',
  'Providers': '提供商',
  'Models for {provider}': '{provider} 的模型',
  'No providers reported by this Host': '该 Host 未报告任何提供商',
  'This provider offers no models': '该提供商没有可用模型',
  'live': '已启用',
  'dormant': '未启用',
  'no models': '无模型',
  '{count} models': '{count} 个模型',
  '{size} context': '{size} 上下文',
  'Refresh': '刷新',
  'refresh': '刷新',
  'Unknown provider': '未知提供商',
  'No Host is attached': '未连接 Host',
  'The provider is no longer available': '该提供商已不可用',
  'Choosing a provider picks one of its models; the Host keeps the credentials.':
    '选择提供商会挑选其一个模型；凭据由 Host 保存。',
  'Switching the provider selects one of its models for this session or for new ones.':
    '切换提供商会为该会话或新会话选择一个模型。',
  'This provider has no models on this Host; configure it with /providers before switching.':
    '该提供商在此 Host 没有模型；请先用 /providers 配置后再切换。',
  'Provider configuration and credentials are only editable from /providers':
    '提供商配置与凭据只能在 /providers 中编辑',
  'Switched to {model} ({provider})': '已切换到 {model}（{provider}）',
}

/** A catalog stand-in for a projection-only read, so an unselected route marks nothing. */
const NO_CATALOG: ModelCatalog = {
  default: { provider: '', model: '' },
  routableProviders: [],
  groups: [],
  failures: [],
}

/** One provider after merging the live registry with the configurable directory. */
interface RemoteProviderEntry {
  readonly id: string
  readonly name: string
  readonly live: boolean
  readonly detail: string | undefined
}

/** The Client and optional exact Session a command invocation addressed. */
interface RemoteProviderTarget {
  readonly client: HostClient
  readonly selection: RemoteFeatureSelection | undefined
}

/** Merge the live adapter registry with the configurable directory, the live label winning. */
function providerEntries(
  live: readonly LlmProviderInfo[],
  configurable: readonly LlmConfigurableProvider[],
): readonly RemoteProviderEntry[] {
  const entries = new Map<string, RemoteProviderEntry>()
  for (const entry of configurable) {
    entries.set(entry.provider, {
      id: entry.provider,
      name: entry.displayName,
      live: live.some(provider => provider.id === entry.provider),
      detail: entry.error,
    })
  }
  for (const provider of live) {
    const existing = entries.get(provider.id)
    entries.set(provider.id, {
      id: provider.id,
      name: provider.name,
      live: true,
      detail: existing?.detail,
    })
  }
  return [...entries.values()]
}

/** Model count of one provider in the Host's current catalog generation. */
function modelCount(catalog: ModelCatalog | undefined, provider: string): number {
  return catalog?.groups.find(group => group.id === provider)?.models.length ?? 0
}

class RemoteProviderOperationsController {
  private readonly t: MayflyTranslate
  private readonly lifecycle: RemoteFeatureLifecycle
  private readonly defaults: RemoteConfigurationHost
  private panel: RemoteBrowserPanel | undefined
  private rows: readonly RemoteProviderRow[] = []
  private models: readonly RemoteProviderModelRow[] = []
  private picker: { readonly provider: string, readonly label: string } | undefined
  private error: string | undefined
  private note: string | undefined
  private disposed = false

  constructor(private readonly context: RemoteOperationsContext) {
    this.t = memoizedLocaleTranslator(context.base.ctx, 'remote-provider').translate
    registerRemoteOperationsLocale(context.base, 'remote-provider', zh)
    this.defaults = new RemoteConfigurationHost(context.base.hosts)
    this.lifecycle = new RemoteFeatureLifecycle(context.base, this.attach)
    this.lifecycle.start()
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.lifecycle.dispose()
    this.panel?.close()
  }

  /** A selection, Session, or reconnection change retires the captured panel. */
  private readonly attach = (): void => {
    this.panel?.close()
    this.panel = undefined
  }

  readonly execute = async (rawInput: string, signal: AbortSignal): Promise<void> => {
    const input = rawInput.trim()
    if (signal.aborted || this.disposed) return
    const target = this.target()
    if (target === undefined) {
      this.context.base.notice.set(this.t('No Host is attached'))
      return
    }
    if (input === '' || input.toLowerCase() === 'list') {
      await this.openRoster(target, signal)
      return
    }
    if (input === 'add' || input.startsWith('add ') || input.startsWith('edit ') || input.startsWith('remove ')) {
      this.context.base.notice.set(this.t('Provider configuration and credentials are only editable from /providers'))
      return
    }
    const name = input.startsWith('switch ') ? input.slice('switch '.length).trim() : input
    if (name === '') {
      await this.openRoster(target, signal)
      return
    }
    await this.switchTo(target, name, signal)
  }

  /** Whether an invocation or panel action may still publish. */
  private live(signal: AbortSignal | undefined): boolean {
    return !this.disposed && signal?.aborted !== true
  }

  private target(): RemoteProviderTarget | undefined {
    const selection = this.context.base.hosts.current()
    if (selection !== undefined) return { client: selection.client, selection }
    const client = this.context.base.hosts.list()[0]
    return client === undefined ? undefined : { client, selection: undefined }
  }

  private scope(selection: RemoteFeatureSelection | undefined): MayflyUiScope {
    return selection === undefined
      ? { kind: 'app', targetId: 'provider-switch' }
      : { kind: 'session', sessionId: selection.ref.sessionId }
  }

  private isCurrent(client: HostClient, selection: RemoteFeatureSelection | undefined): boolean {
    const current = this.context.base.hosts.current()
    if (selection === undefined) return current === undefined && this.context.base.hosts.list().includes(client)
    return isRemoteFeatureSelection(current, client, selection.ref)
  }

  private view(): MayflyUiNode {
    const picker = this.picker
    return picker === undefined
      ? remoteProviderListPanelNode({ rows: this.rows, error: this.error }, this.t)
      : remoteProviderModelsPanelNode({
        provider: picker.provider,
        providerLabel: picker.label,
        rows: this.models,
        error: this.error,
        note: this.note,
      }, this.t)
  }

  /** Render the roster, or a provider's models, in the one shared browser panel. */
  private show(): void {
    if (this.panel !== undefined) {
      this.panel.refresh()
      return
    }
    const target = this.target()
    if (target === undefined) return
    const { client, selection } = target
    this.panel = openRemoteBrowser(this.context.base, {
      id: 'remote.operations.providers',
      scope: this.scope(selection),
      isCurrent: () => this.isCurrent(client, selection),
      view: () => this.view(),
      observe: (_event: MayflyUiObservationEvent) => {},
      action: (event: MayflyUiActionEvent) => this.act(client, selection, event),
      onClosed: () => { this.panel = undefined },
    })
  }

  private async openRoster(target: RemoteProviderTarget, signal?: AbortSignal): Promise<void> {
    this.picker = undefined
    this.models = []
    this.note = undefined
    await this.reload(target, signal)
  }

  private async switchTo(target: RemoteProviderTarget, name: string, signal: AbortSignal): Promise<void> {
    const directory = await this.readDirectory(target.client)
    if (!this.live(signal)) return
    if (directory === undefined) {
      this.show()
      return
    }
    const needle = name.toLowerCase()
    const match = directory.entries.find(entry => entry.id.toLowerCase() === needle)
      ?? directory.entries.find(entry => entry.name.toLowerCase() === needle)
    if (match === undefined) {
      this.context.base.notice.set(this.t('Unknown provider'))
      return
    }
    await this.openModels(target, match.id, match.name, signal)
  }

  private async openModels(target: RemoteProviderTarget, provider: string, label: string, signal?: AbortSignal): Promise<void> {
    this.picker = { provider, label }
    await this.reload(target, signal)
  }

  /** Re-read the directory and the current selection, then repaint the open view. */
  private async reload(target: RemoteProviderTarget, signal?: AbortSignal): Promise<void> {
    const [directory, current, details] = await Promise.all([
      this.readDirectory(target.client),
      this.currentSelection(target),
      this.mergedDetails(target.client),
    ])
    if (!this.live(signal)) return
    if (directory === undefined) {
      this.show()
      return
    }
    this.error = undefined
    this.rows = directory.entries.map(entry => ({
      id: entry.id,
      name: entry.name,
      live: entry.live,
      models: modelCount(directory.catalog, entry.id),
      current: entry.id === current?.provider,
      ...entry.detail === undefined ? {} : { detail: entry.detail },
    }))
    const picker = this.picker
    if (picker !== undefined) {
      this.models = this.modelRows(directory.catalog, picker.provider, current, details)
      this.note = this.models.length === 0
        ? this.t('This provider has no models on this Host; configure it with /providers before switching.')
        : undefined
    }
    this.show()
  }

  /** Flatten the catalog for one provider through the shared model-catalog projection. */
  private modelRows(
    catalog: ModelCatalog | undefined,
    provider: string,
    current: ModelSelection | undefined,
    details: RemoteModelCatalogDetails | undefined,
  ): readonly RemoteProviderModelRow[] {
    if (catalog === undefined) return []
    const selection = current ?? catalog.default
    return remoteModelRows(catalog, selection, details).filter(row => row.provider === provider).map(row => ({
      id: row.model.id,
      label: row.model.name || row.model.id,
      current: row.current,
      ...row.contextWindow === undefined
        ? {}
        : { detail: this.t('{size} context', { size: formatRemoteContextWindow(row.contextWindow) }) },
    }))
  }

  /** Merged context metadata from the Mayfly Host DTO; a Host without it contributes none. */
  private async mergedDetails(client: HostClient): Promise<RemoteModelCatalogDetails | undefined> {
    try {
      return await this.defaults.load(client)
    } catch {
      return undefined
    }
  }

  private async readDirectory(
    client: HostClient,
  ): Promise<{ readonly entries: readonly RemoteProviderEntry[], readonly catalog: ModelCatalog | undefined } | undefined> {
    try {
      const [live, configurable] = await Promise.all([
        remoteValue(client.remote.llm.listProviders()),
        remoteValue(client.remote.llm.listConfigurableProviders()),
      ])
      const catalog = await remoteValue(client.remote.session.modelCatalog()).catch(() => undefined)
      if (this.disposed) return undefined
      return { entries: providerEntries(live, configurable), catalog }
    } catch (error) {
      if (this.disposed) return undefined
      this.error = remoteErrorMessage(error)
      return undefined
    }
  }

  /** Current route, read from the Session projection or the Session-independent default. */
  private async currentSelection(target: RemoteProviderTarget): Promise<ModelSelection | undefined> {
    const selection = target.selection
    if (selection !== undefined) {
      return currentRemoteModelSelection(selection.binding.session.projections.faceOf('modelSelection').getSnapshot(), NO_CATALOG)
    }
    try {
      return await this.defaults.read(target.client)
    } catch {
      return undefined
    }
  }

  private async act(
    client: HostClient,
    selection: RemoteFeatureSelection | undefined,
    event: MayflyUiActionEvent,
  ): Promise<MayflyUiActionReply> {
    if (event.kind === 'selection-accept') {
      if (this.picker === undefined) {
        if (event.controlId !== REMOTE_PROVIDERS_LIST_ID) return { kind: 'completed' }
        const row = this.rows.find(candidate => candidate.id === event.selectedIds[0])
        if (row === undefined) {
          this.context.base.notice.set(this.t('The provider is no longer available'))
          return { kind: 'completed' }
        }
        await this.openModels({ client, selection }, row.id, row.name)
        return { kind: 'completed' }
      }
      if (event.controlId !== REMOTE_PROVIDER_MODELS_LIST_ID) return { kind: 'completed' }
      return await this.commitModel(client, selection, event.selectedIds[0])
    }
    if (event.kind !== 'activate') return { kind: 'completed' }
    if (event.actionId === REMOTE_PROVIDERS_REFRESH_ID || event.actionId === REMOTE_PROVIDER_MODELS_REFRESH_ID) {
      await this.reload({ client, selection })
    }
    return { kind: 'completed' }
  }

  /** Commit the chosen model as the Session selection, or as the new-Session default. */
  private async commitModel(
    client: HostClient,
    selection: RemoteFeatureSelection | undefined,
    modelId: string | undefined,
  ): Promise<MayflyUiActionReply> {
    const picker = this.picker
    if (picker === undefined || modelId === undefined || this.disposed) return { kind: 'completed' }
    if (selection !== undefined && !isRemoteFeatureSelection(this.context.base.hosts.current(), client, selection.ref)) {
      return { kind: 'completed' }
    }
    try {
      let selected: ModelSelection
      if (selection === undefined) {
        selected = await this.defaults.select(client, { provider: picker.provider, model: modelId })
      } else {
        selected = (await remoteValue(client.remote.session.selectModel({
          sessionId: selection.ref.sessionId,
          provider: picker.provider,
          model: modelId,
        }))).selected
      }
      if (this.disposed) return { kind: 'completed' }
      this.context.base.notice.set(this.t('Switched to {model} ({provider})', {
        model: selected.model,
        provider: selected.provider,
      }))
      this.panel?.close()
    } catch (error) {
      if (!this.disposed) this.context.base.notice.set(remoteErrorMessage(error))
    }
    return { kind: 'completed' }
  }
}

/** Mount the `/provider` roster and per-provider model switch. */
export function mountRemoteProviderOperations(context: RemoteOperationsContext): () => void {
  const controller = new RemoteProviderOperationsController(context)
  const t = memoizedLocaleTranslator(context.base.ctx, 'remote-provider').translate
  const unregister = context.base.commands.register({
    name: 'provider',
    description: t('List providers or switch to one by picking its model'),
    input: { hint: '[list | switch <provider>]' },
    execute: controller.execute,
  })
  return () => {
    unregister()
    controller.dispose()
  }
}
