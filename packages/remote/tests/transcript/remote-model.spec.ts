import { describe, expect, it, vi } from 'vitest'
import type {
  SessionAssistantSettlementEntry,
  SessionBinding,
  SessionEventChange,
  SessionEventLikeEntry,
  SessionEventSource,
} from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import type { ConversationProjection } from '@ephemeral-ai/mayfly/conversation'
import { foldConversationProjection, initialConversationState } from '../../../host/src/conversation/projection.ts'
import { HostKey } from '../../src/client/types.ts'
import { RemoteConversationModelSource } from '../../src/transcript/remote-model.ts'
import type { ToolPresentationSource } from '@ephemeral-ai/mayfly/transcript'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'

const tools = { get: () => undefined } as ToolPresentationSource

function nativeCatalog(effort = 'high'): ModelCatalog {
  return {
    default: { provider: 'provider', model: 'model' },
    groups: [{ id: 'provider', name: 'Provider', models: [{ id: 'model', name: 'Model', reasoning: { efforts: [], defaultEffort: effort } }] }],
    failures: [], routableProviders: ['provider'],
  } as unknown as ModelCatalog
}

function requestHeader(provider = 'provider', model = 'model', effort: string | null = 'high', seq = 1): SessionEventLikeEntry {
  return {
    type: 'event',
    event: { type: 'request/header', seq: SessionSeq(seq), time: 0, data: { header: {
      config: { provider, model, ...effort === null ? {} : { reasoningEffort: effort } },
      adapterDefaults: { reasoningEffort: true }, tools: [],
    } } },
  } as unknown as SessionEventLikeEntry
}

function projection<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next: T) {
      value = next
      for (const listener of listeners) listener()
    },
  }
}

/** The Host's `mayflyConversation` wire view folded from the same durable events. */
function foldConversation(entries: readonly SessionEventLikeEntry[]): ConversationProjection {
  let state = initialConversationState()
  for (const entry of entries) {
    if (entry.type !== 'event') continue
    state = foldConversationProjection(state, entry.event as never)
  }
  return {
    entries: state.entries,
    streaming: state.active,
    settledSteps: state.finalizedSteps,
    turns: state.turns,
  }
}

/** The Host's `contextPressure` projection: prompt-side tokens of the latest assistant step. */
function contextPressure(entries: readonly SessionEventLikeEntry[]): unknown {
  for (const entry of entries) {
    if (entry.type !== 'event' || entry.event.type !== 'assistant/message') continue
    const usage = (entry.event.data as unknown as {
      readonly usage?: {
        readonly inputTokens?: number
        readonly cacheReadTokens?: number
        readonly cacheWriteTokens?: number
      }
    }).usage
    if (usage?.inputTokens === undefined) continue
    return { projectedTokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) }
  }
  return undefined
}

class TestEventSource implements SessionEventSource {
  private readonly listeners = new Set<() => void>()
  private entries: readonly SessionEventLikeEntry[] = []
  private hasMore = false
  private revision = 0
  private change: SessionEventChange = { kind: 'replace', entries: [] }
  private readonly conversation = projection<ConversationProjection>(foldConversation([]))
  private readonly pressure = projection<unknown>(undefined)
  private readonly faces = { mayflyConversation: this.conversation, contextPressure: this.pressure }

  /** A Session face carrying the Host projections this source's events would produce. */
  binding(
    overrides: Readonly<Record<string, { getSnapshot: () => unknown, subscribe: (listener: () => void) => () => void }>> = {},
  ): SessionBinding {
    const faces: Readonly<Record<string, unknown>> = { ...this.faces, ...overrides }
    const empty = { getSnapshot: () => undefined, subscribe: () => () => {} }
    return {
      sessionId: SessionId('session-1'),
      eventSource: this,
      session: {
        getSnapshot: () => ({ running: false }),
        subscribe: () => () => {},
        projections: { faceOf: (key: string) => faces[key] ?? empty },
      },
    } as unknown as SessionBinding
  }

