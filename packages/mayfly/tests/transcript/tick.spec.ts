/**
 * Decision tests of the host's one clock: it runs only while someone listens, every listener hears the same time at
 * each tick, a disposer removes exactly its listener and is safe to call twice, and the Fiber that mounted the service
 * stops it on unload, so no stale generation keeps emitting. Time is driven by fake timers and an injected clock.
 * @module transcript-tick
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MayflyTickService, TICK_MS } from '../../src/transcript/tick.ts'

const START = 1_700_000_000_000

/** A clock the test moves by hand: each tick reads the current value. */
function clockAt(start: number): { now: () => number, advance: (ms: number) => void } {
  let value = start
  return { now: () => value, advance: ms => { value += ms } }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('MayflyTickService', () => {
  it('runs no clock until a listener subscribes, and one clock for every listener', () => {
    const clock = clockAt(START)
    const tick = new MayflyTickService(new Context(), clock.now)
    expect(vi.getTimerCount()).toBe(0)
    const first = vi.fn()
    const second = vi.fn()
    tick.subscribe(first)
    tick.subscribe(second)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(TICK_MS)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    tick.dispose()
  })

  it('passes every listener the time of the same tick, read from the injected clock', () => {
    const clock = clockAt(START)
    const tick = new MayflyTickService(new Context(), clock.now)
    const seen: [string, number][] = []
    tick.subscribe(now => seen.push(['a', now]))
    tick.subscribe(now => seen.push(['b', now]))
    clock.advance(TICK_MS)
    vi.advanceTimersByTime(TICK_MS)
    expect(seen).toEqual([['a', START + TICK_MS], ['b', START + TICK_MS]])
    tick.dispose()
  })

  it('removes exactly the listener its disposer returned, and is safe to dispose twice', () => {
    const tick = new MayflyTickService(new Context(), clockAt(START).now)
    const kept = vi.fn()
    const dropped = vi.fn()
    tick.subscribe(kept)
    const off = tick.subscribe(dropped)
    off()
    off()
    vi.advanceTimersByTime(TICK_MS * 2)
    expect(dropped).not.toHaveBeenCalled()
    expect(kept).toHaveBeenCalledTimes(2)
    tick.dispose()
  })

  it('stops the clock when the last listener leaves, and starts it again for the next one', () => {
    const tick = new MayflyTickService(new Context(), clockAt(START).now)
    const off = tick.subscribe(() => {})
    off()
    expect(vi.getTimerCount()).toBe(0)
    const later = vi.fn()
    tick.subscribe(later)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(TICK_MS)
    expect(later).toHaveBeenCalledTimes(1)
    tick.dispose()
  })

  it('a listener removed between ticks hears no further tick', () => {
    const tick = new MayflyTickService(new Context(), clockAt(START).now)
    const listener = vi.fn()
    const off = tick.subscribe(listener)
    vi.advanceTimersByTime(TICK_MS)
    off()
    vi.advanceTimersByTime(TICK_MS * 5)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('a listener added during a tick first hears the next tick, not the one in progress', () => {
    const tick = new MayflyTickService(new Context(), clockAt(START).now)
    const late = vi.fn()
    let added = false
    tick.subscribe(() => {
      if (added) return
      added = true
      tick.subscribe(late)
    })
    vi.advanceTimersByTime(TICK_MS)
    expect(late).not.toHaveBeenCalled()
    vi.advanceTimersByTime(TICK_MS)
    expect(late).toHaveBeenCalledTimes(1)
    tick.dispose()
  })

  it('dispose stops the clock and forgets every listener, so nothing is emitted afterwards', () => {
    const tick = new MayflyTickService(new Context(), clockAt(START).now)
    const listener = vi.fn()
    const off = tick.subscribe(listener)
    tick.dispose()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(TICK_MS * 3)
    expect(listener).not.toHaveBeenCalled()
    // A disposer that outlives the service is a no-op.
    expect(() => off()).not.toThrow()
  })

  it('stops with the Fiber that mounted it: unloading the owner ends the clock and its listeners', async () => {
    const ctx = new Context()
    const clock = clockAt(START)
    const listener = vi.fn()
    // The frontend mounts the service and disposes it in an effect of the same Fiber (`frontend/index.ts`).
    const fiber = await ctx.plugin({
      name: 'mayfly-tick-owner',
      apply(owner: Context) {
        const tick = new MayflyTickService(owner, clock.now)
        owner.effect(() => () => tick.dispose())
        tick.subscribe(listener)
      },
    })
    vi.advanceTimersByTime(TICK_MS)
    expect(listener).toHaveBeenCalledTimes(1)
    await fiber.dispose()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(TICK_MS * 4)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
