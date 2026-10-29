/**
 * Host-generation model catalog and exact-Session model selection through the
 * official Session Remote API.
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

/** Context metadata still requires a focused Host DTO; the official catalog omits it. */
export interface RemoteModelCatalogDetails {
  contextWindow(provider: string, model: string): number | undefined
}

/** Explicit no-Session parity gap; no official arbitrary default-model write exists. */
export const REMOTE_DEFAULT_MODEL_GAP = 'Selecting the default model without a Session requires the Host defaultModel DTO.'

/** One flattened model row with reasoning metadata supplied by the official catalog. */
export interface RemoteModelRow {
  readonly key: string
  readonly provider: string
  readonly providerLabel: string
  readonly model: ModelCatalogModel
  readonly current: boolean
  readonly contextWindow?: number
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

/** Flatten official provider groups while leaving absent context details absent. */
export function remoteModelRows(
  catalog: ModelCatalog,
  current: ModelSelection,
  details?: RemoteModelCatalogDetails,
): readonly RemoteModelRow[] {
  return catalog.groups.flatMap(group => group.models.map(model => {
    const contextWindow = details?.contextWindow(group.id, model.id)
    return {
      key: JSON.stringify([group.id, model.id]),
      provider: group.id,
      providerLabel: group.name,
      model,
      current: current.provider === group.id && current.model === model.id,
      ...contextWindow === undefined ? {} : { contextWindow },
    }
  }))
}

/** Model picker/controller for one Remote feature mount. */
export class RemoteModelsController extends RemoteFeatureController {
  constructor(context: RemoteFeatureContext, private readonly details?: RemoteModelCatalogDetails) {
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

  /** Open the picker for the exact displayed Session. */
  async open(): Promise<void> {
    const selection = this.context.hosts.current()
    if (selection === undefined) { this.context.notice.set(REMOTE_DEFAULT_MODEL_GAP); return }
    const operation = this.sessionOperation(selection)
    if (operation === undefined) return
    try {
      const catalog = await remoteValue(selection.client.remote.session.modelCatalog())
      if (!operation.valid()) { operation.dispose(); return }
      this.mountPicker(operation, selection, catalog)
    } catch (error) {
      if (operation.valid()) this.context.notice.set(remoteErrorMessage(error))
      operation.dispose()
    }
  }

  /** Select one complete route for an exact Session; no default-only fallback exists. */
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

  /** Refuse the unsupported no-Session write rather than selecting the wrong default. */
  selectWithoutSession(): never {
    throw new Error(REMOTE_DEFAULT_MODEL_GAP)
  }

  private mountPicker(operation: RemoteFeatureOperation, selection: RemoteFeatureSelection, initial: ModelCatalog): void {
    let catalog = initial
    let current = currentRemoteModelSelection(selection.binding.session.projections.faceOf('modelSelection').getSnapshot(), catalog)
    let rows = remoteModelRows(catalog, current, this.details)
    const pinned = new Map<string, string | undefined>()
    if (current.reasoningEffort !== undefined) {
      const key = JSON.stringify([current.provider, current.model])
      pinned.set(key, String(current.reasoningEffort))
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
          row.model.reasoning === undefined ? undefined : `${this.context.t('Thinking')}: ${pinned.get(row.key) ?? row.model.reasoning.defaultEffort ?? this.context.t('Provider default')}`,
        ].filter((part): part is string => part !== undefined).join(' · ') || undefined,
      })),
      footer: catalog.failures.map(failure => `${failure.name}: ${failure.message}`).join('\n'),
      hint: '↑↓ select · ←/→ thinking · Delete provider default · Enter choose · Esc close',
    })
    const refresh = async (): Promise<void> => {
      const generation = ++sequence
      try {
        const next = await remoteValue(selection.client.remote.session.modelCatalog())
        if (generation !== sequence || !operation.valid() || mounted === undefined) return
        catalog = next
        current = currentRemoteModelSelection(selection.binding.session.projections.faceOf('modelSelection').getSnapshot(), catalog)
        rows = remoteModelRows(catalog, current, this.details)
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
        const selected = await remoteValue(selection.client.remote.session.selectModel({
          sessionId: selection.ref.sessionId,
          provider: row.provider,
          model: row.model.id,
          ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) },
        }))
        if (!operation.valid()) return
        this.context.notice.set(this.context.t('Switched to {model} ({provider})', { model: selected.selected.model, provider: selected.selected.provider }))
        mounted?.lease.close()
      } catch (error) {
        if (operation.valid()) this.context.notice.set(remoteErrorMessage(error))
      }
    }
    const adjust = (key: string | undefined, direction: -1 | 0 | 1): void => {
      const row = rows.find(candidate => candidate.key === key)
      const efforts = row?.model.reasoning?.efforts
      if (row === undefined || efforts === undefined || efforts.length === 0 || mounted === undefined) return
      const choices: (string | undefined)[] = [undefined, ...efforts.map(effort => String(effort.id))]
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
    const offProjection = selection.binding.session.projections.faceOf('modelSelection').subscribe(() => {
      if (!operation.valid() || mounted === undefined) return
      current = currentRemoteModelSelection(selection.binding.session.projections.faceOf('modelSelection').getSnapshot(), catalog)
      rows = remoteModelRows(catalog, current, this.details)
      mounted.panel.update(view())
    })
    operation.onDispose(offProjection)
  }
}
