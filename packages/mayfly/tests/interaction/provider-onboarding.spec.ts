/** Frontend-owned onboarding and native credential lifecycle evidence.
 * @module @ephemeral-ai/mayfly/tests/interaction/provider-onboarding
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MayflyCurrentAgentService } from '../../src/app/current-agent.ts'
import { MayflyConversationsService } from '../../src/app/conversation-views.ts'
import { DEFAULT_SETTINGS } from '../../src/interaction/settings.ts'
import { InteractionStateService } from '../../src/interaction/runtime-state.ts'
import type { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import { DEEPSEEK_KEY } from '../../src/interaction/provider-onboarding.ts'
import { ONBOARDING_PERMISSION_FIELD, ONBOARDING_PREFERENCES_FORM, ONBOARDING_SIGN_IN, ONBOARDING_STARTUP_FIELD } from '../../src/components/onboarding-wizard.ts'
import { accountInternals } from '../../src/interaction/provider-account.ts'
import { setClipboardOsc52Emitter, setClipboardTextWriter } from '../../src/interaction/clipboard-write.ts'
import { providerFixture } from './provider-fixture.ts'
import type { MayflyFieldValue, MayflyUiActionEvent } from '../../../ui/src/interaction.ts'
import { flush } from '../helpers.ts'

const pickerCalls = vi.hoisted(() => [] as Array<string | undefined>)
const pickerGate = vi.hoisted(() => ({ current: undefined as Promise<void> | undefined }))
const applyThemeMock = vi.hoisted(() => vi.fn(async (_ctx: unknown, _theme: string) => ({ kind: 'success' as const })))
vi.mock('../../src/interaction/model-commands.ts', () => ({ openModelPicker: async (_ctx: unknown, _signal: unknown, provider?: string) => { pickerCalls.push(provider); if (pickerGate.current !== undefined) await pickerGate.current; return { kind: 'success' } } }))
vi.mock('../../src/interaction/theme-switch.ts', () => ({ applyTheme: applyThemeMock }))

const contexts: Context[] = []
const savedDisplay = process.env.DISPLAY
const savedWayland = process.env.WAYLAND_DISPLAY
afterEach(async () => {
  pickerCalls.length = 0
  pickerGate.current = undefined
  vi.restoreAllMocks()
  setClipboardTextWriter(undefined)
  setClipboardOsc52Emitter(undefined)
  if (savedDisplay === undefined) delete process.env.DISPLAY
  else process.env.DISPLAY = savedDisplay
  if (savedWayland === undefined) delete process.env.WAYLAND_DISPLAY
  else process.env.WAYLAND_DISPLAY = savedWayland
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function setup(profiles: Record<string, unknown> = {}, configured = false, llm?: unknown) {
  const ctx = new Context()
  contexts.push(ctx)
  new InteractionStateService(ctx, DEFAULT_SETTINGS)
  const bench = await providerFixture(ctx, profiles, llm, { onboarding: true })
  if (configured) bench.credentials.values.set(DEEPSEEK_KEY, 'configured')
  const agent = { id: 'root', session: {} } as Agent
  ctx.provide('agents', { get: (id: string) => id === agent.id ? agent : undefined } as never)
  const mount = () => ctx.plugin({ name: 'onboarding-app', inject: ['agents'], apply(owner: Context) {
    const conversations = new MayflyConversationsService(owner)
    new MayflyCurrentAgentService(owner, conversations)
    // The fixture's boot signal: a primary selection is the app going ready.
    conversations.subscribe(() => { if (conversations.primary() !== null) (ctx.mayflySessionStart as unknown as { markBooted(): void }).markBooted() })
  } })
  const app = await mount()
  return { ...bench, agent, app, mount, model: () => ctx.mayflyUiInteraction.get('overlay', 'mayfly.provider.onboarding') }
}

const stepPath = (id: string) => [{ controlId: 'onboarding', itemId: id }]
const connectPath = stepPath('connect')
const keyFormAddress = { pagePath: connectPath, formId: 'key-form' }

/** Leave Preferences and choose one connection path on the Connect step. */
async function chooseConnection(model: UiSurfaceModel, choice: 'key' | 'skip' | 'account'): Promise<void> {
  // A wizard step settles through a submit event carrying its form draft.
  const form = model.form({ pagePath: stepPath('preferences'), formId: 'preferences-form' })!
  const fields = Object.entries(form.fields).map(([id, field]) => ({ id, value: field.value, change: 'unchanged' as const }))
  model.emit({
    kind: 'submit', pagePath: stepPath('preferences'), controlId: 'onboarding',
    submission: { actionId: 'onboarding.next.preferences', draftRevision: 1, source: [], forms: [{ pagePath: stepPath('preferences'), formId: 'preferences-form', draftRevision: 1, fields }] },
  })
  await flush()
  model.updateChoice({ pagePath: connectPath, controlId: 'connect-options' }, { kind: 'select', ids: [choice] })
  model.emit({ kind: 'selection-accept', pagePath: connectPath, controlId: 'connect-options', selectedIds: [choice] })
  await flush()
}

/** Enter the key page, whose form is the only control. */
async function enterKey(model: UiSurfaceModel): Promise<void> {
  await chooseConnection(model, 'key')
}

/** Submit the key form's current draft. */
function submitKey(model: UiSurfaceModel): void {
  model.invoke('onboarding.next.connect', connectPath)
}

/** Take the Ready step's start row, which dismisses the guide. */
function finishGuide(model: UiSurfaceModel): void {
  const readyPath = stepPath('ready')
  model.activateTab({ pagePath: [], controlId: 'onboarding' }, 'ready')
  model.invoke('onboarding.next.ready', readyPath)
}


/** The account adapter route listing for guide discovery. */
const accountLlm = {
  listProviders: () => [],
  listConfigurableProviders: () => [{ provider: 'deepseek-account', settingsNs: 'llm-deepseek-account' }],
}

/** Minimal account double: only the state the guide reads. */
function fakeAccount(status: 'signed-out' | 'credential-stored') {
  const links = { usageUrl: 'https://example/u', topUpUrl: 'https://example/t' }
  let attempt: { id: string, phase: string, authorizeUrl: string, expiresAt: number } | null = null
  return {
    async getState() { return { status, links, attempt } },
    async startSignIn() {
      attempt = { id: 'a', phase: 'waiting', authorizeUrl: 'https://example/auth', expiresAt: Date.now() + 60_000 }
      return { status, links, attempt }
    },
    async cancelSignIn() { attempt = null; return this.getState() },
    async signOut() { return this.getState() },
    watch(signal: AbortSignal): AsyncIterable<unknown> {
      void signal
      return { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }
    },
  }
}

