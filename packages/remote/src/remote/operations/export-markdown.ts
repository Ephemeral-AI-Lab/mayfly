/**
 * Frozen rc.2 Markdown shapes over the Host's visible conversation projection
 * and the native audit wire stream: front-matter, overview, per-turn sections,
 * and readable attempt prefixes in the full audit.
 * @module @ephemeral-ai/mayfly/remote/operations/export-markdown
 */

import type { SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import { expandAssistantStream, type AssistantStreamRecord } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { ConversationEntry, ConversationProjection } from '@ephemeral-ai/mayfly-host/types'

/** First user message topic length in the overview. */
const TOPIC_MAX_CHARS = 80

/** The shortest id prefix kept in default filenames. */
const ID_PREFIX_LENGTH = 8

type ExportItem = Exclude<ConversationEntry, { readonly kind: 'compaction' | 'goal-change' | 'goal-round' }>

/** Facts both export shapes render. */
export interface RemoteExportInput {
  readonly sessionId: string
  readonly workDir: string | undefined
  readonly events: readonly SessionWireEvent[]
  readonly exportedAt: Date
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringAt(value: unknown, key: string): string | undefined {
  const nested = isRecord(value) ? value[key] : undefined
  return typeof nested === 'string' ? nested : undefined
}

function shorten(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`
}

/** Join the text blocks of content, separated like the legacy fold. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter(isRecord)
    .filter(block => block['type'] === 'text')
    .map(block => (typeof block['text'] === 'string' ? block['text'] : ''))
    .filter(text => text !== '')
    .join('\n\n')
}

/** Join the reasoning blocks of content, or '' when there are none. */
function reasoningText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter(isRecord)
    .filter(block => block['type'] === 'reasoning')
    .map(block => (typeof block['text'] === 'string' ? block['text'] : ''))
    .filter(text => text !== '')
    .join('\n\n')
}

function formatToolItem(item: Extract<ExportItem, { kind: 'tool' }>): string {
  const lines = [`#### Tool Call: ${item.name}`, '', '```json', item.arguments, '```', '']
  if (item.result !== undefined) {
    lines.push(`<details><summary>Tool Result: ${item.name}</summary>`, '', item.result.text, '', '</details>', '')
  }
  return lines.join('\n')
}

function formatTurn(items: readonly ExportItem[], turn: number): string {
  const lines = [`## Turn ${String(turn)}`, '']
  let userHeaderWritten = false
  for (const item of items) {
    if (item.kind === 'user') {
      if (!userHeaderWritten) {
        lines.push('### User', '')
        userHeaderWritten = true
      }
      if (item.text.trim().length > 0) lines.push(item.text, '')
      for (const image of item.images) lines.push(`[image${image.name === undefined ? '' : ` ${image.name}`}]`, '')
    } else if (item.kind === 'thinking') {
      if (item.text.trim().length === 0) continue
      lines.push('<details><summary>Thinking</summary>', '', item.text, '', '</details>', '')
    } else if (item.kind === 'assistant') {
      if (item.text.trim().length > 0) lines.push('### Assistant', '', item.text, '')
    } else if (item.kind === 'tool') {
      lines.push(formatToolItem(item))
    } else if (item.kind === 'error') {
      lines.push(`> ✗ request failed: ${item.message}${item.code === undefined ? '' : ` (${item.code})`}`, '')
    } else {
      lines.push('> (interrupted)', '')
    }
  }
  return lines.join('\n')
}

function buildOverview(items: readonly ExportItem[]): string {
  let topic = ''
  for (const item of items) {
    if (item.kind === 'user' && item.text.trim().length > 0) {
      topic = shorten(item.text.trim().replaceAll(/\s+/g, ' '), TOPIC_MAX_CHARS)
      break
    }
  }
  const turns = new Set(items.map(item => item.turn)).size
  const toolCalls = items.filter(item => item.kind === 'tool').length
  return [
    '## Overview',
    '',
    topic.length > 0 ? `- **Topic**: ${topic}` : '- **Topic**: (empty)',
    `- **Conversation**: ${String(turns)} turn${turns === 1 ? '' : 's'} | ${String(toolCalls)} tool call${toolCalls === 1 ? '' : 's'}`,
    '',
    '---',
  ].join('\n')
}

/** Read the visible Host projection, excluding only transcript chrome, as rc.2 does. */
export function remoteExportItems(projection: ConversationProjection): readonly ExportItem[] {
  return projection.entries.filter((entry): entry is ExportItem => entry.kind !== 'compaction' && entry.kind !== 'goal-change' && entry.kind !== 'goal-round')
}

/** Readable export facts come exclusively from the Host's complete conversation projection. */
export interface RemoteReadableExportInput extends Omit<RemoteExportInput, 'events'> {
  readonly items: readonly ExportItem[]
}

/** Build the readable folded export: front-matter, overview, one section per turn. */
export function buildRemoteExportMarkdown(input: RemoteReadableExportInput): string {
  const items = input.items
  const lines = [
    '---',
    `session_id: ${input.sessionId}`,
    `exported_at: ${input.exportedAt.toISOString()}`,
    `work_dir: ${input.workDir ?? ''}`,
    `message_count: ${String(items.length)}`,
    '---',
    '',
    '# Mayfly Session Export',
    '',
    buildOverview(items),
    '',
  ]
  const turns: number[] = []
  for (const item of items) {
    if (!turns.includes(item.turn)) turns.push(item.turn)
  }
  for (const turn of turns) {
    lines.push(formatTurn(items.filter(item => item.turn === turn), turn), '')
  }
  return lines.join('\n')
}

/** `input X, cache-read Y, cache-write Z, output W` in the legacy 1024-base units. */
function formatUsage(usage: unknown): string | undefined {
  if (!isRecord(usage)) return undefined
  const input = usage['inputTokens']
  const output = usage['outputTokens']
  if (typeof input !== 'number' || typeof output !== 'number') return undefined
  const parts = [`input ${format1024(input)}`]
  for (const key of ['cacheReadTokens', 'cacheWriteTokens'] as const) {
    const value = usage[key]
    if (typeof value === 'number') parts.push(`${key === 'cacheReadTokens' ? 'cache-read' : 'cache-write'} ${format1024(value)}`)
  }
  parts.push(`output ${format1024(output)}`)
  return parts.join(', ')
}

function format1024(count: number): string {
  if (count >= 1024 * 1024) return `${(count / (1024 * 1024)).toFixed(1)}M`
  if (count >= 1024) return `${(count / 1024).toFixed(1)}k`
  return String(count)
}

/** Render content blocks for the full export: text verbatim, images as markers. */
function formatContentBlocksFull(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block['type'] === 'text') {
      const text = typeof block['text'] === 'string' ? block['text'] : ''
      if (text.trim().length > 0) parts.push(text)
    } else if (block['type'] === 'image') {
      parts.push('[image]')
    } else {
      parts.push(`[${String(block['type'])}]`)
    }
  }
  return parts.join('\n\n')
}

