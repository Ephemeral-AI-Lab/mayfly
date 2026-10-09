/**
 * Core-private locale catalog for interaction strings the compiler and the
 * frontend interaction model own; plugin authors never provide this copy.
 *
 * @module @ephemeral-ai/mayfly/core/context-hint-locale
 */

import type { Context } from '@deepseek-ai/cordis'
import { interpolateLocaleMessage, type MayflyLocaleCatalog, type MayflyTranslate } from '../frontend/locale.ts'
import { mountCommonLocale } from '../frontend/common-locale.ts'

const zh = Object.freeze({
  // Contextual hint labels and key words specific to the core compiler.
  // Shared vocabulary (tabs/actions/choose/toggle/…, Yes/No) lives in `common`.
  Type: '输入',
  focus: '定位',
  open: '打开',
  'No/Yes': '否/是',
  branch: '展开/折叠',
  pick: '选择',
  step: '步进',
  continue: '继续',
  complete: '补全',
  next: '下一项',
  cancel: '取消',
  done: '完成编辑',
  'end search': '结束搜索',
  clear: '清除',
  filter: '筛选',
  expand: '展开',
  collapse: '收起',
  'use inherited': '改用继承值',
  'use default': '改用默认值',
  restore: '恢复',
  Options: '选项',
  '{count} match': '{count} 项匹配',
  '{count} matches': '{count} 项匹配',
  '↑ {above} more · ↓ {below} more': '↑ 还有 {above} 项 · ↓ 还有 {below} 项',
  '▸ {count} more lines · Enter': '▸ 还有 {count} 行 · Enter',
  reset: '重置',
  'ready in a moment': '稍候即可操作',
  // The prompt: the recall position in its corner (`↑ history 2/4`) and the words of its hint row.
  history: '历史',
  queued: '排队中',
  send: '发送',
  insert: '插入',
  // Field provenance and conflict resolution.
  inherited: '继承',
  override: '显式覆盖',
  saved: '已保存',
  'not set': '未设置',
  empty: '空',
  'unsaved changes': '有未保存的修改',
  'Use current value': '使用当前值',
  'Keep my changes': '保留我的修改',
  // Shared decisions, placeholders, and default controls.
  'Discard unsaved changes?': '放弃未保存的修改？',
  'No matches': '无匹配项',
  'Choose…': '请选择…',
  'None selected': '未选择',
  Submit: '提交',
  Cancel: '取消',
  Save: '保存',
  // Validation and operation feedback.
  'Resolve the changed value before saving': '保存前请先处理已变更的值',
  'A value is required': '此项为必填',
  Required: '必填',
  'Invalid value': '值无效',
  'Fix the highlighted fields': '请修正标出的字段',
  'Enter a finite number': '请输入有限数值',
  'Minimum: {value}': '最小值：{value}',
  'Maximum: {value}': '最大值：{value}',
  'Step: {value}': '步长：{value}',
  'Minimum length: {value}': '最短长度：{value}',
  'Maximum length: {value}': '最大长度：{value}',
  'A selected option is unavailable': '所选选项不可用',
  'Select at least {count} options': '请至少选择 {count} 项',
  'Select at most {count} options': '最多只能选择 {count} 项',
  'A submitted form is unavailable or invalid': '提交的表单不可用或无效',
  'A selection is no longer available': '所选项已不可用',
  'The destination page is unavailable': '目标页面不可用',
  'The action completed, but newer data must be reviewed': '操作已完成，但需要查看更新的数据',
  'The action completed, but its result could not be displayed': '操作已完成，但无法显示结果',
  'The action could not be completed': '操作未能完成',
  'This surface could not be displayed': '无法显示此界面',
})

const en = Object.freeze(Object.fromEntries(Object.keys(zh).map(key => [key, key])))

/** Core-owned catalog for interaction strings: hint labels, shared decisions, placeholders, and validation. */
export const CORE_CONTEXT_HINT_LOCALE: MayflyLocaleCatalog = Object.freeze({ en, zh })

/** How many translated strings a translator remembers for one locale revision. */
export const HINT_MEMO_ENTRIES = 512

/**
 * Resolve contextual operation labels against the current locale provider.
 * @param ctx - frontend-tree context.
 * @returns dynamic translator with an English-key fallback.
 */
export function contextHintTranslator(ctx: Context): MayflyTranslate {
  const lookup: MayflyTranslate = (key, values) => ctx.get('mayflyLocale')?.translate('core-context-hints', key, values)
    ?? interpolateLocaleMessage(key, values)
  // Painters translate the same few strings on every row, and a catalog changes only with the locale provider or its
  // revision. While a provider is mounted each string is resolved once; every revision and every provider lifetime
  // starts a fresh memo, and without a provider nothing is remembered.
  let messages: Map<string, string> | undefined
  ctx.inject(['mayflyLocale'], (localeCtx) => {
    const unsubscribe = localeCtx.mayflyLocale.subscribe(() => { messages = new Map() })
    localeCtx.effect(() => () => {
      unsubscribe()
      messages = undefined
    })
  })
  return (key, values) => {
    if (messages === undefined) return lookup(key, values)
    const id = values === undefined ? key : `${key}\0${JSON.stringify(values)}`
    let message = messages.get(id)
    if (message === undefined) {
      message = lookup(key, values)
      // Interpolated counts are unbounded; a full memo starts over rather than grow.
      if (messages.size >= HINT_MEMO_ENTRIES) messages.clear()
      messages.set(id, message)
    }
    return message
  }
}

/**
 * Register the private catalog for each locale-provider lifetime.
 * @param ctx - core owner context.
 * @param onChange - terminal repaint requested on locale/catalog changes.
 */
export function mountContextHintLocale(ctx: Context, onChange: () => void): void {
  mountCommonLocale(ctx)
  ctx.inject(['mayflyLocale'], (localeCtx) => {
    const unregister = localeCtx.mayflyLocale.register('core-context-hints', CORE_CONTEXT_HINT_LOCALE)
    const unsubscribe = localeCtx.mayflyLocale.subscribe(onChange)
    localeCtx.effect(() => () => {
      unsubscribe()
      unregister()
    })
  })
}
