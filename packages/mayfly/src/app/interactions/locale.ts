/**
 * Remote approval/question locale catalog and dynamic translator lifecycle.
 * @module @ephemeral-ai/mayfly/remote/interactions/locale
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import { memoizedLocaleTranslator, type MayflyLocaleCatalog } from '../../frontend/locale.ts'
import { mountCommonLocale } from '../../frontend/common-locale.ts'

const zh: Readonly<Record<string, string>> = {
  'Allow once': '仅允许一次',
  'Open diff': '打开差异',
  'Open command': '打开命令',
  'open diff': '打开差异',
  'open command': '打开命令',
  'no editor configured ($VISUAL/$EDITOR)': '未配置编辑器（$VISUAL/$EDITOR）',
  'The editor could not be opened': '无法打开编辑器',
  'Allow {tool} for this session': '本会话允许 {tool}',
  'Reject': '拒绝',
  'Approve {tool}?': '是否批准 {tool}？',
  'Questions': '问题',
  'Review': '核对',
  '— skipped': '— 已跳过',
  'type your own answer': '输入你自己的回答',
  'select all that apply · Space toggles': '可多选 · 空格切换',
  'Feedback': '反馈',
  'Revise': '修改意见',
  'Decide': '决定',
  'type to explain…': '输入原因…',
  'type the revision in place': '在此输入修改意见',
  'Approve and start': '批准并开始',
  'Keep planning…': '继续规划…',
  'Write what to change first': '请先写下需要修改的内容',
  '{index} of {total} waiting': '第 {index} 个，共 {total} 个等待',
  'Submit answers': '提交回答',
  'Other': '其他',
  'Answer': '回答',
  'expires in {time}': '{time} 后过期',
}

/** The approval/question vocabulary: English keys and their Chinese values. */
export const REMOTE_INTERACTION_LOCALE: MayflyLocaleCatalog = Object.freeze({
  en: Object.freeze(Object.fromEntries(Object.keys(zh).map(key => [key, key]))),
  zh: Object.freeze(zh),
})
const NAMESPACE = 'remote-interactions'

/** Register only the Remote interaction vocabulary and return its live translator. */
export function mountRemoteInteractionLocale(ctx: Context): MayflyTranslate {
  mountCommonLocale(ctx)
  ctx.effect(() => ctx.mayflyLocale.register(NAMESPACE, REMOTE_INTERACTION_LOCALE))
  return memoizedLocaleTranslator(ctx, NAMESPACE).translate
}
