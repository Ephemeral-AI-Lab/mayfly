/** Retraction admission, exact native targets and retired acknowledgements. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountRemoteRetractOperations } from '../../src/remote/operations/retract.ts'
import { RemotePresentSlot, type RemoteOperationsContext } from '../../src/remote/operations/support.ts'
import { taskFixture, good, bad } from './task-feature-fixture.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop(); vi.restoreAllMocks() })
async function fixture(selected = true) {
  const f = await taskFixture(selected)
  const retractTurn = vi.fn(async (..._args: unknown[]): Promise<unknown> => good(true))
  Object.assign(f.client.remote, { mayflyHost: { retractTurn } })
  const options = { localCwd: '/local', btw: {} } as RemoteOperationsContext['options']
  const presentSlot = new RemotePresentSlot(options)
  const stop = mountRemoteRetractOperations({ base: f.options, options, presentSlot })
  cleanups.push(async () => { stop(); presentSlot.dispose(); await f.dispose() })
  return { ...f, retractTurn, stop }
}

describe('native turn retraction', () => {
  it('requires a message and exact Session, preserves native refusal, and distinguishes no-op from retraction', async () => {
    const empty = await fixture(false)
    await expect(empty.run('retract')).rejects.toThrow('Usage: /retract <messageId>')
    await expect(empty.run('retract', 'message')).rejects.toThrow('No current session')
    const f = await fixture()
    await f.run('retract', '  message  ')
    expect(f.retractTurn).toHaveBeenCalledWith({ sessionId: 'session', messageId: 'message' }, expect.any(AbortSignal))
    expect(f.options.notice.set).toHaveBeenLastCalledWith('Turn retracted')
    f.retractTurn.mockResolvedValueOnce(good(false))
    await f.run('retract', 'message')
    expect(f.options.notice.set).toHaveBeenLastCalledWith('The Host did not retract the turn; it must be running and tool-free')
    f.retractTurn.mockResolvedValueOnce(bad('native refused'))
    await expect(f.run('retract', 'message')).rejects.toMatchObject({ message: 'native refused' })
  })

  it('retires late acknowledgements after physical generation, selection, cancellation, or unload', async () => {
    for (const kind of ['reconnect', 'select', 'abort', 'unload'] as const) {
      const f = await fixture()
      const ready = Promise.withResolvers<unknown>()
      f.retractTurn.mockReturnValueOnce(ready.promise)
      const controller = new AbortController()
      const pending = f.run('retract', 'message', controller.signal)
      if (kind === 'reconnect') f.reconnect()
      else if (kind === 'select') f.select(false)
      else if (kind === 'abort') controller.abort()
      else f.stop()
      ready.resolve(good(true))
      await pending
      expect(f.options.notice.set).not.toHaveBeenCalled()
      expect(f.retractTurn).toHaveBeenCalledOnce()
    }
    const f = await fixture()
    await f.run('retract', 'message', AbortSignal.abort())
    expect(f.retractTurn).not.toHaveBeenCalled()
    const error = Promise.withResolvers<unknown>()
    f.retractTurn.mockReturnValueOnce(error.promise)
    const stale = f.run('retract', 'message')
    f.detach(); error.reject(new Error('old transport'))
    await expect(stale).resolves.toBe(true)
  })
})