describe('provider onboarding', () => {
  it('waits for app readiness and saves only the official credential through explicit Save', async () => {
    const bench = await setup()
    await flush()
    expect(bench.model()).toBeUndefined()
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    const model = bench.model()!
    expect(model.scope).toEqual({ kind: 'app', targetId: DEEPSEEK_KEY })
    await enterKey(model)
    await flush()
    model.edit({ ...keyFormAddress, fieldId: 'key' }, 'new-key')
    expect(bench.credentials.writes).toBe(0)
    submitKey(model)
    submitKey(model)
    await flush()
    finishGuide(model)
    await flush()
    expect(bench.credentials.values.get(DEEPSEEK_KEY)).toBe('new-key')
    expect(bench.credentials.writes).toBe(1)
    expect(bench.settings.writes).toBe(0)
    expect(bench.model()).toBeUndefined()
    // A saved key ends on that provider's model list, not on another route's default.
    expect(pickerCalls).toEqual(['deepseek-official'])
  })

  it.each([true, false])('skips setup when a native credential is configured (official=%s)', async official => {
    const directory = {
      listProviders: () => [{ id: 'custom', name: 'Custom API' }],
      listConfigurableProviders: () => [{ settingsNs: 'llm-pi-ai', provider: 'custom', displayName: 'Custom API', settingsPath: ['providers', 'custom'] }],
    }
    const bench = await setup(official ? {} : { custom: { apiKeyEnv: 'CUSTOM_KEY' } }, official, official ? undefined : directory)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    expect(bench.model()).toBeUndefined()
  })

  it('retains the app-scoped key draft through current-Agent service reload and can save during the gap', async () => {
    const bench = await setup()
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    const model = bench.model()!
    await enterKey(model)
    await flush()
    model.edit({ ...keyFormAddress, fieldId: 'key' }, 'retained-key')
    await bench.app.dispose()
    expect(model.disposed).toBe(false)
    expect(model.form(keyFormAddress)!.fields.key!.value).toBe('retained-key')
    submitKey(model)
    await flush()
    finishGuide(model)
    await flush()
    expect(bench.credentials.values.get(DEEPSEEK_KEY)).toBe('retained-key')
    await bench.mount()
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    expect(bench.model()).toBeUndefined()
  })

  it('keeps failed input and permits a retry without reopening the form', async () => {
    const bench = await setup()
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    const model = bench.model()!
    await enterKey(model)
    await flush()
    bench.credentials.failWrite = true
    model.edit({ ...keyFormAddress, fieldId: 'key' }, 'retry-key')
    submitKey(model)
    await flush()
    expect(model.form(keyFormAddress)!.fields.key!.value).toBe('retry-key')
    expect(model.feedbackSnapshot().at(-1)?.severity).toBe('error')
    bench.credentials.failWrite = false
    submitKey(model)
    await flush()
    finishGuide(model)
    await flush()
    expect(bench.credentials.writes).toBe(1)
    expect(model.disposed).toBe(true)
  })

  it('does not offer setup again after a deliberate skip and app reload', async () => {
    const bench = await setup()
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    chooseConnection(bench.model()!, 'skip')
    bench.model()!.requestClose()
    await flush()
    await bench.app.dispose()
    await bench.mount()
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    expect(bench.model()).toBeUndefined()
    expect(bench.credentials.writes).toBe(0)
  })

  it('contains a late credential read after the frontend owner has unloaded', async () => {
    const bench = await setup()
    const read = Promise.withResolvers<{ configured: boolean, writable: boolean, source: string }>()
    vi.spyOn(bench.credentials, 'describe').mockReturnValue(read.promise)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    await bench.front.dispose()
    read.resolve({ configured: false, writable: true, source: 'memory' })
    await flush()
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])
  })

  it('enumerates native providers and ignores malformed configured references', async () => {
    const bench = await setup({}, false, {
      listProviders: () => [{ id: 'anthropic', name: 'Anthropic' }],
      listConfigurableProviders: () => [
        { settingsNs: 'llm-pi-ai', provider: 'anthropic', settingsPath: ['providers', 'anthropic'] },
        { settingsNs: 'llm-pi-ai', provider: 'missing', settingsPath: ['providers', 'missing'] },
        { settingsNs: 'llm-pi-ai', provider: 'primitive', settingsPath: ['providers', 'primitive'] },
        { settingsNs: 'llm-pi-ai', provider: 'numeric', settingsPath: ['providers', 'numeric'] },
        { settingsNs: 'llm-pi-ai', provider: 'empty', settingsPath: ['providers', 'empty'] },
        { settingsNs: 'llm-pi-ai', provider: 'valid', settingsPath: ['providers', 'valid'] },
      ],
    })
    const describe = vi.spyOn(bench.settings, 'describe').mockReturnValue([{ ns: 'llm-pi-ai', value: { providers: {
      missing: null,
      primitive: 'invalid',
      numeric: { apiKeyEnv: 42 },
      empty: { apiKeyEnv: '' },
      valid: { apiKeyEnv: 'EXTRA_KEY' },
    } } } as never])
    const credentials = vi.spyOn(bench.credentials, 'describe').mockImplementation(async ref => {
      if (String(ref) === 'ANTHROPIC_API_KEY') throw new Error('unreadable')
      return { configured: false, writable: true, source: 'memory' }
    })
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    expect(describe).toHaveBeenCalled()
    expect(credentials.mock.calls.map(([ref]) => String(ref))).toEqual(expect.arrayContaining([DEEPSEEK_KEY, 'ANTHROPIC_API_KEY', 'EXTRA_KEY']))
    expect(bench.model()).toBeDefined()
  })

  it.each([null, 42, { providers: null }, { providers: 'invalid' }])('treats malformed settings as having no extra references (%j)', async section => {
    const bench = await setup()
    vi.spyOn(bench.settings, 'describe').mockReturnValue([{ ns: 'llm-pi-ai', value: section } as never])
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    expect(bench.model()).toBeDefined()
  })

  it('validates forged empty submissions and rejects read-only credential sources', async () => {
    const bench = await setup()
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    const model = bench.model()!
    await enterKey(model)
    await flush()
    const entry = bench.ctx.mayflyOverlays.list().find(item => item.id === 'mayfly.provider.onboarding')!
    const event = (value: unknown): MayflyUiActionEvent => ({
      kind: 'submit',
      pagePath: connectPath,
      controlId: 'onboarding',
      submission: { actionId: 'onboarding.next.connect', draftRevision: 1, source: [], forms: [{ pagePath: connectPath, formId: 'key-form', draftRevision: 1, fields: [{ id: 'key', value: value as MayflyFieldValue, change: 'set' }] }] },
    })
    const context = (actionSignal = new AbortController().signal) => ({ surfaceId: entry.id, operationId: 'test', source: [], revision: entry.revision, signal: actionSignal, report: vi.fn() })
    expect((await entry.events.prepare(event(undefined), context())).reply).toMatchObject({ kind: 'invalid' })

    vi.spyOn(bench.credentials, 'describe').mockResolvedValue({ configured: false, writable: false, source: 'environment' })
    expect((await entry.events.prepare(event('key'), context())).reply).toEqual({ kind: 'failed', message: 'The credential source is read-only' })
  })

  it('requires review before replacing a credential configured after the initial check', async () => {
    const bench = await setup()
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    const model = bench.model()!
    bench.credentials.values.set(DEEPSEEK_KEY, 'external')
    await enterKey(model)
    await flush()
    model.edit({ ...keyFormAddress, fieldId: 'key' }, 'replacement')
    submitKey(model)
    await flush()
    expect(model.feedbackSnapshot().at(-1)?.message).toContain('configured elsewhere')
    expect(bench.credentials.values.get(DEEPSEEK_KEY)).toBe('external')
    submitKey(model)
    await flush()
    expect(bench.credentials.values.get(DEEPSEEK_KEY)).toBe('replacement')
  })

  it('settles as cancelled when an action aborts after describe or write', async () => {
    const bench = await setup()
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    const model = bench.model()!
    await enterKey(model)
    await flush()
    const entry = bench.ctx.mayflyOverlays.list().find(item => item.id === 'mayfly.provider.onboarding')!
    const event: MayflyUiActionEvent = {
      kind: 'submit',
      pagePath: connectPath,
      controlId: 'onboarding',
      submission: { actionId: 'onboarding.next.connect', draftRevision: 1, source: [], forms: [{ pagePath: connectPath, formId: 'key-form', draftRevision: 1, fields: [{ id: 'key', value: 'key', change: 'set' }] }] },
    }
    const request = async (actionSignal: AbortSignal, operationId: string) => await entry.definition.onEvent!.action!(event, { surfaceId: entry.id, operationId, source: [], revision: entry.revision, signal: actionSignal, report: vi.fn() })
    const reading = Promise.withResolvers<{ configured: boolean, writable: boolean, source: string }>()
    const describe = vi.spyOn(bench.credentials, 'describe').mockReturnValueOnce(reading.promise)
    const duringRead = new AbortController()
    const readResult = request(duringRead.signal, 'during-read')
    await vi.waitFor(() => expect(describe).toHaveBeenCalled())
    duringRead.abort()
    reading.resolve({ configured: false, writable: true, source: 'memory' })
    expect(await readResult).toEqual({ kind: 'cancelled' })
    describe.mockRestore()

    const pending = Promise.withResolvers<void>()
    vi.spyOn(bench.credentials, 'set').mockReturnValue(pending.promise)
    const duringWrite = new AbortController()
    const result = request(duringWrite.signal, 'during-write')
    await vi.waitFor(() => expect(bench.credentials.set).toHaveBeenCalled())
    duringWrite.abort()
    pending.resolve()
    expect(await result).toEqual({ kind: 'cancelled' })
  })

  it('shows a fallback surface when readiness cannot inspect settings', async () => {
    const bench = await setup({}, false, {
      listProviders: () => [],
      listConfigurableProviders: () => [{ settingsNs: 'llm-pi-ai', provider: 'custom', settingsPath: ['providers', 'custom'] }],
    })
    vi.spyOn(bench.settings, 'describe').mockImplementation(() => { throw new Error('unavailable') })
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    expect(JSON.stringify(bench.model()!.node)).toContain('Provider setup could not be checked')
  })

  it('focuses an existing fallback surface after a readiness failure', async () => {
    const bench = await setup()
    bench.ctx.mayflyOverlays.open({ id: 'mayfly.provider.onboarding', title: 'Existing', presentation: 'editor', capturing: true }, { kind: 'text', content: 'existing' })
    vi.spyOn(bench.settings, 'describe').mockImplementation(() => { throw new Error('unavailable') })
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    expect(bench.ctx.mayflyOverlays.list().find(item => item.id === 'mayfly.provider.onboarding')?.focusRevision).toBe(1)
  })

  it('contains loader completion and failure after frontend unload', async () => {
    for (const outcome of ['resolve', 'reject'] as const) {
      const ctx = new Context()
      contexts.push(ctx)
      const loading = Promise.withResolvers<void>()
      ctx.provide('loader', { await: () => loading.promise } as never)
      const bench = await providerFixture(ctx, {}, undefined, { onboarding: true })
      const agent = { id: `root-${outcome}`, session: {} } as Agent
      ctx.provide('agents', { get: () => agent } as never)
      await ctx.plugin({ name: `onboarding-app-${outcome}`, inject: ['agents'], apply(owner: Context) {
        const conversations = new MayflyConversationsService(owner)
        new MayflyCurrentAgentService(owner, conversations)
        conversations.subscribe(() => { if (conversations.primary() !== null) (ctx.mayflySessionStart as unknown as { markBooted(): void }).markBooted() })
      } })
      ctx.mayflyConversations.selectPrimary(agent)
      await flush()
      await bench.front.dispose()
      if (outcome === 'resolve') loading.resolve()
      else loading.reject(new Error('loader failed'))
      await flush()
      expect(ctx.mayflyOverlays.list()).toEqual([])
    }
  })

  it('skips the guide entirely when a DeepSeek account grant is already stored', async () => {
    const bench = await setup({}, false, accountLlm)
    bench.ctx.provide('deepseekAccount', fakeAccount('credential-stored') as never)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    expect(bench.model()).toBeUndefined()
  })

  it('offers account sign-in and shows the waiting sign-in page in the guide', async () => {
    const bench = await setup({}, false, accountLlm)
    bench.ctx.provide('deepseekAccount', fakeAccount('signed-out') as never)
    bench.ctx.provide('webServer', { port: 45678 } as never)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    const model = bench.model()!
    expect(JSON.stringify(model.node)).toContain('Sign in with a DeepSeek account')
    await chooseConnection(model, 'account')
    await flush()
    const page = JSON.stringify(bench.model()!.node)
    // No browser is available under the test: the guide offers the link and the paste-back field.
    expect(page).toContain('Copy the link below')
    expect(page).toContain('https://example/auth')
    expect(bench.ctx.mayflyOverlays.list().map(entry => entry.id)).toEqual(['mayfly.provider.onboarding'])
  })

  it('returns to the choice when the account step is closed before connecting', async () => {
    const bench = await setup({}, false, accountLlm)
    bench.ctx.provide('deepseekAccount', fakeAccount('signed-out') as never)
    bench.ctx.provide('webServer', { port: 45678 } as never)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    await chooseConnection(bench.model()!, 'account')
    await flush()
    bench.model()!.emit({ kind: 'dismiss', pagePath: [] })
    await flush()
    expect(JSON.stringify(bench.model()!.node)).toContain('Sign in with a DeepSeek account')
  })

  it('opens on Preferences and applies the language chosen in the guide', async () => {
    const bench = await setup({}, false, accountLlm)
    bench.settings.register('locale', z.object({ preference: z.string().volatile() }))
    bench.settings.register('mayfly', z.object({ theme: z.string().default('dark').volatile() }))
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    const model = bench.model()!
    expect(JSON.stringify(model.node)).toContain('Preferences')
    model.emit({ kind: 'value-change', pagePath: stepPath('preferences'), formId: 'preferences-form', controlId: 'language', value: 'zh', draftRevision: 1 })
    await flush(); await flush()
    expect(bench.ctx.mayflyLocale.preference).toBe('zh')
    expect(JSON.stringify(bench.model()!.node)).toContain('偏好设置')
  })

  it('does not reopen the guide when the frontend unloads on the Preferences step', async () => {
    const bench = await setup({}, false, accountLlm)
    bench.settings.register('locale', z.object({ preference: z.string().volatile() }))
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    expect(bench.model()).toBeDefined()
    // The frontend's services go with it; the unload must not reopen the guide or throw.
    await expect(bench.front.dispose()).resolves.toBeUndefined()
    await flush()
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])
  })

  it('continues to the account provider\'s model list once the guide sign-in completes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const bench = await setup({}, false, accountLlm)
      const links = { usageUrl: 'https://example/u', topUpUrl: 'https://example/t' }
      const done = { status: 'credential-stored', links, attempt: { id: 'a', phase: 'succeeded' } }
      bench.ctx.provide('deepseekAccount', {
        async getState() { return { status: 'signed-out', links, attempt: null } },
        async startSignIn() { return { status: 'signed-out', links, attempt: { id: 'a', phase: 'waiting', authorizeUrl: 'https://example/auth', expiresAt: Date.now() + 60_000 } } },
        async cancelSignIn() {},
        watch(): AsyncIterable<unknown> {
          return { async *[Symbol.asyncIterator]() { yield { status: 'signed-out', links, attempt: null }; await new Promise<void>(resolve => setTimeout(resolve, 10)); yield done } }
        },
      } as never)
      bench.ctx.provide('webServer', { port: 45678 } as never)
      bench.ctx.mayflyConversations.selectPrimary(bench.agent)
      await vi.advanceTimersByTimeAsync(50)
      await chooseConnection(bench.model()!, 'account')
      expect(pickerCalls).toEqual([])
      await vi.advanceTimersByTimeAsync(2000)
      expect(pickerCalls).toEqual(['deepseek-account'])
    } finally { vi.useRealTimers() }
  })

  it('falls back to the key-only guide when no account service is composed', async () => {
    const bench = await setup({}, false, accountLlm)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    const model = bench.model()!
    const json = JSON.stringify(model.node)
    expect(json).not.toContain('Sign in with a DeepSeek account')
    expect(json).toContain('Enter a DeepSeek API key')
    await enterKey(model)
    await flush()
    expect(JSON.stringify(model.node)).toContain('DEEPSEEK_API_KEY')
  })

  it('still offers the guide when the account state read fails', async () => {
    const bench = await setup({}, false, accountLlm)
    bench.ctx.provide('deepseekAccount', {
      async getState() { throw new Error('unavailable') },
      async signOut() { throw new Error('unavailable') },
      watch(signal: AbortSignal): AsyncIterable<unknown> { void signal; return { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) } },
    } as never)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    expect(bench.model()).toBeDefined()
  })
})

