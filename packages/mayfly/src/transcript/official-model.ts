/**
 * Projection mapper from the official `mayflyConversation` session projection
 * to Mayfly's renderer-neutral transcript model. It reads the native projection
 * registry for the exact current session and never folds Harness events.
 *
 * @module @ephemeral-ai/mayfly/transcript/official-model
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ToolCallView, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import {
  type ConversationEntry,
  type ConversationProjection,
  type ConversationToolEntry,
} from '../conversation/index.ts'
import type { LiveAssistantDraft, LiveAssistantStreamService } from '../conversation/live-stream.ts'
import { freezeModel, type CommandCallModel, type ReadCallModel, type SearchCallModel, type TranscriptCommandGroupModel, type TranscriptEntryModel, type TranscriptModel, type TranscriptReadGroupModel, type TranscriptSearchGroupModel, type TranscriptToolFamily } from '../frontend/index.ts'
import { createToolPresentationModel } from './tool-model.ts'
import { createTranscriptModel } from './transcript-model.ts'
import { ellipsize, parseToolArguments, resolveCallView, resolveResultView, type ToolPresentationSource } from './present.ts'

/**
 * Live assistant-stream draft source. Harness `0.1.5` publishes streaming
 * deltas as transient Agent frames the session projection never sees; the
 * mapper overlays the current draft as synthetic streaming entries until the
 * durable settlement rewrites the step.
 */
export interface LiveDraftSource {
  subscribe(listener: () => void): () => void
  get(agent: Agent): LiveAssistantDraft | undefined
}

/** Adapt the optional ctx live-stream service into a draft source. */
export function liveDraftsOf(ctx: { get(name: 'mayflyLiveAssistantStream'): unknown }): LiveDraftSource | undefined {
  const service = ctx.get('mayflyLiveAssistantStream') as LiveAssistantStreamService | undefined
  if (service === undefined) return undefined
  return {
    subscribe: listener => service.subscribe(listener),
    get: agent => service.get(agent),
  }
}

/**
 * Native projection read face consumed by the transcript mapper. The registry
 * validates complete values; the mapper repeats admission on the next read.
 */
export interface ConversationProjectionSource {
  snapshot(session: Session, keys?: readonly ['mayflyConversation']): { readonly asOfSeq: number, readonly values: Readonly<Record<string, unknown>> }
  onChanged(listener: (session: Session, key: string, value: unknown, seq: number) => void): () => void
}

interface PendingProjection {
  readonly value: unknown
  readonly seq: number
}

/** Preview lines a read window carries for the expanded group view. */
export const READ_PREVIEW_LINE_LIMIT = 5

/** Match previews a search group's file row carries when expanded. */
export const SEARCH_PREVIEW_MATCH_LIMIT = 3

/** Path rows a search group's glob call carries when expanded. */
export const SEARCH_PATH_LIMIT = 16

/** Output-tail rows a command group's member carries when expanded. */
export const COMMAND_PREVIEW_LINE_LIMIT = 4

/** One tool entry with its presenter views resolved exactly once. */
export interface ResolvedTool {
  readonly entry: ConversationToolEntry
  readonly args: unknown
  readonly outcome: ToolResult | undefined
  readonly call: ToolCallView | undefined
  readonly result: ToolResultView | undefined
}

function toolResult(entry: ConversationToolEntry): ToolResult | undefined {
  if (entry.result === undefined) return undefined
  /* Presenter inputs are deep-copied: a mutating presenter must not corrupt
     the registry-owned wire view this entry belongs to. */
  return {
    content: structuredClone(entry.result.content) as unknown as ContentBlock[],
    isError: entry.result.isError,
    ...(entry.result.meta === undefined ? {} : { meta: structuredClone(entry.result.meta) }),
  }
}

