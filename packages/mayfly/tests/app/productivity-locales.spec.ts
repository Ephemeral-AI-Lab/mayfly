/** Locale catalogs belong to the feature Fiber and keep English and Chinese keys aligned.
 * @module @ephemeral-ai/mayfly-remote/tests/productivity-locales
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { MayflyLocaleService } from '../../src/frontend.ts'
import { mountRemoteProductivityLocales } from '../../src/app/features/locales.ts'

describe('Remote productivity locale lifetime', () => {
  it('mounts each bilingual catalog under one actual Cordis feature Fiber and releases it on unload', async () => {
    const ctx = new Context()
    const locale = new MayflyLocaleService(ctx, { systemLocale: 'en' })
    ctx.set('mayflyLocale', locale)
    const owner = await ctx.plugin({ name: 'remote-productivity-locale-test', apply: mountRemoteProductivityLocales })
    try {
      for (const namespace of ['remote-jobs', 'remote-git', 'remote-catalog', 'remote-activity', 'remote-workflow']) {
        expect(locale.translate(namespace, 'Refresh')).toBe('Refresh')
      }
      locale.setPreference('zh')
      for (const namespace of ['remote-jobs', 'remote-git', 'remote-catalog', 'remote-activity', 'remote-workflow']) {
        expect(locale.translate(namespace, 'Refresh')).toBe('刷新')
      }
      expect(locale.translate('remote-activity', 'Running {count} tools', { count: 3 })).toBe('正在运行 3 个工具')
      expect(locale.translate('remote-jobs', 'Jobs')).toBe('后台任务')
      await owner.dispose()
      expect(locale.translate('remote-jobs', 'Jobs')).toBe('Jobs')
      expect(locale.translate('remote-workflow', 'Refresh')).toBe('Refresh')
    } finally {
      await owner.dispose()
      locale.dispose()
    }
  })
})
