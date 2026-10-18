/**
 * The publish window of the stream: the first change of a quiet period reaches the screen at once, the changes of a burst
 * (live text, a run of events) become one trailing publish with the newest model, and nothing publishes after the controller
 * is gone.
 * @module publish-window
 */

import { describe, expect, it, vi } from 'vitest'
import type { MayflyNodeSlot } from '../../src/core/node-slot.ts'
import type { TranscriptEntryModel } from '../../src/frontend/models.ts'
import { createTranscriptModel, PUBLISH_INTERVAL_MS, TranscriptController, type TranscriptScreen } from '../../src/transcript/transcript-model.ts'

const user = (turn: number, text: string): TranscriptEntryModel => ({ id: `user:${String(turn)}`, kind: 'transcript-user', seq: turn, updatedSeq: turn, turn, text, images: [] })

/** A call that did not settle: the stream subscribes to the tick while its row is drawn. */
const pending = (id: string): TranscriptEntryModel => ({
  id, kind: 'transcript-tool', seq: 9, updatedSeq: 9, turn: 1, step: 1, callId: id, name: 'bash', family: 'command', activity: 'commands',
  detail: 'ls', arguments: '{}', startedAt: 0,
} as unknown as TranscriptEntryModel)

/** A controller over a screen that counts publishes, and a clock the test moves. */
function bench(initial: TranscriptEntryModel[] = [user(1, 'one')]) {
  const published: unknown[] = []
  const lease = {
    id: 'transcript.conversation', disposed: false,
    set: (node: unknown) => { published.push(node) }, setTurns: () => {}, setMarked: () => {}, track: () => {},
    focus: () => {}, release: () => {}, setKeys: () => {}, spotlight: () => {}, focusRow: () => {}, cursor: () => undefined,
    trackedRow: () => undefined, dispose: () => {},
  } as unknown as MayflyNodeSlot
  const screen = {
    mountNodeSlot: () => lease, followContent: vi.fn(), requestRender: vi.fn(), watchContentTail: () => () => {},
    contentTail: () => undefined, scrollContentTo: vi.fn(), scrollContent: vi.fn(),
  } as unknown as TranscriptScreen
  let now = 1_000
  const timers = new Map<number, { at: number, callback: () => void }>()
  let next = 0
  const clock = {
    now: () => now,
    setTimeout: (callback: () => void, ms: number) => { timers.set(++next, { at: now + ms, callback }); return next },
    clearTimeout: (handle: unknown) => { timers.delete(handle as number) },
  }
  const advance = (ms: number): void => {
    now += ms
    for (const [handle, timer] of [...timers]) if (timer.at <= now) { timers.delete(handle); timer.callback() }
  }
  const listeners = new Set<(now: number) => void>()
  const tick = { subscribe: (listener: (now: number) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  const fire = (at: number): void => { for (const listener of [...listeners]) listener(at) }
  let model = createTranscriptModel('a', initial)
  const controller = new TranscriptController({ t: key => key, queued: () => [], clock, tick })
  controller.setView('main', () => model)
  controller.show('main')
  controller.attach(screen)
  published.length = 0
  return { controller, published, screen, advance, timers, fire, setModel: (next: TranscriptEntryModel[]) => { model = createTranscriptModel('a', next) } }
}

describe('the stream publish window', () => {
  it('publishes the first change at once and the burst behind it once, with the newest model', () => {
    const { controller, published, screen, advance, setModel } = bench()
    // The attach just published: a change inside its window waits for the end of it.
    setModel([user(1, 'one'), user(2, 'two')])
    controller.refresh()
    setModel([user(1, 'one'), user(2, 'two'), user(3, 'three')])
    controller.refresh()
    controller.refresh()
    expect(published).toHaveLength(0)
    advance(PUBLISH_INTERVAL_MS)
    expect(published).toHaveLength(1)
    const list = (published[0] as { children: { node: { items: { id: string }[] } }[] }).children[0]!.node
    expect(list.items.filter(item => item.id.startsWith('user:'))).toHaveLength(3)
    expect(screen.requestRender).toHaveBeenCalled()
    // A change after a quiet period is not delayed.
    advance(PUBLISH_INTERVAL_MS * 10)
    controller.refresh()
    expect(published).toHaveLength(2)
  })

  it('coalesces a republish into the pending window with the newest model, and drops it on dispose', () => {
    const { controller, published, advance, timers, setModel } = bench()
    controller.refresh()
    expect(timers.size).toBe(1)
    setModel([user(1, 'one'), user(2, 'two')])
    controller.republish()
    expect(timers.size).toBe(1)
    expect(published).toHaveLength(0)
    advance(PUBLISH_INTERVAL_MS)
    expect(published).toHaveLength(1)
    const list = (published[0] as { children: { node: { items: { id: string }[] } }[] }).children[0]!.node
    expect(list.items.filter(item => item.id.startsWith('user:'))).toHaveLength(2)
    // A later republish waits for its own window, and dispose cancels it.
    controller.republish()
    expect(timers.size).toBe(1)
    controller.dispose()
    expect(timers.size).toBe(0)
    advance(PUBLISH_INTERVAL_MS * 10)
    expect(published).toHaveLength(1)
  })

  it('publishes a key-driven disclosure change at once, dropping the pending window', () => {
    const { controller, published, advance, timers } = bench()
    controller.refresh()
    expect(timers.size).toBe(1)
    controller.toggleRecent()
    expect(timers.size).toBe(0)
    expect(published).toHaveLength(1)
    advance(PUBLISH_INTERVAL_MS * 10)
    expect(published).toHaveLength(1)
  })

  it('coalesces a tick into the pending window and publishes once', () => {
    const { published, screen, advance, timers, fire } = bench([user(1, 'go'), pending('c1')])
    fire(1_010)
    fire(1_020)
    expect(timers.size).toBe(1)
    expect(published).toHaveLength(0)
    advance(20)
    expect(published).toHaveLength(1)
    expect(screen.requestRender).toHaveBeenCalled()
    // A tick after the quiet period publishes at once, as before.
    fire(2_000)
    expect(published).toHaveLength(2)
  })
})
