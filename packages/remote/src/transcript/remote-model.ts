/**
 * Host-projection Transcript source with an official Client live-Assistant overlay.
 * @module @ephemeral-ai/mayfly/transcript/remote-model
 */
import type {
  SessionBinding, SessionEventSource, SessionSnapshot,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationFactsState, ConversationProjection } from '@ephemeral-ai/mayfly/conversation'
import { freezeModel, type TranscriptEntryModel, type TranscriptModel } from '@ephemeral-ai/mayfly/frontend'
import { conversationTranscriptModel, createTranscriptModel } from '@ephemeral-ai/mayfly/transcript'
import type { ToolPresentationSource } from '@ephemeral-ai/mayfly/transcript'
import type { SessionRef } from '../client/types.ts'
import { projectLiveConversation, type RemoteLiveConversation } from '../conversation/live.ts'
import {
  RemoteSessionFactsSource,
  type RemotePresentationSelection,
  type RemoteQueueItem,
  type RemoteSessionFactsSnapshot,
} from '../frontend/session-facts.ts'
import type { ScopedRemoteToolPresentationSource } from '../frontend/tool-presentations.ts'
import { MAYFLY_CONVERSATION_PROJECTION, MAYFLY_FACTS_PROJECTION } from '../frontend/host-mount.ts'

export type { RemotePresentationSelection } from '../frontend/session-facts.ts'

/** Immutable Session facts consumed by the remote banner, footer, and panels. */
export interface RemotePresentationFacts {
  readonly ref: SessionRef | undefined
  readonly cwd: string
  readonly title: string | undefined
  readonly model: string | undefined
  readonly provider: string | undefined
  readonly mode: unknown
  readonly status: SessionSnapshot | undefined
  readonly contextTokens: number
  readonly contextWindow: number | undefined
  readonly active: boolean
  readonly phase: ConversationFactsState['phase']
  readonly queue: readonly RemoteQueueItem[]
}

/** Presentation callbacks owned by the standalone Frontend. */
export interface RemoteConversationOptions {
  readonly onPresentation?: () => void
  readonly onCommandResult?: (result: { readonly kind: 'success' | 'error', readonly text?: string }) => void
}

/** Provider and model advertised by the Host for new Sessions. */
export interface RemoteModelSelection {
  readonly model: string
  readonly provider: string
}

const EMPTY_CONVERSATION: ConversationProjection = {
  entries: [],
  streaming: false,
  settledSteps: [],
  turns: [],
}
const EMPTY_TOOLS: ToolPresentationSource = { get: () => undefined }

/** Build Mayfly's transcript from the authoritative Host projection and official live event window. */
export class RemoteConversationModelSource {
  private readonly facts = new RemoteSessionFactsSource()
  private source: SessionEventSource | null = null
  private binding: SessionBinding | null = null
  private selection: RemotePresentationSelection | undefined
  private model = createTranscriptModel('official-conversation', [], false)
  private durable: ConversationProjection = EMPTY_CONVERSATION
  private durableValue: unknown
  private live: RemoteLiveConversation | undefined
  private defaultModel: RemoteModelSelection | undefined
  private generation = 0
  private attachmentGeneration = 0
  private revision = -1
  private toolsRevision = 0
  private attaching = false
  private disposed = false
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

  /** Return the selected Session's official lifecycle and standard projection values. */
  sessionFacts(): RemoteSessionFactsSnapshot {
    return this.facts.snapshot()
  }

  /** Set the Host-advertised fallback used before a Session records a model route. */
  setDefaultModel(selection: RemoteModelSelection | undefined): void {
    if (this.disposed) return
    if (selection?.model === this.defaultModel?.model && selection?.provider === this.defaultModel?.provider) return
    this.defaultModel = selection
    this.options.onPresentation?.()
  }

