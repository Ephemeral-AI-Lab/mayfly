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
  /** Whether the call was cancelled (stopped by the user, or never started): neither a success nor a failure. */
  readonly interrupted?: boolean
  /** Producer times of the call, for the wall time a group title reports. */
  readonly startedAt?: number
  readonly endedAt?: number
  /** Lines a file change added and removed, for the diffstat a title reports. */
  readonly added?: number
  readonly removed?: number
}

/** Ranked category counts and failures of one process group's settled members. */
export interface ProcessSummary {
  readonly counts: readonly { readonly activity: ProcessActivity, readonly count: number }[]
  readonly failed: number
  /** Members cancelled by an interruption, which are not counted as failed. */
  readonly interrupted: number
  /** Wall time from the first member's start to the last member's end, when every settled member has both. */
  readonly durationMs?: number
  /** Lines the members' file changes added and removed, when any made one. */
  readonly added?: number
  readonly removed?: number
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
  let interrupted = 0
  let added = 0
  let removed = 0
  let changed = false
  for (const member of members) {
    counts.set(member.activity, (counts.get(member.activity) ?? 0) + 1)
    if (member.failed === true) failed += 1
    if (member.interrupted === true) interrupted += 1
    if (member.added !== undefined) {
      changed = true
      added += member.added
      removed += member.removed ?? 0
    }
  }
  const ranked = [...counts].map(([activity, count]) => ({ activity, count })).sort((a, b) => b.count - a.count)
  const starts = members.flatMap(member => member.startedAt === undefined ? [] : [member.startedAt])
  const ends = members.flatMap(member => member.endedAt === undefined ? [] : [member.endedAt])
  const span = starts.length === 0 || ends.length === 0 ? undefined : Math.max(...ends) - Math.min(...starts)
  return { counts: ranked, failed, interrupted, ...(span === undefined || span < 0 ? {} : { durationMs: span }), ...(changed ? { added, removed } : {}) }
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

/** Chinese copy of the folded group phrases and the outcomes a call line shows. */
export const PROCESS_DONE_ZH: Readonly<Record<string, string>> = {
  '… +{count} more': '… 还有 {count} 项',
  '… +{count} rows': '… 还有 {count} 行',
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
  '{count} image': '{count} 张图片',
  '{count} images': '{count} 张图片',
  '{count} search': '{count} 次搜索',
  '{count} searches': '{count} 次搜索',
  '{count} call': '{count} 次调用',
  '{count} calls': '{count} 次调用',
  '{count} run': '{count} 次运行',
  '{count} runs': '{count} 次运行',
  '{count} page': '{count} 个网页',
  '{count} pages': '{count} 个网页',
  '{count} subagent': '{count} 个子智能体',
  '{count} subagents': '{count} 个子智能体',
  '{count} update': '{count} 次更新',
  '{count} updates': '{count} 次更新',
  '{count} question': '{count} 个问题',
  '{count} questions': '{count} 个问题',
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
 * The diffstat of a change as a line shows it: `+4 −2`.
 * @param added - lines added.
 * @param removed - lines removed.
 * @returns the text.
 */
export function diffStat(added: number, removed: number): string {
  return `+${String(added)} −${String(removed)}`
}
