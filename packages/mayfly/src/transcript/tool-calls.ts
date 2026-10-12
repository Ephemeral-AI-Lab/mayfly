/**
 * The facts of settled tool calls at the three tiers every tool is designed at: a verbose block per call (the line and a
 * short body), a standard block for a run of calls of one kind (a head and a tree), and the stream's merged title for the
 * compact tier (`process-activity`). A call is reduced once to a {@link Call}: its tool name, target, outcome, and a lazy body,
 * so the tiers differ only in how they lay the same facts out. A call that still runs has no block at any tier; the
 * activity row names it. Texts leave here translated and sanitized.
 *
 * @module @ephemeral-ai/mayfly/transcript/tool-calls
 */

import { sanitizePluginText } from '../core/plugin-view.ts'
import type { MayflyTranslate } from '../frontend/locale.ts'
import type { CommandCallModel, ProcessActivity, ReadCallModel, SearchCallModel, TranscriptEntryModel } from '../frontend/models.ts'
import type { StreamRow } from '../components/transcript-view.ts'
import type { ToolBodyRow, ToolLineState } from '../components/tool-line.ts'
import { countPhrase, elapsedText } from './process-activity.ts'
import { ellipsize } from './present.ts'

/** Rows a verbose block's body shows. */
export const VERBOSE_BODY_ROWS = 6

/** Rows a verbose block's body shows once Ctrl+O opens the turn: every row the facts carry. */
export const OPEN_BODY_ROWS = 40

/** Characters of a salient argument kept on a row. */
const TARGET_MAX_CHARS = 80

/** Characters of a command kept on its line, the same bound the model keeps. */
const COMMAND_MAX_CHARS = 120

/** Characters of the failure reason kept on a line. */
const REASON_MAX_CHARS = 80

/** Characters of one body row kept in the facts: the row clips to the width it is given. */
const BODY_ROW_MAX_CHARS = 200

/** The body of a call: its rows, and how many rows the output has in all. */
interface Body {
  readonly rows: readonly ToolBodyRow[]
  readonly total: number
  /** Whether the rows are the end of the output, so what is left out is above them. */
  readonly tail?: boolean
}

/** One settled (or cut-off) call, reduced to what any tier lays out. */
export interface Call {
  readonly id: string
  readonly activity: ProcessActivity
  readonly state: ToolLineState
  /** The tool's name as the model requested it, in the display form (`Read`, `WebSearch`). */
  readonly name: string
  readonly target?: string
  /** What a line of a standard block calls it: the target, or the name and target of a tool the head does not name. */
  readonly label: string
  readonly outcome: readonly (string | undefined)[]
  readonly startedAt: number
  readonly endedAt?: number
  /** Lines a read returned, for the sum a standard block reports. */
  readonly lines?: number
  /** Matches a search found, for the sum a standard block reports. */
  readonly matches?: number
  readonly body: () => Body
}

type ToolEntry = Extract<TranscriptEntryModel, { readonly kind: 'transcript-tool' }>

/** Whether a tool entry is a file change, which has no block of its own until the edit and write cards. */
export function isFileChange(entry: ToolEntry): boolean {
  return entry.family === 'edit' || entry.activity === 'edit' || entry.activity === 'write'
}

/** The state a call reads as, or `undefined` while it still runs (the activity row owns it). */
function stateOf(state: 'pending' | 'ok' | 'error', closed: boolean): ToolLineState | undefined {
  if (state === 'pending') return closed ? 'cancelled' : undefined
  return state
}

/**
 * The display form of a tool's name: `web_search` reads `WebSearch`, and `mcp__github__search_issues` reads
 * `github › search_issues`. The name is the tool's own, never a verb of ours.
 */
function nameOf(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/u.exec(name)
  if (mcp !== null) return `${mcp[1]!} › ${mcp[2]!}`
  return name.split('_').filter(part => part !== '').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('')
}

/** The categories whose head names what the calls did, so a call's line in the block is just its target. */
const HEADED = new Set<ProcessActivity>(['read', 'readImage', 'search', 'commands', 'code', 'webSearch', 'webFetch'])

function took(startedAt: number, endedAt: number | undefined): string | undefined {
  return endedAt === undefined ? undefined : elapsedText(endedAt - startedAt)
}

