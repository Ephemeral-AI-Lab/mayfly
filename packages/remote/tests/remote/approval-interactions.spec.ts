/** Native approval request facts, common decision keys, acknowledgements, and lifetime fencing. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { DecisionCard } from '@ephemeral-ai/mayfly/editor-presentation'
import { editLocalText } from '../../src/remote/local/external-editor.ts'
import { approvalFixture, flushApproval } from './approval-feature-fixture.ts'

vi.mock('../../src/remote/local/external-editor.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/remote/local/external-editor.ts')>()
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
    ['{"value":3}', '{\n  "value": 3\n}'], ['{bad json', '{bad json'], ['null', 'null'],
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
