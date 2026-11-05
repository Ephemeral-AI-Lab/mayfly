/** Theme replacement against real Cordis Fibers and the built public palette entries. @module */
import { Context } from '@deepseek-ai/cordis'
import * as ThemeDark from '../../src/core/theme-dark.ts'
import { expect, it, vi } from 'vitest'
import type { RemoteFeatureContext } from '../../src/app/features/contracts.ts'
import { CordisRemoteLocalPresentation } from '../../src/app/features/presentation.ts'

it('waits for native dependent teardown before mounting a queued replacement theme', async () => {
  const ctx = new Context()
  const state = { currentThemeKey: 'dark', settingsSource: () => undefined }
  ctx.provide('mayflyInteractionState', state as never)
  const presentation = new CordisRemoteLocalPresentation({ ctx, subscribeLocale: () => () => {} } as Pick<RemoteFeatureContext, 'ctx' | 'subscribeLocale'>)
  const retiring = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let generations = 0
  let disposals = 0
  let pending: Promise<void> | undefined
  let queued: Promise<void> | undefined
  try {
    await ctx.plugin(ThemeDark)
    const original = ctx.mayflyTheme.colors
    await ctx.plugin({
      name: 'native-theme-dependent',
      inject: ['mayflyTheme'],
      apply(owner: Context) {
        generations += 1
        owner.effect(() => async () => {
          disposals += 1
          if (disposals === 1) {
            retiring.resolve()
            await release.promise
          }
        })
      },
    })
    pending = presentation.applyTheme('tide')
    await retiring.promise
    queued = presentation.applyTheme('light')
    // Allow the first swap's microtasks to settle while its old provider is retained.
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(state.currentThemeKey).toBe('dark')
    expect(generations).toBe(1)
    release.resolve()
    await Promise.all([pending, queued])
    await vi.waitFor(() => {
      expect(ctx.mayflyTheme.colors).not.toBe(original)
      expect(generations).toBe(3)
    })
    expect(state.currentThemeKey).toBe('light')
    await presentation.applyTheme('dark')
    await vi.waitFor(() => { expect(ctx.mayflyTheme.colors).toBe(original) })
    expect(state.currentThemeKey).toBe('dark')
    await presentation.reloadTheme()
    await vi.waitFor(() => { expect(generations).toBe(5) })
  } finally {
    release.resolve()
    await Promise.allSettled([pending, queued])
    presentation.dispose()
    await ctx.fiber.dispose()
  }
  expect(disposals).toBe(5)
})