  getSnapshot() {
    return { entries: this.entries, hasMore: this.hasMore, revision: this.revision, change: this.change }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  append(entry: SessionEventLikeEntry): void {
    this.entries = [...this.entries, entry]
    this.publish({ kind: 'append', entries: [entry] })
  }

  replace(entries: readonly SessionEventLikeEntry[], hasMore: boolean): void {
    this.entries = entries
    this.hasMore = hasMore
    this.publish({ kind: 'replace', entries })
  }

  prepend(entries: readonly SessionEventLikeEntry[], hasMore: boolean): void {
    this.entries = [...entries, ...this.entries]
    this.hasMore = hasMore
    this.publish({ kind: 'prepend', entries })
  }

  settleAssistant(attemptId: LlmAttemptId, settlement: SessionAssistantSettlementEntry): void {
    const entries = this.entries.filter(entry => entry.type !== 'transient' || entry.event.data.attemptId !== attemptId)
    const index = entries.findIndex(entry => entry.event.seq > settlement.event.seq)
    if (index < 0) entries.push(settlement)
    else entries.splice(index, 0, settlement)
    this.entries = entries
    this.publish({ kind: 'settle-assistant', attemptId, entry: settlement })
  }

  replay(): void {
    for (const listener of this.listeners) listener()
  }

  private publish(change: SessionEventChange): void {
    this.conversation.set(foldConversation(this.entries))
    this.pressure.set(contextPressure(this.entries))
    this.change = change
    this.revision += 1
    for (const listener of this.listeners) listener()
  }
}

function turn(turn: number, seq: number): SessionEventLikeEntry {
  return { type: 'event', event: { type: 'turn/start', seq: SessionSeq(seq), time: seq * 10, data: { turn } } }
}

function content(text: string, file = false) {
  return [
    { type: 'text' as const, text },
    ...(file ? [{ type: 'file' as const, attachment: { attachmentId: 'file-1' as never, name: 'a.txt', bytes: 1 } }] : []),
  ]
}

function user(text: string, seq: number, file = false): SessionEventLikeEntry {
  return {
    type: 'event',
    event: {
      type: 'user/message',
      seq: SessionSeq(seq),
      time: seq * 10,
      data: {
        role: 'user',
        id: MessageId(`user-${String(seq)}`),
        source: { kind: 'user' },
        content: content(text, file),
      },
      surfaceOp: 'append',
    },
  }
}

function assistant(text: string, turn: number, seq: number, file = false): SessionAssistantSettlementEntry {
  return {
    type: 'event',
    event: {
      type: 'assistant/message',
      seq: SessionSeq(seq),
      time: seq * 10,
      data: {
        turn,
        step: 0,
        message: {
          role: 'assistant',
          id: MessageId(`assistant-${String(seq)}`),
          source: { kind: 'model', model: 'deepseek-chat', provider: 'deepseek' },
          content: content(text, file),
        },
        stream: [],
      },
      surfaceOp: 'append',
    },
  }
}

function live(text: string, turn: number, seq: number, index: number) {
  return {
    type: 'transient' as const,
    event: {
      type: 'assistant/live-chunk' as const,
      seq,
      time: Math.round(seq * 10),
      data: {
        attemptId: 'attempt-1' as LlmAttemptId,
        turn,
        step: 0,
        chunk: { type: 'text-delta' as const, index, text },
      },
    },
  }
}

function liveBlock(kind: 'block-start' | 'block-end', turn: number, seq: number) {
  const attachment = { attachmentId: 'file-1' as never, name: 'a.txt', bytes: 1 }
  return {
    type: 'transient' as const,
    event: {
      type: 'assistant/live-chunk' as const,
      seq,
      time: Math.round(seq * 10),
      data: {
        attemptId: 'attempt-1' as LlmAttemptId,
        turn,
        step: 0,
        chunk: kind === 'block-start'
          ? { type: kind, index: 0, blockType: 'file' as const }
          : { type: kind, index: 0, block: { type: 'file' as const, attachment } },
      },
    },
  }
}

function toolResult(seq: number, isError?: boolean): SessionEventLikeEntry {
  return {
    type: 'event',
    event: {
      type: 'tool/result',
      seq: SessionSeq(seq),
      time: seq * 10,
      data: {
        turn: 1,
        step: 0,
        message: {
          role: 'tool',
          id: MessageId(`tool-${String(seq)}`),
          source: { kind: 'tool', callId: ToolCallId('call-1') },
          toolCallId: ToolCallId('call-1'),
          content: content('contents', true),
          ...(isError === undefined ? {} : { isError }),
        },
      },
      surfaceOp: 'append',
    },
  }
}

describe('RemoteConversationModelSource', () => {
  it('folds official durable and live entries, then settles one assistant without duplicates', () => {
    const events = new TestEventSource()
    const publish = vi.fn()
    const source = new RemoteConversationModelSource(tools, publish)
    source.attach(events.binding())
    events.append(turn(1, 1))
    events.append(user('question', 2))
    events.append(live('Hel', 1, 2.5, 0))
    events.append(live('lo', 1, 2.6, 1))

    let model = source.snapshot()
    // The live attempt is an overlay beside the durable entries, not a durable
    // row of its own: the Host projection owns history, the live window owns
    // only the in-flight step.
    const liveEntry = model.live?.entries.find(entry => entry.kind === 'transcript-assistant')
    expect(liveEntry).toMatchObject({ text: 'Hello', streaming: true })

    events.settleAssistant('attempt-1' as LlmAttemptId, assistant('Hello', 1, 3))
    model = source.snapshot()
    expect(model.entries.filter(entry => entry.kind === 'transcript-assistant')).toHaveLength(1)
    expect(model.entries.find(entry => entry.kind === 'transcript-assistant')).toMatchObject({ text: 'Hello', streaming: false })

    events.append({ type: 'event', event: { type: 'turn/end', seq: SessionSeq(4), time: 40, data: { turn: 1, reason: { kind: 'completed' } } } })
    expect(source.snapshot().streaming).toBe(false)
    source.dispose()
  })

  it('adapts current tool result messages to the existing tool presentation fold', () => {
    const events = new TestEventSource()
    const source = new RemoteConversationModelSource(tools, vi.fn())
    source.attach(events.binding())
    events.append(turn(1, 1))
    events.append({
      type: 'event',
      event: {
        type: 'tool/call',
        seq: SessionSeq(2),
        time: 20,
        data: { turn: 1, step: 0, callId: ToolCallId('call-1'), name: 'read', arguments: '{"path":"a.txt"}' },
      },
    })
    events.append(toolResult(3, true))
    expect(source.snapshot().entries.find(entry => entry.kind === 'transcript-tool')).toMatchObject({
      callId: 'call-1',
      result: { text: 'contents', isError: true },
    })
    events.append(toolResult(4))
    expect(source.snapshot().entries.find(entry => entry.kind === 'transcript-tool')).toMatchObject({
      result: { text: 'contents', isError: false },
    })
  })

  it('adapts durable messages and ignores callbacks from a replaced source', () => {
    const events = new TestEventSource()
    const publish = vi.fn()
    let staleListener!: () => void
    const subscribe = events.subscribe.bind(events)
    vi.spyOn(events, 'subscribe').mockImplementation(listener => {
      staleListener = listener
      return subscribe(listener)
    })
    const source = new RemoteConversationModelSource(tools, publish)
    source.attach(events.binding())
    events.append(turn(1, 1))
    events.append(user('attachment', 2, true))
    events.append(assistant('attachment', 1, 3, true))
    expect(source.snapshot().entries).toEqual([
      expect.objectContaining({ kind: 'transcript-user', text: 'attachment' }),
      expect.objectContaining({ kind: 'transcript-assistant', text: 'attachment' }),
    ])
    source.attach(new TestEventSource())
    const count = publish.mock.calls.length
    staleListener()
    expect(publish).toHaveBeenCalledTimes(count)
  })

  it('rebuilds on replace and prepend instead of mixing generations', () => {
    const events = new TestEventSource()
    const source = new RemoteConversationModelSource(tools, vi.fn())
    source.attach(events.binding())
    events.append(turn(1, 1))
    events.append(user('old', 2))
    const oldGeneration = source.snapshot().generation

    events.replace([turn(2, 10), user('new', 11)], false)
    expect(source.snapshot().generation).toBeGreaterThan(oldGeneration)
    expect(source.snapshot().entries.some(entry => entry.kind === 'transcript-user' && entry.text === 'old')).toBe(false)
    expect(source.snapshot().entries.some(entry => entry.kind === 'transcript-user' && entry.text === 'new')).toBe(true)

    events.prepend([turn(1, 1), user('older', 2)], true)
    expect(source.snapshot().entries.some(entry => entry.kind === 'transcript-user' && entry.text === 'older')).toBe(true)
  })

  it('adapts file block boundaries without changing the transcript semantics', () => {
    const events = new TestEventSource()
    const source = new RemoteConversationModelSource(tools, vi.fn())
    source.attach(events.binding())
    events.append(liveBlock('block-start', 1, 2.5))
    events.append(liveBlock('block-end', 1, 2.6))
    expect(source.snapshot().entries).toEqual([])
  })

  it('ignores stale revisions and legacy chunk rows', () => {
    const events = new TestEventSource()
    const publish = vi.fn()
    const source = new RemoteConversationModelSource(tools, publish)
    source.attach(events.binding())
    events.append(turn(1, 1))
    const count = publish.mock.calls.length
    events.replay()
    expect(publish).toHaveBeenCalledTimes(count)
    events.append({ type: 'event', event: { type: 'chunkrow/text-chunks', seq: SessionSeq(2), time: 20, data: {} } as never })
    expect(source.snapshot().entries).toEqual([])
  })

  it('publishes an empty model when detached from the event source', () => {
    const events = new TestEventSource()
    const publish = vi.fn()
    const source = new RemoteConversationModelSource(tools, publish)
    source.attach(events.binding())
    source.attach(null)
    expect(source.snapshot().entries).toEqual([])
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ entries: [] }))
  })

  it('ignores publications after dispose', () => {
    const events = new TestEventSource()
    const publish = vi.fn()
    const source = new RemoteConversationModelSource(tools, publish)
    source.attach(events.binding())
    source.dispose()
    const count = publish.mock.calls.length
    events.append(turn(1, 1))
    expect(publish).toHaveBeenCalledTimes(count)
    expect(source.snapshot().entries).toEqual([])
  })

  it('publishes remote presentation facts and only live command outcomes', () => {
    const events = new TestEventSource()
    const title = projection<unknown>(undefined)
    const model = projection<unknown>({ next: null, lastUsed: { model: 'deepseek-chat', provider: 'deepseek' } })
    const binding = events.binding({ title, modelSelection: model })
    const onPresentation = vi.fn()
    const onCommandResult = vi.fn()
    const source = new RemoteConversationModelSource(tools, vi.fn(), { onPresentation, onCommandResult })
    const ref = { host: HostKey('local'), sessionId: SessionId('session-1') }
    source.attach(binding, { ref, cwd: '/work/mayfly' })
    expect(source.presentation()).toMatchObject({ ref, cwd: '/work/mayfly', model: 'deepseek-chat', provider: 'deepseek', contextTokens: 0 })

    title.set('Remote architecture')
    model.set({ next: { model: 'deepseek-reasoner', provider: 'deepseek' }, lastUsed: null })
    expect(source.presentation()).toMatchObject({ title: 'Remote architecture', model: 'deepseek-reasoner' })
    title.set(null)
    model.set(null)
    expect(source.presentation()).toMatchObject({ title: undefined, model: undefined })
    model.set('invalid')
    expect(source.presentation().model).toBeUndefined()
    model.set({ next: { model: 'deepseek-chat', provider: 42 }, lastUsed: null })
    expect(source.presentation().model).toBeUndefined()
    model.set({ next: { model: 'deepseek-chat', provider: 'deepseek' }, lastUsed: null })

    events.append(turn(1, 1))
    expect(source.presentation()).toMatchObject({ active: true, phase: 'waiting' })
    const completed = assistant('done', 1, 2)
    events.append({
      ...completed,
      event: {
        ...completed.event,
        data: {
          ...completed.event.data,
          usage: { inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 3, outputTokens: 7 },
        },
      },
    } as never)
    expect(source.presentation()).toMatchObject({ contextTokens: 123 })

    const command = {
      type: 'event',
      event: { type: 'command/done', seq: SessionSeq(3), time: 30, data: { commandId: 'command-1', kind: 'error', text: 'failed' } },
    } as SessionEventLikeEntry
    events.append(command)
    expect(onCommandResult).toHaveBeenCalledOnce()
    expect(onCommandResult).toHaveBeenCalledWith({ kind: 'error', text: 'failed' })
    events.append({
      type: 'event',
      event: { type: 'command/done', seq: SessionSeq(4), time: 40, data: { commandId: 'command-2', kind: 'success' } },
    } as SessionEventLikeEntry)
    expect(onCommandResult).toHaveBeenCalledWith({ kind: 'success' })
    events.replace([command], false)
    events.prepend([turn(1, 1)], true)
    expect(onCommandResult).toHaveBeenCalledTimes(2)
    expect(onPresentation).toHaveBeenCalled()

    source.attach(null)
    expect(source.presentation()).toMatchObject({ ref: undefined, cwd: '', model: undefined, contextTokens: 0, active: false })
    source.dispose()
  })

  it('publishes and clears the Host default model without duplicate renders', () => {
    const onPresentation = vi.fn()
    const source = new RemoteConversationModelSource(tools, vi.fn(), { onPresentation })
    source.setDefaultModel({ model: 'deepseek-chat', provider: 'deepseek' })
    expect(source.presentation()).toMatchObject({ model: 'deepseek-chat', provider: 'deepseek' })
    const count = onPresentation.mock.calls.length
    source.setDefaultModel({ model: 'deepseek-chat', provider: 'deepseek' })
    expect(onPresentation).toHaveBeenCalledTimes(count)
    source.setDefaultModel({ model: 'deepseek-reasoner', provider: 'deepseek' })
    expect(source.presentation().model).toBe('deepseek-reasoner')
    source.setDefaultModel(undefined)
    expect(source.presentation().model).toBeUndefined()
    source.dispose()
  })

  it('keeps startup directory and default effort until exact Session projections replace them', () => {
    const source = new RemoteConversationModelSource(tools, vi.fn(), { defaultCwd: '/host/startup' })
    source.setDefaultModel({ provider: 'provider', model: 'model', reasoningEffort: 'high' })
    expect(source.presentation()).toMatchObject({ cwd: '/host/startup', reasoningEffort: 'high' })
    source.setDefaultModel({ provider: 'provider', model: 'model', reasoningEffort: 'low' })
    expect(source.presentation().reasoningEffort).toBe('low')
    const events = new TestEventSource()
    const selected = projection<unknown>({ next: { provider: 'provider', model: 'other', reasoningEffort: 'medium' } })
    source.attach(events.binding({ modelSelection: selected }), { ref: { host: HostKey('host'), sessionId: SessionId('session-1') }, cwd: '/host/session' })
    expect(source.presentation()).toMatchObject({ cwd: '/host/session', model: 'other', reasoningEffort: 'medium' })
    selected.set({ next: { provider: 'provider', model: 'plain' } })
    expect(source.presentation().reasoningEffort).toBeUndefined()
    source.attach(null)
    expect(source.presentation()).toMatchObject({ cwd: '/host/startup', model: 'model', reasoningEffort: 'low' })
    source.dispose()
  })

  it('restores an admitted default effort while wire next aliases lastUsed, without pinning the selection', () => {
    const events = new TestEventSource()
    events.replace([requestHeader()], false)
    const native = { provider: 'provider', model: 'model' }
    const selected = projection<unknown>({ next: native, lastUsed: native })
    const source = new RemoteConversationModelSource(tools, vi.fn())
    source.setDefaultModel({ ...native, reasoningEffort: 'max' })
    source.attach(events.binding({ modelSelection: selected }), { ref: { host: HostKey('host'), sessionId: SessionId('same-session') }, cwd: '' })
    expect(source.presentation()).toMatchObject({ ...native, reasoningEffort: 'high' })
    expect(selected.getSnapshot()).toEqual({ next: native, lastUsed: native })
    events.append(requestHeader('provider', 'model', 'low', 2))
    expect(source.presentation().reasoningEffort).toBe('low')
    events.append(requestHeader('provider', 'model', null, 3))
    expect(source.presentation().reasoningEffort).toBeUndefined()
    source.dispose()
  })

  it('never carries an old header or catalog level into a pending route or default-effort choice', () => {
    const events = new TestEventSource()
    events.replace([requestHeader('provider', 'model', 'max')], false)
    const previous = { provider: 'provider', model: 'model', reasoningEffort: 'max' }
    const selected = projection<unknown>({ next: previous, lastUsed: previous })
    const source = new RemoteConversationModelSource(tools, vi.fn())
    source.setModelCatalog(HostKey('host'), nativeCatalog())
    source.attach(events.binding({ modelSelection: selected }), { ref: { host: HostKey('host'), sessionId: SessionId('session') }, cwd: '' })
    expect(source.presentation().reasoningEffort).toBe('max')
    selected.set({ next: { provider: 'provider', model: 'model' }, lastUsed: previous })
    expect(source.presentation().reasoningEffort).toBeUndefined()
    selected.set({ next: { provider: 'provider', model: 'new-model' }, lastUsed: previous })
    expect(source.presentation().reasoningEffort).toBeUndefined()
    selected.set({ next: { provider: 'other-provider', model: 'model' }, lastUsed: previous })
    expect(source.presentation().reasoningEffort).toBeUndefined()
    selected.set({ next: { provider: 'provider', model: 'model' }, lastUsed: null })
    expect(source.presentation().reasoningEffort).toBeUndefined()
    source.dispose()
  })

  it('resolves a used route from exact Host metadata when its request header is outside the native tail page', () => {
    const events = new TestEventSource()
    events.replace([assistant('Long response tail', 1, 200)], true)
    const native = { provider: 'provider', model: 'model' }
    const selected = projection<unknown>({ next: native, lastUsed: native })
    const changed = vi.fn()
    const source = new RemoteConversationModelSource(tools, vi.fn(), { onPresentation: changed })
    const catalog = nativeCatalog()
    source.setModelCatalog(HostKey('first'), catalog)
    const revision = changed.mock.calls.length
    source.setModelCatalog(HostKey('first'), catalog)
    expect(changed).toHaveBeenCalledTimes(revision)
    source.attach(events.binding({ modelSelection: selected }), { ref: { host: HostKey('first'), sessionId: SessionId('same-session') }, cwd: '' })
    expect(source.presentation().reasoningEffort).toBe('high')
    source.setVisible(false)
    events.replace([assistant('Reconnected tail', 1, 201)], true)
    source.setVisible(true)
    expect(source.presentation().reasoningEffort).toBe('high')
    source.attach(events.binding({ modelSelection: selected }), { ref: { host: HostKey('second'), sessionId: SessionId('same-session') }, cwd: '' })
    expect(source.presentation().reasoningEffort).toBeUndefined()
    source.setModelCatalog(HostKey('second'), nativeCatalog('low'))
    expect(source.presentation().reasoningEffort).toBe('low')
    source.setModelCatalog(HostKey('second'), undefined)
    expect(source.presentation().reasoningEffort).toBeUndefined()
    source.attach(null)
    expect(source.presentation().reasoningEffort).toBeUndefined()
    source.dispose()
    const after = changed.mock.calls.length
    source.setModelCatalog(HostKey('first'), nativeCatalog('max'))
    expect(changed).toHaveBeenCalledTimes(after)
  })

  it('does not invent effective metadata for an unavailable provider, model, or non-reasoning route', () => {
    const events = new TestEventSource()
    events.replace([requestHeader('other-provider', 'other-model')], false)
    const selected = projection<unknown>({ next: { provider: 'provider', model: 'model' }, lastUsed: { provider: 'provider', model: 'model' } })
    const source = new RemoteConversationModelSource(tools, vi.fn())
    source.attach(events.binding({ modelSelection: selected }), { ref: { host: HostKey('host'), sessionId: SessionId('session') }, cwd: '' })
    source.setModelCatalog(HostKey('host'), nativeCatalog())
    expect(source.presentation().reasoningEffort).toBe('high')
    for (const [provider, model] of [['absent', 'model'], ['provider', 'absent']]) {
      const route = { provider, model }
      selected.set({ next: route, lastUsed: route })
      expect(source.presentation().reasoningEffort).toBeUndefined()
    }
    const route = { provider: 'provider', model: 'plain' }
    selected.set({ next: route, lastUsed: route })
    source.setModelCatalog(HostKey('host'), { ...nativeCatalog(), groups: [{ id: 'provider', name: 'Provider', models: [{ id: 'plain', name: 'Plain' }] }] })
    expect(source.presentation().reasoningEffort).toBeUndefined()
    source.dispose()
  })

  it('keeps fork history floors aligned across entries, settled steps, turns, images, and Session facts', () => {
    const events = new TestEventSource()
    const durable = foldConversation([turn(1, 1), user('inherited', 2), assistant('old answer', 1, 3), turn(2, 10), user('child reply', 11)])
    const image = { attachmentId: 'native-image', mediaType: 'image/png', bytes: 1, width: 2, height: 3 } as const
    const conversation = projection<unknown>({
      ...durable,
      entries: durable.entries.map(entry => entry.kind === 'user' && entry.turn === 2 ? { ...entry, images: [image] } : entry),
      settledSteps: ['1:0', '2:0'],
    })
    const source = new RemoteConversationModelSource(tools, vi.fn())
    const ref = { host: HostKey('host'), sessionId: SessionId('child') }
    source.attach(events.binding({ mayflyConversation: conversation }), { ref, cwd: '/child', historyFloorSeq: 3 })
    expect(source.sessionFacts()).toMatchObject({ ref, cwd: '/child' })
    expect(source.snapshot().entries).toEqual([expect.objectContaining({ kind: 'transcript-user', text: 'child reply' })])
    expect(source.snapshot().turns?.map(turn => turn.turn)).toEqual([2])
    expect(source.imageAttachment('native-image')).toEqual(image)
    expect(source.imageAttachment('missing')).toBeUndefined()
    source.dispose()
    expect(source.imageAttachment('native-image')).toBeUndefined()
  })

  it('ignores malformed durable projections and accepts pressure-only native context facts', () => {
    const events = new TestEventSource()
    const conversation = projection<unknown>({ entries: [], streaming: false, settledSteps: [], turns: [] })
    const pressure = projection<unknown>({ pressureTokens: 64, contextWindow: 128 })
    const source = new RemoteConversationModelSource(tools, vi.fn())
    source.attach(events.binding({ mayflyConversation: conversation, contextPressure: pressure }))
    expect(source.presentation()).toMatchObject({ contextTokens: 64, contextWindow: 128 })
    for (const value of [{}, { entries: 'bad', streaming: false }, { entries: [], streaming: 1 },
      { entries: [], streaming: false }, { entries: [], streaming: false, settledSteps: [1] },
      { entries: [], streaming: false, settledSteps: [], turns: 'bad' }]) {
      conversation.set(value)
      expect(source.snapshot().entries).toEqual([])
    }
    pressure.set({})
    expect(source.presentation()).toMatchObject({ contextTokens: 0, contextWindow: undefined })
    source.dispose()
    source.setDefaultModel({ provider: 'late', model: 'late' })
    source.attach(events.binding())
    expect(source.presentation().model).toBeUndefined()
  })

  it('refreshes exact-Host tool presentation without converting hidden views and rejects late cache callbacks', () => {
    let changed!: () => void
    const unsubscribe = vi.fn()
    const scoped = { get: vi.fn(() => undefined), source: vi.fn(() => tools), subscribe: vi.fn((listener: () => void) => { changed = listener; return unsubscribe }) }
    const publish = vi.fn()
    const source = new RemoteConversationModelSource(scoped, publish)
    const events = new TestEventSource()
    const ref = { host: HostKey('host'), sessionId: SessionId('session') }
    source.attach(events.binding(), { ref, cwd: '' })
    expect(scoped.source).toHaveBeenLastCalledWith(ref, expect.objectContaining({ entries: [] }))
    const before = publish.mock.calls.length
    changed()
    expect(publish.mock.calls.length).toBeGreaterThan(before)
    source.setVisible(false)
    const hidden = publish.mock.calls.length
    changed()
    expect(publish).toHaveBeenCalledTimes(hidden)
    source.setVisible(true)
    expect(publish.mock.calls.length).toBeGreaterThan(hidden)
    source.attach(null)
    source.setVisible(false)
    changed()
    source.setVisible(true)
    expect(source.snapshot().entries).toEqual([])
    source.dispose()
    const retired = publish.mock.calls.length
    changed()
    expect(publish).toHaveBeenCalledTimes(retired)
    expect(unsubscribe).toHaveBeenCalledOnce()
    source.setVisible(false)
  })

  it.each([
    [{ type: 'reasoning-delta', index: 0, text: 'Inspect the source' }, 'thinking'],
    [{ type: 'text-delta', index: 0, text: 'The answer' }, 'composing'],
    [{ type: 'tool-call-delta', index: 0, id: 'native-call', name: 'bash', argumentsDelta: '{' }, 'waiting'],
    [{ type: 'block-start', index: 0, blockType: 'file' }, 'waiting'],
  ])('derives the current presentation phase from native transient %j', (chunk, phase) => {
    const events = new TestEventSource()
    const source = new RemoteConversationModelSource(tools, vi.fn())
    source.attach(events.binding())
    events.append({ ...live('', 1, 2, 0), event: { ...live('', 1, 2, 0).event, data: { ...live('', 1, 2, 0).event.data, chunk } } } as unknown as SessionEventLikeEntry)
    expect(source.presentation()).toMatchObject({ active: true, phase })
    source.dispose()
  })

  it('ignores stale projection callbacks after selecting another Session', () => {
    const events = new TestEventSource()
    let staleTitle!: () => void
    let staleModel!: () => void
    const title = {
      getSnapshot: () => 'old title',
      subscribe: (listener: () => void) => {
        staleTitle = listener
        return () => {}
      },
    }
    const model = {
      getSnapshot: () => null,
      subscribe: (listener: () => void) => {
        staleModel = listener
        return () => {}
      },
    }
    const binding = {
      eventSource: events,
      session: {
        getSnapshot: () => ({ running: false }),
        subscribe: () => () => {},
        projections: { faceOf: (key: string) => key === 'title' ? title : model },
      },
    } as unknown as SessionBinding
    const onPresentation = vi.fn()
    const source = new RemoteConversationModelSource(tools, vi.fn(), { onPresentation })
    source.attach(binding)
    const count = onPresentation.mock.calls.length
    source.attach(new TestEventSource())
    staleTitle()
    staleModel()
    expect(onPresentation).toHaveBeenCalledTimes(count + 1)
    source.dispose()
  })
})