/** Resolve one tool entry's presenter views (contained; void on any failure). */
function resolveTool(entry: ConversationToolEntry, tools: ToolPresentationSource): ResolvedTool {
  const args = parseToolArguments(entry.arguments)
  const outcome = toolResult(entry)
  const call = resolveCallView(tools, entry.name, args)
  const result = outcome === undefined ? undefined : resolveResultView(tools, entry.name, args, outcome)
  return { entry, args, outcome, call, result }
}

/**
 * Whether a tool entry presents as a read — by presenter vocabulary, not
 * tool name: the pending call declares `kind: 'read'`, or the settled result
 * carries the read card.
 */
function isReadTool(resolved: ResolvedTool): boolean {
  if (resolved.call?.card === 'generic' && resolved.call.kind === 'read') return true
  return resolved.result?.card === 'read'
}

/**
 * Whether a tool entry presents as a search (grep or glob) — by presenter
 * vocabulary: the pending call declares `kind: 'search'`, or the settled
 * result carries the search card (whose `shape` separates content matches
 * from path lists).
 */
function isSearchTool(resolved: ResolvedTool): boolean {
  if (resolved.call?.card === 'generic' && resolved.call.kind === 'search') return true
  return resolved.result?.card === 'search'
}

/**
 * Whether a tool entry presents as a command — by presenter vocabulary: the
 * pending call or the settled result declares the terminal card.
 */
function isCommandTool(resolved: ResolvedTool): boolean {
  return resolved.call?.card === 'terminal' || resolved.result?.card === 'terminal'
}

/** Whether a tool entry presents as a file mutation — the diff card. */
function isEditTool(resolved: ResolvedTool): boolean {
  return resolved.call?.card === 'diff' || resolved.result?.card === 'diff'
}

/** Whether a tool entry presents as a web fetch/search — the result-only web card. */
function isWebTool(resolved: ResolvedTool): boolean {
  return resolved.result?.card === 'web'
}

/** The card family a tool entry presents as; read/search/command group, the rest stay lone cards. */
type ToolFamily = 'read' | 'search' | TranscriptToolFamily

function toolFamily(resolved: ResolvedTool): ToolFamily {
  if (isReadTool(resolved)) return 'read'
  if (isSearchTool(resolved)) return 'search'
  if (isCommandTool(resolved)) return 'command'
  if (isEditTool(resolved)) return 'edit'
  if (isWebTool(resolved)) return 'web'
  return 'other'
}

/** The read arguments this mapper understands, degraded to unknowns. */
function readArgumentRecord(args: unknown): Record<string, unknown> {
  if (args === undefined || typeof args !== 'object' || args === null) return {}
  return args as Record<string, unknown>
}

/** A row label for a read-kind call without a file: the first short string argument, prefixed by its key. */
function salientArgument(record: Record<string, unknown>): string | undefined {
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' && value !== '' && value.length <= 60) return `${key}: ${value}`
  }
  return undefined
}

function firstNonEmptyLine(text: string): string | undefined {
  return text.split('\n').find(line => line.trim() !== '')
}

/** Build one read call's renderer-neutral facts from entry, arguments, and views. */
function readCallModel(resolved: ResolvedTool): ReadCallModel {
  const { entry, args, outcome, result } = resolved
  const record = readArgumentRecord(args)
  const view = result?.card === 'read' ? result : undefined
  const path = typeof record['file_path'] === 'string' && record['file_path'] !== ''
    ? record['file_path']
    : typeof record['path'] === 'string' && record['path'] !== ''
      ? record['path']
      : view?.path
  // Read-kind calls without a file (the jobs reader, for one) still group;
  // their row falls back to the salient argument so the member stays visible.
  const label = path === undefined ? salientArgument(record) : undefined
  const offset = typeof record['offset'] === 'number' && record['offset'] > 0 ? record['offset'] : 1
  const limit = typeof record['limit'] === 'number' ? record['limit'] : undefined
  const lines = view?.lines ?? []
  const state = outcome === undefined ? 'pending' : outcome.isError ? 'error' : 'ok'
  // state 'error' implies entry.result exists: the outcome derives from it.
  return {
    callId: entry.callId,
    seq: entry.seq,
    updatedSeq: entry.updatedSeq,
    turn: entry.turn,
    step: entry.step,
    ...(path === undefined ? {} : { path }),
    ...(label === undefined ? {} : { label }),
    ...(limit === undefined ? {} : { requestedRange: { first: offset, last: offset + limit - 1 } }),
    ...(lines.length === 0 ? {} : { range: { first: lines[0]!.number, last: lines.at(-1)!.number } }),
    ...(view?.totalLines === undefined ? {} : { totalLines: view.totalLines }),
    state,
    ...(state === 'error' ? { error: ellipsize(firstNonEmptyLine(entry.result!.text) ?? 'read failed', 120) } : {}),
    ...(lines.length === 0 ? {} : {
      previewLines: lines.slice(0, READ_PREVIEW_LINE_LIMIT).map(line => ({ number: line.number, text: line.text })),
    }),
  }
}

