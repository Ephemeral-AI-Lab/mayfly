/**
 * Transcript-owned locale catalogs and lifecycle helpers. Each sub-surface
 * owns its namespace so optional bundle rows can load and unload without a
 * hidden dependency on the transcript root.
 *
 * @module @ephemeral-ai/mayfly/transcript/locale
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  interpolateLocaleMessage,
  type MayflyLocaleCatalog,
  type MayflyLocaleSnapshot,
  type MayflyTranslate,
} from '../frontend/index.ts'
import { HINTS_ZH } from './hints.ts'
import { PROCESS_ACTIVE_ZH, PROCESS_DONE_ZH, SHARED_DONE_PREFIX_KEY } from './process-activity.ts'

const identityCatalog = (zh: Readonly<Record<string, string>>): MayflyLocaleCatalog => Object.freeze({
  en: Object.freeze(Object.fromEntries(Object.keys(zh).map(key => [key, key]))),
  zh: Object.freeze(zh),
})

/** Welcome-banner copy. */
export const BANNER_LOCALE = identityCatalog({
  'Send /help for help information.': '输入 /help 查看帮助信息。',
  'Directory: ': '目录：     ',
  'Model:     ': '模型：     ',
  'Version:   ': '版本：     ',
})

/** Transcript renderer chrome, work-details rows, and fold hints. */
const TRANSCRIPT_MESSAGES = identityCatalog({
  'Toggle detail expansion (tool output, long messages)': '切换详细内容展开状态（工具输出、长消息）',
  '[image]': '[图片]',
  '■ interrupted': '■ 已中断',
  ...HINTS_ZH,
  ...PROCESS_ACTIVE_ZH,
  ...PROCESS_DONE_ZH,
  'Deep diving...': '深度求索中',
  'Deep diving for {duration}': '深度求索中，用时{duration}',
  'Took {duration}': '用时 {duration}',
  'Stopped': '已停止',
  'Failed': '处理失败',
  'Worked': '已完成工作',
  '{count} tool call': '{count} 次工具调用',
  '{count} tool calls': '{count} 次工具调用',
  '{count} subagent': '{count} 个 subagent',
  '{count} subagents': '{count} 个 subagent',
  '{count} failed': '{count} 个失败',
  'ctrl+o to expand': '按 Ctrl-O 展开',
  'Thought for a while': '已思考',
  'Thought for {duration}': '已思考 {duration}',
  'Preparing {name} · {count} chars': '准备 {name} · {count} 字符',
  'cancelled': '已取消',
  'running': '运行中',
  'waiting for your answer': '等待你的回答',
  '{count} source': '{count} 个来源',
  '{count} sources': '{count} 个来源',
  'truncated': '已截断',
  'Fetching': '正在访问',
  'Fetched': '已访问',
  'Message to {to}': '发送给 {to}',
  '{done}/{total} done': '已完成 {done}/{total}',
  '(no output)': '（无输出）',
  'compacting context…': '正在压缩上下文…',
  'compacted': '已压缩',
  'compacted {count} items': '已压缩 {count} 条历史',
  'compaction failed': '压缩失败',
  ' · auto': ' · 自动',
  // Group headers, error rows, panes, and the subagent panel (issue #63).
  'Running a command': '正在运行命令',
  'Ran a command': '已运行命令',
  'Using': '正在使用',
  'Used': '已使用',
  '{count} line': '{count} 行',
  '{count} lines': '{count} 行',
  ' · plan declined': ' · 计划被拒绝',
  '✗ request failed ({code}): {message}': '✗ 请求失败（{code}）：{message}',
  '✗ request failed: {message}': '✗ 请求失败：{message}',
  'Reading {count} files…': '正在读取 {count} 个文件…',
  'Reading {count} file…': '正在读取 {count} 个文件…',
  'Read {count} files': '已读取 {count} 个文件',
  'Read {count} file': '已读取 {count} 个文件',
  'Read {count} files · failed': '已读取 {count} 个文件 · 失败',
  'Read {count} file · failed': '已读取 {count} 个文件 · 失败',
  '{count} reads': '{count} 次读取',
  'Searching {count} patterns…': '正在搜索 {count} 个模式…',
  'Searching {count} pattern…': '正在搜索 {count} 个模式…',
  'Searched {count} patterns': '已搜索 {count} 个模式',
  'Searched {count} pattern': '已搜索 {count} 个模式',
  'Searched {count} patterns · failed': '已搜索 {count} 个模式 · 失败',
  'Searched {count} pattern · failed': '已搜索 {count} 个模式 · 失败',
  '{count} files': '{count} 个文件',
  '{count} file': '{count} 个文件',
  '{count} matches': '{count} 个匹配',
  '{count} match': '{count} 个匹配',
  '{count} paths': '{count} 个路径',
  '{count} path': '{count} 个路径',
  'Running {count} commands…': '正在运行 {count} 条命令…',
  'Running {count} command…': '正在运行 {count} 条命令…',
  'Ran {count} commands': '已运行 {count} 条命令',
  'Ran {count} command': '已运行 {count} 条命令',
  'Ran {count} commands · failed': '已运行 {count} 条命令 · 失败',
  'Ran {count} command · failed': '已运行 {count} 条命令 · 失败',
  'Running {count} agents': '正在运行 {count} 个子代理',
  'Running {count} agent': '正在运行 {count} 个子代理',
  '{count} agents finished': '{count} 个子代理已完成',
  '{count} agent finished': '{count} 个子代理已完成',
  '  Todo': '  待办',
  ' · interrupted': ' · 已中断',
  'blocked: ': '受阻：',
  '  all {count} items · {key} to collapse': '  全部 {count} 项 · 按 {key} 收起',
  '  … +{count} more ({counts}) · {key} to expand': '  … 还有 {count} 项（{counts}） · 按 {key} 展开',
  'phase {current}/{total}': '阶段 {current}/{total}',
  '{count} running': '{count} 个运行中',
  'Workflow {name}': '工作流 {name}',
  'agent #{seq}': '代理 #{seq}',
  '{reason} · {count} agents · {elapsed}': '{reason} · {count} 个子代理 · {elapsed}',
  '{reason} · {count} agent · {elapsed}': '{reason} · {count} 个子代理 · {elapsed}',
  'Subagent · {label}': '子代理 · {label}',
  'continuable · i to reply': '可继续 · 按 i 回复',
  'one-shot · read-only': '一次性 · 只读',
  'the session controller is unavailable': '会话控制器不可用',
  'the stored subagent conversation is unavailable': '已存储的子代理对话不可用',
  'could not read the subagent conversation: {error}': '无法读取子代理对话：{error}',
  'conversation unavailable': '对话不可用',
  'Goal {phase} · {rounds}/{total} · {activation}': '目标 {phase} · {rounds}/{total} · {activation}',
  'active': '进行中',
  'paused': '已暂停',
  'blocked': '受阻',
  'complete': '已完成',
  'armed': '已启用',
  'disarmed': '已停用',
  '⏵ 1 job': '⏵ 1 个任务',
  '⏵ {count} jobs': '⏵ {count} 个任务',
})

