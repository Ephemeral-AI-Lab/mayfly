/** Shared model controls and exact-Agent lifecycle evidence.
 * @module @ephemeral-ai/mayfly/tests/interaction/model-selection-ui
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MayflyCurrentAgentService } from '../../src/app/current-agent.ts'
import { MayflyConversationsService } from '../../src/app/conversation-views.ts'
import { openModelPicker } from '../../src/interaction/model-commands.ts'
import { providerFixture } from './provider-fixture.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const flush = () => new Promise<void>(resolve => { setImmediate(resolve) })

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  const llm = {
    listProviders: () => [{ id: 'p', name: 'Provider' }], listConfigurableProviders: () => [],
    listModels: vi.fn(async () => [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }]),
    resolveModelInfo: async () => ({ context: { contextWindow: 32000 }, reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } }),
  }
  const bench = await providerFixture(ctx, {}, llm)
  bench.credentials.values.set('DEEPSEEK_API_KEY', 'configured')
  const agent = { id: 'agent-a', session: {} } as Agent
  const other = { id: 'agent-b', session: {} } as Agent
  const agents = new Map([[agent.id, agent], [other.id, other]])
  ctx.provide('agents', { get: (id: Agent['id']) => agents.get(id) } as never)
  let selection = { provider: 'p', model: 'one', reasoningEffort: 'low' as string | undefined }
  const save = vi.fn(async (_value: unknown) => {})
  // Mirrors the rc.2 contract: the Session-local selection is installed
  // synchronously and the default save runs in the background.
  const select = vi.fn(async (value: { provider: string, model: string, reasoningEffort?: string }) => {
    selection = { ...value, reasoningEffort: value.reasoningEffort }
    void save(selection).catch(() => {})
    return { selected: selection }
  })
  ctx.provide('sessionController', { selectModel: select } as never)
  ctx.provide('sessionProjections', { snapshot: () => ({ values: { modelSelection: { next: selection } } }) } as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'one' }), saveSelection: save } as never)
  const app = await ctx.plugin({ name: 'app-selection', inject: ['agents'], apply(owner: Context) { new MayflyCurrentAgentService(owner, new MayflyConversationsService(owner)) } })
  ctx.mayflyConversations.selectPrimary(agent)
  await flush()
  return { ...bench, agent, other, app, llm, select, save }
}

const two = JSON.stringify(['p', 'two'])

describe('native model selection UI', () => {
  it('chooses a model and effort through shared controls on the shared commit path', async () => {
    const bench = await setup()
    await openModelPicker(bench.ctx, new AbortController().signal)
    const picker = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.models')!
    picker.updateChoice({ pagePath: [], controlId: 'selection' }, { kind: 'focus', id: two })
    picker.updateChoice({ pagePath: [], controlId: 'selection' }, { kind: 'segment', id: two, direction: 1 })
    picker.updateChoice({ pagePath: [], controlId: 'selection' }, { kind: 'segment', id: two, direction: 1 })
    expect(bench.select).not.toHaveBeenCalled()
    picker.invoke('default')
    picker.invoke('default')
    await flush()
    expect(bench.select).toHaveBeenCalledOnce()
    expect(bench.select).toHaveBeenCalledWith({ sessionId: bench.agent.id, provider: 'p', model: 'two', reasoningEffort: 'high' })
    expect(bench.save).toHaveBeenCalledOnce()
    expect(picker.disposed).toBe(true)
  })

  it('settles the selection even when the Host default save fails', async () => {
    const bench = await setup()
    bench.save.mockRejectedValueOnce(new Error('disk unavailable'))
    await openModelPicker(bench.ctx, new AbortController().signal)
    const picker = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.models')!
    picker.updateChoice({ pagePath: [], controlId: 'selection' }, { kind: 'focus', id: two })
    picker.updateChoice({ pagePath: [], controlId: 'selection' }, { kind: 'segment', id: two, direction: 1 })
    picker.updateChoice({ pagePath: [], controlId: 'selection' }, { kind: 'segment', id: two, direction: 1 })
    picker.invoke('default')
    await flush()
    expect(picker.disposed).toBe(true)
    expect(bench.select).toHaveBeenCalledOnce()
    expect(bench.save).toHaveBeenCalledOnce()
  })

  it('retires registrations when selection changes and cannot use their old callbacks', async () => {
    const bench = await setup()
    await openModelPicker(bench.ctx, new AbortController().signal)
    const picker = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.models')!
    bench.ctx.mayflyConversations.selectPrimary(bench.other)
    await flush()
    expect(picker.disposed).toBe(true)
    picker.invoke('default')
    await flush()
    expect(bench.select).not.toHaveBeenCalled()
  })

  it('does not revive an Agent-dependent picker after its app service is reloaded', async () => {
    const bench = await setup()
    await openModelPicker(bench.ctx, new AbortController().signal)
    const picker = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.models')!
    await bench.app.dispose()
    await flush()
    expect(picker.disposed).toBe(true)
    await bench.ctx.plugin({ name: 'new-app-selection', inject: ['agents'], apply(owner: Context) { new MayflyCurrentAgentService(owner, new MayflyConversationsService(owner)) } })
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await flush()
    expect(bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.models')).toBeUndefined()
  })
})
