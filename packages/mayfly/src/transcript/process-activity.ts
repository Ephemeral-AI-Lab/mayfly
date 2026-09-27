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
import type { MayflyTranslate, ProcessActivity } from '../frontend/index.ts'

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
}

/** Ranked category counts and failures of one process group's settled members. */
export interface ProcessSummary {
  readonly counts: readonly { readonly activity: ProcessActivity, readonly count: number }[]
  readonly failed: number
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
  return { counts: ranked, failed }
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

const DONE_LABEL: Readonly<Record<ProcessActivity, string>> = {
  read: 'Read files',
  readImage: 'Read images',
  write: 'Wrote files',
  search: 'Searched code',
  edit: 'Edited files',
  commands: 'Ran commands',
  code: 'Ran code',
  webSearch: 'Searched the web',
  webFetch: 'Visited web pages',
  subagents: 'Coordinated subagents',
  plan: 'Updated the plan',
  questions: 'Asked questions',
  tools: 'Called tools',
}

/** Locale key of the prefix shared by joined done labels (`已` in Chinese, empty in English). */
export const SHARED_DONE_PREFIX_KEY = 'process.shared-done-prefix'

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
 * The transcript's past-tense group titles and their joiners (identity
 * English keys) plus Chinese copy, taken from the upstream Chat locale.
 */
export const PROCESS_DONE_ZH: Readonly<Record<string, string>> = {
  'Read files': '已读取文件',
  'Read images': '已读取图片',
  'Wrote files': '已写入文件',
  'Searched code': '已搜索代码',
  'Edited files': '修改了文件',
  'Ran commands': '执行了命令',
  'Ran code': '运行了代码',
  'Searched the web': '已搜索网页',
  'Visited web pages': '已访问网页',
  'Coordinated subagents': '已协调子智能体',
  'Updated the plan': '更新了计划',
  'Asked questions': '向用户提出了问题',
  'Called tools': '已调用工具',
  '{first} and {second}': '{first}并{second}',
  ', ': '，',
  '{title}, etc.': '{title}等',
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
 * The localized past-tense title of one process group: its top three
 * categories' done labels, joined.
 * @param summary - the summary of the group's settled members.
 * @param t - translator for the transcript namespace.
 * @returns the title text, or `''` when nothing has settled.
 */
export function processTitle(summary: ProcessSummary, t: MayflyTranslate): string {
  const labels = summary.counts.slice(0, 3).map(({ activity }) => t(DONE_LABEL[activity]))
  const first = labels[0]
  if (first === undefined) return ''
  const second = labels[1]
  if (second === undefined) return first
  const continuation = (label: string): string => label.charAt(0).toLowerCase() + label.slice(1)
  if (labels.length === 2) {
    const translated = t(SHARED_DONE_PREFIX_KEY)
    const prefix = translated === SHARED_DONE_PREFIX_KEY ? '' : translated
    const trimmed = prefix !== '' && first.startsWith(prefix) && second.startsWith(prefix) ? second.slice(prefix.length) : second
    return t('{first} and {second}', { first, second: continuation(trimmed) })
  }
  const title = [first, ...labels.slice(1).map(continuation)].join(t(', '))
  return summary.counts.length > 3 ? t('{title}, etc.', { title }) : title
}
