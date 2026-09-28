import { Context } from '@deepseek-ai/cordis'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'
import { describe, expect, it } from 'vitest'
import {
  interactionTranslator,
  mountInteractionLocale,
  observeInteractionLocale,
} from '../../src/interaction/locale.ts'

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

function localePlugin(systemLocale: 'en' | 'zh') {
  return {
    name: `test-locale-${systemLocale}`,
    apply(ctx: Context) {
      const service = new MayflyLocaleService(ctx, { systemLocale })
      ctx.effect(() => () => service.dispose())
    },
  }
}

describe('interaction locale lifecycle', () => {
  it('observes the current provider before the injected observer fiber starts', async () => {
    const ctx = new Context()
    const provider = await ctx.plugin(localePlugin('en'))
    await settle()
    const seen: string[] = []
    const off = observeInteractionLocale(ctx, snapshot => seen.push(snapshot?.locale ?? 'absent'))

    ctx.mayflyLocale.setPreference('zh')
    expect(seen.at(-1)).toBe('zh')

    off()
    await provider.dispose()
  })

  it('disposes idempotently after a provider gap', async () => {
    const ctx = new Context()
    const provider = await ctx.plugin(localePlugin('en'))
    await settle()
    const seen: string[] = []
    const off = observeInteractionLocale(ctx, snapshot => seen.push(snapshot?.locale ?? 'absent'))
    await settle()
    await provider.dispose()
    expect(seen.at(-1)).toBe('absent')
    off()
    off()
  })

  it('falls back to English and follows provider unload and reload', async () => {
    const ctx = new Context()
    mountInteractionLocale(ctx)
    const t = interactionTranslator(ctx)
    const seen: string[] = []
    const off = observeInteractionLocale(ctx, snapshot => seen.push(
      snapshot === undefined ? 'absent' : `${snapshot.locale}:${snapshot.revision}`,
    ))
    expect(t('Language')).toBe('Language')
    expect(t('Question {current} of {total}', { current: 1, total: 2 })).toBe('Question 1 of 2')

    const first = await ctx.plugin(localePlugin('zh'))
    await settle()
    expect(t('Language')).toBe('语言')
    expect(seen.at(-1)?.startsWith('zh:')).toBe(true)
    await first.dispose()
    expect(t('Language')).toBe('Language')
    expect(seen.at(-1)).toBe('absent')

    const second = await ctx.plugin(localePlugin('en'))
    await settle()
    expect(t('Language')).toBe('Language')
    const before = seen.length
    off()
    ctx.mayflyLocale.setPreference('zh')
    expect(seen).toHaveLength(before)
    await second.dispose()
  })

  it('shares the interaction catalog across owners and survives the first owner unloading', async () => {
    const ctx = new Context()
    const owner = (name: string) => ({
      name,
      apply(ownerCtx: Context) { mountInteractionLocale(ownerCtx) },
    })
    const first = await ctx.plugin(owner('interaction-owner-one'))
    const second = await ctx.plugin(owner('interaction-owner-two'))
    const provider = await ctx.plugin(localePlugin('zh'))
    await settle()
    const t = interactionTranslator(ctx)
    expect(t('Language')).toBe('语言')

    await first.dispose()
    expect(t('Language')).toBe('语言')
    await second.dispose()
    expect(t('Language')).toBe('Language')
    await provider.dispose()
  })
})
