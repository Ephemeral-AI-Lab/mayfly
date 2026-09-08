/** Provider command routing and registry lifecycle through the frontend Fiber.
 * @module @ephemeral-ai/mayfly/tests/interaction/provider-commands
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { providerFixture } from './provider-fixture.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const flush = () => new Promise<void>(resolve => { setImmediate(resolve) })
const signal = () => new AbortController().signal

function llm() {
  return {
    listProviders: () => [
      { id: 'custom', name: 'Custom API' },
      { id: 'fallback', name: '' },
    ],
    listConfigurableProviders: () => [
      { settingsNs: 'llm-pi-ai', provider: 'anthropic', displayName: 'Anthropic' },
    ],
    discoverModels: async () => [],
  }
}

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  return providerFixture(ctx, {
    custom: { displayName: 'Custom API', api: 'openai-completions', baseURL: 'https://custom.example/v1', apiKeyEnv: 'CUSTOM_KEY' },
    fallback: { api: 'openai-completions', baseURL: 'https://fallback.example/v1', apiKeyEnv: 'FALLBACK_KEY' },
  }, llm())
}

async function invoke(bench: Awaited<ReturnType<typeof setup>>, rawInput: string, invocationSignal = signal()) {
  return bench.commands.entries.get('provider')!.handler({ rawInput, signal: invocationSignal } as never)
}

describe('provider commands', () => {
  it('routes direct arguments and reports unavailable targets', async () => {
    const bench = await setup()
    expect(await invoke(bench, 'edit missing')).toEqual({ kind: 'error', text: 'The provider has no editable configuration' })
    expect(await invoke(bench, 'edit custom')).toEqual({ kind: 'success' })
    expect(await invoke(bench, 'switch missing')).toEqual({ kind: 'error', text: 'Unknown provider' })
    expect(await invoke(bench, 'switch CUSTOM API')).toEqual({ kind: 'error', text: 'no session is live yet' })
    expect(await invoke(bench, 'switch custom')).toEqual({ kind: 'error', text: 'no session is live yet' })
    expect(await invoke(bench, 'unknown')).toEqual({ kind: 'error', text: 'usage: /provider [list | edit <provider> | switch <provider> | add]' })
  })

  it('opens, focuses, refreshes, and retires the provider browser', async () => {
    const bench = await setup()
    expect(await invoke(bench, '')).toEqual({ kind: 'success' })
    const initial = bench.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.providers')!
    expect(JSON.stringify(initial.node)).toContain('Custom API')
    expect(JSON.stringify(initial.node)).toContain('fallback')

    expect(await invoke(bench, 'list')).toEqual({ kind: 'success' })
    expect(bench.ctx.mayflyOverlays.list().filter(entry => entry.id === 'mayfly.providers')).toHaveLength(1)
    expect(bench.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.providers')!.focusRevision).toBeGreaterThan(initial.focusRevision)

    await bench.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'custom', 'displayName'], value: 'Renamed' }])
    await flush()
    expect(bench.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.providers')!.revision).toBeGreaterThan(initial.revision)

    bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.providers')!.emit({
      kind: 'selection-accept', pagePath: [], controlId: 'providers', selectedIds: ['custom'],
    })
    await flush()
    expect(bench.ctx.mayflyUiInteraction.get('overlay', `mayfly.provider.${Buffer.from('custom').toString('hex')}`)).toBeDefined()

    const entry = bench.ctx.mayflyOverlays.list().find(item => item.id === 'mayfly.providers')!
    const stale = await entry.events.prepare(
      { kind: 'selection-accept', pagePath: [], controlId: 'providers', selectedIds: ['missing'] },
      { surfaceId: entry.id, operationId: 'stale', source: entry.source, revision: entry.revision, signal: signal(), report: vi.fn() },
    )
    expect(stale.reply).toEqual({ kind: 'failed', message: 'The provider has no editable configuration' })
    const unrelated = await entry.events.prepare(
      { kind: 'activate', pagePath: [], controlId: 'provider-list-actions', actionId: 'noop' },
      { surfaceId: entry.id, operationId: 'unrelated', source: entry.source, revision: entry.revision, signal: signal(), report: vi.fn() },
    )
    expect(unrelated.reply).toEqual({ kind: 'completed' })

    bench.ctx.mayflyOverlays.close('mayfly.providers')
    await bench.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'custom', 'displayName'], value: 'After close' }])
    await flush()
    expect(bench.ctx.mayflyOverlays.list().some(entry => entry.id === 'mayfly.providers')).toBe(false)
  })

  it('opens provider setup from both command and browser actions', async () => {
    const bench = await setup()
    expect(await invoke(bench, 'add')).toEqual({ kind: 'success' })
    expect(bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.provider.add')).toBeDefined()
    bench.ctx.mayflyOverlays.close('mayfly.provider.add')

    await invoke(bench, '')
    bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.providers')!.invoke('add')
    await flush()
    expect(bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.provider.add')).toBeDefined()
  })

  it('continues from a completed Add flow to model selection', async () => {
    const bench = await setup()
    await invoke(bench, 'add')
    bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.provider.add')!.emit({
      kind: 'selection-accept', pagePath: [], controlId: 'provider-source', selectedIds: ['known'],
    })
    await flush()
    bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.provider.add.known')!.emit({
      kind: 'selection-accept', pagePath: [], controlId: 'providers', selectedIds: ['anthropic'],
    })
    await flush()
    const endpoint = bench.ctx.mayflyUiInteraction.get('overlay', `mayfly.provider.add.${Buffer.from('anthropic').toString('hex')}`)!
    endpoint.edit({ pagePath: [{ controlId: 'provider-tabs', itemId: 'credentials' }], formId: 'credentials', fieldId: 'key' }, 'new-key')
    endpoint.invoke('save')
    await flush()
    expect(bench.settings.get('llm-pi-ai')).toMatchObject({ providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } } })
  })

  it('renders an empty browser when the optional llm service is absent', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const bench = await providerFixture(ctx)
    expect(await bench.commands.entries.get('provider')!.handler({ rawInput: '', signal: signal() } as never)).toEqual({ kind: 'success' })
    expect(JSON.stringify(ctx.mayflyOverlays.list()[0]!.node)).toContain('No configured providers')
  })

  it('contains aborted and unloaded add continuations', async () => {
    const bench = await setup()
    const aborted = new AbortController()
    aborted.abort()
    expect(await invoke(bench, 'add', aborted.signal)).toEqual({ kind: 'success' })
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])

    const handler = bench.commands.entries.get('provider')!.handler
    await bench.front.dispose()
    expect(await handler({ rawInput: 'add', signal: signal() } as never)).toEqual({ kind: 'success' })
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])
  })
})
