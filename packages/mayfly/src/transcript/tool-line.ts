/**
 * One-row transcript presentation for calls whose substance lives elsewhere
 * or fits one line: pane-owned delegation and plan updates (the agents,
 * todo, and workflow panes stay their live surfaces), goal updates, user
 * questions, web retrieval, agent messaging, and a call still being prepared.
 * Each row carries the call's status, its salient label, and a one-line
 * outcome; Ctrl-O opens the bounded result (or a web search's sources).
 *
 * @module @ephemeral-ai/mayfly/transcript/tool-line
 */

import { sanitizePluginText, type MayflyComponent, type MayflyComponents, type MayflySemanticColors } from '../core/index.ts'
import { interpolateLocaleMessage, type MayflyTranslate, type TranscriptToolModel } from '../frontend/index.ts'
import { agentCallLabel } from './agent-presentation.ts'
import { moreLinesHint } from './hints.ts'
import { ellipsize, parseToolArguments } from './present.ts'
import { formatTokens } from './status-context.ts'

/** Tool names that present as one row regardless of their activity. */
const LINE_TOOL_NAMES = new Set(['send_message', 'interrupt_agent', 'workflow', 'skill'])

/** Activities that present as one row. */
const LINE_ACTIVITIES = new Set<TranscriptToolModel['activity']>(['subagents', 'plan', 'questions', 'webSearch', 'webFetch'])

/** Rows an expanded line row's body keeps. */
export const TOOL_LINE_EXPANDED_ROWS = 12

/** Characters of the one-line outcome kept on the row. */
const OUTCOME_MAX_CHARS = 120

/**
 * Whether a tool entry presents as one row rather than a card.
 * @param entry - the tool entry.
 * @returns whether {@link ToolLineComponent} renders it.
 */
export function isLineTool(entry: TranscriptToolModel): boolean {
  return entry.preparing !== undefined || LINE_ACTIVITIES.has(entry.activity) || LINE_TOOL_NAMES.has(entry.name)
}

/**
 * Human form of a tool name: `mcp__<server>__<tool>` reads `server › tool`.
 * @param name - the tool name.
 * @returns the display name.
 */
export function toolDisplayName(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/u.exec(name)
  return mcp === null ? name : `${mcp[1]!} › ${mcp[2]!}`
}

/**
 * Pretty-print a JSON object or array; anything else passes through.
 * @param text - raw result text.
 * @returns indented JSON, or the text unchanged.
 */
export function prettyJson(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return text
  }
}

