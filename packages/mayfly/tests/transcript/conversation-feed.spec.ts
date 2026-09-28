/**
 * Conversation feeds: a live Session through the projection registry and a
 * stored child through its native address, plus their placeholder models.
 * @module @ephemeral-ai/mayfly/tests/transcript/conversation-feed
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionAddress, SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { materializeTranscriptEntries } from '../../src/frontend/index.ts'
import type { LiveAssistantDraft } from '../../src/conversation/live-stream.ts'
import {
  AddressConversationFeed,
  SessionConversationFeed,
  type ConversationFeed,
  type ConversationHistorySource,
  type ConversationProjectionSource,
} from '../../src/transcript/conversation-feed.ts'
import { OfficialConversationModelSource } from '../../src/transcript/official-model.ts'

const ADDRESS: SessionAddress = { kind: 'subagent', parentSessionId: SessionId('parent'), childSessionId: SessionId('child'), mode: 'one-shot' }

const stored = {
  entries: [{ kind: 'user', id: 'u-1', seq: 3, updatedSeq: 3, turn: 1, text: 'stored question', images: [] }],
  streaming: false,
  settledSteps: [],
  turns: [],
}

function snapshotFrame(value: unknown): SessionFollowFrame {
  return { type: 'snapshot', projections: { asOfSeq: 9, values: { mayflyConversation: value } } } as unknown as SessionFollowFrame
}

/** A history source replaying fixed frames, optionally failing after them. */
function history(frames: readonly SessionFollowFrame[], failure?: unknown): ConversationHistorySource & { readonly signals: AbortSignal[] } {
  const signals: AbortSignal[] = []
  return {
    signals,
    follow: (_request, signal) => {
      signals.push(signal)
      return (async function* () {
        for (const frame of frames) yield frame
        if (failure !== undefined) throw failure
      })()
    },
  }
}

const settled = (): Promise<void> => new Promise(resolve => { setImmediate(resolve) })

describe('AddressConversationFeed', () => {
  it('reads the first snapshot frame without activating the child and skips event frames', async () => {
    const notify = vi.fn()
    const source = history([{ type: 'event' } as unknown as SessionFollowFrame, snapshotFrame(stored), snapshotFrame({ bad: true })])
    const feed = new AddressConversationFeed(source, ADDRESS, notify)
    expect(feed.state()).toEqual({ kind: 'loading' })
    expect(feed.take()).toBeUndefined()
    await settled()
    expect(notify).toHaveBeenCalledOnce()
    expect(feed.state()).toEqual({ kind: 'ready' })
    expect(feed.take()).toMatchObject({ seq: 9, value: { entries: [{ text: 'stored question' }] } })
    expect(feed.take()).toBeUndefined()
    expect(feed.draft()).toBeUndefined()
    feed.settle()
    // Leaving the loop closes the follow stream; only disposal aborts its signal.
    expect(source.signals[0]!.aborted).toBe(false)
    feed.dispose()
    expect(source.signals[0]!.aborted).toBe(true)
  })

  it.each([
    ['a malformed stored value', history([snapshotFrame({ entries: 'bad' })]), { kind: 'failed', reason: 'invalid' }],
    ['a stream that ends without a snapshot', history([]), { kind: 'failed', reason: 'invalid' }],
    ['a transport error', history([], new Error('socket closed')), { kind: 'failed', reason: 'read-failed', detail: 'socket closed' }],
    ['a bare transport rejection', history([], 'gone'), { kind: 'failed', reason: 'read-failed', detail: 'gone' }],
  ])('fails visibly on %s', async (_name, source, state) => {
    const notify = vi.fn()
    const feed = new AddressConversationFeed(source, ADDRESS, notify)
    await settled()
    expect(feed.state()).toEqual(state)
    expect(notify).toHaveBeenCalledOnce()
    expect(feed.take()).toBeUndefined()
  })

  it('fails without a session controller and stays silent after disposal', async () => {
    const missing = new AddressConversationFeed(undefined, ADDRESS, vi.fn())
    expect(missing.state()).toEqual({ kind: 'failed', reason: 'controller-unavailable' })

    for (const source of [history([snapshotFrame(stored)]), history([]), history([], new Error('late'))]) {
      const notify = vi.fn()
      const feed = new AddressConversationFeed(source, ADDRESS, notify)
      feed.dispose()
      await settled()
      expect(notify).not.toHaveBeenCalled()
      expect(feed.state()).toEqual({ kind: 'loading' })
    }
  })
})

