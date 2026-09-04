/** Native `/agents` tree browser behavior.
 * @module @ephemeral-ai/mayfly/interaction/tests/agents-command
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it, vi } from 'vitest'
import * as agentsPlugin from '../../src/interaction/agents-command.ts'
import {
  agentMetricsText,
  buildAgentRows,
  formatAgentElapsed,
  type MayflySubagentTreeEntry,
} from '../../src/interaction/agents-command.ts'
import { PromptEditorController, setSharedEditor } from '../../src/interaction/editor-instance.ts'
import { EditorPanelController } from '../../src/interaction/editor-panel-controller.ts'
import { FakeMayflyComponents, FakeKeymap, FakeScreen, FakeTheme, KEY } from './fakes.ts'

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

  it('builds collapsed and expanded stable-preorder rows', () => {
    const tree: MayflySubagentTreeEntry[] = [
      child('branch', { activity: 'running', hasChildren: true, label: 'explore', tokens: 2_048, activeSince: 1_000 }),
      child('nested', { parentId: SessionId('branch'), depth: 2, mode: 'one-shot', label: undefined }),
      { kind: 'diagnostic', id: SessionId('broken'), parentId: SessionId('parent'), depth: 1, reason: 'corrupt' },
      child('orphan', { parentId: SessionId('ghost'), depth: 2 }),
      child('leaf'),
    ]
    const collapsed = buildAgentRows(tree, new Set(), 3_000)
    expect(collapsed.map(row => row.value)).toEqual(['branch', 'broken', 'leaf'])
    expect(collapsed[0]).toMatchObject({ label: '▸ ● explore', badge: 'running', description: 'continuable · 2k tok · 2s' })
    expect(collapsed[1]).toMatchObject({ label: '⚠ broken', disabled: true, description: 'diagnostic: corrupt' })
    const expanded = buildAgentRows(tree, new Set(['branch']), 3_000)
    expect(expanded.map(row => row.value)).toEqual(['branch', 'nested', 'broken', 'leaf'])
    expect(expanded[0]!.label).toBe('▾ ● explore')
    expect(expanded[1]).toMatchObject({ label: '  ○ nested', description: 'one-shot' })
  })

  it('hides descendants under diagnostics and non-expandable parents', () => {
    expect(buildAgentRows([
      { kind: 'diagnostic', id: SessionId('broken'), parentId: SessionId('parent'), depth: 1, reason: 'unavailable' },
      child('under', { parentId: SessionId('broken'), depth: 2 }),
    ], new Set()).map(row => row.value)).toEqual(['broken'])
    expect(buildAgentRows([
      child('leaf'),
      child('under', { parentId: SessionId('leaf'), depth: 2 }),
    ], new Set()).map(row => row.value)).toEqual(['leaf'])
  })
})

interface CommandHarness {
  readonly ctx: Context
  readonly screen: FakeScreen
  readonly parent: Agent
  readonly childSession: Session
  readonly sessionState: { current: Agent | null }
  readonly notices: string[]
  readonly projectionCalls: string[][]
  readonly opened: unknown[]
  readonly drain: ReturnType<typeof vi.fn>
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
  }
  new PromptEditorController(ctx)
  new EditorPanelController(ctx)
  ctx.mayflyEditorPanels.setHost({ mount: component => screen.mountDialogPanel(component) })
  const notices: string[] = []
  setSharedEditor(ctx, {
    editor: { focused: false, render: () => [], invalidate: () => {} } as never,
    submitPrompt: () => {},
    notice: text => { notices.push(text) },
  })
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
  ctx.provide('agents', { get: (id: unknown) => String(id) === String(parent.id) ? parent : undefined } as never)
  ctx.provide('tools', { get: () => undefined } as never)
  const harness = {
    ctx,
    screen,
    parent,
    childSession,
    sessionState,
    notices,
    projectionCalls,
    opened,
    drain: vi.fn(async () => {}),
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
  return harness
}

async function execute(rig: CommandHarness, input = '') {
  return (await rig.ctx.commands.execute(rig.parent, `/agents${input === '' ? '' : ` ${input}`}`, [], new AbortController().signal))?.result
}

describe('mayfly-agents-command', () => {
  it('reports display, Agent, listing, and empty-catalog outcomes', async () => {
    const noDisplay = await mountCommand({ display: false })
    expect(await execute(noDisplay)).toMatchObject({ kind: 'error', text: expect.stringContaining('not mounted') })
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
    expect(close).toHaveBeenCalledTimes(2)
    await rig.fiber.dispose()

    const absent = await mountCommand({ current: false })
    expect(await execute(absent, 'stop child')).toEqual({ kind: 'error', text: 'no session is live yet' })
    await absent.fiber.dispose()
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
    expect(plain(rig.screen.overlays[0]!.component.render(100)).join('\n')).toContain('Review security boundaries')

    rig.ctx.emit('workflow/agent-start', {} as never, {
      seq: 2,
      label: 'Workflow fallback',
      childId: SessionId('child'),
    })
    rig.tree = [child('child', { mode: 'one-shot', label: 'Descriptor label' })]
    expect(await execute(rig)).toEqual({ kind: 'success' })
    const second = plain(rig.screen.overlays[1]!.component.render(100)).join('\n')
    expect(second).toContain('Descriptor label')
    expect(second).not.toContain('Workflow fallback')

    rig.ctx.emit('workflow/agent-start', {} as never, {
      seq: 3,
      label: '   ',
      childId: SessionId('unnamed'),
    })
    rig.tree = [child('unnamed', { mode: 'one-shot', label: undefined })]
    expect(await execute(rig)).toEqual({ kind: 'success' })
    expect(plain(rig.screen.overlays[2]!.component.render(100)).join('\n')).toContain('unnamed')

    rig.ctx.emit('workflow/agent-end', {} as never, {
      seq: 4,
      label: 'Recovered after renderer reload',
      childId: SessionId('settled'),
      outcome: 'completed',
    })
    rig.tree = [child('settled', { mode: 'one-shot', label: undefined })]
    expect(await execute(rig)).toEqual({ kind: 'success' })
    expect(plain(rig.screen.overlays[3]!.component.render(100)).join('\n')).toContain('Recovered after renderer reload')
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
    const browser = rig.screen.overlays[0]!
    expect(plain(browser.component.render(100)).join('\n')).toContain('▸ ● explore')
    expect(plain(browser.component.render(100)).join('\n')).toContain('2k tok')
    expect(rig.projectionCalls).toContainEqual(['mayflyConversationFacts', 'subagentTiming'])
    browser.component.handleInput(' ')
    expect(plain(browser.component.render(100)).join('\n')).toContain('○ nested')
    browser.component.handleInput('\x1b[B')
    browser.component.handleInput(' ')
    browser.component.handleInput('\x1b[B')
    browser.component.handleInput(' ')
    browser.component.handleInput('\x1b[A')
    browser.component.handleInput('\x1b[A')
    browser.component.handleInput('\r')
    expect(browser.hidden).toBe(true)
    expect(rig.opened).toEqual([{
      kind: 'subagent', sessionId: 'child', parentSessionId: 'parent', label: 'explore', mode: 'continuable',
    }])
    const controller = browser.component as unknown as {
      options: {
        onToggle(row: { value: string }): void
        onSelect(row: { value: string }): void
        onDelete(row: { value: string }): void
        onCancel(): void
      }
    }
    controller.options.onToggle({ value: 'invalid' })
    controller.options.onToggle({ value: 'broken' })
    controller.options.onToggle({ value: 'child' })
    controller.options.onToggle({ value: 'child' })
    controller.options.onSelect({ value: 'broken' })
    controller.options.onDelete({ value: 'broken' })
    controller.options.onSelect({ value: 'nested' })
    expect(rig.opened.at(-1)).toEqual({
      kind: 'subagent', sessionId: 'nested', parentSessionId: 'child', label: 'nested', mode: 'one-shot',
    })
    controller.options.onCancel()
    controller.options.onCancel()
    expect(browser.hidden).toBe(true)
    await rig.fiber.dispose()
  })

  it('requires typed y before the browser stops a continuable subagent', async () => {
    const rig = await mountCommand()
    rig.tree = [child('child', { label: 'worker' })]
    expect(await execute(rig)).toEqual({ kind: 'success' })
    const browser = rig.screen.overlays[0]!
    browser.component.render(100)
    browser.component.handleInput(KEY.ctrlD)
    const confirm = rig.screen.overlays[1]!
    confirm.component.render(100)
    confirm.component.handleInput(KEY.enter)
    confirm.component.handleInput('n')
    confirm.component.handleInput(KEY.enter)
    expect(rig.drain).not.toHaveBeenCalled()
    expect(plain(confirm.component.render(100)).join('\n')).toContain('type y to confirm')

    confirm.component.handleInput(KEY.enter)
    confirm.component.handleInput('\x7f')
    confirm.component.handleInput('y')
    confirm.component.handleInput(KEY.enter)
    await vi.waitFor(() => {
      expect(rig.drain).toHaveBeenCalledWith(rig.parent, [SessionId('child')])
      expect(rig.notices).toContain('stopped subagent child')
    })
    expect(browser.hidden).toBe(true)
    await rig.fiber.dispose()
  })

  it('cancels and replaces an open browser stop confirmation', async () => {
    const rig = await mountCommand()
    rig.tree = [child('child')]
    await execute(rig)
    const browser = rig.screen.overlays[0]!
    browser.component.render(100)
    browser.component.handleInput(KEY.ctrlD)
    const firstConfirm = rig.screen.overlays[1]!
    browser.component.handleInput(KEY.ctrlD)
    expect(firstConfirm.hidden).toBe(true)
    const secondConfirm = rig.screen.overlays[2]!
    secondConfirm.component.render(100)
    secondConfirm.component.handleInput(KEY.escape)
    expect(secondConfirm.hidden).toBe(true)
    expect(browser.hidden).toBe(false)
    expect(rig.drain).not.toHaveBeenCalled()
    await rig.fiber.dispose()
  })

  it('uses the id in an unlabeled confirmation and reports browser stop failure', async () => {
    const rig = await mountCommand()
    rig.tree = [child('child', { label: undefined })]
    rig.drain.mockRejectedValueOnce(new Error('cannot drain'))
    await execute(rig)
    const browser = rig.screen.overlays[0]!
    browser.component.render(100)
    browser.component.handleInput(KEY.ctrlD)
    const confirm = rig.screen.overlays[1]!
    const text = plain(confirm.component.render(100)).join('\n')
    expect(text).toContain('type y to stop child')
    confirm.component.handleInput(KEY.enter)
    confirm.component.handleInput('y')
    confirm.component.handleInput(KEY.enter)
    await vi.waitFor(() => expect(plain(rig.notices)).toContain('could not stop subagent child: cannot drain'))
    await rig.fiber.dispose()
  })

  it('refuses to stop a one-shot subagent from the browser', async () => {
    const rig = await mountCommand()
    rig.tree = [child('once', { mode: 'one-shot' })]
    await execute(rig)
    const browser = rig.screen.overlays[0]!
    browser.component.render(100)
    browser.component.handleInput(KEY.ctrlD)
    expect(rig.screen.overlays).toHaveLength(1)
    expect(plain(rig.notices)).toContain('one-shot subagents cannot be stopped from the browser')
    expect(rig.drain).not.toHaveBeenCalled()
    await rig.fiber.dispose()
  })

  it('replaces an open browser, closes it on Agent change, and unloads cleanly', async () => {
    const rig = await mountCommand()
    rig.tree = [child('child')]
    await execute(rig)
    const first = rig.screen.overlays[0]!
    await execute(rig)
    expect(first.hidden).toBe(true)
    const second = rig.screen.overlays[1]!
    rig.switchAgent({ id: SessionId('other') } as Agent)
    expect(second.hidden).toBe(true)
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
    expect(unloading.screen.overlays).toHaveLength(0)

    let releaseSwitch!: () => void
    const switched = await mountCommand()
    switched.tree = [child('child')]
    switched.deferred = new Promise(resolve => { releaseSwitch = resolve })
    const switchedPending = execute(switched)
    switched.sessionState.current = { id: SessionId('other') } as Agent
    releaseSwitch()
    expect(await switchedPending).toEqual({ kind: 'success' })
    expect(switched.screen.overlays).toHaveLength(0)
    await switched.fiber.dispose()
  })
})
