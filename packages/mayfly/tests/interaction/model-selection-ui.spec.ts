/** Shared model controls and exact-Agent lifecycle evidence.
 * @module @ephemeral-ai/mayfly/tests/interaction/model-selection-ui
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MayflyCurrentAgentService } from '../../src/app/current-agent.ts'
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
  const select = vi.fn(async (value: { provider: string, model: string, reasoningEffort?: string }) => { selection = { ...value, reasoningEffort: value.reasoningEffort }; return { selected: selection } })
  const save = vi.fn(async (_value: unknown) => {})
  ctx.provide('sessionController', { selectModel: select } as never)
  ctx.provide('sessionProjections', { snapshot: () => ({ values: { modelSelection: { next: selection } } }) } as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'one' }), saveSelection: save } as never)
  const app = await ctx.plugin({ name: 'app-selection', inject: ['agents'], apply(owner: Context) { new MayflyCurrentAgentService(owner) } })
  ctx.mayflyCurrentAgent.select(agent)
  await flush()
  return { ...bench, agent, other, app, llm, select, save }
}

describe('native model selection UI', () => {
  it('chooses a model and effort through shared controls without persisting a session-only selection', async () => {
    const bench = await setup()
    await openModelPicker(bench.ctx, new AbortController().signal)
    const picker = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.models')!
    picker.emit({ kind: 'selection-accept', pagePath: [], controlId: 'models', selectedIds: [JSON.stringify(['p', 'two'])] })
    await flush()
    const options = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.model.options')!
    options.edit({ pagePath: [], formId: 'model-options', fieldId: 'effort' }, 'high')
    expect(bench.select).not.toHaveBeenCalled()
    options.invoke('session')
    options.invoke('session')
    await flush()
    expect(bench.select).toHaveBeenCalledOnce()
    expect(bench.select).toHaveBeenCalledWith({ sessionId: bench.agent.id, provider: 'p', model: 'two', reasoningEffort: 'high' })
    expect(bench.save).not.toHaveBeenCalled()
    expect(options.disposed).toBe(true)
  })

  it('reports default persistence failure and retries it without repeating the session write', async () => {
    const bench = await setup()
    bench.save.mockRejectedValueOnce(new Error('disk unavailable'))
    await openModelPicker(bench.ctx, new AbortController().signal)
    bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.models')!.emit({ kind: 'selection-accept', pagePath: [], controlId: 'models', selectedIds: [JSON.stringify(['p', 'two'])] })
    await flush()
    const options = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.model.options')!
    options.edit({ pagePath: [], formId: 'model-options', fieldId: 'effort' }, 'high')
    options.invoke('default')
    await flush()
    expect(options.disposed).toBe(false)
    expect(options.feedbackSnapshot().at(-1)?.severity).toBe('error')
    options.invoke('default')
    await flush()
    expect(bench.select).toHaveBeenCalledOnce()
    expect(bench.save).toHaveBeenCalledTimes(2)
    expect(options.disposed).toBe(true)
  })

  it('retires registrations when selection changes and cannot use their old callbacks', async () => {
    const bench = await setup()
    await openModelPicker(bench.ctx, new AbortController().signal)
    const picker = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.models')!
    bench.ctx.mayflyCurrentAgent.select(bench.other)
    await flush()
    expect(picker.disposed).toBe(true)
    picker.emit({ kind: 'selection-accept', pagePath: [], controlId: 'models', selectedIds: [JSON.stringify(['p', 'two'])] })
    await flush()
    expect(bench.select).not.toHaveBeenCalled()
    expect(bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.model.options')).toBeUndefined()
  })

  it('does not revive an Agent-dependent picker after its app service is reloaded', async () => {
    const bench = await setup()
    await openModelPicker(bench.ctx, new AbortController().signal)
    const picker = bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.models')!
    await bench.app.dispose()
    await flush()
    expect(picker.disposed).toBe(true)
    await bench.ctx.plugin({ name: 'new-app-selection', inject: ['agents'], apply(owner: Context) { new MayflyCurrentAgentService(owner) } })
    bench.ctx.mayflyCurrentAgent.select(bench.agent)
    await flush()
    expect(bench.ctx.mayflyUiInteraction.get('overlay', 'mayfly.models')).toBeUndefined()
  })
})
