/**
 * Host-generation model catalog and exact-Session model selection through the
 * official Session Remote API, with Host-merged context metadata and the
 * Session-independent default model.
 * @module @ephemeral-ai/mayfly/remote/features/models
 */

import type {
  ModelCatalog,
  ModelCatalogModel,
  ModelSelection,
} from '@deepseek-ai/dsh-api-remotes/client'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { HostClient, SessionRef } from '../../client/types.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from './contracts.ts'
import {
  RemoteFeatureController,
  RemoteFeatureOperation,
  remoteErrorMessage,
  remoteProperty,
  remoteValue,
} from './official.ts'
import { openRemoteFeaturePanel, type RemoteMountedPanel } from './panel.ts'

/** Adapter-merged context and reasoning metadata for one Host catalog generation. */
export interface RemoteModelCatalogDetails {
  contextWindow(provider: string, model: string): number | undefined
  efforts(provider: string, model: string): readonly string[] | undefined
  defaultEffort(provider: string, model: string): string | undefined
}

/** Per-Host merged-detail source; a Host without the DTO contributes none. */
export interface RemoteModelCatalogSource {
  load(client: HostClient, parent?: AbortSignal): Promise<RemoteModelCatalogDetails | undefined>
}

/** Session-independent default model read/write through the Host defaultModel DTO. */
export interface RemoteDefaultModel {
  read(client: HostClient, parent?: AbortSignal): Promise<ModelSelection>
  select(client: HostClient, next: ModelSelection, parent?: AbortSignal): Promise<ModelSelection>
}

/** One flattened model row with reasoning metadata supplied by the official catalog. */
export interface RemoteModelRow {
  readonly key: string
  readonly provider: string
  readonly providerLabel: string
  readonly model: ModelCatalogModel
  readonly current: boolean
  readonly contextWindow?: number
  readonly efforts: readonly string[]
  readonly defaultEffort?: string
}

/** Parse a model selection from a Host projection without trusting its unknown wire value. */
export function remoteModelSelection(value: unknown): ModelSelection | undefined {
  const provider = remoteProperty(value, 'provider')
  const model = remoteProperty(value, 'model')
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined
  const reasoningEffort = remoteProperty(value, 'reasoningEffort')
  return {
    provider,
    model,
    ...typeof reasoningEffort === 'string' ? { reasoningEffort: ReasoningEffortId(reasoningEffort) } : {},
  }
}

/** Current next/last-used selection, falling back to the Host catalog default. */
export function currentRemoteModelSelection(projection: unknown, catalog: ModelCatalog): ModelSelection {
  return remoteModelSelection(remoteProperty(projection, 'next'))
    ?? remoteModelSelection(remoteProperty(projection, 'lastUsed'))
    ?? catalog.default
}

/** Format context metadata in the legacy picker's binary units. */
export function formatRemoteContextWindow(tokens: number): string {
  if (tokens < 1024) return `${tokens}`
  const units = ['k', 'm', 'g']
  let value = tokens
  let unit = -1
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  const text = Number.isInteger(value) || value >= 10 ? `${Math.round(value)}` : value.toFixed(1)
  return `${text}${units[unit]}`
}

/** Flatten official provider groups, preferring Host-merged context and effort metadata. */
export function remoteModelRows(
  catalog: ModelCatalog,
  current: ModelSelection,
  details?: RemoteModelCatalogDetails,
): readonly RemoteModelRow[] {
  return catalog.groups.flatMap(group => group.models.map(model => {
    const contextWindow = details?.contextWindow(group.id, model.id)
    const efforts = details?.efforts(group.id, model.id)
      ?? model.reasoning?.efforts.map(effort => String(effort.id))
      ?? []
    const defaultEffort = details?.defaultEffort(group.id, model.id) ?? model.reasoning?.defaultEffort
    return {
      key: JSON.stringify([group.id, model.id]),
      provider: group.id,
      providerLabel: group.name,
      model,
      current: current.provider === group.id && current.model === model.id,
      ...contextWindow === undefined ? {} : { contextWindow },
      efforts,
      ...defaultEffort === undefined ? {} : { defaultEffort },
    }
  }))
}

interface RemoteModelState {
  readonly catalog: ModelCatalog
  readonly current: ModelSelection
  readonly details: RemoteModelCatalogDetails | undefined
}

/** Model picker/controller for one Remote feature mount. */
export class RemoteModelsController extends RemoteFeatureController {
  constructor(
    context: RemoteFeatureContext,
    private readonly source?: RemoteModelCatalogSource,
    private readonly defaultModel?: RemoteDefaultModel,
  ) {
    super(context)
  }

