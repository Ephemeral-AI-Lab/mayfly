/** Exact native editor adapters and mount-owned selection/connection lifetimes. @module */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { EditorFeatureOptions, EditorLocalCommandInvocation } from '../../src/remote/editor/types.ts'
import type { RemoteFeatureSelection } from '../../src/remote/features/contracts.ts'
import type { HostClient } from '../../src/client/types.ts'
import { HostKey } from '../../src/client/types.ts'

const captured = vi.hoisted(() => ({
  options: undefined as EditorFeatureOptions | undefined,
  controller: { selectionChanged: vi.fn(), hostReconnected: vi.fn(), dispose: vi.fn(), openSkills: vi.fn(async () => {}) },
}))
vi.mock('../../src/remote/editor/index.ts', () => ({ attachEditorFeatures: vi.fn((options: EditorFeatureOptions) => { captured.options = options; return captured.controller }) }))
import { mountEditorComposition } from '../../src/remote/editor-composition.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop() })
beforeEach(() => { vi.clearAllMocks() })
async function fixture(injected = false, contributed = false) {
  const ctx = new Context()
  const topology = new Set<() => void>(), side = new Set<() => void>(), states = new Set<() => void>()
  let generation = 1
  const native = { stat: vi.fn(async () => ({ ok: true, value: {} })), readBytes: vi.fn(async () => ({ ok: true, value: {} })) }
  const upload = vi.fn(async () => ({ ok: true, value: {} }))
  const client = {
    key: HostKey('exact-host'), remote: { workspaceFiles: native }, fileUpload: { upload },
    state: { getSnapshot: () => ({ generation }), subscribe: (listener: () => void) => { states.add(listener); return () => states.delete(listener) } },
  } as unknown as HostClient
  const ref = { host: client.key, sessionId: SessionId('native-session') }
  const session = { openWorkspacePath: vi.fn(async () => ({ ok: true, value: { opened: true } })) }
  const binding = { session } as unknown as RemoteFeatureSelection['binding']
  let currentRef: typeof ref | undefined = ref
  let reference: { binding: typeof binding } | undefined = { binding }
  let attached = [client], available = client as HostClient | undefined
  let selection: (RemoteFeatureSelection & { access: 'interactive' | 'resumable' | 'readonly' }) | undefined = { client, ref, binding, access: 'readonly' }
  const app = {
    registry: { get current() { return currentRef }, get currentReference() { return reference }, get: () => available, list: () => attached },
    subscribeTopology: (listener: () => void) => { topology.add(listener); return () => topology.delete(listener) },
    execute: vi.fn(async () => ({ exit: true })), ensureSession: vi.fn(async () => {}), preparePrompt: vi.fn(async () => {}),
  }
  const commands = { list: vi.fn(() => [{ name: 'local-fixture', description: 'Feature fixture', scope: 'sessionless' as const, execute() {} }]), execute: vi.fn(async () => true) }
  const focusEditor = vi.fn(), startupKey = vi.fn(() => false), exit = vi.fn()
  const handle = mountEditorComposition({ ctx, app: app as never, editor: {} as never, screen: {} as never, components: {} as never, colors: {} as never, keymap: {} as never, notice: { set() {} }, localCwd: '/frontend/workspace', exit,
    ...injected ? { selection: () => selection, subscribeSelection: (listener: () => void) => { side.add(listener); return () => side.delete(listener) }, focusEditor, startupKey } : {},
    ...contributed ? { featureCommands: commands } : {},
  })
  cleanups.push(async () => { handle.dispose(); await ctx.fiber.dispose() })
  return { ctx, options: captured.options!, handle, app, client, ref, binding, session, native, upload, topology, states, side, commands, focusEditor, startupKey, exit,
    clearRef: () => { currentRef = undefined }, clearBinding: () => { reference = undefined }, restore: () => { currentRef = ref; reference = { binding }; available = client },
    available: (value: HostClient | undefined) => { available = value }, attached: (value: HostClient[]) => { attached = value },
    select: (value: typeof selection) => { selection = value }, generation: () => { generation += 1 },
  }
}
function invocation(name: string, extra: Partial<EditorLocalCommandInvocation> = {}): EditorLocalCommandInvocation {
  return { name, line: `/${name} untouched`, rawInput: ' untouched', attachments: [], session: undefined, signal: new AbortController().signal, ...extra }
}