/** Submit the Preferences step with explicit values for some of its fields. */
function submitPreferences(model: UiSurfaceModel, values: Readonly<Record<string, unknown>> = {}): void {
  const address = { pagePath: stepPath('preferences'), formId: ONBOARDING_PREFERENCES_FORM }
  for (const [fieldId, value] of Object.entries(values)) model.edit({ ...address, fieldId }, value as never)
  const form = model.form(address)!
  const fields = Object.entries(form.fields).map(([id, field]) => ({ id, value: field.value, change: 'unchanged' as const }))
  model.emit({
    kind: 'submit', pagePath: stepPath('preferences'), controlId: 'onboarding',
    submission: { actionId: 'onboarding.next.preferences', draftRevision: 1, source: [], forms: [{ pagePath: stepPath('preferences'), formId: ONBOARDING_PREFERENCES_FORM, draftRevision: 1, fields }] },
  })
}

/** A native permission-preset double: safe is the deployment default. */
function fakePresets(changes: { readonly current?: string, readonly setThrows?: unknown } = {}) {
  const current = changes.current ?? 'safe'
  return {
    names: ['safe', 'full'],
    defaultPreset: 'safe',
    catalog: () => ({ defaultPreset: 'safe', defaultOptions: [{ value: 'safe', name: 'Safe' }, { value: 'full', name: 'Full' }] }),
    current: vi.fn(() => current),
    optionOf: vi.fn((name: string) => ({ name: name === 'full' ? 'Full' : 'Safe' })),
    resolve: vi.fn(),
    set: vi.fn((..._args: unknown[]) => { if (changes.setThrows !== undefined) throw changes.setThrows }),
  }
}

