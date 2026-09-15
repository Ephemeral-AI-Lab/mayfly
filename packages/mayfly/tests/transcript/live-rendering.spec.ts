/** Live transcript rendering over durable projections and transient draft revisions.
 * @module @ephemeral-ai/mayfly/tests/transcript/live-rendering
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { expect, it, vi } from 'vitest'
import * as conversationPlugin from '../../src/conversation/index.ts'
import { LiveAssistantStreamService } from '../../src/conversation/live-stream.ts'
import { freezeModel, materializeTranscriptEntries, type TranscriptModel } from '../../src/frontend/models.ts'
import { conversationTranscriptModel, OfficialConversationModelSource } from '../../src/transcript/official-model.ts'
import { TranscriptModelComponent } from '../../src/transcript/transcript-model.ts'
import { fakeMayflyComponents } from './helpers.ts'
import { COLORS } from './status-fakes.ts'

async function rig(id: string) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(conversationPlugin)
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 0 })
  const agent = { session } as Agent
  const live = new LiveAssistantStreamService(ctx)
  const publish = vi.fn()
  const source = new OfficialConversationModelSource(ctx.sessionProjections, { get: () => undefined }, publish, live)
  source.attach(session, undefined, agent)
  const renderer = { colors: COLORS, components: fakeMayflyComponents(), viewportRows: () => 24, images: () => ({}), requestRender: () => {} }
  const component = new TranscriptModelComponent(() => source.snapshot(), renderer)
  let revision = 0
  let index = 0
  const start = (attemptId = 'attempt') => {
    index = 0
    live.accept(agent, { type: 'start', attemptId, revision: ++revision, turn: 1, step: 0 } as AssistantStreamFrame)
  }
  const chunk = (value: Extract<AssistantStreamFrame, { type: 'chunk' }>['chunk'], attemptId = 'attempt') => {
    live.accept(agent, { type: 'chunk', attemptId, revision: ++revision, index: index++, time: 100, chunk: value } as AssistantStreamFrame)
  }
  const dispose = async () => { component.dispose(); source.dispose(); live.dispose(); await ctx.fiber.dispose() }
  return { ctx, session, agent, live, source, component, start, chunk, dispose, publish }
}

it('renders every draft revision and authoritative settlement even at the former synthetic sequence', async () => {
  const r = await rig('live-render-revision')
  try {
    r.component.render(24)
    const durable = r.source.snapshot().entries
    const settlementSeq = r.session.seq
    r.start()
    r.chunk({ type: 'reasoning-delta', index: 0, text: 'first thought' })
    expect(r.component.render(24).join('\n')).toContain('first thought')
    r.chunk({ type: 'reasoning-delta', index: 0, text: ' extended' })
    expect(r.component.render(80).join('\n')).toContain('first thought extended')
    r.chunk({ type: 'text-delta', index: 1, text: 'first' })
    expect(r.component.render(24).join('\n')).toContain('first')
    expect(r.source.snapshot().live?.entries[0]).toMatchObject({ streaming: false })
    expect(r.source.snapshot().live?.entries[0]).not.toHaveProperty('outputProgress')
    r.chunk({ type: 'text-delta', index: 1, text: ' second' })
    expect(r.component.render(24).join('\n')).toContain('first second')
    expect(r.source.snapshot().entries).toBe(durable)
    expect(r.source.snapshot().live?.entries.at(-1)?.seq).toBe(settlementSeq)
    r.session.append('assistant/message', {
      turn: 1, step: 0,
      message: { id: MessageId('settled'), role: 'assistant', content: [{ type: 'text', text: 'authoritative final' }], source: { kind: 'model', provider: 'mock', model: 'mock' } },
      stream: [],
    }, { surfaceOp: 'append' })
    expect(r.source.snapshot().live).toBeUndefined()
    expect(r.component.render(24).join('\n')).toContain('authoritative final')
    expect(r.component.render(24).join('\n')).not.toContain('first second')
  } finally { await r.dispose() }
})

it('replaces a failed mixed attempt with retry text despite its ended thinking block', async () => {
  const r = await rig('live-render-retry')
  try {
    r.session.append('assistant/attempt', {
      turn: 1, step: 0, stream: [
        { type: 'reasoning-chunks', time0: 100, index: 0, dt: [], texts: ['failed thought'] },
        { type: 'text-chunks', time0: 100, index: 1, dt: [], texts: ['failed answer'] },
      ],
    })
    r.component.render(80)
    r.start()
    r.chunk({ type: 'reasoning-delta', index: 0, text: 'retry thought' })
    r.chunk({ type: 'text-delta', index: 1, text: 'retry answer' })
    const rows = r.component.render(80).join('\n')
    expect(rows).toContain('retry answer')
    expect(rows).toContain('retry thought')
    expect(rows).not.toContain('failed answer')
    expect(materializeTranscriptEntries(r.source.snapshot()).filter(entry => entry.kind === 'transcript-assistant')).toHaveLength(1)
  } finally { await r.dispose() }
})

it('keeps 10000 historical presenters and entry reads out of repeated live renders', async () => {
  const ctx = new Context()
  const session = { id: 'long-live' } as Agent['session']
  const agent = { session } as Agent
  const live = new LiveAssistantStreamService(ctx)
  const entries = Array.from({ length: 10_000 }, (_, index) => ({ kind: 'tool', id: `tool:${String(index)}`, seq: index, updatedSeq: index, turn: index, step: 0, callId: String(index), name: 'other', arguments: '{}', startedAt: 1, channel: 'transcript' }))
  const presentCall = vi.fn(() => ({ card: 'generic', title: 'historical tool' }))
  const source = new OfficialConversationModelSource({ snapshot: () => ({ asOfSeq: 10_000, values: { mayflyConversation: { entries, streaming: true, settledSteps: [] } } }), onChanged: () => () => {} }, { get: () => ({ presentCall }) as never }, () => {}, live)
  source.attach(session, undefined, agent)
  const durableEntries = source.snapshot().entries
  expect(presentCall).toHaveBeenCalledTimes(10_000)
  let historicalReads = 0
  const observed = new Proxy(durableEntries, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/u.test(key)) historicalReads += 1; return Reflect.get(target, key, receiver) } })
  const component = new TranscriptModelComponent(() => ({ ...source.snapshot(), entries: observed }), { colors: COLORS, components: fakeMayflyComponents(), viewportRows: () => 24, images: () => ({}), requestRender: () => {} })
  live.accept(agent, { type: 'start', attemptId: 'long' as never, revision: 1, turn: 10_000, step: 0 })
  component.render(80)
  historicalReads = 0
  for (let index = 0; index < 20; index += 1) {
    live.accept(agent, { type: 'chunk', attemptId: 'long' as never, revision: index + 2, index, time: 100, chunk: { type: 'text-delta', index: 0, text: 'x' } })
    const current = source.snapshot()
    expect(current.entries).toBe(durableEntries)
    expect(component.render(80).join('\n')).toContain('x'.repeat(index + 1))
  }
  expect(historicalReads).toBe(0)
  expect(presentCall).toHaveBeenCalledTimes(10_000)
  source.invalidateTools()
  expect(presentCall).toHaveBeenCalledTimes(20_000)
  expect(source.snapshot().generation).toBe(1)
  component.dispose()
  source.dispose()
  source.invalidateTools()
  live.dispose()
  await ctx.fiber.dispose()
})

it('deep-freezes foreign shallow-frozen values but reuses its own trusted graphs', () => {
  let reads = 0
  const child = { values: [1] }
  const observed = new Proxy(child, { ownKeys(target) { reads += 1; return Reflect.ownKeys(target) } })
  const foreign = Object.freeze({ child: observed })
  expect(freezeModel(foreign)).toBe(foreign)
  expect(Object.isFrozen(child.values)).toBe(true)
  reads = 0
  freezeModel({ history: foreign, live: { text: 'next' } })
  expect(reads).toBe(0)
  const noLive: TranscriptModel = { kind: 'transcript', id: 'plain', generation: 0, entries: [] }
  expect(materializeTranscriptEntries(noLive)).toBe(noLive.entries)
})

it('invalidates tool presentation rows without changing session generation', async () => {
  const ctx = new Context()
  const session = { id: 'tools-invalidate' } as Agent['session']
  const agent = { session } as Agent
  let title = 'old presentation'
  const presentCall = vi.fn(() => ({ card: 'generic', title }))
  const source = new OfficialConversationModelSource({
    snapshot: () => ({ asOfSeq: 1, values: { mayflyConversation: { settledSteps: [], streaming: false, entries: [{ kind: 'tool', id: 'tool', seq: 1, updatedSeq: 1, turn: 1, step: 0, callId: 'call', name: 'custom', arguments: '{}', startedAt: 1, channel: 'transcript' }] } } }),
    onChanged: () => () => {},
  }, { get: () => ({ presentCall }) as never }, () => {})
  source.invalidateTools()
  source.attach(session, undefined, agent)
  const component = new TranscriptModelComponent(() => source.snapshot(), { colors: COLORS, components: fakeMayflyComponents(), viewportRows: () => 24, images: () => ({}), requestRender: () => {} })
  const generation = source.snapshot().generation
  expect(component.render(80).join('\n')).toContain('old presentation')
  expect(presentCall).toHaveBeenCalledTimes(1)
  title = 'new presentation'
  source.invalidateTools()
  expect(source.snapshot().generation).toBe(generation)
  expect(presentCall).toHaveBeenCalledTimes(2)
  expect(component.render(80).join('\n')).toContain('new presentation')
  source.attach(session)
  source.snapshot()
  source.invalidateTools()
  component.dispose()
  source.dispose()
  await ctx.fiber.dispose()
})

it('retires a replaced live component and ignores notifications without a selected Agent', () => {
  const entry = { kind: 'transcript-assistant' as const, id: 'live', seq: 1, updatedSeq: 0, turn: 1, step: 0, text: 'live text', streaming: true, renderRevision: 'live:1' }
  const entries: TranscriptModel['entries'] = []
  let current: TranscriptModel = { kind: 'transcript', id: 'live-retirement', generation: 1, entries, live: { turn: 1, step: 0, entries: [entry] } }
  const component = new TranscriptModelComponent(() => current, { colors: COLORS, components: fakeMayflyComponents(), viewportRows: () => 24, images: () => ({}), requestRender: () => {} })
  expect(component.render(80).join('\n')).toContain('live text')
  current = { ...current, live: { turn: 1, step: 0, entries: [] } }
  expect(component.render(80)).toEqual([])
  component.dispose()

  let notify = () => {}
  const source = new OfficialConversationModelSource({ snapshot: () => ({ asOfSeq: 0, values: { mayflyConversation: { entries: [], settledSteps: [], streaming: false } } }), onChanged: () => () => {} }, { get: () => undefined }, () => {}, { get: () => undefined, subscribe: callback => { notify = callback; return () => {} } })
  notify()
  source.attach({ id: 'empty' } as Agent['session'])
  source.snapshot()
  source.invalidateTools()
  source.dispose()

  const progress = { chars: 10, initialChars: 5, startedAt: 1, updatedAt: 2 }
  expect(conversationTranscriptModel({ entries: [{ kind: 'thinking', id: 'thinking', seq: 1, updatedSeq: 1, turn: 1, step: 0, text: 'thought', streaming: false, outputProgress: progress }], streaming: false, settledSteps: [] }, { get: () => undefined }).entries[0]).toMatchObject({ outputProgress: progress })
})

it('reuses canonical rows and safely retires a live semantic id absent from the cache', () => {
  const node = { kind: 'text' as const, content: 'canonical' }
  let model: TranscriptModel = { kind: 'transcript', id: 'canonical', generation: 0, entries: [node], live: { turn: 1, step: 0, entries: [] } }
  const component = new TranscriptModelComponent(() => model, { colors: COLORS, components: fakeMayflyComponents(), viewportRows: () => 24, images: () => ({}), requestRender: () => {}, semantic: false })
  expect(component.render(80)).toEqual(['canonical'])
  model = { ...model, streaming: true }
  expect(component.render(80)).toEqual(['canonical'])
  component.setExpanded(true)
  expect(component.render(80)).toEqual(['canonical'])
  model = { ...model, live: { turn: 1, step: 0, entries: [{ kind: 'transcript-assistant', id: 'new-live', seq: 1, updatedSeq: 1, turn: 1, step: 0, text: 'answer', streaming: true, renderRevision: 'live:1' }] } }
  component.render(80)
  model = { ...model, live: { turn: 1, step: 0, entries: [] } }
  expect(component.render(80)).toEqual(['canonical'])
  component.dispose()
})