function flat(text: string, max: number): string | undefined {
  const line = text.split('\n').find(candidate => candidate.trim() !== '')
  return line === undefined ? undefined : ellipsize(sanitizePluginText(line.trim()), max)
}

function reason(message: string | undefined): string | undefined {
  return message === undefined ? undefined : flat(message, REASON_MAX_CHARS)
}

function exitText(exitCode: number | undefined, signal: string | undefined, t: MayflyTranslate): string | undefined {
  if (signal !== undefined) return t('signal {signal}', { signal })
  return exitCode === undefined || exitCode === 0 ? undefined : t('exit {code}', { code: exitCode })
}

function bodyRow(text: string, lead?: string, tone?: ToolBodyRow['tone']): ToolBodyRow {
  // Code keeps its indentation: only tabs and the end of an over-long row change.
  const kept = sanitizePluginText(text.replace(/\t/g, '  ').trimEnd())
  return { ...(lead === undefined ? {} : { lead }), text: kept.length <= BODY_ROW_MAX_CHARS ? kept : `${kept.slice(0, BODY_ROW_MAX_CHARS - 1)}…`, ...(tone === undefined ? {} : { tone }) }
}

/** The first non-blank lines of a text, and how many lines it has in all. */
function headOf(text: string, max: number): Body {
  const rows: ToolBodyRow[] = []
  let total = 0
  let from = 0
  while (from <= text.length) {
    let to = text.indexOf('\n', from)
    if (to === -1) to = text.length
    if (text.slice(from, to).trim() !== '') {
      total += 1
      if (rows.length < max) rows.push(bodyRow(text.slice(from, to).trimEnd()))
    }
    from = to + 1
  }
  return { rows, total }
}

function readCall(groupId: string, call: ReadCallModel, closed: boolean, t: MayflyTranslate): Call | undefined {
  const state = stateOf(call.state, closed)
  if (state === undefined) return undefined
  const shown = call.range === undefined ? undefined : call.range.last - call.range.first + 1
  const lines = shown === undefined ? undefined
    : call.totalLines !== undefined && shown < call.totalLines ? t('{shown} of {total} lines', { shown, total: call.totalLines })
    : t(shown === 1 ? '{count} line' : '{count} lines', { count: shown })
  const target = call.path ?? call.label
  return {
    id: `${groupId}:${call.callId}`,
    activity: call.activity,
    state,
    name: nameOf(call.name),
    ...(target === undefined ? {} : { target }),
    label: target ?? nameOf(call.name),
    outcome: [state === 'error' ? reason(call.error) : lines],
    startedAt: call.startedAt,
    ...(call.endedAt === undefined ? {} : { endedAt: call.endedAt }),
    ...(shown === undefined ? {} : { lines: shown }),
    body: () => {
      const preview = call.previewLines ?? []
      const width = String(preview.at(-1)?.number ?? 0).length
      return { rows: preview.map(line => bodyRow(line.text, String(line.number).padStart(width))), total: shown ?? preview.length }
    },
  }
}

function searchCall(groupId: string, call: SearchCallModel, closed: boolean, t: MayflyTranslate): Call | undefined {
  const state = stateOf(call.state, closed)
  if (state === undefined) return undefined
  let found: string | undefined
  let matches: number | undefined
  if (call.shape === 'paths') {
    const paths = call.pathsTotal ?? call.paths?.length ?? 0
    found = paths === 0 ? t('no matches') : t(paths === 1 ? '{count} path' : '{count} paths', { count: paths })
  } else if (call.shape === 'matches') {
    const files = call.files ?? []
    matches = call.total ?? files.reduce((sum, file) => sum + file.count, 0)
    found = matches === 0 ? t('no matches') : t('{matches} in {files}', {
      matches: t(matches === 1 ? '{count} match' : '{count} matches', { count: matches }),
      files: t(files.length === 1 ? '{count} file' : '{count} files', { count: files.length }),
    })
  }
  const target = call.pattern === undefined ? call.detail : `"${call.pattern}"`
  return {
    id: `${groupId}:${call.callId}`,
    activity: call.activity,
    state,
    name: nameOf(call.name),
    target,
    label: target,
    outcome: [state === 'error' ? reason(call.error) : found],
    startedAt: call.startedAt,
    ...(call.endedAt === undefined ? {} : { endedAt: call.endedAt }),
    ...(matches === undefined ? {} : { matches }),
    body: () => {
      if (call.shape === 'paths') {
        const paths = call.paths ?? []
        return { rows: paths.map(path => bodyRow(path)), total: call.pathsTotal ?? paths.length }
      }
      const rows = (call.files ?? []).flatMap(file => file.previews.map(match => bodyRow(match.line.trim(), `${file.path}:${String(match.lineNumber)}`)))
      return { rows, total: Math.max(rows.length, call.total ?? 0) }
    },
  }
}

