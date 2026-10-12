/**
 * Process-activity vocabulary ported from the upstream Harness Chat client
 * (`dsh-client-ui-chat` process-activity and process-groups): the category a
 * tool call contributes, the ranked summary of one process group's settled
 * members, the past-tense group title the transcript shows, and the
 * present-tense labels the activity row shows. Pure data helpers; renderers
 * pass their own translator.
 *
 * @module @ephemeral-ai/mayfly/transcript/process-activity
 */

import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { isSpawnToolName } from '../conversation/projection.ts'
import type { MayflyTranslate } from '../frontend/locale.ts'
import type { ProcessActivity } from '../frontend/models.ts'

const COMMAND_TOOLS = new Set(['bash', 'pwsh', 'exec_command', 'write_stdin'])
const PLAN_TOOLS = new Set(['todo_write', 'create_goal', 'update_goal', 'get_goal'])

/**
 * Classify one tool call: the upstream name table first, then the presenter
 * vocabulary for tools the table does not know (MCP and plugin tools).
 * @param name - tool name exactly as the model requested it.
 * @param call - the resolved pending-call view, if any.
 * @param result - the resolved settled-result view, if any.
 * @returns the process activity the call counts under.
 */
export function toolActivity(name: string, call?: ToolCallView, result?: ToolResultView): ProcessActivity {
  if (name === 'read') return 'read'
  if (name === 'read_image') return 'readImage'
  if (name === 'grep' || name === 'glob' || name.endsWith('_inspect')) return 'search'
  if (name === 'write') return 'write'
  if (name === 'edit' || name === 'apply_patch') return 'edit'
  if (COMMAND_TOOLS.has(name) || name.startsWith('terminal_')) return 'commands'
  if (name === 'run_code') return 'code'
  if (name === 'web_search') return 'webSearch'
  if (name === 'web_fetch') return 'webFetch'
  if (isSpawnToolName(name)) return 'subagents'
  if (PLAN_TOOLS.has(name)) return 'plan'
  if (name === 'ask_user_question' || name === 'request_user_input') return 'questions'
  if (call?.card === 'terminal' || result?.card === 'terminal') return 'commands'
  if (call?.card === 'diff' || result?.card === 'diff') return 'edit'
  if (result?.card === 'read') return 'read'
  if (result?.card === 'search') return 'search'
  if (result?.card === 'web') return result.kind === 'search' ? 'webSearch' : 'webFetch'
  return 'tools'
}

/** One process member as the summary sees it. */
export interface ProcessMemberFact {
  readonly activity: ProcessActivity
  /** Whether the call is still unsettled (a running or preparing tool). */
  readonly running: boolean
  readonly preparing?: boolean
  readonly failed?: boolean
  /** Producer times of the call, for the wall time a group title reports. */
  readonly startedAt?: number
  readonly endedAt?: number
}

/** Ranked category counts and failures of one process group's settled members. */
export interface ProcessSummary {
  readonly counts: readonly { readonly activity: ProcessActivity, readonly count: number }[]
  readonly failed: number
  /** Wall time from the first member's start to the last member's end, when every settled member has both. */
  readonly durationMs?: number
}

/**
 * Rank categories by call count, ties by first appearance (the upstream
 * `processActivity` ranking).
 * @param members - the group's settled tool members in order.
 * @returns the group summary.
 */
export function summarizeProcess(members: readonly ProcessMemberFact[]): ProcessSummary {
  const counts = new Map<ProcessActivity, number>()
  let failed = 0
  for (const member of members) {
    counts.set(member.activity, (counts.get(member.activity) ?? 0) + 1)
    if (member.failed === true) failed += 1
  }
  const ranked = [...counts].map(([activity, count]) => ({ activity, count })).sort((a, b) => b.count - a.count)
  const starts = members.flatMap(member => member.startedAt === undefined ? [] : [member.startedAt])
  const ends = members.flatMap(member => member.endedAt === undefined ? [] : [member.endedAt])
  const span = starts.length === 0 || ends.length === 0 ? undefined : Math.max(...ends) - Math.min(...starts)
  return { counts: ranked, failed, ...(span === undefined || span < 0 ? {} : { durationMs: span }) }
}