function formatFullEvent(event: SessionWireEvent): string {
  const data = event.data
  const lines: string[] = []
  switch (event.type) {
    case 'turn/start':
      lines.push(`## Turn ${String(isRecord(data) ? data['turn'] ?? '' : '')}`, '')
      break
    case 'step/start':
      lines.push(`### Step ${String(isRecord(data) ? data['step'] ?? '' : '')}`, '')
      break
    case 'user/message': {
      const source = isRecord(data) ? data['source'] : undefined
      const kind = isRecord(source) ? stringAt(source, 'kind') ?? '' : ''
      const text = formatContentBlocksFull(isRecord(data) ? data['content'] : undefined)
      lines.push(`#### user (${kind})`, '')
      if (text.trim().length > 0) lines.push(text, '')
      break
    }
    case 'assistant/message': {
      const message = isRecord(data) ? data['message'] : undefined
      const content = isRecord(message) ? message['content'] : undefined
      const reasoning = reasoningText(content)
      const text = contentText(content)
      lines.push('#### assistant', '')
      if (reasoning.trim().length > 0) lines.push('<details><summary>Thinking</summary>', '', reasoning, '', '</details>', '')
      if (text.trim().length > 0) lines.push(text, '')
      const usage = formatUsage(isRecord(data) ? data['usage'] : undefined)
      if (usage !== undefined) lines.push(`<sub>usage: ${usage}</sub>`, '')
      break
    }
    case 'tool/call':
      lines.push(`#### tool call: ${stringAt(data, 'name') ?? ''}`, '', '```json', stringAt(data, 'arguments') ?? '', '```', '')
      break
    case 'tool/result': {
      const meta = stringAt(data, 'meta')
      const message = isRecord(data) ? data['message'] : undefined
      const resultText = meta !== undefined && meta.trim() !== '' ? meta : contentText(isRecord(message) ? message['content'] : undefined)
      const error = isRecord(data) ? data['error'] : undefined
      const code = stringAt(error, 'code')
      const name = stringAt(error, 'name')
      const errorTail = error === undefined ? '' : ` (error: ${code ?? ''}${name === undefined || name === '' ? '' : ` ${name}`})`
      lines.push(`#### tool result${errorTail}`, '')
      if (resultText.trim().length > 0) lines.push(resultText, '')
      break
    }
    case 'step/end':
      lines.push('#### step/end', '')
      break
    case 'assistant/attempt': {
      const stream = isRecord(data) && Array.isArray(data['stream']) ? data['stream'] as AssistantStreamRecord[] : []
      let reasoning = ''
      let text = ''
      for (const { chunk } of expandAssistantStream(stream)) {
        if (chunk.type === 'reasoning-delta') reasoning += chunk.text
        else if (chunk.type === 'text-delta') text += chunk.text
      }
      if (reasoning.trim() === '' && text.trim() === '') return ''
      lines.push('#### assistant attempt', '')
      if (reasoning.trim() !== '') lines.push('<details><summary>Thinking</summary>', '', reasoning, '', '</details>', '')
      if (text.trim() !== '') lines.push(text, '')
      break
    }
    case 'turn/end': {
      const reason = isRecord(data) ? data['reason'] : undefined
      const kind = stringAt(reason, 'kind') ?? ''
      const failure = isRecord(reason) ? reason['error'] : undefined
      const failureText = kind === 'error' && failure !== undefined
        ? `: ${stringAt(failure, 'message') ?? ''}${stringAt(failure, 'code') === undefined ? '' : ` (${stringAt(failure, 'code')})`}`
        : ''
      lines.push(`#### turn/end (${kind}${failureText})`, '')
      break
    }
    default:
      lines.push(`#### ${event.type}`, '', '```json', JSON.stringify(data, null, 2), '```', '')
      break
  }
  return lines.join('\n')
}

