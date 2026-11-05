/**
 * Host-projection Transcript source with an official Client live-Assistant overlay.
 * @module @ephemeral-ai/mayfly/transcript/remote-model
 */
import type {
  SessionBinding, SessionEventSource, SessionSnapshot,
  SessionEventLikeEntry,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConversationEntry, ConversationFactsState, ConversationImage, ConversationProjection } from '@ephemeral-ai/mayfly-host/types'
import { freezeModel, type TranscriptEntryModel, type TranscriptModel } from '../frontend/models.ts'
import { conversationTranscriptModel, createTranscriptModelCaches } from './conversation-model.ts'
import { createTranscriptModel } from './transcript-model.ts'
import type { ToolPresentationSource } from './present.ts'
import type { MayflyWorkCounters } from '../core/ui-work-counters.ts'
import type { HostKey, SessionRef } from '../client/types.ts'
import { LiveConversationFold, type RemoteLiveConversation } from '../conversation/live.ts'
import {
  RemoteSessionFactsSource,
  type RemotePresentationSelection,
  type RemoteQueueItem,
  type RemoteSessionFactsSnapshot,
} from '../hosts/session-facts.ts'
import type { ScopedRemoteToolPresentationSource } from '../hosts/tool-presentations.ts'
import { MAYFLY_CONVERSATION_PROJECTION } from '../hosts/host-mount.ts'

export type { RemotePresentationSelection } from '../hosts/session-facts.ts'

/** Immutable Session facts consumed by the remote banner, footer, and panels. */
export interface RemotePresentationFacts {
  readonly ref: SessionRef | undefined
  readonly cwd: string
  readonly title: string | undefined
  readonly model: string | undefined
  readonly provider: string | undefined
  readonly reasoningEffort?: string
  readonly mode: unknown
  readonly status: SessionSnapshot | undefined
  readonly contextTokens: number
  readonly contextWindow: number | undefined
  readonly active: boolean
  readonly phase: ConversationFactsState['phase']
  readonly queue: readonly RemoteQueueItem[]
}

/** Presentation callbacks owned by the standalone Frontend. */
interface RemoteConversationOptions {
  readonly defaultCwd?: string
  readonly modelCatalog?: (host: HostKey) => ModelCatalog | undefined
  readonly onPresentation?: () => void
  /** Work counters the perf workloads read; production leaves them unset. */
  readonly counters?: MayflyWorkCounters
}

/** The durable model of one Host value, reused while only the live overlay moves. */
interface DurableModel {
  readonly value: ConversationProjection
  readonly generation: number
  readonly toolsRevision: number
  readonly model: TranscriptModel
}

/** Provider and model advertised by the Host for new Sessions. */
interface RemoteModelSelection {
  readonly model: string
  readonly provider: string
  readonly reasoningEffort?: string
}

const EMPTY_CONVERSATION: ConversationProjection = {
  entries: [],
  streaming: false,
  settledSteps: [],
  turns: [],
}

/** Build Mayfly's transcript from the authoritative Host projection and official live event window. */
export class RemoteConversationModelSource {
  private readonly facts = new RemoteSessionFactsSource()
  private source: SessionEventSource | null = null
  private binding: SessionBinding | null = null
  private selection: RemotePresentationSelection | undefined
  private model = createTranscriptModel('official-conversation', [], false)
  private durable: ConversationProjection = EMPTY_CONVERSATION
  private durableValue: unknown
  /* Identity caches over the entries of the current attachment. A Host push
     decodes every entry afresh, so `interned` hands the caches the previous
     object of an entry whose id and `updatedSeq` are unchanged: the Host's fold
     stamps `updatedSeq` on every replacement. */
  private caches = createTranscriptModelCaches()
  private interned = new Map<string, ConversationEntry>()
  private durableModel: DurableModel | undefined
  private live: RemoteLiveConversation | undefined
  private readonly liveFold = new LiveConversationFold()
  private defaultModel: RemoteModelSelection | undefined
  private restoreEffectiveEffort = false
  private readonly modelCatalogs = new Map<HostKey, ModelCatalog>()
  private generation = 0
  private attachmentGeneration = 0
  private revision = -1
  private toolsRevision = 0
  private attaching = false
  private disposed = false
  private visible = true
  private unread = false
  private replacedWhileHidden = false
  private off: (() => void) | undefined
  private readonly offTools: (() => void) | undefined