describe('hidden native conversation views', () => {
  it('keeps unread updates unconverted and publishes only the latest value on display', () => {
    const events = new TestEventSource()
    const publish = vi.fn()
    const onPresentation = vi.fn()
    const onCommandResult = vi.fn()
    const source = new RemoteConversationModelSource(tools, publish, { onPresentation, onCommandResult })
    source.attach(events.binding())
    const before = source.snapshot()
    source.setVisible(false)
    publish.mockClear(); onPresentation.mockClear()
    for (let index = 1; index <= 40; index += 1) events.append(user(`unread ${String(index)}`, index))
    expect(source.snapshot()).toBe(before)
    expect(publish).not.toHaveBeenCalled()
    expect(onPresentation).not.toHaveBeenCalled()
    events.append({ type: 'event', event: { type: 'command/done', seq: SessionSeq(41), time: 410, data: { kind: 'success', text: 'hidden result' } } } as SessionEventLikeEntry)
    expect(onCommandResult).not.toHaveBeenCalled()
    source.setVisible(true)
    expect(source.snapshot().entries).toHaveLength(40)
    expect(source.snapshot().entries.at(-1)).toMatchObject({ text: 'unread 40' })
    expect(publish).toHaveBeenCalledOnce()
    source.setVisible(true)
    expect(publish).toHaveBeenCalledOnce()
    source.dispose()
  })

  it('defers initial attachment and replacements and rejects hidden late data after disposal', () => {
    const events = new TestEventSource()
    const publish = vi.fn()
    const source = new RemoteConversationModelSource(tools, publish)
    source.setVisible(false)
    events.replace([user('before', 1)], false)
    source.attach(events.binding())
    expect(publish).not.toHaveBeenCalled()
    events.replace([user('replacement', 2)], false)
    source.setVisible(true)
    expect(source.snapshot().entries).toHaveLength(1)
    expect(source.snapshot().entries[0]).toMatchObject({ text: 'replacement' })
    source.setVisible(false)
    source.dispose()
    publish.mockClear()
    events.append(user('too late', 3))
    source.setVisible(true)
    expect(publish).not.toHaveBeenCalled()
  })
})