const accountLinks = { usageUrl: 'https://example/u', topUpUrl: 'https://example/t' }
const waitingAttempt = { id: 'a', phase: 'waiting-browser' as const, authorizeUrl: 'https://example/auth', expiresAt: Date.now() + 60_000 }

/** A native account double whose watch queue a test pushes views into. */
function scriptedAccount(initial: { readonly status?: 'signed-out' | 'credential-stored', readonly attempt?: unknown } = {}) {
  const queue: Array<Record<string, unknown>> = []
  const waiters: Array<() => void> = []
  const first = { status: initial.status ?? 'signed-out', links: accountLinks, attempt: initial.attempt ?? waitingAttempt }
  const service = {
    getState: vi.fn(async () => first),
    startSignIn: vi.fn(async () => first),
    cancelSignIn: vi.fn(async () => first),
    watch: vi.fn((signal: AbortSignal): AsyncIterable<Record<string, unknown>> => ({
      async *[Symbol.asyncIterator]() {
        while (!signal.aborted) {
          if (queue.length === 0) {
            await new Promise<void>(resolve => {
              waiters.push(resolve)
              signal.addEventListener('abort', () => { resolve() }, { once: true })
            })
          }
          if (signal.aborted) return
          const next = queue.shift()
          if (next !== undefined) yield next
        }
      },
    })),
  }
  return {
    service,
    push(next: Record<string, unknown>) { queue.push(next); waiters.shift()?.() },
  }
}