  /** Read the current Host generation's catalog without creating a parallel store. */
  async catalog(client: HostClient): Promise<ModelCatalog | undefined> {
    const operation = this.hostOperation(client)
    if (operation === undefined) return undefined
    try {
      const catalog = await remoteValue(client.remote.session.modelCatalog())
      return operation.valid() ? catalog : undefined
    } finally { operation.dispose() }
  }

  /** Open the Session picker, or the Session-independent default picker without one. */
  async open(): Promise<void> {
    const selection = this.context.hosts.current()
    if (selection === undefined) { await this.openDefault(); return }
    const operation = this.sessionOperation(selection)
    if (operation === undefined) return
    try {
      const [catalog, details] = await Promise.all([
        remoteValue(selection.client.remote.session.modelCatalog()),
        this.loadDetails(operation, selection.client),
      ])
      if (!operation.valid()) { operation.dispose(); return }
      this.mountPicker(operation, selection, catalog, details)
    } catch (error) {
      if (operation.valid()) this.context.notice.set(remoteErrorMessage(error))
      operation.dispose()
    }
  }

  /** Select one complete route for an exact Session. */
  async select(ref: SessionRef, next: ModelSelection): Promise<ModelSelection | undefined> {
    const current = this.context.hosts.current()
    if (current === undefined || current.ref.host !== ref.host || current.ref.sessionId !== ref.sessionId) return undefined
    const operation = this.sessionOperation(current)
    if (operation === undefined) return undefined
    try {
      const result = await remoteValue(current.client.remote.session.selectModel({ sessionId: ref.sessionId, ...next }))
      return result.selected
    } finally { operation.dispose() }
  }

  private async openDefault(): Promise<void> {
    const client = this.context.hosts.list()[0]
    if (client === undefined) return
    if (this.defaultModel === undefined) {
      this.context.notice.set(this.context.t('Selecting the default model requires the Host defaultModel capability.'))
      return
    }
    const operation = this.hostOperation(client)
    if (operation === undefined) return
    try {
      const [catalog, details, current] = await Promise.all([
        remoteValue(client.remote.session.modelCatalog()),
        this.loadDetails(operation, client),
        this.defaultModel.read(client, operation.signal),
      ])
      if (!operation.valid()) { operation.dispose(); return }
      this.mountDefaultPicker(operation, client, catalog, current, details)
    } catch (error) {
      if (operation.valid()) this.context.notice.set(remoteErrorMessage(error))
      operation.dispose()
    }
  }

  private async loadDetails(operation: RemoteFeatureOperation, client: HostClient): Promise<RemoteModelCatalogDetails | undefined> {
    if (this.source === undefined) return undefined
    try { return await this.source.load(client, operation.signal) }
    catch { return undefined }
  }

