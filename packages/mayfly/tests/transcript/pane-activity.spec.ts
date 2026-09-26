/**
 * `mayfly-pane-activity` plugin: the mode machine. Covers the moon/braille
 * rows per phase, the teaching-tip rotation (picked on loading-kind change,
 * the kimi semantics), the thinking/dialog empty renders, the idle
 * placeholder ratchet, snapshot-seeded attach, the per-style intervals, the
 * width guards, and unload cleanup.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as activity from '../../src/transcript/pane-activity.ts'
import { buildTipRotation } from '../../src/transcript/status-tips.ts'
import { MOON_SPINNER_FRAMES, MOON_SPINNER_INTERVAL_MS } from '../../src/transcript/spinners.ts'
import { STATUS_TIPS } from '../../src/transcript/tips-content.ts'
import { bootPanePlugin, type PanePluginHarness } from './pane-fakes.ts'
import { asAgent, fakeAgent, type FakeAgent } from './status-fakes.ts'
import {
  assistantEvent,
  event,
  reasoningDelta,
  resetSeq,
  textDelta,
  toolCallEvent,
  toolResultEvent,
  turnEnd,
  turnStart,
} from './helpers.ts'
import { visibleWidth } from '../../src/core/width.ts'
import type { Context } from '@deepseek-ai/cordis'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'
import { initialConversationFacts } from '../../src/conversation/facts.ts'

/** Fake timers recording interval creation/clearing; ticks run manually. */
class FakeTimers implements activity.ActivityTimers {
  readonly ticks: (() => void)[] = []
  readonly intervals: number[] = []
  readonly timeouts: { readonly ms: number, fire(): void }[] = []
  cleared = 0

  setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval> {
    this.ticks.push(callback)
    this.intervals.push(ms)
    return this.ticks.length as unknown as ReturnType<typeof setInterval>
  }

  clearInterval(_handle: ReturnType<typeof setInterval>): void {
    this.cleared += 1
  }

  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
    const entry = { ms, fire: callback }
    this.timeouts.push(entry)
    return this.timeouts.length as unknown as ReturnType<typeof setTimeout>
  }

  clearTimeout(_handle: ReturnType<typeof setTimeout>): void {
    this.cleared += 1
  }
}

afterEach(() => {
  activity.setActivityTimers(undefined)
  resetSeq()
})

interface ActivityHarness extends PanePluginHarness {
  timers: FakeTimers
}

/**
 * Boot the pane with fake timers installed.
 * @param current - agent preloaded onto `mayflySession.current`, if any.
 */
async function boot(current: FakeAgent | null = null): Promise<ActivityHarness> {
  const timers = new FakeTimers()
  activity.setActivityTimers(timers)
  const harness = await bootPanePlugin(activity, current)
  return { ...harness, timers }
}

/** A fake agent preset to the given status. */
function runningAgent(running: FakeAgent): FakeAgent {
  running.status = 'running'
  return running
}

/** The first moon-row tip: slot 0 of the SWRR rotation. */
const FIRST_TIP = buildTipRotation(STATUS_TIPS)[0]!.text

/** Emit one session event for the agent's session. */
function emit2(ctx: Context, agent: FakeAgent, event: Parameters<typeof turnStart>[0]): void {
  ctx.emit('session/event', agent.session, event)
}

