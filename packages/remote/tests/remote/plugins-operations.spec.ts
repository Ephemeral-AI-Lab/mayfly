/** Plugin family composition delegates to one marketplace and one updater. @module tests/remote/plugins-operations */
import { expect, it, vi } from 'vitest'
import type { RemoteOperationsContext } from '../../src/remote/operations/support.ts'
const mounts = vi.hoisted(() => ({ marketplace: vi.fn(() => vi.fn()), update: vi.fn(() => vi.fn()) }))
vi.mock('../../src/remote/operations/plugin-marketplace.ts', () => ({ mountRemoteMarketplace: mounts.marketplace }))
vi.mock('../../src/remote/operations/update.ts', () => ({ mountRemoteUpdate: mounts.update }))
import { mountRemotePluginOperations } from '../../src/remote/operations/plugins.ts'
it('mounts both owners and disposes update before marketplace', () => {
  const context = {} as RemoteOperationsContext
  const dispose = mountRemotePluginOperations(context)
  expect(mounts.marketplace).toHaveBeenCalledWith(context)
  expect(mounts.update).toHaveBeenCalledWith(context)
  dispose()
  expect(mounts.update.mock.results[0]!.value).toHaveBeenCalledOnce()
  expect(mounts.marketplace.mock.results[0]!.value).toHaveBeenCalledOnce()
})
