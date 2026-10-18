/**
 * Projection mapper from the official `mayflyConversation` session projection
 * to Mayfly's renderer-neutral transcript model. It reads one conversation
 * feed — a live Session through the native registry or a stored child through
 * its native address — and never folds Harness events.
 *
 * @module @ephemeral-ai/mayfly/transcript/official-model
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { interpolateLocaleMessage, type MayflyTranslate } from '../frontend/locale.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ToolCallView, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { ConversationEntry, ConversationProjection, ConversationToolEntry } from '../conversation/types.ts'
import type { LiveAssistantDraft } from '../conversation/live-stream.ts'
import {
  SessionConversationFeed,
  type ConversationFeed,
  type ConversationFeedState,
  type ConversationProjectionSource,
  type LiveDraftSource,
} from './conversation-feed.ts'
import { freezeModel, type CommandCallModel, type ReadCallModel, type SearchCallModel, type TranscriptCommandGroupModel, type TranscriptEntryModel, type TranscriptFileChangeModel, type TranscriptModel, type TranscriptReadGroupModel, type TranscriptSearchGroupModel, type ToolInterruption, type TranscriptTerminalModel, type TranscriptToolFamily, type TranscriptTurnModel, type TranscriptWebModel } from '../frontend/models.ts'
import { diffChangeCounts } from '../core/diff-align.ts'
import { countWork, type MayflyWorkCounters } from '../core/ui-work-counters.ts'
import { createToolPresentationModel } from './tool-model.ts'
import { createTranscriptModel } from './transcript-model.ts'
import { ellipsize, parseToolArguments, resolveCallView, resolveResultView, type ToolPresentationSource } from './present.ts'
import { toolDetail } from '../conversation/activity-detail.ts'
import { toolActivity } from './process-activity.ts'

/** Preview lines a read window carries: the body of its verbose block, opened to every row by Ctrl+O. */
export const READ_PREVIEW_LINE_LIMIT = 40

/** Match previews a search file carries for the body of its verbose block. */
export const SEARCH_PREVIEW_MATCH_LIMIT = 3

/** Path rows a glob call carries for the body of its verbose block. */
export const SEARCH_PATH_LIMIT = 40

/** Output-tail rows a command carries for the body of its verbose block. */
export const COMMAND_PREVIEW_LINE_LIMIT = 40

/** Lines of a multi-line command that a call carries as its input rows. */
const COMMAND_INPUT_LINE_LIMIT = 40

/** Characters one command output-tail row keeps before truncation. */
const COMMAND_PREVIEW_LINE_MAX_CHARS = 160

/** Lines of each side an edit hunk carries; the change's counts are taken over all of them. */
const FILE_CHANGE_HUNK_LINES = 60

/** Lines of a write's new text the facts carry for its code body (the most any tier shows). */
export const WRITE_HEAD_LINES = 40

/** One tool entry with its presenter views resolved exactly once. */
interface ResolvedTool {
  readonly entry: ConversationToolEntry
  readonly args: unknown
  readonly outcome: ToolResult | undefined
  readonly call: ToolCallView | undefined
  readonly result: ToolResultView | undefined
}

/** One run of unchanged tools with the group model built from it. */
interface CachedToolGroup {
  readonly members: readonly ResolvedTool[]
  readonly revision: string | undefined
  readonly model: TranscriptEntryModel
}

/**
 * Identity caches for one conversation source. Entries are keyed by their
 * registry-owned wire objects, which the projection retains across whole
 * values; presenters and models are keyed by the resolved tool they belong to.
 * A source replaces the whole object on attach and the tool half on a
 * tools/change, so a stale presenter is never served.
 */
export interface TranscriptModelCaches {
  /** Non-tool entry models, by the durable entry object they were mapped from. */
  readonly entries: WeakMap<object, TranscriptEntryModel>
  /** Resolved presenters, by the durable tool entry object. */
  readonly tools: WeakMap<object, ResolvedTool>
  /** Lone tool models, by the resolved tool. */
  readonly models: WeakMap<ResolvedTool, TranscriptEntryModel>
  /** Read/search/command group models, by their first resolved member. */
  readonly groups: WeakMap<ResolvedTool, CachedToolGroup>
}

/** Fresh, empty identity caches. */
export function createTranscriptModelCaches(): TranscriptModelCaches {
  return { entries: new WeakMap(), tools: new WeakMap(), models: new WeakMap(), groups: new WeakMap() }
}

