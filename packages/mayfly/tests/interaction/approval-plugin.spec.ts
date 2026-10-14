/** Native approval decisions on the decision card: choices, notes, queue publication, and Agent lifetime.
 * @module @ephemeral-ai/mayfly/tests/interaction/approval-plugin
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setClipboardTextWriter } from '../../src/interaction/clipboard-write.ts'
import { setExternalEditorLauncher } from '../../src/interaction/external-editor.ts'
import { requestFixture, renderRequest, flushRequests } from './request-fixture.ts'
import type { MayflyDecisionRequest } from '../../src/core/types.ts'

const contexts: Context[] = []
afterEach(async () => {
  setClipboardTextWriter(undefined)
  setExternalEditorLauncher(undefined)
  vi.unstubAllEnvs()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})
async function setup() { const ctx = new Context(); contexts.push(ctx); return requestFixture(ctx) }

const note = { pagePath: [], formId: 'decision.note', fieldId: 'note' }
const options = { pagePath: [], controlId: 'decision.options' }

/** The roster each `mayfly/decision-requests-changed` publication carried, in order. */
function rosters(ctx: Context): Array<readonly MayflyDecisionRequest[]> {
  const seen: Array<readonly MayflyDecisionRequest[]> = []
  ctx.on('mayfly/decision-requests-changed', (source, requests) => { if (source === 'approval') seen.push(requests) })
  return seen
}

/** Open the card and return its model with a renderer; the caller disposes the renderer. */
function card(bench: Awaited<ReturnType<typeof setup>>, prefix = 'mayfly.approval.') {
  const model = bench.model(prefix)
  return { model, renderer: renderRequest(model) }
}

