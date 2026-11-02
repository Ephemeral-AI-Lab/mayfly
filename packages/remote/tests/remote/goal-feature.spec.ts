/** Native Goal revision checks, command/editor settlement and stale result isolation. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { visibleWidth } from '@ephemeral-ai/mayfly/core'
import type { MayflyFieldValue, MayflySubmittedField, MayflyUiActionEvent } from '@ephemeral-ai/mayfly-ui'
import { mountGoalFeature } from '../../src/remote/features/goal.ts'
import { remoteGoalPanel, remoteGoalSummary, type RemoteGoalView } from '../../src/remote/panels/goal.ts'
import type { RemoteBrowserOptions } from '../../src/remote/panels/browser.ts'
import { requestOverlay } from '../../src/remote/interactions/request-overlay.ts'
import { taskFixture, tick, translate, activated, good, bad } from './task-feature-fixture.ts'

const native = vi.hoisted(() => ({ browser: vi.fn(), editor: vi.fn() }))
vi.mock('../../src/remote/panels/browser.ts', () => ({ openRemoteBrowser: native.browser }))
vi.mock('../../src/remote/interactions/request-overlay.ts', () => ({ requestOverlay: native.editor }))
type Edit = { readonly objective: string, readonly maxGoalRounds?: number }
type EditorOptions = Parameters<typeof requestOverlay<Edit | undefined>>[1]
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop(); vi.restoreAllMocks(); vi.useRealTimers(); native.browser.mockReset(); native.editor.mockReset() })
const goal = (extra: Partial<RemoteGoalView> = {}): RemoteGoalView => ({ id: 'goal' as RemoteGoalView['id'], revision: 1, objective: 'Finish the actual task', maxGoalRounds: 5, roundsStarted: 1, phase: 'active', activation: 'armed', createdAt: 1_000, updatedAt: 1_000, ...extra })
const save = (objective: MayflyFieldValue = 'Edited task', rounds?: MayflyFieldValue): MayflyUiActionEvent => {
  const fields: MayflySubmittedField[] = [{ id: 'objective', change: 'set', value: objective }]
  if (rounds !== undefined) fields.push({ id: 'rounds', change: 'set', value: rounds })
  return { ...activated('save'), inputs: { actionId: 'save', draftRevision: 1, source: [], forms: [{ formId: 'goal-edit', pagePath: [], draftRevision: 1, fields }] } }
}

async function fixture(initial: RemoteGoalView | null = goal(), selected = true) {
  const f = await taskFixture(selected)
  f.goals.get.mockResolvedValue(good(initial ?? undefined))
  const panels: Array<{ options: RemoteBrowserOptions, refresh: ReturnType<typeof vi.fn<() => void>>, close: ReturnType<typeof vi.fn<() => void>> }> = []
  const editors: Array<{ options: EditorOptions, resolve: (edit: Edit | undefined) => void, reject: (error: unknown) => void, cancel: ReturnType<typeof vi.fn<() => void>> }> = []
  native.browser.mockImplementation((_ctx, options: RemoteBrowserOptions) => { let closed = false; const handle = { options, refresh: vi.fn(), close: vi.fn(() => { if (closed) return; closed = true; options.onClosed?.() }), get closed() { return closed } }; panels.push(handle); return handle })
  native.editor.mockImplementation((_ctx, options: EditorOptions) => { const result = Promise.withResolvers<Edit | undefined>(); const cancel = vi.fn(() => result.resolve(undefined)); editors.push({ options, resolve: result.resolve, reject: result.reject, cancel }); return { result: result.promise, cancel, refresh: vi.fn(), reveal: vi.fn() } })
  const stop = mountGoalFeature(f.options)
  cleanups.push(async () => { stop(); await f.dispose() })
  await tick()
  return { ...f, panels, editors, stop, node: () => f.pane('mayfly.view.goal')?.node ?? null, summary: () => f.pane('mayfly.view.goal')?.summary ?? null,
    update: async (next: RemoteGoalView | undefined) => { f.goals.get.mockResolvedValue(good(next)); f.state.goal.set(next); await tick() },
  }
}
const panelText = (f: Awaited<ReturnType<typeof fixture>>) => JSON.stringify(f.panels.at(-1)?.options.view())

async function edit(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await f.dispatch(activated('goal-edit:1'))).toEqual({ kind: 'completed' })
  const current = f.editors.at(-1)!
  expect(current.options.isCurrent()).toBe(true)
  expect(JSON.stringify(current.options.view())).toContain('Maximum rounds')
  return current
}

describe('Goal native facts and explicit commands', () => {
  it('keeps revision-carrying actions, native activation notifications and the reference completion linger', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(2_000)
    const f = await fixture(null, false)
    expect(f.node()).toBeNull(); await f.run('goal'); expect(f.options.notice.set).toHaveBeenCalledWith('No goal is currently set.')
    f.select(true); await f.update(goal())
    expect(f.render(f.node()).join('\n')).toContain('Finish the actual task')
    await f.run('goal')
    expect(f.panels.at(-1)!.options.isCurrent()).toBe(true); expect(panelText(f)).toContain('Goal')
    const calls = f.goals.get.mock.calls.length
    f.event('goal/activation-changed', { sessionId: 'unrelated' }); expect(f.goals.get).toHaveBeenCalledTimes(calls)
    f.event('goal/activation-changed', { sessionId: 'session' }); await tick()
    expect(f.goals.get).toHaveBeenCalledTimes(calls + 1)
    await f.update(goal({ phase: 'blocked', blockedReason: { code: 'limit', message: 'quota used' } }))
    expect(f.ctx.mayflyUiInteraction.notificationSnapshot().some(row => row.message.includes('Goal blocked · limit: quota used'))).toBe(true)
    await f.update(goal({ phase: 'blocked' }))
    expect(f.ctx.mayflyUiInteraction.notificationSnapshot()).toEqual([])
    await f.update(goal({ phase: 'complete' }))
    expect(f.node()).toBeNull(); expect(JSON.stringify(f.summary())).toContain('✓')
    await vi.advanceTimersByTimeAsync(5_000); expect(f.summary()).toBeNull()
    await f.update(goal({ phase: 'complete', id: 'other' as RemoteGoalView['id'] }))
    expect(f.summary()).toBeNull()
    await f.update(undefined); await f.run('goal'); expect(panelText(f)).toContain('No goal is currently set.')
    await f.update(goal()); await f.update(goal({ phase: 'complete' })); f.select(false)
    expect(f.summary()).toBeNull(); expect(vi.getTimerCount()).toBe(0)
  })

  it('routes create/edit and every verb with the exact Goal revision, preserving native refusal', async () => {
    const f = await fixture()
    await f.run('goal', 'create New objective'); await f.run('goal', 'Implicit objective')
    expect(f.goals.create).toHaveBeenCalledWith('session', { objective: 'Implicit objective' })
    await f.run('goal', 'edit Changed objective')
    expect(f.goals.edit).toHaveBeenCalledWith('session', { id: 'goal', revision: 1 }, { objective: 'Changed objective' })
    await f.run('goal')
    expect(await f.panels.at(-1)!.options.action!(activated('goal-pause:1'), { surfaceId: 'remote.goal', source: [], signal: new AbortController().signal, revision: 1, operationId: 'pause', report: vi.fn() })).toEqual({ kind: 'completed' })
    for (const verb of ['pause', 'resume', 'complete', 'clear'] as const) {
      await f.run('goal', verb)
      expect(f.goals[verb]).toHaveBeenCalledWith('session', { id: 'goal', revision: 1 })
      expect(await f.dispatch(activated(`goal-${verb}:1`))).toEqual({ kind: 'completed' })
    }
    f.goals.pause.mockResolvedValueOnce(bad('revision conflict') as never)
    expect(await f.dispatch(activated('goal-pause:1'))).toMatchObject({ kind: 'failed', message: 'revision conflict' })
    f.goals.pause.mockResolvedValueOnce(bad('revision conflict') as never)
    await expect(f.run('goal', 'pause')).rejects.toThrow('revision conflict')
    f.goals.create.mockResolvedValueOnce(bad('create denied') as never)
    await expect(f.run('goal', 'create Reject')).rejects.toMatchObject({ message: 'create denied' })
    f.goals.edit.mockResolvedValueOnce(bad('edit denied') as never)
    await expect(f.run('goal', 'edit Reject')).rejects.toMatchObject({ message: 'edit denied' })
    expect(await f.dispatch(activated('unrelated'))).toEqual({ kind: 'completed' })
    expect(await f.dispatch(activated('goal-invalid'))).toEqual({ kind: 'completed' })
    expect(await f.dispatch({ kind: 'dismiss', pagePath: [] })).toEqual({ kind: 'completed' })
    expect(await f.dispatch(activated('goal-pause:2'))).toMatchObject({ kind: 'failed', message: 'The goal changed; open it again' })
    await f.update(undefined)
    expect(await f.dispatch(activated('goal-pause:1'))).toMatchObject({ kind: 'failed' })
    await f.run('goal', 'clear'); expect(f.options.notice.set).toHaveBeenLastCalledWith('No goal is currently set.')
    await expect(f.run('goal', 'pause')).rejects.toThrow('No current goal')
    f.select(false)
    await expect(f.run('goal', 'create One')).rejects.toThrow('No current goal')
    await expect(f.run('goal', 'create One', AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
    expect(await f.dispatch(activated('goal-pause:1'))).toMatchObject({ kind: 'failed' })
  })

  it('fences replaced/failed Goal reads, native writes and explicit command cancellation', async () => {
    const f = await fixture()
    for (const reject of [false, true]) {
      const result = Promise.withResolvers<unknown>()
      f.goals.get.mockReturnValueOnce(result.promise); f.state.goal.set({})
      f.state.goal.set({}); await tick()
      if (reject) result.reject(new Error('stale get failure'))
      else result.resolve(good(undefined))
      await tick(); expect(f.node()).not.toBeNull()
    }
    for (const failure of [new Error('get failed'), 'get failed']) {
      f.goals.get.mockRejectedValueOnce(failure); f.state.goal.set({}); await tick()
      expect(f.options.notice.set).toHaveBeenCalledWith('get failed')
    }
    f.goals.get.mockResolvedValueOnce(bad('get denied')); f.state.goal.set({}); await tick()
    expect(f.options.notice.set).toHaveBeenCalledWith('get denied')
    for (const verb of ['create', 'edit', 'pause'] as const) {
      const result = Promise.withResolvers<ReturnType<typeof good<undefined>>>()
      f.goals[verb].mockReturnValueOnce(result.promise)
      const cancellation = new AbortController()
      const pending = f.run('goal', verb === 'pause' ? verb : `${verb} Pending`, cancellation.signal)
      cancellation.abort(); result.resolve(good(undefined)); await pending
      expect(f.options.notice.set).not.toHaveBeenLastCalledWith(verb === 'create' ? 'Goal created' : verb === 'edit' ? 'Goal updated' : 'Goal paused')
      const stale = Promise.withResolvers<ReturnType<typeof good<undefined>>>()
      f.goals[verb].mockReturnValueOnce(stale.promise)
      const previous = f.run('goal', verb === 'pause' ? verb : `${verb} Pending`)
      f.reconnect(); stale.resolve(good(undefined)); await previous; await tick()
    }
    const callbacks = [...f.state.goal.listeners, ...f.topology]
    f.detach(); f.event('goal/activation-changed', { sessionId: 'session' })
    f.stop(); f.stop(); for (const callback of callbacks) callback()
    expect(f.ctx.mayflyPanes.list()).toEqual([])
  })

  it('handles selection changes inside queued reads, pane publication and pending mutations', async () => {
    const f = await fixture()
    const queued = [...f.state.goal.listeners]
    f.silentlyDeselect()
    const calls = f.goals.get.mock.calls.length
    for (const callback of queued) callback()
    expect(f.goals.get).toHaveBeenCalledTimes(calls)
    f.select(true); await tick()
    const stop = f.ctx.mayflyPanes.subscribe(delta => {
      if (delta.kind === 'upsert' && JSON.stringify(delta.entry.node).includes('quota used')) f.silentlyDeselect()
    })
    await f.update(goal({ phase: 'blocked', blockedReason: { code: 'limit', message: 'quota used' } }))
    stop()
    expect(f.ctx.mayflyUiInteraction.notificationSnapshot()).toEqual([])
    f.select(true); await tick()
    const pending = Promise.withResolvers<ReturnType<typeof good<undefined>>>()
    f.goals.pause.mockReturnValueOnce(pending.promise)
    const result = f.run('goal', 'pause')
    f.silentlyDeselect(); pending.resolve(good(undefined)); await result
    expect(f.options.notice.set).not.toHaveBeenCalledWith('Goal paused')
  })
})

describe('Goal revision-bound editor', () => {
  it('validates native form values and edits only an acknowledged valid result', async () => {
    const f = await fixture(); const editor = await edit(f)
    const invalid = [{ kind: 'dismiss', pagePath: [] }, activated('unrelated'), activated('save'), save(''), save('  '), save(1), save('ok', '0'), save('ok', '-1'), save('ok', '1.5'), save('ok', 'NaN')]
    for (const event of invalid) expect(editor.options.answer(event as MayflyUiActionEvent)).toBeUndefined()
    const missingFields = save() as Extract<MayflyUiActionEvent, { kind: 'activate' }>
    expect(editor.options.answer({ ...missingFields, inputs: { ...missingFields.inputs!, forms: [] } })).toBeUndefined()
    expect(editor.options.answer({ ...missingFields, inputs: { ...missingFields.inputs!, forms: [{ ...missingFields.inputs!.forms[0]!, fields: [] }] } })).toBeUndefined()
    expect(editor.options.answer(save(' objective ', '3'))).toEqual({ objective: 'objective', maxGoalRounds: 3 })
    expect(editor.options.answer(save(' objective ', ' '))).toEqual({ objective: 'objective' })
    expect(editor.options.answer(save(' objective ', 3))).toEqual({ objective: 'objective' })
    expect(editor.options.answer(save(' objective '))).toEqual({ objective: 'objective' })
    expect(editor.options.cancelled('dismiss')).toBeUndefined()
    editor.resolve({ objective: 'Accepted objective', maxGoalRounds: 3 }); await tick()
    expect(f.goals.edit).toHaveBeenCalledWith('session', { id: 'goal', revision: 1 }, { objective: 'Accepted objective', maxGoalRounds: 3 })
    expect(f.options.notice.set).toHaveBeenCalledWith('Goal updated')
    const noRounds = await edit(f); noRounds.resolve({ objective: 'Only objective' }); await tick()
    expect(f.goals.edit).toHaveBeenLastCalledWith('session', { id: 'goal', revision: 1 }, { objective: 'Only objective' })
    for (const width of [1, 8, 20, 40, 80, 120]) expect(f.render(editor.options.view(), width).every(row => visibleWidth(row) <= width)).toBe(true)
  })

  it('requires current identity and revision again before native editing, then fences late failures', async () => {
    const f = await fixture()
    const editor = await edit(f)
    await f.update(goal({ revision: 2 })); expect(editor.options.isCurrent()).toBe(false)
    editor.resolve({ objective: 'Stale objective' }); await tick(); expect(f.goals.edit).not.toHaveBeenCalled()
    await f.update(goal()); const replacedId = await edit(f)
    await f.update(goal({ id: 'replacement' as RemoteGoalView['id'] })); expect(replacedId.options.isCurrent()).toBe(false)
    replacedId.resolve(undefined); await tick()
    await f.update(goal()); const missing = await edit(f)
    await f.update(undefined); expect(missing.options.isCurrent()).toBe(false); missing.resolve(undefined); await tick()
    await f.update(goal()); const detached = await edit(f)
    f.silentlyDeselect(); expect(detached.options.isCurrent()).toBe(false); detached.resolve({ objective: 'Stale Host' }); await tick()
    f.select(true); await tick(); const stale = await edit(f)
    stale.cancel.mockImplementationOnce(() => {})
    f.reconnect(); expect(stale.options.isCurrent()).toBe(false); stale.resolve({ objective: 'Stale generation' }); await tick()
    const reject = await edit(f)
    const pending = Promise.withResolvers<ReturnType<typeof good<undefined>>>()
    f.goals.edit.mockReturnValueOnce(pending.promise)
    reject.resolve({ objective: 'Pending edit' }); await tick(); f.reconnect(); pending.reject('retired edit failure'); await tick()
    expect(f.options.notice.set).not.toHaveBeenCalledWith('retired edit failure')
  })

  it('shows native edit refusals/errors only for the current exact owner and keeps settled timer callbacks harmless', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const f = await fixture()
    let editor = await edit(f)
    f.goals.edit.mockResolvedValueOnce(bad('edit refused') as never); editor.resolve({ objective: 'Rejected' }); await tick()
    expect(f.options.notice.set).toHaveBeenCalledWith('edit refused')
    for (const error of [new Error('editor failed'), 'editor failed']) {
      editor = await edit(f); editor.reject(error); await tick()
      expect(f.options.notice.set).toHaveBeenCalledWith('editor failed')
    }
    editor = await edit(f)
    const pending = Promise.withResolvers<ReturnType<typeof good<undefined>>>()
    f.goals.edit.mockReturnValueOnce(pending.promise); editor.resolve({ objective: 'Late edit' }); await tick()
    f.reconnect(); pending.resolve(good(undefined)); await tick()
    await f.update(goal({ phase: 'complete' }))
    const callback = timers.mock.calls.findLast(call => call[1] === 5_000)![0] as () => void
    f.stop(); callback()
    expect(f.ctx.mayflyPanes.list()).toEqual([])
  })
})

describe('Goal shared presentation', () => {
  it('keeps every phase, activation, round limit and blocked reason within narrow widths', async () => {
    const f = await fixture()
    const states = [undefined, goal(), goal({ activation: 'disarmed' }), goal({ phase: 'paused' }), goal({ phase: 'paused', roundsStarted: 5 }), goal({ phase: 'blocked', blockedReason: { code: 'budget', message: 'Native detail 你好 '.repeat(20) } }), goal({ phase: 'blocked' }), goal({ phase: 'complete' })]
    for (const value of states) {
      const state = { goal: value }
      remoteGoalSummary(state, translate)
      for (const width of [1, 8, 20, 40, 80, 120]) expect(f.render(remoteGoalPanel(state, translate), width).every(row => visibleWidth(row) <= width)).toBe(true)
    }
    expect(remoteGoalSummary({ goal: undefined, done: { rounds: 2, total: 3 } }, translate)).not.toBeNull()
  })
})