function firstLine(text: string | undefined): string | undefined {
  const line = text?.split('\n').find(candidate => candidate.trim() !== '')
  return line === undefined ? undefined : ellipsize(line, OUTCOME_MAX_CHARS)
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** One row's parts: the label, an optional detail, and the settled outcome. */
interface LineParts {
  readonly label: string
  readonly detail?: string | undefined
  readonly outcome?: string | undefined
}

/** A presenter-less question tool's answers, joined. */
function answers(text: string): string | undefined {
  try {
    const parsed = record(JSON.parse(text))
    const list = Array.isArray(parsed['answers']) ? parsed['answers'] : []
    const values = list.flatMap(item => {
      const answer = record(item)['answer']
      return typeof answer === 'string' ? [answer] : Array.isArray(answer) ? [answer.filter(value => typeof value === 'string').join(', ')] : []
    })
    return values.length === 0 ? undefined : values.join('; ')
  } catch {
    return undefined
  }
}

/** One-row renderer for delegation, plan, question, web, and messaging calls. */
export class ToolLineComponent implements MayflyComponent {
  private expanded = false
  private keyed = true
  private closed = false
  private cache: { readonly key: string, readonly rows: string[] } | undefined

  constructor(
    private entry: TranscriptToolModel,
    private readonly colors: MayflySemanticColors,
    private readonly components: MayflyComponents,
    private readonly t: MayflyTranslate = interpolateLocaleMessage,
  ) {}

  /** Replace the projected entry while keeping disclosure state. */
  update(entry: TranscriptToolModel): void {
    this.entry = entry
    this.cache = undefined
  }

  setExpanded(expanded: boolean): void { this.expanded = expanded }

  /** Adopt whether Ctrl-O reaches the row and whether its turn has ended. */
  setScope(scope: { readonly hint: boolean, readonly turnClosed: boolean }): void {
    this.keyed = scope.hint
    this.closed = scope.turnClosed
  }

  invalidate(): void { this.cache = undefined }

  render(width: number): string[] {
    const key = `${String(width)}:${String(this.expanded)}:${String(this.keyed)}:${String(this.closed)}`
    if (this.cache?.key === key) return this.cache.rows
    const rows = this.build(width).map(row => this.components.truncateToWidth(row, width))
    this.cache = { key, rows }
    return rows
  }

  private build(width: number): string[] {
    const { colors, t } = this
    const entry = this.entry
    if (entry.preparing !== undefined) {
      const text = t('Preparing {name} · {count} chars', { name: toolDisplayName(entry.name), count: formatTokens(entry.preparing.characters) })
      return ['', colors.muted(`⋯ ${sanitizePluginText(text)}`)]
    }
    const result = entry.result
    const pending = result === undefined
    const cancelled = pending && this.closed
    const failed = result?.isError === true
    const bullet = pending
      ? cancelled ? colors.muted('⊘ ') : colors.text('● ')
      : failed ? colors.error('✗ ') : colors.success('✓ ')
    const parts = this.parts()
    const clean = (text: string): string => sanitizePluginText(text).replace(/[\r\n]+/gu, ' ')
    let row = `${bullet}${this.components.strong(colors.primary(clean(parts.label)))}`
    if (parts.detail !== undefined && parts.detail !== '') row += colors.muted(` · ${clean(parts.detail)}`)
    if (cancelled) row += colors.muted(` · ${t('cancelled')}`)
    else if (parts.outcome !== undefined) {
      // An answer arrow reads as a continuation, not a separate chip.
      const joined = parts.outcome.startsWith('→') ? ` ${clean(parts.outcome)}` : ` · ${clean(parts.outcome)}`
      row += failed ? colors.error(joined) : colors.muted(joined)
    }
    const rows = ['', row]
    if (!this.expanded || result === undefined) return rows
    const web = entry.web
    if (web?.kind === 'search') {
      web.sources.forEach((source, index) => {
        const branch = index === web.sources.length - 1 ? '└─' : '├─'
        const title = source.title === undefined ? '' : `${clean(source.title)} — `
        rows.push(`  ${branch} ${title}${colors.muted(clean(source.url))}`)
      })
      return rows
    }
    const body = prettyJson(sanitizePluginText(result.fullText ?? result.text).replace(/\n+$/, ''))
    if (body.trim() === '') return rows
    const wrapped = this.components.wrapText(body, Math.max(1, width - 2))
    const paint = failed ? colors.error : colors.muted
    const shown = wrapped.slice(0, TOOL_LINE_EXPANDED_ROWS)
    rows.push(...shown.map(line => `  ${paint(line)}`))
    if (wrapped.length > shown.length) rows.push(`  ${colors.textMuted(moreLinesHint(t, wrapped.length - shown.length, wrapped.length, false))}`)
    return rows
  }

  /** The row's label, detail, and outcome by activity or name. */
  private parts(): LineParts {
    const { t } = this
    const entry = this.entry
    const args = parseToolArguments(entry.arguments)
    const result = entry.result
    const outcome = result === undefined ? undefined : firstLine(result.fullText ?? result.text)
    switch (entry.activity) {
      case 'subagents': {
        const { label, detail } = agentCallLabel(entry.name, args, entry.arguments)
        return { label, detail, outcome: result === undefined ? t('running') : outcome }
      }
      case 'questions': {
        const answer = result === undefined || result.isError ? undefined : answers(result.fullText ?? result.text)
        return { label: entry.detail, outcome: result === undefined ? t('waiting for your answer') : answer === undefined ? outcome : `→ ${answer}` }
      }
      case 'webSearch': {
        const sources = entry.web?.kind === 'search' ? entry.web : undefined
        if (sources === undefined) return { label: t(result === undefined ? 'Searching the web' : 'Searched the web'), detail: entry.detail, outcome: result?.isError === true ? outcome : undefined }
        const count = t(sources.sources.length === 1 ? '{count} source' : '{count} sources', { count: sources.sources.length })
        return { label: t('Searched the web'), detail: entry.detail, outcome: sources.truncated ? `${count} · ${t('truncated')}` : count }
      }
      case 'webFetch': {
        const fetched = entry.web?.kind === 'fetch' ? entry.web : undefined
        if (fetched === undefined) return { label: t(result === undefined ? 'Fetching' : 'Fetched'), detail: entry.detail, outcome: result?.isError === true ? outcome : undefined }
        return { label: t('Fetched'), detail: fetched.url, outcome: fetched.truncated ? `${String(fetched.statusCode)} · ${t('truncated')}` : String(fetched.statusCode) }
      }
      case 'plan':
        // Plan state lives in the todo pane and the goal status; the row names the change.
        if (entry.name === 'todo_write') return { label: t('Updated the plan'), detail: this.todoDetail(args), outcome: result?.isError === true ? outcome : undefined }
        return { label: entry.title ?? toolDisplayName(entry.name), detail: entry.detail === entry.name ? undefined : entry.detail, outcome: result?.isError === true ? outcome : undefined }
      default:
        break
    }
    if (entry.name === 'skill') return { label: entry.title ?? toolDisplayName(entry.name), outcome: result?.isError === true ? outcome : undefined }
    if (entry.name === 'send_message') {
      const values = record(args)
      const to = typeof values['to'] === 'string' ? values['to'] : typeof values['agent'] === 'string' ? values['agent'] : undefined
      if (to !== undefined) return { label: t('Message to {to}', { to }), detail: typeof values['message'] === 'string' ? ellipsize(values['message'], OUTCOME_MAX_CHARS) : undefined, outcome }
    }
    const label = entry.title ?? toolDisplayName(entry.name)
    return { label, detail: entry.detail === entry.name || label.includes(entry.detail) ? undefined : entry.detail, outcome }
  }

  /** `3/5 done · ● current item` from a todo list argument. */
  private todoDetail(args: unknown): string | undefined {
    const todos = record(args)['todos']
    if (!Array.isArray(todos) || todos.length === 0) return undefined
    const items = todos.map(record)
    const done = items.filter(item => item['status'] === 'completed').length
    const current = items.find(item => item['status'] === 'in_progress')?.['content']
    const counts = this.t('{done}/{total} done', { done, total: items.length })
    return typeof current === 'string' ? `${counts} · ● ${ellipsize(current, OUTCOME_MAX_CHARS)}` : counts
  }
}
