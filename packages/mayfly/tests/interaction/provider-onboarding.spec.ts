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
import { DEEPSEEK_KEY } from '../../src/interaction/provider-onboarding.ts'
import { providerFixture } from './provider-fixture.ts'

const pickerCalls = vi.hoisted(() => [] as Array<string | undefined>)
vi.mock('../../src/interaction/model-commands.ts', () => ({ openModelPicker: async (_ctx: unknown, _signal: unknown, provider?: string) => { pickerCalls.push(provider); return { kind: 'success' } } }))
vi.mock('../../src/interaction/theme-switch.ts', () => ({ applyTheme: async () => ({ kind: 'success' }) }))

const contexts: Context[] = []
afterEach(async () => { pickerCalls.length = 0; for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const flush = () => new Promise<void>(resolve => { setImmediate(resolve) })

async function setup(profiles: Record<string, unknown> = {}, configured = false, llm?: unknown) {
  const ctx = new Context()
  contexts.push(ctx)
  new InteractionStateService(ctx, DEFAULT_SETTINGS)
  const bench = await providerFixture(ctx, profiles, llm)
  if (configured) bench.credentials.values.set(DEEPSEEK_KEY, 'configured')
  const agent = { id: 'root', session: {} } as Agent
  ctx.provide('agents', { get: (id: string) => id === agent.id ? agent : undefined } as never)
  const mount = () => ctx.plugin({ name: 'onboarding-app', inject: ['agents'], apply(owner: Context) { new MayflyCurrentAgentService(owner, new MayflyConversationsService(owner)) } })
  const app = await mount()
  return { ...bench, agent, app, mount, model: () => ctx.mayflyUiInteraction.get('overlay', 'mayfly.provider.onboarding') }
}


/** The account adapter route listing for guide discovery. */
const accountLlm = {
  listProviders: () => [],
  listConfigurableProviders: () => [{ provider: 'deepseek-account', settingsNs: 'llm-deepseek-account' }],
}

/** Minimal account double: only the state the guide reads. */
function fakeAccount(status: 'signed-out' | 'credential-stored') {
  return {
    async getState() { return { status, links: { usageUrl: 'https://example/u', topUpUrl: 'https://example/t' }, attempt: null } },
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
    model.invoke('use-key')
    await flush()
    model.edit({ pagePath: [], formId: 'onboarding', fieldId: 'key' }, 'new-key')
    expect(bench.credentials.writes).toBe(0)
    model.invoke('save')
    model.invoke('save')
    await flush()
    expect(bench.credentials.values.get(DEEPSEEK_KEY)).toBe('new-key')
    expect(bench.credentials.writes).toBe(1)
    expect(bench.settings.writes).toBe(0)
    expect(bench.model()).toBeUndefined()
    // A saved key ends on that provider's model list, not on another route's default.
    expect(pickerCalls).toEqual(['deepseek-official'])
  })

  it.each([true, false])('skips setup when a native credential is configured (official=%s)', async official => {
    const bench = await setup(official ? {} : { custom: { apiKeyEnv: 'CUSTOM_KEY' } }, official)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    expect(bench.model()).toBeUndefined()
  })

  it('retains the app-scoped key draft through current-Agent service reload and can save during the gap', async () => {
    const bench = await setup()
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    const model = bench.model()!
    model.invoke('use-key')
    await flush()
    model.edit({ pagePath: [], formId: 'onboarding', fieldId: 'key' }, 'retained-key')
    await bench.app.dispose()
    expect(model.disposed).toBe(false)
    expect(model.form({ pagePath: [], formId: 'onboarding' })!.fields.key!.value).toBe('retained-key')
    model.invoke('save')
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
    model.invoke('use-key')
    await flush()
    bench.credentials.failWrite = true
    model.edit({ pagePath: [], formId: 'onboarding', fieldId: 'key' }, 'retry-key')
    model.invoke('save')
    await flush()
    expect(model.form({ pagePath: [], formId: 'onboarding' })!.fields.key!.value).toBe('retry-key')
    expect(model.feedbackSnapshot().at(-1)?.severity).toBe('error')
    bench.credentials.failWrite = false
    model.invoke('save')
    await flush()
    expect(bench.credentials.writes).toBe(1)
    expect(model.disposed).toBe(true)
  })

  it('does not offer setup again after a deliberate skip and app reload', async () => {
    const bench = await setup()
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    bench.model()!.invoke('close')
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
    const bench = await setup({}, false, { listProviders: () => [{ id: 'anthropic', name: 'Anthropic' }] })
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
    const entry = bench.ctx.mayflyOverlays.list().find(item => item.id === 'mayfly.provider.onboarding')!
    const event = (value: unknown) => ({
      kind: 'submit' as const,
      submission: { actionId: 'save', source: [], forms: [{ pagePath: [], formId: 'onboarding', fields: [{ id: 'key', value, change: 'set' as const }] }] },
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
    model.invoke('use-key')
    await flush()
    model.edit({ pagePath: [], formId: 'onboarding', fieldId: 'key' }, 'replacement')
    model.invoke('save')
    await flush()
    expect(model.feedbackSnapshot().at(-1)?.message).toContain('configured elsewhere')
    expect(bench.credentials.values.get(DEEPSEEK_KEY)).toBe('external')
    model.invoke('save')
    await flush()
    expect(bench.credentials.values.get(DEEPSEEK_KEY)).toBe('replacement')
  })

  it('settles as cancelled when an action aborts after describe or write', async () => {
    const bench = await setup()
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    const entry = bench.ctx.mayflyOverlays.list().find(item => item.id === 'mayfly.provider.onboarding')!
    const event = {
      kind: 'submit' as const,
      submission: { actionId: 'save', source: [], forms: [{ pagePath: [], formId: 'onboarding', fields: [{ id: 'key', value: 'key', change: 'set' as const }] }] },
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
    const bench = await setup()
    vi.spyOn(bench.settings, 'describe').mockImplementation(() => { throw new Error('unavailable') })
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    expect(JSON.stringify(bench.model()!.node)).toContain('Provider setup could not be checked')
  })

  it('focuses an existing fallback surface after a readiness failure', async () => {
    const bench = await setup()
    const existing = bench.ctx.mayflyOverlays.open({ id: 'mayfly.provider.onboarding', title: 'Existing', presentation: 'editor', capturing: true }, { kind: 'text', content: 'existing' })
    vi.spyOn(bench.settings, 'describe').mockImplementation(() => { throw new Error('unavailable') })
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    expect(bench.ctx.mayflyOverlays.list().find(item => item.id === existing.events.id)?.focusRevision).toBe(1)
  })

  it('contains loader completion and failure after frontend unload', async () => {
    for (const outcome of ['resolve', 'reject'] as const) {
      const ctx = new Context()
      contexts.push(ctx)
      const loading = Promise.withResolvers<void>()
      ctx.provide('loader', { await: () => loading.promise } as never)
      const bench = await providerFixture(ctx)
      const agent = { id: `root-${outcome}`, session: {} } as Agent
      ctx.provide('agents', { get: () => agent } as never)
      await ctx.plugin({ name: `onboarding-app-${outcome}`, inject: ['agents'], apply(owner: Context) { new MayflyCurrentAgentService(owner, new MayflyConversationsService(owner)) } })
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

  it('offers account sign-in, opens the account panel from the guide, and does not return to it', async () => {
    const bench = await setup({}, false, accountLlm)
    bench.ctx.provide('deepseekAccount', fakeAccount('signed-out') as never)
    bench.ctx.provide('webServer', { port: 45678 } as never)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    const model = bench.model()!
    expect(JSON.stringify(model.node)).toContain('Sign in with a DeepSeek account')
    model.invoke('use-key')
    await flush()
    expect(JSON.stringify(model.node)).toContain('DEEPSEEK_API_KEY')
    model.invoke('back')
    await flush()
    expect(JSON.stringify(model.node)).not.toContain('DEEPSEEK_API_KEY')
    model.invoke('sign-in')
    await flush()
    expect(bench.ctx.mayflyOverlays.list().map(entry => entry.id)).toContain('mayfly.provider-account.deepseek-account')
    expect(bench.model()).toBeUndefined()
  })

  it('returns to the choice when the account step is closed before connecting', async () => {
    const bench = await setup({}, false, accountLlm)
    bench.ctx.provide('deepseekAccount', fakeAccount('signed-out') as never)
    bench.ctx.provide('webServer', { port: 45678 } as never)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    bench.model()!.invoke('sign-in')
    await flush()
    expect(bench.model()).toBeUndefined()
    bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.provider-account.deepseek-account')!.invoke('close')
    await flush()
    expect(JSON.stringify(bench.model()!.node)).toContain('Sign in with a DeepSeek account')
  })

  it('opens the welcome first on a first run and then the guide in the chosen language', async () => {
    const bench = await setup({}, false, accountLlm)
    bench.settings.register('locale', z.object({ preference: z.string().volatile() }))
    bench.settings.register('mayfly', z.object({ theme: z.string().default('dark').volatile() }))
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    await flush()
    const welcome = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.welcome')!
    expect(welcome).toBeDefined()
    expect(bench.model()).toBeUndefined()
    welcome.edit({ pagePath: [], formId: 'welcome', fieldId: 'language' }, 'zh')
    welcome.invoke('continue')
    await flush(); await flush(); await flush()
    expect(bench.ctx.mayflyLocale.preference).toBe('zh')
    expect(bench.model()).toBeDefined()
    expect(JSON.stringify(bench.model()!.node)).toContain('第 1 步')
  })

  it('does not open the guide when the frontend unloads during the welcome', async () => {
    const bench = await setup({}, false, accountLlm)
    bench.settings.register('locale', z.object({ preference: z.string().volatile() }))
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    await flush()
    expect(bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.welcome')).toBeDefined()
    // The frontend's services go with it; the unload must not reopen the guide or throw.
    await expect(bench.front.dispose()).resolves.toBeUndefined()
    await flush()
  })

  it('continues to the account provider\'s model list once the guide sign-in completes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const bench = await setup({}, false, accountLlm)
      const links = { usageUrl: 'https://example/u', topUpUrl: 'https://example/t' }
      const done = { status: 'credential-stored', links, attempt: { id: 'a', phase: 'succeeded' } }
      bench.ctx.provide('deepseekAccount', {
        async getState() { return { status: 'signed-out', links, attempt: null } },
        watch(): AsyncIterable<unknown> {
          return { async *[Symbol.asyncIterator]() { yield { status: 'signed-out', links, attempt: null }; await new Promise<void>(resolve => setTimeout(resolve, 10)); yield done } }
        },
      } as never)
      bench.ctx.provide('webServer', { port: 45678 } as never)
      bench.ctx.mayflyConversations.selectPrimary(bench.agent)
      await vi.advanceTimersByTimeAsync(50)
      bench.model()!.invoke('sign-in')
      await vi.advanceTimersByTimeAsync(50)
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
    model.invoke('use-key')
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