describe('approval decision card', () => {
  it('opens on the card with the choices numbered and the common grant first', async () => {
    const bench = await setup()
    const pending = bench.approve({ toolName: 'edit' })
    const entry = bench.ctx.mayflyOverlays.list().findLast(candidate => candidate.id.startsWith('mayfly.approval.'))!
    expect(entry.definition).toMatchObject({ presentation: 'editor', capturing: true, dismissal: 'discard', contentScroll: true, armMs: 300 })
    const { model, renderer } = card(bench)
    const frame = renderer.component.render(120).join('\n')
    expect(frame).toContain('Decide')
    expect(frame.indexOf('Allow once')).toBeLessThan(frame.indexOf('Allow edit for this session'))
    expect(frame.indexOf('Allow edit for this session')).toBeLessThan(frame.indexOf('Reject'))
    expect(frame).toContain('Feedback')
    expect(frame).toContain('open diff')
    expect(renderer.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'decision.options' })
    model.requestClose()
    await expect(pending).resolves.toBe('rejected')
    renderer.runtime.dispose()
  })

  it('chooses allow once with the digit 1 and leaves no session allowance behind', async () => {
    const bench = await setup()
    const first = bench.approve()
    const { renderer } = card(bench)
    renderer.input('1')
    await expect(first).resolves.toBe('allowed-once')
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
    const second = bench.approve()
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(1)
    card(bench).model.requestClose()
    await expect(second).resolves.toBe('rejected')
    renderer.runtime.dispose()
  })

  it('grants the tool for the session with the digit 2, so later requests of that tool settle without a card', async () => {
    const bench = await setup()
    const first = bench.approve()
    const { renderer } = card(bench)
    renderer.input('2')
    await expect(first).resolves.toBe('allowed-once')
    renderer.runtime.dispose()
    await expect(bench.approve()).resolves.toBe('allowed-once')
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
    const other = bench.approve({ toolName: 'write' })
    card(bench).model.requestClose()
    await expect(other).resolves.toBe('rejected')
  })

  it('rejects with the digit 3 and with Esc, and steers nothing without a note', async () => {
    const bench = await setup()
    const third = bench.approve()
    const digit = card(bench)
    digit.renderer.input('3')
    await expect(third).resolves.toBe('rejected')
    digit.renderer.runtime.dispose()

    const escaped = bench.approve()
    const esc = card(bench)
    esc.renderer.input('\x1b')
    await expect(escaped).resolves.toBe('rejected')
    esc.renderer.runtime.dispose()
    expect(bench.steer).not.toHaveBeenCalled()
  })

  it('rejects with the typed note as one steer message when Enter is pressed in the note', async () => {
    const bench = await setup()
    const pending = bench.approve()
    const { model, renderer } = card(bench)
    model.edit(note, '  too risky  ')
    model.invoke('send-note')
    await expect(pending).resolves.toBe('rejected')
    expect(bench.steer).toHaveBeenCalledOnce()
    expect(bench.steer.mock.calls[0]![0]).toMatchObject({ content: [{ type: 'text', text: 'User rejected bash: too risky' }], source: { kind: 'user' } })
    renderer.runtime.dispose()
  })

  it('keeps Enter in an empty note inert: nothing settles and nothing is steered', async () => {
    const bench = await setup()
    const pending = bench.approve()
    const { model, renderer } = card(bench)
    model.edit(note, '   ')
    model.invoke('send-note')
    await flushRequests()
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(1)
    expect(bench.steer).not.toHaveBeenCalled()
    model.requestClose()
    await expect(pending).resolves.toBe('rejected')
    renderer.runtime.dispose()
  })

  it('sends the note with the Reject choice, and it reads as a rejection', async () => {
    const bench = await setup()
    const pending = bench.approve({ toolName: 'write' })
    const { model, renderer } = card(bench)
    model.edit(note, 'use a new file')
    model.emit({ kind: 'selection-accept', ...options, pagePath: [], selectedIds: ['reject'] })
    await expect(pending).resolves.toBe('rejected')
    expect(bench.steer.mock.calls[0]![0]).toMatchObject({ content: [{ type: 'text', text: 'User rejected write: use a new file' }] })
    renderer.runtime.dispose()
  })

  it('does not carry a typed note onto an allow choice: the grant is recorded and nothing is steered (the code ignores the note on allow)', async () => {
    const bench = await setup()
    const pending = bench.approve()
    const { model, renderer } = card(bench)
    model.edit(note, 'looks fine')
    model.emit({ kind: 'selection-accept', ...options, pagePath: [], selectedIds: ['allow-once'] })
    await expect(pending).resolves.toBe('allowed-once')
    expect(bench.steer).not.toHaveBeenCalled()
    renderer.runtime.dispose()
  })

  it('reports the asker reason in the published roster in the language shown, not on the card', async () => {
    const bench = await setup()
    bench.ctx.mayflyLocale.setPreference('zh')
    const seen = rosters(bench.ctx)
    const pending = bench.approve({ reason: 'raw reason', displayReason: { en: 'Shown reason', zh: '中文理由' }, callId: 'call-1' as never })
    expect(seen.at(-1)).toEqual([{ type: 'approval', toolName: 'bash', callId: 'call-1', reason: '中文理由' }])
    const { model, renderer } = card(bench)
    expect(renderer.component.render(80).join('\n')).not.toContain('中文理由')
    model.requestClose()
    await expect(pending).resolves.toBe('rejected')
    renderer.runtime.dispose()
  })

  it('falls back to the en displayReason entry for unlisted locales and to the raw reason without one', async () => {
    const bench = await setup()
    bench.ctx.mayflyLocale.setPreference('zh')
    const seen = rosters(bench.ctx)
    const first = bench.approve({ displayReason: { en: 'Shown reason' } })
    expect(seen.at(-1)![0]!.reason).toBe('Shown reason')
    bench.model('mayfly.approval.').requestClose()
    await expect(first).resolves.toBe('rejected')
    const second = bench.approve({ reason: 'raw only' })
    expect(seen.at(-1)![0]!.reason).toBe('raw only')
    bench.model('mayfly.approval.').requestClose()
    await expect(second).resolves.toBe('rejected')
  })

  it('shows the en displayReason entry while the locale is not known yet', async () => {
    const bench = await setup()
    // The locale service may be absent when a request arrives; the roster then has no locale to pick an entry by.
    vi.spyOn(bench.ctx.mayflyLocale, 'snapshot', 'get').mockReturnValue({ locale: undefined as never, preference: undefined, revision: 0 })
    const seen = rosters(bench.ctx)
    const pending = bench.approve({ reason: 'raw reason', displayReason: { en: 'Shown reason', zh: '中文理由' } })
    expect(seen.at(-1)![0]!.reason).toBe('Shown reason')
    bench.model('mayfly.approval.').requestClose()
    await expect(pending).resolves.toBe('rejected')
  })

  it('keeps the queue in FIFO order, marks the count on the card, and withdraws a queued request', async () => {
    const bench = await setup()
    const seen = rosters(bench.ctx)
    const first = bench.approve({ callId: 'a' as never })
    const abort = new AbortController()
    const skipped = bench.approve({ toolName: 'write', callId: 'b' as never, signal: abort.signal })
    const last = bench.approve({ toolName: 'read', callId: 'c' as never })
    expect(seen.at(-1)!.map(request => request.callId)).toEqual(['a', 'b', 'c'])
    expect(JSON.stringify(bench.model('mayfly.approval.').node)).toContain('1 of 3 waiting')
    abort.abort()
    await expect(skipped).resolves.toBe('cancelled')
    expect(seen.at(-1)!.map(request => request.callId)).toEqual(['a', 'c'])
    bench.model('mayfly.approval.').emit({ kind: 'selection-accept', ...options, pagePath: [], selectedIds: ['allow-once'] })
    await expect(first).resolves.toBe('allowed-once')
    expect(JSON.stringify(bench.model('mayfly.approval.').node)).toContain('Allow read for this session')
    expect(JSON.stringify(bench.model('mayfly.approval.').node)).not.toContain('waiting')
    bench.model('mayfly.approval.').requestClose()
    await expect(last).resolves.toBe('rejected')
    expect(seen.at(-1)).toEqual([])
  })

  it('applies a session grant to already queued requests for the same tool', async () => {
    const bench = await setup()
    const first = bench.approve()
    const second = bench.approve()
    const { renderer } = card(bench)
    renderer.input('2')
    await expect(first).resolves.toBe('allowed-once')
    await expect(second).resolves.toBe('allowed-once')
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])
    renderer.runtime.dispose()
  })

  it.each(['selection', 'same-id', 'app-unload', 'frontend-unload'] as const)('retires active and queued work after %s and publishes an empty roster', async mode => {
    const bench = await setup()
    const seen = rosters(bench.ctx)
    const first = bench.approve()
    const old = bench.model('mayfly.approval.')
    const second = bench.approve({ toolName: 'write' })
    if (mode === 'selection') bench.ctx.mayflyConversations.selectPrimary(bench.other)
    else if (mode === 'same-id') {
      const replacement = { ...bench.agent } as Agent
      bench.agents.set(bench.agent.id, replacement)
      bench.ctx.mayflyConversations.selectPrimary(replacement)
    } else await (mode === 'app-unload' ? bench.app : bench.front).dispose()
    await expect(first).resolves.toBe('cancelled')
    await expect(second).resolves.toBe('cancelled')
    expect(seen.at(-1)).toEqual([])
    old.emit({ kind: 'selection-accept', ...options, pagePath: [], selectedIds: ['allow-once'] })
    expect(old.disposed).toBe(true)
    expect(bench.steer).not.toHaveBeenCalled()
  })

  it('delegates other Agents and keeps session allowances across view switches until the Agent is disposed', async () => {
    const bench = await setup()
    await expect(bench.approve({ agent: bench.other })).resolves.toBe('unavailable')
    const first = bench.approve()
    const { renderer } = card(bench)
    renderer.input('2')
    await first
    renderer.runtime.dispose()
    bench.ctx.mayflyConversations.selectPrimary(bench.other)
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    await expect(bench.approve()).resolves.toBe('allowed-once')
    bench.ctx.emit('agent/disposed', { agent: bench.agent as unknown as Agent })
    bench.ctx.mayflyConversations.selectPrimary(bench.agent)
    const second = bench.approve()
    card(bench).model.requestClose()
    await expect(second).resolves.toBe('rejected')
    bench.ctx.mayflyConversations.selectPrimary(null)
    await expect(bench.approve()).resolves.toBe('unavailable')
  })

  it('translates the card while the choice survives the locale change', async () => {
    const bench = await setup()
    bench.ctx.mayflyLocale.setPreference('en')
    const pending = bench.approve()
    const model = bench.model('mayfly.approval.')
    expect(JSON.stringify(model.node)).toContain('Allow once')
    bench.ctx.mayflyLocale.setPreference('zh')
    await flushRequests()
    expect(JSON.stringify(model.node)).toContain('仅允许一次')
    expect(JSON.stringify(model.node)).toContain('拒绝')
    model.requestClose()
    await expect(pending).resolves.toBe('rejected')
  })

  it('ignores unrelated direct events before a decision exists', async () => {
    const bench = await setup()
    const pending = bench.approve()
    const entry = bench.ctx.mayflyOverlays.list()[0]!
    const context = { surfaceId: entry.id, operationId: 'noop', source: entry.source, revision: entry.revision, signal: new AbortController().signal, report: vi.fn() }
    expect(await entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'noop', actionId: 'noop' }, context)).toEqual({ kind: 'completed' })
    bench.model('mayfly.approval.').requestClose()
    await expect(pending).resolves.toBe('rejected')
  })

  it('rechecks exact Agent authority when a queued request starts', async () => {
    const bench = await setup()
    let reads = 0
    let changeAt = Number.POSITIVE_INFINITY
    vi.spyOn(bench.ctx.mayflyCurrentAgent, 'current').mockImplementation(() => ++reads >= changeAt ? bench.other : bench.agent)
    const first = bench.approve()
    const queued = bench.approve({ toolName: 'write' })
    changeAt = reads + 4
    bench.model('mayfly.approval.').requestClose()
    await expect(first).resolves.toBe('rejected')
    await expect(queued).resolves.toBe('cancelled')
  })

  it('maps an accepted callback failure to unavailable', async () => {
    const bench = await setup()
    bench.agent.steer = vi.fn(() => { throw new Error('steer failed') }) as never
    const pending = bench.approve()
    const { model, renderer } = card(bench)
    model.edit(note, 'reason')
    model.invoke('send-note')
    await expect(pending).resolves.toBe('unavailable')
    renderer.runtime.dispose()
  })

  it('settles a request whose signal is already aborted as cancelled, without a card or a roster entry', async () => {
    const bench = await setup()
    const seen = rosters(bench.ctx)
    const abort = new AbortController()
    abort.abort()
    await expect(bench.approve({ signal: abort.signal })).resolves.toBe('cancelled')
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
    expect(seen).toEqual([])
  })

  it('cancels the open card when its request is aborted while the user is deciding', async () => {
    const bench = await setup()
    const abort = new AbortController()
    const pending = bench.approve({ signal: abort.signal })
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(1)
    abort.abort()
    await expect(pending).resolves.toBe('cancelled')
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
  })

  it('leaves events that are not an activation open, so nothing is granted or rejected', async () => {
    const bench = await setup()
    const pending = bench.approve()
    const entry = bench.ctx.mayflyOverlays.list()[0]!
    const context = { surfaceId: entry.id, operationId: 'noop', source: entry.source, revision: entry.revision, signal: new AbortController().signal, report: vi.fn() }
    expect(await entry.definition.onEvent!.action!({ kind: 'completion-dismiss', pagePath: [], controlId: 'decision.note' }, context)).toEqual({ kind: 'completed' })
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(1)
    bench.model('mayfly.approval.').requestClose()
    await expect(pending).resolves.toBe('rejected')
  })

  it('does not start a queued request when the displayed Agent changed behind the roster', async () => {
    const bench = await setup()
    let armed = false
    // The first card is answered while its Agent is displayed; once it closes, the displayed Agent is another one.
    vi.spyOn(bench.ctx.mayflyCurrentAgent, 'current').mockImplementation(() => armed && bench.ctx.mayflyOverlays.list().length === 0 ? bench.other : bench.agent)
    const first = bench.approve()
    const queued = bench.approve({ toolName: 'write' })
    armed = true
    bench.model('mayfly.approval.').requestClose()
    await expect(first).resolves.toBe('rejected')
    await expect(queued).resolves.toBe('cancelled')
    expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
  })

  describe('opening the request in the editor', () => {
    type Bench = Awaited<ReturnType<typeof setup>>
    const tools = (bench: Bench, calls: Array<{ callId: string, arguments: string }>) => {
      ;(bench.agent as unknown as { session: unknown }).session = {
        snapshotEvents: () => calls.map(call => ({ type: 'tool/call', data: { name: 'edit', ...call } })),
      }
    }
    const opened = (launcher: ReturnType<typeof vi.fn>) => vi.waitFor(() => expect(launcher).toHaveBeenCalledOnce())

    async function open(bench: Bench, extra: Parameters<Bench['approve']>[0] = {}) {
      vi.stubEnv('VISUAL', 'my-editor')
      const launcher = vi.fn(async (_text: string, _command: string): Promise<string | undefined> => undefined)
      setExternalEditorLauncher(launcher)
      const pending = bench.approve(extra)
      const { model, renderer } = card(bench)
      return { launcher, pending, model, renderer }
    }

    async function finish(opening: Awaited<ReturnType<typeof open>>) {
      opening.model.requestClose()
      await expect(opening.pending).resolves.toBe('rejected')
      opening.renderer.runtime.dispose()
    }

    it('opens the request with Ctrl+G and comes back to the card with the request still open', async () => {
      const bench = await setup()
      const opening = await open(bench, { reason: 'Runs a shell command' })
      opening.renderer.input('\x07')
      await opened(opening.launcher)
      expect(opening.launcher).toHaveBeenCalledWith('Runs a shell command', 'my-editor')
      expect(bench.screen.suspends).toBe(1)
      await flushRequests()
      expect(bench.ctx.mayflyOverlays.list()).toHaveLength(1)
      expect(bench.steer).not.toHaveBeenCalled()
      await finish(opening)
    })

    it('shows the tool name when the request has neither a call nor a reason', async () => {
      const bench = await setup()
      const opening = await open(bench, { toolName: 'bash' })
      opening.model.invoke('open')
      await opened(opening.launcher)
      expect(opening.launcher.mock.calls[0]![0]).toBe('bash')
      await finish(opening)
    })

    it.each([
      ['an edit as its path and both sides', { file_path: 'a.ts', old_string: 'one', new_string: 'two' }, 'a.ts\n\n--- old\none\n\n+++ new\ntwo\n'],
      ['an edit that only names the new side', { path: 'b.ts', new_string: 'two' }, 'b.ts\n\n--- old\n\n\n+++ new\ntwo\n'],
      ['an edit that only names the old side without a path', { old_string: 'one' }, '\n\n--- old\none\n\n+++ new\n\n'],
      ['a write as its path and content', { file_path: 'c.ts', content: 'body' }, 'c.ts\n\nbody\n'],
      ['a write without a path', { content: 'body' }, '\n\nbody\n'],
      ['a command as the command line', { command: 'pnpm test' }, 'pnpm test'],
      ['other arguments as indented JSON', { query: 'x' }, '{\n  "query": "x"\n}'],
    ])('reads %s from the recorded call', async (_name, args, expected) => {
      const bench = await setup()
      tools(bench, [{ callId: 'other', arguments: '{"command":"nope"}' }, { callId: 'call-1', arguments: JSON.stringify(args) }])
      const opening = await open(bench, { callId: 'call-1' as never })
      opening.model.invoke('open')
      await opened(opening.launcher)
      expect(opening.launcher.mock.calls[0]![0]).toBe(expected)
      await finish(opening)
    })

    it('opens the raw arguments when they are not JSON, and the reason when the call was not recorded', async () => {
      const bench = await setup()
      tools(bench, [{ callId: 'call-1', arguments: '{"command": "ls' }])
      const raw = await open(bench, { callId: 'call-1' as never, reason: 'ignored' })
      raw.model.invoke('open')
      await opened(raw.launcher)
      expect(raw.launcher.mock.calls[0]![0]).toBe('{"command": "ls')
      await finish(raw)

      tools(bench, [])
      const missing = await open(bench, { callId: 'call-2' as never, reason: 'Needs approval' })
      missing.model.invoke('open')
      await opened(missing.launcher)
      expect(missing.launcher.mock.calls[0]![0]).toBe('Needs approval')
      await finish(missing)
    })

    it('reports a missing editor and an editor that fails as notices, and keeps the card', async () => {
      const bench = await setup()
      vi.stubEnv('VISUAL', '')
      vi.stubEnv('EDITOR', '')
      const pending = bench.approve()
      const { model, renderer } = card(bench)
      model.invoke('open')
      await vi.waitFor(() => expect(model.feedbackSnapshot().at(-1)?.message).toBe('no editor configured ($VISUAL/$EDITOR)'))

      vi.stubEnv('EDITOR', 'nano')
      setExternalEditorLauncher(async () => { throw new Error('spawn failed') })
      model.invoke('open')
      await vi.waitFor(() => expect(model.feedbackSnapshot().at(-1)?.message).toBe('The editor could not be opened'))
      expect(model.disposed).toBe(false)
      expect(bench.ctx.mayflyOverlays.list()).toHaveLength(1)
      model.requestClose()
      await expect(pending).resolves.toBe('rejected')
      renderer.runtime.dispose()
    })
  })
})
