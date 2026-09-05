/** Official model consumption of native schema-cloned projection values.
 * @module @ephemeral-ai/mayfly/tests/transcript/official-model-native
 */
import { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { expect, it, vi } from 'vitest'
import * as conversationPlugin from '../../src/conversation/index.ts'
import type { ConversationProjection } from '../../src/conversation/types.ts'
import { conversationTranscriptModel, OfficialConversationModelSource } from '../../src/transcript/official-model.ts'

it('handles cloned native snapshots, multi-entry settlement, retraction, and late results', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(conversationPlugin)
  const session = ctx.sessions.create(SessionId('official-model-native'))
  session.append('turn/start', { turn: 0 })
  session.append('user/message', {
    id: MessageId('user'), role: 'user', content: [{ type: 'text', text: 'question' }], source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  const values: ConversationProjection[] = []
  const off = ctx.sessionProjections.onChanged((target, key, value) => {
    if (target === session && key === 'mayflyConversation') values.push(value as ConversationProjection)
  })
  const publish = vi.fn()
  const tools = { get: () => undefined }
  const source = new OfficialConversationModelSource(ctx.sessionProjections, tools, publish)
  source.attach(session)
  const baseline = ctx.sessionProjections.snapshot(session, ['mayflyConversation']).values.mayflyConversation as ConversationProjection
  session.append('step/start', { turn: 0, step: 0 })
  session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'partial' } })
  session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'reasoning-delta', index: 1, text: 'thought' } })
  expect(values[0]!.entries[0]).toEqual(baseline.entries[0])
  expect(values[0]!.entries[0]).not.toBe(baseline.entries[0])
  expect(values[1]!.entries[0]).not.toBe(values[0]!.entries[0])
  expect(source.snapshot().entries.map(entry => entry.kind)).toEqual(['transcript-user', 'transcript-thinking', 'transcript-assistant'])
  const settledSeq = session.seq
  session.append('assistant/message', {
    turn: 0, step: 0,
    message: {
      id: MessageId('assistant'), role: 'assistant',
      content: [{ type: 'reasoning', text: 'final thought' }, { type: 'text', text: 'final answer' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    },
  }, { surfaceOp: 'append' })
  expect(source.snapshot().entries).toMatchObject([
    { kind: 'transcript-user', text: 'question' },
    { kind: 'transcript-thinking', text: 'final thought', streaming: false },
    { kind: 'transcript-assistant', text: 'final answer', streaming: false },
  ])
  expect(source.snapshot().entries).toEqual(conversationTranscriptModel(values.at(-1)!, tools).entries)
  const checkpoint = ctx.sessionProjections.checkpoint(session)
  const checkpointView = ctx.sessionProjections.viewCheckpoint(checkpoint).mayflyConversation as ConversationProjection
  source.attach(null)
  source.attach(session)
  expect(source.snapshot().entries).toEqual(conversationTranscriptModel(checkpointView, tools).entries)
  session.append('assistant/message', {
    turn: 0, step: 0, interrupted: true,
    message: { id: MessageId('retraction'), role: 'assistant', content: [], source: { kind: 'model', provider: 'mock', model: 'mock' } },
  }, { surfaceOp: { op: 'replace', start: settledSeq, end: settledSeq }, sourceEventSeqs: [settledSeq] })
  expect(source.snapshot().entries).toEqual([])
  session.append('assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'late' } })
  expect(source.snapshot().entries).toEqual([])
  source.dispose()
  const count = publish.mock.calls.length
  session.append('turn/start', { turn: 1 })
  expect(publish).toHaveBeenCalledTimes(count)
  off()
  await fiber.dispose()
  await ctx.fiber.dispose()
})
