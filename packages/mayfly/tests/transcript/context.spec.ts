/** Native compaction, approval and exact child facts reach the reference Transcript context. @module */
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey } from '../../src/client/types.ts'
import { remoteTranscriptChildIds, remoteTranscriptContext, type RemoteTranscriptCatalog, spawnedChildIds } from '../../src/transcript/context.ts'
import { catalog, facts, ref, summary } from './context-fixture.ts'

describe('displayed transcript context', () => {
  it('reads only the displayed whole parent snapshot and preserves native mark and approval identities', () => {
    expect(remoteTranscriptContext({ ...facts(), ref: undefined })).toBeUndefined()
    expect(remoteTranscriptContext(facts())).toEqual({ children: { byId: new Map(), byCall: new Map(), byPrompt: new Map() } })
    const marks = [{ id: 'compact', before: 800, after: 120, window: 1000 }]
    const approvals = [{ id: 'approval', callId: 'call', outcome: 'rejected' }]
    const snapshot = facts({ mayflyConversationFacts: { active: false, compactions: marks, approvals }, contextPressure: { contextWindow: 1000, projectedTokens: 140, pressureTokens: 120 } })
    const context = remoteTranscriptContext(snapshot)!
    expect(context.marks).toBe(marks)
    expect(context.approvals).toBe(approvals)
    expect(context).toMatchObject({ window: 1000, tokens: 140 })
    expect(remoteTranscriptContext(facts({ contextPressure: { projectedTokens: 'pending', pressureTokens: 72 } }))!.tokens).toBe(72)
    expect(remoteTranscriptContext(facts({ contextPressure: { contextWindow: 'unknown', pressureTokens: 'unknown' }, mayflyConversationFacts: { active: false, compactions: false, approvals: {} } }))).toEqual({ children: { byId: new Map(), byCall: new Map(), byPrompt: new Map() } })
    for (const invalid of [null, [], 5, { active: 'false' }]) {
      expect(remoteTranscriptContext(facts({ mayflyConversationFacts: invalid, contextPressure: invalid }))!.marks).toBeUndefined()
    }
  })

  it('gives the displayed Session\'s directory from its own catalog row, and none from another Session\'s', () => {
    const session = { ref: { host: HostKey('h'), sessionId: SessionId('p') }, values: {} } as unknown as Parameters<typeof remoteTranscriptContext>[0]
    const of = (sessionId: string) => ({ ref: { host: HostKey('h'), sessionId: SessionId(sessionId) }, snapshot: { byId: { p: { cwd: '/w' } }, projectionsBySession: {} } }) as unknown as RemoteTranscriptCatalog
    expect(remoteTranscriptContext(session, of('p'))?.cwd).toBe('/w')
    expect(remoteTranscriptContext(session, of('other'))).not.toHaveProperty('cwd')
    expect(remoteTranscriptContext(session)).not.toHaveProperty('cwd')
  })

  it('finds each spawn call its child through the catalog: same description in spawn order, and a failed call claims nothing', () => {
    const call = (callId: string, description: unknown, isError?: boolean) => ({ seq: 1, turn: 1, step: 1, callId, name: 'subagent', arguments: JSON.stringify({ description }), startedAt: 0, ...isError === undefined ? {} : { result: { text: '', isError, endedAt: 1 } } })
    const catalog = [null, { id: 7, label: 'A' }, { id: 'no-label' }, { id: 'a1', label: 'A' }, { id: 'b1', label: 'B' }, { id: 'a2', label: 'A' }, { id: 'workflow-child', label: 'scan' }]
    const calls = [call('failed', 'A', true), call('first', 'A', false), call('pending', 'B'), call('second', 'A'), call('third', 'A'), call('nameless', 7)]
    expect([...spawnedChildIds(calls, catalog)]).toEqual([['first', 'a1'], ['pending', 'b1'], ['second', 'a2']])
    expect([...spawnedChildIds(calls, 'not a catalog')]).toEqual([])
    const displayed = remoteTranscriptContext(facts({ mayflyConversationFacts: { active: true, agentCalls: calls }, subagentCatalog: catalog }))!
    expect([...displayed.children!.byCall]).toEqual([['first', 'a1'], ['pending', 'b1'], ['second', 'a2']])
    expect([...remoteTranscriptContext(facts({ mayflyConversationFacts: { active: true, agentCalls: 'bad' }, subagentCatalog: catalog }))!.children!.byCall]).toEqual([])
  })

  it('admits only the exact Host and displayed parent’s authoritative direct-child identities', () => {
    const displayed = facts({ subagentCatalog: [null, [], 5, {}, { id: 7 }, { id: 'parent' }, { id: 'external', mode: 'external' }, { id: 'wrong-parent' }, { id: 'known' }, { id: 'unlisted' }] })
    const snapshot = catalog([summary('wrong-parent', { parentId: SessionId('other') }), summary('known')])
    expect(remoteTranscriptChildIds(displayed, { ref, snapshot })).toEqual(['known', 'unlisted'])
    expect(remoteTranscriptChildIds({ ...displayed, ref: undefined }, { ref, snapshot })).toEqual([])
    expect(remoteTranscriptChildIds(displayed, undefined)).toEqual([])
    expect(remoteTranscriptChildIds(displayed, { ref: { ...ref, host: HostKey('other') }, snapshot })).toEqual([])
    expect(remoteTranscriptChildIds(displayed, { ref: { ...ref, sessionId: SessionId('other') }, snapshot })).toEqual([])
    expect(remoteTranscriptChildIds(facts({ subagentCatalog: {} }), { ref, snapshot })).toEqual([])
  })

  it('maps native outcomes, stopped timing and first prompt index without cross-child or parent borrowing', () => {
    const ids = ['active', 'waiting', 'completed', 'failed', 'stopped', 'native-running', 'timing-active', 'timing-completed', 'timing-failed', 'summary-running', 'unknown']
    const snapshot = catalog(ids.map(id => summary(id, { running: id === 'native-running' || id === 'summary-running' })))
    const values = new Map([
      ['active', { mayflyConversationFacts: { active: true, runOutcome: 'failed' } }],
      ['waiting', { mayflyConversationFacts: { active: false } }],
      ['completed', { mayflyConversationFacts: { active: false, runOutcome: 'completed', promptText: 'identical', endedAt: 20 } }],
      ['failed', { mayflyConversationFacts: { active: false, runOutcome: 'failed', promptText: 'identical' } }],
      ['stopped', { mayflyConversationFacts: { active: false, runOutcome: 'failed', runStopped: true, endedAt: 30 } }],
      ['native-running', { mayflyConversationFacts: { active: false, runOutcome: 'completed' } }],
      ['timing-active', { subagentTiming: { active: { since: 10, through: 11 } } }],
      ['timing-completed', { subagentTiming: { lastTurnCompleted: true } }],
      ['timing-failed', { subagentTiming: { lastTurnCompleted: false } }],
    ])
    const children = new Map([...values].map(([id, value]) => [SessionId(id), value])) as unknown as NonNullable<RemoteTranscriptCatalog['children']>
    const context = remoteTranscriptContext(facts({ subagentCatalog: ids.map(id => ({ id })), mayflyConversationFacts: { active: false, runOutcome: 'failed', promptText: 'parent prompt' }, subagentTiming: { lastTurnCompleted: false } }), { ref, snapshot, children })!
    expect([...context.children!.byId]).toEqual([
      ['active', { state: 'running' }], ['waiting', { state: 'running' }],
      ['completed', { state: 'settled', failed: false, endedAt: 20 }],
      ['failed', { state: 'settled', failed: true }],
      ['stopped', { state: 'settled', failed: true, stopped: true, endedAt: 30 }],
      ['native-running', { state: 'settled', failed: false }], ['timing-active', { state: 'running' }],
      ['timing-completed', { state: 'settled', failed: false }], ['timing-failed', { state: 'settled', failed: true }],
      ['summary-running', { state: 'running' }],
    ])
    expect([...context.children!.byPrompt!]).toEqual([['identical', context.children!.byId.get('completed')]])
    expect(context.children!.byId.has('unknown')).toBe(false)
  })

  it('uses the latest whole child response before native projection-store or summary snapshots', () => {
    const id = SessionId('child')
    const selected = facts({ subagentCatalog: [{ id }] })
    const snapshot = catalog([summary(id, { projectionValues: { subagentTiming: { settledMs: 1, lastTurnCompleted: true } } })])
    expect(remoteTranscriptContext(selected, { ref, snapshot })!.children!.byId.get(id)).toEqual({ state: 'settled', failed: false })
    const projected: typeof snapshot = { ...snapshot, projectionsBySession: { [id]: { values: { subagentTiming: { settledMs: 2, lastTurnCompleted: false } }, state: 'ready', error: null } } }
    expect(remoteTranscriptContext(selected, { ref, snapshot: projected })!.children!.byId.get(id)).toEqual({ state: 'settled', failed: true })
    expect(remoteTranscriptContext(selected, { ref, snapshot: projected, children: new Map([[id, {}]]) })!.children!.byId.size).toBe(0)
    expect(remoteTranscriptContext(facts({ subagentCatalog: [{ id: 'absent' }] }), { ref, snapshot })!.children!.byId.size).toBe(0)
  })
})
