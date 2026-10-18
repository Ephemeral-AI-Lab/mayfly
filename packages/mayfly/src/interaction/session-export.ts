/**
 * The session-export command family (S26): `/save` writes the current
 * session's folded transcript as a self-contained Markdown file (kimi's
 * export-md shape: front-matter, overview, per-turn sections) through the
 * persistence backend's raw artifact (`supportsRawArtifacts` + `readRaw`,
 * the JSONL chunk rows expanded with the dsh decoder), and `/copy` pushes
 * the last assistant message's text through the `./clipboard-write.ts`
 * pipeline. Both commands share one read path — raw artifact → decoded
 * events plus the current official `mayflyConversation` projection. Readable
 * output mirrors the projected transcript; `full` deliberately preserves the
 * decoded append-only audit. Current operations (the default output path and
 * a relative argument) resolve from the native current working directory.
 * This module injects nothing and resolves every service through `ctx.get`
 * (the `/theme` fiber-dispose trap).
 *
 * @module @ephemeral-ai/mayfly/interaction/session-export
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ConversationEntry, ConversationProjection, ConversationToolEntry } from '../conversation/types.ts'
// Empty type imports carry the `commands` merge the registration uses, the
// app-owned reader/action/projection merges every handler reads, and the
// `sessionPersistence` merge the read path resolves.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '../app/index.ts'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection'
import { agentDirectory } from '../internal/session-directory.ts'
import { copyTextToClipboard } from './clipboard-write.ts'
import { attemptStreamText } from './trace-format.ts'
import { createInteractionNotificationOwner } from './notifications.ts'
import { formatError } from '../internal/format.ts'
/** The key-arg whitelist for the tool-call hint, in priority order (the
 * present.ts list — the export keeps the same hint the card shows). */
const KEY_ARG_KEYS = ['file_path', 'command', 'pattern'] as const

/** Maximum length of the tool-call hint on an export line. */
const KEY_ARG_MAX_CHARS = 60

/** Default export filename prefix (kimi's `kimi-export-…` counterpart). */
const EXPORT_PREFIX = 'mayfly-export'

/** First user message topic length in the overview. */
const TOPIC_MAX_CHARS = 80

/** The shortest id prefix kept in default filenames. */
const ID_PREFIX_LENGTH = 8

/** Flatten and ellipsize one hint string. */
function shorten(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}

/**
 * The tool-call hint for one projected tool entry: the first non-empty
 * whitelist argument, then the first short string argument — the present.ts
 * rule, kept local so the export's shape does not grow the transcript public
 * surface.
 * @param item - the projected tool entry.
 * @returns the hint, or `undefined` when the entry's arguments yield none.
 */
function extractToolHint(item: ConversationToolEntry): string | undefined {
  const parsed = parseArguments(item.arguments)
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null) return undefined
  const args = parsed as Record<string, unknown>
  for (const key of KEY_ARG_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return shorten(value, KEY_ARG_MAX_CHARS)
  }
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value !== '' && value.length <= KEY_ARG_MAX_CHARS) {
      return shorten(value, KEY_ARG_MAX_CHARS)
    }
  }
  return undefined
}

/** Parse a raw arguments string; `undefined` when the model sent invalid JSON. */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * The visible text of the last assistant entry, newest first; empty when
 * none. Same shape as kimi's `findLastAssistantText`: only assistant entries
 * count, and empty replies are skipped.
 * @param entries - the projected conversation in session order.
 * @returns the last non-empty assistant text, or `''`.
 */
export function lastAssistantText(entries: readonly ConversationEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry?.kind !== 'assistant') continue
    if (entry.text.trim().length === 0) continue
    return entry.text
  }
  return ''
}

/** The facts the Markdown export renders. */
interface ExportInput {
  /** The persisted session id. */
  readonly sessionId: string
  /** The session's current working directory, when one is known. */
  readonly workDir: string | undefined
  /** The projected conversation entries, in session order. */
  readonly entries: readonly ConversationEntry[]
  /** The export timestamp. */
  readonly exportedAt: Date
}

/**
 * Build a tool call's Markdown section: the `#### Tool Call: name (hint)`
 * heading with the raw arguments JSON fenced, plus the paired result as a
 * collapsible `<details>` block when one has settled.
 * @param item - the projected tool entry.
 * @returns the Markdown block, always ending in a blank line.
 */
