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
import { providerFixture } from './provider-fixture.ts'
import type { MayflyFieldValue, MayflyUiActionEvent } from '../../../ui/src/interaction.ts'
import { flush } from '../helpers.ts'

const pickerCalls = vi.hoisted(() => [] as Array<string | undefined>)
vi.mock('../../src/interaction/model-commands.ts', () => ({ openModelPicker: async (_ctx: unknown, _signal: unknown, provider?: string) => { pickerCalls.push(provider); return { kind: 'success' } } }))
vi.mock('../../src/interaction/theme-switch.ts', () => ({ applyTheme: async () => ({ kind: 'success' }) }))

const contexts: Context[] = []
afterEach(async () => { pickerCalls.length = 0; for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

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