/** The presentation revision one entry carries: the source revision and the entry's durable update. */
function entryRevision(renderRevision: string | undefined, updatedSeq: number): string | undefined {
  return renderRevision === undefined ? undefined : `${renderRevision}:${String(updatedSeq)}`
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

const INTERRUPTIONS: Readonly<Record<string, ToolInterruption>> = {
  ABORTED: 'aborted',
  ABORTED_BEFORE_DISPATCH: 'not-started',
  TOOL_NOT_STARTED: 'not-started',
  TOOL_OUTCOME_UNKNOWN: 'unknown',
}

/** How the Harness cut an entry's call short, from the failure code of its result; nothing for a call that settled on its own. */
function interruptionFacts(entry: ConversationToolEntry): { readonly interruption?: ToolInterruption } {
  const result = entry.result
  const interruption = result?.isError === true && result.code !== undefined ? INTERRUPTIONS[result.code] : undefined
  return interruption === undefined ? {} : { interruption }
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
 * Whether a tool entry presents as a file read — by presenter vocabulary, not
 * tool name: the settled result carries the read card, or the call declares
 * `kind: 'read'` over at least one file location. A read-kind call without a
 * file (a skill load, a job reader, a goal lookup) stays a lone card.
 */
function isReadTool(resolved: ResolvedTool): boolean {
  if (resolved.result?.card === 'read') return true
  return resolved.call?.card === 'generic' && resolved.call.kind === 'read' && (resolved.call.locations?.length ?? 0) > 0
}

/**
 * Whether a tool entry presents as a code search (grep or glob) — by
 * presenter vocabulary: the settled result carries the search card, or the
 * call declares `kind: 'search'` with a `pattern` argument and did not settle
 * as a web card. A web search (queries, web result) stays a lone web card.
 */
function isSearchTool(resolved: ResolvedTool): boolean {
  if (resolved.result?.card === 'search') return true
  if (resolved.result?.card === 'web') return false
  return resolved.call?.card === 'generic' && resolved.call.kind === 'search'
    && typeof readArgumentRecord(resolved.args)['pattern'] === 'string'
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

/** The tool a call used, when it started, and, once its result settled, when it ended. */
function callFacts(entry: ConversationToolEntry): { readonly name: string, readonly startedAt: number, readonly endedAt?: number } {
  return { name: entry.name, startedAt: entry.startedAt, ...(entry.result === undefined ? {} : { endedAt: entry.result.endedAt }) }
}

/** The process activity and live detail every mapped tool call carries. */
function processFacts(resolved: ResolvedTool): { readonly activity: ReturnType<typeof toolActivity>, readonly detail: string } {
  return {
    activity: toolActivity(resolved.entry.name, resolved.call, resolved.result),
    detail: toolDetail(resolved.entry.name, resolved.args),
  }
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
  const label = path === undefined ? salientArgument(record) ?? entry.name : undefined
  const offset = typeof record['offset'] === 'number' && record['offset'] > 0 ? record['offset'] : 1
  const limit = typeof record['limit'] === 'number' ? record['limit'] : undefined
  const lines = view?.lines ?? []
  const state = outcome === undefined ? 'pending' : outcome.isError ? 'error' : 'ok'
  // state 'error' implies entry.result exists: the outcome derives from it.
  return {
    callId: entry.callId,
    ...processFacts(resolved),
    seq: entry.seq,
    updatedSeq: entry.updatedSeq,
    turn: entry.turn,
    step: entry.step,
    ...callFacts(entry),
    ...(path === undefined ? {} : { path }),
    ...(label === undefined ? {} : { label }),
    ...(limit === undefined ? {} : { requestedRange: { first: offset, last: offset + limit - 1 } }),
    ...(lines.length === 0 ? {} : { range: { first: lines[0]!.number, last: lines.at(-1)!.number } }),
    ...(view?.totalLines === undefined ? {} : { totalLines: view.totalLines }),
    state,
    ...(state === 'error' ? { error: ellipsize(firstNonEmptyLine(entry.result!.text) ?? 'read failed', 120) } : {}),
    ...interruptionFacts(entry),
    ...(lines.length === 0 ? {} : {
      previewLines: lines.slice(0, READ_PREVIEW_LINE_LIMIT).map(line => ({ number: line.number, text: line.text })),
    }),
  }
}

/** Fold a run of resolved read entries into one group model. */
function readGroupModel(run: readonly ResolvedTool[], counters?: MayflyWorkCounters, renderRevision?: string): TranscriptReadGroupModel {
  countWork(counters, 'toolModelsBuilt')
  const first = run[0]!
  const updatedSeq = Math.max(...run.map(item => item.entry.updatedSeq))
  return {
    kind: 'transcript-read-group',
    id: `read-group:${String(first.entry.id)}`,
    seq: first.entry.seq,
    updatedSeq,
    turn: first.entry.turn,
    step: first.entry.step,
    ...(renderRevision === undefined ? {} : { renderRevision: `${renderRevision}:${String(updatedSeq)}` }),
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
    ...processFacts(resolved),
    seq: entry.seq,
    updatedSeq: entry.updatedSeq,
    turn: entry.turn,
    step: entry.step,
    ...callFacts(entry),
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
    ...interruptionFacts(entry),
  }
}

/** Fold a run of resolved search entries into one group model. */
function searchGroupModel(run: readonly ResolvedTool[], counters?: MayflyWorkCounters, renderRevision?: string): TranscriptSearchGroupModel {
  countWork(counters, 'toolModelsBuilt')
  const first = run[0]!
  const updatedSeq = Math.max(...run.map(item => item.entry.updatedSeq))
  return {
    kind: 'transcript-search-group',
    id: `search-group:${String(first.entry.id)}`,
    seq: first.entry.seq,
    updatedSeq,
    turn: first.entry.turn,
    step: first.entry.step,
    ...(renderRevision === undefined ? {} : { renderRevision: `${renderRevision}:${String(updatedSeq)}` }),
    searches: run.map(searchCallModel),
  }
}

/**
 * The bounded output tail one command member carries for the expanded view.
 * Lines keep their own spacing (tables and indentation stay aligned); only
 * trailing whitespace goes and long lines truncate.
 */
function commandPreviewLines(output: string): string[] | undefined {
  const lines = output.replace(/\n+$/, '').split('\n').map(line => line.replace(/\s+$/, ''))
  if (lines.every(line => line.trim() === '')) return undefined
  return lines.slice(-COMMAND_PREVIEW_LINE_LIMIT).map(line => line.length <= COMMAND_PREVIEW_LINE_MAX_CHARS ? line : `${line.slice(0, COMMAND_PREVIEW_LINE_MAX_CHARS - 1)}…`)
}

/** The exit/signal failure text of a settled terminal run, or `undefined` when it exited 0. */
function exitFailure(exitCode: number | undefined, signal: string | undefined): string | undefined {
  if (signal !== undefined) return `signal ${signal}`
  return exitCode === undefined || exitCode === 0 ? undefined : `exit ${String(exitCode)}`
}

function lastNonEmptyLine(text: string): string | undefined {
  return text.split('\n').findLast(line => line.trim() !== '')
}

/** Build one command call's renderer-neutral facts from entry, arguments, and views. */
function commandCallModel(resolved: ResolvedTool): CommandCallModel {
  const { entry, args, outcome, call, result } = resolved
  const record = readArgumentRecord(args)
  const callView = call?.card === 'terminal' ? call : undefined
  const resultView = result?.card === 'terminal' ? result : undefined
  const argCommand = typeof record['command'] === 'string' && record['command'] !== '' ? record['command'] : undefined
  const full = callView?.title ?? resultView?.title ?? argCommand ?? entry.name
  const [first = '', ...rest] = (argCommand ?? full).split('\n').map(line => line.replace(/\s+$/, '')).filter((line, index) => index === 0 || line.trim() !== '')
  const multi = rest.length > 0
  const command = multi ? ellipsize(`${first} …`, 120) : ellipsize(full, 120)
  const commandLines = multi ? [first, ...rest].slice(0, COMMAND_INPUT_LINE_LIMIT).map(line => line.length <= COMMAND_PREVIEW_LINE_MAX_CHARS ? line : `${line.slice(0, COMMAND_PREVIEW_LINE_MAX_CHARS - 1)}…`) : undefined
  const output = resultView?.output ?? (entry.result === undefined ? undefined : entry.result.text)
  const exit = exitFailure(resultView?.exitCode, resultView?.signal)
  const state = outcome === undefined ? 'pending' : outcome.isError || exit !== undefined ? 'error' : 'ok'
  const previewLines = output === undefined ? undefined : commandPreviewLines(output)
  const exitLine = output === undefined ? undefined : lastNonEmptyLine(output)
  return {
    callId: entry.callId,
    ...processFacts(resolved),
    seq: entry.seq,
    updatedSeq: entry.updatedSeq,
    turn: entry.turn,
    step: entry.step,
    ...callFacts(entry),
    command,
    ...(commandLines === undefined ? {} : { commandLines }),
    state,
    ...(resultView?.exitCode === undefined ? {} : { exitCode: resultView.exitCode }),
    ...(resultView?.signal === undefined ? {} : { signal: resultView.signal }),
    ...(state === 'error' ? {
      error: outcome!.isError
        ? ellipsize(firstNonEmptyLine(entry.result!.text) ?? 'command failed', 120)
        : ellipsize(`${exit!}${exitLine === undefined ? '' : ` · ${exitLine}`}`, 120),
    } : {}),
    ...interruptionFacts(entry),
    ...(previewLines === undefined ? {} : { previewLines }),
  }
}

/** Fold a run of resolved command entries into one group model. */
function commandGroupModel(run: readonly ResolvedTool[], counters?: MayflyWorkCounters, renderRevision?: string): TranscriptCommandGroupModel {
  countWork(counters, 'toolModelsBuilt')
  const first = run[0]!
  const updatedSeq = Math.max(...run.map(item => item.entry.updatedSeq))
  return {
    kind: 'transcript-command-group',
    id: `command-group:${String(first.entry.id)}`,
    seq: first.entry.seq,
    updatedSeq,
    turn: first.entry.turn,
    step: first.entry.step,
    ...(renderRevision === undefined ? {} : { renderRevision: `${renderRevision}:${String(updatedSeq)}` }),
    commands: run.map(commandCallModel),
  }
}

/** Terminal-card facts of one command call, from its call and result views. */
function terminalModel(resolved: ResolvedTool): TranscriptTerminalModel | undefined {
  const call = resolved.call?.card === 'terminal' ? resolved.call : undefined
  const result = resolved.result?.card === 'terminal' ? resolved.result : undefined
  if (call === undefined && result === undefined) return undefined
  const argCommand = readArgumentRecord(resolved.args)['command']
  const command = call?.title ?? result?.title ?? (typeof argCommand === 'string' ? argCommand : resolved.entry.name)
  return {
    command,
    ...(call?.description === undefined ? {} : { description: call.description }),
    ...(result?.output === undefined ? {} : { output: result.output }),
    ...(result?.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(result?.signal === undefined ? {} : { signal: result.signal }),
  }
}

/** Web-card facts of one settled web call. */
function webModel(resolved: ResolvedTool): TranscriptWebModel | undefined {
  const view = resolved.result
  if (view?.card !== 'web') return undefined
  if (view.kind === 'fetch') return { kind: 'fetch', url: view.url, statusCode: view.statusCode, truncated: view.truncated }
  return {
    kind: 'search',
    sources: view.sources.map(source => ({ url: source.url, ...(source.title === undefined ? {} : { title: source.title }) })),
    truncated: view.truncated,
  }
}

function textLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines.at(-1) === '') lines.pop()
  return lines
}

/** Unchanged lines a hunk keeps around its change: the Harness sends three, the diff body shows one. */
const FILE_CHANGE_CONTEXT_LINES = 1

/**
 * A hunk with its unchanged lines around the change cut down to {@link FILE_CHANGE_CONTEXT_LINES} on each side, so the diff
 * body needs no `⋯` for context it does not draw. A change still being written has no end to compare yet (`tail: false`).
 */
export function trimContext(before: string, after: string, tail = true): { readonly before: string, readonly after: string } {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (tail && suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1
  const dropHead = Math.max(0, prefix - FILE_CHANGE_CONTEXT_LINES)
  const dropTail = Math.max(0, suffix - FILE_CHANGE_CONTEXT_LINES)
  return { before: a.slice(dropHead, a.length - dropTail).join('\n'), after: b.slice(dropHead, b.length - dropTail).join('\n') }
}

/** The first `max` lines of a text (the whole text when it is shorter). */
function headLines(text: string, max: number): { readonly text: string, readonly cut: boolean } {
  let at = -1
  for (let line = 0; line < max; line += 1) {
    at = text.indexOf('\n', at + 1)
    if (at === -1) return { text, cut: false }
  }
  return { text: text.slice(0, at), cut: true }
}

/**
 * The change an edit or write made, from the result's diff view (the applied hunks) and, for a write, the call's content.
 * An edit that failed, or a call that still runs, has none: its line gives the reason and the activity row names it.
 */
function fileChangeModel(resolved: ResolvedTool, counters?: MayflyWorkCounters): TranscriptFileChangeModel | undefined {
  const { entry, outcome, call, result } = resolved
  if (entry.result === undefined || entry.result.isError) return undefined
  const diffs = result?.card === 'diff' ? result.diffs : call?.card === 'diff' ? call.diffs : undefined
  if (diffs === undefined || diffs.length === 0) return undefined
  const path = diffs[0]!.path
  const isWrite = entry.name === 'write'
  // A write is code, not a diff: the new text's size and head, from what the call gave.
  const operation = (outcome?.meta as { readonly operation?: unknown } | undefined)?.operation
  const created = isWrite && (operation === 'create' || (operation !== 'update' && diffs.every(diff => diff.oldText === null)))
  const hunks: { before: string, after: string }[] = []
  let added = 0
  let removed = 0
  let hidden = 0
  if (!created) {
    for (const diff of diffs) {
      const trimmed = trimContext(diff.oldText ?? '', diff.newText)
      countWork(counters, 'diffsComputed')
      const counts = diffChangeCounts(trimmed.before, trimmed.after)
      added += counts.added
      removed += counts.removed
      const cutBefore = headLines(trimmed.before, FILE_CHANGE_HUNK_LINES)
      const cutAfter = headLines(trimmed.after, FILE_CHANGE_HUNK_LINES)
      if (cutBefore.cut || cutAfter.cut) {
        countWork(counters, 'diffsComputed')
        const kept = diffChangeCounts(cutBefore.text, cutAfter.text)
        hidden += counts.added + counts.removed - kept.added - kept.removed
      }
      hunks.push({ before: cutBefore.text, after: cutAfter.text })
    }
  }
  if (!isWrite) return { path, added, removed, hunks, hiddenLines: hidden }
  const content = call?.card === 'diff' ? call.diffs[0]?.newText : diffs[0]!.newText
  const text = content ?? ''
  const lines = textLines(text)
  return {
    path,
    added: created ? lines.length : added,
    removed,
    hunks: [],
    hiddenLines: 0,
    write: { bytes: Buffer.byteLength(text, 'utf8'), lines: lines.length, head: lines.slice(0, WRITE_HEAD_LINES) },
  }
}

function toolModel(resolved: ResolvedTool, family: TranscriptToolFamily, counters?: MayflyWorkCounters, renderRevision?: string, caches?: TranscriptModelCaches): TranscriptEntryModel {
  const revision = entryRevision(renderRevision, resolved.entry.updatedSeq)
  const cached = caches?.models.get(resolved)
  if (cached !== undefined && cached.renderRevision === revision) return cached
  countWork(counters, 'toolModelsBuilt')
  const { entry, outcome, call, result } = resolved
  const terminal = terminalModel(resolved)
  const web = webModel(resolved)
  const change = family === 'edit' || resolved.entry.name === 'write' ? fileChangeModel(resolved, counters) : undefined
  const presentation = call === undefined && result === undefined
    ? undefined
    : createToolPresentationModel({
        id: entry.id,
        name: entry.name,
        ...(call === undefined ? {} : { call }),
        ...(result === undefined ? {} : { result }),
        ...(outcome === undefined ? {} : { outcome }),
      })
  const model: TranscriptEntryModel = {
    kind: 'transcript-tool',
    id: entry.id,
    seq: entry.seq,
    updatedSeq: entry.updatedSeq,
    turn: entry.turn,
    step: entry.step,
    callId: entry.callId,
    name: entry.name,
    family,
    ...processFacts(resolved),
    ...(call === undefined ? {} : { title: call.title }),
    ...(terminal === undefined ? {} : { terminal }),
    ...(web === undefined ? {} : { web }),
    ...(change === undefined ? {} : { change }),
    arguments: entry.arguments,
    startedAt: entry.startedAt,
    ...(revision === undefined ? {} : { renderRevision: revision }),
    ...(entry.result === undefined ? {} : {
      result: {
        text: entry.result.text,
        fullText: entry.result.text,
        isError: entry.result.isError,
        endedAt: entry.result.endedAt,
        ...interruptionFacts(entry),
      },
    }),
    ...(presentation === undefined ? {} : { presentation }),
  }
  caches?.models.set(resolved, model)
  return model
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
        ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
      }
    case 'error':
      return {
        kind: 'transcript-error', id: entry.id, seq: entry.seq, updatedSeq: entry.updatedSeq, turn: entry.turn, message: entry.message,
        ...(entry.code === undefined ? {} : { code: entry.code }),
      }
    case 'interrupted':
      return { kind: 'transcript-interrupted', id: entry.id, seq: entry.seq, updatedSeq: entry.updatedSeq, turn: entry.turn }
    case 'goal-change':
      return {
        kind: 'transcript-goal-change', id: entry.id, seq: entry.seq, updatedSeq: entry.updatedSeq, turn: entry.turn, operation: entry.operation,
        ...(entry.objective === undefined ? {} : { objective: entry.objective }),
        ...(entry.blockedReason === undefined ? {} : { blockedReason: entry.blockedReason }),
        ...(entry.roundsStarted === undefined ? {} : { rounds: entry.roundsStarted }),
        ...(entry.createdAt === undefined || entry.updatedAt === undefined ? {} : { elapsedMs: Math.max(0, entry.updatedAt - entry.createdAt) }),
      }
    case 'goal-round':
      return { kind: 'transcript-goal-round', id: entry.id, seq: entry.seq, updatedSeq: entry.updatedSeq, turn: entry.turn, round: entry.round }
    case 'compaction':
      return {
        kind: 'transcript-compaction', id: entry.id, seq: entry.seq, updatedSeq: entry.updatedSeq, turn: entry.turn,
        state: entry.state, trigger: entry.trigger, startedAt: entry.startedAt,
        ...(entry.endedAt === undefined ? {} : { endedAt: entry.endedAt }),
        ...(entry.summaryAt === undefined ? {} : { summaryAt: entry.summaryAt }),
        ...(entry.compactionId === undefined ? {} : { compactionId: entry.compactionId }),
        ...(entry.shadowedCount === undefined ? {} : { shadowedCount: entry.shadowedCount }),
        ...(entry.shadowedTokens === undefined ? {} : { shadowedTokens: entry.shadowedTokens }),
        ...(entry.summary === undefined ? {} : { summary: entry.summary }),
        ...(entry.detail === undefined ? {} : { detail: entry.detail }),
        ...(entry.error === undefined ? {} : { error: entry.error }),
      }
  }
}

/** Convert one validated official whole value to a frozen Mayfly model. */
export function conversationTranscriptModel(
  projection: ConversationProjection,
  tools: ToolPresentationSource,
  generation = 0,
  renderRevision?: string,
  caches?: TranscriptModelCaches,
  counters?: MayflyWorkCounters,
): TranscriptModel {
  const entries: TranscriptEntryModel[] = []
  let run: ResolvedTool[] = []
  let runFamily: ToolFamily | undefined
  /** The group model of one unchanged run, or a freshly built one cached under its first member. */
  const groupModel = (family: 'read' | 'search' | 'command'): TranscriptEntryModel => {
    const first = run[0]!
    const updatedSeq = Math.max(...run.map(item => item.entry.updatedSeq))
    const revision = entryRevision(renderRevision, updatedSeq)
    const cached = caches?.groups.get(first)
    if (cached !== undefined && cached.revision === revision && cached.members.length === run.length
      && cached.members.every((member, index) => member === run[index])) return cached.model
    const model = family === 'search' ? searchGroupModel(run, counters, renderRevision)
      : family === 'command' ? commandGroupModel(run, counters, renderRevision)
        : readGroupModel(run, counters, renderRevision)
    caches?.groups.set(first, { members: [...run], revision, model })
    return model
  }
  const flushRun = (): void => {
    if (run.length === 0) return
    /* A single command keeps its lone card — the output preview carries more
       than a one-member group header would. */
    if (runFamily === 'command' && run.length === 1) entries.push(toolModel(run[0]!, 'command', counters, renderRevision, caches))
    else entries.push(groupModel(runFamily === 'search' ? 'search' : runFamily === 'command' ? 'command' : 'read'))
    run = []
    runFamily = undefined
  }
  for (const entry of projection.entries) {
    if (entry.kind !== 'tool') {
      // Reasoning within the run's own step keeps a grouped family together;
      // a later step's reasoning closes the run first so it never renders
      // above the calls it followed.
      if (entry.kind !== 'thinking' || (run.length > 0 && run.at(-1)!.entry.step !== entry.step)) flushRun()
      let model = caches?.entries.get(entry)
      if (model === undefined) {
        countWork(counters, 'entriesMapped')
        model = entryModel(entry)
        caches?.entries.set(entry, model)
      }
      entries.push(model)
      continue
    }
    /* The registry retains an unchanged entry object across whole values, so
       an entry-keyed cache re-resolves only the calls that changed. */
    let resolved = caches?.tools.get(entry)
    if (resolved === undefined) {
      countWork(counters, 'entriesMapped')
      resolved = resolveTool(entry, tools)
      caches?.tools.set(entry, resolved)
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
    entries.push(toolModel(resolved, family, counters, renderRevision, caches))
  }
  flushRun()
  const turns: TranscriptTurnModel[] = (projection.turns ?? []).map(turn => ({
    turn: turn.turn,
    startedAt: turn.startedAt,
    ...(turn.endedAt === undefined ? {} : { endedAt: turn.endedAt }),
    ...(turn.outcome === undefined ? {} : { outcome: turn.outcome }),
  }))
  return createTranscriptModel('official-conversation', entries, projection.streaming, generation, turns)
}

/** Entry kinds the mapper dereferences; anything else is not our wire value. */
const ADMITTED_KINDS = new Set(['user', 'assistant', 'thinking', 'tool', 'error', 'interrupted', 'goal-change', 'goal-round', 'compaction'])

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
 * mapper dereferences, then slices history below a presentation floor.
 */
function visibleProjection(
  value: unknown,
  historyFloorSeq: number | undefined,
): ConversationProjection | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const envelope = value as { entries?: unknown, streaming?: unknown, settledSteps?: unknown, turns?: unknown }
  if (!Array.isArray(envelope.entries) || typeof envelope.streaming !== 'boolean' || !Array.isArray(envelope.settledSteps)) return undefined
  /* One pass over the wire array: admit every entry and cut off inherited
     history at the same time. Downstream mapping works on this copy, so the
     published array is never re-read (see the history-read-count specs). */
  const entries: ConversationEntry[] = []
  for (const candidate of envelope.entries) {
    if (!admissibleEntry(candidate)) return undefined
    if (historyFloorSeq === undefined || candidate.seq > historyFloorSeq) entries.push(candidate)
  }
  const retained = historyFloorSeq === undefined ? undefined : new Set(entries.map(entry => entry.turn))
  const turns = (Array.isArray(envelope.turns) ? envelope.turns as ConversationProjection['turns'] : [])
    .filter(turn => retained === undefined || retained.has(turn.turn))
  return { entries, streaming: envelope.streaming, settledSteps: envelope.settledSteps as string[], turns }
}

/** Failure copy of one feed state, in English source keys the renderer translates. */
const FEED_FAILURE_COPY = {
  'controller-unavailable': 'the session controller is unavailable',
  'invalid': 'the stored conversation is unavailable',
  'read-failed': 'could not read the conversation: {error}',
} as const

/**
 * Projection-to-model source for one displayed conversation. It reads one
 * feed at a time, converts only the latest unread whole value, and overlays
 * the feed's live draft without rerunning history mapping.
 */
export class OfficialConversationModelSource {
  private model: TranscriptModel = createTranscriptModel('official-conversation', [], false)
  private feed: ConversationFeed | undefined
  private generation = 0
  private watermark = -1
  private durableModel: TranscriptModel | undefined
  private lastVisible: ConversationProjection | undefined
  private settledSteps = new Set<string>()
  private liveSeq = 0
  private toolsRevision = 0
  private dispatchedCalls: ReadonlySet<string> = new Set()
  private lastDraft: LiveAssistantDraft | undefined
  private historyFloorSeq: number | undefined
  private stateModel: { readonly state: ConversationFeedState, readonly model: TranscriptModel } | undefined
  private caches = createTranscriptModelCaches()
  /** A tools/change landed: only the tool half of the next conversion must rebuild. */
  private toolsStale = false
  private disposed = false

  constructor(
    private readonly projections: ConversationProjectionSource,
    private readonly tools: ToolPresentationSource,
    private readonly publish: (force?: boolean) => void,
    private readonly live?: LiveDraftSource,
    private readonly t: MayflyTranslate = interpolateLocaleMessage,
    private readonly counters?: MayflyWorkCounters,
  ) {}

  /** Convert the latest unread value once, then reuse its model; convert stashed tools lazily. */
  snapshot(): TranscriptModel {
    const feed = this.feed
    if (feed === undefined) return this.model
    const draft = feed.draft()
    const pending = feed.take()
    if (pending !== undefined) {
      const visible = visibleProjection(pending.value, this.historyFloorSeq)
      if (visible !== undefined) {
        this.watermark = pending.seq
        feed.settle(pending.seq)
        this.lastVisible = visible
        this.durableModel = conversationTranscriptModel(visible, this.tools, this.generation, undefined, this.caches, this.counters)
        this.toolsStale = false
        this.dispatchedCalls = new Set(visible.entries.flatMap(entry => entry.kind === 'tool' ? [entry.callId] : []))
        this.settledSteps = new Set(visible.settledSteps)
        this.liveSeq = Math.max(visible.entries.at(-1)?.seq ?? pending.seq, pending.seq) + 1
        this.lastDraft = draft
        this.model = withLiveDraft(this.durableModel, this.settledSteps, draft, this.liveSeq, this.watermark, this.dispatchedCalls)
      }
    } else if (this.toolsStale && this.durableModel !== undefined && this.lastVisible !== undefined) {
      // The displayed view converts its own tool layer on the next snapshot;
      // hidden views keep the stale models stashed until they are shown.
      this.toolsStale = false
      this.rebuildTools()
    } else if (draft !== this.lastDraft && this.durableModel !== undefined) {
      this.lastDraft = draft
      this.model = withLiveDraft(this.durableModel, this.settledSteps, draft, this.liveSeq, this.watermark, this.dispatchedCalls)
    }
    return this.durableModel === undefined ? this.feedStateModel(feed.state()) : this.model
  }

  /**
   * Mark the durable tool layer stale without converting it: the next
   * {@link snapshot} re-resolves presenters for the stashed projection.
   */
  markToolsStale(): void {
    if (this.disposed) return
    this.toolsRevision += 1
    this.caches = { entries: this.caches.entries, tools: new WeakMap(), models: new WeakMap(), groups: new WeakMap() }
    this.toolsStale = true
  }

  /** Re-resolve durable tool presenters on the next snapshot without changing session generation. */
  invalidateTools(): void {
    this.markToolsStale()
  }

  /** Rebuild only the tool layer of the stashed projection, keeping every non-tool entry model. */
  private rebuildTools(): void {
    const visible = this.lastVisible
    if (visible === undefined) return
    this.durableModel = conversationTranscriptModel(visible, this.tools, this.generation, `tools:${String(this.toolsRevision)}`, this.caches, this.counters)
    const draft = this.feed?.draft()
    this.lastDraft = draft
    this.model = withLiveDraft(this.durableModel, this.settledSteps, draft, this.liveSeq, this.watermark, this.dispatchedCalls)
  }

  /** Follow one live Session, clearing stale content first. */
  attach(session: Session | null, historyFloorSeq?: number, agent?: Agent): void {
    if (this.disposed) return
    // A resumed or reloaded Agent may carry a different Session object for the same identity: the live channel follows
    // the identity, not the object, or a replacement would silently lose the transient draft.
    const bound = agent !== undefined && session !== null && String(agent.session.id) === String(session.id) ? agent : undefined
    this.attachFeed(session === null ? undefined : new SessionConversationFeed(
      this.projections,
      session,
      bound,
      this.live,
      (force) => this.publish(force),
    ), historyFloorSeq)
  }

  /** Read one feed from now on, disposing the previous one and clearing stale content. */
  attachFeed(feed: ConversationFeed | undefined, historyFloorSeq?: number): void {
    if (this.disposed) {
      feed?.dispose()
      return
    }
    this.feed?.dispose()
    this.feed = feed
    this.historyFloorSeq = historyFloorSeq
    this.generation += 1
    this.watermark = -1
    this.durableModel = undefined
    this.lastVisible = undefined
    this.caches = createTranscriptModelCaches()
    this.toolsStale = false
    this.settledSteps.clear()
    this.lastDraft = undefined
    this.stateModel = undefined
    this.model = createTranscriptModel('official-conversation', [], false, this.generation)
    this.publish()
  }

  /** Drop the feed and reject every late callback. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.feed?.dispose()
    this.feed = undefined
    this.durableModel = undefined
    this.lastVisible = undefined
    this.caches = createTranscriptModelCaches()
    this.toolsStale = false
    this.settledSteps.clear()
    this.lastDraft = undefined
    this.historyFloorSeq = undefined
    this.stateModel = undefined
    this.model = createTranscriptModel('official-conversation', [], false)
  }

  /** A loading or failure placeholder, stable per feed state so rows stay cached. */
  private feedStateModel(state: ConversationFeedState): TranscriptModel {
    if (state.kind === 'ready') return this.model
    if (this.stateModel?.state === state) return this.stateModel.model
    const node = state.kind === 'loading'
      ? { kind: 'loader' as const, message: this.t('loading conversation...'), variant: 'gap' as const }
      : {
          kind: 'empty' as const,
          title: this.t('conversation unavailable'),
          description: this.t(FEED_FAILURE_COPY[state.reason], { error: state.detail ?? '' }),
        }
    const model = createTranscriptModel('official-conversation', [node], false, this.generation)
    this.stateModel = { state, model }
    return model
  }
}

/**
 * Durable evidence the draft's turn already ended or was superseded: its turn
 * row carries an end time, a newer turn row exists, or a newer durable entry
 * does. Mirrors the session-facts fence so a stale stream draft never reopens
 * a settled turn (the step-level `settledSteps` gate misses abandoned attempts,
 * which finalize nothing).
 * @param durable - the already-mapped durable model.
 * @param turn - the draft's pinned turn.
 * @returns whether the draft is provably behind the durable projection.
 */
function staleTurn(durable: TranscriptModel, turn: number): boolean {
  /* durable models all come from conversationTranscriptModel, which always emits turns */
  const turns = durable.turns ?? []
  if (turns.some(item => item.turn > turn || (item.turn === turn && item.endedAt !== undefined))) return true
  const last = durable.entries.findLast((entry): entry is TranscriptEntryModel => entry.kind.startsWith('transcript-'))
  return last !== undefined && last.turn > turn
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
  dispatched: ReadonlySet<string>,
): TranscriptModel {
  if (draft === undefined || settledSteps.has(`${String(draft.turn)}:${String(draft.step)}`) || staleTurn(durable, draft.turn)) return durable
  const renderRevision = `live:${draft.attemptId}:${String(draft.revision)}`
  const liveEntries: TranscriptEntryModel[] = []
  // A recorded span proves visible reasoning without trimming the whole text.
  if (draft.reasoningSpan !== undefined || draft.reasoning.trim() !== '') {
    const thinking = draft.phase === 'thinking'
    const span = draft.reasoningSpan
    liveEntries.push({
      kind: 'transcript-thinking',
      id: `thinking:${String(draft.turn)}:${String(draft.step)}`,
      seq,
      updatedSeq,
      renderRevision,
      turn: draft.turn,
      step: draft.step,
      text: draft.reasoning,
      streaming: thinking,
      ...(thinking ? { outputProgress: draft.outputProgress } : {}),
      ...(span === undefined ? {} : { startedAt: span.startedAt, ...(thinking ? {} : { durationMs: Math.max(0, span.endedAt - span.startedAt) }) }),
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
  for (const call of draft.preparing ?? []) {
    if (dispatched.has(call.id)) continue
    liveEntries.push({ kind: 'transcript-tool', id: `preparing:${call.id}`, seq, updatedSeq, renderRevision,
      turn: draft.turn, step: draft.step, callId: call.id, name: call.name, family: 'other',
      activity: toolActivity(call.name), detail: '', arguments: call.arguments, startedAt: call.startedAt,
      preparing: { characters: call.characters },
    })
  }
  return freezeModel({ ...durable, entries: durable.entries, live: { turn: draft.turn, step: draft.step, entries: liveEntries }, streaming: true }) as TranscriptModel
}