  constructor(
    private readonly tools: ToolPresentationSource,
    private readonly publish: (model: TranscriptModel) => void,
    private readonly options: RemoteConversationOptions = {},
  ) {
    this.facts.subscribe(() => { this.onFacts() })
    this.offTools = isScopedTools(tools) ? tools.subscribe(() => { this.refreshTools() }) : undefined
  }

  /** Return the latest mapped Transcript model. */
  snapshot(): TranscriptModel {
    return this.model
  }

  /** Defer hidden transcript conversion until the view is displayed again. */
  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return
    this.visible = visible
    if (visible && !this.restoreEffectiveEffort && readRecordedModelSelection(this.facts.snapshot().values['modelSelection']) !== undefined) {
      this.restoreEffectiveEffort = true
      this.options.onPresentation?.()
    }
    if (!visible || !this.unread) return
    this.unread = false
    if (this.replacedWhileHidden) this.generation += 1
    this.replacedWhileHidden = false
    this.updateDurable()
    const window = this.source?.getSnapshot()
    this.live = window === undefined ? undefined : this.liveFold.reset(window)
    this.revision = window?.revision ?? -1
    this.rebuildModel()
    this.publishModel()
  }

  /** Return the selected Session's official lifecycle and standard projection values. */
  sessionFacts(): RemoteSessionFactsSnapshot {
    return this.facts.snapshot()
  }

  /** Resolve one image reference from the authoritative Host projection or current official live window. */
  imageAttachment(attachmentId: string): ConversationImage | undefined {
    for (const projection of [this.live?.projection, this.durable]) {
      for (const entry of projection?.entries ?? []) {
        if (entry.kind !== 'user') continue
        const image = entry.attachments.find(candidate => candidate.kind === 'image' && candidate.attachmentId === attachmentId)
        if (image?.kind === 'image') return image
      }
    }
    return undefined
  }

  /** Set the Host-advertised fallback used before a Session records a model route. */
  setDefaultModel(selection: RemoteModelSelection | undefined): void {
    if (this.disposed) return
    if (selection?.model === this.defaultModel?.model && selection?.provider === this.defaultModel?.provider && selection?.reasoningEffort === this.defaultModel?.reasoningEffort) return
    this.defaultModel = selection
    this.options.onPresentation?.()
  }

  /** Retain a native metadata snapshot under its physical Host identity; selection remains native projection state. */
  setModelCatalog(host: HostKey, catalog: ModelCatalog | undefined): void {
    if (this.disposed || this.modelCatalogs.get(host) === catalog) return
    if (catalog === undefined) this.modelCatalogs.delete(host)
    else this.modelCatalogs.set(host, catalog)
    this.options.onPresentation?.()
  }

  /** Share this owner's exact Host metadata without copying or retaining a second catalog. */
  getModelCatalog(host: HostKey): ModelCatalog | undefined {
    return this.modelCatalogs.get(host)
  }

  /** Return the current selected Session's immutable banner and footer facts. */
  presentation(): RemotePresentationFacts {
    const snapshot = this.facts.snapshot()
    const selectedModel = readModelSelection(snapshot.values['modelSelection'])
    const recordedModel = readRecordedModelSelection(snapshot.values['modelSelection'])
    const ref = this.selection?.ref ?? snapshot.ref
    const catalog = ref === undefined ? undefined : this.modelCatalogs.get(ref.host) ?? this.options.modelCatalog?.(ref.host)
    const effort = selectedModel === undefined
      ? this.defaultModel?.reasoningEffort
      : selectedModel.reasoningEffort ?? (this.restoreEffectiveEffort ? recordedEffort(this.source?.getSnapshot().entries, selectedModel, recordedModel, catalog) : undefined)
    const context = readContextPressure(snapshot.values['contextPressure'])
    const active = snapshot.session?.running === true
      || this.durable.streaming
      || this.live?.projection.streaming === true
    const title = snapshot.values['title']
    return {
      ref,
      cwd: snapshot.cwd !== '' ? snapshot.cwd : this.selection?.cwd ?? this.options.defaultCwd ?? '',
      title: typeof title === 'string' ? title : undefined,
      model: selectedModel?.model ?? this.defaultModel?.model,
      provider: selectedModel?.provider ?? this.defaultModel?.provider,
      ...effort === undefined ? {} : { reasoningEffort: effort },
      mode: snapshot.values['permissions'],
      status: snapshot.session,
      contextTokens: context.contextTokens,
      contextWindow: context.contextWindow,
      active,
      phase: this.live?.projection.streaming === true
        ? livePhase(this.live)
        : active ? 'waiting' : 'idle',
      queue: snapshot.queue,
    }
  }

  /** Attach one exact Client binding and its event window, or clear the view with null. */
  attach(input: SessionEventSource | SessionBinding | null, selection?: RemotePresentationSelection): void {
    if (this.disposed) return
    this.off?.()
    this.off = undefined
    const binding = input !== null && 'eventSource' in input ? input : null
    const source = binding?.eventSource ?? input as SessionEventSource | null
    const generation = ++this.generation
    const attachmentGeneration = ++this.attachmentGeneration
    this.source = source
    this.binding = binding
    this.selection = selection
    this.revision = -1
    this.durable = EMPTY_CONVERSATION
    this.durableValue = undefined
    this.caches = createTranscriptModelCaches()
    this.interned = new Map()
    this.durableModel = undefined
    this.live = undefined
    this.liveFold.clear()
    this.unread = false
    this.replacedWhileHidden = false
    this.attaching = true
    this.facts.attach(binding, selection)
    // rc.2 displays a provider-default route without an effort during its
    // initial mount. Reopening an already used Session restores the effective
    // request level. This is greeting provenance, not another selection store.
    this.restoreEffectiveEffort = readRecordedModelSelection(this.facts.snapshot().values['modelSelection']) !== undefined
    this.attaching = false
    if (this.visible) this.updateDurable()
    if (source === null) {
      this.model = createTranscriptModel('official-conversation', [], false, generation)
      this.publishModel()
      return
    }
    const snapshot = source.getSnapshot()
    this.revision = snapshot.revision
    if (this.visible) {
      this.live = this.liveFold.reset(snapshot)
      this.rebuildModel()
      this.publishModel()
    } else this.unread = true
    this.off = source.subscribe(() => {
      if (this.disposed || this.source !== source || attachmentGeneration !== this.attachmentGeneration) return
      const window = source.getSnapshot()
      if (window.revision <= this.revision) return
      if (!this.visible) {
        this.unread = true
        this.replacedWhileHidden ||= window.change.kind === 'replace'
        this.revision = window.revision
        return
      }
      if (window.change.kind === 'replace') this.generation += 1
      this.live = this.liveFold.advance(window)
      this.revision = window.revision
      this.rebuildModel()
      this.publishModel()
    })
  }

  /** Release every subscription and reject all late cache, projection, and event callbacks. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.off?.()
    this.off = undefined
    this.offTools?.()
    this.facts.dispose()
    this.source = null
    this.binding = null
    this.selection = undefined
    this.restoreEffectiveEffort = false
    this.modelCatalogs.clear()
    this.generation += 1
    this.attachmentGeneration += 1
    this.revision = -1
    this.durable = EMPTY_CONVERSATION
    this.durableValue = undefined
    this.caches = createTranscriptModelCaches()
    this.interned = new Map()
    this.durableModel = undefined
    this.live = undefined
    this.liveFold.clear()
    this.model = createTranscriptModel('official-conversation', [], false, this.generation)
  }

  private onFacts(): void {
    if (this.disposed || this.attaching) return
    if (!this.visible) { this.unread = true; return }
    if (this.updateDurable()) {
      this.rebuildModel()
      this.publishModel()
      return
    }
    this.options.onPresentation?.()
  }

  private updateDurable(): boolean {
    const value = this.binding?.session.projections.faceOf(MAYFLY_CONVERSATION_PROJECTION).getSnapshot()
    if (Object.is(value, this.durableValue)) return false
    this.durableValue = value
    const projection = readConversationProjection(value)
    this.durable = projection === undefined
      ? EMPTY_CONVERSATION
      : visibleConversationProjection(this.intern(projection), this.selection?.historyFloorSeq)
    return true
  }

  /** The projection with every unchanged entry replaced by the object the previous value decoded for it. */
  private intern(projection: ConversationProjection): ConversationProjection {
    const next = new Map<string, ConversationEntry>()
    let reused = false
    const entries = projection.entries.map(entry => {
      const prior = this.interned.get(entry.id)
      const kept = prior !== undefined && prior.kind === entry.kind && prior.updatedSeq === entry.updatedSeq ? prior : entry
      if (kept === prior) reused = true
      next.set(entry.id, kept)
      return kept
    })
    this.interned = next
    return reused ? { ...projection, entries } : projection
  }

  private refreshTools(): void {
    if (this.disposed) return
    this.toolsRevision += 1
    // Presenters changed: entry models stay, resolved tools and their cards go.
    this.caches = { entries: this.caches.entries, tools: new WeakMap(), models: new WeakMap(), groups: new WeakMap() }
    if (!this.visible) { this.unread = true; return }
    this.rebuildModel()
    this.publishModel()
  }

  private rebuildModel(): void {
    const scopedTools = this.selection !== undefined && isScopedTools(this.tools)
      ? this.tools.source(this.selection.ref, this.durable)
      : this.tools
    const memo = this.durableModel
    const durable = memo !== undefined && memo.value === this.durable && memo.generation === this.generation && memo.toolsRevision === this.toolsRevision
      ? memo.model
      : conversationTranscriptModel(
        this.durable,
        scopedTools,
        this.generation,
        this.toolsRevision === 0 ? undefined : `tools:${String(this.toolsRevision)}`,
        this.caches,
        this.options.counters,
      )
    this.durableModel = { value: this.durable, generation: this.generation, toolsRevision: this.toolsRevision, model: durable }
    this.model = withLiveOverlay(durable, this.durable, this.live, scopedTools, this.generation, this.toolsRevision, this.options.counters)
  }

  private publishModel(): void {
    this.publish(this.model)
    this.options.onPresentation?.()
  }
}

