/** Remote decision vocabulary stays live and releases refcounted catalogs with its actual Fibers. @module */

import { Context } from '@deepseek-ai/cordis'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import { expect, it } from 'vitest'
import { mountRemoteInteractionLocale } from '../../src/app/interactions/locale.ts'

it('shares bilingual decision vocabulary between owners and removes it after the final unload', async () => {
  const ctx = new Context()
  const locale = new MayflyLocaleService(ctx, { systemLocale: 'en' })
  ctx.set('mayflyLocale', locale)
  let first!: MayflyTranslate
  let second!: MayflyTranslate
  const owner = await ctx.plugin({ name: 'first-remote-decisions', apply(scope: Context) { first = mountRemoteInteractionLocale(scope) } })
  const other = await ctx.plugin({ name: 'second-remote-decisions', apply(scope: Context) { second = mountRemoteInteractionLocale(scope) } })
  try {
    expect(first('Questions')).toBe('Questions')
    locale.setPreference('zh')
    expect(first('Questions')).toBe('问题')
    expect(second('Allow {tool} for this session', { tool: 'Bash' })).toBe('本会话允许 Bash')
    expect(second('Submit answers')).toBe('提交回答')
    await owner.dispose()
    expect(second('Write what to change first')).toBe('请先写下需要修改的内容')
    await other.dispose()
    expect(locale.translate('remote-interactions', 'Questions')).toBe('Questions')
  } finally {
    await owner.dispose()
    await other.dispose()
    await ctx.fiber.dispose()
  }
})
