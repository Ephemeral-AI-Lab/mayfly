/** Shared onboarding wizard driven through real feature controllers and Cordis overlay endpoints. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MayflyUiActionEvent, MayflyUiEvent } from '@ephemeral-ai/mayfly-ui'
import type { MayflyUiEventContext } from '@ephemeral-ai/mayfly-ui'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteFeatureSelection } from '../../src/remote/features/contracts.ts'
import * as Browser from '../../src/remote/panels/browser.ts'
import {
  ONBOARDING_WIZARD, ONBOARDING_PREFERENCES, ONBOARDING_CONNECT, ONBOARDING_READY,
  ONBOARDING_PREFERENCES_FORM, ONBOARDING_CONNECT_LIST, ONBOARDING_KEY_FORM, ONBOARDING_KEY_FIELD, ONBOARDING_SIGN_IN,
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
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })
const openRemoteBrowser = Browser.openRemoteBrowser

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
const keySubmission = (value?: string): MayflyUiActionEvent => submit(ONBOARDING_CONNECT, [{ formId: ONBOARDING_KEY_FORM, fields: value === undefined ? [] : [{ id: ONBOARDING_KEY_FIELD, value }] }])

async function fixture() {
  const f = await accountFixture()
  f.remote.llm.listConfigurableProviders.mockResolvedValue({ ok: true, value: [{ provider: 'deepseek-account', displayName: 'DeepSeek Account', settingsNs: 'llm-deepseek-account', settingsPath: [] }] } as never)
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
  let browser: Browser.RemoteBrowserOptions | undefined
  vi.spyOn(Browser, 'openRemoteBrowser').mockImplementation((context, options) => {
    if (options.id === ID) browser = options
    return openRemoteBrowser(context, options)
  })
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
  const raw = (event: MayflyUiActionEvent, signal = new AbortController().signal) => browser!.action!(event, { signal } as MayflyUiEventContext)
  return { ...f, controller, settings, providers, preference, permission, models, defaultModel, dispatch, open, text, browser: () => browser!, raw }
}

describe('RemoteOnboardingController readiness ownership', () => {
  it('refuses cancelled invocation discovery and keeps the original caller when focusing an open wizard', async () => {
    const f = await fixture()
    const focus = vi.spyOn(f.ctx.mayflyOverlays, 'focus')
    const cancelled = new AbortController(); cancelled.abort()
    f.controller.open(f.client, undefined, cancelled.signal)
    expect(focus).not.toHaveBeenCalled()
    expect(f.remote.settings.describe).not.toHaveBeenCalled()
    const gate = Promise.withResolvers<Awaited<ReturnType<typeof f.remote.settings.describe>>>()
    const original = f.remote.settings.describe.getMockImplementation()!
    f.remote.settings.describe.mockReturnValueOnce(gate.promise)
    const pending = new AbortController()
    f.controller.open(f.client, undefined, pending.signal)
    pending.abort(); gate.resolve(await original())
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    const caller = new AbortController()
    f.controller.open(f.client, undefined, caller.signal)
    await vi.waitFor(() => { expect(f.ctx.mayflyOverlays.list().some(row => row.id === ID)).toBe(true) })
    const reads = f.remote.settings.describe.mock.calls.length
    const second = new AbortController()
    f.controller.open(f.client, undefined, second.signal)
    second.abort()
    expect(f.ctx.mayflyOverlays.list().some(row => row.id === ID)).toBe(true)
    expect(f.remote.settings.describe).toHaveBeenCalledTimes(reads)
    caller.abort()
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
  })

  it('cancels nested account reads and credential writes under the wizard caller', async () => {
    for (const nested of ['account', 'key'] as const) {
      const f = await fixture()
      const caller = new AbortController()
      f.controller.open(f.client, undefined, caller.signal)
      await vi.waitFor(() => { expect(f.ctx.mayflyOverlays.list().some(row => row.id === ID)).toBe(true) })
      await f.dispatch(preferences({ language: 'en', theme: 'dark', permission: 'default' }))
      if (nested === 'account') {
        const gate = Promise.withResolvers<Awaited<ReturnType<typeof f.account.getState>>>()
        f.account.getState.mockReturnValueOnce(gate.promise)
        const starting = f.dispatch(submit(ONBOARDING_CONNECT, [], 'account'))
        await vi.waitFor(() => { expect(f.account.getState).toHaveBeenCalledTimes(2) })
        caller.abort(); gate.resolve({ ok: true, value: accountView() })
        await starting
        expect(f.account.watch).not.toHaveBeenCalled()
        expect(f.account.startSignIn).not.toHaveBeenCalled()
      } else {
        await f.dispatch(submit(ONBOARDING_CONNECT, [], 'key'))
        const gate = Promise.withResolvers<Awaited<ReturnType<typeof f.remote.credentials.describe>>>()
        const original = f.remote.credentials.describe.getMockImplementation()!
        f.remote.credentials.describe.mockImplementationOnce(original).mockReturnValueOnce(gate.promise)
        const writing = f.dispatch(keySubmission('one-time-key'))
        await vi.waitFor(() => { expect(f.remote.credentials.describe).toHaveBeenCalledTimes(2) })
        caller.abort(); gate.resolve(await original(['DEEPSEEK_API_KEY']))
        await writing
        expect(f.remote.credentials.set).not.toHaveBeenCalled()
      }
      expect(f.ctx.mayflyOverlays.list()).toEqual([])
    }
  })

  it('closes the nested real model picker when the wizard caller cancels', async () => {
    const f = await fixture()
    const caller = new AbortController()
    f.controller.open(f.client, undefined, caller.signal)
    await vi.waitFor(() => { expect(f.ctx.mayflyOverlays.list().some(row => row.id === ID)).toBe(true) })
    await f.dispatch(preferences({ language: 'en', theme: 'dark', permission: 'default' }))
    await f.dispatch(submit(ONBOARDING_CONNECT, [], 'key'))
    const settling = f.dispatch(keySubmission('one-time-key'))
    await vi.waitFor(() => { expect(f.ctx.mayflyOverlays.list().some(row => row.id === 'mayfly.models')).toBe(true) })
    caller.abort()
    await settling
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
  })

  it('does not consume a readiness attempt for a detached or disposed owner', async () => {
    const f = await fixture()
    f.detach()
    await f.controller.onReady(f.client)
    f.controller.open(f.client)
    expect(f.remote.settings.describe).not.toHaveBeenCalled()
  })

  it('fences Host preference readiness and reports only current explicit-open failures', async () => {
    const f = await fixture()
    const original = f.remote.settings.describe.getMockImplementation()!
    let reads = 0
    f.remote.settings.describe.mockImplementation(async () => {
      reads += 1
      if (reads === 2) f.reconnect()
      return await original()
    })
    await f.controller.onReady(f.client)
    expect(f.remote.credentials.describe).not.toHaveBeenCalled()
    f.remote.settings.describe.mockRejectedValueOnce(new Error('current description failed'))
    f.controller.open(f.client)
    await vi.waitFor(() => { expect(f.notice.set).toHaveBeenCalledWith('current description failed') })
    const late = Promise.withResolvers<never>()
    f.remote.settings.describe.mockReturnValueOnce(late.promise)
    f.controller.open(f.client)
    f.reconnect()
    late.reject(new Error('retired description failed'))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.notice.set).toHaveBeenCalledOnce()
    const resolving = Promise.withResolvers<Awaited<ReturnType<typeof f.remote.settings.describe>>>()
    f.remote.settings.describe.mockReturnValueOnce(resolving.promise)
    f.controller.open(f.client)
    f.reconnect()
    resolving.resolve(await original())
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
  })

  it('reads all native credential-reference batches and detects a configured reference after the first batch', async () => {
    const f = await fixture()
    f.remote.llm.listProviders.mockResolvedValue({ ok: true, value: Array.from({ length: 70 }, (_, i) => ({ id: `route-${String(i)}`, name: `Route ${String(i)}` })) } as never)
    let batches = 0
    f.remote.credentials.describe.mockImplementation(async refs => {
      batches += 1
      return { ok: true, value: Object.fromEntries(refs.map(ref => [ref, { configured: batches === 2 && ref === refs.at(-1), writable: true }])) }
    })
    await f.controller.onReady(f.client)
    expect(f.remote.credentials.describe).toHaveBeenCalledTimes(2)
    expect(f.remote.credentials.describe.mock.calls[0]![0]).toHaveLength(64)
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
  })

  it('treats a rejected official account result as unavailable and a missing route as unsupported', async () => {
    const f = await fixture()
    f.account.getState.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'account unavailable', {}) } as never)
    await f.controller.onReady(f.client)
    expect(f.text()).toContain('"id":"key"')
    expect(f.text()).not.toContain('"id":"account"')
    f.reconnect()
    f.remote.llm.listConfigurableProviders.mockResolvedValue({ ok: true, value: [] })
    await f.controller.onReady(f.client)
    expect(f.text()).not.toContain('"id":"account"')
  })
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
  it('keeps API-key onboarding available when the optional account service fails and retries account readiness on a new generation', async () => {
    const f = await fixture()
    f.account.getState.mockRejectedValueOnce(new Error('Host not ready'))
    await f.controller.onReady(f.client)
    await f.controller.onReady(f.client)
    expect(f.account.getState).toHaveBeenCalledOnce()
    expect(f.current(ID)).toBeDefined()
    expect(f.text()).not.toContain('"id":"account"')
    expect(f.text()).toContain('"id":"key"')
    f.reconnect()
    await f.controller.onReady(f.client)
    expect(f.account.getState).toHaveBeenCalledTimes(2)
    expect(f.current(ID)).toBeDefined()
    expect(f.text()).toContain('"id":"account"')
  })

  it.each(['unreadable', 'absent-route'] as const)('opens an explicit guide with API-key and skip choices when account is %s', async unavailable => {
    const f = await fixture()
    if (unavailable === 'unreadable') f.account.getState.mockRejectedValueOnce(new Error('account unavailable'))
    else f.remote.llm.listConfigurableProviders.mockResolvedValue({ ok: true, value: [] })
    await f.open()
    expect(f.text()).not.toContain('"id":"account"')
    expect(f.text()).toContain('"id":"key"')
    expect(await f.dispatch(submit(ONBOARDING_CONNECT, [], 'account'))).toMatchObject({ kind: 'cancelled' })
    expect(f.account.startSignIn).not.toHaveBeenCalled()
    expect(await f.dispatch(submit(ONBOARDING_CONNECT, [], 'skip'))).toMatchObject({ kind: 'accepted' })
  })
})

describe('RemoteOnboardingController shared wizard operations', () => {
  it('keeps language, theme, startup, and permissions live while each independent default write is best effort', async () => {
    const f = await fixture()
    await f.open()
    f.remote.settings.mutate.mockRejectedValue(new Error('Host document is readonly'))
    expect(await f.dispatch(preferences({ startup: 'conversation' }))).toMatchObject({ kind: 'accepted', navigate: [{ itemId: ONBOARDING_CONNECT }] })
    expect(f.presentation.snapshot).toEqual({ locale: 'zh', theme: 'tide' })
    expect(f.remote.settings.mutate).toHaveBeenCalledTimes(5)
    expect(f.text()).toContain('On start: Conversation')
    expect(f.notice.set).toHaveBeenCalledWith('Host document is readonly')
  })

  it.each(['absent', 'readonly', 'same-default', 'stored-startup', 'invalid-startup'] as const)('handles %s settings without manufacturing default writes', async state => {
    const f = await fixture()
    const initial = await f.remote.settings.describe()
    f.remote.settings.describe.mockResolvedValue({ ok: true, value: {
      ...initial.value, writable: state !== 'readonly',
      namespaces: state === 'absent' ? [] : initial.value.namespaces.map(ns => ns.ns === 'mayfly' ? { ...ns, value: { startup: state === 'invalid-startup' ? 'unknown' : 'splash' } } : ns),
    } })
    await f.open()
    if (state === 'stored-startup') expect(f.text()).toContain('"value":"splash"')
    expect(await f.dispatch(preferences({ permission: state === 'same-default' ? 'default' : 'plan' }))).toMatchObject({ kind: 'accepted' })
    const permissionWrites = f.remote.settings.mutate.mock.calls.filter(call => call[0] === 'permission')
    expect(permissionWrites).toHaveLength(state === 'absent' || state === 'readonly' || state === 'same-default' ? 0 : 1)
  })

  it('rejects missing fields, missing choices, unrelated observations and aborted action contexts', async () => {
    const f = await fixture()
    await f.open()
    expect(await f.raw(submit(ONBOARDING_PREFERENCES))).toMatchObject({ kind: 'failed' })
    expect(await f.raw(submit(ONBOARDING_PREFERENCES, [{ formId: ONBOARDING_PREFERENCES_FORM, fields: [{ id: 'language', value: 'en' }] }]))).toMatchObject({ kind: 'failed' })
    expect(await f.raw(submit(ONBOARDING_CONNECT))).toMatchObject({ kind: 'accepted' })
    expect(await f.raw({ kind: 'activate', controlId: 'unknown', actionId: 'unknown', pagePath: [] })).toEqual({ kind: 'completed' })
    const abort = new AbortController(); abort.abort()
    expect(await f.raw(submit(ONBOARDING_CONNECT), abort.signal)).toEqual({ kind: 'cancelled' })
    f.browser().observe!({ kind: 'selection-toggle', controlId: 'unknown', selectedIds: [], pagePath: [] })
    for (const [formId, controlId, value] of [['unknown', 'language', 'zh'], [ONBOARDING_PREFERENCES_FORM, 'language', 'invalid'], [ONBOARDING_PREFERENCES_FORM, 'theme', 'invalid'], [ONBOARDING_PREFERENCES_FORM, 'unknown', 'en']] as const) {
      f.browser().observe!({ kind: 'value-change', formId, controlId, value, draftRevision: 1, pagePath: [] })
    }
    expect(f.remote.settings.mutate).not.toHaveBeenCalled()
    expect(f.browser().back!()).toBe(false)
    await f.raw(submit(ONBOARDING_CONNECT, [], 'key'))
    expect(f.browser().back!()).toBe(true)
    expect(f.text()).toContain('connect-options')
  })

  it.each([1, 3, 4, 5])('stops the submitted preference chain after native write %i retires its generation', async boundary => {
    const f = await fixture()
    await f.open()
    let writes = 0
    f.remote.settings.mutate.mockImplementation(async () => {
      writes += 1
      if (writes === boundary) f.reconnect()
      return { ok: true, value: {} }
    })
    expect(await f.raw(preferences())).toMatchObject({ kind: 'cancelled' })
    expect(f.remote.settings.mutate).toHaveBeenCalledTimes(boundary)
  })

  it('stops preference work after a late palette swap and suppresses an old permission error', async () => {
    for (const phase of ['palette', 'permission-error'] as const) {
      const f = await fixture()
      await f.open()
      if (phase === 'palette') f.presentation.applyTheme.mockImplementationOnce(async () => { f.reconnect() })
      else f.remote.settings.mutate.mockImplementation(async (ns: unknown) => { if (ns === 'permission') { f.reconnect(); throw new Error('retired write') } return { ok: true, value: {} } })
      expect(await f.raw(preferences())).toMatchObject({ kind: 'cancelled' })
      expect(f.notice.set).not.toHaveBeenCalledWith('retired write')
    }
  })

  it('applies the permission to the exact selected Session and fences its late command result', async () => {
    for (const reconnect of [false, true]) {
      const f = await fixture()
      const command = vi.fn(async () => { if (reconnect) f.reconnect(); return { ok: true, value: { matched: true } } })
      const selected = { client: f.client, ref: { host: f.client.key, sessionId: SessionId('active-session') }, binding: { session: { command } } } as unknown as RemoteFeatureSelection
      f.context.hosts.current = () => selected
      await f.open()
      expect(await f.raw(preferences())).toMatchObject({ kind: reconnect ? 'cancelled' : 'accepted' })
      expect(command).toHaveBeenCalledExactlyOnceWith('/permission plan')
    }
  })

  it('retains the chosen theme label if the local palette directory withdraws it during application', async () => {
    const f = await fixture()
    await f.open()
    f.presentation.applyTheme.mockImplementationOnce(async theme => {
      f.presentation.snapshot.theme = theme
      f.presentation.themes.splice(1)
    })
    const reply = await f.raw(preferences())
    expect(reply).toMatchObject({ kind: 'accepted' })
    expect(JSON.stringify(reply)).toContain('Theme: tide')
  })

  it('does not treat unrelated non-string fields as secrets when a preference action fails', async () => {
    const f = await fixture()
    await f.open()
    f.presentation.applyTheme.mockRejectedValueOnce(new Error('palette unavailable'))
    const event = preferences() as Extract<MayflyUiActionEvent, { kind: 'submit' }>
    const forms = [...event.submission.forms, { pagePath: [], formId: ONBOARDING_KEY_FORM, draftRevision: 1, fields: [{ id: ONBOARDING_KEY_FIELD, value: 7, change: 'set' as const }] }]
    expect(await f.raw({ ...event, submission: { ...event.submission, forms } })).toMatchObject({ kind: 'failed', message: 'palette unavailable' })
  })
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

  it.each(['queued', 'language', 'theme', 'persisted-theme', 'failure', 'late-failure'] as const)('retires %s live preference observations without starting newer Host writes', async boundary => {
    const f = await fixture()
    await f.open()
    if (boundary === 'language' || boundary === 'persisted-theme') {
      let writes = 0
      f.remote.settings.mutate.mockImplementation(async () => {
        writes += 1
        if (writes === (boundary === 'language' ? 1 : 3)) f.reconnect()
        return { ok: true, value: {} }
      })
    }
    if (boundary === 'theme') f.presentation.applyTheme.mockImplementationOnce(async () => { f.reconnect() })
    if (boundary === 'failure') f.presentation.applyTheme.mockRejectedValueOnce(new Error('current palette failed'))
    if (boundary === 'late-failure') f.presentation.applyTheme.mockImplementationOnce(async () => { f.reconnect(); throw new Error('retired palette failed') })
    f.browser().observe!({ kind: 'value-change', controlId: 'theme', formId: ONBOARDING_PREFERENCES_FORM, value: 'tide', draftRevision: 1, pagePath: [] })
    if (boundary === 'queued') f.reconnect()
    await new Promise<void>(resolve => setImmediate(resolve))
    if (boundary === 'failure') expect(f.notice.set).toHaveBeenCalledWith('current palette failed')
    else {
      expect(await f.raw(preferences())).toMatchObject({ kind: 'cancelled' })
      expect(f.notice.set).not.toHaveBeenCalled()
    }
    expect(f.remote.settings.mutate.mock.calls.length).toBeLessThanOrEqual(3)
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
    expect(await f.raw(keySubmission())).toMatchObject({ kind: 'accepted' })
    expect(await f.raw(keySubmission(''))).toMatchObject({ kind: 'accepted' })
    expect(f.remote.credentials.set).toHaveBeenCalledOnce()
  })

  it('validates a missing key and redacts credential values from failed official writes', async () => {
    const f = await fixture()
    await f.open()
    await f.raw(submit(ONBOARDING_CONNECT, [], 'key'))
    expect(await f.raw(keySubmission())).toMatchObject({ kind: 'invalid' })
    f.remote.credentials.set.mockRejectedValueOnce(new Error('rejected fixture-api-secret'))
    expect(await f.raw(keySubmission('fixture-api-secret'))).toMatchObject({ kind: 'failed', message: 'rejected [redacted]' })
    expect(f.text()).not.toContain('fixture-api-secret')
  })

  it.each(['read', 'write', 'model', 'write-error'] as const)('fences API-key %s results after the Host reconnects', async boundary => {
    const f = await fixture()
    await f.open()
    await f.raw(submit(ONBOARDING_CONNECT, [], 'key'))
    if (boundary === 'read') f.remote.credentials.describe.mockImplementationOnce(async () => { f.reconnect(); return { ok: true, value: {} } })
    if (boundary === 'write' || boundary === 'write-error') f.remote.credentials.set.mockImplementationOnce(async () => {
      f.reconnect()
      if (boundary === 'write-error') throw new Error('retired secret error')
      return { ok: true, value: undefined }
    })
    const settling = f.raw(keySubmission('fixture-api-secret'))
    if (boundary === 'model') {
      await vi.waitFor(() => { expect(f.ctx.mayflyOverlays.list().some(entry => entry.id === 'mayfly.models')).toBe(true) })
      f.reconnect()
    }
    expect(await settling).toMatchObject({ kind: 'cancelled' })
    if (boundary === 'read') expect(f.remote.credentials.set).not.toHaveBeenCalled()
    expect(f.notice.set).not.toHaveBeenCalledWith('retired secret error')
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

  it('drives the real account flow through manual, copy, restart, retry and pasted-callback outcomes', async () => {
    const f = await fixture()
    await f.open()
    await f.dispatch(submit(ONBOARDING_CONNECT, [], 'account'))
    await vi.waitFor(() => { expect(f.io.openBrowser).toHaveBeenCalledOnce() })
    const activate = (actionId: string) => f.raw({ kind: 'activate', controlId: 'sign-in-actions', actionId, pagePath: [] })
    expect(await activate(ONBOARDING_SIGN_IN.copy)).toMatchObject({ kind: 'completed', feedback: { severity: 'success' } })
    expect(f.io.copy).toHaveBeenCalledWith('https://platform.example/sign-in/attempt-1')
    await activate(ONBOARDING_SIGN_IN.other)
    expect(f.text()).toContain(ONBOARDING_SIGN_IN.form)
    await activate('unknown')
    await activate(ONBOARDING_SIGN_IN.restart)
    await activate(ONBOARDING_SIGN_IN.retry)
    expect(f.account.startSignIn).toHaveBeenCalledTimes(3)
    const callback = (value?: string): MayflyUiActionEvent => {
      const event = submit(ONBOARDING_CONNECT, [{ formId: ONBOARDING_SIGN_IN.form, fields: value === undefined ? [] : [{ id: ONBOARDING_SIGN_IN.field, value }] }])
      return { ...event, submission: { ...(event as Extract<MayflyUiActionEvent, { kind: 'submit' }>).submission, actionId: ONBOARDING_SIGN_IN.deliver } } as MayflyUiActionEvent
    }
    expect(await f.raw(callback())).toMatchObject({ kind: 'invalid' })
    expect(await f.raw(callback('not a callback'))).toMatchObject({ kind: 'invalid' })
    f.io.deliverCallback.mockResolvedValueOnce({ status: 400 })
    expect(await f.raw(callback('http://127.0.0.1:6789/oauth/callback?code=fixture-code'))).toMatchObject({ kind: 'failed', message: expect.stringContaining('not accepted') })
    expect(await f.raw(callback('http://127.0.0.1:6789/oauth/callback?code=fixture-code'))).toMatchObject({ kind: 'accepted' })
    f.io.copy.mockRejectedValueOnce(new Error('clipboard unavailable'))
    expect(await activate(ONBOARDING_SIGN_IN.copy)).toMatchObject({ kind: 'failed', message: 'clipboard unavailable' })
    expect(f.text()).toContain('Signing you in')
  })

  it('keeps failed browser sign-in visible and handles unavailable factories without writing a credential', async () => {
    const f = await fixture()
    await f.open()
    f.account.getState.mockRejectedValueOnce(new Error('account reader unavailable'))
    expect(await f.raw(submit(ONBOARDING_CONNECT, [], 'account'))).toEqual({ kind: 'cancelled' })
    f.io.callbackOrigin.mockReturnValue(undefined)
    expect(await f.raw(submit(ONBOARDING_CONNECT, [], 'account'))).toMatchObject({ kind: 'accepted' })
    await vi.waitFor(() => { expect(f.notice.set).toHaveBeenCalledWith(expect.stringContaining('loopback callback origin')) })
    expect(f.text()).toContain('loopback callback origin')
    expect(f.remote.credentials.set).not.toHaveBeenCalled()
  })

  it('suppresses a failed start from a retired flow and cancels only an explicitly backed-out attempt', async () => {
    const f = await fixture()
    await f.open()
    const opening = Promise.withResolvers<boolean>()
    f.io.openBrowser.mockReturnValueOnce(opening.promise)
    await f.raw(submit(ONBOARDING_CONNECT, [], 'account'))
    await vi.waitFor(() => { expect(f.io.openBrowser).toHaveBeenCalledOnce() })
    f.account.cancelSignIn.mockRejectedValueOnce(new Error('Host cancellation unavailable'))
    expect(f.browser().back!()).toBe(true)
    opening.reject(new Error('retired browser opener'))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.notice.set).not.toHaveBeenCalledWith('retired browser opener')
    expect(f.account.cancelSignIn).toHaveBeenCalledOnce()
  })

  it('fences account copy and callback delivery after a reconnect', async () => {
    for (const task of ['copy', 'deliver'] as const) {
      const f = await fixture()
      await f.open()
      await f.raw(submit(ONBOARDING_CONNECT, [], 'account'))
      await vi.waitFor(() => { expect(f.io.openBrowser).toHaveBeenCalledOnce() })
      if (task === 'copy') {
        f.io.copy.mockImplementationOnce(async () => { f.reconnect() })
        expect(await f.raw({ kind: 'activate', controlId: 'sign-in-actions', actionId: ONBOARDING_SIGN_IN.copy, pagePath: [] })).toEqual({ kind: 'cancelled' })
      } else {
        f.io.deliverCallback.mockImplementationOnce(async () => { f.reconnect(); return { status: 200 } })
        const event = submit(ONBOARDING_CONNECT, [{ formId: ONBOARDING_SIGN_IN.form, fields: [{ id: ONBOARDING_SIGN_IN.field, value: 'http://127.0.0.1:6789/oauth/callback?code=fixture-code' }] }]) as Extract<MayflyUiActionEvent, { kind: 'submit' }>
        expect(await f.raw({ ...event, submission: { ...event.submission, actionId: ONBOARDING_SIGN_IN.deliver } })).toEqual({ kind: 'cancelled' })
      }
    }
  })

  it('does not admit a flow returned just as its external account watcher changes the Host generation', async () => {
    const f = await fixture()
    await f.open()
    const watch = f.account.watch.getMockImplementation()!
    f.account.watch.mockImplementationOnce(signal => { f.reconnect(); return watch(signal) })
    expect(await f.raw(submit(ONBOARDING_CONNECT, [], 'account'))).toEqual({ kind: 'cancelled' })
    expect(f.account.startSignIn).not.toHaveBeenCalled()
    expect(f.stream.signals[0]!.aborted).toBe(true)
  })

  it('fences a connected account while its exact model picker is still displayed', async () => {
    const f = await fixture()
    await f.open()
    await f.raw(submit(ONBOARDING_CONNECT, [], 'account'))
    await vi.waitFor(() => { expect(f.io.openBrowser).toHaveBeenCalledOnce() })
    f.stream.emit(accountView('succeeded'))
    await vi.waitFor(() => { expect(f.ctx.mayflyOverlays.list().some(entry => entry.id === 'mayfly.models')).toBe(true) })
    f.reconnect()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
  })

  it('does not open model selection if a connected account refresh synchronously retires its Host', async () => {
    const f = await fixture()
    await f.open()
    await f.raw(submit(ONBOARDING_CONNECT, [], 'account'))
    await vi.waitFor(() => { expect(f.io.openBrowser).toHaveBeenCalledOnce() })
    const off = f.ctx.mayflyOverlays.subscribe(delta => {
      if (delta.kind === 'upsert' && delta.entry.id === ID && JSON.stringify(delta.entry.node).includes('Connected with a DeepSeek account')) f.reconnect()
    })
    f.stream.emit(accountView('succeeded'))
    await new Promise<void>(resolve => setImmediate(resolve))
    off()
    expect(f.remote.session.modelCatalog).not.toHaveBeenCalled()
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
  })

  it('keeps a successfully stored API key when its optional model picker cannot load', async () => {
    const f = await fixture()
    await f.open()
    await f.raw(submit(ONBOARDING_CONNECT, [], 'key'))
    f.remote.session.modelCatalog.mockRejectedValueOnce(new Error('model catalog unavailable'))
    expect(await f.raw(keySubmission('fixture-api-secret'))).toMatchObject({ kind: 'accepted', navigate: [{ itemId: ONBOARDING_READY }] })
    expect(f.remote.credentials.set).toHaveBeenCalledOnce()
    expect(f.ctx.mayflyOverlays.list().some(entry => entry.id === 'mayfly.models')).toBe(false)
  })

  it('ticks account countdown only while waiting and never restarts remote work', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    f.controller.open(f.client)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    await f.raw(submit(ONBOARDING_CONNECT, [], 'account'))
    await vi.advanceTimersByTimeAsync(0)
    const remaining = f.text()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.text()).not.toBe(remaining)
    expect(f.account.startSignIn).toHaveBeenCalledOnce()
    f.stream.emit(accountView('failed'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.account.startSignIn).toHaveBeenCalledOnce()
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
