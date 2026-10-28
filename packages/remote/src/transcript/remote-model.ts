import type { SessionBinding, SessionEventLikeEntry, SessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ContentBlock as LegacyContentBlock } from '@deepseek-ai/dsh-llm'
import type { ContentBlock as CurrentContentBlock, StreamChunk as CurrentStreamChunk } from '@deepseek-ai/dsh-llm/types'
import type { StreamChunk as LegacyStreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent as CurrentSessionEvent } from '@deepseek-ai/dsh-session/types'
import { foldConversationFacts, foldConversationProjection, initialConversationFacts, initialConversationState } from '@ephemeral-ai/mayfly/conversation'
import type { ConversationFactsState, ConversationProjectionState } from '@ephemeral-ai/mayfly/conversation'
import type { TranscriptModel } from '@ephemeral-ai/mayfly/frontend'
import { conversationTranscriptModel, createTranscriptModel } from '@ephemeral-ai/mayfly/transcript'
import type { ToolPresentationSource } from '@ephemeral-ai/mayfly/transcript'
import type { SessionRef } from '../client/types.ts'

/** Immutable Session facts consumed by the remote banner, footer, and panels. */
export interface RemotePresentationFacts {
  readonly ref: SessionRef | undefined
  readonly cwd: string
  readonly title: string | undefined
  readonly model: string | undefined
  readonly provider: string | undefined
  readonly contextTokens: number
  readonly contextWindow: number | undefined
  readonly active: boolean
  readonly phase: ConversationFactsState['phase']
}

/** Selected Session metadata that is not carried by its event window. */
export interface RemotePresentationSelection {
  readonly ref: SessionRef
  readonly cwd: string
}

/** Presentation callbacks owned by the standalone Frontend. */
export interface RemoteConversationOptions {
  readonly onPresentation?: () => void
  readonly onCommandResult?: (result: { readonly kind: 'success' | 'error', readonly text?: string }) => void
}

interface RemoteFoldState {
  readonly conversation: ConversationProjectionState
  readonly facts: ConversationFactsState
}

/** Provider and model advertised by the Host for new Sessions. */
export interface RemoteModelSelection {
  readonly model: string
  readonly provider: string
}

function legacyContent(blocks: readonly CurrentContentBlock[]): readonly LegacyContentBlock[] {
  return blocks.map(block => block.type === 'file'
    ? { type: 'text', text: `[file: ${block.attachment.name}]` }
    : block as LegacyContentBlock)
}

function legacyStreamChunk(chunk: CurrentStreamChunk): LegacyStreamChunk {
  if (chunk.type === 'block-start' && chunk.blockType === 'file') {
    return { ...chunk, blockType: 'text' } as LegacyStreamChunk
  }
  if (chunk.type === 'block-end' && chunk.block.type === 'file') {
    return { ...chunk, block: { type: 'text', text: `[file: ${chunk.block.attachment.name}]` } } as LegacyStreamChunk
  }
  return chunk as LegacyStreamChunk
}

function legacySessionEvent(event: CurrentSessionEvent): never {
  switch (event.type) {
    case 'assistant/message':
      return {
        ...event,
        data: {
          ...event.data,
          message: { ...event.data.message, content: legacyContent(event.data.message.content) },
        },
      } as never
    case 'user/message':
      return {
        ...event,
        data: { ...event.data, content: legacyContent(event.data.content) },
      } as never
    case 'tool/result': {
      const message = event.data.message
      return {
        ...event,
        data: {
          ...event.data,
          message: {
            ...message,
            content: [{
              type: 'tool-result' as const,
              toolCallId: message.toolCallId,
              content: legacyContent(message.content),
              ...(message.isError === undefined ? {} : { isError: message.isError }),
            }],
          },
        },
      } as never
    }
    default:
      return event as never
  }
}