/** Fold a run of resolved read entries into one group model. */
function readGroupModel(run: readonly ResolvedTool[]): TranscriptReadGroupModel {
  const first = run[0]!
  return {
    kind: 'transcript-read-group',
    id: `read-group:${String(first.entry.id)}`,
    seq: first.entry.seq,
    updatedSeq: Math.max(...run.map(item => item.entry.updatedSeq)),
    turn: first.entry.turn,
    step: first.entry.step,
    reads: run.map(readCallModel),
  }
}

/** Build one search call's renderer-neutral facts from entry, arguments, and views. */
function searchCallModel(resolved: ResolvedTool): SearchCallModel {
  const { entry, args, outcome, result } = resolved
  const record = readArgumentRecord(args)
  const pattern = typeof record['pattern'] === 'string' && record['pattern'] !== '' ? record['pattern'] : undefined
  const view = result?.card === 'search' ? result : undefined
  const state = outcome === undefined ? 'pending' : outcome.isError ? 'error' : 'ok'
  return {
    callId: entry.callId,
    seq: entry.seq,
    updatedSeq: entry.updatedSeq,
    turn: entry.turn,
    step: entry.step,
    ...(pattern === undefined ? {} : { pattern }),
    ...(view === undefined ? {} : { shape: view.shape }),
    ...(view?.shape === 'matches' ? {
      files: view.files.map(file => ({
        path: file.path,
        count: file.matches.length,
        previews: file.matches.slice(0, SEARCH_PREVIEW_MATCH_LIMIT).map(match => ({ lineNumber: match.lineNumber, line: match.line })),
      })),
    } : {}),
    ...(view?.shape === 'paths' ? { paths: view.paths.slice(0, SEARCH_PATH_LIMIT), pathsTotal: view.total } : {}),
    ...(view === undefined ? {} : { truncated: view.truncated }),
    ...(view?.total === undefined ? {} : { total: view.total }),
    state,
    ...(state === 'error' ? { error: ellipsize(firstNonEmptyLine(entry.result!.text) ?? 'search failed', 120) } : {}),
  }
}

/** Fold a run of resolved search entries into one group model. */
function searchGroupModel(run: readonly ResolvedTool[]): TranscriptSearchGroupModel {
  const first = run[0]!
  return {
    kind: 'transcript-search-group',
    id: `search-group:${String(first.entry.id)}`,
    seq: first.entry.seq,
    updatedSeq: Math.max(...run.map(item => item.entry.updatedSeq)),
    turn: first.entry.turn,
    step: first.entry.step,
    searches: run.map(searchCallModel),
  }
}

/** The bounded output tail one command member carries for the expanded view. */
function commandPreviewLines(output: string): string[] | undefined {
  const lines = output.replace(/\n+$/, '').split('\n')
  if (lines.length === 0 || lines.every(line => line.trim() === '')) return undefined
  return lines.slice(-COMMAND_PREVIEW_LINE_LIMIT).map(line => ellipsize(line, 160))
}