describe('SessionConversationFeed', () => {
  it('filters foreign sessions and keys, wakes once per unread value, and releases on dispose', () => {
    const session = { id: 'mine' } as unknown as Session
    let changed: ((session: Session, key: string, value: unknown, seq: number) => void) | undefined
    const off = vi.fn()
    const projections: ConversationProjectionSource = {
      snapshot: () => ({ asOfSeq: 2, values: { mayflyConversation: stored } }),
      onChanged: listener => { changed = listener; return off },
    }
    const notify = vi.fn()
    const feed = new SessionConversationFeed(projections, session, undefined, undefined, notify)
    expect(feed.take()).toEqual({ value: stored, seq: 2 })
    feed.settle(2)
    changed!({ id: 'other' } as unknown as Session, 'mayflyConversation', stored, 5)
    changed!(session, 'other', stored, 5)
    changed!(session, 'mayflyConversation', stored, 2)
    expect(notify).not.toHaveBeenCalled()
    changed!(session, 'mayflyConversation', stored, 5)
    changed!(session, 'mayflyConversation', stored, 6)
    expect(notify).toHaveBeenCalledOnce()
    expect(feed.take()?.seq).toBe(6)
    expect(feed.draft()).toBeUndefined()
    expect(feed.state()).toEqual({ kind: 'ready' })
    feed.dispose()
    feed.dispose()
    expect(off).toHaveBeenCalledOnce()
    changed!(session, 'mayflyConversation', stored, 7)
    expect(notify).toHaveBeenCalledOnce()
  })

  it('wakes only for its exact Agent draft and forgets it once disposed', () => {
    const session = { id: 'live' } as unknown as Session
    const agent = { id: SessionId('live'), session } as unknown as Agent
    const drafts = new Map<Agent, LiveAssistantDraft>()
    const listeners: Array<() => void> = []
    const offLive = vi.fn()
    const notify = vi.fn()
    const feed = new SessionConversationFeed(
      { snapshot: () => ({ asOfSeq: 0, values: {} }), onChanged: () => () => {} },
      session,
      agent,
      { subscribe: listener => { listeners.push(listener); return offLive }, get: target => drafts.get(target) },
      notify,
    )
    listeners[0]!()
    expect(notify).not.toHaveBeenCalled()
    const draft = { turn: 1, step: 0 } as unknown as LiveAssistantDraft
    drafts.set(agent, draft)
    listeners[0]!()
    expect(notify).toHaveBeenCalledOnce()
    expect(feed.draft()).toBe(draft)
    listeners[0]!()
    expect(notify).toHaveBeenCalledOnce()
    feed.dispose()
    drafts.delete(agent)
    listeners[0]!()
    expect(notify).toHaveBeenCalledOnce()
    expect(offLive).toHaveBeenCalledOnce()
  })
})

describe('feed-backed model source', () => {
  it('renders stable loading and failure placeholders, then the stored conversation', async () => {
    const publish = vi.fn()
    const source = new OfficialConversationModelSource({ snapshot: vi.fn(), onChanged: () => () => {} }, { get: () => undefined }, publish)
    const gate = Promise.withResolvers<void>()
    const feed = new AddressConversationFeed({
      follow: (_request, signal) => (async function* () {
        await gate.promise
        if (!signal.aborted) yield snapshotFrame(stored)
      })(),
    }, ADDRESS, publish)
    source.attachFeed(feed, 2)
    const loading = source.snapshot()
    expect(materializeTranscriptEntries(loading)).toEqual([{ kind: 'loader', message: 'loading conversation...', variant: 'braille' }])
    expect(source.snapshot()).toBe(loading)
    gate.resolve()
    await settled()
    expect(materializeTranscriptEntries(source.snapshot())).toMatchObject([{ kind: 'transcript-user', text: 'stored question' }])

    const failed = new OfficialConversationModelSource({ snapshot: vi.fn(), onChanged: () => () => {} }, { get: () => undefined }, vi.fn(), undefined, (key, values) => `zh:${key}:${String(values?.['error'] ?? '')}`)
    failed.attachFeed(new AddressConversationFeed(history([], new Error('socket closed')), ADDRESS, vi.fn()))
    await settled()
    expect(materializeTranscriptEntries(failed.snapshot())).toEqual([{
      kind: 'empty',
      title: 'zh:conversation unavailable:',
      description: 'zh:could not read the conversation: {error}:socket closed',
    }])
    failed.attachFeed(new AddressConversationFeed(history([]), ADDRESS, vi.fn()))
    await settled()
    expect(materializeTranscriptEntries(failed.snapshot())).toMatchObject([{ description: 'zh:the stored conversation is unavailable:' }])
    failed.attachFeed(undefined)
    expect(materializeTranscriptEntries(failed.snapshot())).toEqual([])
  })

  it('disposes a feed attached after the source itself was disposed', () => {
    const source = new OfficialConversationModelSource({ snapshot: vi.fn(), onChanged: () => () => {} }, { get: () => undefined }, vi.fn())
    source.dispose()
    const feed: ConversationFeed = { take: vi.fn(), settle: vi.fn(), draft: vi.fn(), state: vi.fn(), dispose: vi.fn() }
    source.attachFeed(feed)
    expect(feed.dispose).toHaveBeenCalledOnce()
    expect(materializeTranscriptEntries(source.snapshot())).toEqual([])
  })
})