function foldEntry(state: RemoteFoldState, entry: SessionEventLikeEntry): RemoteFoldState {
  const event = entry.event
  if (event.type.startsWith('chunkrow/')) return state
  const current = event.type === 'assistant/live-chunk'
    ? {
        type: 'assistant/chunk',
        seq: event.seq,
        time: event.time,
        data: {
          turn: event.data.turn,
          step: event.data.step,
          chunk: legacyStreamChunk(event.data.chunk) as never,
        },
      } as never
    : event
  const legacy = legacySessionEvent(current)
  return {
    conversation: foldConversationProjection(state.conversation, legacy),
    facts: foldConversationFacts(state.facts, legacy),
  }
}

function conversationProjection(state: ConversationProjectionState) {
  return {
    entries: state.entries,
    streaming: state.active,
    settledSteps: state.finalizedSteps,
    turns: state.turns,
  }
}

function projectEntries(
  entries: readonly SessionEventLikeEntry[],
  tools: ToolPresentationSource,
  generation: number,
): { readonly state: RemoteFoldState, model: TranscriptModel } {
  let state: RemoteFoldState = { conversation: initialConversationState(), facts: initialConversationFacts() }
  for (const entry of entries) state = foldEntry(state, entry)
  return {
    state,
    model: conversationTranscriptModel(conversationProjection(state.conversation), tools, generation),
  }
}

/** Build Mayfly's transcript and presentation facts from one official Client event window. */
export class RemoteConversationModelSource {
  private source: SessionEventSource | null = null
  private state: RemoteFoldState = { conversation: initialConversationState(), facts: initialConversationFacts() }
  private model = createTranscriptModel('official-conversation', [], false)
  private selection: RemotePresentationSelection | undefined
  private title: string | undefined
  private selectedModel: RemoteModelSelection | undefined
  private defaultModel: RemoteModelSelection | undefined
  private contextTokens = 0
  private contextWindow: number | undefined
  private generation = 0
  private revision = -1
  private off: (() => void) | undefined
  private offTitle: (() => void) | undefined
  private offModel: (() => void) | undefined
  private offContext: (() => void) | undefined

  constructor(
    private readonly tools: ToolPresentationSource,
    private readonly publish: (model: TranscriptModel) => void,
    private readonly options: RemoteConversationOptions = {},
  ) {}

  snapshot(): TranscriptModel {
    return this.model
  }

  /** Set the Host-advertised fallback used before a Session records a model route. */
  setDefaultModel(selection: RemoteModelSelection | undefined): void {
    if (selection?.model === this.defaultModel?.model && selection?.provider === this.defaultModel?.provider) return
    this.defaultModel = selection
    this.options.onPresentation?.()
  }

  /** Return the current selected Session's immutable banner and footer facts. */
  presentation(): RemotePresentationFacts {
    return {
      ref: this.selection?.ref,
      cwd: this.selection?.cwd ?? '',
      title: this.title,
      model: this.selectedModel?.model ?? this.defaultModel?.model,
      provider: this.selectedModel?.provider ?? this.defaultModel?.provider,
      contextTokens: this.contextTokens,
      contextWindow: this.contextWindow,
      active: this.state.facts.active,
      phase: this.state.facts.phase,
    }
  }

