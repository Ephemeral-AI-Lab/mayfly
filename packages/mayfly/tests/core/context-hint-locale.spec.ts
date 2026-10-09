/** Core-private contextual hint locale lifecycle. */
import { Context } from '@deepseek-ai/cordis'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'
import { describe, expect, it, vi } from 'vitest'
import {
  contextHintTranslator,
  HINT_MEMO_ENTRIES,
  mountContextHintLocale,
} from '../../src/core/context-hint-locale.ts'
import { untranslated } from '../../src/core/ui-interaction-locale.ts'

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

function localePlugin(systemLocale: 'en' | 'zh') {
  return {
    name: `core-context-hint-locale-${systemLocale}`,
    apply(ctx: Context) {
      const service = new MayflyLocaleService(ctx, { systemLocale })
      ctx.effect(() => () => service.dispose())
    },
  }
}

describe('context hint locale lifecycle', () => {
  it('interpolates known placeholders and leaves unknown ones in the core fallback', () => {
    expect(untranslated('Select at least {count} of {total}', { count: 2 })).toBe('Select at least 2 of {total}')
    expect(untranslated('plain')).toBe('plain')
  })

  it('falls back to English keys and interpolation without a provider', () => {
    const t = contextHintTranslator(new Context())
    expect(t('run')).toBe('run')
    expect(t('run {count}', { count: 2 })).toBe('run 2')
  })

  it('registers with each provider lifetime and repaints on locale changes', async () => {
    const ctx = new Context()
    const repaint = vi.fn()
    mountContextHintLocale(ctx, repaint)
    const t = contextHintTranslator(ctx)

    const first = await ctx.plugin(localePlugin('zh'))
    await settle()
    expect(t('run')).toBe('执行')
    const before = repaint.mock.calls.length
    ctx.mayflyLocale.setPreference('en')
    expect(t('run')).toBe('run')
    expect(repaint.mock.calls.length).toBeGreaterThan(before)

    await first.dispose()
    expect(t('run')).toBe('run')

    const second = await ctx.plugin(localePlugin('zh'))
    await settle()
    expect(t('close')).toBe('关闭')
    expect(t('Discard unsaved changes?')).toBe('放弃未保存的修改？')
    expect(t('Minimum: {value}', { value: 3 })).toBe('最小值：3')
    await second.dispose()
  })

  it('resolves a string once per locale revision while a provider is mounted', async () => {
    const ctx = new Context()
    mountContextHintLocale(ctx, () => {})
    const t = contextHintTranslator(ctx)
    const provider = await ctx.plugin(localePlugin('zh'))
    await settle()
    const translate = vi.spyOn(MayflyLocaleService.prototype, 'translate')
    try {
      expect(t('run')).toBe('执行')
      expect(t('run')).toBe('执行')
      expect(t('Minimum: {value}', { value: 3 })).toBe('最小值：3')
      expect(t('Minimum: {value}', { value: 3 })).toBe('最小值：3')
      expect(t('Minimum: {value}', { value: 4 })).toBe('最小值：4')
      expect(translate).toHaveBeenCalledTimes(3)
      // A new revision starts a new memo, in the turn that made it.
      ctx.mayflyLocale.setPreference('en')
      expect(t('run')).toBe('run')
      expect(translate).toHaveBeenCalledTimes(4)
      // A full memo starts over: the next string is resolved again and remembered.
      for (let count = 0; count < HINT_MEMO_ENTRIES; count += 1) t('run {count}', { count })
      const filled = translate.mock.calls.length
      expect(t('run')).toBe('run')
      expect(translate).toHaveBeenCalledTimes(filled + 1)
      expect(t('run')).toBe('run')
      expect(translate).toHaveBeenCalledTimes(filled + 1)
      // Without a provider nothing is remembered, so the next provider is not answered from the last one.
      await provider.dispose()
      expect(t('run')).toBe('run')
      expect(translate).toHaveBeenCalledTimes(filled + 1)
    } finally {
      translate.mockRestore()
    }
  })
})