function formatToolItemMd(item: ConversationToolEntry): string {
  const parsed = parseArguments(item.arguments)
  const hint = extractToolHint(item)
  const title = hint === undefined ? `#### Tool Call: ${item.name}` : `#### Tool Call: ${item.name} (\`${hint}\`)`
  const argsFormatted = parsed === undefined
    ? item.arguments
    : JSON.stringify(parsed, null, 2)
  const lines = [title, '', '```json', argsFormatted, '```', '']
  const result = item.result
  if (result !== undefined) {
    const resultTitle = hint === undefined ? `Tool Result: ${item.name}` : `Tool Result: ${item.name} (\`${hint}\`)`
    lines.push(`<details><summary>${resultTitle}</summary>`, '', result.text, '', '</details>', '')
  }
  return lines.join('\n')
}

/** A projected entry the readable export renders; boundary markers stay out. */
type ExportEntry = Exclude<ConversationEntry, { readonly kind: 'compaction' | 'goal-change' | 'goal-round' }>

/** The entries the readable export renders, in session order. */
function exportEntries(entries: readonly ConversationEntry[]): readonly ExportEntry[] {
  return entries.filter((entry): entry is ExportEntry =>
    entry.kind !== 'compaction' && entry.kind !== 'goal-change' && entry.kind !== 'goal-round')
}

/** Build one turn's Markdown section from its entries, in session order. */
function formatTurnMd(entries: readonly ExportEntry[], turn: number): string {
  const lines = [`## Turn ${String(turn)}`, '']
  let userHeaderWritten = false
  for (const entry of entries) {
    if (entry.kind === 'user') {
      if (!userHeaderWritten) {
        lines.push('### User', '')
        userHeaderWritten = true
      }
      if (entry.text.trim().length > 0) {
        lines.push(entry.text, '')
      }
      for (const image of entry.images) {
        // The kimi exporter's image placeholder: the bytes stay in the
        // session store, the export carries the marker.
        lines.push(`[image${image.name === undefined ? '' : ` ${image.name}`}]`, '')
      }
    } else if (entry.kind === 'thinking') {
      if (entry.text.trim().length === 0) continue
      lines.push('<details><summary>Thinking</summary>', '', entry.text, '', '</details>', '')
    } else if (entry.kind === 'assistant') {
      if (entry.text.trim().length > 0) {
        lines.push('### Assistant', '', entry.text, '')
      }
    } else if (entry.kind === 'tool') {
      lines.push(formatToolItemMd(entry))
    } else if (entry.kind === 'error') {
      lines.push(`> ✗ request failed: ${entry.message}${entry.code === undefined ? '' : ` (${entry.code})`}`, '')
    } else {
      lines.push('> (interrupted)', '')
    }
  }
  return lines.join('\n')
}

/** Build the overview section: first user topic plus conversation totals. */
function buildOverview(entries: readonly ExportEntry[]): string {
  let topic = ''
  for (const entry of entries) {
    if (entry.kind === 'user' && entry.text.trim().length > 0) {
      topic = shorten(entry.text.trim().replaceAll(/\s+/g, ' '), TOPIC_MAX_CHARS)
      break
    }
  }
  const turns = new Set(entries.map(entry => entry.turn)).size
  const toolCalls = entries.filter(entry => entry.kind === 'tool').length
  return [
    '## Overview',
    '',
    topic.length > 0 ? `- **Topic**: ${topic}` : '- **Topic**: (empty)',
    `- **Conversation**: ${String(turns)} turn${turns === 1 ? '' : 's'} | ${String(toolCalls)} tool call${toolCalls === 1 ? '' : 's'}`,
    '',
    '---',
  ].join('\n')
}

/**
 * Build the session export Markdown: front-matter (id, timestamp, cwd,
 * counts), the overview, then one `## Turn N` section per distinct turn in
 * first-seen order (the kimi export-md shape over the projected conversation).
 * @param input - the export facts.
 * @returns the complete Markdown document.
 */
