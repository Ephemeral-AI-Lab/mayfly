/** The prompt's delayed waits: stacking, the show delay, and ending safely.
 * @module @ephemeral-ai/mayfly/tests/interaction/prompt-wait
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beginPromptWait } from '../../src/interaction/prompt-wait.ts'
import { InteractionStateService } from '../../src/interaction/runtime-state.ts'
import { DEFAULT_SETTINGS } from '../../src/interaction/settings.ts'

let ctx: Context
let state: InteractionStateService
let seen: (string | undefined)[]

beforeEach(() => {
  vi.useFakeTimers()
  ctx = new Context()
  state = new InteractionStateService(ctx, DEFAULT_SETTINGS)
  seen = []
  ctx.on('mayfly/prompt-wait-changed', message => { seen.push(message) })
})

afterEach(async () => {
  vi.useRealTimers()
  await ctx.fiber.dispose()
})

describe('beginPromptWait', () => {
  it('does not publish a wait that ends before the show delay', () => {
    const end = beginPromptWait(ctx, 'Reading the clipboard…')
    expect(state.promptWaits.active).toMatchObject([{ message: 'Reading the clipboard…', shown: false }])
    end()
    vi.advanceTimersByTime(150)
    expect(seen).toEqual([])
    expect(state.promptWaits.active).toEqual([])
  })

  it('publishes the wait once the delay has passed and clears it when it ends', () => {
    const end = beginPromptWait(ctx, 'Searching files…')
    vi.advanceTimersByTime(149)
    expect(seen).toEqual([])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual(['Searching files…'])
    expect(state.promptWaits.active[0]).toMatchObject({ shown: true, timer: undefined })
    end()
    expect(seen).toEqual(['Searching files…', undefined])
    expect(state.promptWaits.active).toEqual([])
  })

  it('lets the newest shown wait speak while older ones remain in flight', () => {
    const first = beginPromptWait(ctx, 'First')
    vi.advanceTimersByTime(150)
    const second = beginPromptWait(ctx, 'Second')
    vi.advanceTimersByTime(150)
    expect(seen).toEqual(['First', 'Second'])
    second()
    expect(seen.at(-1)).toBe('First')
    first()
    expect(seen.at(-1)).toBeUndefined()
    expect(seen).toEqual(['First', 'Second', 'First', undefined])
  })

  it('leaves an older shown wait speaking when an unshown wait ends', () => {
    const first = beginPromptWait(ctx, 'First')
    vi.advanceTimersByTime(150)
    const second = beginPromptWait(ctx, 'Second')
    second()
    expect(seen).toEqual(['First'])
    first()
    expect(seen).toEqual(['First', undefined])
  })

  it('is safe to end twice', () => {
    const end = beginPromptWait(ctx, 'Once')
    vi.advanceTimersByTime(150)
    end()
    end()
    expect(seen).toEqual(['Once', undefined])
  })

  it('ignores a timer whose wait was removed from the tree already', () => {
    beginPromptWait(ctx, 'Stranded')
    state.promptWaits.active.splice(0)
    vi.advanceTimersByTime(150)
    expect(seen).toEqual([])
  })
})
