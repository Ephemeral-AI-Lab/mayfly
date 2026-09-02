/**
 * Core-private locale catalog for contextual operation labels. The compiler
 * owns the keys; plugin authors and public UI nodes never provide this copy.
 *
 * @module @ephemeral-ai/mayfly/core/context-hint-locale
 */

import type { Context } from '@deepseek-ai/cordis'
import { interpolateLocaleMessage, type MayflyLocaleCatalog, type MayflyTranslate } from '../frontend/index.ts'

const zh = Object.freeze({
  tabs: '标签',
  actions: '操作',
  options: '选项',
  fields: '字段',
  groups: '分组',
  switch: '切换',
  choose: '选择',
  toggle: '切换',
  run: '执行',
  edit: '编辑',
  adjust: '调整',
  finish: '完成',
  apply: '应用',
  submit: '提交',
  confirm: '确认',
  cancel: '取消',
  close: '关闭',
  leave: '退出编辑',
  newline: '换行',
})

const en = Object.freeze(Object.fromEntries(Object.keys(zh).map(key => [key, key])))

/** Core-owned contextual operation catalog. */
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