  private mountPicker(
    operation: RemoteFeatureOperation,
    selection: RemoteFeatureSelection,
    catalog: ModelCatalog,
    details: RemoteModelCatalogDetails | undefined,
  ): void {
    const projection = selection.binding.session.projections.faceOf('modelSelection')
    const reload = async (): Promise<RemoteModelState> => {
      const next = await remoteValue(selection.client.remote.session.modelCatalog())
      return {
        catalog: next,
        current: currentRemoteModelSelection(projection.getSnapshot(), next),
        details: await this.loadDetails(operation, selection.client),
      }
    }
    const commit = async (row: RemoteModelRow, effort: string | undefined): Promise<ModelSelection> => {
      const selected = await remoteValue(selection.client.remote.session.selectModel({
        sessionId: selection.ref.sessionId,
        provider: row.provider,
        model: row.model.id,
        ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) },
      }))
      return selected.selected
    }
    this.mountModelList(operation, { catalog, current: currentRemoteModelSelection(projection.getSnapshot(), catalog), details }, {
      reload,
      commit,
      observe: {
        subscribe: listener => projection.subscribe(listener),
        project: (live: ModelCatalog): ModelSelection => currentRemoteModelSelection(projection.getSnapshot(), live),
      },
    })
  }

  private mountDefaultPicker(
    operation: RemoteFeatureOperation,
    client: HostClient,
    catalog: ModelCatalog,
    current: ModelSelection,
    details: RemoteModelCatalogDetails | undefined,
  ): void {
    const reload = async (): Promise<RemoteModelState> => {
      const [next, latest, nextDetails] = await Promise.all([
        remoteValue(client.remote.session.modelCatalog()),
        this.defaultModel === undefined ? Promise.resolve(current) : this.defaultModel.read(client, operation.signal),
        this.loadDetails(operation, client),
      ])
      return { catalog: next, current: latest, details: nextDetails }
    }
    const commit = async (row: RemoteModelRow, effort: string | undefined): Promise<ModelSelection> => {
      if (this.defaultModel === undefined) throw new Error(this.context.t('Selecting the default model requires the Host defaultModel capability.'))
      return await this.defaultModel.select(client, {
        provider: row.provider,
        model: row.model.id,
        ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) },
      }, operation.signal)
    }
    this.mountModelList(operation, { catalog, current, details }, { reload, commit })
  }

  private mountModelList(
    operation: RemoteFeatureOperation,
    initial: RemoteModelState,
    hooks: {
      reload(): Promise<RemoteModelState>
      commit(row: RemoteModelRow, effort: string | undefined): Promise<ModelSelection>
      observe?: {
        subscribe(listener: () => void): () => void
        project(catalog: ModelCatalog): ModelSelection
      }
    },
  ): void {
    let state = initial
    let rows = remoteModelRows(state.catalog, state.current, state.details)
    const pinned = new Map<string, string | undefined>()
    if (state.current.reasoningEffort !== undefined) {
      pinned.set(JSON.stringify([state.current.provider, state.current.model]), String(state.current.reasoningEffort))
    }
    let mounted: RemoteMountedPanel | undefined
    let sequence = 0
    const view = () => ({
      title: this.context.t('Select a model'),
      subtitle: this.context.t('Your pick becomes the default for new sessions.'),
      rows: rows.map(row => ({
        id: row.key,
        text: `${row.providerLabel}/${row.model.name || row.model.id}`,
        current: row.current,
        detail: [
          row.contextWindow === undefined ? undefined : this.context.t('{size} context', { size: formatRemoteContextWindow(row.contextWindow) }),
          row.efforts.length === 0 ? undefined : `${this.context.t('Thinking')}: ${pinned.get(row.key) ?? row.defaultEffort ?? this.context.t('Provider default')}`,
        ].filter((part): part is string => part !== undefined).join(' · ') || undefined,
      })),
      footer: state.catalog.failures.map(failure => `${failure.name}: ${failure.message}`).join('\n'),
      hint: '↑↓ select · ←/→ thinking · Delete provider default · Enter choose · Esc close',
    })
    const apply = (next: RemoteModelState): void => {
      state = next
      rows = remoteModelRows(state.catalog, state.current, state.details)
    }
    const refresh = async (): Promise<void> => {
      const generation = ++sequence
      try {
        const next = await hooks.reload()
        if (generation !== sequence || !operation.valid() || mounted === undefined) return
        apply(next)
        mounted.panel.update(view())
      } catch (error) {
        if (operation.valid()) this.context.notice.set(remoteErrorMessage(error))
      }
    }
    const commit = async (key: string | undefined): Promise<void> => {
      const row = rows.find(candidate => candidate.key === key)
      if (row === undefined || !operation.valid()) return
      const effort = pinned.get(row.key)
      try {
        const selected = await hooks.commit(row, effort)
        if (!operation.valid()) return
        this.context.notice.set(this.context.t('Switched to {model} ({provider})', { model: selected.model, provider: selected.provider }))
        mounted?.lease.close()
      } catch (error) {
        if (operation.valid()) this.context.notice.set(remoteErrorMessage(error))
      }
    }
    const adjust = (key: string | undefined, direction: -1 | 0 | 1): void => {
      const row = rows.find(candidate => candidate.key === key)
      if (row === undefined || row.efforts.length === 0 || mounted === undefined) return
      const choices: (string | undefined)[] = [undefined, ...row.efforts]
      const existing = choices.indexOf(pinned.get(row.key))
      if (direction === 0) pinned.set(row.key, undefined)
      else {
        const index = (Math.max(0, existing) + direction + choices.length) % choices.length
        pinned.set(row.key, choices[index])
      }
      mounted.panel.update(view())
    }
    mounted = openRemoteFeaturePanel(this.context, view(), (action, id) => {
      if (!operation.valid()) { mounted?.lease.close(); return }
      if (action === 'accept') void commit(id)
      else if (action === 'refresh') void refresh()
      else if (action === 'previous') adjust(id, -1)
      else if (action === 'next') adjust(id, 1)
      else if (action === 'delete') adjust(id, 0)
    }, () => { operation.dispose() })
    if (hooks.observe !== undefined) operation.onDispose(hooks.observe.subscribe(() => {
      if (!operation.valid() || mounted === undefined) return
      apply({ ...state, current: hooks.observe!.project(state.catalog) })
      mounted.panel.update(view())
    }))
  }
}