function commandCall(groupId: string, call: CommandCallModel, closed: boolean, t: MayflyTranslate): Call | undefined {
  const state = stateOf(call.state, closed)
  if (state === undefined) return undefined
  const why = state === 'error' ? exitText(call.exitCode, call.signal, t) ?? reason(call.error) : undefined
  return {
    id: `${groupId}:${call.callId}`,
    activity: call.activity,
    state,
    name: nameOf(call.name),
    target: call.command,
    label: call.command,
    outcome: [why, took(call.startedAt, call.endedAt)],
    startedAt: call.startedAt,
    ...(call.endedAt === undefined ? {} : { endedAt: call.endedAt }),
    body: () => {
      const rows = (call.previewLines ?? []).map(line => bodyRow(line))
      return { rows, total: rows.length, tail: true }
    },
  }
}

function loneCall(entry: ToolEntry, closed: boolean, t: MayflyTranslate): Call | undefined {
  const exit = exitText(entry.terminal?.exitCode, entry.terminal?.signal, t)
  const state = stateOf(entry.result === undefined ? 'pending' : entry.result.isError || exit !== undefined ? 'error' : 'ok', closed)
  if (state === undefined) return undefined
  const web = entry.web
  const text = entry.result?.text ?? ''
  const salient = ellipsize(sanitizePluginText(entry.detail), TARGET_MAX_CHARS)
  // The arguments the model gave: a command, a query, an address, else the salient one (not the tool's own name).
  const target = entry.terminal !== undefined ? ellipsize(entry.terminal.command, COMMAND_MAX_CHARS)
    : web?.kind === 'fetch' ? web.url
    : entry.activity === 'webSearch' && salient !== '' ? `"${salient}"`
    : salient === '' || salient === entry.name ? undefined : salient
  const outcome: (string | undefined)[] = []
  if (entry.result !== undefined) {
    if (state === 'error') outcome.push(exit ?? reason(text))
    else if (web?.kind === 'fetch') {
      outcome.push(String(web.statusCode), `${String(Math.max(1, Math.round(text.length / 1024)))} KB`, web.truncated ? t('truncated') : undefined)
    } else if (web?.kind === 'search') {
      outcome.push(t(web.sources.length === 1 ? '{count} source' : '{count} sources', { count: web.sources.length }))
    }
    outcome.push(took(entry.startedAt, entry.result.endedAt))
  }
  const name = nameOf(entry.name)
  return {
    id: entry.id,
    activity: entry.activity,
    state,
    name,
    ...(target === undefined ? {} : { target }),
    label: HEADED.has(entry.activity) ? target ?? name : `${name}${target === undefined ? '' : `(${target})`}`,
    outcome,
    startedAt: entry.startedAt,
    ...(entry.result === undefined ? {} : { endedAt: entry.result.endedAt }),
    body: () => {
      if (web?.kind === 'search') {
        return { rows: web.sources.map(source => bodyRow(source.title === undefined ? source.url : `${source.title} · ${source.url.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, '')}`)), total: web.sources.length }
      }
      if (entry.terminal !== undefined) {
        const lines = (entry.terminal.output ?? text).replace(/\n+$/, '').split('\n').filter(line => line.trim() !== '')
        return { rows: lines.slice(-OPEN_BODY_ROWS).map(line => bodyRow(line)), total: lines.length, tail: true }
      }
      return headOf(text, OPEN_BODY_ROWS)
    },
  }
}

/**
 * The settled calls of one entry, in the order they were made. A running call has none, a call cut off with its turn is
 * cancelled, and a file change is not a call here.
 * @param entry - a tool or a group of read, search, or command calls.
 * @param closed - whether the entry's turn has ended.
 * @param t - translator for the transcript namespace.
 * @returns the calls.
 */