const RUNNING_LABEL: Readonly<Record<ProcessActivity, string>> = {
  read: 'Reading files',
  readImage: 'Reading images',
  write: 'Writing files',
  search: 'Searching code',
  edit: 'Editing files',
  commands: 'Running commands',
  code: 'Running code',
  webSearch: 'Searching the web',
  webFetch: 'Visiting web pages',
  subagents: 'Coordinating subagents',
  plan: 'Updating the plan',
  questions: 'Waiting for your action',
  tools: 'Calling tools',
}

const PREPARING_LABEL: Readonly<Record<ProcessActivity, string>> = {
  read: 'Preparing to read files',
  readImage: 'Preparing to read images',
  write: 'Preparing to write files',
  search: 'Preparing to search code',
  edit: 'Preparing to edit files',
  commands: 'Preparing to run commands',
  code: 'Preparing to run code',
  webSearch: 'Preparing to search the web',
  webFetch: 'Preparing to visit web pages',
  subagents: 'Preparing to coordinate subagents',
  plan: 'Preparing to update the plan',
  questions: 'Preparing questions',
  tools: 'Preparing tool calls',
}

/**
 * The activity row's present-tense labels (identity English keys) plus
 * Chinese copy, taken from the upstream Chat locale.
 */
export const PROCESS_ACTIVE_ZH: Readonly<Record<string, string>> = {
  'Reading files': '正在读取文件',
  'Reading images': '正在读取图片',
  'Writing files': '正在写入文件',
  'Searching code': '正在搜索代码',
  'Editing files': '正在编辑文件',
  'Running commands': '正在运行命令',
  'Running code': '正在运行代码',
  'Searching the web': '正在搜索网页',
  'Visiting web pages': '正在访问网页',
  'Coordinating subagents': '正在协调子智能体',
  'Updating the plan': '正在更新计划',
  'Waiting for your action': '等待你的操作',
  'Calling tools': '正在调用工具',
  'Preparing to read files': '准备读取文件',
  'Preparing to read images': '准备读取图片',
  'Preparing to write files': '准备写入文件',
  'Preparing to search code': '准备搜索代码',
  'Preparing to edit files': '准备编辑文件',
  'Preparing to run commands': '准备运行命令',
  'Preparing to run code': '准备运行代码',
  'Preparing to search the web': '准备搜索网页',
  'Preparing to visit web pages': '准备访问网页',
  'Preparing to coordinate subagents': '准备协调子智能体',
  'Preparing to update the plan': '准备更新计划',
  'Preparing questions': '准备提问',
  'Preparing tool calls': '准备调用工具',
}

/**
 * What a folded group says of one category: a count phrase, one form for a single call and one for several (identity
 * English keys). Searches, code runs, web searches, and plan updates name no object, so their phrase counts the times.
 */
const COUNT_PHRASE: Readonly<Record<ProcessActivity, readonly [one: string, many: string]>> = {
  read: ['Read {count} file', 'Read {count} files'],
  readImage: ['Read {count} image', 'Read {count} images'],
  write: ['Wrote {count} file', 'Wrote {count} files'],
  search: ['Searched code', 'Searched code {count} times'],
  edit: ['Edited {count} file', 'Edited {count} files'],
  commands: ['Ran {count} command', 'Ran {count} commands'],
  code: ['Ran code', 'Ran code {count} times'],
  webSearch: ['Searched the web', 'Searched the web {count} times'],
  webFetch: ['Visited {count} web page', 'Visited {count} web pages'],
  subagents: ['Coordinated {count} subagent', 'Coordinated {count} subagents'],
  plan: ['Updated the plan', 'Updated the plan {count} times'],
  questions: ['Asked {count} question', 'Asked {count} questions'],
  tools: ['Called {count} tool', 'Called {count} tools'],
}