/** Boot the guide with an account route and a native account double on Connect. */
async function accountSetup(account = scriptedAccount()) {
  const bench = await setup({}, false, accountLlm)
  bench.ctx.provide('deepseekAccount', account.service as never)
  bench.ctx.provide('webServer', { port: 45678 } as never)
  bench.ctx.mayflyConversations.selectPrimary(bench.agent)
  await flush()
  await chooseConnection(bench.model()!, 'account')
  await flush()
  return { bench, account }
}

/** The onboarding overlay's wire entry, for events a test sends directly. */
function onboardingEntry(bench: Awaited<ReturnType<typeof setup>>) {
  return bench.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.provider.onboarding')!
}

async function prepareEvent(bench: Awaited<ReturnType<typeof setup>>, event: MayflyUiActionEvent) {
  const entry = onboardingEntry(bench)
  return await entry.events.prepare(event, { surfaceId: entry.id, operationId: 'spec', source: [], revision: entry.revision, signal: new AbortController().signal, report: vi.fn() })
}

function activateEvent(actionId: string) {
  return { kind: 'activate' as const, pagePath: stepPath('connect'), controlId: 'sign-in-keys', actionId }
}

function deliverEvent(value: string): MayflyUiActionEvent {
  return {
    kind: 'submit', pagePath: stepPath('connect'), controlId: 'onboarding',
    submission: {
      actionId: ONBOARDING_SIGN_IN.deliver, draftRevision: 1, source: [],
      forms: [{ pagePath: stepPath('connect'), formId: ONBOARDING_SIGN_IN.form, draftRevision: 1, fields: [{ id: ONBOARDING_SIGN_IN.field, value, change: 'set' }] }],
    },
  }
}

function connectSubmit(choice?: string): MayflyUiActionEvent {
  return {
    kind: 'submit', pagePath: connectPath, controlId: 'onboarding',
    submission: {
      actionId: 'onboarding.next.connect', draftRevision: 1, source: [], forms: [],
      selections: [{ controlId: 'connect-options', pagePath: connectPath, selectedIds: choice === undefined ? [] : [choice] }],
    },
  } as MayflyUiActionEvent
}

function preferencesEvent(values: Readonly<Record<string, unknown>> = {}): MayflyUiActionEvent {
  const fields = [
    { id: 'language', value: values.language ?? 'en', change: 'set' as const },
    { id: 'theme', value: values.theme ?? 'dark', change: 'set' as const },
    { id: ONBOARDING_STARTUP_FIELD, value: values[ONBOARDING_STARTUP_FIELD] ?? 'conversation', change: 'set' as const },
    ...values[ONBOARDING_PERMISSION_FIELD] === undefined ? [] : [{ id: ONBOARDING_PERMISSION_FIELD, value: values[ONBOARDING_PERMISSION_FIELD], change: 'set' as const }],
  ]
  return {
    kind: 'submit', pagePath: stepPath('preferences'), controlId: 'onboarding',
    submission: { actionId: 'onboarding.next.preferences', draftRevision: 1, source: [], forms: [{ pagePath: stepPath('preferences'), formId: ONBOARDING_PREFERENCES_FORM, draftRevision: 1, fields }] },
  } as MayflyUiActionEvent
}

describe('provider onboarding preferences', () => {
  it('saves the language, startup, and permission preset chosen on the first step', async () => {
    const bench = await setup({}, false, accountLlm)
    const presets = fakePresets()
    bench.ctx.provide('permissionPresets', presets as never)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    const model = bench.model()!
    expect(JSON.stringify(model.node)).toContain('Safe')
    submitPreferences(model, { language: 'zh', theme: 'light', [ONBOARDING_STARTUP_FIELD]: 'splash', [ONBOARDING_PERMISSION_FIELD]: 'full' })
    await vi.waitFor(() => { expect(presets.set).toHaveBeenCalledOnce() })
    expect(presets.current).toHaveBeenCalled()
    expect(presets.set.mock.calls[0]?.[1]).toBe('full')
    expect(bench.ctx.mayflyLocale.preference).toBe('zh')
    expect(applyThemeMock.mock.calls.at(-1)?.[1]).toBe('light')
    model.activateTab({ pagePath: [], controlId: 'onboarding' }, 'ready')
    const ready = JSON.stringify(bench.model()!.node)
    expect(ready).toContain('简体中文')
    expect(ready).toContain('Full')
  })

  it('accepts the default preset without writing a new default or switching the session', async () => {
    const bench = await setup({}, false, accountLlm)
    const presets = fakePresets()
    bench.ctx.provide('permissionPresets', presets as never)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    submitPreferences(bench.model()!, { [ONBOARDING_PERMISSION_FIELD]: 'safe' })
    await flush(2)
    expect(presets.set).not.toHaveBeenCalled()
    expect(presets.current).toHaveBeenCalled()
  })

  it('uses the catalog default when no session Agent is selected', async () => {
    const bench = await setup({}, false, accountLlm)
    const presets = fakePresets()
    bench.ctx.provide('permissionPresets', presets as never)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    bench.ctx.mayflyConversations.selectPrimary(null)
    submitPreferences(bench.model()!, { [ONBOARDING_PERMISSION_FIELD]: 'full' })
    await flush(2)
    expect(presets.set).not.toHaveBeenCalled()
    expect(presets.optionOf).toHaveBeenCalledWith('full')
  })

  it('refuses forged or unknown preference values', async () => {
    const bench = await setup({}, false, accountLlm)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    expect((await prepareEvent(bench, preferencesEvent({ language: 'xx' }))).reply).toMatchObject({ kind: 'failed', message: 'Choose a language and a theme' })
    expect((await prepareEvent(bench, preferencesEvent({ theme: 'nope' }))).reply).toMatchObject({ kind: 'failed', message: 'Choose a language and a theme' })
    expect((await prepareEvent(bench, preferencesEvent({ [ONBOARDING_STARTUP_FIELD]: 'later' }))).reply).toMatchObject({ kind: 'failed', message: 'Choose what to show on start' })
  })

  it('refuses a permission value outside the catalog and a failing native switch', async () => {
    const bench = await setup({}, false, accountLlm)
    const presets = fakePresets()
    bench.ctx.provide('permissionPresets', presets as never)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    expect((await prepareEvent(bench, preferencesEvent({ [ONBOARDING_PERMISSION_FIELD]: 'bogus' }))).reply).toMatchObject({ kind: 'failed', message: 'permission command is unavailable' })

    const failing = await setup({}, false, accountLlm)
    const erroring = fakePresets({ current: 'safe', setThrows: new Error('denied') })
    failing.ctx.provide('permissionPresets', erroring as never)
    failing.ctx.mayflyConversations.selectPrimary(failing.agent)
    await flush()
    expect((await prepareEvent(failing, preferencesEvent({ [ONBOARDING_PERMISSION_FIELD]: 'full' }))).reply).toMatchObject({ kind: 'failed', message: 'permission dispatch failed: denied' })
    expect(erroring.set).toHaveBeenCalledOnce()
  })

  it('applies a theme switch and ignores unrelated or unknown value changes', async () => {
    const bench = await setup({}, false, accountLlm)
    bench.settings.register('mayfly', z.object({ theme: z.string().default('dark').volatile() }))
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    const model = bench.model()!
    model.emit({ kind: 'value-change', pagePath: stepPath('preferences'), formId: ONBOARDING_PREFERENCES_FORM, controlId: 'theme', value: 'light', draftRevision: 1 })
    await flush(2)
    expect(applyThemeMock.mock.calls[0]?.[1]).toBe('light')
    expect(bench.ctx.mayflyInteractionState.lastAppliedTheme).toBe('light')
    model.emit({ kind: 'value-change', pagePath: stepPath('preferences'), formId: 'other-form', controlId: 'language', value: 'zh', draftRevision: 2 })
    model.emit({ kind: 'value-change', pagePath: stepPath('preferences'), formId: ONBOARDING_PREFERENCES_FORM, controlId: 'unknown', value: 'zh', draftRevision: 3 })
    model.emit({ kind: 'value-change', pagePath: stepPath('preferences'), formId: ONBOARDING_PREFERENCES_FORM, controlId: 'language', value: 'xx', draftRevision: 4 })
    await flush()
    expect(applyThemeMock.mock.calls.length).toBeGreaterThan(0)
    expect(applyThemeMock.mock.calls.every(call => call[1] === 'light')).toBe(true)
  })

  it('swallows a theme apply failure while keeping the drafted choice', async () => {
    const bench = await setup({}, false, accountLlm)
    applyThemeMock.mockRejectedValueOnce(new Error('theme broke'))
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    bench.model()!.emit({ kind: 'value-change', pagePath: stepPath('preferences'), formId: ONBOARDING_PREFERENCES_FORM, controlId: 'theme', value: 'light', draftRevision: 1 })
    await flush(3)
    expect(bench.model()).toBeDefined()
  })
})

