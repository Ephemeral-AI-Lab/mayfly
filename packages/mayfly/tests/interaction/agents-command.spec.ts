/** Native `/agents` tree browser behavior.
 * @module @ephemeral-ai/mayfly/interaction/tests/agents-command
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it, vi } from 'vitest'
import * as uiProvider from '../../../ui/src/provider.ts'
import * as agentsPlugin from '../../src/interaction/agents-command.ts'
import { mountUiRegistryObservers, UiInteractionService } from '../../src/core/ui-interaction-state.ts'
import type { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import {
  agentMetricsText,
  agentTreeItems,
  formatAgentElapsed,
  liveAgentDescendantCount,
  type MayflySubagentTreeEntry,
} from '../../src/interaction/agents-command.ts'
import { FakeMayflyComponents, FakeKeymap, FakeScreen, FakeTheme, KEY } from './fakes.ts'
import { renderRequest, flushRequests } from './request-fixture.ts'
import type { MayflyComponent } from '../../src/core/types.ts'

function plain(rows: readonly string[]): readonly string[] {
  return rows.map(row => row.replace(/\x1b\[[0-9;]*m/g, '').replace(/[~^#!?@]/g, ''))
}

type ChildEntry = MayflySubagentTreeEntry & { readonly kind: 'child' }

function child(id: string, overrides: Partial<ChildEntry> = {}): ChildEntry {
  return {
    kind: 'child',
    id: SessionId(id),
    parentId: SessionId('parent'),
    depth: 1,
    activity: 'inactive',
    hasChildren: false,
    mode: 'continuable',
    label: id,
    ...overrides,
  }
}

describe('agent tree models', () => {
  it('formats elapsed time and optional metrics', () => {
    expect(formatAgentElapsed(-5)).toBe('0s')
    expect(formatAgentElapsed(45_000)).toBe('45s')
    expect(formatAgentElapsed(130_000)).toBe('2m 10s')
    expect(agentMetricsText({}, 1_000)).toBe('')
    expect(agentMetricsText({ tokens: 2_048 }, 1_000)).toBe('2k tok')
    expect(agentMetricsText({ settledMs: 65_000 }, 1_000)).toBe('1m 5s')
    expect(agentMetricsText({ tokens: 100, settledMs: 5_000, activeSince: 500 }, 3_500)).toBe('100 tok · 3s')
  })

  it('counts only live descendants inside the selected subtree', () => {
    const tree: MayflySubagentTreeEntry[] = [
      child('branch', { activity: 'running', hasChildren: true }),
      child('nested-a', { parentId: SessionId('branch'), depth: 2, activity: 'running', hasChildren: true }),
      child('nested-b', { parentId: SessionId('nested-a'), depth: 3, activity: 'running' }),
      child('inactive', { parentId: SessionId('branch'), depth: 2 }),
      child('sibling', { activity: 'running' }),
    ]
    const isLive = (entry: ChildEntry): boolean => entry.activity === 'running'
    expect(liveAgentDescendantCount(tree, 'branch', isLive)).toBe(2)
    expect(liveAgentDescendantCount(tree, 'nested-a', isLive)).toBe(1)
    expect(liveAgentDescendantCount(tree, 'nested-b', isLive)).toBe(0)
    expect(liveAgentDescendantCount(tree, 'missing', isLive)).toBe(0)
    expect(agentTreeItems([
      child('parent'),
      { kind: 'diagnostic', id: SessionId('diagnostic'), parentId: SessionId('parent'), depth: 2, reason: 'broken' },
    ], 0)[1]).toMatchObject({ parentId: 'parent', disabled: true })
  })
})

interface CommandHarness {
  readonly ctx: Context
  readonly screen: FakeScreen
  readonly parent: Agent
  readonly childSession: Session
  readonly sessionState: { current: Agent | null }
  readonly projectionCalls: string[][]
  readonly opened: unknown[]
  readonly drain: ReturnType<typeof vi.fn>
  readonly liveAgents: Map<string, Agent>
  readonly switchAgent: (agent: Agent | null) => void
  readonly fiber: { dispose(): Promise<void> }
  tree: readonly SubagentDescendantListEntry[]
  listError: unknown
  deferred: Promise<void> | undefined
}

async function mountCommand(options: { readonly display?: boolean, readonly current?: boolean } = {}): Promise<CommandHarness> {
  const ctx = new Context()
  const screen = new FakeScreen()
  if (options.display !== false) {
    ctx.provide('mayflyScreen', screen as never)
    ctx.provide('mayflyTheme', new FakeTheme() as never)
    ctx.provide('mayflyKeymap', new FakeKeymap() as never)
    ctx.provide('mayflyComponents', new FakeMayflyComponents() as never)
    await ctx.plugin(uiProvider)
    new UiInteractionService(ctx)
    mountUiRegistryObservers(ctx)
    await Promise.resolve()
  }
  await ctx.plugin(CommandRuntime)
  const parentSession = {
    id: SessionId('parent'), header: { cwd: '/tmp' }, append: vi.fn(),
  } as unknown as Session
  const childSession = {
    id: SessionId('child'), header: { cwd: '/tmp', origin: 'subagent', parentSession: parentSession.id },
  } as unknown as Session
  const invalidSession = {
    id: SessionId('invalid'), header: { cwd: '/tmp', origin: 'subagent', parentSession: parentSession.id },
  } as unknown as Session
  const parent = { id: parentSession.id, session: parentSession, status: 'idle' } as unknown as Agent
  const childAgent = { id: childSession.id, session: childSession, status: 'idle' } as unknown as Agent
  const liveAgents = new Map<string, Agent>([[String(parent.id), parent], [String(childAgent.id), childAgent]])
  const sessionState: { current: Agent | null } = { current: options.current === false ? null : parent }
  const listeners = new Set<(agent: Agent | null, revision: number) => void>()
  const opened: unknown[] = []
  ctx.provide('testSession', sessionState)
  ctx.provide('mayflyCurrentAgent', {
    current: () => sessionState.current,
    primary: () => sessionState.current,
    view: () => ({ primarySessionId: String(parent.id), displayed: 'primary', auxiliary: null, revision: 0 }),
    revision: () => 0,
    subscribe(listener: (agent: Agent | null, revision: number) => void) {
      listeners.add(listener)
      listener(sessionState.current, 0)
      return () => { listeners.delete(listener) }
    },
    openAuxiliary(view: unknown) { opened.push(view) },
    closeAuxiliary: () => null,
  } as never)
  const projectionCalls: string[][] = []
  ctx.provide('sessionProjections', {
    snapshot: (session: Session, keys: readonly string[]) => {
      projectionCalls.push([...keys])
      return {
        asOfSeq: 2,
        values: session === invalidSession ? {
          mayflyConversationFacts: { epochTokens: 'many' },
          subagentTiming: { settledMs: 'later', active: { since: 'soon' } },
        } : {
          mayflyConversation: { entries: [], streaming: false },
          mayflyConversationFacts: { epochTokens: 2_048 },
          subagentTiming: { settledMs: 3_000, active: { since: 1_000 } },
        },
      }
    },
    onChanged: () => () => {},
  } as never)
  ctx.provide('sessions', { list: () => [parentSession, childSession, invalidSession] } as never)
  ctx.provide('agents', { get: (id: unknown) => liveAgents.get(String(id)) } as never)
  ctx.provide('tools', { get: () => undefined } as never)
  const harness = {
    ctx,
    screen,
    parent,
    childSession,
    sessionState,
    projectionCalls,
    opened,
    drain: vi.fn(async () => {}),
    liveAgents,
    switchAgent(agent: Agent | null) {
      sessionState.current = agent
      for (const listener of listeners) listener(agent, 1)
    },
    fiber: undefined as unknown as CommandHarness['fiber'],
    tree: [] as readonly SubagentDescendantListEntry[],
    listError: undefined as unknown,
    deferred: undefined as Promise<void> | undefined,
  } satisfies CommandHarness
  ctx.provide('subagents', {
    listDescendants: async () => {
      await harness.deferred
      if (harness.listError !== undefined) throw harness.listError
      return harness.tree
    },
    followup: async () => 'message-1',
    interrupt: () => {},
    drainContinuableChildren: harness.drain,
  } as never)
  harness.fiber = await ctx.plugin(agentsPlugin)
  if (options.display === false) return harness
  // Test-only registry bridge: production renders through the core surface
  // renderer; this adapter exposes that same compiled model to FakeScreen so
  // legacy lifecycle assertions can be migrated without reviving controllers.
  const mounted = new Map<string, { readonly component: MayflyComponent, readonly handle: { hide(): void } }>()
  const off = ctx.mayflyOverlays.subscribe(delta => {
    if (delta.kind === 'remove') {
      const previous = mounted.get(delta.id)
      previous?.handle.hide()
      mounted.delete(delta.id)
      return
    }
    const model = ctx.mayflyUiInteraction.get('overlay', delta.entry.id)
    if (model === undefined || mounted.has(delta.entry.id)) return
    let compiled = renderRequest(model)
    const component: MayflyComponent = {
      render: width => { if (compiled.runtime.interaction?.revision !== model.revision) compiled = renderRequest(model, { columns: width, rows: 24 }, compiled.runtime); return compiled.component.render(width) },
      handleInput: data => {
        if (data === KEY.ctrlD && delta.entry.id === 'mayfly.agents') {
          const choice = model.choice({ pagePath: [], controlId: 'subagents' })
          const id = choice?.focusedId
          if (id !== undefined) { model.updateChoice({ pagePath: [], controlId: 'subagents' }, { kind: 'select', ids: [id] }); model.invoke('stop') }
          return
        }
        compiled.input(data)
      },
      invalidate: () => compiled.component.invalidate(),
    }
    const handle = screen.showOverlay(component)
    mounted.set(delta.entry.id, { component, handle })
  })
  const originalDispose = harness.fiber.dispose.bind(harness.fiber)
  harness.fiber = { dispose: async () => { off(); for (const item of mounted.values()) item.handle.hide(); mounted.clear(); await originalDispose() } }
  return harness
}

async function execute(rig: CommandHarness, input = '') {
  return (await rig.ctx.commands.execute(rig.parent, `/agents${input === '' ? '' : ` ${input}`}`, [], new AbortController().signal))?.result
}

function browser(rig: CommandHarness): UiSurfaceModel {
  const model = rig.ctx.mayflyUiInteraction.get('overlay', 'mayfly.agents')
  if (model === undefined) throw new Error('agents browser is not open')
  return model
}

function browserRows(rig: CommandHarness, width = 100): string {
  return plain(renderRequest(browser(rig), { columns: width, rows: 24 }).component.render(width)).join('\n')
}

async function selectBrowser(model: UiSurfaceModel, id: string): Promise<void> {
  model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'subagents', selectedIds: [id] })
  await flushRequests()
}

describe('mayfly-agents-command', () => {
  it('reports display, Agent, listing, and empty-catalog outcomes', async () => {
    const noDisplay = await mountCommand({ display: false })
    expect(await execute(noDisplay)).toBeUndefined()
    agentsPlugin.apply(noDisplay.ctx)
    expect(await execute(noDisplay)).toEqual({ kind: 'error', text: 'agents panel is unavailable: the Mayfly screen is not mounted' })
    await noDisplay.fiber.dispose()
    const noAgent = await mountCommand({ current: false })
    expect(await execute(noAgent)).toEqual({ kind: 'error', text: 'no session is live yet' })
    await noAgent.fiber.dispose()
    const failed = await mountCommand()
    failed.listError = new Error('catalog failed')
    expect(await execute(failed)).toEqual({ kind: 'error', text: 'catalog failed' })
    failed.listError = 'catalog string failure'
    expect(await execute(failed)).toEqual({ kind: 'error', text: 'catalog string failure' })
    await failed.fiber.dispose()
    const empty = await mountCommand()
    expect(await execute(empty)).toEqual({ kind: 'success', text: 'no subagents in this session' })
    await empty.fiber.dispose()
  })

  it('stops an exact continuable descendant and rejects unsafe targets', async () => {
    const rig = await mountCommand()
    rig.tree = [child('child')]
    expect(await execute(rig, 'stop child')).toEqual({ kind: 'success', text: 'stopped subagent child' })
    expect(rig.drain).toHaveBeenCalledWith(rig.parent, [SessionId('child')])

    rig.tree = [child('once', { mode: 'one-shot' })]
    expect(await execute(rig, 'stop once')).toEqual({ kind: 'error', text: 'subagent once is not continuable' })
    expect(await execute(rig, 'stop missing')).toEqual({ kind: 'error', text: 'unknown subagent: missing' })
    expect(await execute(rig, 'invalid')).toEqual({ kind: 'error', text: 'usage: /agents [stop <id>]' })

    rig.tree = [child('orphan', { parentId: SessionId('offline-parent') })]
    rig.liveAgents.set('orphan', { id: SessionId('orphan') } as Agent)
    expect(await execute(rig, 'stop orphan')).toEqual({
      kind: 'error', text: 'cannot stop subagent orphan: its direct parent is not live',
    })
    rig.tree = [child('child')]
    rig.drain.mockRejectedValueOnce(new Error('drain failed'))
    expect(await execute(rig, 'stop child')).toEqual({ kind: 'error', text: 'could not stop subagent child: drain failed' })
    rig.listError = new Error('stop listing failed')
    expect(await execute(rig, 'stop child')).toEqual({ kind: 'error', text: 'stop listing failed' })
    await rig.fiber.dispose()
  })

  it('leaves an active child view before stopping it and rejects stop without a primary', async () => {
    const rig = await mountCommand()
    rig.tree = [child('child')]
    vi.spyOn(rig.ctx.mayflyCurrentAgent, 'view').mockReturnValue({
      primarySessionId: 'parent',
      displayed: 'auxiliary',
      auxiliary: {
        kind: 'subagent', sessionId: 'child', parentSessionId: 'parent', label: 'child', mode: 'continuable', access: 'interactive',
      },
      revision: 1,
    })
    const close = vi.spyOn(rig.ctx.mayflyCurrentAgent, 'closeAuxiliary')
    expect(await execute(rig, 'stop child')).toMatchObject({ kind: 'success' })
    expect(close).toHaveBeenCalledOnce()
    await rig.fiber.dispose()

    const absent = await mountCommand({ current: false })
    expect(await execute(absent, 'stop child')).toEqual({ kind: 'error', text: 'no session is live yet' })
    await absent.fiber.dispose()
  })

  it('refuses direct teardown while the target owns live descendants', async () => {
    const rig = await mountCommand()
    rig.tree = [
      child('branch', { activity: 'running', hasChildren: true }),
      child('nested-a', { parentId: SessionId('branch'), depth: 2, activity: 'running', hasChildren: true }),
      child('nested-b', { parentId: SessionId('nested-a'), depth: 3, activity: 'running' }),
      child('sibling', { activity: 'running' }),
    ]
    rig.liveAgents.set('nested-a', { id: SessionId('nested-a') } as Agent)
    rig.liveAgents.set('nested-b', { id: SessionId('nested-b') } as Agent)
    rig.liveAgents.set('sibling', { id: SessionId('sibling') } as Agent)
    expect(await execute(rig, 'stop branch')).toEqual({
      kind: 'error', text: 'subagent branch owns 2 live descendants; stop its live descendants first',
    })
    expect(rig.drain).not.toHaveBeenCalled()
    await rig.fiber.dispose()
  })

  it('does not report a cold continuable child as stopped', async () => {
    const rig = await mountCommand()
    rig.tree = [child('child')]
    rig.liveAgents.delete('child')
    expect(await execute(rig, 'stop child')).toEqual({
      kind: 'error', text: 'subagent child is not live; there is no running Agent to stop',
    })
    expect(rig.drain).not.toHaveBeenCalled()
    await rig.fiber.dispose()
  })

  it('uses native workflow labels only when one-shot descriptors omit a name', async () => {
    const rig = await mountCommand()
    rig.ctx.emit('workflow/agent-start', {} as never, {
      seq: 1,
      label: 'Review security boundaries',
      childId: SessionId('child'),
    })
    rig.tree = [child('child', { mode: 'one-shot', label: undefined })]
    expect(await execute(rig)).toEqual({ kind: 'success' })
    expect(browserRows(rig)).toContain('Review security boundaries')

    rig.ctx.emit('workflow/agent-start', {} as never, {
      seq: 2,
      label: 'Workflow fallback',
      childId: SessionId('child'),
    })
    rig.tree = [child('child', { mode: 'one-shot', label: 'Descriptor label' })]
    expect(await execute(rig)).toEqual({ kind: 'success' })
    const second = browserRows(rig)
    expect(second).toContain('Descriptor label')
    expect(second).not.toContain('Workflow fallback')

    rig.ctx.emit('workflow/agent-start', {} as never, {
      seq: 3,
      label: '   ',
      childId: SessionId('unnamed'),
    })
    rig.tree = [child('unnamed', { mode: 'one-shot', label: undefined })]
    expect(await execute(rig)).toEqual({ kind: 'success' })
    expect(browserRows(rig)).toContain('unnamed')

    rig.ctx.emit('workflow/agent-end', {} as never, {
      seq: 4,
      label: 'Recovered after renderer reload',
      childId: SessionId('settled'),
      outcome: 'completed',
    })
    rig.tree = [child('settled', { mode: 'one-shot', label: undefined })]
    expect(await execute(rig)).toEqual({ kind: 'success' })
    expect(browserRows(rig)).toContain('Recovered after renderer reload')
    await rig.fiber.dispose()
  })

  it('browses native descendants, samples live metrics, expands, and opens an auxiliary view', async () => {
    const rig = await mountCommand()
    rig.tree = [
      child('child', { activity: 'running', hasChildren: true, label: 'explore' }),
      child('nested', { parentId: SessionId('child'), depth: 2, mode: 'one-shot', label: undefined }),
      child('invalid'),
      { kind: 'diagnostic', id: SessionId('broken'), parentId: SessionId('parent'), depth: 1, reason: 'corrupt' },
    ]
    expect(await execute(rig)).toEqual({ kind: 'success' })
    const model = browser(rig)
    expect(browserRows(rig)).toContain('▸ ● explore')
    expect(browserRows(rig)).toContain('2k tok')
    expect(browserRows(rig)).not.toContain('○ nested')
    expect(rig.projectionCalls).toContainEqual(['mayflyConversationFacts', 'subagentTiming'])
    model.updateChoice({ pagePath: [], controlId: 'subagents' }, { kind: 'expand', id: 'child' })
    expect(browserRows(rig)).toContain('○ nested')
    await selectBrowser(model, 'child')
    model.invoke('view')
    await flushRequests()
    expect(model.disposed).toBe(true)
    expect(rig.opened).toEqual([{
      kind: 'subagent', sessionId: 'child', parentSessionId: 'parent', label: 'explore', mode: 'continuable',
    }])
    await rig.fiber.dispose()
  })

  it('defaults to No and requires selecting Yes before stopping a continuable subagent', async () => {
    const rig = await mountCommand()
    rig.tree = [child('child', { label: 'worker' })]
    expect(await execute(rig)).toEqual({ kind: 'success' })
    const model = browser(rig)
    await selectBrowser(model, 'child')
    model.invoke('stop')
    expect(JSON.stringify(model.decisionNode)).toContain('mayfly.decision.no')
    expect(JSON.stringify(model.decisionNode)).toContain('defaultFocus')
    model.answerDecision(false)
    expect(rig.drain).not.toHaveBeenCalled()
    expect(model.disposed).toBe(false)
    model.invoke('stop')
    model.answerDecision(true)
    await vi.waitFor(() => {
      expect(rig.drain).toHaveBeenCalledWith(rig.parent, [SessionId('child')])
      expect(model.feedbackSnapshot()).toEqual(expect.arrayContaining([
        expect.objectContaining({ severity: 'success', message: 'stopped subagent child' }),
      ]))
    })
    expect(model.disposed).toBe(false)
    await rig.fiber.dispose()
  })

  it('rechecks live descendants after browser confirmation', async () => {
    const rig = await mountCommand()
    rig.tree = [child('branch', { activity: 'running', hasChildren: false })]
    rig.liveAgents.set('branch', { id: SessionId('branch') } as Agent)
    await execute(rig)
    const model = browser(rig)
    await selectBrowser(model, 'branch')
    model.invoke('stop')
    rig.tree = [
      child('branch', { activity: 'running', hasChildren: true }),
      child('nested', { parentId: SessionId('branch'), depth: 2, activity: 'running' }),
    ]
    rig.liveAgents.set('nested', { id: SessionId('nested') } as Agent)
    model.answerDecision(true)
    await vi.waitFor(() => expect(model.feedbackSnapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'error', message: 'subagent branch owns 1 live descendant; stop its live descendants first' }),
    ])))
    expect(rig.drain).not.toHaveBeenCalled()
    await rig.fiber.dispose()
  })

  it('drops a confirmed stop after unload or primary replacement', async () => {
    const exercise = async (mode: 'unload' | 'replace'): Promise<CommandHarness> => {
      const rig = await mountCommand()
      rig.tree = [child('child')]
      await execute(rig)
      const model = browser(rig)
      await selectBrowser(model, 'child')
      let release!: () => void
      rig.deferred = new Promise(resolve => { release = resolve })
      model.invoke('stop')
      model.answerDecision(true)
      await Promise.resolve()
      if (mode === 'unload') await rig.fiber.dispose()
      else rig.switchAgent({ id: SessionId('replacement') } as Agent)
      release()
      await Promise.resolve()
      await Promise.resolve()
      return rig
    }
    const unloaded = await exercise('unload')
    expect(unloaded.drain).not.toHaveBeenCalled()
    const replaced = await exercise('replace')
    expect(replaced.drain).not.toHaveBeenCalled()
    await replaced.fiber.dispose()
  })

  it('deduplicates and cancels an open browser stop confirmation', async () => {
    const rig = await mountCommand()
    rig.tree = [child('child')]
    await execute(rig)
    const model = browser(rig)
    await selectBrowser(model, 'child')
    model.invoke('stop')
    const decision = model.decisionNode
    model.invoke('stop')
    expect(model.decisionNode).toEqual(decision)
    model.answerDecision(false)
    expect(model.decisionNode).toBeUndefined()
    expect(model.disposed).toBe(false)
    expect(rig.drain).not.toHaveBeenCalled()
    await rig.fiber.dispose()
  })

  it('uses the id in an unlabeled confirmation and reports browser stop failure', async () => {
    const rig = await mountCommand()
    rig.tree = [child('child', { label: undefined })]
    rig.drain.mockRejectedValueOnce(new Error('cannot drain'))
    await execute(rig)
    const model = browser(rig)
    await selectBrowser(model, 'child')
    model.invoke('stop')
    expect(JSON.stringify(model.decisionNode)).toContain('Stop child')
    model.answerDecision(true)
    await vi.waitFor(() => expect(model.feedbackSnapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'error', message: 'could not stop subagent child: cannot drain' }),
    ])))
    await rig.fiber.dispose()
  })

  it('defends empty, unrelated, and non-child browser events and uses an id label fallback', async () => {
    const rig = await mountCommand()
    rig.tree = [
      child('unlabeled', { label: undefined }),
      { kind: 'diagnostic', id: SessionId('diagnostic'), parentId: SessionId('parent'), depth: 1, reason: 'broken' },
    ]
    rig.liveAgents.set('unlabeled', { id: SessionId('unlabeled') } as Agent)
    await execute(rig)
    const entry = rig.ctx.mayflyOverlays.list().find(item => item.id === 'mayfly.agents')!
    const context = { surfaceId: entry.id, operationId: 'direct', source: entry.source, revision: entry.revision, signal: new AbortController().signal, report: vi.fn() }
    expect(await entry.definition.onEvent!.action!({ kind: 'selection-accept', pagePath: [], controlId: 'subagents', selectedIds: [] }, context)).toEqual({ kind: 'completed' })
    expect(await entry.definition.onEvent!.action!({ kind: 'selection-accept', pagePath: [], controlId: 'subagents', selectedIds: ['diagnostic'] }, context)).toMatchObject({ kind: 'accepted' })
    expect(await entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'noop', actionId: 'noop' }, context)).toEqual({ kind: 'completed' })
    expect(await entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'subagent-actions', actionId: 'view' }, context)).toMatchObject({ kind: 'failed' })
    const diagnosticInput = { forms: [], source: [], selections: [{ pagePath: [], controlId: 'subagents', selectedIds: ['diagnostic'] }] }
    expect(await entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'subagent-actions', actionId: 'view', inputs: diagnosticInput }, context)).toMatchObject({ kind: 'failed' })
    const viewInput = { forms: [], source: [], selections: [{ pagePath: [], controlId: 'subagents', selectedIds: ['unlabeled'] }] }
    expect(await entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'subagent-actions', actionId: 'view', inputs: viewInput }, context)).toEqual({ kind: 'completed' })
    expect(rig.opened).toContainEqual(expect.objectContaining({ label: 'unlabeled' }))
    await rig.fiber.dispose()
  })

  it('disables browser stop when the direct parent is not live', async () => {
    const rig = await mountCommand()
    rig.tree = [child('orphan', { parentId: SessionId('offline-parent') })]
    rig.liveAgents.set('orphan', { id: SessionId('orphan') } as Agent)
    await execute(rig)
    const model = browser(rig)
    await selectBrowser(model, 'orphan')
    expect(model.availableActions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionId: 'stop', disabledReason: 'cannot stop subagent orphan: its direct parent is not live' }),
    ]))
    await rig.fiber.dispose()
  })

  it('refuses to stop a one-shot subagent from the browser', async () => {
    const rig = await mountCommand()
    rig.tree = [child('once', { mode: 'one-shot' })]
    await execute(rig)
    const model = browser(rig)
    await selectBrowser(model, 'once')
    expect(model.availableActions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionId: 'stop', enabled: false, disabledReason: 'subagent once is not continuable' }),
    ]))
    model.invoke('stop')
    expect(model.decisionNode).toBeUndefined()
    expect(rig.drain).not.toHaveBeenCalled()
    await rig.fiber.dispose()
  })

  it('refuses browser teardown while the target owns a live descendant', async () => {
    const rig = await mountCommand()
    rig.tree = [
      child('branch', { activity: 'running', hasChildren: true }),
      child('nested', { parentId: SessionId('branch'), depth: 2, activity: 'running' }),
    ]
    rig.liveAgents.set('branch', { id: SessionId('branch') } as Agent)
    rig.liveAgents.set('nested', { id: SessionId('nested') } as Agent)
    await execute(rig)
    const model = browser(rig)
    await selectBrowser(model, 'branch')
    expect(model.availableActions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionId: 'stop', enabled: false, disabledReason: 'subagent branch owns 1 live descendant; stop its live descendants first' }),
    ]))
    model.invoke('stop')
    expect(model.decisionNode).toBeUndefined()
    expect(rig.drain).not.toHaveBeenCalled()
    await rig.fiber.dispose()
  })

  it('does not open stop confirmation for a cold continuable child', async () => {
    const rig = await mountCommand()
    rig.tree = [child('cold')]
    rig.liveAgents.delete('child')
    await execute(rig)
    const model = browser(rig)
    await selectBrowser(model, 'cold')
    expect(model.availableActions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionId: 'stop', enabled: false, disabledReason: 'subagent cold is not live; there is no running Agent to stop' }),
    ]))
    model.invoke('stop')
    expect(model.decisionNode).toBeUndefined()
    expect(rig.drain).not.toHaveBeenCalled()
    await rig.fiber.dispose()
  })

  it('replaces an open browser, closes it on Agent change, and unloads cleanly', async () => {
    const rig = await mountCommand()
    rig.tree = [child('child')]
    await execute(rig)
    const first = browser(rig)
    await execute(rig)
    expect(first.disposed).toBe(true)
    const second = browser(rig)
    rig.switchAgent({ id: SessionId('other') } as Agent)
    expect(second.disposed).toBe(true)
    await rig.fiber.dispose()
  })

  it('drops a listing that resolves after unload or current-Agent replacement', async () => {
    let release!: () => void
    const unloading = await mountCommand()
    unloading.tree = [child('child')]
    unloading.deferred = new Promise(resolve => { release = resolve })
    const pending = execute(unloading)
    const disposal = unloading.fiber.dispose()
    release()
    expect(await pending).toEqual({ kind: 'success' })
    await disposal
    expect(unloading.ctx.mayflyOverlays.list()).toHaveLength(0)

    let releaseSwitch!: () => void
    const switched = await mountCommand()
    switched.tree = [child('child')]
    switched.deferred = new Promise(resolve => { releaseSwitch = resolve })
    const switchedPending = execute(switched)
    switched.sessionState.current = { id: SessionId('other') } as Agent
    releaseSwitch()
    expect(await switchedPending).toEqual({ kind: 'success' })
    expect(switched.ctx.mayflyOverlays.list()).toHaveLength(0)
    await switched.fiber.dispose()
  })
})
