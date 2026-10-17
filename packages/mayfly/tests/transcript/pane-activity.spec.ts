/**
 * `mayfly-pane-activity` plugin: the activity row above the editor. Decision tests of the phases and their labels, the
 * header and its tail, the second line (the arguments of the calls in flight, else the tip), the tick that re-reads the
 * elapsed time while the row is live, the dialog hide, the stopping hold, the locale switch, the seed on attach, the
 * responsive narrowing, and the unload.
 * @module @ephemeral-ai/mayfly/tests/transcript/pane-activity
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import * as activity from '../../src/transcript/pane-activity.ts'
import { buildTipRotation } from '../../src/transcript/status-tips.ts'
import { loaderFrameGlyph } from '../../src/core/ui-loader-animation.ts'
import { STATUS_TIPS } from '../../src/transcript/tips-content.ts'
import type { TickSource } from '../../src/transcript/tick.ts'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'
import { initialConversationFacts } from '../../src/conversation/facts.ts'
import { visibleWidth } from '../../src/core/width.ts'
import { bootPanePlugin, type PaneFakeScreen, type PanePluginHarness } from './pane-fakes.ts'
import { asAgent, fakeAgent, type FakeAgent } from './status-fakes.ts'
import { assistantEvent, reasoningDelta, resetSeq, textDelta, toolCallEvent, toolResultEvent, turnEnd, turnStart } from './helpers.ts'
// Empty type import activates the 'settings/document-updated' Events merge.
import type {} from '@deepseek-ai/dsh-settings'

/** The host's one-second tick, driven by the spec: each `fire` is one tick, and the subscriptions are counted. */
class FakeTick implements TickSource {
  private readonly listeners = new Set<(now: number) => void>()
  subscribe(listener: (now: number) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  fire(now: number): void {
    for (const listener of [...this.listeners]) listener(now)
  }
  get subscribers(): number { return this.listeners.size }
}

/** Stopping hold timers, recorded: the hold is the only timer the row owns. */
class FakeTimers implements activity.ActivityTimers {
  readonly timeouts: { readonly ms: number, fire: () => void, cleared: boolean }[] = []
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
    // A timer that fired or was cleared is no longer live.
    const entry = { ms, cleared: false, fire: (): void => { entry.cleared = true; callback() } }
    this.timeouts.push(entry)
    return entry as unknown as ReturnType<typeof setTimeout>
  }
  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    const entry = handle as unknown as { cleared: boolean }
    entry.cleared = true
  }
  get live(): number { return this.timeouts.filter(entry => !entry.cleared).length }
}

/** The notification line above the editor is another pane's: the activity rows are the non-blank lines it does not draw. */
function rows(screen: PaneFakeScreen, width?: number): string[] {
  return screen.paneLines(width).filter(line => line.trim() !== '' && !line.includes('Alt+'))
}

afterEach(() => {
  activity.setActivityTimers(undefined)
  activity.setActivityClock(undefined)
  resetSeq()
})

/** The pinned clock: one minute after the fixture event epoch. */
const NOW = 1_700_000_060_000
const FIRST_TIP = buildTipRotation(STATUS_TIPS)[0]!.text
/** The loader glyph of a model phase at a frame: `fill` for the writing and waiting phases. */
const fill = (frame = 0): string => loaderFrameGlyph('fill', frame)

/** A fake agent whose status is running. */
function runningAgent(agent: FakeAgent): FakeAgent {
  agent.status = 'running'
  return agent
}

type Facts = ReturnType<typeof initialConversationFacts>

/**
 * Boot the pane over a hand-driven facts stream, a mutable `mayfly` settings section, a fake tick, and a pinned clock.
 * @param initial - the facts the row starts from (the session is active unless said otherwise).
 * @param settings - the `mayfly` settings section the row reads.
 * @param stopPending - whether a stop is latched.
 * @param status - the Agent's status at mount.
 * @param processTimers - keep the process timers (the test drives them with fake global timers) instead of the recorded ones.
 */
