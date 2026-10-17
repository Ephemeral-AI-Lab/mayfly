/** The memoized namespace translator: one observer per context and namespace, strings resolved once per locale revision. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { MayflyLocaleService, memoizedLocaleTranslator } from '../../src/frontend/locale.ts'

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

function localePlugin() {
  return {
    name: 'memoized-translator-locale',
    apply(ctx: Context) {
      const service = new MayflyLocaleService(ctx, { systemLocale: 'en' })
      ctx.effect(() => service.register('demo', { en: { hello: 'hello' }, zh: { hello: '你好' } }))
      ctx.effect(() => () => service.dispose())
    },
  }
}

describe('memoizedLocaleTranslator', () => {
  it('is one translator per context and namespace, however often it is asked for', () => {
    const ctx = new Context()
    expect(memoizedLocaleTranslator(ctx, 'demo')).toBe(memoizedLocaleTranslator(ctx, 'demo'))
    expect(memoizedLocaleTranslator(ctx, 'demo')).not.toBe(memoizedLocaleTranslator(ctx, 'other'))
  })

  it('reads the catalog once per revision and follows the locale', async () => {
    const ctx = new Context()
    const { translate, revision } = memoizedLocaleTranslator(ctx, 'demo')
    expect(translate('hello')).toBe('hello')
    expect(revision()).toBe(0)
    const provider = await ctx.plugin(localePlugin())
    await settle()
    const read = vi.spyOn(MayflyLocaleService.prototype, 'translate')
    try {
      expect(translate('hello')).toBe('hello')
      expect(translate('hello')).toBe('hello')
      expect(read).toHaveBeenCalledTimes(1)
      const before = revision()
      ctx.mayflyLocale.setPreference('zh')
      expect(revision()).toBeGreaterThan(before)
      expect(translate('hello')).toBe('你好')
      expect(read).toHaveBeenCalledTimes(2)
    } finally {
      read.mockRestore()
    }
    await provider.dispose()
    expect(translate('hello')).toBe('hello')
    expect(revision()).toBe(0)
  })
})