describe('provider onboarding connection choices', () => {
  it('refuses a forged account choice without a sign-in route and still answers an unknown choice', async () => {
    const bench = await setup()
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    const model = bench.model()!
    expect((await prepareEvent(bench, connectSubmit('account'))).reply).toMatchObject({ kind: 'failed', message: 'Account sign-in is unavailable' })
    expect((await prepareEvent(bench, connectSubmit('weird'))).reply).toMatchObject({ kind: 'accepted' })
    await flush()
    expect(JSON.stringify(model.node)).toContain('Enter a DeepSeek API key')
    expect((await prepareEvent(bench, connectSubmit())).reply).toMatchObject({ kind: 'accepted' })
    await flush()
    expect(JSON.stringify(bench.model()!.node)).toContain('Skip for now')
  })

  it('refuses account sign-in without the local web server', async () => {
    const bench = await setup({}, false, accountLlm)
    bench.ctx.provide('deepseekAccount', scriptedAccount().service as never)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    await chooseConnection(bench.model()!, 'account')
    await flush()
    expect(bench.model()!.feedbackSnapshot().at(-1)?.message).toBe('Sign-in needs the local web server, which this setup does not run — use an API key instead')
  })

  it('refuses account sign-in when the native start rejects', async () => {
    const bench = await setup({}, false, accountLlm)
    const account = scriptedAccount()
    account.service.startSignIn.mockRejectedValue(new Error('platform down'))
    bench.ctx.provide('deepseekAccount', account.service as never)
    bench.ctx.provide('webServer', { port: 45678 } as never)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    await chooseConnection(bench.model()!, 'account')
    await flush()
    expect(bench.model()!.feedbackSnapshot().at(-1)?.message).toBe('Account sign-in is unavailable')
  })

  it('returns from the key page on Escape and advances an empty key after a saved one', async () => {
    const bench = await setup()
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    const model = bench.model()!
    await enterKey(model)
    await flush()
    model.emit({ kind: 'dismiss', pagePath: connectPath })
    await flush()
    expect(JSON.stringify(bench.model()!.node)).toContain('Enter a DeepSeek API key')

    await enterKey(bench.model()!)
    await flush()
    bench.credentials.values.set(DEEPSEEK_KEY, 'existing')
    bench.model()!.emit({
      kind: 'submit', pagePath: connectPath, controlId: 'onboarding',
      submission: { actionId: 'onboarding.next.connect', draftRevision: 1, source: [], forms: [{ pagePath: connectPath, formId: 'key-form', draftRevision: 1, fields: [{ id: 'key', value: '', change: 'set' }] }] },
    })
    await vi.waitFor(() => { expect(bench.credentials.values.get(DEEPSEEK_KEY)).toBe('existing') })
    await flush()
    expect(JSON.stringify(bench.model()!.node)).toContain('Things to try')
  })
})

