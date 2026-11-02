/** Descendant browsing, exact native drains, cold leases and acknowledged child prompts. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { MayflyFieldValue, MayflySubmittedField, MayflyUiActionEvent, MayflyUiEventContext } from '@ephemeral-ai/mayfly-ui'
import { visibleWidth } from '@ephemeral-ai/mayfly/core'
import { mountRemoteAgentsOperations } from '../../src/remote/operations/agents.ts'
import { RemotePresentSlot, type RemoteOperationsContext } from '../../src/remote/operations/support.ts'
import { remoteAgentsPanel, type RemoteAgentRow } from '../../src/remote/panels/operations/agents.ts'
import type { RemoteBrowserOptions } from '../../src/remote/panels/browser.ts'
import { requestOverlay } from '../../src/remote/interactions/request-overlay.ts'
import { taskFixture, tick, translate, activated, good, bad } from './task-feature-fixture.ts'

const native = vi.hoisted(() => ({ browser: vi.fn(), editor: vi.fn() }))
vi.mock('../../src/remote/panels/browser.ts', () => ({ openRemoteBrowser: native.browser }))
vi.mock('../../src/remote/interactions/request-overlay.ts', () => ({ requestOverlay: native.editor }))
type Answer = { readonly text: string, readonly delivery: 'queue' | 'steer' }
type EditorOptions = Parameters<typeof requestOverlay<Answer | undefined>>[1]
const eventContext = (): MayflyUiEventContext => ({ surfaceId: 'agents', source: [], signal: new AbortController().signal, revision: 1, operationId: 'action', report: vi.fn() })
const choose = (id?: string, controlId = 'agents-list'): MayflyUiActionEvent => ({ kind: 'selection-accept', controlId, selectedIds: id === undefined ? [] : [id], pagePath: [] })
const send = (text: MayflyFieldValue = ' Follow up ', delivery: MayflyFieldValue = 'queue'): MayflyUiActionEvent => {
  const fields: MayflySubmittedField[] = [{ id: 'message', change: 'set', value: text }, { id: 'delivery', change: 'set', value: delivery }]
  return { ...activated('send'), inputs: { actionId: 'send', draftRevision: 1, source: [], forms: [{ formId: 'agents-prompt', pagePath: [], draftRevision: 1, fields }] } }
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop(); vi.restoreAllMocks(); native.browser.mockReset(); native.editor.mockReset() })

async function fixture(selected = true) {
  const f = await taskFixture(selected)
  const ids = ['session', 'child', 'grandchild', 'cold', 'address-only', 'missing-address', 'unrelated'].map(SessionId)
  const byId: Record<string, { parentId?: string, displayTitle?: string, running?: boolean, cwd?: string }> = {
    session: { parentId: 'grandchild' }, child: { parentId: 'session', displayTitle: 'Build worker', running: true, cwd: '/work/child' }, grandchild: { parentId: 'child', displayTitle: 'Nested worker' }, cold: { parentId: 'session', displayTitle: 'Cold reader', running: false }, 'missing-address': { parentId: 'session' }, unrelated: { parentId: 'other' },
  }
  const address = (id: string, parent = 'session', mode: SubagentAddress['mode'] = 'continuable'): SubagentAddress => ({ parentSessionId: SessionId(parent), childSessionId: SessionId(id), mode })
  const addresses = new Map<string, SubagentAddress>([['child', address('child')], ['grandchild', address('grandchild', 'child')], ['cold', address('cold', 'session', 'one-shot')], ['address-only', address('address-only', 'session', 'unknown')]])
  const sessions = { list: { getSnapshot: vi.fn(() => ({ ids, byId })) }, subagentAddress: vi.fn((id: string) => addresses.get(id)) }
  const drain = vi.fn(async (..._args: unknown[]) => good(undefined))
  Object.assign(f.client, { sessions }); Object.assign(f.client.remote, { mayflyHost: { subagentDrain: drain } })
  const present = vi.fn(), closePresent = vi.fn(), release = vi.fn()
  const ready = Promise.resolve({ sessionId: SessionId('child') })
  const retain = vi.fn((..._args: unknown[]) => ({ ready, release }))
  const prompt = vi.fn(async (..._args: unknown[]) => {})
  const options = { localCwd: '/work', present, closePresent, btw: { retainColdSubagentView: retain, promptSubagent: prompt } } as unknown as RemoteOperationsContext['options']
  const presentSlot = new RemotePresentSlot(options)
  const context: RemoteOperationsContext = { base: f.options, options, presentSlot }
  const panels: Array<{ options: RemoteBrowserOptions, refresh: ReturnType<typeof vi.fn<() => void>>, close: ReturnType<typeof vi.fn<() => void>> }> = []
  const editors: Array<{ options: EditorOptions, resolve: (answer: Answer | undefined) => void, reject: (error: unknown) => void, cancel: ReturnType<typeof vi.fn<() => void>> }> = []
  native.browser.mockImplementation((_base, options: RemoteBrowserOptions) => { let closed = false; const result = { options, refresh: vi.fn(), close: vi.fn(() => { if (closed) return; closed = true; options.onClosed?.() }), get closed() { return closed } }; panels.push(result); return result })
  native.editor.mockImplementation((_ctx, options: EditorOptions) => { const result = Promise.withResolvers<Answer | undefined>(); const cancel = vi.fn(() => result.resolve(undefined)); editors.push({ options, resolve: result.resolve, reject: result.reject, cancel }); return { result: result.promise, cancel, refresh: vi.fn(), reveal: vi.fn() } })
  const stop = mountRemoteAgentsOperations(context)
  cleanups.push(async () => { stop(); presentSlot.dispose(); await f.dispose() })
  const act = async (event: MayflyUiActionEvent) => await panels.at(-1)!.options.action!(event, eventContext())
  const select = async (id?: string, control?: string) => await act(choose(id, control))
  const open = async (filter = '') => { await f.run('agents', filter); return panels.at(-1)! }
  const text = () => JSON.stringify(panels.at(-1)!.options.view())
  return { ...f, selectSession: f.select, context, sessions, byId, ids, addresses, address, drain, present, closePresent, retain, release, prompt, panels, editors, stop, act, select, open, text }
}

async function promptEditor(f: Awaited<ReturnType<typeof fixture>>) {
  await f.select('child'); expect(await f.act(activated('agents-prompt'))).toEqual({ kind: 'completed' })
  const editor = f.editors.at(-1)!; expect(editor.options.isCurrent()).toBe(true)
  expect(JSON.stringify(editor.options.view())).toContain('Delivery')
  return editor
}

describe('native descendant tree command', () => {
  it('traverses durable summaries and exact addresses without cycles and uses responsive panels', async () => {
    const f = await fixture(false)
    await f.open(); expect(f.options.notice.set).toHaveBeenCalledWith('No current session'); expect(f.panels).toEqual([])
    f.selectSession(true); await f.open()
    f.silentlyDeselect(); await f.act(activated('agents-refresh'))
    expect(f.text()).toContain('No current session')
    expect(await f.act(activated('agents-open'))).toMatchObject({ kind: 'failed' })
  })

  it('filters and selects descendants, refreshes disappearing rows, and closes only its browser', async () => {
    const f = await fixture(); const panel = await f.open()
    expect(panel.options.isCurrent()).toBe(true)
    expect(f.text()).toContain('Build worker'); expect(f.text()).toContain('Nested worker'); expect(f.text()).toContain('address-only'); expect(f.text()).not.toContain('unrelated')
    panel.options.observe!({ kind: 'tab-change', controlId: 'unrelated', tabId: 'x', pagePath: [] })
    expect(await f.act(choose('child', 'other-list'))).toEqual({ kind: 'completed' })
    expect(await f.act({ kind: 'dismiss', pagePath: [] })).toEqual({ kind: 'completed' })
    expect(await f.act(activated('agents-open'))).toMatchObject({ kind: 'failed' })
    await f.select('child', 'agents-list-narrow'); expect(f.text()).toContain('Stop this subagent?')
    expect(await f.act(activated('unknown'))).toEqual({ kind: 'completed' })
    await f.open('GRANDCHILD'); expect(f.text()).toContain('Nested worker')
    await f.open(); await f.select('child')
    delete f.byId.child; f.addresses.delete('child')
    await f.act(activated('agents-refresh')); expect(f.text()).not.toContain('Build worker')
    await f.select('missing'); await f.select()
    await f.open('cold'); expect(f.text()).toContain('Cold reader'); expect(f.text()).not.toContain('Nested worker')
    await f.run('agents', 'close'); expect(f.panels.at(-1)!.close).toHaveBeenCalled()
    f.stop(); f.stop(); expect(await f.run('agents')).toBe(false)
  })
})

describe('exact native descendant controls', () => {
  it('drains only a running continuable child through its exact parent and keeps stopping state on refresh', async () => {
    const f = await fixture(); await f.open()
    for (const id of ['cold', 'missing-address', 'grandchild']) { await f.select(id); expect(await f.act(activated('agents-stop'))).toMatchObject({ kind: 'failed' }) }
    await f.select('child')
    f.addresses.set('child', f.address('child', 'other')); expect(await f.act(activated('agents-stop'))).toMatchObject({ kind: 'failed' })
    f.addresses.set('child', f.address('child'))
    expect(await f.act(activated('agents-stop'))).toEqual({ kind: 'completed' })
    expect(f.drain).toHaveBeenCalledWith({ parentSessionId: 'session', childSessionId: 'child' }, expect.any(AbortSignal))
    expect(f.text()).toContain('stopping'); await f.act(activated('agents-refresh')); expect(f.text()).toContain('stopping')
    f.drain.mockResolvedValueOnce(bad('drain refused') as never)
    expect(await f.act(activated('agents-stop'))).toEqual({ kind: 'failed', message: 'drain refused' })
    f.drain.mockRejectedValueOnce(new Error('drain failed'))
    expect(await f.act(activated('agents-stop'))).toEqual({ kind: 'failed', message: 'drain failed' })
  })

  it('retires pending drain success and errors across reconnect and unload', async () => {
    const f = await fixture(); await f.open(); await f.select('child')
    for (const reject of [false, true]) {
      await f.open(); await f.select('child')
      const pending = Promise.withResolvers<ReturnType<typeof good<undefined>>>()
      f.drain.mockReturnValueOnce(pending.promise); const result = f.act(activated('agents-stop'))
      f.reconnect()
      if (reject) pending.reject('old drain failure'); else pending.resolve(good(undefined))
      expect(await result).toEqual({ kind: 'cancelled' })
    }
    expect(f.options.notice.set).not.toHaveBeenCalledWith('Drain requested; the child counts as stopped once it settles')
  })

  it('opens retained cold views with native mode and cwd and releases their leases on unload', async () => {
    const f = await fixture(); await f.open()
    for (const [id, access] of [['child', 'resumable'], ['cold', 'readonly'], ['missing-address', 'readonly']] as const) {
      await f.select(id); expect(await f.act(activated('agents-open'))).toEqual({ kind: 'completed' })
      expect(f.present).toHaveBeenLastCalledWith({ host: f.client.key, sessionId: id }, expect.anything(), expect.objectContaining({ kind: 'subagent', access }))
    }
    expect(f.retain).toHaveBeenCalledWith({ host: f.client.key, sessionId: 'session' }, { host: f.client.key, sessionId: 'child' }, 'remote-agents-cold')
    expect(f.present.mock.calls[0]![2]).toMatchObject({ label: 'Build worker', cwd: '/work/child', address: { mode: 'continuable' } })
    f.retain.mockImplementationOnce(() => { throw new Error('cannot retain') })
    expect(await f.act(activated('agents-open'))).toEqual({ kind: 'failed', message: 'cannot retain' })
    for (const reject of [false, true]) {
      await f.open(); await f.select('child')
      const pending = Promise.withResolvers<unknown>()
      f.retain.mockReturnValueOnce({ ready: pending.promise, release: vi.fn() } as never)
      const result = f.act(activated('agents-open')); f.reconnect()
      if (reject) pending.reject(new Error('late lease failure')); else pending.resolve({})
      expect(await result).toEqual({ kind: 'cancelled' })
    }
    f.context.presentSlot.dispose(); expect(f.release).toHaveBeenCalledTimes(3)
  })
})

describe('acknowledged descendant prompts', () => {
  it('validates form values and queues or steers only an acknowledged direct-child message', async () => {
    const f = await fixture(); await f.open()
    for (const id of ['cold', 'missing-address']) { await f.select(id); await f.act(activated('agents-prompt')); expect(f.options.notice.set).toHaveBeenCalledWith('The subagent must be a continuable direct child') }
    await f.select('child'); f.addresses.set('child', f.address('child', 'other')); await f.act(activated('agents-prompt')); f.addresses.set('child', f.address('child'))
    const editor = await promptEditor(f)
    const invalid = [activated('other'), { kind: 'dismiss', pagePath: [] }, activated('send'), send(''), send('  '), send(1)]
    for (const event of invalid) expect(editor.options.answer(event as MayflyUiActionEvent)).toBeUndefined()
    const empty = send() as Extract<MayflyUiActionEvent, { kind: 'activate' }>
    expect(editor.options.answer({ ...empty, inputs: { ...empty.inputs!, forms: [] } })).toBeUndefined()
    expect(editor.options.answer({ ...empty, inputs: { ...empty.inputs!, forms: [{ ...empty.inputs!.forms[0]!, fields: [] }] } })).toBeUndefined()
    expect(editor.options.answer(send())).toEqual({ text: 'Follow up', delivery: 'queue' })
    expect(editor.options.answer(send(' hi ', 'steer'))).toEqual({ text: 'hi', delivery: 'steer' })
    expect(editor.options.cancelled('dismiss')).toBeUndefined()
    editor.resolve({ text: 'Continue task', delivery: 'queue' }); await tick()
    expect(f.prompt).toHaveBeenCalledWith({ host: f.client.key, sessionId: 'session' }, { host: f.client.key, sessionId: 'child' }, { content: [{ type: 'text', text: 'Continue task' }], delivery: 'queue', signal: expect.any(AbortSignal) })
    expect(f.options.notice.set).toHaveBeenCalledWith('Message queued for the subagent')
    const next = await promptEditor(f); next.resolve({ text: 'Correct course', delivery: 'steer' }); await tick()
    expect(f.options.notice.set).toHaveBeenCalledWith('Message steered into the subagent step')
    for (const width of [1, 8, 20, 40, 80, 120]) expect(f.render(editor.options.view(), width).every(row => visibleWidth(row) <= width)).toBe(true)
  })

  it('fences selected row and generation before sending and suppresses late delivery results', async () => {
    const f = await fixture(); await f.open()
    let editor = await promptEditor(f); await f.select('cold'); expect(editor.options.isCurrent()).toBe(false)
    editor.resolve({ text: 'No send', delivery: 'queue' }); await tick(); expect(f.prompt).not.toHaveBeenCalled()
    editor = await promptEditor(f); await f.select(); expect(editor.options.isCurrent()).toBe(false); editor.resolve(undefined); await tick()
    editor = await promptEditor(f); f.silentlyDeselect(); expect(editor.options.isCurrent()).toBe(false); editor.resolve(undefined); await tick()
    f.selectSession(true); await f.open(); editor = await promptEditor(f)
    editor.cancel.mockImplementationOnce(() => {})
    f.reconnect(); expect(editor.options.isCurrent()).toBe(false)
    editor.resolve({ text: 'Stale generation', delivery: 'queue' }); await tick()
    expect(f.prompt).not.toHaveBeenCalled()
  })

  it('reports current failures and retires late prompt errors and completions', async () => {
    const f = await fixture(); await f.open()
    let editor = await promptEditor(f); f.prompt.mockRejectedValueOnce(new Error('prompt failed')); editor.resolve({ text: 'Try', delivery: 'queue' }); await tick()
    expect(f.options.notice.set).toHaveBeenCalledWith('prompt failed')
    editor = await promptEditor(f); editor.reject('overlay cancelled'); await tick()
    for (const reject of [false, true]) {
      await f.open(); editor = await promptEditor(f)
      const pending = Promise.withResolvers<void>(); f.prompt.mockReturnValueOnce(pending.promise)
      editor.resolve({ text: 'Late prompt', delivery: 'queue' }); await tick(); f.reconnect()
      if (reject) pending.reject('old prompt failure'); else pending.resolve()
      await tick()
    }
    expect(f.options.notice.set).not.toHaveBeenCalledWith('old prompt failure')
    expect(f.options.notice.set).not.toHaveBeenCalledWith('Message queued for the subagent')
  })
})

describe('descendant responsive presentation', () => {
  it('renders all modes, live/idle/stopping rows and missing selections within width', async () => {
    const f = await fixture()
    const base: RemoteAgentRow = { id: SessionId('child'), parent: SessionId('session'), depth: 2, label: 'Worker 你好 '.repeat(20), mode: 'continuable', running: true, stopping: false }
    const rows = [base, { ...base, id: SessionId('cold'), mode: 'one-shot' as const, running: false }, { ...base, id: SessionId('unknown'), mode: 'unknown' as const }, { ...base, id: SessionId('stopping'), stopping: true }]
    for (const selectedId of [undefined, ...rows.map(row => row.id), SessionId('missing')]) for (const error of [undefined, 'native error']) {
      const node = remoteAgentsPanel({ rows, selectedId, error }, translate)
      for (const width of [1, 8, 20, 40, 80, 120]) expect(f.render(node, width).every(row => visibleWidth(row) <= width)).toBe(true)
    }
  })
})
