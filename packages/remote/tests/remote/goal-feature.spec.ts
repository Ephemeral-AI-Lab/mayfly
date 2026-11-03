/** Reference Goal status actions and native slash routing preserve exact invocation ownership. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GoalProjection, GoalView } from '@deepseek-ai/dsh-goal/client'
import { visibleWidth } from '@ephemeral-ai/mayfly/core'
import { goalPanel, goalSummary } from '@ephemeral-ai/mayfly/command-panels'
import { mountGoalFeature } from '../../src/remote/features/goal.ts'
import { EditorCommands } from '../../src/remote/editor/commands.ts'
import { remoteCommandCatalog } from '../../src/remote/command-catalog.ts'
import type { EditorFeatureSession } from '../../src/remote/editor/types.ts'
import type { EditorCommandAttachment } from '../../src/remote/editor/commands.ts'
import { taskFixture, tick, translate, activated, good, bad } from './task-feature-fixture.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop(); vi.restoreAllMocks(); vi.useRealTimers() })
const goal = (extra: Partial<GoalView> = {}): GoalView => ({ id: 'goal' as GoalView['id'], revision: 1, objective: 'Finish the actual task', maxGoalRounds: 5, roundsStarted: 1, phase: 'active', activation: 'armed', createdAt: 1_000, updatedAt: 1_000, ...extra })
function projection(value: GoalView | undefined): GoalProjection | null {
  if (value === undefined) return null
  const { activation: _activation, roundsStarted, createdAt, updatedAt, ...snapshot } = value
  return { goal: snapshot, roundsStarted, createdAt, updatedAt }
}
async function fixture(initial: GoalView | undefined = goal(), selected = true) {
  const f = await taskFixture(selected)
  f.goals.get.mockResolvedValue(good(initial))
  f.state.goal.set(projection(initial))
  const localeSubscriptions = vi.spyOn(f.ctx.mayflyLocale, 'subscribe')
  const stop = mountGoalFeature(f.options)
  cleanups.push(async () => { stop(); await f.dispose() })
  await tick()
  return { ...f, stop, localeSubscriptions, node: () => f.pane('mayfly.view.goal')?.node ?? null, summary: () => f.pane('mayfly.view.goal')?.summary ?? null,
    update: async (next: GoalView | undefined) => { f.goals.get.mockResolvedValue(good(next)); f.state.goal.set(projection(next)); await tick() },
  }
}

describe('native Goal command admission', () => {
  it('leaves bare /goal, every native parser token and ordered attachments with official commands.execute', async () => {
    const f = await fixture()
    expect(f.options.commands.list().some(command => command.name === 'goal')).toBe(false)
    expect(await f.run('goal', '', AbortSignal.abort())).toBe(false)
    const execute = vi.fn(async () => good({ result: { kind: 'success', text: 'Native Goal result' } }))
    Object.assign(f.client.remote, { commands: { execute } })
    const current = f.options.hosts.current()!
    const session = { client: f.client, ref: current.ref, session: current.binding.session, generation: 1 } as EditorFeatureSession
    const local = { cwd: () => '/frontend', list: () => remoteCommandCatalog(true, f.options.commands.list()), execute: vi.fn(async () => ({ kind: 'unhandled' as const })), exit: vi.fn() }
    const router = new EditorCommands({ session: () => session, local, notice: f.options.notice, t: translate })
    const attachments: readonly EditorCommandAttachment[] = [{ type: 'image', mediaType: 'image/png', data: 'encoded' }, { type: 'file', receiptId: 'native-file' }]
    const signal = new AbortController().signal
    for (const line of ['/goal', '/goal create literal objective', '/goal complete', '/goal EDIT\tnew objective', '/goal PaUsE', '/goal clear']) {
      expect(await router.execute(line, attachments, signal)).toEqual({ handled: true, exit: false, accepted: true })
      expect(execute).toHaveBeenLastCalledWith('session', line, attachments, signal)
    }
    expect(local.execute).not.toHaveBeenCalled()
    expect(f.goals.create).not.toHaveBeenCalled(); expect(f.goals.edit).not.toHaveBeenCalled()
    expect(f.editPrompt).not.toHaveBeenCalled()
    const calls = execute.mock.calls.length
    expect(await router.execute('/goal', [], AbortSignal.abort())).toMatchObject({ accepted: false })
    expect(execute).toHaveBeenCalledTimes(calls)
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    expect(f.options.notice.set).not.toHaveBeenCalled()
    execute.mockResolvedValueOnce(good({ result: { kind: 'error', text: 'Attachments only accompany a goal objective' } }))
    expect(await router.execute('/goal pause', attachments, signal)).toMatchObject({ accepted: true })
    expect(f.options.notice.set).toHaveBeenLastCalledWith('Attachments only accompany a goal objective', 'error')
  })
})

describe('native Goal status facts', () => {
  it('uses whole durable projection, reconciles exact activation, and preserves the original completion deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(2_000)
    const f = await fixture(goal(), false)
    expect(f.node()).toBeNull(); expect(f.goals.get).not.toHaveBeenCalled()
    f.select(true); await tick()
    expect(f.render(f.node()).join('\n')).toContain('Finish the actual task')
    expect(JSON.stringify(f.summary())).toContain('●')
    const calls = f.goals.get.mock.calls.length
    f.event('goal/activation-changed', { sessionId: 'unrelated' }); expect(f.goals.get).toHaveBeenCalledTimes(calls)
    f.event('goal/activation-changed', { sessionId: 'session' }); await tick(); expect(f.goals.get).toHaveBeenCalledTimes(calls + 1)
    await f.update(goal({ phase: 'blocked', blockedReason: { code: 'limit', message: 'quota used' } }))
    expect(f.ctx.mayflyUiInteraction.notificationSnapshot().some(row => row.message.includes('Goal blocked · limit: quota used'))).toBe(true)
    await f.update(goal({ phase: 'blocked' })); expect(f.ctx.mayflyUiInteraction.notificationSnapshot()).toEqual([])
    await f.update(goal({ phase: 'complete' })); expect(f.node()).toBeNull(); expect(JSON.stringify(f.summary())).toContain('✓')
    await vi.advanceTimersByTimeAsync(4_000)
    await f.update(goal({ phase: 'complete' }))
    await vi.advanceTimersByTimeAsync(1_000); expect(f.summary()).toBeNull()
    await f.update(goal({ phase: 'complete', id: 'other' as GoalView['id'] })); expect(f.summary()).toBeNull()
    await f.update(undefined); expect(f.summary()).toBeNull()
    await f.update(goal()); await f.update(goal({ phase: 'complete' })); f.select(false)
    expect(f.summary()).toBeNull(); expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a durable goal disarmed on missing, mismatched or refused activation instead of replacing it with RPC state', async () => {
    const f = await fixture()
    for (const result of [good(undefined), good(goal({ revision: 2 })), good(goal({ id: 'foreign' as GoalView['id'] })), bad('native get refused')]) {
      f.goals.get.mockResolvedValueOnce(result); f.state.goal.set(projection(goal())); await tick()
      expect(JSON.stringify(f.summary())).toContain('○')
      expect(f.render(f.node()).join('\n')).toContain('Finish the actual task')
    }
    f.goals.get.mockRejectedValueOnce(new Error('activation unavailable')); f.state.goal.set(projection(goal())); await tick()
    expect(JSON.stringify(f.summary())).toContain('○')
    expect(f.options.notice.set).not.toHaveBeenCalled()
    f.state.goal.set(undefined); await tick(); expect(f.node()).toBeNull()
  })

  it.each(['superseded', 'binding', 'connection', 'detach', 'unload'] as const)('retires both outcomes of a pending activation after %s', async reason => {
    for (const fails of [false, true]) {
      const f = await fixture()
      const late = Promise.withResolvers<unknown>(); f.goals.get.mockReturnValueOnce(late.promise)
      f.state.goal.set(projection(goal({ objective: 'retired result' })))
      const callbacks = [...f.state.goal.listeners]
      if (reason === 'superseded') await f.update(goal({ objective: 'newer goal' }))
      if (reason === 'binding') f.replaceBinding(true)
      if (reason === 'connection') { f.goals.get.mockResolvedValue(good(undefined)); f.reconnect() }
      if (reason === 'detach') f.detach()
      if (reason === 'unload') f.stop()
      if (fails) late.reject(new Error('retired activation failure'))
      else late.resolve(good(goal()))
      await tick()
      if (reason === 'superseded') expect(f.render(f.node()).join('\n')).toContain('newer goal')
      else if (reason === 'connection') expect(JSON.stringify(f.summary())).toContain('○')
      else expect(f.render(f.node()).join('\n')).not.toContain('retired result')
      if (reason === 'unload') for (const callback of callbacks) callback()
      expect(f.options.notice.set).not.toHaveBeenCalledWith('retired activation failure')
    }
  })

  it('retires synchronous native projection replacement and publication without late blocked feedback', async () => {
    const f = await fixture()
    const source = vi.spyOn(f.state.goal, 'getSnapshot')
    source.mockImplementationOnce(() => { f.replaceBinding(true); return null })
    f.state.goal.set(null); await tick()
    expect(f.node()).not.toBeNull()
    f.select(true); await tick()
    const subscribe = vi.spyOn(f.state.goal, 'subscribe')
    subscribe.mockImplementationOnce(() => { f.replaceBinding(true); return () => {} })
    f.select(true); await tick()
    expect(f.node()).toBeNull()
    f.select(true); await f.update(goal())
    const off = f.ctx.mayflyPanes.subscribe(delta => {
      if (delta.kind === 'upsert' && JSON.stringify(delta.entry.node).includes('quota used')) f.replaceBinding(true)
    })
    await f.update(goal({ phase: 'blocked', blockedReason: { code: 'limit', message: 'quota used' } }))
    off()
    expect(f.ctx.mayflyUiInteraction.notificationSnapshot()).toEqual([])
    f.select(true); await f.update(goal()); await f.update(goal({ phase: 'complete' })); await f.update(goal({ revision: 2 }))
    expect(JSON.stringify(f.summary())).toContain('●')
  })

  it('retires queued native activation, topology, locale and completion callbacks after disposal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const f = await fixture()
    const event = [...f.events.get('goal/activation-changed')!][0]!
    await f.update(goal({ phase: 'complete' }))
    const callback = timers.mock.calls.findLast(call => call[1] === 5_000)![0] as () => void
    const topology = [...f.topology]
    f.stop(); f.stop(); callback(); event({ sessionId: 'session' }); for (const change of topology) change()
    f.ctx.mayflyLocale.setPreference('zh')
    for (const [listener] of f.localeSubscriptions.mock.calls) listener(f.ctx.mayflyLocale.snapshot)
    expect(f.ctx.mayflyPanes.list()).toEqual([])
    expect(f.events.get('goal/activation-changed')?.size).toBe(0)
  })
})

describe('reference Goal status actions', () => {
  it('keeps edit in the prompt, confirms only clear, and mutates native exact Goal revisions without extra notices', async () => {
    const f = await fixture()
    const node = JSON.stringify(f.node())
    expect(node).toContain('goal-pause:1'); expect(node).toContain('Clear the goal?')
    expect(node).not.toContain('goal-complete'); expect(node).not.toContain('Maximum rounds')
    expect(await f.dispatch(activated('goal-edit:1'))).toEqual({ kind: 'completed' })
    expect(f.editPrompt).toHaveBeenCalledWith('/goal edit Finish the actual task', expect.any(Function))
    expect(f.goals.edit).not.toHaveBeenCalled()
    for (const verb of ['pause', 'resume', 'clear'] as const) {
      expect(await f.dispatch(activated(`goal-${verb}:1`))).toEqual({ kind: 'completed' })
      expect(f.goals[verb]).toHaveBeenCalledWith('session', { id: 'goal', revision: 1 })
    }
    expect(f.options.notice.set).not.toHaveBeenCalled()
    f.goals.pause.mockResolvedValueOnce(bad('revision conflict') as never)
    expect(await f.dispatch(activated('goal-pause:1'))).toEqual({ kind: 'failed', message: 'revision conflict' })
    for (const error of [new Error('native failure'), 'native failure']) {
      f.goals.resume.mockRejectedValueOnce(error)
      expect(await f.dispatch(activated('goal-resume:1'))).toEqual({ kind: 'failed', message: 'native failure' })
    }
    expect(await f.dispatch({ kind: 'dismiss', pagePath: [] })).toEqual({ kind: 'completed' })
    expect(await f.dispatch(activated('goal-complete:1'))).toEqual({ kind: 'failed', message: 'Unknown goal action' })
    expect(await f.dispatch(activated('goal-pause:2'))).toMatchObject({ kind: 'failed', message: 'The goal changed; open it again' })
    expect(await f.dispatch(activated('goal-pause:1'), AbortSignal.abort())).toEqual({ kind: 'cancelled' })
    f.editPrompt.mockReturnValueOnce(false)
    expect(await f.dispatch(activated('goal-edit:1'))).toEqual({ kind: 'failed', message: 'The prompt is not available' })
    Reflect.deleteProperty(f.options, 'editPrompt')
    expect(await f.dispatch(activated('goal-edit:1'))).toMatchObject({ message: 'The prompt is not available' })
    await f.update(undefined)
    expect(await f.dispatch(activated('goal-pause:1'))).toMatchObject({ kind: 'failed' })
    f.stop(); expect(await f.dispatch(activated('goal-pause:1'))).toEqual({ kind: 'cancelled' })
  })

  it.each(['cancel', 'binding', 'connection', 'unload'] as const)('fences native action settlement after %s without cancelling a sent write', async reason => {
    for (const fails of [false, true]) {
      const f = await fixture()
      const pending = Promise.withResolvers<ReturnType<typeof good<undefined>>>()
      f.goals.pause.mockReturnValueOnce(pending.promise)
      const caller = new AbortController()
      const result = f.dispatch(activated('goal-pause:1'), caller.signal)
      if (reason === 'cancel') caller.abort()
      if (reason === 'binding') f.replaceBinding(true)
      if (reason === 'connection') f.reconnect()
      if (reason === 'unload') f.stop()
      if (fails) pending.reject(new Error('late native refusal'))
      else pending.resolve(good(undefined))
      expect(await result).toEqual({ kind: 'cancelled' })
      expect(f.goals.pause).toHaveBeenCalledOnce()
      expect(f.options.notice.set).not.toHaveBeenCalled()
    }
  })

  it('checks exact binding and connection before edit and every write, including synchronous ownership loss', async () => {
    const f = await fixture()
    f.replaceBinding(true)
    expect(await f.dispatch(activated('goal-pause:1'))).toMatchObject({ kind: 'failed' })
    expect(f.goals.pause).not.toHaveBeenCalled()
    f.select(true); await tick()
    f.editPrompt.mockImplementationOnce((_text, current) => { f.replaceBinding(true); expect(current()).toBe(false); return false })
    expect(await f.dispatch(activated('goal-edit:1'))).toMatchObject({ kind: 'failed' })
    f.select(true); await tick()
    const signal = new AbortController()
    const selected = f.options.hosts.current()!
    const list = vi.spyOn(f.options.hosts, 'list')
    list.mockImplementationOnce(() => { signal.abort(); return [selected.client] })
    expect(await f.dispatch(activated('goal-pause:1'), signal.signal)).toEqual({ kind: 'cancelled' })
    expect(f.goals.pause).not.toHaveBeenCalled()
  })
})

describe('shared reference Goal rendering', () => {
  it('shares every phase, activation, key and blocked reason across native and Remote, including locale updates', async () => {
    const f = await fixture()
    for (const value of [undefined, goal(), goal({ activation: 'disarmed' }), goal({ phase: 'paused' }), goal({ phase: 'paused', roundsStarted: 5 }), goal({ phase: 'blocked', blockedReason: { code: 'budget', message: 'Native detail 你好 '.repeat(20) } }), goal({ phase: 'blocked' }), goal({ phase: 'complete' })]) {
      const state = { goal: value }
      goalSummary(state, translate)
      for (const width of [1, 8, 20, 40, 80, 120]) expect(f.render(goalPanel(state, translate), width).every(row => visibleWidth(row) <= width)).toBe(true)
    }
    expect(goalSummary({ goal: undefined, done: { rounds: 2, total: 3 } }, translate)).not.toBeNull()
    f.ctx.mayflyLocale.setPreference('zh')
    expect(JSON.stringify(f.node())).toContain('清除这个目标？')
    expect(JSON.stringify(f.summary())).toContain('目标')
  })
})