export function buildExportMarkdown(input: ExportInput): string {
  const { sessionId, workDir, exportedAt } = input
  const entries = exportEntries(input.entries)
  const lines = [
    '---',
    `session_id: ${sessionId}`,
    `exported_at: ${exportedAt.toISOString()}`,
    `work_dir: ${workDir ?? ''}`,
    `message_count: ${String(entries.length)}`,
    '---',
    '',
    '# Mayfly Session Export',
    '',
  ]
  lines.push(buildOverview(entries))
  lines.push('')
  const turns: number[] = []
  for (const entry of entries) {
    if (!turns.includes(entry.turn)) turns.push(entry.turn)
  }
  for (const turn of turns) {
    const turnEntries = entries.filter(entry => entry.turn === turn)
    lines.push(formatTurnMd(turnEntries, turn))
    lines.push('')
  }
  return lines.join('\n')
}

/** The default export filename: `mayfly-export-{id8}-{YYYYMMDD-HHMMSS}.md`. */
function defaultExportName(id: string, now: Date): string {
  const shortId = id.slice(0, ID_PREFIX_LENGTH)
  const timestamp = now.toISOString().replaceAll(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `${EXPORT_PREFIX}-${shortId}-${timestamp}.md`
}

/** Join the text blocks of content, `\n`-separated (the fold's rule). */
function contentText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n\n')
}

/** Join the reasoning blocks of content, or '' when there are none. */
function reasoningText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
    .map(block => block.text)
    .join('\n\n')
}

/** Render content blocks for the full export: text verbatim, images as
 * placeholders, every other block as a bracketed marker. */
function formatContentBlocksFull(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text.trim().length > 0) parts.push(block.text)
    } else if (block.type === 'image') {
      parts.push('[image]')
    } else {
      parts.push(`[${block.type}]`)
    }
  }
  return parts.join('\n\n')
}

/** One event's full-export section, in seq order. An `assistant/attempt` is
 * a settled stream without a surface message; its prefix exists nowhere else
 * and stays in. */
function formatFullEvent(event: SessionEvent): string {
  const lines: string[] = []
  switch (event.type) {
    case 'turn/start':
      lines.push(`## Turn ${String(event.data.turn)}`, '')
      break
    case 'step/start':
      lines.push(`### Step ${String(event.data.step)}`, '')
      break
    case 'user/message': {
      const source = event.data.source.kind
      const text = formatContentBlocksFull(event.data.content)
      lines.push(`#### user (${source})`, '')
      if (text.trim().length > 0) lines.push(text, '')
      break
    }
    case 'assistant/message': {
      const reasoning = reasoningText(event.data.message.content)
      const text = contentText(event.data.message.content)
      lines.push('#### assistant', '')
      if (reasoning.trim().length > 0) {
        lines.push('<details><summary>Thinking</summary>', '', reasoning, '', '</details>', '')
      }
      if (text.trim().length > 0) lines.push(text, '')
      const usage = event.data.usage
      if (usage !== undefined) {
        lines.push(`<sub>usage: ${formatUsage(usage)}</sub>`, '')
      }
      break
    }
    case 'tool/call': {
      lines.push(`#### tool call: ${event.data.name}`, '', '```json', event.data.arguments, '```', '')
      break
    }
    case 'tool/result': {
      const resultText = typeof event.data.meta === 'string' && event.data.meta.trim() !== ''
        ? event.data.meta
        : contentText(event.data.message.content)
      const error = event.data.error
      const errorTail = error === undefined
        ? ''
        : ` (error: ${error.code}${error.name === '' ? '' : ` ${error.name}`})`
      lines.push(`#### tool result${errorTail}`, '')
      if (resultText.trim().length > 0) lines.push(resultText, '')
      break
    }
    case 'step/end':
      lines.push('#### step/end', '')
      break
    case 'assistant/attempt': {
      // A settled attempt with no surface message (failed, retried, or
      // cancelled): its stream exists nowhere else, so the full export keeps
      // the delivered prefix. A boundary-only attempt is noise and stays out.
      const parts = attemptStreamText(event.data.stream)
      if (parts.reasoning.trim().length === 0 && parts.text.trim().length === 0) return ''
      lines.push('#### assistant attempt', '')
      if (parts.reasoning.trim().length > 0) {
        lines.push('<details><summary>Thinking</summary>', '', parts.reasoning, '', '</details>', '')
      }
      if (parts.text.trim().length > 0) lines.push(parts.text, '')
      break
    }
    case 'turn/end': {
      const reason = event.data.reason
      const failure = reason.kind === 'error' && reason.error !== undefined
        ? `: ${reason.error.message}${reason.error.code === undefined ? '' : ` (${reason.error.code})`}`
        : ''
      lines.push(`#### turn/end (${reason.kind}${failure})`, '')
      break
    }
    default:
      // Every other event stays visible as its raw JSON (the "nothing
      // folded" promise): request/header, request/context, usage rows,
      // and anything a future harness version adds.
      lines.push(`#### ${event.type}`, '', '```json', JSON.stringify(event.data, null, 2), '```', '')
  }
  return lines.join('\n')
}

