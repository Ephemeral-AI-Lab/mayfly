/**
 * The facts of tool calls at the three tiers every tool is designed at: a verbose block per call (the line and a short
 * body), a standard block for a run of calls of one kind (a head and a tree), and the stream's merged title for the compact
 * tier (`process-activity`). A call is reduced once to a {@link Call}: its tool name, target, outcome, and lazy bodies, so
 * the tiers differ only in how they lay the same facts out. What differs per category (phrases, merging, streaming) is the
 * descriptor in `tool-kinds`. A call that is still in flight is a pending line with its own time and its input under it: a
 * command's further lines, the code an edit or write is generating (the activity row names only the phase). Texts leave
 * here translated and sanitized.
 *
 * @module @ephemeral-ai/mayfly/transcript/tool-calls
 */

import { alignDiffLines, diffModel } from '../core/diff-align.ts'
import { sanitizePluginText } from '../core/plugin-view.ts'
import { argumentDetail } from '../conversation/activity-detail.ts'
import type { MayflyTranslate } from '../frontend/locale.ts'
import type { CommandCallModel, ProcessActivity, ReadCallModel, SearchCallModel, TranscriptEntryModel } from '../frontend/models.ts'
import type { StreamRow } from '../components/transcript-view.ts'
import type { ToolBodyRow, ToolDiffHunk, ToolLineState, ToolStat } from '../components/tool-line.ts'
import { compactElapsedMs } from './agent-presentation.ts'
import { trimContext, WRITE_HEAD_LINES } from './official-model.ts'
import { elapsedText } from './process-activity.ts'
import { partialStrings } from './partial-json.ts'
import { ellipsize } from './present.ts'
import { kindOf, unitPhrase } from './tool-kinds.ts'

/** Rows a verbose block's body shows. */
export const VERBOSE_BODY_ROWS = 6

/** Rows a verbose block's body shows once Ctrl+O opens the turn: every row the facts carry. */
export const OPEN_BODY_ROWS = 40

/** Rows of a file change's body at the Standard tier, settled or being generated. */
export const STANDARD_DIFF_ROWS = 6

/** Rows of input a running call shows at the Standard tier: a command's lines after the first. */
export const STANDARD_INPUT_ROWS = 3

/** Lines of a file change's input the facts keep while it is generated: the same bound a settled change keeps. */
const LIVE_CHANGE_LINES = 60

/** Rows of a file change's body at the Verbose tier; Ctrl+O lifts it to {@link OPEN_BODY_ROWS}. */
export const VERBOSE_CHANGE_ROWS = 12

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

/** The body of a file change: an edit's hunks, or the head of a write's code. */
type ChangeBody =
  // `tail`: the change is still being written, so its last rows are what a block shows (a settled one shows its first).
  | { readonly kind: 'diff', readonly language?: string, readonly hunks: readonly { readonly before: string, readonly after: string, readonly rows: number }[], readonly hidden: number, readonly tail?: boolean }
  | { readonly kind: 'code', readonly head: readonly string[], readonly total: number, readonly language?: string, readonly tail?: boolean }

/** Where a call is: its arguments still stream, it runs, or it has settled (or was cut off). */
export type CallPhase = 'preparing' | 'running' | 'settled'

/** One call, in flight or settled (or cut off), reduced to what any tier lays out. */
export interface Call {
  readonly id: string
  readonly activity: ProcessActivity
  readonly state: ToolLineState
  readonly phase: CallPhase
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
  /** What the call was given, for the time it runs: the lines of a command that spans several. */
  readonly input: () => Body
  /** Whether the input's rows are the call's target in full, so a running line at the tiers that draw them names only the tool. */
  readonly inputIsTarget?: boolean
  /** A file change: its kind and diffstat, and the diff or code its body draws (while it is generated, too). */
  readonly file?: { readonly stat: ToolStat, readonly statInLine: boolean, readonly content: () => ChangeBody }
}

type ToolEntry = Extract<TranscriptEntryModel, { readonly kind: 'transcript-tool' }>