/** Build one command call's renderer-neutral facts from entry, arguments, and views. */
function commandCallModel(resolved: ResolvedTool): CommandCallModel {
  const { entry, args, outcome, call, result } = resolved
  const record = readArgumentRecord(args)
  const callView = call?.card === 'terminal' ? call : undefined
  const resultView = result?.card === 'terminal' ? result : undefined
  const argCommand = typeof record['command'] === 'string' && record['command'] !== '' ? record['command'] : undefined
  const command = callView?.title ?? resultView?.title ?? argCommand ?? entry.name
  const output = resultView?.output ?? (entry.result === undefined ? undefined : entry.result.text)
  const state = outcome === undefined ? 'pending' : outcome.isError ? 'error' : 'ok'
  const previewLines = output === undefined ? undefined : commandPreviewLines(output)
  return {
    callId: entry.callId,
    seq: entry.seq,
    updatedSeq: entry.updatedSeq,
    turn: entry.turn,
    step: entry.step,
    command: ellipsize(command, 120),
    state,
    ...(resultView?.exitCode === undefined ? {} : { exitCode: resultView.exitCode }),
    ...(resultView?.signal === undefined ? {} : { signal: resultView.signal }),
    ...(state === 'error' ? { error: ellipsize(firstNonEmptyLine(entry.result!.text) ?? 'command failed', 120) } : {}),
    ...(previewLines === undefined ? {} : { previewLines }),
  }
}

/** Fold a run of resolved command entries into one group model. */
function commandGroupModel(run: readonly ResolvedTool[]): TranscriptCommandGroupModel {
  const first = run[0]!
  return {
    kind: 'transcript-command-group',
    id: `command-group:${String(first.entry.id)}`,
    seq: first.entry.seq,
    updatedSeq: Math.max(...run.map(item => item.entry.updatedSeq)),
    turn: first.entry.turn,
    step: first.entry.step,
    commands: run.map(commandCallModel),
  }
}

function toolModel(resolved: ResolvedTool, family: TranscriptToolFamily): TranscriptEntryModel {
  const { entry, outcome, call, result } = resolved
  const presentation = call === undefined && result === undefined
    ? undefined
    : createToolPresentationModel({
        id: entry.id,
        name: entry.name,
        ...(call === undefined ? {} : { call }),
        ...(result === undefined ? {} : { result }),
        ...(outcome === undefined ? {} : { outcome }),
      })
  return {
    kind: 'transcript-tool',
    id: entry.id,
    seq: entry.seq,
    updatedSeq: entry.updatedSeq,
    turn: entry.turn,
    step: entry.step,
    callId: entry.callId,
    name: entry.name,
    family,
    arguments: entry.arguments,
    startedAt: entry.startedAt,
    ...(entry.result === undefined ? {} : {
      result: {
        text: entry.result.text,
        fullText: entry.result.text,
        isError: entry.result.isError,
        endedAt: entry.result.endedAt,
      },
    }),
    ...(presentation === undefined ? {} : { presentation }),
  }
}

