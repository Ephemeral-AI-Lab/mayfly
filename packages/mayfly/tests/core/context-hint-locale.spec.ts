/** Core-private contextual hint locale lifecycle. */
import { Context } from '@deepseek-ai/cordis'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'
import { describe, expect, it, vi } from 'vitest'
import {
  contextHintTranslator,
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
})