/** `input X, cache-read Y, cache-write Z, output W` — 1024-base, the usage.ts shape. */
function formatUsage(usage: { inputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number, outputTokens: number }): string {
  const parts = [`input ${format1024(usage.inputTokens)}`]
  if (usage.cacheReadTokens !== undefined) parts.push(`cache-read ${format1024(usage.cacheReadTokens)}`)
  if (usage.cacheWriteTokens !== undefined) parts.push(`cache-write ${format1024(usage.cacheWriteTokens)}`)
  parts.push(`output ${format1024(usage.outputTokens)}`)
  return parts.join(', ')
}

/** 1024-base token formatting (the status family's `formatTokens` rule). */
function format1024(count: number): string {
  if (count >= 1024 * 1024) return `${(count / (1024 * 1024)).toFixed(1)}M`
  if (count >= 1024) return `${(count / 1024).toFixed(1)}k`
  return String(count)
}

function isConversationProjection(value: unknown): value is ConversationProjection {
  return value !== null && typeof value === 'object' && Array.isArray((value as { entries?: unknown }).entries)
}

/** The facts the full (event-stream) export renders. */
interface FullExportInput {
  /** The persisted session id. */
  readonly sessionId: string
  /** The session's current working directory, when one is known. */
  readonly workDir: string | undefined
  /** The decoded event stream, in seq order. */
  readonly events: readonly SessionEvent[]
  /** The export timestamp. */
  readonly exportedAt: Date
}

/**
 * Build the full session export Markdown: front-matter, then every event's
 * section in seq order — nothing folded, nothing filtered (the D28
 * injection messages appear with their `source.kind` labeled, tool results
 * carry their full text, boundary events and request rows stay visible).
 * @param input - the export facts.
 * @returns the complete Markdown document.
 */
export function buildFullExportMarkdown(input: FullExportInput): string {
  const { sessionId, workDir, events, exportedAt } = input
  const lines = [
    '---',
    `session_id: ${sessionId}`,
    `exported_at: ${exportedAt.toISOString()}`,
    `work_dir: ${workDir ?? ''}`,
    `event_count: ${String(events.length)}`,
    '---',
    '',
    '# Mayfly Session Export (full)',
    '',
  ]
  for (const event of events) {
    const section = formatFullEvent(event)
    if (section.trim().length > 0) lines.push(section, '')
  }
  return lines.join('\n')
}

/**
 * Register the `/save` and `/copy` commands.
 * @param ctx - plugin context.
 * @returns a disposer unregistering both commands.
 */
