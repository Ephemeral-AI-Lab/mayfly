/**
 * The controller behind the conversation node slot: it publishes the displayed view's stream, swaps views, and leaves
 * nothing mounted once disposed.
 * @module transcript-controller
 */

import { describe, expect, it, vi } from 'vitest'
import type { MayflyListNode, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyNodeSlot } from '../../src/core/node-slot.ts'
import type { TranscriptEntryModel } from '../../src/frontend/models.ts'
import { createTranscriptModel, LIVE_PUBLISH_MS, PUBLISH_INTERVAL_MS, TranscriptController, type TranscriptScreen } from '../../src/transcript/transcript-model.ts'

const user = (turn: number, text: string): TranscriptEntryModel => ({ id: `user:${String(turn)}`, kind: 'transcript-user', seq: turn, updatedSeq: turn, turn, text, images: [] })

/** A screen that keeps what the conversation slot was given. */
function fakeScreen() {
  const slot = { published: [] as (MayflyUiNode | null)[], disposed: false, turns: 0 }
  const lease: MayflyNodeSlot = {
    id: 'transcript.conversation', get disposed() { return slot.disposed },
    set: (node) => { slot.published.push(node) }, setTurns: (latest) => { slot.turns = latest }, setMarked: () => {},
    focus: () => {}, release: () => {}, setKeys: () => {}, spotlight: () => {}, focusRow: () => {}, track: () => {}, trackedRow: () => undefined, cursor: () => undefined,
    dispose: () => { slot.disposed = true },
  }
  const mounted: { id: string, region: string }[] = []
  const screen = {
    mountNodeSlot: (id: string, options: { region: string }) => { mounted.push({ id, region: options.region }); return lease },
    followContent: vi.fn(),
    requestRender: vi.fn(),
    watchContentTail: () => () => {},
    contentTail: () => undefined,
    scrollContentTo: vi.fn(),
  } as unknown as TranscriptScreen
  // The slot holds the stream and its key actions: the list is the first child of the column.
  const latest = (): MayflyListNode | null => {
    const node = slot.published.at(-1)
    if (node === null || node === undefined) return null
    const list = node.kind === 'stack' ? node.children[0]!.node : node
    return list as MayflyListNode
  }
  return { screen, slot, mounted, latest }
}

/** A clock the test moves: the publish window schedules on it, and expiry runs the trailing publish. */
function fakeClock() {
  let now = 1_000
  const timers = new Map<number, { at: number, callback: () => void }>()
  let next = 0
  return {
    clock: {
      now: () => now,
      setTimeout: (callback: () => void, ms: number) => { timers.set(++next, { at: now + ms, callback }); return next },
      clearTimeout: (handle: unknown) => { timers.delete(handle as number) },
    },
    advance: (ms: number): void => {
      now += ms
      for (const [handle, timer] of [...timers]) if (timer.at <= now) { timers.delete(handle); timer.callback() }
    },
    timers,
  }
}

const options = { t: (key: string) => key, queued: () => [] as { id: string, text: string, lane: 'turn' | 'step' }[] }

describe('TranscriptController', () => {
  it('mounts the conversation node slot in the content region and publishes the displayed view', () => {
    const { screen, mounted, latest } = fakeScreen()
    const controller = new TranscriptController(options)
    controller.setView('main', createTranscriptModel('a', [user(1, 'hello')]))
    controller.show('main')
    controller.attach(screen)
    expect(mounted).toEqual([{ id: 'transcript.conversation', region: 'content' }])
    expect(latest()!.items.map(item => item.label)).toEqual(['» hello'])
    controller.setView('side', createTranscriptModel('b', [user(1, 'side question')]))
    controller.show('side')
    expect(latest()!.items[0]!.label).toBe('» side question')
    expect(screen.followContent).toHaveBeenCalledTimes(1)
    controller.show(undefined)
    expect(latest()).toBeNull()
  })

  it('reads a function source on every publish and drops a view', () => {
    const { screen, latest } = fakeScreen()
    const { clock, advance } = fakeClock()
    const controller = new TranscriptController({ ...options, clock })
    let model = createTranscriptModel('a', [user(1, 'one')])
    controller.setView('main', () => model)
    controller.show('main')
    controller.attach(screen)
    model = createTranscriptModel('a', [user(1, 'one'), user(2, 'two')])
    controller.refresh()
    advance(PUBLISH_INTERVAL_MS)
    expect(latest()!.items.filter(item => item.gap === true)).toHaveLength(1)
    controller.dropView('main')
    expect(latest()).toBeNull()
  })

  it('opens the prompts the Ctrl-O reach covers, republishes the queue, and unmounts on dispose', () => {
    const { screen, slot, latest } = fakeScreen()
    const queued: { id: string, text: string, lane: 'turn' | 'step' }[] = []
    const { clock, advance, timers } = fakeClock()
    const controller = new TranscriptController({ ...options, queued: () => queued, clock })
    controller.setView('main', createTranscriptModel('a', [user(1, 'a\nb\nc\nd\ne\nf')], true, 0, [{ turn: 1, startedAt: 0 }]))
    controller.show('main')
    controller.attach(screen)
    expect(latest()!.items[0]!.wrapMax).toBe(4)
    // Ctrl-O opens the prompts of the turns its reach covers, and a second press closes them again.
    expect(controller.toggleRecent()).toBe(true)
    expect(latest()!.items[0]!.wrapMax).toBeUndefined()
    controller.toggleRecent()
    expect(latest()!.items[0]!.wrapMax).toBe(4)
    // A data-driven republish waits for the publish window; the newest queue arrives with the trailing publish.
    queued.push({ id: 'q', text: 'later', lane: 'turn' })
    controller.republish()
    // The trailing publish and the live-turn watchdog the streaming model armed.
    expect(timers.size).toBe(2)
    expect(latest()!.items.at(-1)!.label).not.toContain('later')
    advance(LIVE_PUBLISH_MS)
    expect(latest()!.items.at(-1)!.label).toContain('later')
    // A key-driven disclosure change publishes at once instead of waiting; the watchdog stays armed.
    controller.toggleRecent()
    expect(timers.size).toBe(1)
    controller.republish()
    controller.dispose()
    expect(timers.size).toBe(0)
    expect(slot.disposed).toBe(true)
  })
})
