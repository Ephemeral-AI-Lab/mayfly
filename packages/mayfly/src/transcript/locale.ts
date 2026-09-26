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
import { PROCESS_TITLE_ZH, SHARED_DONE_PREFIX_KEY } from './process-activity.ts'

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
  ...PROCESS_TITLE_ZH,
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
  'Thinking': '思考中',
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

/** Activity-pane copy. */
export const ACTIVITY_LOCALE = identityCatalog({
  ' · Tip: ': ' · 提示：',
  ' working...': ' 工作中...',
  ' thinking...': ' 思考中...',
  ' interrupting...': ' 正在中断...',
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
