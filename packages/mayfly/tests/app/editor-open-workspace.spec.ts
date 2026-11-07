/** Real editor key routing through the official Host namespace, with no SessionFace convenience method. @module */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { MayflyComponentsService, type MayflyComponentsDeps } from '../../src/core/components.ts'
import type { MayflyKeymap, MayflyScreen, MayflySemanticColors } from '../../src/core/types.ts'
import * as Provider from '@ephemeral-ai/mayfly-ui/provider'
import * as Frontend from '../../src/frontend/index.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import type { RemoteApp } from '../../src/app/app.ts'
import type { RemoteFeatureSelection } from '../../src/app/features/contracts.ts'
import { mountEditorComposition } from '../../src/app/editor-composition.ts'
import { flush } from './editor-feature-fixture.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function fixture() {
  const ctx = new Context()
  await ctx.plugin(Provider)
  await ctx.plugin(Frontend)
  const colors = new Proxy({}, { get: () => (text: string) => text }) as MayflySemanticColors
  const screen = { requestRender: vi.fn(), setFocus: vi.fn(), mountContentSlot: () => ({ dispose() {} }) } as unknown as MayflyScreen
  const components = new MayflyComponentsService(ctx, { theme: { colors }, tui: { requestRender: screen.requestRender } } as unknown as MayflyComponentsDeps)
  const editor = components.createEditor()
  const open = vi.fn(async (_request: { readonly path: string }, _signal: AbortSignal): Promise<unknown> => ({ ok: true, value: { opened: true } }))
  let generation = 1
  const stateListeners = new Set<() => void>()
  const selectionListeners = new Set<() => void>()
  const client = {
    key: HostKey('exact-host'),
    state: { getSnapshot: () => ({ generation }), subscribe: (listener: () => void) => { stateListeners.add(listener); return () => { stateListeners.delete(listener) } } },
    remote: { session: { openWorkspacePath: open }, commands: { list: async () => ({ ok: true, value: [] }) }, skills: { list: async () => ({ ok: true, value: { skills: [] } }) }, $on: () => () => {} },
  } as unknown as HostClient
  const binding = { session: { getSnapshot: () => ({ running: false }), projections: { faceOf: () => ({ getSnapshot: () => undefined }) } } } as unknown as RemoteFeatureSelection['binding']
  let selected: RemoteFeatureSelection | undefined = { ref: { host: client.key, sessionId: SessionId('session') }, client, binding, access: 'readonly' }
  const app = { registry: { list: () => [client] }, subscribeTopology: () => () => {} } as unknown as RemoteApp
  const keymap = { register: () => () => {}, list: () => [], matches: (data: string, id: string) => data === id } as unknown as MayflyKeymap
  const notice = { set: vi.fn() }
  ctx.provide('mayflyScreen', screen)
  ctx.provide('mayflyKeymap', keymap)
  const handle = mountEditorComposition({ ctx, app, editor, screen, components, colors, keymap, notice, localCwd: '/frontend', exit: () => {},
    selection: () => selected === undefined ? undefined : { ...selected, access: selected.access ?? 'interactive' },
    subscribeSelection: listener => { selectionListeners.add(listener); return () => { selectionListeners.delete(listener) } },
  })
  vi.spyOn(editor, 'isShowingAutocomplete').mockReturnValue(true)
  vi.spyOn(editor, 'completion').mockReturnValue({ kind: 'files', items: [{ label: 'notes.txt', value: '@"host path"' }], index: 0 } as never)
  cleanups.push(async () => { handle.dispose(); await ctx.fiber.dispose() })
  await flush()
  return { editor, client, binding, open, notice, handle,
    key: () => editor.onKey?.('ui.external'),
    replace: (next: RemoteFeatureSelection | undefined) => { selected = next; for (const listener of selectionListeners) listener() },
    reconnect: () => { generation += 1; for (const listener of stateListeners) listener() },
  }
}

describe('official Host workspace opener from the actual editor', () => {
  it('opens readonly file completions through client.remote.session and renders native failures', async () => {
    const f = await fixture()
    expect('openWorkspacePath' in f.binding.session).toBe(false)
    expect(f.key()).toBe(true)
    await flush()
    expect(f.open).toHaveBeenCalledExactlyOnceWith({ path: 'host path' }, expect.any(AbortSignal))
    f.open.mockResolvedValueOnce({ ok: false, error: { message: 'native open denied' } })
    f.key()
    await flush()
    expect(f.notice.set).toHaveBeenLastCalledWith('native open denied')
  })

  it.each(['selection', 'connection', 'unload'] as const)('retires late native errors after %s', async change => {
    const f = await fixture()
    const gate = Promise.withResolvers<unknown>()
    f.open.mockReturnValueOnce(gate.promise)
    f.key()
    await flush()
    const signal = f.open.mock.calls[0]![1] as AbortSignal
    if (change === 'selection') f.replace(undefined)
    if (change === 'connection') f.reconnect()
    if (change === 'unload') f.handle.dispose()
    expect(signal.aborted).toBe(true)
    gate.resolve({ ok: false, error: { message: 'late native feedback' } })
    await flush()
    expect(f.notice.set).not.toHaveBeenCalled()
  })
})