describe('Remote editor composition', () => {
  it('borrows only the exact selected binding and refuses unavailable Host file scope', async () => {
    const f = await fixture()
    const options = f.options, signal = new AbortController().signal
    expect(options.session()).toMatchObject({ ref: f.ref, client: f.client, session: f.session, generation: 0 })
    await options.files.stat(f.ref.sessionId, 'native.txt', signal)
    expect(f.native.stat).toHaveBeenCalledWith(f.ref.sessionId, 'native.txt', signal)
    await options.files.readBytes(f.ref.sessionId, 'native.txt', signal)
    expect(f.native.readBytes).toHaveBeenCalledWith(f.ref.sessionId, 'native.txt', {}, signal)
    const data = new Uint8Array([1, 2])
    await options.upload(f.ref.sessionId, data, 'upload.txt', signal)
    expect(f.upload).toHaveBeenCalledWith(f.ref.sessionId, data, 'upload.txt', signal)
    await options.upload(f.ref.sessionId, data)
    expect(f.upload).toHaveBeenCalledWith(f.ref.sessionId, data, undefined, undefined)
    await options.files.openWorkspacePath('native.txt', signal)
    expect(f.session.openWorkspacePath).toHaveBeenCalledWith('native.txt', signal)
    expect(() => options.files.stat(SessionId('another-session'), 'native.txt', signal)).toThrow('The selected Session changed before the file operation')
    const aborted = new AbortController(); aborted.abort()
    expect(() => options.files.stat(f.ref.sessionId, 'native.txt', aborted.signal)).toThrow()
    expect(() => options.files.openWorkspacePath('native.txt', aborted.signal)).toThrow()
    f.clearRef(); expect(options.session()).toBeUndefined()
    expect(() => options.files.openWorkspacePath('native.txt', signal)).toThrow('Select or create a Session before using Host files')
    f.restore(); f.clearBinding(); expect(options.session()).toBeUndefined()
    f.restore(); f.available(undefined); expect(options.session()).toBeUndefined()
    await expect(options.ensureSession!()).rejects.toThrow('Select or create a Session')
    f.restore(); await expect(options.ensureSession!()).resolves.toMatchObject({ ref: f.ref })
    expect(f.app.ensureSession).toHaveBeenCalledWith('/frontend/workspace')
    await options.preparePrompt!(options.session()!, signal)
    expect(f.app.preparePrompt).toHaveBeenCalledWith(f.ref, signal, undefined)
    await options.preparePrompt!(options.session()!, signal, 'plan')
    expect(f.app.preparePrompt).toHaveBeenLastCalledWith(f.ref, signal, 'plan')
  })

  it('uses injected side selection and preserves access across native reconnect and selection generations', async () => {
    const f = await fixture(true)
    expect(f.options.focusEditor).toBe(f.focusEditor); expect(f.options.startupKey).toBe(f.startupKey)
    expect(f.options.session()).toMatchObject({ ref: f.ref, access: 'readonly', generation: 0 })
    expect(f.options.local.list().some(command => command.name === 'rename')).toBe(false)
    f.select(undefined); expect(f.options.session()).toBeUndefined()
    f.select({ client: f.client, ref: f.ref, binding: f.binding, access: 'resumable' })
    for (const listener of f.side) listener()
    expect(f.options.session()).toMatchObject({ access: 'resumable', generation: 1 })
    expect(f.options.local.list().some(command => command.name === 'rename')).toBe(true)
    for (const listener of f.states) listener()
    expect(captured.controller.hostReconnected).not.toHaveBeenCalled()
    f.generation(); for (const listener of f.states) listener()
    expect(captured.controller.hostReconnected).toHaveBeenCalledOnce()
    expect(f.options.session()?.generation).toBe(2)
    for (const listener of f.topology) listener()
    expect(f.options.session()?.generation).toBe(3)
    expect(captured.controller.selectionChanged).toHaveBeenCalledTimes(2)
  })

  it('routes commands and skills without admitting unsupported command attachments', async () => {
    const f = await fixture(false, true)
    expect(f.options.local.cwd()).toBe('/frontend/workspace')
    expect(f.options.local.list().some(command => command.name === 'local-fixture')).toBe(true)
    await expect(f.options.local.execute(invocation('model', { attachments: [{ type: 'file', receiptId: 'attached' }] }))).resolves.toEqual({ kind: 'error', text: '/model does not accept attachments; no command was sent' })
    expect(f.app.execute).not.toHaveBeenCalled(); expect(f.commands.execute).not.toHaveBeenCalled()
    await expect(f.options.local.execute(invocation('plan', { session: f.options.session(), attachments: [{ type: 'file', receiptId: 'native-file' }] }))).resolves.toEqual({ kind: 'unhandled' })
    await expect(f.options.local.execute(invocation('plan'))).resolves.toEqual({ kind: 'success' })
    await expect(f.options.local.execute(invocation('skills'))).resolves.toEqual({ kind: 'success' })
    expect(captured.controller.openSkills).toHaveBeenCalledOnce()
    const command = invocation('local-fixture')
    await expect(f.options.local.execute(command)).resolves.toEqual({ kind: 'success' })
    expect(f.commands.execute).toHaveBeenCalledWith('local-fixture', ' untouched', command.signal)
    f.commands.execute.mockResolvedValueOnce(false)
    await expect(f.options.local.execute(invocation('unknown'))).resolves.toEqual({ kind: 'success', exit: true })
    await expect(f.options.local.execute(invocation('quit'))).resolves.toEqual({ kind: 'success', exit: true })
    expect(f.app.execute).toHaveBeenCalledWith('/quit untouched')
    f.options.local.exit(); expect(f.exit).toHaveBeenCalledOnce()
    const plain = await fixture()
    await expect(plain.options.local.execute(invocation('native-command'))).resolves.toEqual({ kind: 'success', exit: true })
    plain.clearRef(); expect(plain.options.local.list().some(command => command.name === 'rename')).toBe(false)
  })

  it('retires every listener once and ignores callbacks queued before detach or full unload', async () => {
    const f = await fixture(true)
    const oldState = [...f.states]
    f.attached([]); for (const listener of f.topology) listener()
    expect(f.states.size).toBe(0)
    f.attached([f.client]); for (const listener of f.topology) listener()
    expect(f.states.size).toBe(1)
    f.generation(); captured.controller.hostReconnected.mockClear()
    for (const listener of oldState) listener()
    expect(captured.controller.hostReconnected).not.toHaveBeenCalled()
    const late = [...f.states, ...f.topology, ...f.side]
    f.handle.dispose(); f.handle.dispose()
    captured.controller.selectionChanged.mockClear(); captured.controller.hostReconnected.mockClear()
    f.generation(); for (const listener of late) listener()
    expect(captured.controller.selectionChanged).not.toHaveBeenCalled(); expect(captured.controller.hostReconnected).not.toHaveBeenCalled()
    expect(captured.controller.dispose).toHaveBeenCalledOnce()
    expect(f.states.size).toBe(0); expect(f.topology.size).toBe(0); expect(f.side.size).toBe(0)
  })
})
