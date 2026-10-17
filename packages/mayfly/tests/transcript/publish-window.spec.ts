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

/** A controller over a screen that counts publishes, and a clock the test moves. */
function bench() {
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
  let model = createTranscriptModel('a', [user(1, 'one')])
  const controller = new TranscriptController({ t: key => key, queued: () => [], clock })
  controller.setView('main', () => model)
  controller.show('main')
  controller.attach(screen)
  published.length = 0
  return { controller, published, screen, advance, timers, setModel: (next: typeof model) => { model = next } }
}

describe('the stream publish window', () => {
  it('publishes the first change at once and the burst behind it once, with the newest model', () => {
    const { controller, published, screen, advance, setModel } = bench()
    // The attach just published: a change inside its window waits for the end of it.
    setModel(createTranscriptModel('a', [user(1, 'one'), user(2, 'two')]))
    controller.refresh()
    setModel(createTranscriptModel('a', [user(1, 'one'), user(2, 'two'), user(3, 'three')]))
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

  it('drops the pending publish when the stream is published another way, and when the controller is disposed', () => {
    const { controller, published, advance, timers } = bench()
    controller.refresh()
    expect(timers.size).toBe(1)
    controller.republish()
    expect(timers.size).toBe(0)
    expect(published).toHaveLength(1)
    controller.refresh()
    expect(timers.size).toBe(1)
    controller.dispose()
    expect(timers.size).toBe(0)
    advance(PUBLISH_INTERVAL_MS * 10)
    expect(published).toHaveLength(1)
  })
})
