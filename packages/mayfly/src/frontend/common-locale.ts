/**
 * Locale vocabulary shared across independently owned namespaces. Every
 * consumer registers it, so the `common` namespace lives while any surface
 * that needs it is mounted; the shared copy is the single source for hint
 * labels and shared decisions that would otherwise drift between catalogs.
 *
 * @module @ephemeral-ai/mayfly/frontend/common-locale
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MayflyLocaleCatalog } from './locale.ts'

const zh: Readonly<Record<string, string>> = {
  // Contextual hint vocabulary shared by the compiler and the interaction layer.
  'tabs': '标签',
  'actions': '操作',
  'options': '选项',
  'fields': '字段',
  'groups': '分组',
  'choose': '选择',
  'toggle': '切换',
  'run': '执行',
  'edit': '编辑',
  'adjust': '调整',
  'apply': '应用',
  'submit': '提交',
  'confirm': '确认',
  'close': '关闭',
  'leave': '离开',
  'back': '返回',
  'newline': '换行',
  'scroll': '滚动',
  // Shared decisions.
  'Yes': '是',
  'No': '否',
  // Shared surface chrome.
  '  … +{count} more rows': '  … 还有 {count} 行',
}

const en = Object.freeze(Object.fromEntries(Object.keys(zh).map(key => [key, key])))

/** Catalog shared by the core compiler and the interaction layer. */
export const COMMON_LOCALE: MayflyLocaleCatalog = Object.freeze({ en, zh: Object.freeze(zh) })

/**
 * Register the shared catalog for each locale-provider lifetime.
 * @param ctx - owner context that also owns the concrete namespace catalog.
 */
export function mountCommonLocale(ctx: Context): void {
  ctx.inject(['mayflyLocale'], (localeCtx) => {
    localeCtx.effect(() => localeCtx.mayflyLocale.register('common', COMMON_LOCALE))
  })
}