function entryModel(entry: Exclude<ConversationEntry, ConversationToolEntry>): TranscriptEntryModel {
  switch (entry.kind) {
    case 'user':
      return {
        kind: 'transcript-user', id: entry.id, seq: entry.seq, updatedSeq: entry.updatedSeq, turn: entry.turn, text: entry.text,
        images: entry.images.map(image => ({
          attachmentId: image.attachmentId,
          mediaType: image.mediaType,
          bytes: image.bytes,
          width: image.width,
          height: image.height,
          ...(image.name === undefined ? {} : { name: image.name }),
          ...(image.originalDimensions === undefined ? {} : {
            originalDimensions: { ...image.originalDimensions },
          }),
        })),
      }
    case 'assistant':
      return {
        kind: 'transcript-assistant', id: entry.id, seq: entry.seq, updatedSeq: entry.updatedSeq, turn: entry.turn, step: entry.step,
        text: entry.text, streaming: entry.streaming,
      }
    case 'thinking':
      return {
        kind: 'transcript-thinking', id: entry.id, seq: entry.seq, updatedSeq: entry.updatedSeq, turn: entry.turn, step: entry.step,
        text: entry.text, streaming: entry.streaming,
        ...(entry.outputProgress === undefined ? {} : { outputProgress: entry.outputProgress }),
      }
    case 'error':
      return {
        kind: 'transcript-error', id: entry.id, seq: entry.seq, updatedSeq: entry.updatedSeq, turn: entry.turn, message: entry.message,
        ...(entry.code === undefined ? {} : { code: entry.code }),
      }
    case 'interrupted':
      return { kind: 'transcript-interrupted', id: entry.id, seq: entry.seq, updatedSeq: entry.updatedSeq, turn: entry.turn }
  }
}

/** Convert one validated official whole value to a frozen Mayfly model. */
export function conversationTranscriptModel(
  projection: ConversationProjection,
  tools: ToolPresentationSource,
  generation = 0,
  renderRevision?: string,
  resolvedTools?: Map<string, ResolvedTool>,
): TranscriptModel {
  const entries: TranscriptEntryModel[] = []
  let run: ResolvedTool[] = []
  let runFamily: ToolFamily | undefined
  const flushRun = (): void => {
    if (run.length === 0) return
    /* A single command keeps its lone card — the output preview carries more
       than a one-member group header would. */
    if (runFamily === 'command' && run.length === 1) entries.push(toolModel(run[0]!, 'command'))
    else entries.push(
      runFamily === 'search' ? searchGroupModel(run)
        : runFamily === 'command' ? commandGroupModel(run)
          : readGroupModel(run))
    run = []
    runFamily = undefined
  }
  for (const entry of projection.entries) {
    if (entry.kind !== 'tool') {
      // Thinking is meta, not content: it neither renders into the run nor
      // breaks it — grouped families stay grouped across the model's
      // reasoning.
      if (entry.kind !== 'thinking') flushRun()
      entries.push(entryModel(entry))
      continue
    }
    if (entry.channel !== 'transcript') continue
    /* Presenters re-resolve on every pending value; keying on the durable
       entry id + its last-update seq makes steady-state mapping O(changed). */
    const key = JSON.stringify([entry.id, entry.updatedSeq])
    let resolved = resolvedTools?.get(key)
    if (resolved === undefined) {
      resolved = resolveTool(entry, tools)
      resolvedTools?.set(key, resolved)
    }
    const family = toolFamily(resolved)
    const continuesRun = runFamily !== undefined
      && family === runFamily
      && entry.turn === run[0]!.entry.turn
    if (!continuesRun) flushRun()
    if (family === 'read' || family === 'search' || family === 'command') {
      run.push(resolved)
      runFamily = family
      continue
    }
    entries.push(toolModel(resolved, family))
  }
  flushRun()
  const renderedEntries = renderRevision === undefined ? entries : entries.map(entry => ({ ...entry, renderRevision: `${renderRevision}:${String(entry.updatedSeq)}` }))
  return createTranscriptModel('official-conversation', renderedEntries, projection.streaming, generation)
}

/** Entry kinds the mapper dereferences; anything else is not our wire value. */
const ADMITTED_KINDS = new Set(['user', 'assistant', 'thinking', 'tool', 'error', 'interrupted'])

/** The entry fields this mapper dereferences; the rest stay opaque here. */
function admissibleEntry(candidate: unknown): candidate is ConversationEntry {
  if (candidate === null || typeof candidate !== 'object') return false
  const kind = (candidate as { kind?: unknown }).kind
  const seq = (candidate as { seq?: unknown }).seq
  return typeof kind === 'string' && ADMITTED_KINDS.has(kind)
    && typeof seq === 'number' && Number.isSafeInteger(seq)
}