/** Build the full audit export: front-matter then every event's section in seq order. */
export function buildRemoteFullExportMarkdown(input: RemoteExportInput): string {
  const lines = [
    '---',
    `session_id: ${input.sessionId}`,
    `exported_at: ${input.exportedAt.toISOString()}`,
    `work_dir: ${input.workDir ?? ''}`,
    `event_count: ${String(input.events.length)}`,
    '---',
    '',
    '# Mayfly Session Export (full)',
    '',
  ]
  for (const event of input.events) {
    const section = formatFullEvent(event)
    if (section.trim().length > 0) lines.push(section, '')
  }
  return lines.join('\n')
}

/** The default export filename: `mayfly-export-{id8}-{YYYYMMDD-HHMMSS}.md`. */
export function remoteExportFileName(sessionId: string, now: Date): string {
  const shortId = sessionId.slice(0, ID_PREFIX_LENGTH).replaceAll(/[\\/\u0000-\u001F\u007F]/gu, '')
  const timestamp = now.toISOString().replaceAll(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `mayfly-export-${shortId}-${timestamp}.md`
}

/** Sanitize one caller-supplied filename to a bare name inside the export directory. */
export function sanitizeRemoteExportName(requested: string): string | undefined {
  const bare = requested.replaceAll(/[\\/\u0000-\u001F\u007F]/gu, '').trim()
  if (bare === '' || bare === '.' || bare === '..') return undefined
  const capped = [...bare].slice(0, 100).join('')
  return capped.endsWith('.md') ? capped : `${capped}.md`
}