describe('mayfly-pane-activity', () => {
  it('mounts one bottom pane that renders the kimi placeholder row while idle', async () => {
    const { ctx, screen, dispose } = await boot()
    expect(activity.name).toBe('mayfly-pane-activity')
    expect(activity.inject).toEqual(['mayflyPanes', 'mayflySessionFacts', 'mayflyComponents'])
    expect(ctx.mayflyPanes.list().find(entry => entry.id === 'mayfly.pane.activity')?.definition.title).toBeUndefined()
    expect(screen.bottomChildren).toHaveLength(1)
    // kimi's Spacer(1): the placeholder row is always present when the
    // spinner is not, so the dock never jumps at the activity edges.
    expect(screen.paneLines()).toEqual([''])
    await dispose()
    expect(screen.bottomChildren).toHaveLength(0)
  })

  it('keeps the activity row while the dedicated Agents pane is visible', async () => {
    const harness = await boot(runningAgent(fakeAgent([])))
    const agents = harness.ctx.mayflyPanes.register({
      id: 'mayfly.pane.agents',
      title: 'Agents',
      placement: 'bottom',
    }, { kind: 'text', content: 'agent row' })
    expect(harness.screen.paneLines()).toEqual([
      `${MOON_SPINNER_FRAMES[0]!} · Tip: ${FIRST_TIP}`,
      'agent row',
    ])
    agents.set(null)
    expect(harness.screen.paneLines()).toEqual([`${MOON_SPINNER_FRAMES[0]!} · Tip: ${FIRST_TIP}`])
    agents.dispose()
    await harness.dispose()
  })

  it('shows the moon row with a teaching tip for a running agent (waiting)', async () => {
    const agent = runningAgent(fakeAgent([]))
    const { screen, timers, dispose } = await boot(agent)
    expect(screen.paneLines()).toEqual([`${MOON_SPINNER_FRAMES[0]!} · Tip: ${FIRST_TIP}`])
    expect(timers.intervals).toEqual([120])

    // Each tick advances the frame and requests a redraw.
    const baseline = screen.renderRequests.length
    timers.ticks[0]!()
    expect(screen.paneLines()).toEqual([`${MOON_SPINNER_FRAMES[1]!} · Tip: ${FIRST_TIP}`])
    expect(screen.renderRequests.length).toBe(baseline + 1)

    // The frame wraps around the moon cycle.
    for (let index = 0; index < MOON_SPINNER_FRAMES.length - 1; index += 1) timers.ticks[0]!()
    expect(screen.paneLines()).toEqual([`${MOON_SPINNER_FRAMES[0]!} · Tip: ${FIRST_TIP}`])

    // Unloading stops the animation.
    await dispose()
    expect(timers.cleared).toBe(1)
  })

  it('uses Agent status as the waiting fallback while the projection is still idle', async () => {
    const timers = new FakeTimers()
    activity.setActivityTimers(timers)
    const agent = runningAgent(fakeAgent([]))
    const facts = initialConversationFacts()
    const harness = await bootPanePlugin(activity, agent, {
      mayflySessionFacts: {
        current: facts,
        currentAgent: asAgent(agent),
        subscribe(listener: (value: typeof facts) => void) {
          listener(facts)
          return () => {}
        },
        subscribeAgent(listener: (value: ReturnType<typeof asAgent>) => void) {
          listener(asAgent(agent))
          return () => {}
        },
      },
    })
    expect(harness.screen.paneLines()).toEqual([`${MOON_SPINNER_FRAMES[0]!} · Tip: ${FIRST_TIP}`])
    await harness.dispose()
  })

  it('switches the mounted activity row in place when locale changes', async () => {
    const harness = await boot(runningAgent(fakeAgent([])))
    const pane = harness.screen.bottomChildren[0]
    const localeFiber = await harness.ctx.plugin({
      name: 'activity-locale',
      apply(ctx: Context) {
        const locale = new MayflyLocaleService(ctx, { systemLocale: 'en' })
        ctx.effect(() => () => locale.dispose())
      },
    })
    await Promise.resolve()
    expect(harness.screen.paneLines()[0]).toContain(' · Tip: ')
    harness.ctx.mayflyLocale.setPreference('zh')
    expect(harness.screen.bottomChildren[0]).toBe(pane)
    expect(harness.screen.paneLines()[0]).toContain(' · 提示：')
    await localeFiber.dispose()
    await harness.dispose()
  })

  it('shows the static interrupting row while a stop request drains', async () => {
    const timers = new FakeTimers()
    activity.setActivityTimers(timers)
    let pending = false
    const harness = await bootPanePlugin(activity, runningAgent(fakeAgent([])), {
      mayflyRequests: { stopPending: () => pending },
    })
    const { ctx, screen, dispose } = harness
    expect(screen.paneLines()).toEqual([`${MOON_SPINNER_FRAMES[0]!} · Tip: ${FIRST_TIP}`])
    expect(timers.intervals).toEqual([120])

    vi.useFakeTimers()
    try {
      vi.setSystemTime(10_000)
      pending = true
      ctx.emit('mayfly/request-stop-changed', true)
      expect(screen.paneLines()).toEqual(['■ interrupting...'])
      // The static row never arms the spinner: the animation timer stops and a
      // late tick cannot make the accepted interrupt look ignored again.
      expect(timers.cleared).toBe(1)
      expect(timers.intervals).toEqual([120])
      timers.ticks[0]!()
      expect(screen.paneLines()).toEqual(['■ interrupting...'])
      for (const width of [18, 12, 4]) {
        expect(screen.paneLines(width).every(line => visibleWidth(line) <= width)).toBe(true)
      }

      // The turn settles immediately: the acknowledgment holds for the rest of
      // its minimum visible duration instead of losing the render race.
      vi.setSystemTime(10_050)
      pending = false
      ctx.emit('mayfly/request-stop-changed', false)
      expect(screen.paneLines()).toEqual(['■ interrupting...'])
      expect(timers.timeouts).toHaveLength(1)
      expect(timers.timeouts[0]!.ms).toBe(550)

      // A second release inside the hold does not stack another timer.
      ctx.emit('mayfly/request-stop-changed', false)
      expect(timers.timeouts).toHaveLength(1)

      // A fresh stop while the hold runs cancels it and restarts the clock.
      vi.setSystemTime(10_400)
      pending = true
      ctx.emit('mayfly/request-stop-changed', true)
      expect(timers.cleared).toBe(2)
      expect(screen.paneLines()).toEqual(['■ interrupting...'])
      vi.setSystemTime(10_450)
      pending = false
      ctx.emit('mayfly/request-stop-changed', false)
      expect(timers.timeouts).toHaveLength(2)
      expect(timers.timeouts[1]!.ms).toBe(550)

      timers.timeouts[1]!.fire()
      // The moon kind re-enters, so the rotation advances to its next slot and
      // the shared frame counter survived the stopping detour.
      expect(screen.paneLines()).toEqual([`${MOON_SPINNER_FRAMES[1]!} · Tip: ${buildTipRotation(STATUS_TIPS)[1]!.text}`])
      expect(timers.intervals).toEqual([120, 120])
    } finally {
      vi.useRealTimers()
    }
    await dispose()
  })

  it('holds and releases the stopping row through the process timers', async () => {
    // No injected fake here: the default timer primitives run under vi's clock.
    const harness = await bootPanePlugin(activity, runningAgent(fakeAgent([])))
    const { ctx, screen, dispose } = harness
    let pending = true
    vi.useFakeTimers()
    try {
      ctx.emit('mayfly/request-stop-changed', true)
      expect(screen.paneLines()).toEqual(['■ interrupting...'])
      pending = false
      ctx.emit('mayfly/request-stop-changed', false)
      // The turn settled at once; the acknowledgment holds out its minimum.
      expect(screen.paneLines()).toEqual(['■ interrupting...'])
      // A fresh stop cancels the pending hold through the default clearTimeout.
      pending = true
      ctx.emit('mayfly/request-stop-changed', true)
      expect(screen.paneLines()).toEqual(['■ interrupting...'])
      vi.advanceTimersByTime(600)
      expect(screen.paneLines()).toEqual(['■ interrupting...'])
      pending = false
      ctx.emit('mayfly/request-stop-changed', false)
      vi.advanceTimersByTime(600)
      expect(screen.paneLines()[0]).toContain(' · Tip: ')
    } finally {
      vi.useRealTimers()
    }
    await dispose()
  })

  it('cancels a pending stopping hold when the pane unloads', async () => {
    const timers = new FakeTimers()
    activity.setActivityTimers(timers)
    let pending = false
    const harness = await bootPanePlugin(activity, runningAgent(fakeAgent([])), {
      mayflyRequests: { stopPending: () => pending },
    })
    const { ctx, dispose } = harness
    vi.useFakeTimers()
    try {
      vi.setSystemTime(30_000)
      pending = true
      ctx.emit('mayfly/request-stop-changed', true)
      pending = false
      ctx.emit('mayfly/request-stop-changed', false)
      expect(timers.timeouts).toHaveLength(1)
      const clearedBefore = timers.cleared
      await dispose()
      // The unload clears the hold, so its callback can never fire late.
      expect(timers.cleared).toBe(clearedBefore + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts in the stopping row when a stop is already draining at mount', async () => {
    const timers = new FakeTimers()
    activity.setActivityTimers(timers)
    const harness = await bootPanePlugin(activity, runningAgent(fakeAgent([])), {
      mayflyRequests: { stopPending: () => true },
    })
    const { screen, dispose } = harness
    expect(screen.paneLines()).toEqual(['■ interrupting...'])
    await dispose()
  })

  it('releases the stopping row at once when the hold already elapsed', async () => {
    const timers = new FakeTimers()
    activity.setActivityTimers(timers)
    let pending = false
    const harness = await bootPanePlugin(activity, runningAgent(fakeAgent([])), {
      mayflyRequests: { stopPending: () => pending },
    })
    const { ctx, screen, dispose } = harness
    vi.useFakeTimers()
    try {
      vi.setSystemTime(20_000)
      pending = true
      ctx.emit('mayfly/request-stop-changed', true)
      expect(screen.paneLines()).toEqual(['■ interrupting...'])

      // A drain that outlasts the hold releases on the event itself.
      vi.setSystemTime(20_900)
      pending = false
      ctx.emit('mayfly/request-stop-changed', false)
      expect(timers.timeouts).toEqual([])
      expect(screen.paneLines()[0]).toContain(' · Tip: ')
    } finally {
      vi.useRealTimers()
    }
    await dispose()
  })

  it('shows the kimi working row with a fresh tip while composing', async () => {
    const agent = runningAgent(fakeAgent([]))
    const { ctx, screen, timers, dispose } = await boot(agent)
    expect(screen.paneLines()).toEqual([`${MOON_SPINNER_FRAMES[0]!} · Tip: ${FIRST_TIP}`])
    // Composing flips to the braille style at 80 ms; the kind change picks
    // the next rotation slot and the row is the kimi shape: primary frame,
    // plain label, riding tip (the user's second dogfood ruling restored
    // the row — kimi's assistant block has no cursor).
    emit2(ctx, agent, textDelta(1, 1, 'answering'))
    const composingTip = buildTipRotation(STATUS_TIPS)[1]!.text
    // The streamed chars ride as the live ↓ counter (9 chars → ↓2).
    expect(screen.paneLines()).toEqual([`⠋ working... ↓2 · Tip: ${composingTip}`])
    expect(timers.intervals).toEqual([120, 80])
    // A tick advances the shared frame counter.
    timers.ticks[1]!()
    expect(screen.paneLines()).toEqual([`⠙ working... ↓2 · Tip: ${composingTip}`])
    // A tool result re-enters the moon kind with the next rotation slot;
    // the shared frame counter survived the style flip, so the moon picks
    // up where the cycle left off.
    emit2(ctx, agent, toolCallEvent(1, 1, 'c0', 'worker', '{}'))
    emit2(ctx, agent, toolResultEvent(1, 1, 'c0', 'done'))
    expect(screen.paneLines()).toEqual([`${MOON_SPINNER_FRAMES[1]!} worker ↓2 · Tip: ${buildTipRotation(STATUS_TIPS)[2]!.text}`])
    await dispose()
  })

  it('drops the composing tip then the whole row under width pressure', async () => {
    const agent = runningAgent(fakeAgent([]))
    const { ctx, screen, dispose } = await boot(agent)
    emit2(ctx, agent, textDelta(1, 1, 'answering'))
    const tip = buildTipRotation(STATUS_TIPS)[1]!.text
    const visible = 1 + ' working...'.length + ' ↓2'.length + ' · Tip: '.length + tip.length
    expect(screen.paneLines(visible)).toEqual([`⠋ working... ↓2 · Tip: ${tip}`])
    for (const width of [visible - 1, 12, 10]) {
      expect(screen.paneLines(width).every(line => visibleWidth(line) <= width)).toBe(true)
    }
    emit2(ctx, agent, toolCallEvent(1, 1, 'c0', 'worker', '{}'))
    emit2(ctx, agent, toolResultEvent(1, 1, 'c0', 'done'))
    expect(screen.paneLines(2).every(line => visibleWidth(line) <= 2)).toBe(true)
    await dispose()
  })

  it('rides the turn token flow: ↑ from the latest usage, ↓ from streamed chars, reset per turn', async () => {
    const agent = runningAgent(fakeAgent([]))
    const { ctx, screen, dispose } = await boot(agent)
    // Before any data the moon row carries no counter.
    expect(screen.paneLines()).toEqual([`${MOON_SPINNER_FRAMES[0]!} · Tip: ${FIRST_TIP}`])
    // Streams that carry no text (boundary records, tool-call deltas) count
    // nothing.
    emit2(ctx, agent, event('assistant/attempt', {
      turn: 1, step: 1,
      stream: [{ type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } }],
    }))
    expect(screen.paneLines()[0]).not.toContain('↓')
    // A finished response contributes its input side as ↑ (context tokens:
    // input + cache reads/writes).
    const finished = assistantEvent(1, 1, [{ type: 'text', text: 'done' }])
    finished.data.usage = { inputTokens: 2000, outputTokens: 5, cacheReadTokens: 1024 }
    emit2(ctx, agent, finished)
    expect(screen.paneLines()).toEqual([`${MOON_SPINNER_FRAMES[0]!} ↑3k · Tip: ${FIRST_TIP}`])
    // Streamed text and reasoning accumulate as ↓ (chars over the 4-chars
    // per-token heuristic); both counters ride together.
    emit2(ctx, agent, textDelta(1, 2, 'answering'))
    emit2(ctx, agent, reasoningDelta(1, 2, 'thinking hard'))
    emit2(ctx, agent, toolCallEvent(1, 2, 'c0', 'worker', '{}'))
    emit2(ctx, agent, toolResultEvent(1, 2, 'c0', 'done'))
    expect(screen.paneLines()[0]).toContain('↑3k ↓5')
    // A new turn resets both (the tip rotation is independent — assert the
    // counters, not the tip slot).
    emit2(ctx, agent, turnEnd(1))
    emit2(ctx, agent, turnStart(2))
    const resetRow = screen.paneLines()[0] ?? ''
    expect(resetRow).not.toContain('↑')
    expect(resetRow).not.toContain('↓')
    // Empty deltas do not start a new output phase or publish a counter.
    emit2(ctx, agent, textDelta(2, 1, ''))
    const composingRow = screen.paneLines()[0] ?? ''
    expect(composingRow).not.toContain('working...')
    expect(composingRow).not.toContain('↓')
    await dispose()
  })

  it('keeps a thinking row while the model reasons, so the dock never collapses', async () => {
    const agent = runningAgent(fakeAgent([]))
    const { ctx, screen, timers, dispose } = await boot(agent)
    emit2(ctx, agent, reasoningDelta(1, 1, 'pondering'))
    // The braille style takes over from the moon with the next tip slot.
    expect(screen.paneLines()).toEqual([`⠋ thinking... ↓2 · Tip: ${buildTipRotation(STATUS_TIPS)[1]!.text}`])
    expect(timers.intervals).toEqual([120, 80])
    expect(timers.cleared).toBe(1)
    // Once active, the idle placeholder ratchet holds a blank row.
    emit2(ctx, agent, turnEnd(1))
    expect(screen.paneLines()).toEqual([''])
    await dispose()
  })

  it('shows the moon row without the composing label while a tool runs', async () => {
    const agent = runningAgent(fakeAgent([]))
    const { ctx, screen, dispose } = await boot(agent)
    emit2(ctx, agent, toolCallEvent(1, 1, 'c1', 'bash', '{}'))
    // waiting → tool keeps the moon loading kind, so the tip survives; the row names the tool.
    expect(screen.paneLines()).toEqual([`${MOON_SPINNER_FRAMES[0]!} bash · Tip: ${FIRST_TIP}`])
    emit2(ctx, agent, toolCallEvent(1, 1, 'c2', 'mcp__github__create_issue', '{}'))
    expect(screen.paneLines()).toEqual([`${MOON_SPINNER_FRAMES[0]!} github › create_issue · Tip: ${FIRST_TIP}`])
    // A subagent spawn is not named: the agents pane above owns its live detail.
    emit2(ctx, agent, toolCallEvent(1, 1, 'c3', 'subagent', '{}'))
    expect(screen.paneLines()).toEqual([`${MOON_SPINNER_FRAMES[0]!} · Tip: ${FIRST_TIP}`])
    await dispose()
  })

  it('keeps the moon up through invisible reasoning', async () => {
    const agent = runningAgent(fakeAgent([]))
    const { ctx, screen, dispose } = await boot(agent)
    emit2(ctx, agent, reasoningDelta(1, 1, ' '))
    expect(screen.paneLines()).toEqual([`${MOON_SPINNER_FRAMES[0]!} · Tip: ${FIRST_TIP}`])
    await dispose()
  })

  it('hides while a dialog panel occupies the editor slot', async () => {
    const agent = runningAgent(fakeAgent([]))
    const { ctx, screen, timers, dispose } = await boot(agent)
    expect(screen.paneLines()).toEqual([`${MOON_SPINNER_FRAMES[0]!} · Tip: ${FIRST_TIP}`])
    ctx.emit('mayfly/editor-slot-swapped', true)
    expect(screen.paneLines()).toEqual([])
    expect(timers.cleared).toBe(1)
    // Returning re-enters the moon loading kind: a fresh tip from the next
    // rotation slot.
    ctx.emit('mayfly/editor-slot-swapped', false)
    expect(screen.paneLines()).toEqual([`${MOON_SPINNER_FRAMES[0]!} · Tip: ${buildTipRotation(STATUS_TIPS)[1]!.text}`])
    expect(timers.intervals).toEqual([120, 120])
    await dispose()
  })

  it('parks the idle placeholder and resets stale idle on wake', async () => {
    const agent = fakeAgent([])
    const { ctx, screen, timers, dispose } = await boot(agent)
    // kimi's Spacer(1): the placeholder shows even before any activity.
    expect(screen.paneLines()).toEqual([''])

    agent.status = 'running'
    ctx.emit('agent/status', { agent: asAgent(agent), status: 'running' })
    expect(screen.paneLines()).toEqual([`${MOON_SPINNER_FRAMES[0]!} · Tip: ${FIRST_TIP}`])
    emit2(ctx, agent, turnEnd(1))
    expect(screen.paneLines()).toEqual([''])

    // A turn that ended leaves the phase idle; waking the agent treats the
    // stale idle as a fresh waiting turn until an event lands.
    agent.status = 'idle'
    ctx.emit('agent/status', { agent: asAgent(agent), status: 'idle' })
    expect(screen.paneLines()).toEqual([''])
    agent.status = 'running'
    ctx.emit('agent/status', { agent: asAgent(agent), status: 'running' })
    expect(screen.paneLines()).toEqual([`${MOON_SPINNER_FRAMES[0]!} · Tip: ${buildTipRotation(STATUS_TIPS)[1]!.text}`])
    await dispose()
    expect(timers.cleared).toBe(2)
  })

  it('filters other agents\' flips and foreign sessions\' events', async () => {
    const agent = fakeAgent([])
    const { ctx, screen, timers, dispose } = await boot(agent)
    ctx.emit('agent/status', { agent: asAgent(runningAgent(fakeAgent([]))), status: 'running' })
    expect(timers.ticks).toHaveLength(0)
    expect(screen.paneLines()).toEqual([''])

    // A foreign session's events never reach the tracker.
    agent.status = 'running'
    ctx.emit('agent/status', { agent: asAgent(agent), status: 'running' })
    const foreign = fakeAgent([])
    ctx.emit('session/event', foreign.session, textDelta(1, 1, 'x'))
    expect(screen.paneLines()).toEqual([`${MOON_SPINNER_FRAMES[0]!} · Tip: ${FIRST_TIP}`])
    await dispose()
  })

  it('seeds the phase from the snapshot on attach', async () => {
    // The snapshot ends mid-thinking: the resumed pane shows the thinking row at once.
    const agent = runningAgent(fakeAgent([
      turnStart(1),
      reasoningDelta(1, 1, 'mid-thought'),
    ]))
    const { screen, dispose } = await boot(agent)
    expect(screen.paneLines()[0]).toMatch(/^⠋ thinking\.\.\. ↓\d/u)
    await dispose()
  })

  it('drops the tip under width pressure and the row entirely below it', async () => {
    const agent = runningAgent(fakeAgent([]))
    const { screen, dispose } = await boot(agent)
    const full = `${MOON_SPINNER_FRAMES[0]!} · Tip: ${FIRST_TIP}`
    // The width measure is pi-tui's (D48): the moon glyph spans two cells,
    // so the row's visible width is the moon + the lead + the tip.
    const visible = visibleWidth(MOON_SPINNER_FRAMES[0]!) + ' · Tip: '.length + FIRST_TIP.length
    expect(screen.paneLines(visible)).toEqual([full])
    for (const width of [visible - 1, 2, 1]) {
      expect(screen.paneLines(width).every(line => visibleWidth(line) <= width)).toBe(true)
    }
    await dispose()
  })

  it('animates with the default timers when none are injected', async () => {
    const harness = await bootPanePlugin(activity, runningAgent(fakeAgent([])))
    const baseline = harness.screen.renderRequests.length
    await new Promise(resolve => setTimeout(resolve, MOON_SPINNER_INTERVAL_MS * 2 + 50))
    expect(harness.screen.renderRequests.length).toBeGreaterThan(baseline)
    await harness.dispose()
  })
})
