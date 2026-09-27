/**
 * Core-private locale catalog for interaction strings the compiler and the
 * frontend interaction model own; plugin authors never provide this copy.
 *
 * @module @ephemeral-ai/mayfly/core/context-hint-locale
 */

import type { Context } from '@deepseek-ai/cordis'
import { interpolateLocaleMessage, type MayflyLocaleCatalog, type MayflyTranslate } from '../frontend/locale.ts'

const zh = Object.freeze({
  // Contextual hint labels and key words.
  Type: '输入',
  tabs: '标签',
  actions: '操作',
  options: '选项',
  fields: '字段',
  groups: '分组',
  choose: '选择',
  focus: '定位',
  open: '打开',
  toggle: '切换',
  'toggle / confirm': '切换 / 确认',
  branch: '展开/折叠',
  run: '执行',
  edit: '编辑',
  adjust: '调整',
  pick: '选择',
  apply: '应用',
  submit: '提交',
  next: '下一项',
  newline: '换行',
  confirm: '确认',
  cancel: '取消',
  done: '完成编辑',
  'end search': '结束搜索',
  back: '返回',
  close: '关闭',
  leave: '离开',
  clear: '清除',
  filter: '筛选',
  scroll: '滚动',
  expand: '展开',
  collapse: '收起',
  'use inherited': '改用继承值',
  reset: '重置',
  // Field provenance and conflict resolution.
  Inherited: '继承',
  Override: '显式覆盖',
  'Use current value': '使用当前值',
  'Keep my changes': '保留我的修改',
  // Shared decisions, placeholders, and default controls.
  'Discard unsaved changes?': '放弃未保存的修改？',
  No: '否',
  Yes: '是',
  'No matches': '无匹配项',
  'Choose…': '请选择…',
  'None selected': '未选择',
  Submit: '提交',
  Cancel: '取消',
  // Validation and operation feedback.
  'Resolve the changed value before saving': '保存前请先处理已变更的值',
  'A value is required': '此项为必填',
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
})

const en = Object.freeze(Object.fromEntries(Object.keys(zh).map(key => [key, key])))

/** Core-owned catalog for interaction strings: hint labels, shared decisions, placeholders, and validation. */
export const CORE_CONTEXT_HINT_LOCALE: MayflyLocaleCatalog = Object.freeze({ en, zh })

/**
 * Resolve contextual operation labels against the current locale provider.
 * @param ctx - frontend-tree context.
 * @returns dynamic translator with an English-key fallback.
 */
export function contextHintTranslator(ctx: Context): MayflyTranslate {
  return (key, values) => ctx.get('mayflyLocale')?.translate('core-context-hints', key, values)
    ?? interpolateLocaleMessage(key, values)
}

/**
 * Register the private catalog for each locale-provider lifetime.
 * @param ctx - core owner context.
 * @param onChange - terminal repaint requested on locale/catalog changes.
 */
export function mountContextHintLocale(ctx: Context, onChange: () => void): void {
  ctx.inject(['mayflyLocale'], (localeCtx) => {
    const unregister = localeCtx.mayflyLocale.register('core-context-hints', CORE_CONTEXT_HINT_LOCALE)
    const unsubscribe = localeCtx.mayflyLocale.subscribe(onChange)
    localeCtx.effect(() => () => {
      unsubscribe()
      unregister()
    })
  })
}