export function callsOf(entry: TranscriptEntryModel, closed: boolean, t: MayflyTranslate): readonly Call[] {
  const calls: (Call | undefined)[] = []
  switch (entry.kind) {
    case 'transcript-read-group': for (const call of entry.reads) calls.push(readCall(entry.id, call, closed, t)); break
    case 'transcript-search-group': for (const call of entry.searches) calls.push(searchCall(entry.id, call, closed, t)); break
    case 'transcript-command-group': for (const call of entry.commands) calls.push(commandCall(entry.id, call, closed, t)); break
    case 'transcript-tool': if (!isFileChange(entry)) calls.push(loneCall(entry, closed, t)); break
    default: break
  }
  return calls.filter((call): call is Call => call !== undefined)
}

function outcomeText(call: Call): string | undefined {
  const text = call.outcome.filter((part): part is string => part !== undefined && part !== '').join(' · ')
  // A call the turn ended without settling has no outcome to report.
  return text === '' || call.state === 'cancelled' ? undefined : sanitizePluginText(text)
}

/**
 * One call as a verbose block: its line and the first rows of its body.
 * @param call - the settled call.
 * @param open - whether Ctrl+O opened the turn, which shows every row the facts carry.
 * @param t - translator for the transcript namespace.
 * @returns the block's row.
 */
export function verboseRow(call: Call, open: boolean, t: MayflyTranslate): StreamRow {
  const cap = open ? OPEN_BODY_ROWS : VERBOSE_BODY_ROWS
  // A call cut off has no output, and a failed read or search has only its reason, which the line already gives.
  const quiet = call.state === 'cancelled' || (call.state === 'error' && (call.activity === 'read' || call.activity === 'readImage' || call.activity === 'search'))
  const body: Body = quiet ? { rows: [], total: 0 } : call.body()
  const rows = body.tail === true ? body.rows.slice(-cap) : body.rows.slice(0, cap)
  const left = body.total - rows.length
  const hint = open ? '' : t(' · Ctrl+O')
  const more = left > 0 ? `${t(body.tail === true ? '… +{count} earlier' : '… +{count} more', { count: left })}${hint}` : undefined
  const outcome = outcomeText(call)
  return {
    kind: 'tool',
    id: call.id,
    state: call.state,
    name: sanitizePluginText(call.name),
    ...(call.target === undefined || call.target === '' ? {} : { target: sanitizePluginText(call.target) }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(rows.length === 0 ? {} : { body: rows }),
    ...(more === undefined ? {} : body.tail === true ? { moreBefore: more } : { more }),
  }
}

/**
 * A run of calls of one kind as a standard block. A single call is its own line.
 * @param calls - the run's settled calls, all of one category.
 * @param t - translator for the transcript namespace.
 * @returns the run's row.
 */
export function standardRow(calls: readonly Call[], t: MayflyTranslate): StreamRow {
  const first = calls[0]!
  if (calls.length === 1) return verboseRow({ ...first, body: () => ({ rows: [], total: 0 }) }, false, t)
  const lines = calls.every(call => call.lines !== undefined || call.state !== 'ok') ? calls.reduce((sum, call) => sum + (call.lines ?? 0), 0) : undefined
  const matches = calls.every(call => call.matches !== undefined || call.state !== 'ok') ? calls.reduce((sum, call) => sum + (call.matches ?? 0), 0) : undefined
  const starts = calls.map(call => call.startedAt)
  const ends = calls.flatMap(call => call.endedAt === undefined ? [] : [call.endedAt])
  const span = ends.length === 0 ? undefined : elapsedText(Math.max(...ends) - Math.min(...starts))
  const failed = calls.filter(call => call.state === 'error').length
  const head = [
    countPhrase(first.activity, calls.length, t),
    lines === undefined || lines === 0 ? undefined : t('{count} lines', { count: lines }),
    matches === undefined || matches === 0 ? undefined : t(matches === 1 ? '{count} match' : '{count} matches', { count: matches }),
    span,
  ].filter((part): part is string => part !== undefined).join(' · ')
  return {
    kind: 'tools',
    id: `run:${first.id}`,
    state: failed > 0 ? 'error' : calls.some(call => call.state === 'cancelled') ? 'cancelled' : 'ok',
    head: sanitizePluginText(head),
    ...(failed === 0 ? {} : { failed: t('{count} failed', { count: failed }) }),
    items: calls.map((call) => {
      const outcome = outcomeText(call)
      return { state: call.state, label: sanitizePluginText(call.label), ...(outcome === undefined ? {} : { outcome }) }
    }),
  }
}