describe('provider onboarding account sign-in page', () => {
  it('copies the live link and reports a failing clipboard', async () => {
    const { bench } = await accountSetup()
    setClipboardOsc52Emitter(() => true)
    setClipboardTextWriter(async () => {})
    expect((await prepareEvent(bench, activateEvent(ONBOARDING_SIGN_IN.copy))).reply).toMatchObject({ kind: 'completed', feedback: { severity: 'success' } })
    setClipboardOsc52Emitter(() => false)
    setClipboardTextWriter(async () => { throw new Error('no tool') })
    expect((await prepareEvent(bench, activateEvent(ONBOARDING_SIGN_IN.copy))).reply).toMatchObject({ kind: 'failed' })
    setClipboardTextWriter(undefined)
    setClipboardOsc52Emitter(undefined)
  })

  it('shows the other-machine view and restarts or retries the attempt', async () => {
    process.env.DISPLAY = ':spec'
    const opener = Promise.withResolvers<boolean>()
    vi.spyOn(accountInternals, 'spawnOpener').mockReturnValue(opener.promise)
    const { bench, account } = await accountSetup()
    opener.resolve(true)
    await vi.waitFor(() => { expect(JSON.stringify(bench.model()!.node)).toContain('Waiting for you to sign in') })
    expect((await prepareEvent(bench, activateEvent(ONBOARDING_SIGN_IN.other))).reply).toMatchObject({ kind: 'completed' })
    await vi.waitFor(() => { expect(JSON.stringify(bench.model()!.node)).toContain('another machine') })
    expect((await prepareEvent(bench, activateEvent(ONBOARDING_SIGN_IN.restart))).reply).toMatchObject({ kind: 'completed' })
    expect(account.service.startSignIn).toHaveBeenCalledTimes(2)
    expect((await prepareEvent(bench, activateEvent(ONBOARDING_SIGN_IN.retry))).reply).toMatchObject({ kind: 'completed' })
    expect(account.service.startSignIn).toHaveBeenCalledTimes(3)
    expect((await prepareEvent(bench, activateEvent('unknown-sign-in-action'))).reply).toMatchObject({ kind: 'completed' })
  })

  it('validates, refuses, and delivers a pasted callback address', async () => {
    const { bench } = await accountSetup()
    const fetchCallback = vi.spyOn(accountInternals, 'fetchCallback')
    expect((await prepareEvent(bench, deliverEvent(''))).reply).toMatchObject({ kind: 'invalid' })
    expect((await prepareEvent(bench, deliverEvent('not a url'))).reply).toMatchObject({ kind: 'invalid' })
    expect(fetchCallback).not.toHaveBeenCalled()

    fetchCallback.mockResolvedValueOnce({ status: 400 })
    const rejected = await prepareEvent(bench, deliverEvent('http://localhost:45678/oauth/callback?code=x'))
    expect(rejected.reply).toMatchObject({ kind: 'failed', message: expect.stringContaining('not accepted') })

    fetchCallback.mockRejectedValueOnce(new Error('closed'))
    const failed = await prepareEvent(bench, deliverEvent('http://localhost:45678/oauth/callback?code=x'))
    expect(failed.reply).toMatchObject({ kind: 'failed', message: 'The callback could not be delivered' })

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      fetchCallback.mockResolvedValueOnce({ status: 200 })
      const delivered = await prepareEvent(bench, deliverEvent('http://localhost:45678/oauth/callback?code=x'))
      expect(delivered.reply).toMatchObject({ kind: 'accepted' })
      vi.advanceTimersByTime(20_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns to the choices when the sign-in is dismissed, and ignores its late connection', async () => {
    const { bench, account } = await accountSetup()
    bench.model()!.emit({ kind: 'dismiss', pagePath: [] })
    await flush()
    expect(JSON.stringify(bench.model()!.node)).toContain('Enter a DeepSeek API key')
    account.push({ status: 'credential-stored', links: accountLinks, attempt: { id: 'a', phase: 'succeeded' } })
    await flush(3)
    expect(JSON.stringify(bench.model()!.node)).toContain('Enter a DeepSeek API key')
    expect(pickerCalls).toEqual([])
  })

  it.each([
    ['expired', { id: 'a', phase: 'failed', errorCode: 'expired' }, 'The sign-in link expired — try again'],
    ['network', { id: 'a', phase: 'failed', errorCode: 'network' }, 'Could not reach DeepSeek — check the connection and try again'],
    ['storage', { id: 'a', phase: 'failed', errorCode: 'storage' }, 'The login could not be saved on this machine — try again'],
    ['cancelled', { id: 'a', phase: 'cancelled' }, 'Sign-in cancelled'],
    ['failed', { id: 'a', phase: 'failed' }, 'Sign-in failed — try again'],
  ])('renders the %s sign-in ending on the Connect page', async (_name, ending, copy) => {
    const { bench, account } = await accountSetup()
    account.push({ status: 'signed-out', links: accountLinks, attempt: ending })
    await vi.waitFor(() => { expect(JSON.stringify(bench.model()!.node)).toContain(copy) })
  })

  it('shows a fallback setup panel when readiness fails with a non-Error', async () => {
    const bench = await setup({}, false, {
      listProviders: () => [],
      listConfigurableProviders: () => [{ settingsNs: 'llm-pi-ai', provider: 'custom', settingsPath: ['providers', 'custom'] }],
    })
    vi.spyOn(bench.settings, 'describe').mockImplementation(() => { throw 'plain failure' })
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    expect(JSON.stringify(bench.model()!.node)).toContain('Provider setup could not be checked')
  })

  it('warns with the message when a readiness failure carries no stack', async () => {
    const bench = await setup({}, false, {
      listProviders: () => [],
      listConfigurableProviders: () => [{ settingsNs: 'llm-pi-ai', provider: 'custom', settingsPath: ['providers', 'custom'] }],
    })
    const warn = vi.spyOn(bench.ctx.logger, 'warn').mockImplementation(() => {})
    const broken = new Error('no stack here')
    Object.defineProperty(broken, 'stack', { value: undefined })
    vi.spyOn(bench.settings, 'describe').mockImplementation(() => { throw broken })
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    expect(warn).toHaveBeenCalledWith('provider onboarding could not open: no stack here')
  })
})

describe('provider onboarding model picker and remaining connection routes', () => {
  it('waits for an open model picker to close before the welcome page', async () => {
    const bench = await setup({}, false, accountLlm)
    const account = scriptedAccount()
    bench.ctx.provide('deepseekAccount', account.service as never)
    bench.ctx.provide('webServer', { port: 45678 } as never)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    await chooseConnection(bench.model()!, 'account')
    await flush()
    bench.ctx.mayflyOverlays.open({ id: 'mayfly.models', title: 'Models', presentation: 'editor', capturing: true } as never, { kind: 'text', content: 'models' } as never)
    account.push({ status: 'credential-stored', links: accountLinks, attempt: { id: 'a', phase: 'succeeded' } })
    await vi.waitFor(() => { expect(pickerCalls).toEqual(['deepseek-account']) })
    expect(bench.model()!.activeTab({ pagePath: [], controlId: 'onboarding' })).toBe('connect')
    bench.ctx.mayflyOverlays.close('mayfly.models')
    await vi.waitFor(() => { expect(bench.model()!.activeTab({ pagePath: [], controlId: 'onboarding' })).toBe('ready') })
  })

  it('leaves the guide on the choices when a sign-in is dismissed while its model picker opens', async () => {
    const bench = await setup({}, false, accountLlm)
    const account = scriptedAccount()
    bench.ctx.provide('deepseekAccount', account.service as never)
    bench.ctx.provide('webServer', { port: 45678 } as never)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    await chooseConnection(bench.model()!, 'account')
    await flush()
    const gate = Promise.withResolvers<void>()
    pickerGate.current = gate.promise
    account.push({ status: 'credential-stored', links: accountLinks, attempt: { id: 'a', phase: 'succeeded' } })
    await vi.waitFor(() => { expect(pickerCalls).toEqual(['deepseek-account']) })
    bench.model()!.emit({ kind: 'dismiss', pagePath: [] })
    await flush()
    gate.resolve()
    await flush(3)
    expect(bench.model()!.activeTab({ pagePath: [], controlId: 'onboarding' })).not.toBe('ready')
    expect(pickerCalls).toEqual(['deepseek-account'])
  })

  it('cancels a key save when its action aborts while the model picker opens', async () => {
    const bench = await setup()
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    const model = bench.model()!
    await enterKey(model)
    await flush()
    const gate = Promise.withResolvers<void>()
    pickerGate.current = gate.promise
    const entry = onboardingEntry(bench)
    const signal = new AbortController()
    const event: MayflyUiActionEvent = {
      kind: 'submit', pagePath: connectPath, controlId: 'onboarding',
      submission: { actionId: 'onboarding.next.connect', draftRevision: 1, source: [], forms: [{ pagePath: connectPath, formId: 'key-form', draftRevision: 1, fields: [{ id: 'key', value: 'abort-key', change: 'set' }] }] },
    }
    const preparing = entry.events.prepare(event, { surfaceId: entry.id, operationId: 'abort-key', source: [], revision: entry.revision, signal: signal.signal, report: vi.fn() })
    await vi.waitFor(() => { expect(pickerCalls).toEqual(['deepseek-official']) })
    signal.abort()
    gate.resolve()
    expect((await preparing).reply).toBeUndefined()
    expect(bench.credentials.values.get(DEEPSEEK_KEY)).toBe('abort-key')
  })

  it('moves on from a genuinely saved key when the empty field is submitted again', async () => {
    const bench = await setup()
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    const model = bench.model()!
    await enterKey(model)
    await flush()
    model.edit({ ...keyFormAddress, fieldId: 'key' }, 'saved-key')
    submitKey(model)
    await vi.waitFor(() => { expect(bench.credentials.values.get(DEEPSEEK_KEY)).toBe('saved-key') })
    const event: MayflyUiActionEvent = {
      kind: 'submit', pagePath: connectPath, controlId: 'onboarding',
      submission: { actionId: 'onboarding.next.connect', draftRevision: 1, source: [], forms: [{ pagePath: connectPath, formId: 'key-form', draftRevision: 1, fields: [{ id: 'key', value: '', change: 'set' }] }] },
    }
    const reply = (await prepareEvent(bench, event)).reply
    expect(reply).toMatchObject({ kind: 'accepted' })
    expect(JSON.stringify(bench.model()!.node)).toContain('Things to try')
  })

  it('skips the connection and lands on the welcome page', async () => {
    const bench = await setup()
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    expect((await prepareEvent(bench, connectSubmit('skip'))).reply).toMatchObject({ kind: 'accepted' })
    expect(JSON.stringify(bench.model()!.node)).toContain('Things to try')
    expect(JSON.stringify(bench.model()!.node)).toContain('DeepSeek not connected')
  })

  it('drops a queued theme change when the frontend unloads before it runs', async () => {
    const bench = await setup({}, false, accountLlm)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    bench.model()!.emit({ kind: 'value-change', pagePath: stepPath('preferences'), formId: ONBOARDING_PREFERENCES_FORM, controlId: 'theme', value: 'light', draftRevision: 1 })
    await bench.front.dispose()
    await flush(2)
    expect(applyThemeMock.mock.calls.every(call => call[1] === 'light')).toBe(true)
  })
})

describe('provider onboarding defensive edges', () => {
  it('stringifies a non-Error permission switch throw', async () => {
    const bench = await setup({}, false, accountLlm)
    const presets = fakePresets({ current: 'safe', setThrows: 'plain denial' })
    bench.ctx.provide('permissionPresets', presets as never)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    expect((await prepareEvent(bench, preferencesEvent({ [ONBOARDING_PERMISSION_FIELD]: 'full' }))).reply)
      .toMatchObject({ kind: 'failed', message: 'permission dispatch failed: plain denial' })
  })

  it('does not republish from a delivery timeout after the sign-in was dismissed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { bench } = await accountSetup()
      vi.spyOn(accountInternals, 'fetchCallback').mockResolvedValueOnce({ status: 200 })
      const delivered = await prepareEvent(bench, deliverEvent('http://localhost:45678/oauth/callback?code=x'))
      expect(delivered.reply).toMatchObject({ kind: 'accepted' })
      bench.model()!.emit({ kind: 'dismiss', pagePath: [] })
      await flush()
      expect(bench.model()).toBeDefined()
      vi.advanceTimersByTime(20_000)
      expect(JSON.stringify(bench.model()!.node)).toContain('Enter a DeepSeek API key')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('provider onboarding remaining defensive paths', () => {
  it('shows the sign-in page without a callback port when the server exposes none', async () => {
    const bench = await setup({}, false, accountLlm)
    bench.ctx.provide('deepseekAccount', scriptedAccount().service as never)
    bench.ctx.provide('webServer', {} as never)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    await chooseConnection(bench.model()!, 'account')
    await flush()
    const page = JSON.stringify(bench.model()!.node)
    expect(page).toContain('Copy the link below')
    expect(page).not.toContain('oauth/callback?…')
  })

  it('does not republish a counting sign-in after the guide was closed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    try {
      const bench = await setup({}, false, accountLlm)
      bench.ctx.provide('deepseekAccount', scriptedAccount().service as never)
      bench.ctx.provide('webServer', { port: 45678 } as never)
      bench.ctx.mayflyConversations.selectPrimary(bench.agent)
      await flush()
      await chooseConnection(bench.model()!, 'account')
      await flush()
      bench.ctx.mayflyOverlays.close('mayfly.provider.onboarding')
      expect(() => { vi.advanceTimersByTime(2_000) }).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a queued theme change when the frontend unloads behind a pending one', async () => {
    const bench = await setup({}, false, accountLlm)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    const gate = Promise.withResolvers<void>()
    applyThemeMock.mockReturnValueOnce(gate.promise as never)
    bench.model()!.emit({ kind: 'value-change', pagePath: stepPath('preferences'), formId: ONBOARDING_PREFERENCES_FORM, controlId: 'theme', value: 'light', draftRevision: 1 } as never)
    await flush()
    bench.model()!.emit({ kind: 'value-change', pagePath: stepPath('preferences'), formId: ONBOARDING_PREFERENCES_FORM, controlId: 'language', value: 'zh', draftRevision: 2 } as never)
    await bench.front.dispose()
    gate.resolve()
    await flush(3)
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])
  })
})