/** Chinese copy of the folded group phrases and the outcomes a call line shows. */
export const PROCESS_DONE_ZH: Readonly<Record<string, string>> = {
  'Read {count} file': '读取了 {count} 个文件',
  'Read {count} files': '读取了 {count} 个文件',
  'Read {count} image': '读取了 {count} 张图片',
  'Read {count} images': '读取了 {count} 张图片',
  'Wrote {count} file': '写入了 {count} 个文件',
  'Wrote {count} files': '写入了 {count} 个文件',
  'Searched code': '搜索了代码',
  'Searched code {count} times': '搜索了 {count} 次代码',
  'Edited {count} file': '修改了 {count} 个文件',
  'Edited {count} files': '修改了 {count} 个文件',
  'Ran {count} command': '执行了 {count} 条命令',
  'Ran {count} commands': '执行了 {count} 条命令',
  'Ran code': '运行了代码',
  'Ran code {count} times': '运行了 {count} 次代码',
  'Searched the web': '搜索了网页',
  'Searched the web {count} times': '搜索了 {count} 次网页',
  'Visited {count} web page': '访问了 {count} 个网页',
  'Visited {count} web pages': '访问了 {count} 个网页',
  'Coordinated {count} subagent': '协调了 {count} 个子智能体',
  'Coordinated {count} subagents': '协调了 {count} 个子智能体',
  'Updated the plan': '更新了计划',
  'Updated the plan {count} times': '更新了 {count} 次计划',
  'Asked {count} question': '提出了 {count} 个问题',
  'Asked {count} questions': '提出了 {count} 个问题',
  'Called {count} tool': '调用了 {count} 个工具',
  'Called {count} tools': '调用了 {count} 个工具',
  '… +{count} more': '… 还有 {count} 项',
  '… +{count} earlier': '… 前面还有 {count} 项',
  ' · Ctrl+O': ' · 按 Ctrl+O',
  '{count} line': '{count} 行',
  '{count} lines': '{count} 行',
  '{shown} of {total} lines': '{total} 行中的 {shown} 行',
  '{count} file': '{count} 个文件',
  '{count} files': '{count} 个文件',
  '{matches} in {files}': '{matches}，分布在 {files}',
  'no matches': '无匹配',
  '{count} path': '{count} 个路径',
  '{count} paths': '{count} 个路径',
  '{count} source': '{count} 个来源',
  '{count} sources': '{count} 个来源',
  'exit {code}': '退出码 {code}',
  'signal {signal}': '信号 {signal}',
}

/**
 * A call's or a group's wall time as a line shows it: `4.2s` under ten seconds, then the compact form; nothing under a
 * tenth of a second, where the number says nothing.
 * @param ms - the elapsed milliseconds.
 * @returns the text, or `undefined` when too short to report.
 */
export function elapsedText(ms: number): string | undefined {
  if (!(ms >= 100)) return undefined
  if (ms < 10_000) return `${String(Math.round(ms / 100) / 10)}s`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${String(seconds)}s`
  return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`
}

/**
 * The present-tense label of one running category (an English locale key).
 * @param activity - the running call's category.
 * @returns the untranslated label.
 */
export function runningLabel(activity: ProcessActivity): string {
  return RUNNING_LABEL[activity]
}

/**
 * The present-tense label of one category whose call is still streaming its
 * arguments (an English locale key).
 * @param activity - the preparing call's category.
 * @returns the untranslated label.
 */
export function preparingLabel(activity: ProcessActivity): string {
  return PREPARING_LABEL[activity]
}

/**
 * What a run of calls of one category says of itself: `Read 3 files`, `Searched code 3 times`.
 * @param activity - the calls' category.
 * @param count - how many calls.
 * @param t - translator for the transcript namespace.
 * @returns the translated phrase.
 */
export function countPhrase(activity: ProcessActivity, count: number, t: MayflyTranslate): string {
  return t(COUNT_PHRASE[activity][count === 1 ? 0 : 1], { count })
}

/**
 * The title of one folded process group: a count phrase for each of its top three categories, joined by ` · `, and the
 * wall time of its settled calls.
 * @param summary - the summary of the group's settled members.
 * @param t - translator for the transcript namespace.
 * @returns the title text, or `''` when nothing has settled.
 */
export function processTitle(summary: ProcessSummary, t: MayflyTranslate): string {
  if (summary.counts.length === 0) return ''
  const shown = summary.counts.slice(0, 3).map(({ activity, count }) => countPhrase(activity, count, t))
  const more = summary.counts.length > 3 ? ['…'] : []
  const time = summary.durationMs === undefined ? undefined : elapsedText(summary.durationMs)
  return [...shown, ...more, ...(time === undefined ? [] : [time])].join(' · ')
}