export function registerExportCommands(ctx: Context): () => void {
  const notifications = createInteractionNotificationOwner(ctx, 'mayfly.session-export', 'session-export')
  /** The shared read path's outcome: session identity, decoded audit events,
   * and the current official projected transcript. */
  interface SessionExportSource {
    /** The persisted session id. */
    readonly id: string
    /** The session's current working directory. */
    readonly directory: string
    /** The decoded event stream, in seq order (the full export's view). */
    readonly events: readonly SessionEvent[]
    /** The projected conversation entries, in session order (the readable export's view). */
    readonly entries: readonly ConversationEntry[]
  }

  /**
   * The shared read path: the current session's durable events plus its
   * current official conversation projection. Resolves `undefined` when no
   * session is live yet; throws the classified failure for every other stop.
   * @param signal - the dispatching UI request's cancellation signal.
   */
  async function readSessionSource(signal: AbortSignal): Promise<SessionExportSource | undefined> {
    const agent = ctx.mayflyCurrentAgent.current()
    if (agent === null) return undefined
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('session persistence is unavailable')
    // The persistence coordinator drains asynchronously (`session/event`
    // write-behind), so a durable read must flush first — the SessionStore's
    // documented pre-read channel (`ctx.get`, never the inject proxy).
    // Safe with no store, no listener (flush returns false), or any backend.
    await ctx.sessions.flush(agent.session)
    // Harness `0.1.5` replaces the raw-artifact channel with read handles:
    // the backend decodes its own storage format, so the full export reads
    // the validated event log instead of parsing JSONL lines here.
    const handle = await persistence.open(agent.id, 'read', { signal })
    let events: SessionEvent[] = []
    try {
      events = [...(await handle.read(undefined, undefined, { signal })).events]
    } finally {
      await handle.close()
    }
    const projection = ctx.sessionProjections.snapshot(agent.session, ['mayflyConversation']).values.mayflyConversation
    const entries = isConversationProjection(projection) ? projection.entries : []
    return { id: String(agent.id), directory: agentDirectory(ctx, agent), events, entries }
  }

  /**
   * The `/save` handler: write the projected transcript (`/save [path]`)
   * or the full event stream (`/save full [path]`) as Markdown and flash
   * the path in the hint line.
   * @param rawInput - the command's raw argument string (`[full] [<path>]`).
   * @param signal - the dispatching UI request's cancellation signal.
   * @returns the command outcome.
   */
  async function saveSession(rawInput: string, signal: AbortSignal): Promise<CommandResult> {
    let source: SessionExportSource | undefined
    try {
      source = await readSessionSource(signal)
    } catch (error) {
      return { kind: 'error', text: formatError(error) }
    }
    if (source === undefined) return { kind: 'error', text: 'no session is live yet' }
    // The mode keyword leads the argument; everything after it is the path.
    const trimmed = rawInput.trim()
    const full = trimmed === 'full' || trimmed.startsWith('full ')
    const pathArg = full ? trimmed.slice(4).trim() : trimmed
    const count = full ? source.events.length : exportEntries(source.entries).length
    if (count === 0) return { kind: 'error', text: 'nothing to export yet' }
    const outputPath = pathArg.length > 0
      ? resolve(source.directory, pathArg)
      : join(source.directory, defaultExportName(source.id, new Date()))
    const markdown = full
      ? buildFullExportMarkdown({
          sessionId: source.id,
          workDir: source.directory,
          events: source.events,
          exportedAt: new Date(),
        })
      : buildExportMarkdown({
          sessionId: source.id,
          workDir: source.directory,
          entries: source.entries,
          exportedAt: new Date(),
        })
    try {
      await mkdir(dirname(outputPath), { recursive: true })
      await writeFile(outputPath, markdown, 'utf-8')
    } catch (error) {
      return { kind: 'error', text: `could not write export: ${formatError(error)}` }
    }
    notifications.report('export', { message: `exported ${String(count)} ${full ? 'events' : 'items'} to ${outputPath}`, severity: 'success' })
    return { kind: 'success' }
  }

  /**
   * The `/copy` handler: copy the last assistant message's text and flash
   * the outcome in the hint line.
   * @param signal - the dispatching UI request's cancellation signal.
   * @returns the command outcome.
   */
  async function copyAssistantMessage(signal: AbortSignal): Promise<CommandResult> {
    let source: SessionExportSource | undefined
    try {
      source = await readSessionSource(signal)
    } catch (error) {
      return { kind: 'error', text: formatError(error) }
    }
    if (source === undefined) return { kind: 'error', text: 'no session is live yet' }
    const text = lastAssistantText(source.entries)
    if (text.length === 0) return { kind: 'error', text: 'no assistant message to copy' }
    let method
    try {
      method = await copyTextToClipboard(text)
    } catch (error) {
      return { kind: 'error', text: `could not copy to clipboard: ${formatError(error)}` }
    }
    // The OSC 52 leg cannot be confirmed from this side — the terminal
    // honors it silently or ignores it silently — so it reports as
    // unverified (the kimi wording).
    notifications.report('copy', { message: method === 'native'
      ? `copied the last assistant message (${String(text.length)} characters)`
      : `copied via terminal escape sequence (unverified, ${String(text.length)} characters)`, severity: 'success' })
    return { kind: 'success' }
  }

  const saveCommand = ctx.commands.register({
    name: 'save',
    description: 'Save the current session as a Markdown file',
    input: { hint: '[full] [<path>]' },
    handler: (invocation) => saveSession(invocation.rawInput, invocation.signal),
  })
  const copyCommand = ctx.commands.register({
    name: 'copy',
    description: 'Copy the last assistant message to the clipboard',
    handler: (invocation) => copyAssistantMessage(invocation.signal),
  })
  return () => {
    saveCommand()
    copyCommand()
  }
}
