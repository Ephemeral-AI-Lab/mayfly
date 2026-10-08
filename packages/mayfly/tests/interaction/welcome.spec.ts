/** First-run welcome: language and theme choice, live apply, and persistence.
 * @module @ephemeral-ai/mayfly/tests/interaction/welcome
 */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/interaction/settings.ts'
import { InteractionStateService } from '../../src/interaction/runtime-state.ts'
import { openWelcome, welcomeDue, welcomeNode, WELCOME_ID } from '../../src/interaction/welcome.ts'
import { providerFixture } from './provider-fixture.ts'

const themeCalls = vi.hoisted(() => ({ keys: [] as string[], fail: false }))
vi.mock('../../src/interaction/theme-switch.ts', () => ({
  applyTheme: async (_ctx: unknown, key: string) => {
    themeCalls.keys.push(key)
    return themeCalls.fail ? { kind: 'error', text: 'no' } : { kind: 'success' }
  },
}))

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose(); themeCalls.keys.length = 0; themeCalls.fail = false })
const flush = async (times = 4): Promise<void> => { for (let index = 0; index < times; index += 1) await new Promise<void>(resolve => { setImmediate(resolve) }) }

/** A fixture tree whose settings list the shared `locale` and `mayfly` namespaces. */
async function bench(options: { readonly locale?: boolean, readonly state?: boolean } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  new InteractionStateService(ctx, DEFAULT_SETTINGS)
  const fixture = await providerFixture(ctx)
  if (options.locale !== false) fixture.settings.register('locale', z.object({ preference: z.string().volatile() }))
  fixture.settings.register('mayfly', z.object({ theme: z.string().default('dark').volatile() }))
  return { ...fixture, welcome: () => ctx.mayflyUiInteraction.get('overlay', WELCOME_ID) }
}

const submit = (model: NonNullable<ReturnType<Awaited<ReturnType<typeof bench>>['welcome']>>, language: string, theme: string) => {
  model.edit({ pagePath: [], formId: 'welcome', fieldId: 'language' }, language)
  model.edit({ pagePath: [], formId: 'welcome', fieldId: 'theme' }, theme)
  model.invoke('continue')
}

describe('welcome', () => {
  it('is due only while the shared language preference has never been stored', async () => {
    const fresh = await bench()
    expect(welcomeDue(fresh.ctx)).toBe(true)
    await fresh.settings.mutate('locale', [{ op: 'set', path: ['preference'], value: 'en' }])
    expect(welcomeDue(fresh.ctx)).toBe(false)

    const noNamespace = await bench({ locale: false })
    expect(welcomeDue(noNamespace.ctx)).toBe(false)

    const chosen = await bench()
    chosen.ctx.mayflyLocale.setPreference('zh')
    expect(welcomeDue(chosen.ctx)).toBe(false)

  })

  it('starts from the live language and theme, treating a custom palette as dark', async () => {
    const { ctx, welcome } = await bench()
    ctx.mayflyLocale.setPreference('zh')
    ctx.mayflyInteractionState.currentThemeKey = 'custom'
    void openWelcome(ctx, new AbortController().signal)
    await flush()
    const json = JSON.stringify(welcome()!.node)
    expect(json).toContain('"value":"zh"')
    expect(json).toContain('"value":"dark"')
    ctx.mayflyOverlays.close(WELCOME_ID)

    const theme = await bench()
    theme.ctx.mayflyInteractionState.currentThemeKey = 'paper'
    void openWelcome(theme.ctx, new AbortController().signal)
    await flush()
    expect(JSON.stringify(theme.welcome()!.node)).toContain('"value":"paper"')
    theme.ctx.mayflyOverlays.close(WELCOME_ID)
  })

  it('renders the language and theme choice with a single Continue', () => {
    const t = (key: string) => key
    const json = JSON.stringify(welcomeNode(t, 'zh', 'ocean'))
    expect(json).toContain('简体中文')
    expect(json).toContain('"value":"ocean"')
    expect(json).toContain('"value":"zh"')
    expect(json.match(/"id":"continue"/g)).toHaveLength(1)
  })

  it('applies the choice live, persists both settings, and settles when it closes', async () => {
    const { ctx, settings, welcome } = await bench()
    const lifetime = new AbortController()
    let settled = false
    const opened = openWelcome(ctx, lifetime.signal).then(() => { settled = true })
    await flush()
    const model = welcome()!
    expect(JSON.stringify(model.node)).toContain('Pick a language')
    expect(settled).toBe(false)
    submit(model, 'zh', 'ocean')
    await flush(8)
    await opened
    expect(ctx.mayflyLocale.preference).toBe('zh')
    expect(themeCalls.keys).toEqual(['ocean'])
    expect(settings.get('locale')).toMatchObject({ preference: 'zh' })
    expect(settings.get('mayfly')).toMatchObject({ theme: 'ocean' })
    expect(welcomeDue(ctx)).toBe(false)
    expect(settled).toBe(true)
  })

  it('keeps the live choice when the store is read-only, missing, or rejects the write', async () => {
    const readOnly = await bench()
    Object.defineProperty(readOnly.settings, 'writable', { value: false })
    const first = openWelcome(readOnly.ctx, new AbortController().signal)
    await flush()
    submit(readOnly.welcome()!, 'en', 'light')
    await flush(8)
    await first
    expect(readOnly.ctx.mayflyLocale.preference).toBe('en')
    expect(readOnly.settings.writes).toBe(0)

    const rejecting = await bench()
    const warn = vi.spyOn(rejecting.ctx.logger, 'warn')
    vi.spyOn(rejecting.settings, 'mutate').mockRejectedValue(new Error('conflict'))
    themeCalls.fail = true
    const second = openWelcome(rejecting.ctx, new AbortController().signal)
    await flush()
    submit(rejecting.welcome()!, 'zh', 'paper')
    await flush(8)
    await second
    expect(warn).toHaveBeenCalled()
    expect(rejecting.ctx.mayflyLocale.preference).toBe('zh')
  })

  it('rejects a forged submission and resolves at once when the welcome is already open', async () => {
    const { ctx, welcome } = await bench()
    const first = openWelcome(ctx, new AbortController().signal)
    await flush()
    const model = welcome()!
    model.edit({ pagePath: [], formId: 'welcome', fieldId: 'language' }, 'xx')
    model.invoke('continue')
    await flush(8)
    expect(model.feedbackSnapshot().at(-1)?.severity).toBe('warning')
    await openWelcome(ctx, new AbortController().signal)
    model.invoke('continue')
    lifetimeClose(ctx)
    await first
  })
})

/** Dispose the overlays the spec opened so pending welcomes settle. */
function lifetimeClose(ctx: Context): void {
  ctx.mayflyOverlays.close(WELCOME_ID)
}
