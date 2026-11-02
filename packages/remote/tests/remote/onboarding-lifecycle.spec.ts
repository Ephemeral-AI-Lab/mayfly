/** Shared onboarding wizard driven through real feature controllers and Cordis overlay endpoints. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MayflyUiActionEvent, MayflyUiEvent } from '@ephemeral-ai/mayfly-ui'
import {
  ONBOARDING_WIZARD, ONBOARDING_PREFERENCES, ONBOARDING_CONNECT, ONBOARDING_READY,
  ONBOARDING_PREFERENCES_FORM, ONBOARDING_CONNECT_LIST, ONBOARDING_KEY_FORM, ONBOARDING_KEY_FIELD,
} from '@ephemeral-ai/mayfly/configuration-panels'
import { RemoteOnboardingController } from '../../src/remote/features/onboarding.ts'
import { RemoteProvidersController } from '../../src/remote/features/providers.ts'
import { RemoteSettingsController } from '../../src/remote/features/settings.ts'
import { RemotePreferencesController } from '../../src/remote/features/preferences.ts'
import { RemotePermissionsController } from '../../src/remote/features/permissions.ts'
import { RemoteModelsController } from '../../src/remote/features/models.ts'
import { accountFixture, accountView } from './account-feature-fixture.ts'

const ID = 'mayfly.provider.onboarding'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function submit(step: string, forms: readonly { readonly formId: string, readonly fields: readonly { readonly id: string, readonly value: string }[] }[] = [], choice?: string): MayflyUiActionEvent {
  return {
    kind: 'submit', controlId: ONBOARDING_WIZARD,
    pagePath: [{ controlId: ONBOARDING_WIZARD, itemId: step }],
    submission: {
      actionId: `wizard:${step}`, draftRevision: 1, source: [{ resourceId: ID, revision: 1 }],
      forms: forms.map(form => ({ ...form, pagePath: [{ controlId: ONBOARDING_WIZARD, itemId: step }], draftRevision: 1, fields: form.fields.map(field => ({ ...field, change: 'set' })) })),
      ...choice === undefined ? {} : { selections: [{ controlId: ONBOARDING_CONNECT_LIST, pagePath: [{ controlId: ONBOARDING_WIZARD, itemId: step }], selectedIds: [choice] }] },
    },
  }
}
const preferences = (overrides: Readonly<Record<string, string>> = {}): MayflyUiActionEvent => submit(ONBOARDING_PREFERENCES, [{
  formId: ONBOARDING_PREFERENCES_FORM,
  fields: Object.entries({ language: 'zh', theme: 'tide', startup: 'splash', permission: 'plan', ...overrides }).map(([id, value]) => ({ id, value })),
}])

async function fixture() {
  const f = await accountFixture()
  const settings = new RemoteSettingsController(f.context)
  const providers = new RemoteProvidersController(f.context)
  const preference = new RemotePreferencesController(f.context, settings)
  const permission = new RemotePermissionsController(f.context, settings)
  const defaultModel = {
    read: vi.fn(async () => ({ provider: 'deepseek-official', model: 'deepseek-chat' })),
    select: vi.fn(async (_client: unknown, selection: { provider: string, model: string }) => selection),
  }
  const models = new RemoteModelsController(f.context, undefined, defaultModel)
  const controller = new RemoteOnboardingController(f.context, providers, f.accounts, settings, permission, preference, models)
  cleanups.push(async () => {
    controller.dispose(); models.dispose(); permission.dispose(); preference.dispose(); providers.dispose(); settings.dispose()
    await f.cleanup()
  })
  const dispatch = (event: MayflyUiEvent) => f.dispatch(event, ID)
  const open = async (): Promise<void> => {
    controller.open(f.client)
    await vi.waitFor(() => { expect(f.ctx.mayflyOverlays.list().some(entry => entry.id === ID)).toBe(true) })
  }
  const text = (): string => JSON.stringify(f.current(ID).node)
  return { ...f, controller, settings, providers, preference, permission, models, defaultModel, dispatch, open, text }
}

describe('RemoteOnboardingController readiness ownership', () => {
  it('opens first-run once per exact HostClient generation and retires the previous wizard on reconnect', async () => {
    const f = await fixture()
    await f.controller.onReady(f.client)
    expect(f.current(ID).definition.presentation).toBe('editor')
    expect(f.text()).toContain('preferences-form')
    expect(f.remote.llm.listProviders).toHaveBeenCalledOnce()
    expect(f.remote.credentials.describe).toHaveBeenCalledExactlyOnceWith(['DEEPSEEK_API_KEY'])
    await f.controller.onReady(f.client)
    expect(f.remote.llm.listProviders).toHaveBeenCalledOnce()
    f.reconnect()
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    await f.controller.onReady(f.client)
    expect(f.remote.llm.listProviders).toHaveBeenCalledTimes(2)
    expect(f.current(ID)).toBeDefined()
  })
  it.each(['account', 'credential'] as const)('skips first-run for an already configured %s and still applies Host preferences', async configured => {
    const f = await fixture()
    const view = await f.remote.settings.describe()
    f.remote.settings.describe.mockResolvedValue({ ok: true, value: { ...view.value, namespaces: view.value.namespaces.map(ns => ns.ns === 'mayfly' ? { ...ns, value: { language: 'zh', theme: 'tide' } } : ns) } })
    if (configured === 'account') f.account.getState.mockResolvedValue({ ok: true, value: accountView('succeeded') })
    else f.remote.credentials.describe.mockResolvedValue({ ok: true, value: { DEEPSEEK_API_KEY: { configured: true, writable: true } } })
    await f.controller.onReady(f.client)
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    expect(f.presentation.snapshot).toEqual({ locale: 'zh', theme: 'tide' })
  })
  it('ignores an unfinished readiness result after detach and never writes or opens a late wizard', async () => {
    const f = await fixture()
    const reading = Promise.withResolvers<Awaited<ReturnType<typeof f.account.getState>>>()
    f.account.getState.mockReturnValueOnce(reading.promise)
    const ready = f.controller.onReady(f.client)
    f.detach()
    reading.resolve({ ok: true, value: accountView() })
    await ready
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    expect(f.remote.credentials.describe).not.toHaveBeenCalled()
    expect(f.remote.settings.mutate).not.toHaveBeenCalled()
  })
  it('gets a new readiness attempt only after the generation changes following an external failure', async () => {
    const f = await fixture()
    f.account.getState.mockRejectedValueOnce(new Error('Host not ready'))
    await f.controller.onReady(f.client)
    await f.controller.onReady(f.client)
    expect(f.account.getState).toHaveBeenCalledOnce()
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    f.reconnect()
    await f.controller.onReady(f.client)
    expect(f.account.getState).toHaveBeenCalledTimes(2)
    expect(f.current(ID)).toBeDefined()
  })
})

describe('RemoteOnboardingController shared wizard operations', () => {
  it('writes each valid preference through the original Host revision and advances to Connect', async () => {
    const f = await fixture()
    await f.open()
    const reply = await f.dispatch(preferences())
    expect(reply).toMatchObject({ kind: 'accepted', navigate: [{ controlId: ONBOARDING_WIZARD, itemId: ONBOARDING_CONNECT }] })
    expect(f.presentation.snapshot).toEqual({ locale: 'zh', theme: 'tide' })
    expect(f.remote.settings.mutate.mock.calls).toEqual([
      ['mayfly', [{ op: 'set', path: ['language'], value: 'zh' }], 7],
      ['locale', [{ op: 'set', path: ['preference'], value: 'zh' }], 7],
      ['mayfly', [{ op: 'set', path: ['theme'], value: 'tide' }], 7],
      ['mayfly', [{ op: 'set', path: ['startup'], value: 'splash' }], 7],
      ['permission', [{ op: 'set', path: ['defaultPreset'], value: 'plan' }], 7],
    ])
    expect(f.remote.credentials.set).not.toHaveBeenCalled()
    expect(f.text()).toContain('Language: 简体中文 · Theme: Tide')
  })
  it.each([
    [{ language: 'invalid' }, 'Choose a language and a theme'],
    [{ theme: 'invalid' }, 'Choose a language and a theme'],
    [{ startup: 'invalid' }, 'Choose what to show on start'],
    [{ permission: 'invalid' }, 'permission command is unavailable'],
  ] as const)('validates preferences before any Host writes: %j', async (overrides, message) => {
    const f = await fixture()
    await f.open()
    expect(await f.dispatch(preferences(overrides))).toMatchObject({ kind: 'failed', message })
    expect(f.remote.settings.mutate).not.toHaveBeenCalled()
  })
  it('persists serialized live language/theme observations before accepting the final form', async () => {
    const f = await fixture()
    await f.open()
    await f.dispatch({ kind: 'value-change', controlId: 'language', formId: ONBOARDING_PREFERENCES_FORM, value: 'zh', draftRevision: 1, pagePath: [{ controlId: ONBOARDING_WIZARD, itemId: ONBOARDING_PREFERENCES }] })
    await f.dispatch({ kind: 'value-change', controlId: 'theme', formId: ONBOARDING_PREFERENCES_FORM, value: 'tide', draftRevision: 2, pagePath: [{ controlId: ONBOARDING_WIZARD, itemId: ONBOARDING_PREFERENCES }] })
    await f.dispatch(preferences())
    expect(f.presentation.applyTheme.mock.calls.map(call => call[0])).toEqual(['dark', 'tide', 'tide'])
    expect(f.presentation.setLocale.mock.calls.map(call => call[0])).toEqual(['zh', 'zh', 'zh'])
    expect(f.text()).toContain('connect-options')
  })
  it('accepts skip and dismisses Ready without writing a credential or creating a Session', async () => {
    const f = await fixture()
    await f.open()
    await f.dispatch(preferences())
    expect(await f.dispatch(submit(ONBOARDING_CONNECT, [], 'skip'))).toMatchObject({ kind: 'accepted', navigate: [{ controlId: ONBOARDING_WIZARD, itemId: ONBOARDING_READY }] })
    expect(f.text()).toContain('DeepSeek not connected')
    expect(await f.dispatch(submit(ONBOARDING_READY))).toMatchObject({ kind: 'accepted', dismiss: true })
    expect(f.remote.credentials.set).not.toHaveBeenCalled()
    expect(f.account.startSignIn).not.toHaveBeenCalled()
  })
  it('requires review before replacing a concurrently configured API key, then writes it only once', async () => {
    const f = await fixture()
    await f.open()
    await f.dispatch(submit(ONBOARDING_CONNECT, [], 'key'))
    expect(f.text()).toContain('key-form')
    const key = (value: string) => submit(ONBOARDING_CONNECT, [{ formId: ONBOARDING_KEY_FORM, fields: [{ id: ONBOARDING_KEY_FIELD, value }] }])
    expect(await f.dispatch(key(''))).toMatchObject({ kind: 'invalid', errors: [{ formId: ONBOARDING_KEY_FORM, fieldId: ONBOARDING_KEY_FIELD }] })
    f.remote.credentials.describe.mockResolvedValue({ ok: true, value: { DEEPSEEK_API_KEY: { configured: true, writable: true } } })
    expect(await f.dispatch(key('fixture-api-secret'))).toMatchObject({ kind: 'conflict', message: expect.stringContaining('configured elsewhere') })
    expect(f.remote.credentials.set).not.toHaveBeenCalled()
    const writing = f.dispatch(key('fixture-api-secret'))
    await vi.waitFor(() => { expect(f.ctx.mayflyOverlays.list().some(entry => entry.id === 'mayfly.models')).toBe(true) })
    expect(f.remote.credentials.set).toHaveBeenCalledExactlyOnceWith('DEEPSEEK_API_KEY', 'fixture-api-secret')
    expect(JSON.stringify(f.ctx.mayflyOverlays.list().map(entry => entry.node))).not.toContain('fixture-api-secret')
    expect(JSON.stringify(f.current('mayfly.models').node)).not.toContain('deepseek-account/DeepSeek Chat')
    f.ctx.mayflyOverlays.close('mayfly.models')
    expect(await writing).toMatchObject({ kind: 'accepted', navigate: [{ controlId: ONBOARDING_WIZARD, itemId: ONBOARDING_READY }] })
    expect(f.text()).toContain('Connected with an API key')
  })
  it('keeps account sign-in alive on panel close, while cancelling only local watchers', async () => {
    const f = await fixture()
    await f.open()
    await f.dispatch(submit(ONBOARDING_CONNECT, [], 'account'))
    await vi.waitFor(() => { expect(f.account.startSignIn).toHaveBeenCalledOnce() })
    f.ctx.mayflyOverlays.close(ID)
    expect(f.stream.signals[0]!.aborted).toBe(true)
    expect(f.account.cancelSignIn).not.toHaveBeenCalled()
    expect(f.remote.credentials.set).not.toHaveBeenCalled()
  })
  it('explicit back cancels the displayed account attempt and restores the Connect choices', async () => {
    const f = await fixture()
    await f.open()
    await f.dispatch(submit(ONBOARDING_CONNECT, [], 'account'))
    await vi.waitFor(() => { expect(f.io.openBrowser).toHaveBeenCalledOnce() })
    await f.dispatch({ kind: 'dismiss', pagePath: [{ controlId: ONBOARDING_WIZARD, itemId: ONBOARDING_CONNECT }] } as MayflyUiActionEvent)
    await vi.waitFor(() => { expect(f.account.cancelSignIn).toHaveBeenCalledExactlyOnceWith('attempt-1') })
    expect(f.text()).toContain('connect-options')
    expect(f.ctx.mayflyOverlays.list()).toHaveLength(1)
    expect(f.stream.signals[0]!.aborted).toBe(true)
  })
  it('advances account completion only after the account-scoped model picker closes', async () => {
    const f = await fixture()
    await f.open()
    await f.dispatch(submit(ONBOARDING_CONNECT, [], 'account'))
    await vi.waitFor(() => { expect(f.io.openBrowser).toHaveBeenCalledOnce() })
    f.stream.emit(accountView('succeeded'))
    await vi.waitFor(() => { expect(f.ctx.mayflyOverlays.list().some(entry => entry.id === 'mayfly.models')).toBe(true) })
    expect(JSON.stringify(f.current('mayfly.models').node)).not.toContain('deepseek-official/DeepSeek Chat')
    f.ctx.mayflyOverlays.close('mayfly.models')
    await vi.waitFor(() => { expect(f.text()).toContain('"activeId":"ready"') })
    expect(f.text()).toContain('Connected with a DeepSeek account')
    expect(f.stream.signals[0]!.aborted).toBe(true)
    expect(f.account.cancelSignIn).not.toHaveBeenCalled()
  })
  it('fences a late preference write after Host reconnect before subsequent writes can begin', async () => {
    const f = await fixture()
    await f.open()
    const saved = Promise.withResolvers<Awaited<ReturnType<typeof f.remote.settings.mutate>>>()
    f.remote.settings.mutate.mockReturnValueOnce(saved.promise)
    const settling = f.dispatch(preferences())
    await vi.waitFor(() => { expect(f.remote.settings.mutate).toHaveBeenCalledOnce() })
    f.reconnect()
    saved.resolve({ ok: true, value: {} })
    await settling
    // The endpoint aborts its public reply immediately; drain the underlying
    // feature continuation before proving that it caused no later Host write.
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    expect(f.presentation.applyTheme).not.toHaveBeenCalled()
    expect(f.remote.settings.mutate).toHaveBeenCalledOnce()
  })
})