function withLiveOverlay(
  durableModel: TranscriptModel,
  durable: ConversationProjection,
  live: RemoteLiveConversation | undefined,
  tools: ToolPresentationSource,
  generation: number,
  toolsRevision: number,
  counters: MayflyWorkCounters | undefined,
): TranscriptModel {
  if (live === undefined || durable.settledSteps.includes(`${String(live.turn)}:${String(live.step)}`)) return durableModel
  const staleTurn = durable.turns.some(turn => turn.turn > live.turn || (turn.turn === live.turn && turn.endedAt !== undefined))
  if (staleTurn) return durableModel
  const liveModel = conversationTranscriptModel(
    live.projection,
    tools,
    generation,
    `live:${live.attemptId}:${String(toolsRevision)}`,
    undefined,
    counters,
  )
  const durableIds = new Set(durable.entries.map(entry => entry.id))
  // The shared converter produces identified transcript entries. A native
  // transient assistant attempt contains only thinking/text, never tool rows;
  // tool calls are durable Host facts and need no second live de-duplication.
  const entries = (liveModel.entries as readonly TranscriptEntryModel[]).filter(entry => !durableIds.has(entry.id))
  return freezeModel({
    ...durableModel,
    ...(entries.length === 0 ? {} : { live: { turn: live.turn, step: live.step, entries } }),
    // transientAssistantProjection always presents one active assistant attempt.
    streaming: true,
  }) as TranscriptModel
}