/**
 * The registry schema-validates the complete wire value before publishing,
 * so admission here only checks the envelope and the entry fields this
 * mapper dereferences, then slices history when a resume cutoff applies.
 */
function visibleProjection(
  value: unknown,
  transcriptAfterSeq: number | undefined,
): ConversationProjection | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const envelope = value as { entries?: unknown, streaming?: unknown, settledSteps?: unknown }
  if (!Array.isArray(envelope.entries) || typeof envelope.streaming !== 'boolean' || !Array.isArray(envelope.settledSteps)) return undefined
  /* One pass over the wire array: admit every entry and cut off inherited
     history at the same time. Downstream mapping works on this copy, so the
     published array is never re-read (see the history-read-count specs). */
  const entries: ConversationEntry[] = []
  for (const candidate of envelope.entries) {
    if (!admissibleEntry(candidate)) return undefined
    if (transcriptAfterSeq === undefined || candidate.seq > transcriptAfterSeq) entries.push(candidate)
  }
  return { entries, streaming: envelope.streaming, settledSteps: envelope.settledSteps as string[] }
}

/** Projection-to-model source scoped to one frontend tree and provider Fiber. */
export class OfficialConversationModelSource {
  private model: TranscriptModel = createTranscriptModel('official-conversation', [], false)
  private session: Session | null = null
  private agent: Agent | undefined
  private generation = 0
  private watermark = -1
  private pending: PendingProjection | undefined
  private durableModel: TranscriptModel | undefined
  private lastVisible: ConversationProjection | undefined
  private settledSteps = new Set<string>()
  private liveSeq = 0
  private toolsRevision = 0
  private lastDraft: LiveAssistantDraft | undefined
  private transcriptAfterSeq: number | undefined
  private readonly resolvedTools = new Map<string, ResolvedTool>()
  private disposed = false
  private readonly offChanged: () => void
  private readonly offLive: () => void

  constructor(
    private readonly projections: ConversationProjectionSource,
    private readonly tools: ToolPresentationSource,
    private readonly publish: () => void,
    private readonly live?: LiveDraftSource,
  ) {
    this.offChanged = projections.onChanged((session, key, value, seq) => {
      if (this.disposed || session !== this.session || key !== 'mayflyConversation' || seq <= Math.max(this.watermark, this.pending?.seq ?? -1)) return
      // Native changes are complete, validated values. Keep only the latest
      // until a renderer reads it, so a burst never maps history per token.
      const notify = this.pending === undefined
      this.pending = { value, seq }
      if (notify) this.publish()
    })
    this.offLive = live === undefined ? () => {} : live.subscribe(() => {
      // Live notifications cover every Agent. Repaint only when the exact
      // selected Agent's draft identity changed; this keeps unrelated child
      // streams from invalidating the main transcript while still waking it
      // for every reasoning/text delta and for draft removal on end.
      const draft = this.agent === undefined ? undefined : live.get(this.agent)
      if (draft !== this.lastDraft) this.publish()
    })
  }

  /** Convert the latest unread native value once, then reuse its model. */
  snapshot(): TranscriptModel {
    const draft = this.agent === undefined ? undefined : this.live?.get(this.agent)
    const pending = this.pending
    if (pending !== undefined) {
      this.pending = undefined
      const visible = visibleProjection(pending.value, this.transcriptAfterSeq)
      if (visible !== undefined) {
        this.watermark = pending.seq
        this.lastVisible = visible
        this.durableModel = conversationTranscriptModel(visible, this.tools, this.generation, undefined, this.resolvedTools)
        this.settledSteps = new Set(visible.settledSteps)
        this.liveSeq = visible.entries.reduce((seq, entry) => Math.max(seq, entry.seq), pending.seq) + 1
        this.lastDraft = draft
        this.model = withLiveDraft(this.durableModel, this.settledSteps, draft, this.liveSeq, this.watermark)
      }
    } else if (draft !== this.lastDraft && this.durableModel !== undefined) {
      this.lastDraft = draft
      this.model = withLiveDraft(this.durableModel, this.settledSteps, draft, this.liveSeq, this.watermark)
    }
    return this.model
  }

