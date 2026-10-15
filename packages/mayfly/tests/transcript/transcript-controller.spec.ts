/**
 * The controller behind the conversation node slot: it publishes the displayed view's stream, swaps views, and leaves
 * nothing mounted once disposed.
 * @module transcript-controller
 */

import { describe, expect, it, vi } from 'vitest'
import type { MayflyListNode, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyNodeSlot } from '../../src/core/node-slot.ts'
import type { TranscriptEntryModel } from '../../src/frontend/models.ts'
import { createTranscriptModel, TranscriptController, type TranscriptScreen } from '../../src/transcript/transcript-model.ts'

const user = (turn: number, text: string): TranscriptEntryModel => ({ id: `user:${String(turn)}`, kind: 'transcript-user', seq: turn, updatedSeq: turn, turn, text, images: [] })

/** A screen that keeps what the conversation slot was given. */
function fakeScreen() {
  const slot = { published: [] as (MayflyUiNode | null)[], disposed: false, turns: 0 }
  const lease: MayflyNodeSlot = {
    id: 'transcript.conversation', get disposed() { return slot.disposed },
    set: (node) => { slot.published.push(node) }, setTurns: (latest) => { slot.turns = latest },
    focus: () => {}, release: () => {}, setKeys: () => {}, spotlight: () => {}, focusRow: () => {}, cursor: () => undefined,
    dispose: () => { slot.disposed = true },
  }
  const mounted: { id: string, region: string }[] = []
  const screen = {
    mountNodeSlot: (id: string, options: { region: string }) => { mounted.push({ id, region: options.region }); return lease },
    followContent: vi.fn(),
    requestRender: vi.fn(),
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
    const controller = new TranscriptController(options)
    let model = createTranscriptModel('a', [user(1, 'one')])
    controller.setView('main', () => model)
    controller.show('main')
    controller.attach(screen)
    model = createTranscriptModel('a', [user(1, 'one'), user(2, 'two')])
    controller.refresh()
    expect(latest()!.items.filter(item => item.gap === true)).toHaveLength(1)
    controller.dropView('main')
    expect(latest()).toBeNull()
  })

  it('opens the prompts the Ctrl-O reach covers, republishes the queue, and unmounts on dispose', () => {
    const { screen, slot, latest } = fakeScreen()
    const queued: { id: string, text: string, lane: 'turn' | 'step' }[] = []
    const controller = new TranscriptController({ ...options, queued: () => queued })
    controller.setView('main', createTranscriptModel('a', [user(1, 'a\nb\nc\nd\ne\nf')], true, 0, [{ turn: 1, startedAt: 0 }]))
    controller.show('main')
    controller.attach(screen)
    expect(latest()!.items[0]!.wrapMax).toBe(4)
    // Ctrl-O opens the prompts of the turns its reach covers, and a second press closes them again.
    expect(controller.toggleRecent()).toBe(true)
    expect(latest()!.items[0]!.wrapMax).toBeUndefined()
    controller.toggleRecent()
    expect(latest()!.items[0]!.wrapMax).toBe(4)
    queued.push({ id: 'q', text: 'later', lane: 'turn' })
    controller.republish()
    expect(latest()!.items.at(-1)!.label).toContain('later')
    controller.dispose()
    expect(slot.disposed).toBe(true)
  })
})