function livePhase(live: RemoteLiveConversation): ConversationFactsState['phase'] {
  const latest = live.projection.entries.findLast(entry => (
    entry.kind === 'thinking' || entry.kind === 'assistant'
  ))
  if (latest?.kind === 'thinking') return 'thinking'
  if (latest?.kind === 'assistant') return 'composing'
  return 'waiting'
}

function readConversationProjection(value: unknown): ConversationProjection | undefined {
  if (!isRecord(value) || !Array.isArray(value['entries']) || typeof value['streaming'] !== 'boolean') return undefined
  if (!Array.isArray(value['settledSteps']) || !value['settledSteps'].every(step => typeof step === 'string')) return undefined
  if (!Array.isArray(value['turns'])) return undefined
  return {
    entries: value['entries'] as ConversationProjection['entries'],
    streaming: value['streaming'],
    settledSteps: value['settledSteps'] as ConversationProjection['settledSteps'],
    turns: value['turns'] as ConversationProjection['turns'],
  }
}

function visibleConversationProjection(
  projection: ConversationProjection,
  historyFloorSeq: number | undefined,
): ConversationProjection {
  if (historyFloorSeq === undefined) return projection
  const entries = projection.entries.filter(entry => entry.seq > historyFloorSeq)
  const turns = new Set(entries.map(entry => entry.turn))
  return {
    entries,
    streaming: projection.streaming,
    settledSteps: projection.settledSteps.filter(key => turns.has(Number(key.split(':', 1)[0]))),
    turns: projection.turns.filter(turn => turns.has(turn.turn)),
  }
}

