/**
 * Transcript-owned locale catalogs and lifecycle helpers. Each sub-surface
 * owns its namespace so optional bundle rows can load and unload without a
 * hidden dependency on the transcript root.
 *
 * @module @ephemeral-ai/mayfly/transcript/locale
 */

import type { Context } from '@deepseek-ai/cordis'
import { interpolateLocaleMessage, type MayflyLocaleCatalog, type MayflyLocaleSnapshot, type MayflyTranslate } from '../frontend/locale.ts'
import { PROCESS_ACTIVE_ZH, PROCESS_DONE_ZH } from './process-activity.ts'

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
  '⚠ deletes files': '⚠ 将删除文件',
  'waiting': '等待中',
  'allowed': '已允许',
  'rejected': '已拒绝',
  'interrupted': '已中断',
  'not started': '未开始',
  'outcome unknown': '结果未知',
  'Plan ready for review': '计划待评审',
  'Plan approved': '计划已批准',
  'Plan rejected': '计划已拒绝',
  'Plan sent back': '计划已退回',
  '{count} step': '{count} 步',
  '{count} steps': '{count} 步',
  '{index} of {total} waiting': '第 {index} 个，共 {total} 个等待',
  '⏎ queued': '⏎ 排队中',
  '⏎ steering': '⏎ 引导中',
  '↑ history {index}/{total}': '↑ 历史 {index}/{total}',
  ...PROCESS_ACTIVE_ZH,
  ...PROCESS_DONE_ZH,
  'Deep diving...': '深度求索中',
  'Worked for {duration} · done {time}': '工作了 {duration} · 完成于 {time}',
  'Stopped after {duration} · done {time}': '运行 {duration} 后停止 · {time}',
  'Failed after {duration} · done {time}': '运行 {duration} 后失败 · {time}',
  'Stopped': '已停止',
  'Failed': '处理失败',
  'Worked': '已完成工作',
  '{count} tool call': '{count} 次工具调用',
  '{count} tool calls': '{count} 次工具调用',
  '{count} subagent': '{count} 个 subagent',
  '{count} subagents': '{count} 个 subagent',
  '{count} failed': '{count} 个失败',
  '{count} interrupted': '{count} 个已中断',
  'Ctrl+O to expand': '按 Ctrl+O 展开',
  'conversation': '对话',
  'view': '视图',
  'search': '搜索',
  'Copied {count} characters': '已复制 {count} 个字符',
  'Copied {count} characters of JSON': '已复制 {count} 个字符的 JSON',
  'Copied {count} characters of JSON (unverified)': '已通过终端转义序列复制 {count} 个字符的 JSON（未验证）',
  'Copied {count} characters (unverified)': '已通过终端转义序列复制 {count} 个字符（未验证）',
  'Could not copy': '无法复制',
  'The terminal is unavailable': '终端不可用',
  'no editor configured ($VISUAL/$EDITOR)': '未配置编辑器（$VISUAL/$EDITOR）',
  'The editor could not be opened': '无法打开编辑器',
  'cancelled': '已取消',
  'running': '运行中',
  'truncated': '已截断',
  'running in background': '后台运行中',
  'failed': '失败',
  'stopped': '已停止',
  'agents': '智能体',
  'stop': '停止',
  'Stop': '停止',
  'Stop this subagent?': '停止此子智能体？',
  'Its live Agent shuts down; the stored conversation stays browsable.': '它的运行中智能体会关闭；已保存的对话仍可浏览。',
  'The agent changed; open it again': '智能体已变化；请重新打开',
  'Select a subagent first': '请先选择一个子智能体',
  'This subagent cannot be opened': '无法打开此子智能体',
  'fg': '前台',
  'bg': '后台',
  'background': '转后台',
  'dsh cannot move a running subagent to the background yet': 'dsh 暂不支持把运行中的子智能体转到后台',
  'Already in the background': '已在后台运行',
  'Already finished': '已完成',
  'This subagent has not started yet': '此子智能体尚未启动',
  '{count} tool': '{count} 个工具',
  '{count} tools': '{count} 个工具',
  '(no output)': '（无输出）',
  'Compacting context': '正在压缩上下文',
  'summarizing': '生成摘要中',
  'applying': '应用摘要中',
  'context {from}% → {to}%': '上下文 {from}% → {to}%',
  'Compacted': '已压缩',
  'Compacted {count} items': '已压缩 {count} 条历史',
  'Compaction failed': '压缩失败',
  'Compaction failed: {reason}': '压缩失败：{reason}',
  'tokens': '词元',
  'auto': '自动',
  'Ctrl+O summary': 'Ctrl+O 查看摘要',
  '… +{count} more': '… 还有 {count} 行',
  // Group headers, error rows, panes, and the subagent panel (issue #63).
  '{count} matches': '{count} 个匹配',
  '{count} match': '{count} 个匹配',
  'Todo': '待办',
  'todo': '待办',
  'phase {current}/{total}': '阶段 {current}/{total}',
  '{count} running': '{count} 个运行中',
  'Workflow {name}': '工作流 {name}',
  'agent #{seq}': '代理 #{seq}',
  '{reason} · {count} agents · {elapsed}': '{reason} · {count} 个子代理 · {elapsed}',
  '{reason} · {count} agent · {elapsed}': '{reason} · {count} 个子代理 · {elapsed}',
  'loading conversation...': '正在加载对话...',
  'the session controller is unavailable': '会话控制器不可用',
  'the stored conversation is unavailable': '已存储的对话不可用',
  'could not read the conversation: {error}': '无法读取对话：{error}',
  'conversation unavailable': '对话不可用',
  'goal': '目标',
  'goal round {round}': '目标第 {round} 轮',
  'Goal set': '目标已设定',
  'Goal edited': '目标已修改',
  'Goal paused': '目标已暂停',
  'Goal resumed': '目标已继续',
  'Goal complete': '目标已完成',
  'Goal blocked': '目标受阻',
  'Goal cleared': '目标已清除',
  'main': '主会话',
  'btw': '旁问',
  'subagent': '子代理',
  'close': '关闭',
  'detach': '脱离',
  'Goal blocked · {code}: {message}': '目标受阻 · {code}：{message}',
  '1 round': '1 轮',
  '{count} rounds': '{count} 轮',
  'blocked · {code}': '受阻 · {code}',
  'resume': '继续',
  'pause': '暂停',
  'edit': '修改',
  'clear': '清除',
  'Clear': '清除',
  'Clear the goal?': '清除这个目标？',
  'Its history stays in the session log.': '它的历史仍保留在会话日志中。',
  'The prompt is not available': '输入框不可用',
  'The goal changed; open it again': '目标已变化，请重新打开',
  'Unknown goal action': '未知的目标操作',
  'active': '进行中',
  'paused': '已暂停',
  'blocked': '受阻',
  'complete': '已完成',
  'jobs': '任务',
  'stopping': '停止中',
  'Already stopping': '已在停止中',
  'Stop this job?': '停止此任务？',
  'The job is asked to end; its output stays readable.': '会请求任务结束；它的输出仍可查看。',
  'Select a job first': '请先选择一个任务',
  'Stopping {job}': '正在停止 {job}',
})

