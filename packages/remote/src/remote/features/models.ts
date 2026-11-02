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
import { EffortPicker, ModelPicker, formatContextWindow, modelSwitchNotice, sameModelSelection } from '@ephemeral-ai/mayfly/model-picker'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import type { MayflyUiActionReply } from '@ephemeral-ai/mayfly-ui'

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
export const formatRemoteContextWindow = formatContextWindow

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

interface RemoteModelTarget {
  readonly operation: RemoteFeatureOperation
  readonly client: HostClient
  readonly selection: RemoteFeatureSelection | undefined
  readonly catalog: ModelCatalog
  readonly current: ModelSelection
  readonly details: RemoteModelCatalogDetails | undefined
}

/** Model selection over the official Host API with the reference wire UI. */
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

  /** Select one complete route for an exact Session. */
  async select(ref: SessionRef, next: ModelSelection): Promise<ModelSelection | undefined> {
    const current = this.context.hosts.current()
    if (current === undefined || current.ref.host !== ref.host || current.ref.sessionId !== ref.sessionId) return undefined
    const operation = this.sessionOperation(current)
    if (operation === undefined) return undefined
    try {
      const result = await remoteValue(current.client.remote.session.selectModel({ sessionId: ref.sessionId, ...next }))
      return operation.valid() ? result.selected : undefined
    } finally { operation.dispose() }
  }

  /** Alt+M follows the current provider's advertised order and resets pinned effort. */
  async cycle(): Promise<void> {
    const target = await this.target()
    if (target === undefined) return
    try {
      const models = target.catalog.groups.find(group => group.id === target.current.provider)?.models ?? []
      if (models.length === 0) {
        if (target.operation.valid()) this.context.notice.set(this.context.t('the current provider advertises no models'))
        return
      }
      const current = models.findIndex(model => model.id === target.current.model)
      const model = models[current < 0 ? 0 : (current + 1) % models.length]!
      await this.commit(target, { provider: target.current.provider, model: model.id })
    } finally { target.operation.dispose() }
  }

  /** Open the reference picker or resolve one unambiguous model name. */
  async open(rawInput = '', providerFilter?: string): Promise<void> {
    const target = await this.target()
    if (target === undefined) return
    const rows = remoteModelRows(target.catalog, target.current, target.details)
      .filter(row => providerFilter === undefined || row.provider === providerFilter)
    const query = rawInput.trim().toLowerCase()
    if (query !== '') {
      const exact = rows.filter(row => `${row.provider}/${row.model.id}`.toLowerCase() === query
        || row.model.id.toLowerCase() === query || row.model.name.toLowerCase() === query)
      const matched = exact.length === 0 ? rows.filter(row => `${row.provider}/${row.model.id}`.toLowerCase().includes(query)) : exact
      if (matched.length !== 1) {
        if (target.operation.valid()) this.context.notice.set(matched.length === 0 ? `Unknown model: ${rawInput.trim()}` : `Ambiguous model: ${rawInput.trim()}`)
        target.operation.dispose()
        return
      }
      await this.commit(target, { provider: matched[0]!.provider, model: matched[0]!.model.id })
      target.operation.dispose()
      return
    }
    this.mountModels(target, rows, providerFilter)
  }

  /** Open the reference effort slider or explicitly pin/reset one offered level. */
  async effort(rawInput = ''): Promise<void> {
    const target = await this.target()
    if (target === undefined) return
    const row = remoteModelRows(target.catalog, target.current, target.details)
      .find(candidate => candidate.provider === target.current.provider && candidate.model.id === target.current.model)
    if (row === undefined || row.efforts.length === 0) {
      if (target.operation.valid()) this.context.notice.set('the current model exposes no reasoning efforts')
      target.operation.dispose()
      return
    }
    const query = rawInput.trim().toLowerCase()
    if (query !== '') {
      const match = row.efforts.find(level => level.toLowerCase() === query)
        ?? row.model.reasoning?.efforts.find(level => level.name.toLowerCase() === query)?.id
      if (query !== 'default' && match === undefined) {
        this.context.notice.set(`unsupported thinking effort "${rawInput.trim()}" for ${row.model.id}: available: default, ${row.efforts.join(', ')}`)
      } else {
        await this.commit(target, { provider: row.provider, model: row.model.id, ...query === 'default' ? {} : { reasoningEffort: ReasoningEffortId(String(match)) } })
      }
      target.operation.dispose()
      return
    }
    const t = this.context.t
    const model = `${row.providerLabel}/${row.model.id}`
    const node = EffortPicker({
      title: t('Effort'),
      description: row.defaultEffort === undefined ? model : t('{model} · provider default: {level}', { model, level: row.defaultEffort }),
      levels: row.efforts, inherited: row.defaultEffort, pinned: target.current.reasoningEffort,
      startCaption: t('Faster'), endCaption: t('Smarter'),
    })
    const panel = openRemoteBrowser(this.context, {
      id: 'mayfly.effort', scope: this.scope(target), signal: target.operation.signal,
      isCurrent: () => target.operation.valid(), view: () => node,
      action: async (event, context) => {
        if (event.kind !== 'slider-accept' || event.controlId !== 'effort') return { kind: 'completed' }
        if (context.signal.aborted) return { kind: 'cancelled' }
        if (event.value !== null && !row.efforts.includes(event.value)) return { kind: 'failed', message: 'The thinking effort is no longer available' }
        return await this.commit(target, { provider: row.provider, model: row.model.id, ...event.value === null ? {} : { reasoningEffort: ReasoningEffortId(event.value) } })
      },
      onClosed: () => target.operation.dispose(),
    })
    target.operation.onDispose(() => panel.close())
  }

  private scope(target: RemoteModelTarget): { readonly kind: 'session', readonly sessionId: string } | { readonly kind: 'app', readonly targetId: string } {
    return target.selection === undefined
      ? { kind: 'app', targetId: 'model-selection' }
      : { kind: 'session', sessionId: target.selection.ref.sessionId }
  }

  private async target(): Promise<RemoteModelTarget | undefined> {
    const selection = this.context.hosts.current()
    const client = selection?.client ?? this.context.hosts.active?.() ?? this.context.hosts.list()[0]
    if (client === undefined) return undefined
    const operation = selection === undefined ? this.hostOperation(client) : this.sessionOperation(selection)
    if (operation === undefined) return undefined
    try {
      if (selection === undefined && this.defaultModel === undefined) throw new Error(this.context.t('Selecting the default model requires the Host defaultModel capability.'))
      const [catalog, details] = await Promise.all([
        remoteValue(client.remote.session.modelCatalog()),
        this.loadDetails(operation, client),
      ])
      const current = selection === undefined
        ? await this.defaultModel!.read(client, operation.signal)
        : currentRemoteModelSelection(selection.binding.session.projections.faceOf('modelSelection').getSnapshot(), catalog)
      if (!operation.valid()) { operation.dispose(); return undefined }
      return { operation, selection, client, catalog, current, details }
    } catch (error) {
      if (operation.valid()) this.context.notice.set(remoteErrorMessage(error))
      operation.dispose()
      return undefined
    }
  }

  private async loadDetails(operation: RemoteFeatureOperation, client: HostClient): Promise<RemoteModelCatalogDetails | undefined> {
    if (this.source === undefined) return undefined
    try { return await this.source.load(client, operation.signal) }
    catch { return undefined }
  }

  private async commit(target: RemoteModelTarget, next: ModelSelection): Promise<MayflyUiActionReply> {
    if (!target.operation.valid()) return { kind: 'cancelled', dismiss: true }
    try {
      const previous = target.selection === undefined
        ? await this.defaultModel!.read(target.client, target.operation.signal)
        : currentRemoteModelSelection(target.selection.binding.session.projections.faceOf('modelSelection').getSnapshot(), target.catalog)
      if (!target.operation.valid()) return { kind: 'cancelled', dismiss: true }
      const selected = sameModelSelection(previous, next) ? previous : target.selection === undefined
        ? await this.defaultModel!.select(target.client, next, target.operation.signal)
        : (await remoteValue(target.client.remote.session.selectModel({ sessionId: target.selection.ref.sessionId, ...next }))).selected
      if (!target.operation.valid()) return { kind: 'cancelled', dismiss: true }
      const row = remoteModelRows(target.catalog, selected, target.details).find(row => row.current)
      this.context.notice.set(this.context.t(modelSwitchNotice(previous, selected, row?.defaultEffort)), 'success')
      return { kind: 'completed', dismiss: true }
    } catch (error) {
      if (!target.operation.valid()) return { kind: 'cancelled', dismiss: true }
      const message = remoteErrorMessage(error)
      this.context.notice.set(message)
      return { kind: 'failed', message }
    }
  }

  private mountModels(target: RemoteModelTarget, initial: readonly RemoteModelRow[], providerFilter?: string): void {
    let rows = initial
    let current = target.current
    let currentCatalog = target.catalog
    let revision = 0
    let panel: RemoteBrowserPanel
    const view = () => ModelPicker({
      title: this.context.t('Select a model'), description: this.context.t('Your pick becomes the default for new sessions.'),
      thinking: this.context.t('Thinking'), empty: this.context.t('No models advertised'),
      live: rows.find(row => row.current)?.key,
      rows: rows.map(row => ({
        id: row.key, label: `${row.providerLabel}/${row.model.name || row.model.id}`, group: row.providerLabel,
        current: row.current,
        detail: row.contextWindow === undefined ? undefined : this.context.t('{size} context', { size: formatContextWindow(row.contextWindow) }),
        strip: row.efforts.length === 0 ? undefined : { efforts: row.efforts, inherited: row.defaultEffort, pinned: row.current ? current.reasoningEffort : undefined },
      })),
    })
    const refresh = async (): Promise<void> => {
      const generation = ++revision
      try {
        const [catalog, details] = await Promise.all([remoteValue(target.client.remote.session.modelCatalog()), this.loadDetails(target.operation, target.client)])
        if (!target.operation.valid() || generation !== revision) return
        const nextCurrent = target.selection === undefined ? await this.defaultModel!.read(target.client, target.operation.signal)
          : currentRemoteModelSelection(target.selection.binding.session.projections.faceOf('modelSelection').getSnapshot(), catalog)
        if (!target.operation.valid() || generation !== revision) return
        current = nextCurrent
        currentCatalog = catalog
        rows = remoteModelRows(catalog, current, details).filter(row => providerFilter === undefined || row.provider === providerFilter)
        panel.refresh()
      } catch (error) { if (target.operation.valid()) this.context.notice.set(remoteErrorMessage(error)) }
    }
    panel = openRemoteBrowser(this.context, {
      id: 'mayfly.models', scope: this.scope(target), signal: target.operation.signal,
      isCurrent: () => target.operation.valid(), view,
      action: async (event, context) => {
        if (event.kind === 'activate' && event.actionId === 'refresh') { await refresh(); return { kind: 'completed' } }
        if (event.kind !== 'selection-accept' || event.controlId !== 'selection') return { kind: 'completed' }
        if (context.signal.aborted) return { kind: 'cancelled' }
        const row = rows.find(candidate => candidate.key === event.selectedIds[0])
        if (row === undefined) return { kind: 'failed', message: this.context.t('The model is no longer available') }
        if (event.segmentId !== undefined && !row.efforts.includes(event.segmentId)) return { kind: 'failed', message: 'The thinking effort is no longer available' }
        return await this.commit(target, { provider: row.provider, model: row.model.id, ...event.segmentId === undefined ? {} : { reasoningEffort: ReasoningEffortId(event.segmentId) } })
      },
      onClosed: () => target.operation.dispose(),
    })
    target.operation.onDispose(() => panel.close())
    if (target.selection !== undefined) {
      const projection = target.selection.binding.session.projections.faceOf('modelSelection')
      target.operation.onDispose(projection.subscribe(() => {
        if (!target.operation.valid()) return
        current = currentRemoteModelSelection(projection.getSnapshot(), currentCatalog)
        rows = rows.map(row => ({ ...row, current: row.provider === current.provider && row.model.id === current.model }))
        panel.refresh()
      }))
    }
  }
}