  attach(input: SessionEventSource | SessionBinding | null, selection?: RemotePresentationSelection): void {
    this.releaseSubscriptions()
    const binding = input !== null && 'eventSource' in input ? input : undefined
    const source = binding === undefined ? input as SessionEventSource | null : binding.eventSource
    this.source = source
    this.selection = selection
    this.title = undefined
    this.selectedModel = undefined
    this.contextTokens = 0
    this.contextWindow = undefined
    const generation = ++this.generation
    this.revision = -1
    if (source === null) {
      this.state = { conversation: initialConversationState(), facts: initialConversationFacts() }
      this.model = createTranscriptModel('official-conversation', [], false, generation)
      this.publishModel()
      return
    }
    if (binding !== undefined) {
      const title = binding.session.projections.faceOf('title')
      const model = binding.session.projections.faceOf('modelSelection')
      const context = binding.session.projections.faceOf('contextPressure')
      const readTitle = (): void => {
        if (this.source !== source) return
        const value = title.getSnapshot()
        const next = typeof value === 'string' ? value : undefined
        if (next === this.title) return
        this.title = next
        this.options.onPresentation?.()
      }
      const readModel = (): void => {
        if (this.source !== source) return
        const next = readModelSelection(model.getSnapshot())
        if (next?.model === this.selectedModel?.model && next?.provider === this.selectedModel?.provider) return
        this.selectedModel = next
        this.options.onPresentation?.()
      }
      const readContext = (): void => {
        if (this.source !== source) return
        const next = readContextPressure(context.getSnapshot())
        if (next.contextTokens === this.contextTokens && next.contextWindow === this.contextWindow) return
        this.contextTokens = next.contextTokens
        this.contextWindow = next.contextWindow
        this.options.onPresentation?.()
      }
      readTitle()
      readModel()
      readContext()
      this.offTitle = title.subscribe(readTitle)
      this.offModel = model.subscribe(readModel)
      this.offContext = context.subscribe(readContext)
    }
    const snapshot = source.getSnapshot()
    this.rebuild(snapshot.entries, generation, snapshot.revision)
    this.off = source.subscribe(() => {
      if (this.source !== source) return
      const window = source.getSnapshot()
      if (window.revision <= this.revision) return
      if (window.change.kind === 'append' && window.revision === this.revision + 1) {
        for (const entry of window.change.entries) {
          this.state = foldEntry(this.state, entry)
          if (entry.type === 'event' && entry.event.type === 'command/done') {
            const { kind, text } = entry.event.data
            this.options.onCommandResult?.({ kind, ...(text === undefined ? {} : { text }) })
          }
        }
        this.revision = window.revision
        this.model = conversationTranscriptModel(
          conversationProjection(this.state.conversation),
          this.tools,
          this.generation,
        )
        this.publishModel()
        return
      }
      if (window.change.kind === 'replace') this.generation += 1
      this.rebuild(window.entries, this.generation, window.revision)
    })
  }

  dispose(): void {
    this.releaseSubscriptions()
    this.source = null
    this.selection = undefined
    this.title = undefined
    this.selectedModel = undefined
    this.contextTokens = 0
    this.contextWindow = undefined
    this.generation += 1
    this.revision = -1
    this.state = { conversation: initialConversationState(), facts: initialConversationFacts() }
    this.model = createTranscriptModel('official-conversation', [], false, this.generation)
  }

  private publishModel(): void {
    this.publish(this.model)
    this.options.onPresentation?.()
  }

  private releaseSubscriptions(): void {
    this.off?.()
    this.offTitle?.()
    this.offModel?.()
    this.offContext?.()
    this.off = undefined
    this.offTitle = undefined
    this.offModel = undefined
    this.offContext = undefined
  }

  private rebuild(entries: readonly SessionEventLikeEntry[], generation: number, revision: number): void {
    const projected = projectEntries(entries, this.tools, generation)
    this.state = projected.state
    this.model = projected.model
    this.revision = revision
    this.publishModel()
  }
}

function readContextPressure(value: unknown): { readonly contextTokens: number, readonly contextWindow?: number } {
  if (value === null || typeof value !== 'object') return { contextTokens: 0 }
  const projection = value as { projectedTokens?: unknown, pressureTokens?: unknown, contextWindow?: unknown }
  const contextTokens = typeof projection.projectedTokens === 'number'
    ? projection.projectedTokens
    : typeof projection.pressureTokens === 'number' ? projection.pressureTokens : 0
  return {
    contextTokens,
    ...(typeof projection.contextWindow === 'number' ? { contextWindow: projection.contextWindow } : {}),
  }
}

function readModelSelection(value: unknown): RemoteModelSelection | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const projection = value as { next?: unknown, lastUsed?: unknown }
  return readModelRoute(projection.next) ?? readModelRoute(projection.lastUsed)
}

function readModelRoute(value: unknown): RemoteModelSelection | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const route = value as { model?: unknown, provider?: unknown }
  return typeof route.model === 'string' && typeof route.provider === 'string'
    ? { model: route.model, provider: route.provider }
    : undefined
}