async function bootFacts(initial: Partial<Facts>, settings: Record<string, unknown> = {}, stopPending = false, status: 'running' | 'idle' = 'running', processTimers = false) {
  const timers = new FakeTimers()
  if (!processTimers) activity.setActivityTimers(timers)
  /** The messages of the notices the pane's owners raised, in order. */
  const reported: string[] = []
  let now = NOW
  activity.setActivityClock(() => now)
  const tick = new FakeTick()
  const agent = fakeAgent([])
  agent.status = status
  let listener: ((value: Facts) => void) | undefined
  const agentListeners = new Set<(value: ReturnType<typeof asAgent>) => void>()
  let facts: Facts = { ...initialConversationFacts(), active: true, ...initial }
  const section = { value: settings }
  let stop = stopPending
  const harness: PanePluginHarness = await bootPanePlugin(activity, agent, {
    mayflyTick: tick,
    mayflyUiInteraction: { notificationSnapshot: (): readonly never[] => [], subscribe: () => () => {}, createNotificationOwner: () => ({ report: (_id: string, _scope: unknown, feedback: { readonly message: string }) => { reported.push(feedback.message) }, clear() {}, clearAll() {}, dispose() {} }) },
    mayflyInteractionState: { settingsSource: () => section.value },
    mayflyRequests: { stopPending: () => stop },
    mayflySessionFacts: {
      get current() { return facts },
      currentAgent: asAgent(agent),
      subscribe(next: (value: Facts) => void) {
        listener = next
        next(facts)
        return () => {}
      },
      currentGoal: null,
      subscribeGoal() { return () => {} },
      subscribeAgent(next: (value: ReturnType<typeof asAgent>) => void) {
        agentListeners.add(next)
        next(asAgent(agent))
        return () => { agentListeners.delete(next) }
      },
    },
  })
  return {
    ...harness,
    timers,
    tick,
    reported,
    /** The turn ends: the facts go inactive and the Agent's status flips back to idle. */
    idle() {
      facts = { ...facts, active: false, phase: 'idle' }
      listener?.(facts)
      agent.status = 'idle'
      for (const next of agentListeners) next(asAgent(agent))
    },
    push(next: Partial<Facts>) {
      facts = { ...facts, ...next }
      listener?.(facts)
    },
    advance(ms: number) { now += ms },
    settings(value: Record<string, unknown>) {
      section.value = value
      harness.ctx.emit('settings/document-updated', 'mayfly' as never, 1)
    },
    stop(pending: boolean) {
      stop = pending
      harness.ctx.emit('mayfly/request-stop-changed', pending)
    },
  }
}

