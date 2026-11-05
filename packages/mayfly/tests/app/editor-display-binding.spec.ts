/** Displayed native bindings drive the real editor without falling back to the primary Session. @module */
import { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { MayflyComponentsService, type MayflyComponentsDeps } from '../../src/core/components.ts'
import type { MayflyKeymap, MayflyScreen, MayflySemanticColors } from '../../src/core/types.ts'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostClient } from '../../src/client/types.ts'
import type { RemoteApp } from '../../src/app/app.ts'
import { mountEditorComposition } from '../../src/app/editor-composition.ts'
import type { RemoteFeatureSelection } from '../../src/app/features/contracts.ts'
import { RemoteFeatureCommandRegistry } from '../../src/app/features/commands.ts'
import { accepted, deferred, denied, flush, wire } from './editor-feature-fixture.ts'

type Displayed = RemoteFeatureSelection & { readonly access: 'interactive' | 'resumable' | 'readonly' }
const owners: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of owners.splice(0)) await dispose() })

function host(name: string) {
  const fixture = wire(name)
  const listeners = new Set<() => void>()
  const forwarded = new Set<() => void>()
  let generation = 1
  let running = true
  const retain = vi.fn()
  const readBytes = vi.fn(async () => ({ ok: true as const, value: { absolutePath: '/host/file', version: '1', data: new TextEncoder().encode(name) } }))
  const stat = vi.fn(async () => ({ ok: true as const, value: { absolutePath: '/host/file', version: '1' } }))
  const remote = fixture.selected.client.remote as unknown as Record<string, unknown>
  remote.$on = () => { const listener = () => {}; forwarded.add(listener); return () => { forwarded.delete(listener) } }
  remote.workspaceFiles = { stat, readBytes }
  const client = Object.assign(fixture.selected.client, {
    state: { getSnapshot: () => ({ status: 'connected', generation }), subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
    sessions: { retain },
  }) as HostClient
  Object.assign(fixture.selected.session, { getSnapshot: () => ({ running }) })
  const binding = { sessionId: fixture.selected.ref.sessionId, session: fixture.selected.session } as SessionBinding
  return { ...fixture, client, binding, listeners, forwarded, retain, stat, readBytes,
    displayed(access: Displayed['access'] = 'resumable'): Displayed { return { ref: fixture.selected.ref, client, binding, access } },
    reconnect() { generation += 1; for (const listener of listeners) listener() },
    idle() { running = false },
  }
}

function fixture(initialAccess: Displayed['access'] = 'resumable', featureCommands = new RemoteFeatureCommandRegistry(), startupKey?: (data: string, text: string) => boolean) {
  const primary = host('primary')
  const child = host('one')
  const otherHost = host('two')
  const ctx = new Context()
  new MayflyLocaleService(ctx)
  const requestRender = vi.fn()
  const colors = new Proxy({}, { get: () => (text: string) => text }) as MayflySemanticColors
  const components = new MayflyComponentsService(ctx, { theme: { colors }, tui: { requestRender } } as unknown as MayflyComponentsDeps)
  const editor = components.createEditor()
  const screen = { columns: 100, rows: 30, screenMode: 'inline', setFocus: vi.fn(), requestRender } as unknown as MayflyScreen
  const unregisterKeys = vi.fn()
  const keymap = { register: () => unregisterKeys, matches: (data: string, id: string) => data === '\x1b' && id === 'ui.cancel' || data === '\x1b[13;5u' && id === 'mayfly.interaction.steer' } as unknown as MayflyKeymap
  const topology = new Set<() => void>()
  const displayedListeners = new Set<() => void>()
  let displayed: Displayed | undefined = child.displayed(initialAccess)
  const clients = [primary.client, child.client, otherHost.client]
  const primaryReference = { binding: primary.binding }
  const ensureSession = vi.fn(async () => primary.selected.ref)
  const execute = vi.fn(async () => ({ exit: false }))
  const app = {
    registry: { current: primary.selected.ref, currentReference: primaryReference, list: () => clients, get: (key: string) => clients.find(client => client.key === key) },
    ensureSession, execute, preparePrompt: vi.fn(async () => {}),
    subscribeTopology: (listener: () => void) => { topology.add(listener); return () => { topology.delete(listener) } },
  } as unknown as RemoteApp
  const notices: string[] = []
  const exit = vi.fn()
  const handle = mountEditorComposition({ ctx, app, editor, screen, components, colors, keymap, notice: { set: text => { notices.push(text) } }, localCwd: '/remote', exit,
    featureCommands,
    ...startupKey === undefined ? {} : { startupKey },
    selection: () => displayed,
    subscribeSelection: listener => { displayedListeners.add(listener); return () => { displayedListeners.delete(listener) } },
  })
  let disposed = false
  const dispose = async (): Promise<void> => { if (disposed) return; disposed = true; handle.dispose(); await ctx.fiber.dispose() }
  owners.push(dispose)
  return { primary, child, otherHost, editor, app, handle, notices, topology, displayedListeners, ensureSession, execute, unregisterKeys, dispose,
    enter(text: string) { editor.setText(text); editor.handleInput?.('\r') },
    display(next: Displayed | undefined) { displayed = next; for (const listener of displayedListeners) listener() },
  }
}

describe('editor composition displayed native binding integration', () => {
  it('uses the exact borrowed continuable child for prompt, native cancellation, and pending queue writes', async () => {
    const f = fixture()
    await flush()
    f.enter('reply to the displayed child')
    await flush()
    expect(f.child.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'reply to the displayed child' }], 'queue', expect.any(AbortSignal), f.child.handles[0]!.requestId)
    expect(f.child.begin[0]!.text).toBe('reply to the displayed child')
    expect(f.editor.onKey?.('\x1b')).toBe(true)
    await flush()
    expect(f.child.cancel).toHaveBeenCalledOnce()
    expect(await f.handle.controller.updateQueue('pending' as MessageId, { kind: 'remove' })).toBe(true)
    expect(f.child.updateQueue).toHaveBeenCalledWith('pending', { kind: 'remove' })
    expect(f.primary.prompt).not.toHaveBeenCalled()
    expect(f.primary.cancel).not.toHaveBeenCalled()
    expect(f.primary.updateQueue).not.toHaveBeenCalled()
    expect(f.child.retain).not.toHaveBeenCalled()
    expect(f.app.registry.current).toEqual(f.primary.selected.ref)
    expect(f.ensureSession).not.toHaveBeenCalled()
  })

  it('preserves readonly drafts and blocks prompt, Host command, cancellation, and queue mutations', async () => {
    const f = fixture('readonly')
    await flush()
    f.enter('keep this readonly draft')
    await flush()
    expect(f.editor.getText()).toBe('keep this readonly draft')
    expect(f.notices).toContain('This conversation is read-only')
    f.enter('/host-only must not write')
    await flush()
    expect(f.editor.getText()).toBe('/host-only must not write')
    expect(f.child.executeCommand).not.toHaveBeenCalled()
    expect(f.editor.onKey?.('\x1b')).toBe(true)
    await flush()
    expect(await f.handle.controller.updateQueue('pending' as MessageId, { kind: 'steer' })).toBe(false)
    for (const session of [f.child, f.primary]) {
      expect(session.prompt).not.toHaveBeenCalled()
      expect(session.cancel).not.toHaveBeenCalled()
      expect(session.updateQueue).not.toHaveBeenCalled()
      expect(session.begin).toEqual([])
    }
    expect(f.ensureSession).not.toHaveBeenCalled()
  })

  it('keeps equal SessionIds on different Hosts isolated across late queue and prompt responses', async () => {
    const f = fixture()
    const queue = deferred<Awaited<ReturnType<typeof f.child.updateQueue>>>()
    const prompt = deferred<Awaited<ReturnType<typeof f.child.prompt>>>()
    f.child.updateQueue.mockReturnValueOnce(queue.promise)
    f.child.prompt.mockReturnValueOnce(prompt.promise)
    const changing = f.handle.controller.updateQueue('same-message' as MessageId, { kind: 'remove' })
    f.enter('old Host request')
    await flush()
    f.display(f.otherHost.displayed())
    f.editor.setText('new Host draft')
    queue.resolve(denied('old queue error'))
    prompt.reject(new Error('old Host disconnected'))
    expect(await changing).toBe(false)
    await flush()
    expect(f.editor.getText()).toBe('new Host draft')
    expect(f.notices.filter(Boolean)).toEqual([])
    f.enter('new Host request')
    await flush()
    expect(f.otherHost.prompt).toHaveBeenCalledOnce()
    expect(f.child.prompt).toHaveBeenCalledOnce()
    expect(f.otherHost.handles[0]!.requestId).not.toBe(f.child.handles[0]!.requestId)
    expect(f.otherHost.selected.ref.sessionId).toBe(f.child.selected.ref.sessionId)
    expect(f.primary.prompt).not.toHaveBeenCalled()
    expect(f.child.forwarded.size).toBe(0)
  })

  it('fences a replaced binding with the same Host and Session identity and releases all composition listeners', async () => {
    const f = fixture()
    const pending = deferred<Awaited<ReturnType<typeof f.child.updateQueue>>>()
    f.child.updateQueue.mockReturnValueOnce(pending.promise)
    const changing = f.handle.controller.updateQueue('pending' as MessageId, { kind: 'remove' })
    const replacement = host('one')
    f.display(replacement.displayed())
    pending.resolve(denied('retired binding'))
    expect(await changing).toBe(false)
    expect(f.notices.filter(Boolean)).toEqual([])
    f.enter('replacement binding')
    await flush()
    expect(replacement.prompt).toHaveBeenCalledOnce()
    expect(f.child.prompt).not.toHaveBeenCalled()
    await f.dispose()
    expect(f.topology.size + f.displayedListeners.size).toBe(0)
    expect(f.primary.listeners.size + f.child.listeners.size + f.otherHost.listeners.size).toBe(0)
    expect(replacement.forwarded.size).toBe(0)
    expect(f.unregisterKeys).toHaveBeenCalledOnce()
  })

  it('fences a displayed Host reconnection without sending queued actions to the primary', async () => {
    const f = fixture()
    const pending = deferred<Awaited<ReturnType<typeof f.child.updateQueue>>>()
    f.child.updateQueue.mockReturnValueOnce(pending.promise)
    const changing = f.handle.controller.updateQueue('pending' as MessageId, { kind: 'remove' })
    f.child.reconnect()
    pending.resolve(accepted)
    expect(await changing).toBe(false)
    await f.handle.controller.updateQueue('new' as MessageId, { kind: 'remove' })
    expect(f.child.updateQueue).toHaveBeenLastCalledWith('new', { kind: 'remove' })
    expect(f.primary.updateQueue).not.toHaveBeenCalled()
  })

  it('does not read a same-id replacement Host after an earlier file stat completes late', async () => {
    const f = fixture()
    const stat = deferred<Awaited<ReturnType<typeof f.child.stat>>>()
    f.child.stat.mockReturnValueOnce(stat.promise)
    const reading = f.handle.controller.readHostFile('file')
    f.display(f.otherHost.displayed())
    stat.resolve({ ok: true, value: { absolutePath: '/host/file', version: '1' } })
    expect(await reading).toBeUndefined()
    expect(f.otherHost.readBytes).not.toHaveBeenCalled()
    expect(f.primary.readBytes).not.toHaveBeenCalled()
  })

  it('uses the same actual mounted scope-aware directory for startup and writable completion', async () => {
    const commands = new RemoteFeatureCommandRegistry()
    commands.register({ name: 'theme', description: 'Switch the color theme', scope: 'sessionless', aliases: ['color'], execute: vi.fn() })
    commands.register({ name: 'save', description: 'Save session', execute: vi.fn() })
    commands.register({ name: 'internal', description: 'Hidden', scope: 'sessionless', hidden: true, execute: vi.fn() })
    const f = fixture('resumable', commands)
    f.display(undefined)
    f.editor.handleInput?.('/')
    await flush()
    const startup = f.editor.completion()?.items.map(item => item.value) ?? []
    expect(startup).toContain('/theme')
    expect(startup).toContain('/quit')
    expect(startup).not.toContain('/save')
    expect(startup).not.toContain('/skills')
    expect(startup).not.toContain('/internal')
    expect(f.ensureSession).not.toHaveBeenCalled()
    f.display(f.child.displayed())
    f.editor.setText('')
    f.editor.handleInput?.('/')
    await flush()
    expect(f.editor.completion()?.items.map(item => item.value)).toContain('/save')
    f.editor.setText('')
    f.editor.handleInput?.('/color')
    await flush()
    expect(f.editor.completion()?.items.map(item => item.value)).toContain('/theme')
  })

  it('routes built-in ownership before a duplicate feature registration', async () => {
    const commands = new RemoteFeatureCommandRegistry()
    const duplicate = vi.fn()
    const theme = vi.fn()
    commands.register({ name: 'help', description: 'wrong help', scope: 'sessionless', execute: duplicate })
    commands.register({ name: 'theme', description: 'Switch the color theme', scope: 'sessionless', execute: theme })
    const f = fixture('resumable', commands)
    f.enter('/help')
    await flush()
    expect(f.execute).toHaveBeenCalledWith('/help', expect.any(AbortSignal))
    expect(duplicate).not.toHaveBeenCalled()
    f.enter('/theme')
    await flush()
    expect(theme).toHaveBeenCalledOnce()
    expect(f.child.executeCommand).not.toHaveBeenCalled()
  })

  it('offers startup navigation the actual draft before ordinary editor key handling', () => {
    const startup = vi.fn((data: string) => data === 's')
    const f = fixture('resumable', new RemoteFeatureCommandRegistry(), startup)
    f.editor.setText('keep the typed draft')
    expect(f.editor.onKey?.('s')).toBe(true)
    expect(startup).toHaveBeenCalledWith('s', 'keep the typed draft')
    expect(f.editor.getText()).toBe('keep the typed draft')
    expect(f.child.prompt).not.toHaveBeenCalled()
  })

  it('clears command feedback as the native editor changes or clears its draft', () => {
    const f = fixture()
    f.notices.push('Switched to pro (deepseek) · thinking high')
    f.editor.handleInput?.('keep this draft')
    expect(f.editor.getText()).toBe('keep this draft')
    expect(f.notices.at(-1)).toBe('')
    f.notices.push('Already using pro (deepseek)')
    f.editor.handleInput?.('\x15')
    expect(f.editor.getText()).toBe('')
    expect(f.notices.at(-1)).toBe('')
    expect(f.child.prompt).not.toHaveBeenCalled()
  })
})
