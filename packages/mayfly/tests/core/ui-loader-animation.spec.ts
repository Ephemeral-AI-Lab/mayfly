/** Loader timing stays renderer-owned and stops without visible demand.
 * @module @ephemeral-ai/mayfly/tests/core/ui-loader-animation
 */
import { afterEach, expect, it, vi } from 'vitest'
import { UiAnimationClock, UiLoaderAnimation, LOADER_FRAME_MS } from '../../src/core/ui-loader-animation.ts'

afterEach(() => vi.useRealTimers())

it('advances at 80 ms without a domain update and shares one timer across paint passes', () => {
  vi.useFakeTimers()
  const repaint = vi.fn()
  const animation = new UiLoaderAnimation(repaint)
  expect(animation.frame).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  expect(animation.render()).toBe(0)
  expect(animation.render()).toBe(0)
  expect(vi.getTimerCount()).toBe(1)
  for (let frame = 1; frame <= 12; frame++) {
    vi.advanceTimersByTime(LOADER_FRAME_MS - 1)
    expect(repaint).toHaveBeenCalledTimes(frame - 1)
    vi.advanceTimersByTime(1)
    expect(repaint).toHaveBeenCalledTimes(frame)
    expect(animation.render()).toBe(frame)
  }
  animation.stop()
  expect(vi.getTimerCount()).toBe(0)
})

it('stops when a new frame contains no loader, or the surface is hidden/disposed', () => {
  vi.useFakeTimers()
  const repaint = vi.fn()
  const animation = new UiLoaderAnimation(repaint)
  animation.render()
  animation.beginFrame()
  vi.advanceTimersByTime(LOADER_FRAME_MS)
  expect(repaint).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  animation.render()
  animation.stop()
  vi.advanceTimersByTime(LOADER_FRAME_MS * 10)
  expect(repaint).not.toHaveBeenCalled()
  animation.render()
  vi.advanceTimersByTime(LOADER_FRAME_MS)
  expect(repaint).toHaveBeenCalledOnce()
  // A repaint request that did not paint this surface cannot keep a timer alive.
  vi.advanceTimersByTime(LOADER_FRAME_MS * 10)
  expect(repaint).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('serves every surface of a clock with one timer, drops a hidden surface, and stops when nothing moves', () => {
  vi.useFakeTimers()
  const clock = new UiAnimationClock()
  const first = vi.fn()
  const second = vi.fn()
  const one = new UiLoaderAnimation(first, clock)
  const two = new UiLoaderAnimation(second, clock)
  one.render()
  two.render()
  expect(vi.getTimerCount(), 'two surfaces, one timer').toBe(1)
  vi.advanceTimersByTime(LOADER_FRAME_MS)
  expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 1])
  expect([one.frame, two.frame]).toEqual([1, 1])
  one.render()
  two.render()
  two.stop()
  expect(vi.getTimerCount(), 'one surface is still armed').toBe(1)
  vi.advanceTimersByTime(LOADER_FRAME_MS)
  expect([first.mock.calls.length, second.mock.calls.length]).toEqual([2, 1])
  one.stop()
  expect(vi.getTimerCount(), 'nothing is armed').toBe(0)
  one.render()
  clock.dispose()
  expect(vi.getTimerCount()).toBe(0)
  vi.advanceTimersByTime(LOADER_FRAME_MS * 4)
  expect(first.mock.calls.length).toBe(2)
})