/**
 * The transcript catalog. The joined-title shared prefix is the one message
 * whose English is empty (Chinese strips a repeated `已`), so it is added
 * beside the identity entries.
 */
export const TRANSCRIPT_LOCALE: MayflyLocaleCatalog = Object.freeze({
  en: Object.freeze({ ...TRANSCRIPT_MESSAGES.en, [SHARED_DONE_PREFIX_KEY]: '' }),
  zh: Object.freeze({ ...TRANSCRIPT_MESSAGES.zh, [SHARED_DONE_PREFIX_KEY]: '已' }),
})

/** Activity-pane copy: phase labels plus the running and preparing process labels. */
export const ACTIVITY_LOCALE = identityCatalog({
  ' · Tip: ': ' · 提示：',
  'Deep diving': '深度求索中',
  'Thinking': '思考中',
  'Writing': '输出中',
  ' interrupting...': ' 正在中断...',
  ...PROCESS_ACTIVE_ZH,
})

/**
 * Register one catalog whenever a locale provider is active.
 * @param ctx - frontend-tree context.
 * @param namespace - package-owned namespace.
 * @param catalog - localized messages.
 */
export function mountTranscriptLocale(ctx: Context, namespace: string, catalog: MayflyLocaleCatalog): void {
  ctx.inject(['mayflyLocale'], (localeCtx) => {
    localeCtx.effect(() => localeCtx.mayflyLocale.register(namespace, catalog))
  })
}

/**
 * Resolve the current locale service for every translation call.
 * @param ctx - frontend-tree context.
 * @param namespace - package-owned namespace.
 * @returns dynamic translator with interpolated English fallback.
 */
export function transcriptTranslator(ctx: Context, namespace: string): MayflyTranslate {
  return (key, values) => ctx.get('mayflyLocale')?.translate(namespace, key, values)
    ?? interpolateLocaleMessage(key, values)
}

/**
 * Observe locale revisions across provider activation, unload, and reload.
 * An undefined snapshot marks the provider gap where translators fall back
 * to English.
 * @param ctx - owner context.
 * @param listener - presentation invalidation callback.
 * @returns synchronous subscription disposer.
 */
export function observeTranscriptLocale(
  ctx: Context,
  listener: (snapshot: MayflyLocaleSnapshot | undefined) => void,
): () => void {
  let disposed = false
  let offCurrent: () => void = () => {}
  const current = ctx.get('mayflyLocale')
  if (current !== undefined) offCurrent = current.subscribe(listener)
  const fiber = ctx.inject(['mayflyLocale'], (localeCtx) => {
    /* v8 ignore next -- disposing the injected Fiber prevents late activation; this is a defensive fence. */
    if (disposed) return
    offCurrent()
    const off = localeCtx.mayflyLocale.subscribe(listener)
    offCurrent = off
    localeCtx.effect(() => () => {
      off()
      /* v8 ignore next -- Cordis forbids overlapping providers and serializes unload before replacement activation. */
      if (offCurrent !== off) return
      offCurrent = () => {}
      if (!disposed) listener(undefined)
    })
  })
  return () => {
    if (disposed) return
    disposed = true
    offCurrent()
    void fiber.dispose()
  }
}