/** The transcript catalog. */
export const TRANSCRIPT_LOCALE: MayflyLocaleCatalog = TRANSCRIPT_MESSAGES

/** Activity-pane copy: phase labels plus the running and preparing process labels. */
export const ACTIVITY_LOCALE = identityCatalog({
  'Alt+↑ conversation · Alt+↓ view': 'Alt+↑ 选对话 · Alt+↓ 选视图',
  'Ctrl+Enter steer · Esc interrupt': 'Ctrl+Enter 引导 · Esc 中断',
  'Ctrl+C clear · Ctrl+G editor': 'Ctrl+C 清空 · Ctrl+G 编辑器',
  'Shift+Tab plan · Alt+M model': 'Shift+Tab 计划 · Alt+M 模型',
  '↑/↓ select': '↑/↓ 选择',
  '↑/↓ or n/N match': '↑/↓ 或 n/N 切换匹配',
  'e edit': 'e 编辑',
  's send now': 's 立即发送',
  'd cancel': 'd 取消',
  'Enter expand': 'Enter 展开',
  'c copy': 'c 复制',
  '/ ? search': '/ ? 搜索',
  '/ ? new search': '/ ? 新搜索',
  'Ctrl+G editor': 'Ctrl+G 编辑器',
  'Ctrl+C JSON': 'Ctrl+C 复制 JSON',
  'Esc back': 'Esc 返回',
  'Esc end search': 'Esc 结束搜索',
  'Invalid regular expression · Esc to cancel': '正则表达式无效 · Esc 取消',
  'Type a regular expression · Enter to select · Esc to cancel': '输入正则表达式 · Enter 选择 · Esc 取消',
  'No matches · Esc to cancel': '无匹配 · Esc 取消',
  '{total} matches · Enter to select · Esc to cancel': '{total} 个匹配 · Enter 选择 · Esc 取消',
  '{index}/{total} matches': '{index}/{total} 个匹配',
  '{index}/{total} match': '{index}/{total} 个匹配',
  '{total} match · Enter to select · Esc to cancel': '{total} 个匹配 · Enter 选择 · Esc 取消',
  'Tip: ': '提示：',
  'Deep diving': '深度求索中',
  'Pondering': '思索中',
  'Mulling': '琢磨中',
  'DeepThinking': '深度思考中',
  'Fathoming': '沉思中',
  'Writing': '输出中',
  'interrupting…': '正在中断…',
  'Waiting for your approval': '等待你的批准',
  'Waiting for your answer': '等待你的回答',
  'Running {count} tools': '正在运行 {count} 个工具',
  'Rate limited': '请求被限流',
  'Provider error': '服务商出错',
  'retrying in {seconds}s · {attempt}': '{seconds} 秒后重试 · {attempt}',
  'retrying {attempt}…': '正在重试 {attempt}…',
  'Context {percent}% full · /compact now': '上下文已用 {percent}% · 可立即 /compact',
  'Resumed session': '已恢复会话',
  '1 turn': '1 轮',
  '{count} turns': '{count} 轮',
  'last active {age}': '上次活动 {age}',
  'just now': '刚刚',
  '{count}m ago': '{count} 分钟前',
  '{count}h ago': '{count} 小时前',
  '{count}d ago': '{count} 天前',
  '+{count} more': '另有 {count} 项',
  'Preparing {count} tool calls': '准备 {count} 个工具调用',
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
    /* disposing the injected Fiber prevents late activation; this is a defensive fence. */
    if (disposed) return
    offCurrent()
    const off = localeCtx.mayflyLocale.subscribe(listener)
    offCurrent = off
    localeCtx.effect(() => () => {
      off()
      /* Cordis forbids overlapping providers and serializes unload before replacement activation. */
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