  /** Re-resolve durable tool presenters without changing session generation. */
  invalidateTools(): void {
    if (this.disposed) return
    if (this.lastVisible !== undefined) {
      this.toolsRevision += 1
      this.resolvedTools.clear()
      this.durableModel = conversationTranscriptModel(this.lastVisible, this.tools, this.generation, `tools:${String(this.toolsRevision)}`, this.resolvedTools)
      const draft = this.agent === undefined ? undefined : this.live?.get(this.agent)
      this.lastDraft = draft
      this.model = withLiveDraft(this.durableModel, this.settledSteps, draft, this.liveSeq, this.watermark)
    }
    this.publish()
  }

  /** Attach to the app's current session, clearing stale content first. */
  attach(session: Session | null, transcriptAfterSeq?: number, agent?: Agent): void {
    if (this.disposed) return
    this.session = session
    this.agent = agent?.session === session ? agent : undefined
    this.transcriptAfterSeq = transcriptAfterSeq
    this.generation += 1
    this.watermark = -1
    this.pending = undefined
    this.durableModel = undefined
    this.lastVisible = undefined
    this.resolvedTools.clear()
    this.settledSteps.clear()
    this.lastDraft = undefined
    this.model = createTranscriptModel('official-conversation', [], false, this.generation)
    if (session === null) {
      this.publish()
      return
    }
    const snapshot = this.projections.snapshot(session, ['mayflyConversation'])
    this.watermark = snapshot.asOfSeq
    this.pending = { value: snapshot.values.mayflyConversation, seq: snapshot.asOfSeq }
    this.publish()
  }

  /** Drop the subscription and reject every late projection callback. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.offChanged()
    this.offLive()
    this.session = null
    this.agent = undefined
    this.pending = undefined
    this.durableModel = undefined
    this.lastVisible = undefined
    this.resolvedTools.clear()
    this.settledSteps.clear()
    this.lastDraft = undefined
    this.transcriptAfterSeq = undefined
    this.model = createTranscriptModel('official-conversation', [], false)
  }
}

/**
 * Overlay only the current step onto the already-mapped durable model. Stable
 * history entries retain identity and never rerun their tool presenters during
 * token updates. Live revision tokens remain separate from durable event seqs.
 */
function withLiveDraft(
  durable: TranscriptModel,
  settledSteps: ReadonlySet<string>,
  draft: LiveAssistantDraft | undefined,
  seq: number,
  updatedSeq: number,
): TranscriptModel {
  if (draft === undefined || settledSteps.has(`${String(draft.turn)}:${String(draft.step)}`)) return durable
  const renderRevision = `live:${draft.attemptId}:${String(draft.revision)}`
  const liveEntries: TranscriptEntryModel[] = []
  if (draft.reasoning.trim() !== '') {
    liveEntries.push({
      kind: 'transcript-thinking',
      id: `thinking:${String(draft.turn)}:${String(draft.step)}`,
      seq,
      updatedSeq,
      renderRevision,
      turn: draft.turn,
      step: draft.step,
      text: draft.reasoning,
      streaming: draft.phase === 'thinking',
      ...(draft.phase === 'thinking' ? { outputProgress: draft.outputProgress } : {}),
    })
  }
  if (draft.text !== '') {
    liveEntries.push({
      kind: 'transcript-assistant',
      id: `assistant:${String(draft.turn)}:${String(draft.step)}`,
      seq,
      updatedSeq,
      renderRevision,
      turn: draft.turn,
      step: draft.step,
      text: draft.text,
      streaming: true,
    })
  }
  return freezeModel({ ...durable, entries: durable.entries, live: { turn: draft.turn, step: draft.step, entries: liveEntries }, streaming: true }) as TranscriptModel
}