describe('mayfly-pane-activity', () => {
  it('registers one bottom pane over its stable inject list, and draws no row while idle', async () => {
    expect(activity.name).toBe('mayfly-pane-activity')
    expect(activity.inject).toEqual(['mayflyPanes', 'mayflySessionFacts', 'mayflyTick', 'mayflyUiInteraction', 'mayflyConversations', 'mayflyKeymap'])
    const harness = await bootFacts({ active: false, phase: 'idle' }, {}, false, 'idle')
    expect(harness.ctx.mayflyPanes.list().find(entry => entry.id === 'mayfly.pane.activity')?.definition.title).toBeUndefined()
    expect(rows(harness.screen)).toEqual([])
    await harness.dispose()
  })

  it('draws the waiting row with its tip on the line under it, and holds the tick only while the row is live', async () => {
    const harness = await bootFacts({ phase: 'waiting', turnStartedAt: NOW })
    expect(rows(harness.screen)).toEqual([`  ${fill()} Deep diving · 0s`, `    ⎿ Tip: ${FIRST_TIP}`])
    // The glyph moves on the core's clock, not the pane's: the pane owns no frame timer, only the shared tick.
    // The row and the notification row's hint rotation (R6) share the host tick while a turn runs.
    expect(harness.tick.subscribers).toBe(2)
    expect(harness.timers.live).toBe(0)
    harness.idle()
    expect(rows(harness.screen)).toEqual([])
    expect(harness.tick.subscribers).toBe(0)
    await harness.dispose()
    expect(harness.tick.subscribers).toBe(0)
  })

  it('re-reads the elapsed time from the turn start on each tick', async () => {
    const harness = await bootFacts({ phase: 'waiting', turnStartedAt: NOW - 3_000 })
    expect(rows(harness.screen)[0]).toBe(`  ${fill()} Deep diving · 3s`)
    harness.advance(2_000)
    harness.tick.fire(NOW + 2_000)
    expect(rows(harness.screen)[0]).toBe(`  ${fill()} Deep diving · 5s`)
    // An idle Agent carries no elapsed anchor.
    harness.idle()
    expect(rows(harness.screen)).toEqual([])
    await harness.dispose()
  })

  it('does not republish when a facts delta leaves the row shape unchanged', async () => {
    const harness = await bootFacts({ phase: 'waiting', turnStartedAt: NOW })
    const revision = harness.ctx.mayflyPanes.list().find(entry => entry.id === 'mayfly.pane.activity')!.revision
    harness.push({ flowDownChars: 120, contextTokens: 3_000 })
    expect(harness.ctx.mayflyPanes.list().find(entry => entry.id === 'mayfly.pane.activity')!.revision).toBe(revision)
    await harness.dispose()
  })

  it('names the running category by its present-tense label, and puts the calls\' arguments on the line under it', async () => {
    const harness = await bootFacts({ phase: 'tool', inFlight: [{ callId: 'c1', name: 'bash', detail: 'pnpm test' }] })
    expect(rows(harness.screen)).toEqual(['  ● Running commands', '    ⎿ pnpm test'])
    // Several calls in flight of different categories count instead of naming one.
    harness.push({ inFlight: [{ callId: 'c1', name: 'bash', detail: 'pnpm test' }, { callId: 'c2', name: 'read', detail: 'src/a.ts' }] })
    expect(rows(harness.screen)[0]).toBe('  ● Running 2 tools')
    // A call whose arguments still stream is named by its preparing label.
    harness.push({ inFlight: [{ callId: 'c3', name: 'write', preparing: true }] })
    expect(rows(harness.screen)[0]).toBe(`  ● Preparing to write files`)
    // A spawn is not named by the row: the agents pane owns its detail.
    harness.push({ inFlight: [{ callId: 'c4', name: 'subagent', detail: 'Review' }] })
    expect(rows(harness.screen)[0]).toBe('  ● Coordinating subagents')
    await harness.dispose()
  })

  it('names the thinking stage by how long the model has thought, and the writing phase by its label', async () => {
    const harness = await bootFacts({ phase: 'thinking', outputProgress: { chars: 0, initialChars: 0, startedAt: NOW - 1_000, updatedAt: NOW } })
    expect(rows(harness.screen)[0]).toMatch(/^ {2}\S Pondering/u)
    harness.push({ outputProgress: { chars: 0, initialChars: 0, startedAt: NOW - 20_000, updatedAt: NOW } })
    expect(rows(harness.screen)[0]).toMatch(/^ {2}\S DeepThinking/u)
    harness.push({ phase: 'composing', outputProgress: undefined })
    expect(rows(harness.screen)[0]).toBe(`  ${fill()} Writing`)
    await harness.dispose()
  })

  it('hides the row while a dialog takes the editor slot, and returns with a fresh tip', async () => {
    const harness = await bootFacts({ phase: 'waiting', turnStartedAt: NOW })
    expect(rows(harness.screen)).toHaveLength(2)
    harness.ctx.emit('mayfly/editor-slot-swapped', true)
    expect(rows(harness.screen)).toEqual([])
    expect(harness.tick.subscribers).toBe(1)
    harness.ctx.emit('mayfly/editor-slot-swapped', false)
    expect(rows(harness.screen)[1]).toBe(`    ⎿ Tip: ${buildTipRotation(STATUS_TIPS)[1]!.text}`)
    await harness.dispose()
  })

  it('shows the static stopping row while a stop drains, held for its minimum once the turn settles', async () => {
    const harness = await bootFacts({ phase: 'tool', inFlight: [{ callId: 'c1', name: 'bash', detail: 'sleep 9' }] })
    harness.stop(true)
    expect(rows(harness.screen)).toEqual(['  ■ interrupting…', `    ⎿ Tip: ${FIRST_TIP}`])
    // The turn settles at once: the acknowledgment holds for the rest of its 600 ms.
    harness.push({ active: false, phase: 'idle', inFlight: [] })
    harness.stop(false)
    expect(rows(harness.screen)[0]).toBe('  ■ interrupting…')
    expect(harness.timers.timeouts.at(-1)).toMatchObject({ ms: 600 })
    harness.timers.timeouts.at(-1)!.fire()
    expect(rows(harness.screen)).toEqual([`  ${fill()} Deep diving`, `    ⎿ Tip: ${FIRST_TIP}`])
    await harness.dispose()
    expect(harness.timers.live).toBe(0)
  })

  it('cancels a pending stopping hold when a fresh stop lands, and when the pane unloads', async () => {
    const harness = await bootFacts({ phase: 'waiting' })
    harness.stop(true)
    harness.stop(false)
    expect(harness.timers.live).toBe(1)
    harness.stop(true)
    expect(harness.timers.live).toBe(0)
    harness.stop(false)
    expect(harness.timers.live).toBe(1)
    await harness.dispose()
    expect(harness.timers.live).toBe(0)
  })

  it('keeps the one hold when the native settle repeats inside it', async () => {
    const harness = await bootFacts({ phase: 'waiting' })
    harness.stop(true)
    harness.stop(false)
    harness.stop(false)
    expect(harness.timers.timeouts).toHaveLength(1)
    expect(harness.timers.live).toBe(1)
    harness.timers.timeouts.at(-1)!.fire()
    expect(rows(harness.screen)[0]).not.toBe('  ■ interrupting…')
    await harness.dispose()
    expect(harness.timers.live).toBe(0)
  })

  it('starts in the stopping row when a stop is already draining at mount', async () => {
    const harness = await bootFacts({ phase: 'waiting' }, {}, true)
    expect(rows(harness.screen)[0]).toBe('  ■ interrupting…')
    await harness.dispose()
  })

  it('keeps the header whole while it fits, sheds its counters and then its time as the row narrows, and never draws past the width', async () => {
    const harness = await bootFacts({ phase: 'composing', turnStartedAt: NOW - 21_000, flowUp: 30 * 1024, flowDownChars: 16 * 1024 })
    expect(rows(harness.screen, 200)).toEqual([`  ${fill()} Writing · 21s · ↑30k ↓4k`, `    ⎿ Tip: ${FIRST_TIP}`])
    // The counters go first, then the time; the label stays.
    expect(rows(harness.screen, 30)[0]).toBe(`  ${fill()} Writing · 21s · ↑30k ↓4k`)
    expect(rows(harness.screen, 22)[0]).toBe(`  ${fill()} Writing`)
    for (const width of [30, 22, 16, 12, 4]) {
      expect(rows(harness.screen, width).every(line => visibleWidth(line) <= width)).toBe(true)
    }
    await harness.dispose()
  })

  it('reads the locale of the labels again when the locale changes, in place', async () => {
    const harness = await bootFacts({ phase: 'tool', inFlight: [{ callId: 'c1', name: 'bash', detail: 'ls' }] })
    const pane = harness.screen.bottomChildren.find(child => child !== undefined)
    const localeFiber = await harness.ctx.plugin({
      name: 'activity-locale-zh',
      apply(ctx: Context) {
        const locale = new MayflyLocaleService(ctx, { systemLocale: 'zh' })
        ctx.effect(() => () => locale.dispose())
      },
    })
    await Promise.resolve()
    expect(rows(harness.screen)[0]).toContain('正在运行命令')
    expect(harness.screen.bottomChildren.find(child => child !== undefined)).toBe(pane)
    await localeFiber.dispose()
    await harness.dispose()
  })

  it('seeds the phase from the snapshot on attach, and counts from the phase\'s own start', async () => {
    activity.setActivityClock(() => NOW)
    const agent = runningAgent(fakeAgent([turnStart(1), reasoningDelta(1, 1, 'mid-thought')]))
    const harness = await bootPanePlugin(activity, agent, {
      mayflyTick: new FakeTick(),
      mayflyUiInteraction: { notificationSnapshot: (): readonly never[] => [], subscribe: () => () => {}, createNotificationOwner: () => ({ report() {}, clear() {}, clearAll() {}, dispose() {} }) },
    })
    // The turn started a minute before the pinned clock: the thinking stage has reached its last label.
    expect(rows(harness.screen)[0]).toMatch(/^ {2}\S Fathoming · \d+[sm]/u)
    await harness.dispose()
  })

  it('takes the phase from the Agent status while the projection is still idle', async () => {
    const agent = runningAgent(fakeAgent([]))
    const facts = initialConversationFacts()
    const harness = await bootPanePlugin(activity, agent, {
      mayflyTick: new FakeTick(),
      mayflyUiInteraction: { notificationSnapshot: (): readonly never[] => [], subscribe: () => () => {}, createNotificationOwner: () => ({ report() {}, clear() {}, clearAll() {}, dispose() {} }) },
      mayflySessionFacts: {
        current: facts,
        currentAgent: asAgent(agent),
        subscribe(listener: (value: typeof facts) => void) {
          listener(facts)
          return () => {}
        },
        currentGoal: null,
        subscribeGoal() { return () => {} },
        subscribeAgent(listener: (value: ReturnType<typeof asAgent>) => void) {
          listener(asAgent(agent))
          return () => {}
        },
      },
    })
    expect(rows(harness.screen)).toEqual([`  ${fill()} Deep diving`, `    ⎿ Tip: ${FIRST_TIP}`])
    await harness.dispose()
  })

  it('follows the projection events of its own session: a text delta is writing, a finished turn is gone', async () => {
    const agent = runningAgent(fakeAgent([]))
    const harness = await bootPanePlugin(activity, agent, {
      mayflyTick: new FakeTick(),
      mayflyUiInteraction: { notificationSnapshot: (): readonly never[] => [], subscribe: () => () => {}, createNotificationOwner: () => ({ report() {}, clear() {}, clearAll() {}, dispose() {} }) },
    })
    expect(rows(harness.screen)[0]).toBe(`  ${fill()} Deep diving`)
    harness.ctx.emit('session/event', agent.session as never, textDelta(1, 1, 'answering'))
    expect(rows(harness.screen)[0]).toMatch(/^ {2}\S Writing/u)
    harness.ctx.emit('session/event', agent.session as never, toolCallEvent(1, 1, 'c0', 'bash', '{"command":"pnpm test"}'))
    expect(rows(harness.screen)[0]).toBe('  ● Running commands')
    harness.ctx.emit('session/event', agent.session as never, toolResultEvent(1, 1, 'c0', 'done'))
    harness.ctx.emit('session/event', agent.session as never, assistantEvent(1, 1, [{ type: 'text', text: 'done' }]))
    harness.ctx.emit('session/event', agent.session as never, turnEnd(1))
    expect(rows(harness.screen)).toEqual([])
    await harness.dispose()
  })

  it('leaves the other agents\' status flips and the foreign sessions\' events alone', async () => {
    const agent = fakeAgent([])
    const harness = await bootPanePlugin(activity, agent, {
      mayflyTick: new FakeTick(),
      mayflyUiInteraction: { notificationSnapshot: (): readonly never[] => [], subscribe: () => () => {}, createNotificationOwner: () => ({ report() {}, clear() {}, clearAll() {}, dispose() {} }) },
    })
    harness.ctx.emit('agent/status', { agent: asAgent(runningAgent(fakeAgent([]))), status: 'running' })
    expect(rows(harness.screen)).toEqual([])
    const foreign = fakeAgent([])
    harness.ctx.emit('session/event', foreign.session as never, textDelta(1, 1, 'x'))
    expect(rows(harness.screen)).toEqual([])
    await harness.dispose()
  })
  it('climbs the thinking ladder at 5, 15 and 45 seconds of one reasoning phase', async () => {
    const harness = await bootFacts({ phase: 'thinking', outputProgress: { chars: 0, initialChars: 0, startedAt: NOW - 4_000, updatedAt: NOW } })
    expect(rows(harness.screen)[0]).toMatch(/^ {2}\S Pondering/u)
    harness.push({ outputProgress: { chars: 0, initialChars: 0, startedAt: NOW - 5_000, updatedAt: NOW } })
    expect(rows(harness.screen)[0]).toMatch(/^ {2}\S Mulling/u)
    harness.push({ outputProgress: { chars: 0, initialChars: 0, startedAt: NOW - 15_000, updatedAt: NOW } })
    expect(rows(harness.screen)[0]).toMatch(/^ {2}\S DeepThinking/u)
    harness.push({ outputProgress: { chars: 0, initialChars: 0, startedAt: NOW - 45_000, updatedAt: NOW } })
    expect(rows(harness.screen)[0]).toMatch(/^ {2}\S Fathoming/u)
    await harness.dispose()
  })

  it('rotates the tip every fifteen ticks while the row is live', async () => {
    const harness = await bootFacts({ phase: 'waiting', turnStartedAt: NOW })
    const rotation = buildTipRotation(STATUS_TIPS)
    // The tip is found by its text: the notification row's hint rotation (R6) joins the rows above it at the same tick.
    const tipRow = (): string | undefined => rows(harness.screen).find(row => row.includes('Tip: '))
    expect(tipRow()).toBe(`    ⎿ Tip: ${rotation[0]!.text}`)
    for (let tick = 1; tick < 15; tick += 1) harness.tick.fire(NOW + tick * 1_000)
    expect(tipRow()).toBe(`    ⎿ Tip: ${rotation[0]!.text}`)
    harness.tick.fire(NOW + 15_000)
    expect(tipRow()).toBe(`    ⎿ Tip: ${rotation[1]!.text}`)
    await harness.dispose()
  })

  it('leaves the line under the header blank when the quiet hints are off, and keeps the call arguments', async () => {
    const harness = await bootFacts({ phase: 'waiting', turnStartedAt: NOW })
    expect(rows(harness.screen)).toHaveLength(2)
    harness.settings({ quietHints: 'off' })
    expect(rows(harness.screen)).toEqual([`  ${fill()} Deep diving · 0s`])
    harness.settings({ quietHints: 'full' })
    expect(rows(harness.screen)).toHaveLength(2)
    await harness.dispose()
  })

  it('keeps the wait for a decision above an approval panel, and hides under any other dialog', async () => {
    const harness = await bootFacts({ phase: 'tool', inFlight: [{ callId: 'c1', name: 'bash', detail: 'rm -rf build' }] })
    harness.ctx.emit('mayfly/decision-wait-changed', { kind: 'approval' } as never)
    harness.ctx.emit('mayfly/editor-slot-swapped', true)
    // The wait breathes its dot and shows how long it has waited.
    expect(rows(harness.screen)).toHaveLength(2)
    expect(rows(harness.screen)[0]).toMatch(/^ {2}\S? ?Waiting for your approval · 0s$/u)
    expect(rows(harness.screen)[1]).toBe(`    ⎿ Tip: ${FIRST_TIP}`)
    // A question waits in the same slot, and the row names the answer it waits for.
    harness.ctx.emit('mayfly/decision-wait-changed', undefined as never)
    expect(rows(harness.screen)).toEqual([])
    harness.ctx.emit('mayfly/decision-wait-changed', { kind: 'answer' } as never)
    expect(rows(harness.screen)[0]).toMatch(/^ {2}\S? ?Waiting for your answer · 0s$/u)
    await harness.dispose()
  })

  it('names the first three arguments of the calls in flight and counts the rest', async () => {
    const calls = ['one', 'two', 'three', 'four', 'five'].map((detail, index) => ({ callId: `c${String(index)}`, name: 'bash', detail }))
    const harness = await bootFacts({ phase: 'tool', inFlight: calls })
    expect(rows(harness.screen)[1]).toBe('    ⎿ one · two · three +2 more')
    await harness.dispose()
  })

  it('counts the reasoning phase from the moment the row first saw it when the session carries no start of its own', async () => {
    const harness = await bootFacts({ phase: 'thinking' })
    expect(rows(harness.screen)[0]).toMatch(/^ {2}\S Pondering/u)
    harness.advance(6_000)
    harness.tick.fire(NOW + 6_000)
    expect(rows(harness.screen)[0]).toMatch(/^ {2}\S Mulling/u)
    harness.advance(40_000)
    harness.tick.fire(NOW + 46_000)
    expect(rows(harness.screen)[0]).toMatch(/^ {2}\S Fathoming/u)
    await harness.dispose()
  })

  it('releases the stopping row at once when the turn settles after its minimum has passed', async () => {
    const harness = await bootFacts({ phase: 'tool', inFlight: [{ callId: 'c1', name: 'bash', detail: 'sleep 9' }] })
    harness.stop(true)
    harness.advance(700)
    harness.push({ active: false, phase: 'idle', inFlight: [] })
    harness.stop(false)
    expect(harness.timers.timeouts).toHaveLength(0)
    expect(rows(harness.screen)[0]).not.toBe('  ■ interrupting…')
    await harness.dispose()
  })

  it('holds and releases the stopping row on the process timers when none are injected', async () => {
    vi.useFakeTimers()
    try {
      const harness = await bootFacts({ phase: 'waiting' }, {}, false, 'running', true)
      harness.stop(true)
      harness.stop(false)
      expect(rows(harness.screen)[0]).toBe('  ■ interrupting…')
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersByTime(600)
      expect(rows(harness.screen)[0]).not.toBe('  ■ interrupting…')
      // A stop that lands inside a new hold cancels it.
      harness.stop(true)
      harness.stop(false)
      expect(vi.getTimerCount()).toBe(1)
      harness.stop(true)
      expect(vi.getTimerCount()).toBe(0)
      await harness.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores the settings of another namespace, and a change that leaves the quiet hints as they were', async () => {
    const harness = await bootFacts({ phase: 'waiting', turnStartedAt: NOW })
    const before = rows(harness.screen)
    harness.ctx.emit('settings/document-updated', 'other' as never, 1)
    harness.settings({ quietHints: 'full', something: 'else' })
    expect(rows(harness.screen)).toEqual(before)
    await harness.dispose()
  })

  it('tells a resumed session how long ago it was last active, by the clock the row keeps', async () => {
    const harness = await bootFacts({ active: false, phase: 'idle', turn: 2, endedAt: NOW - 120_000 }, {}, false, 'idle')
    expect(harness.reported).toContain('Resumed session · 2 turns · last active 2m ago')
    await harness.dispose()
  })
})