/** The state a call reads as: a call that still runs is pending, and one cut off with its turn is cancelled. */
function stateOf(state: 'pending' | 'ok' | 'error', closed: boolean): ToolLineState {
  if (state === 'pending') return closed ? 'cancelled' : 'pending'
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

const NO_ROWS: Body = { rows: [], total: 0 }

function phaseOf(state: ToolLineState, preparing: boolean): CallPhase {
  if (state !== 'pending') return 'settled'
  return preparing ? 'preparing' : 'running'
}

/** The non-blank lines of a text, as the rows a running call shows in place of its target. */
function allLines(text: string): Body {
  const lines = text.split('\n').map(line => line.trimEnd()).filter(line => line.trim() !== '')
  return { rows: lines.slice(0, OPEN_BODY_ROWS).map(line => bodyRow(line)), total: lines.length }
}

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

function readCall(groupId: string, call: ReadCallModel, closed: boolean, t: MayflyTranslate): Call {
  const state = stateOf(call.state, closed)
  const shown = call.range === undefined ? undefined : call.range.last - call.range.first + 1
  const lines = shown === undefined ? undefined
    : call.totalLines !== undefined && shown < call.totalLines ? t('{shown} of {total} lines', { shown, total: call.totalLines })
    : t(shown === 1 ? '{count} line' : '{count} lines', { count: shown })
  const target = call.path ?? call.label
  return {
    id: `${groupId}:${call.callId}`,
    activity: call.activity,
    state,
    phase: phaseOf(state, false),
    name: nameOf(call.name),
    ...(target === undefined ? {} : { target }),
    label: target ?? nameOf(call.name),
    outcome: [state === 'error' ? reason(call.error) : lines],
    startedAt: call.startedAt,
    ...(call.endedAt === undefined ? {} : { endedAt: call.endedAt }),
    ...(shown === undefined ? {} : { lines: shown }),
    input: () => NO_ROWS,
    body: () => {
      const preview = call.previewLines ?? []
      const width = String(preview.at(-1)?.number ?? 0).length
      return { rows: preview.map(line => bodyRow(line.text, String(line.number).padStart(width))), total: shown ?? preview.length }
    },
  }
}

function searchCall(groupId: string, call: SearchCallModel, closed: boolean, t: MayflyTranslate): Call {
  const state = stateOf(call.state, closed)
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
    phase: phaseOf(state, false),
    name: nameOf(call.name),
    target,
    label: target,
    outcome: [state === 'error' ? reason(call.error) : found],
    startedAt: call.startedAt,
    ...(call.endedAt === undefined ? {} : { endedAt: call.endedAt }),
    ...(matches === undefined ? {} : { matches }),
    input: () => NO_ROWS,
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

function commandCall(groupId: string, call: CommandCallModel, closed: boolean, t: MayflyTranslate): Call {
  const state = stateOf(call.state, closed)
  const why = state === 'error' ? exitText(call.exitCode, call.signal, t) ?? reason(call.error) : undefined
  return {
    id: `${groupId}:${call.callId}`,
    activity: call.activity,
    state,
    phase: phaseOf(state, false),
    name: nameOf(call.name),
    target: call.command,
    label: call.command,
    outcome: [why, took(call.startedAt, call.endedAt)],
    startedAt: call.startedAt,
    ...(call.endedAt === undefined ? {} : { endedAt: call.endedAt }),
    input: () => {
      const lines = call.commandLines ?? []
      return { rows: lines.map(line => bodyRow(line)), total: lines.length }
    },
    ...(call.commandLines === undefined ? {} : { inputIsTarget: true }),
    body: () => {
      const rows = (call.previewLines ?? []).map(line => bodyRow(line))
      return { rows, total: rows.length, tail: true }
    },
  }
}

/** Highlight languages by file extension; anything else is plain code. */
const LANGUAGES: Readonly<Record<string, string>> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', md: 'markdown', py: 'python', rs: 'rust', go: 'go', rb: 'ruby', java: 'java', sh: 'bash', bash: 'bash', zsh: 'bash',
  css: 'css', html: 'xml', xml: 'xml', yml: 'yaml', yaml: 'yaml', toml: 'ini', sql: 'sql', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp',
}

function languageOf(path: string): string | undefined {
  const extension = /\.([A-Za-z0-9]+)$/u.exec(path)?.[1]?.toLowerCase()
  return extension === undefined ? undefined : LANGUAGES[extension]
}

/** A size as a line shows it: bytes under a kilobyte, then kilobytes with one decimal. */
function sizeText(bytes: number): string {
  return bytes < 1024 ? `${String(bytes)} B` : `${String(Math.round(bytes / 102.4) / 10)} KB`
}

/** The lines of a text, without the empty piece a closing newline leaves. */
function linesOf(text: string): string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * The body of a file change that is still being written: the code of a write so far, or the two sides of an edit so far.
 * Nothing is drawn until the model has written some of it.
 */
function liveChange(entry: ToolEntry, fields: Readonly<Record<string, string>>, path: string | undefined): { readonly content: () => ChangeBody, readonly stat: ToolStat } | undefined {
  const language = path === undefined ? undefined : languageOf(path)
  const styled = language === undefined ? {} : { language }
  if (entry.activity === 'write') {
    const content = fields['content']
    if (content === undefined || content === '') return undefined
    const lines = linesOf(content)
    const streaming = entry.preparing !== undefined
    return {
      stat: { added: lines.length, removed: 0 },
      content: () => ({ kind: 'code', head: streaming ? lines.slice(-WRITE_HEAD_LINES) : lines.slice(0, WRITE_HEAD_LINES), total: lines.length, ...(streaming ? { tail: true } : {}), ...styled }),
    }
  }
  const before = fields['old_string']
  const after = fields['new_string']
  if (before === undefined && after === undefined) return undefined
  const cut = (text: string): { readonly kept: string, readonly left: number } => {
    const lines = linesOf(text)
    return { kept: lines.slice(0, LIVE_CHANGE_LINES).join('\n'), left: Math.max(0, lines.length - LIVE_CHANGE_LINES) }
  }
  // The context the change leaves alone is trimmed as a settled change's is, so the rows do not change on settling.
  const trimmed = trimContext(before ?? '', after ?? '', entry.preparing === undefined)
  const old = cut(trimmed.before)
  const next = cut(trimmed.after)
  return {
    stat: { added: linesOf(after ?? '').length, removed: linesOf(before ?? '').length },
    content: () => ({
      kind: 'diff',
      ...styled,
      hunks: [{ before: old.kept, after: next.kept, rows: diffModel(alignDiffLines(old.kept, next.kept), { context: 1 }).length }],
      hidden: old.left + next.left,
      ...(entry.preparing === undefined ? {} : { tail: true }),
    }),
  }
}

/** An edit or write as a call: its tool name and path, the diffstat or the size, and the diff or code as its body. */
function fileCall(entry: ToolEntry, closed: boolean, t: MayflyTranslate): Call {
  const state = stateOf(entry.result === undefined ? 'pending' : entry.result.isError ? 'error' : 'ok', closed)
  const change = entry.change
  // While the call is in flight the arguments are all there is: complete once it is committed, partial while they stream.
  const fields = entry.result === undefined && change === undefined ? partialStrings(entry.arguments).fields : {}
  const path = change?.path ?? fields['file_path'] ?? fields['path']
  const target = path ?? (entry.detail === '' ? undefined : ellipsize(sanitizePluginText(entry.detail), TARGET_MAX_CHARS))
  const name = nameOf(entry.name)
  const write = change?.write
  const outcome = state === 'error' ? [reason(entry.result?.text)]
    : write === undefined ? [] : [t(write.lines === 1 ? '{count} line' : '{count} lines', { count: write.lines }), sizeText(write.bytes)]
  const hasStat = state === 'ok' && change !== undefined && write === undefined
  const live = state === 'pending' ? liveChange(entry, fields, path) : undefined
  return {
    id: entry.id,
    activity: entry.activity,
    state,
    phase: phaseOf(state, entry.preparing !== undefined),
    name,
    ...(target === undefined ? {} : { target: path === undefined ? target : ellipsize(sanitizePluginText(path), TARGET_MAX_CHARS) }),
    label: target ?? name,
    outcome,
    startedAt: entry.startedAt,
    ...(entry.result === undefined ? {} : { endedAt: entry.result.endedAt }),
    input: () => NO_ROWS,
    body: () => NO_ROWS,
    ...(change === undefined || state !== 'ok' ? live === undefined ? {} : { file: { stat: live.stat, statInLine: false, content: live.content } } : {
      file: {
        stat: { added: change.added, removed: change.removed },
        statInLine: hasStat,
        content: (): ChangeBody => write !== undefined
          ? { kind: 'code', head: write.head, total: write.lines, ...(languageOf(change.path) === undefined ? {} : { language: languageOf(change.path)! }) }
          : {
              kind: 'diff',
              ...(languageOf(change.path) === undefined ? {} : { language: languageOf(change.path)! }),
              hunks: change.hunks.map(hunk => ({ ...hunk, rows: diffModel(alignDiffLines(hunk.before, hunk.after), { context: 1 }).length })),
              hidden: change.hiddenLines,
            },
      },
    }),
  }
}

function loneCall(entry: ToolEntry, closed: boolean, t: MayflyTranslate): Call {
  const exit = exitText(entry.terminal?.exitCode, entry.terminal?.signal, t)
  const state = stateOf(entry.result === undefined ? 'pending' : entry.result.isError || exit !== undefined ? 'error' : 'ok', closed)
  const web = entry.web
  const text = entry.result?.text ?? ''
  // A call whose arguments still stream names the target as far as they have gone.
  const fields = entry.preparing === undefined ? undefined : partialStrings(entry.arguments).fields
  const command = entry.terminal?.command ?? (entry.activity === 'commands' ? fields?.['command'] : undefined)
  const salient = ellipsize(sanitizePluginText(fields === undefined ? entry.detail : argumentDetail(fields)), TARGET_MAX_CHARS)
  const further = command === undefined ? NO_ROWS : allLines(command)
  // The arguments the model gave: a command, a query, an address, else the salient one (not the tool's own name).
  const target = command !== undefined ? ellipsize(`${linesOf(command).find(line => line.trim() !== '') ?? command}${further.total > 1 ? ' …' : ''}`, COMMAND_MAX_CHARS)
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
    phase: phaseOf(state, entry.preparing !== undefined),
    name,
    ...(target === undefined ? {} : { target }),
    label: kindOf(entry.activity).headed ? target ?? name : `${name}${target === undefined ? '' : `(${target})`}`,
    outcome,
    startedAt: entry.startedAt,
    ...(entry.result === undefined ? {} : { endedAt: entry.result.endedAt }),
    input: () => further,
    ...(further.total > 1 ? { inputIsTarget: true } : {}),
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

/** A call in flight as a pending line's outcome: the whole seconds it has taken so far, nothing in the first second. */
function pendingElapsed(ms: number): string | undefined {
  return ms < 1000 ? undefined : compactElapsedMs(ms)
}

/**
 * A call that is in flight, as the stream shows it: once it runs, its time so far is its outcome. While the model still
 * writes its arguments it has no time of its own (the activity row counts the turn's).
 */
function whilePending(call: Call, now: number): Call {
  if (call.state !== 'pending') return call
  return { ...call, outcome: call.phase === 'preparing' ? [] : [pendingElapsed(Math.max(0, now - call.startedAt))] }
}

/**
 * The calls of one entry, in the order they were made: a call in flight is pending with the time it has taken so far, and
 * a call cut off with its turn is cancelled. A call whose arguments still stream is pending too: the stream shows it as
 * soon as the model names it.
 * @param entry - a tool or a group of read, search, or command calls.
 * @param closed - whether the entry's turn has ended.
 * @param t - translator for the transcript namespace.
 * @param now - the time, which a pending call measures its own against.
 * @returns the calls.
 */
export function callsOf(entry: TranscriptEntryModel, closed: boolean, t: MayflyTranslate, now: number): readonly Call[] {
  const calls: Call[] = []
  switch (entry.kind) {
    case 'transcript-read-group': for (const call of entry.reads) calls.push(readCall(entry.id, call, closed, t)); break
    case 'transcript-search-group': for (const call of entry.searches) calls.push(searchCall(entry.id, call, closed, t)); break
    case 'transcript-command-group': for (const call of entry.commands) calls.push(commandCall(entry.id, call, closed, t)); break
    case 'transcript-tool':
      calls.push(entry.change !== undefined || kindOf(entry.activity).streams ? fileCall(entry, closed, t) : loneCall(entry, closed, t))
      break
    default: break
  }
  return calls.map(call => whilePending(call, now))
}

function outcomeText(call: Call): string | undefined {
  const text = call.outcome.filter((part): part is string => part !== undefined && part !== '').join(' · ')
  // A call the turn ended without settling has no outcome to report.
  return text === '' || call.state === 'cancelled' ? undefined : sanitizePluginText(text)
}

/** The last rows of a hunk that fit `cap` rows: the text of each side from the first kept row, and the number the first one has. */
function tailHunk(hunk: { readonly before: string, readonly after: string }, cap: number): { readonly before: string, readonly after: string, readonly start: number, readonly rows: number, readonly kept: number } {
  const ops = alignDiffLines(hunk.before, hunk.after)
  const rowsOf = (from: number): number => diffModel(ops.slice(from), { context: 1 }).length
  const total = rowsOf(0)
  let from = 0
  while (from < ops.length && rowsOf(from) > cap) from += 1
  // Only one unchanged line of context leads the window, so no `⋯` stands above it.
  while (ops[from]?.type === 'ctx' && ops[from + 1]?.type === 'ctx') from += 1
  const kept = ops.slice(from)
  return {
    before: kept.filter(op => op.type !== 'add').map(op => op.text).join('\n'),
    after: kept.filter(op => op.type !== 'del').map(op => op.text).join('\n'),
    // The gutter numbers the modified file, so the rows dropped above it that exist there move the first number down.
    start: 1 + ops.slice(0, from).filter(op => op.type !== 'del').length,
    rows: total,
    kept: rowsOf(from),
  }
}

/** The diff or code body of a file change within `cap` rows, and the row that says how much is left out (after it, or before it for the end of a change still being written). */
function changeLayout(call: Call, cap: number, open: boolean, t: MayflyTranslate): { readonly diff?: readonly ToolDiffHunk[], readonly code?: { readonly text: string, readonly language?: string, readonly start?: number }, readonly more?: string, readonly moreBefore?: string } {
  const content = call.file?.content()
  if (content === undefined || cap <= 0) return {}
  const hint = open ? '' : t(' · Ctrl+O')
  const earlier = (count: number): string => `${t('… +{count} earlier', { count })}${hint}`
  if (content.kind === 'code' && content.tail === true) {
    const rows = content.head.slice(-cap)
    const left = content.total - rows.length
    return {
      code: { text: rows.join('\n'), start: content.total - rows.length + 1, ...(content.language === undefined ? {} : { language: content.language }) },
      ...(left > 0 ? { moreBefore: earlier(left) } : {}),
    }
  }
  if (content.kind === 'diff' && content.tail === true && content.hunks.length > 0) {
    const shown = tailHunk(content.hunks[0]!, cap)
    const left = shown.rows - shown.kept + content.hidden
    return {
      diff: [{ before: shown.before, after: shown.after, start: shown.start, ...(content.language === undefined ? {} : { language: content.language }) }],
      ...(left > 0 ? { moreBefore: earlier(left) } : {}),
    }
  }
  if (content.kind === 'code') {
    const rows = content.head.slice(0, cap)
    const left = content.total - rows.length
    return {
      code: { text: rows.join('\n'), ...(content.language === undefined ? {} : { language: content.language }) },
      ...(left > 0 ? { more: `${t('… +{count} more', { count: left })}${hint}` } : {}),
    }
  }
  const styled = content.language === undefined ? {} : { language: content.language }
  let room = cap
  let hidden = content.hidden
  const hunks: ToolDiffHunk[] = []
  let cut = false
  for (const hunk of content.hunks) {
    // The `⋯` between two hunks takes a row of the budget.
    if (hunks.length > 0) room -= 1
    if (room <= 0) { hidden += hunk.rows; continue }
    if (hunk.rows <= room) {
      hunks.push({ before: hunk.before, after: hunk.after, ...styled })
      room -= hunk.rows
    } else {
      // The hunk that does not fit ends with the row that counts everything left out, its own and the hunks after it.
      hunks.push({ before: hunk.before, after: hunk.after, maxRows: room, ...styled })
      hidden += hunk.rows - room
      cut = true
      room = 0
    }
  }
  const left = hidden > 0 ? `${t('… +{count} rows', { count: hidden })}${hint}` : undefined
  if (cut && left !== undefined) hunks[hunks.length - 1] = { ...hunks[hunks.length - 1]!, tail: left }
  return { diff: hunks, ...(!cut && left !== undefined ? { more: left } : {}) }
}

/**
 * One call as a block: its line and the first rows of its body. A call in flight shows its input under the line instead.
 * @param call - the call.
 * @param open - whether Ctrl+O opened the turn, which shows every row the facts carry.
 * @param t - translator for the transcript namespace.
 * @param tier - `standard` for a call the standard tier draws alone: a file change is open at 6 rows, any other call has no body;
 *   `compact` for a call in flight at the compact level: its line alone.
 * @returns the block's row.
 */
export function verboseRow(call: Call, open: boolean, t: MayflyTranslate, tier: 'verbose' | 'standard' | 'compact' = 'verbose'): StreamRow {
  const running = call.state === 'pending'
  const cap = running
    ? tier === 'compact' ? 0 : tier === 'standard' ? STANDARD_INPUT_ROWS : open ? OPEN_BODY_ROWS : VERBOSE_BODY_ROWS
    : open ? OPEN_BODY_ROWS : VERBOSE_BODY_ROWS
  // A call that was cut off has no output, and a failed read or search has only its reason, which the line already gives.
  const quiet = call.state === 'cancelled' || (call.state === 'error' && (call.activity === 'read' || call.activity === 'readImage' || call.activity === 'search'))
  const body: Body = quiet ? NO_ROWS : running ? call.input() : tier === 'verbose' ? call.body() : NO_ROWS
  const rows = body.tail === true ? body.rows.slice(-cap) : body.rows.slice(0, cap)
  const left = body.total - rows.length
  const hint = open ? '' : t(' · Ctrl+O')
  const textMore = left > 0 && cap > 0 ? `${t(body.tail === true ? '… +{count} earlier' : '… +{count} more', { count: left })}${hint}` : undefined
  const change = call.file === undefined || (call.state !== 'ok' && !running) || tier === 'compact' ? {}
    : changeLayout(call, tier === 'standard' ? STANDARD_DIFF_ROWS : open ? OPEN_BODY_ROWS : VERBOSE_CHANGE_ROWS, open, t)
  const more = textMore ?? change.more
  const moreBefore = body.tail === true ? more : change.moreBefore
  const outcome = outcomeText(call)
  return {
    kind: 'tool',
    id: call.id,
    state: call.state,
    name: sanitizePluginText(call.name),
    // A running command that spans several lines shows them under the bare tool name; the target comes back with the result.
    ...(call.target === undefined || call.target === '' || (running && call.inputIsTarget === true && rows.length > 0) ? {} : { target: sanitizePluginText(call.target) }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(call.file?.statInLine === true && call.state === 'ok' ? { stat: call.file.stat } : {}),
    ...(rows.length === 0 ? {} : { body: rows }),
    ...(change.diff === undefined || change.diff.length === 0 ? {} : { diff: change.diff }),
    ...(change.code === undefined ? {} : { code: change.code }),
    ...(moreBefore === undefined ? {} : { moreBefore }),
    ...(more === undefined || body.tail === true ? {} : { more }),
  }
}

/**
 * A run of calls of one kind as a standard block, from the first call on: the tool's name and what the calls count, and a line
 * per call that changes in place as the call runs and settles. A single call is its own line.
 * @param calls - the run's calls, in flight or settled, all of one category.
 * @param t - translator for the transcript namespace.
 * @param now - the time, which a block with a call in flight measures its own against.
 * @returns the run's row.
 */
export function standardRow(calls: readonly Call[], t: MayflyTranslate, now: number): StreamRow {
  const first = calls[0]!
  if (calls.length === 1) return verboseRow(first, false, t, 'standard')
  const running = calls.some(call => call.state === 'pending')
  const lines = !running && calls.every(call => call.lines !== undefined || call.state !== 'ok') ? calls.reduce((sum, call) => sum + (call.lines ?? 0), 0) : undefined
  const matches = !running && calls.every(call => call.matches !== undefined || call.state !== 'ok') ? calls.reduce((sum, call) => sum + (call.matches ?? 0), 0) : undefined
  const starts = calls.map(call => call.startedAt)
  const ends = calls.flatMap(call => call.endedAt === undefined ? [] : [call.endedAt])
  const span = running ? pendingElapsed(Math.max(0, now - Math.min(...starts)))
    : ends.length === 0 ? undefined : elapsedText(Math.max(...ends) - Math.min(...starts))
  const failed = calls.filter(call => call.state === 'error').length
  const names = [...new Set(calls.map(call => call.name))]
  const head = [
    unitPhrase(first.activity, calls.length, t),
    lines === undefined || lines === 0 ? undefined : t('{count} lines', { count: lines }),
    matches === undefined || matches === 0 ? undefined : t(matches === 1 ? '{count} match' : '{count} matches', { count: matches }),
    span,
  ].filter((part): part is string => part !== undefined).join(' · ')
  return {
    kind: 'tools',
    id: `run:${first.id}`,
    state: running ? 'pending' : failed > 0 ? 'error' : calls.some(call => call.state === 'cancelled') ? 'cancelled' : 'ok',
    name: sanitizePluginText(names.length === 1 ? names[0]! : kindOf(first.activity).title),
    head: sanitizePluginText(head),
    ...(failed === 0 ? {} : { failed: t('{count} failed', { count: failed }) }),
    items: calls.map((call) => {
      const outcome = outcomeText(call)
      return {
        state: call.state,
        label: sanitizePluginText(call.label),
        ...(outcome === undefined ? {} : { outcome }),
      }
    }),
  }
}
