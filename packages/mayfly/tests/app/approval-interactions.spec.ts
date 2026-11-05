/** Native approval request facts, common decision keys, acknowledgements, and lifetime fencing. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { DecisionCard } from '../../src/components/decision-card.ts'
import { editLocalText } from '../../src/app/local/external-editor.ts'
import { approvalFixture, flushApproval } from './approval-feature-fixture.ts'

vi.mock('../../src/app/local/external-editor.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/app/local/external-editor.ts')>()
  return { ...original, editLocalText: vi.fn(async () => 'a local edit never writes the Host request') }
})
const fixtures: Awaited<ReturnType<typeof approvalFixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0).reverse()) await f.cleanup(); vi.unstubAllEnvs(); vi.clearAllMocks() })
async function fixture() { const value = await approvalFixture(); fixtures.push(value); return value }
const options = { pagePath: [], controlId: 'decision.options' } as const
const note = { pagePath: [], formId: 'decision.note', fieldId: 'note' } as const
function call(raw: string) { return [{ type: 'event', event: { type: 'tool/call', data: { callId: ToolCallId('call-1'), arguments: raw } } }] as unknown as readonly SessionEventLikeEntry[] }

// Settlement runs through the real UI model and its accepted-reply acknowledgement.
describe('Remote approval common card and native ownership', () => {
  it.each(['ParityProbe', 'edit'])('uses the exact common DecisionCard with the external %s key', async toolName => {
    const f = await fixture()
    const pending = f.request({ toolName })
    const change = toolName === 'edit'
    expect(f.model().node).toEqual(DecisionCard({ title: 'Decide', options: [
      { id: 'allow-once', label: 'Allow once' }, { id: 'allow-session', label: `Allow ${toolName} for this session` }, { id: 'reject', label: 'Reject' },
    ], note: { label: 'Feedback', placeholder: 'type to explain…' }, keys: [{ id: 'open', semantic: 'external', label: change ? 'Open diff' : 'Open command', hintLabel: change ? 'open diff' : 'open command' }] }))
    expect(f.waits).toEqual([{ kind: 'approval' }])
    f.model().requestClose()
    await expect(pending).resolves.toBe('rejected')
    expect(f.waits).toEqual([{ kind: 'approval' }, undefined])
    expect(f.rosters.at(-1)).toEqual([])
  })
  it('publishes FIFO native call identities and localized reasons, refreshing and clearing their queue', async () => {
    const f = await fixture()
    const first = f.request({ callId: ToolCallId('first'), reason: 'raw', displayReason: { en: 'Approve this exact call', zh: '批准这次调用' } })
    const abort = new AbortController()
    const second = f.request({ callId: ToolCallId('second'), reason: 'Second reason', signal: abort.signal })
    expect(f.rosters.at(-1)).toEqual([{ type: 'approval', callId: 'first', toolName: 'ParityProbe', reason: 'Approve this exact call' }, { type: 'approval', callId: 'second', toolName: 'ParityProbe', reason: 'Second reason' }])
    expect(JSON.stringify(f.model().node)).toContain('1 of 2 waiting')
    f.locale('zh')
    expect(f.rosters.at(-1)?.[0]?.reason).toBe('批准这次调用')
    abort.abort()
    await expect(second).resolves.toBe('cancelled')
    expect(f.rosters.at(-1)).toHaveLength(1)
    expect(JSON.stringify(f.model().node)).not.toContain('1 of 2 waiting')
    f.model().requestClose()
    await expect(first).resolves.toBe('rejected')
  })
  it.each(['allow-once', 'allow-session', 'reject'])('settles %s exactly once and only sends a rejection note', async choice => {
    const f = await fixture()
    const pending = f.request()
    const model = f.model()
    model.edit(note, '  use a safe path  ')
    model.emit({ kind: 'selection-accept', ...options, selectedIds: [choice] })
    await expect(pending).resolves.toBe(choice === 'reject' ? 'rejected' : 'allowed-once')
    expect(f.prompt).toHaveBeenCalledTimes(choice === 'reject' ? 1 : 0)
    if (choice === 'reject') expect(f.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'User rejected ParityProbe: use a safe path' }], 'steer')
    if (choice === 'allow-session') {
      await expect(f.request()).resolves.toBe('allowed-once')
      expect(f.ctx.mayflyOverlays.list()).toEqual([])
    }
    expect(f.next).not.toHaveBeenCalled()
  })
  it('keeps blank feedback open, then submits nonblank feedback as rejection', async () => {
    const f = await fixture()
    const pending = f.request()
    f.model().edit(note, '   ')
    f.model().invoke('send-note')
    await flushApproval()
    expect(f.ctx.mayflyOverlays.list()).toHaveLength(1)
    f.model().edit(note, 'unsafe')
    f.model().invoke('send-note')
    await expect(pending).resolves.toBe('rejected')
    expect(f.prompt).toHaveBeenCalledOnce()
  })
  it('promotes the next native request after an active abort without settling the other request', async () => {
    const f = await fixture()
    const abort = new AbortController()
    const first = f.request({ signal: abort.signal })
    const second = f.request({ toolName: 'write' })
    abort.abort()
    await expect(first).resolves.toBe('cancelled')
    expect(JSON.stringify(f.model().node)).toContain('Allow write for this session')
    f.model().requestClose()
    await expect(second).resolves.toBe('rejected')
    expect(f.rosters.at(-1)).toEqual([])
  })
  it('delegates duplicate calls and requests outside the exact selected native scope', async () => {
    const f = await fixture()
    const pending = f.request({ callId: ToolCallId('same-call') })
    await expect(f.request({ callId: ToolCallId('same-call') })).resolves.toBe('unavailable')
    f.scope(undefined)
    await expect(f.request()).resolves.toBe('unavailable')
    f.scope(SessionId('same-session'))
    await expect(f.request({ toolName: '  ' })).resolves.toBe('unavailable')
    expect(f.rosters.at(-1)).toHaveLength(1)
    f.model().requestClose()
    await pending
  })
  it('never opens or publishes an already aborted native request', async () => {
    const f = await fixture()
    const abort = new AbortController(); abort.abort()
    await expect(f.request({ signal: abort.signal })).resolves.toBe('cancelled')
    expect(f.rosters).toEqual([])
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
  })
  it.each(['detach', 'deselect', 'rebind', 'reconnect', 'switchHost', 'dispose'] as const)('delegates pending requests and fences old answers after %s', async reason => {
    const f = await fixture()
    const pending = f.request()
    const old = f.model()
    f[reason]()
    await expect(pending).resolves.toBe('unavailable')
    old.emit({ kind: 'selection-accept', ...options, selectedIds: ['allow-once'] })
    await flushApproval()
    expect(f.next).toHaveBeenCalledOnce()
    expect(f.prompt).not.toHaveBeenCalled()
    expect(f.rosters.at(-1)).toEqual([])
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
  })
  it.each([
    ['{"command":"printf safe"}', 'printf safe'],
    ['{"file_path":"a.ts","old_string":"before","new_string":"after"}', 'a.ts\n\n--- old\nbefore\n\n+++ new\nafter\n'],
    ['{"path":"a.ts","content":"next"}', 'a.ts\n\nnext\n'],
    ['{"value":3}', '{\n  "value": 3\n}'], ['{bad json', '{bad json'], ['null', 'null'], ['3', '3'], ['[]', '[]'],
    ['{"old_string":"before"}', '\n\n--- old\nbefore\n\n+++ new\n\n'],
    ['{"new_string":"after"}', '\n\n--- old\n\n\n+++ new\nafter\n'],
    ['{"content":"only content"}', '\n\nonly content\n'],
  ])('opens only the exact native call document %s and keeps the request pending', async (raw, expected) => {
    vi.stubEnv('VISUAL', 'fixture-editor')
    const f = await fixture(); f.setEvents(call(raw))
    const pending = f.request({ callId: ToolCallId('call-1') })
    f.model().invoke('open')
    await vi.waitFor(() => { expect(editLocalText).toHaveBeenCalledWith(expected, 'fixture-editor', expect.any(AbortSignal)) })
    expect(f.screen.suspend).toHaveBeenCalledOnce()
    expect(f.ctx.mayflyOverlays.list()).toHaveLength(1)
    f.model().requestClose(); await expect(pending).resolves.toBe('rejected')
    expect(f.prompt).not.toHaveBeenCalled()
  })
  it('opens the native reason fallback when the current event window has no matching call', async () => {
    vi.stubEnv('VISUAL', 'fixture-editor')
    const f = await fixture()
    const pending = f.request({ reason: 'The actual request reason' })
    f.model().invoke('open')
    await vi.waitFor(() => { expect(editLocalText).toHaveBeenCalledWith('The actual request reason', 'fixture-editor', expect.any(AbortSignal)) })
    f.model().requestClose(); await pending
  })
  it('reports a missing editor without approving or dismissing the native request', async () => {
    vi.stubEnv('VISUAL', ''); vi.stubEnv('EDITOR', '')
    const f = await fixture(); const pending = f.request()
    f.model().invoke('open'); await flushApproval()
    expect(editLocalText).not.toHaveBeenCalled()
    expect(JSON.stringify(f.model().feedbackSnapshot())).toContain('no editor configured')
    f.model().requestClose(); await pending
  })
  it('applies a new session allowance to already queued requests of the same tool', async () => {
    const f = await fixture()
    const first = f.request()
    const second = f.request()
    f.model().emit({ kind: 'selection-accept', ...options, selectedIds: ['allow-session'] })
    await expect(first).resolves.toBe('allowed-once')
    await expect(second).resolves.toBe('allowed-once')
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    const other = f.request({ toolName: 'write' })
    f.model().emit({ kind: 'selection-accept', ...options, selectedIds: ['allow-session'] })
    await expect(other).resolves.toBe('allowed-once')
    f.selectSession(SessionId('another-session'))
    const next = f.request()
    expect(f.ctx.mayflyOverlays.list()).toHaveLength(1)
    f.model().requestClose(); await expect(next).resolves.toBe('rejected')
  })
  it('passes an off-selection native request to the next waterfall listener', async () => {
    const f = await fixture(); f.scope(SessionId('another-session'))
    await expect(f.request()).resolves.toBe('unavailable')
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    expect(f.rosters).toEqual([])
  })
  it('keeps an unchanged topology and connection snapshot from retiring a pending native request', async () => {
    const f = await fixture(); const pending = f.request()
    const model = f.model()
    f.notify(); for (const listener of f.stateListeners) listener()
    expect(f.model()).toBe(model)
    expect(f.next).not.toHaveBeenCalled()
    f.model().requestClose(); await pending
  })
  it('rejects a refusal without a note and delegates callbacks queued after local controller unload', async () => {
    const f = await fixture(); const pending = f.request()
    f.model().emit({ kind: 'selection-accept', ...options, selectedIds: ['reject'] })
    await expect(pending).resolves.toBe('rejected')
    const queuedTopology = [...f.topologyListeners]
    f.dispose(); for (const callback of queuedTopology) callback()
    await expect(f.request()).resolves.toBe('unavailable')
    expect(f.prompt).not.toHaveBeenCalled()
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
  })
  it('rechecks the selected native scope before starting an already queued request', async () => {
    const f = await fixture(); const abort = new AbortController()
    const first = f.request({ signal: abort.signal }); const second = f.request()
    vi.spyOn(f.options.hosts, 'current').mockReturnValue(undefined)
    abort.abort()
    await expect(first).resolves.toBe('cancelled')
    await expect(second).resolves.toBe('unavailable')
    expect(f.next).toHaveBeenCalledOnce()
    expect(f.rosters.at(-1)).toEqual([])
  })
  it('lets the request overlay delegate an interaction that discovers a stale native selection', async () => {
    const f = await fixture(); const pending = f.request(); const model = f.model()
    vi.spyOn(f.options.hosts, 'current').mockReturnValue(undefined)
    model.invoke('open')
    await expect(pending).resolves.toBe('unavailable')
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    expect(editLocalText).not.toHaveBeenCalled()
  })
  it('settles unavailable when the shared card cannot be constructed', async () => {
    const f = await fixture()
    vi.spyOn(f.options, 't').mockImplementation(key => { if (key === 'Decide') throw new Error('locale unavailable'); return key })
    await expect(f.request()).resolves.toBe('unavailable')
    expect(f.rosters.at(-1)).toEqual([])
  })
  it('settles once when a native abort races a rejected overlay construction', async () => {
    const f = await fixture(); const abort = new AbortController()
    vi.spyOn(f.options, 't').mockImplementation(key => { if (key === 'Decide') throw new Error('locale unavailable'); return key })
    const pending = f.request({ signal: abort.signal }); abort.abort()
    await expect(pending).resolves.toBe('cancelled'); await flushApproval()
    expect(f.next).not.toHaveBeenCalled()
    expect(f.rosters.at(-1)).toEqual([])
  })
  it('falls back cleanly through a frontend locale/settings provider gap', async () => {
    vi.stubEnv('VISUAL', 'fixture-editor')
    const f = await fixture(); await f.stopFrontend()
    const abort = new AbortController()
    const pending = f.request({ signal: abort.signal, displayReason: { en: 'Native fallback after frontend unload' } })
    expect(f.rosters.at(-1)?.[0]?.reason).toBe('Native fallback after frontend unload')
    const entry = f.ctx.mayflyOverlays.list()[0]!
    const prepared = await entry.events.prepare({ kind: 'activate', actionId: 'open', controlId: 'decision.keys', pagePath: [] }, {
      surfaceId: entry.id, revision: entry.revision, source: entry.source, operationId: 'provider-gap', signal: abort.signal, report: vi.fn(),
    })
    prepared.publish()
    expect(editLocalText).toHaveBeenCalledWith('ParityProbe', 'fixture-editor', expect.any(AbortSignal))
    abort.abort(); await expect(pending).resolves.toBe('cancelled')
  })
  it('propagates an actual waterfall fallback rejection during local detach', async () => {
    const f = await fixture()
    const failure = new Error('native listener unavailable')
    const pending = f.request({}, vi.fn(() => { throw failure }))
    f.detach()
    await expect(pending).rejects.toBe(failure)
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    expect(f.rosters.at(-1)).toEqual([])
  })
  it('falls back to the request tool name while ignoring unrelated native event-window entries', async () => {
    vi.stubEnv('VISUAL', 'fixture-editor')
    const f = await fixture()
    f.setEvents([{ type: 'assistant-settlement' }, { type: 'event', event: { type: 'user/message', data: {} } }, { type: 'event', event: { type: 'tool/call', data: { callId: 'other-call', arguments: '{"command":"wrong"}' } } }] as unknown as readonly SessionEventLikeEntry[])
    const pending = f.request({ callId: ToolCallId('missing-call') })
    f.model().invoke('open')
    await vi.waitFor(() => { expect(editLocalText).toHaveBeenCalledWith('ParityProbe', 'fixture-editor', expect.any(AbortSignal)) })
    f.model().requestClose(); await pending
  })
  it('uses the English display reason when the native request has no current-locale translation', async () => {
    const f = await fixture(); f.locale('zh')
    const pending = f.request({ displayReason: { en: 'Native English fallback' } })
    expect(f.rosters.at(-1)?.[0]?.reason).toBe('Native English fallback')
    f.model().requestClose(); await pending
  })
  it('reports local editor failure and leaves the native request undecided', async () => {
    vi.stubEnv('VISUAL', 'fixture-editor'); vi.mocked(editLocalText).mockRejectedValueOnce(new Error('editor failed'))
    const f = await fixture(); const pending = f.request()
    f.model().invoke('open'); await flushApproval()
    expect(JSON.stringify(f.model().feedbackSnapshot())).toContain('The editor could not be opened')
    f.model().requestClose(); await expect(pending).resolves.toBe('rejected')
  })
  it('ignores a late local editor failure after the exact native binding was replaced', async () => {
    vi.stubEnv('VISUAL', 'fixture-editor')
    const done = Promise.withResolvers<string | undefined>(); vi.mocked(editLocalText).mockReturnValueOnce(done.promise)
    const f = await fixture(); const pending = f.request()
    f.model().invoke('open'); await vi.waitFor(() => { expect(editLocalText).toHaveBeenCalledOnce() })
    f.rebind(); await expect(pending).resolves.toBe('unavailable')
    done.reject(new Error('late failure')); await flushApproval()
    expect(f.options.notice.set).not.toHaveBeenCalled()
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
  })
  it('does not begin local editor work when a deferred terminal suspension resumes after detach', async () => {
    vi.stubEnv('VISUAL', 'fixture-editor')
    const f = await fixture(); const done = Promise.withResolvers<void>()
    f.screen.suspend.mockImplementationOnce(async run => { await done.promise; return await run() })
    const pending = f.request(); f.model().invoke('open')
    await vi.waitFor(() => { expect(f.screen.suspend).toHaveBeenCalledOnce() })
    f.detach(); await pending
    done.resolve(); await flushApproval()
    expect(editLocalText).not.toHaveBeenCalled()
  })
  it.each([new Error('steer transport failed'), 'steer failed'])('reports a failed native rejection steer %s under its original selection', async error => {
    const f = await fixture(); f.prompt.mockRejectedValueOnce(error)
    const pending = f.request(); f.model().edit(note, 'unsafe'); f.model().invoke('send-note')
    await expect(pending).resolves.toBe('rejected'); await flushApproval()
    expect(f.options.notice.set).toHaveBeenCalledWith(error instanceof Error ? error.message : error)
  })
  it('presents a failed native steer result and ignores its late failure after selection replacement', async () => {
    const f = await fixture()
    f.prompt.mockResolvedValueOnce({ ok: false, error: { message: 'Native steer unavailable' } } as never)
    const first = f.request(); f.model().edit(note, 'unsafe'); f.model().invoke('send-note')
    await first; await flushApproval()
    expect(f.options.notice.set).toHaveBeenCalledWith('Native steer unavailable')
    vi.mocked(f.options.notice.set).mockClear()
    const done = Promise.withResolvers<Awaited<ReturnType<typeof f.prompt>>>()
    f.prompt.mockReturnValueOnce(done.promise)
    const second = f.request(); f.model().edit(note, 'unsafe'); f.model().invoke('send-note')
    await second; f.deselect()
    done.reject('late native failure'); await flushApproval()
    expect(f.options.notice.set).not.toHaveBeenCalled()
  })
  it('ignores late editor success after native abort and releases the card', async () => {
    vi.stubEnv('VISUAL', 'fixture-editor')
    const done = Promise.withResolvers<string | undefined>()
    vi.mocked(editLocalText).mockReturnValueOnce(done.promise)
    const f = await fixture(); const abort = new AbortController(); const pending = f.request({ signal: abort.signal })
    f.model().invoke('open')
    await vi.waitFor(() => { expect(editLocalText).toHaveBeenCalledOnce() })
    const signal = vi.mocked(editLocalText).mock.calls[0]![2]
    abort.abort(); await expect(pending).resolves.toBe('cancelled')
    expect(signal.aborted).toBe(true)
    done.resolve('late'); await flushApproval()
    expect(f.rosters.at(-1)).toEqual([])
    expect(f.ctx.mayflyOverlays.list()).toEqual([])
    expect(f.prompt).not.toHaveBeenCalled()
  })
})