  /** Return the current selected Session's immutable banner and footer facts. */
  presentation(): RemotePresentationFacts {
    const snapshot = this.facts.snapshot()
    const selectedModel = readModelSelection(snapshot.values['modelSelection'])
    const context = readContextPressure(snapshot.values['contextPressure'])
    const conversationFacts = readConversationFacts(snapshot.values[MAYFLY_FACTS_PROJECTION])
    const active = snapshot.session?.running === true
      || conversationFacts?.active === true
      || this.durable.streaming
      || this.live?.projection.streaming === true
    const title = snapshot.values['title']
    return {
      ref: this.selection?.ref ?? snapshot.ref,
      cwd: snapshot.cwd !== '' ? snapshot.cwd : this.selection?.cwd ?? '',
      title: typeof title === 'string' ? title : undefined,
      model: selectedModel?.model ?? this.defaultModel?.model,
      provider: selectedModel?.provider ?? this.defaultModel?.provider,
      mode: snapshot.values['permissions'],
      status: snapshot.session,
      contextTokens: context.contextTokens,
      contextWindow: context.contextWindow,
      active,
      phase: this.live?.projection.streaming === true
        ? livePhase(this.live)
        : conversationFacts?.phase ?? (active ? 'waiting' : 'idle'),
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
    this.live = undefined
    this.attaching = true
    this.facts.attach(binding, selection)
    this.attaching = false
    this.updateDurable()
    if (source === null) {
      this.model = createTranscriptModel('official-conversation', [], false, generation)
      this.publishModel()
      return
    }
    const snapshot = source.getSnapshot()
    this.live = projectLiveConversation(snapshot.entries)
    this.revision = snapshot.revision
    this.rebuildModel()
    this.publishModel()
    this.off = source.subscribe(() => {
      if (this.disposed || this.source !== source || attachmentGeneration !== this.attachmentGeneration) return
      const window = source.getSnapshot()
      if (window.revision <= this.revision) return
      if (window.change.kind === 'append' && window.revision === this.revision + 1) {
        for (const entry of window.change.entries) {
          if (entry.type !== 'event' || entry.event.type !== 'command/done') continue
          const { kind, text } = entry.event.data
          this.options.onCommandResult?.({ kind, ...(text === undefined ? {} : { text }) })
        }
      }
      if (window.change.kind === 'replace') this.generation += 1
      this.live = projectLiveConversation(window.entries)
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
    this.generation += 1
    this.attachmentGeneration += 1
    this.revision = -1
    this.durable = EMPTY_CONVERSATION
    this.durableValue = undefined
    this.live = undefined
    this.model = createTranscriptModel('official-conversation', [], false, this.generation)
  }

  private onFacts(): void {
    if (this.disposed || this.attaching) return
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
    this.durable = readConversationProjection(value) ?? EMPTY_CONVERSATION
    return true
  }

  private refreshTools(): void {
    if (this.disposed) return
    this.toolsRevision += 1
    this.rebuildModel()
    this.publishModel()
  }

  private rebuildModel(): void {
    const scopedTools = this.selection !== undefined && isScopedTools(this.tools)
      ? this.tools.source(this.selection.ref, this.durable)
      : this.tools
    const durable = conversationTranscriptModel(
      this.durable,
      scopedTools,
      this.generation,
      this.toolsRevision === 0 ? undefined : `tools:${String(this.toolsRevision)}`,
    )
    this.model = withLiveOverlay(durable, this.durable, this.live, this.generation, this.toolsRevision)
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
  generation: number,
  toolsRevision: number,
): TranscriptModel {
  if (live === undefined || durable.settledSteps.includes(`${String(live.turn)}:${String(live.step)}`)) return durableModel
  const staleTurn = durable.turns.some(turn => turn.turn > live.turn || (turn.turn === live.turn && turn.endedAt !== undefined))
  if (staleTurn) return durableModel
  const liveModel = conversationTranscriptModel(
    live.projection,
    EMPTY_TOOLS,
    generation,
    `live:${live.attemptId}:${String(toolsRevision)}`,
  )
  const durableIds = new Set(durableModel.entries.flatMap(entry => 'id' in entry ? [entry.id] : []))
  const durableCalls = new Set(durable.entries.flatMap(entry => entry.kind === 'tool' ? [entry.callId] : []))
  const entries = liveModel.entries.filter(entry => {
    if ('id' in entry && durableIds.has(entry.id)) return false
    return entry.kind !== 'transcript-tool' || !durableCalls.has(entry.callId)
  }) as TranscriptEntryModel[]
  if (entries.length === 0 && !live.projection.streaming) return durableModel
  return freezeModel({
    ...durableModel,
    ...(entries.length === 0 ? {} : { live: { turn: live.turn, step: live.step, entries } }),
    streaming: durableModel.streaming === true || live.projection.streaming,
  }) as TranscriptModel
}

function livePhase(live: RemoteLiveConversation): ConversationFactsState['phase'] {
  const latest = live.projection.entries.findLast(entry => (
    entry.kind === 'thinking' || entry.kind === 'assistant' || entry.kind === 'tool'
  ))
  if (latest?.kind === 'thinking') return 'thinking'
  if (latest?.kind === 'assistant') return 'composing'
  if (latest?.kind === 'tool') return 'tool'
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

function readConversationFacts(value: unknown): Pick<ConversationFactsState, 'active' | 'phase'> | undefined {
  if (!isRecord(value) || typeof value['active'] !== 'boolean') return undefined
  const phase = value['phase']
  if (phase !== 'idle' && phase !== 'waiting' && phase !== 'thinking' && phase !== 'composing' && phase !== 'tool') return undefined
  return { active: value['active'], phase }
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

function readModelRoute(value: unknown): RemoteModelSelection | undefined {
  if (!isRecord(value)) return undefined
  return typeof value['model'] === 'string' && typeof value['provider'] === 'string'
    ? { model: value['model'], provider: value['provider'] }
    : undefined
}

function isScopedTools(tools: ToolPresentationSource): tools is ScopedRemoteToolPresentationSource {
  return 'source' in tools && typeof tools.source === 'function' && 'subscribe' in tools && typeof tools.subscribe === 'function'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