function readContextPressure(value: unknown): { readonly contextTokens: number, readonly contextWindow?: number } {
  if (!isRecord(value)) return { contextTokens: 0 }
  const projected = value['projectedTokens']
  const pressure = value['pressureTokens']
  const window = value['contextWindow']
  return {
    contextTokens: typeof projected === 'number' ? projected : typeof pressure === 'number' ? pressure : 0,
    ...(typeof window === 'number' ? { contextWindow: window } : {}),
  }
}

function readModelSelection(value: unknown): RemoteModelSelection | undefined {
  if (!isRecord(value)) return undefined
  return readModelRoute(value['next']) ?? readModelRoute(value['lastUsed'])
}

/** The wire's `next` includes `lastUsed`; equality, rather than nullness, distinguishes a pending choice. */
function readRecordedModelSelection(value: unknown): RemoteModelSelection | undefined {
  return isRecord(value) ? readModelRoute(value['lastUsed']) : undefined
}

/** Resolve the effective native level for information panels, including their first mount. */
export function remoteEffectiveReasoningEffort(binding: SessionBinding, catalog: ModelCatalog | undefined): string | undefined {
  const value = binding.session.projections.faceOf('modelSelection').getSnapshot()
  const selected = readModelSelection(value)
  if (selected === undefined) return undefined
  return selected.reasoningEffort ?? recordedEffort(binding.eventSource.getSnapshot().entries, selected, readRecordedModelSelection(value), catalog)
}

/** Read an admitted request's effective level without inheriting it into a new model/effort choice. */
function recordedEffort(
  entries: readonly SessionEventLikeEntry[] | undefined,
  selected: RemoteModelSelection,
  lastUsed: RemoteModelSelection | undefined,
  catalog: ModelCatalog | undefined,
): string | undefined {
  if (lastUsed === undefined || selected.provider !== lastUsed.provider || selected.model !== lastUsed.model
    || selected.reasoningEffort !== lastUsed.reasoningEffort) return undefined
  const latest = entries?.findLast(entry => entry.type === 'event' && entry.event.type === 'request/header')
  if (latest?.type === 'event' && latest.event.type === 'request/header') {
    const request = latest.event.data.header.config
    if (request.provider === selected.provider && request.model === selected.model) return request.reasoningEffort
  }
  return catalog?.groups.find(group => group.id === selected.provider)?.models.find(model => model.id === selected.model)?.reasoning?.defaultEffort
}

function readModelRoute(value: unknown): RemoteModelSelection | undefined {
  if (!isRecord(value)) return undefined
  return typeof value['model'] === 'string' && typeof value['provider'] === 'string'
    ? { model: value['model'], provider: value['provider'], ...typeof value['reasoningEffort'] === 'string' ? { reasoningEffort: value['reasoningEffort'] } : {} }
    : undefined
}

function isScopedTools(tools: ToolPresentationSource): tools is ScopedRemoteToolPresentationSource {
  return 'source' in tools && typeof tools.source === 'function' && 'subscribe' in tools && typeof tools.subscribe === 'function'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
