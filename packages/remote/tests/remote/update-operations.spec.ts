/** Native Host and frontend-local upgrade transaction/lifecycle contracts. @module tests/remote/update-operations */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DECISION_NO, DECISION_YES } from '@ephemeral-ai/mayfly-ui'
import type { HostClient } from '../../src/client/types.ts'
import type { RemoteOperationsContext } from '../../src/remote/operations/support.ts'
import type { RemoteBrowserOptions } from '../../src/remote/panels/browser.ts'
import { RemoteUpdateController, mountRemoteUpdate } from '../../src/remote/operations/update.ts'
import type { LocalFrontendUpdater, LocalUpdateSnapshot } from '../../src/remote/operations/local-update.ts'

const opened = vi.hoisted(() => vi.fn())
vi.mock('../../src/remote/panels/browser.ts', () => ({ openRemoteBrowser: opened }))
vi.mock('../../src/remote/features/version.ts', () => ({ remoteClientVersion: () => '1.0.0' }))

const snapshot: LocalUpdateSnapshot = { current: '1.0.0', target: '1.1.0', root: '/npm/@ephemeral-ai/mayfly-cli', directory: '/tmp/update', logPath: '/tmp/update/update.log', lockPath: '/npm/@ephemeral-ai/.mayfly-update.json' }
const ok = <T>(value: T) => ({ ok: true as const, value })
const signal = () => new AbortController().signal
let panels: Array<{ options: RemoteBrowserOptions, refresh: ReturnType<typeof vi.fn<() => void>>, close: ReturnType<typeof vi.fn<() => void>> }>

beforeEach(() => {
  panels = []
  opened.mockImplementation((_base, options: RemoteBrowserOptions) => {
    let closed = false
    const panel = { options, refresh: vi.fn(), close: vi.fn(() => { if (closed) return; closed = true; options.onClosed?.() }), get closed() { return closed } }
    panels.push(panel)
    return panel
  })
})
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

function fixture() {
  let installed = '1.0.0'
  let generation = 1
  const listeners = new Set<() => void>()
  const states = new Set<() => void>()
  const bundle = { name: '@ephemeral-ai/mayfly-host', installed: true, enabled: true, updatable: true, version: '1.0.0' }
  const listBundles = vi.fn(async () => ok([{ ...bundle, version: installed }]))
  const listVersions = vi.fn(async (): Promise<unknown> => ok({ status: 'listed', registry: null, installed: '1.0.0', versions: [{ version: '1.1.0', tags: ['latest'], bundle: true }], omitted: 0 }))
  const updateBundle = vi.fn(async () => { installed = '1.1.0'; return ok({ from: '1.0.0', to: '1.1.0', step: 'install', result: { changed: true, application: 'restart-required' } }) })
  const installBundle = vi.fn(async () => { installed = '1.0.0'; return ok({ changed: true, application: 'restart-required' }) })
  const client = { key: 'one', remote: { pluginManager: { listBundles, listVersions, updateBundle, installBundle } }, state: { getSnapshot: () => ({ generation }), subscribe: (listener: () => void) => { states.add(listener); return () => { states.delete(listener) } } } } as unknown as HostClient
  const running = vi.fn(() => ({ running: false }))
  const selection = { client, ref: { host: 'one', sessionId: 's1' }, binding: { session: { getSnapshot: running } } }
  const hosts = {
    current: vi.fn((): typeof selection | undefined => selection), active: vi.fn((): HostClient | undefined => client), list: vi.fn(() => [client]),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const locale = { register: vi.fn(), subscribe: vi.fn(() => () => {}), translate: vi.fn((_ns: string, key: string, values: Record<string, unknown> = {}) => key.replace(/\{(\w+)\}/gu, (_match, name: string) => String(values[name] ?? name))) }
  const effect = vi.fn((factory: () => unknown) => { const dispose = factory(); return () => { if (typeof dispose === 'function') dispose() } })
  const settings = { updateChannel: 'latest' }
  const ctx = { effect, get: (name: string) => name === 'mayflyLocale' ? locale : name === 'mayflyInteractionState' ? { settingsSource: () => settings } : undefined, mayflyLocale: locale, inject: (_deps: readonly string[], callback: (scope: unknown) => void) => { callback({ effect, mayflyLocale: locale }) } }
  const notice = { set: vi.fn() }
  const unregister = vi.fn()
  const register = vi.fn(() => unregister)
  const base = { hosts, ctx, notice, commands: { register }, subscribeLocale: vi.fn(() => () => {}) }
  const context = { base } as unknown as RemoteOperationsContext
  const local = { pending: vi.fn(async (): Promise<import('../../src/remote/operations/local-update.ts').PendingLocalUpdate | undefined> => undefined), begin: vi.fn(async () => {}), finish: vi.fn(async () => {}), preflight: vi.fn(async () => snapshot), stage: vi.fn(async () => {}), install: vi.fn(async () => {}), restore: vi.fn(async () => {}), cleanup: vi.fn(async () => {}) }
  const controller = new RemoteUpdateController(context, local as unknown as LocalFrontendUpdater)
  const change = () => { for (const listener of listeners) listener() }
  const reconnect = () => { generation += 1; for (const listener of states) listener() }
  return { controller, context, local, hosts, notice, client, running, bundle, listBundles, listVersions, updateBundle, installBundle, register, unregister, settings, change, reconnect }
}

function text() { return JSON.stringify(panels.at(-1)?.options.view()) }
async function answer(yes: boolean) {
  await vi.waitFor(() => { expect(panels.at(-1)?.options.id).toBe('mayfly.update.confirm'); expect(panels.at(-1)!.close).not.toHaveBeenCalled() })
  expect(panels.at(-1)!.options.isCurrent!()).toBe(true)
  expect(JSON.stringify(panels.at(-1)!.options.view())).toContain(yes ? 'Yes' : 'No')
  await panels.at(-1)!.options.action!({ kind: 'activate', actionId: yes ? DECISION_YES : DECISION_NO, controlId: 'update-confirm-actions', pagePath: [] }, {} as never)
}

async function accepted(test: ReturnType<typeof fixture>, requested = '') {
  const pending = test.controller.execute(requested, signal())
  await answer(true)
  await pending
}

describe('split release upgrade', () => {
  it('stages and smokes both release graphs, installs both exact versions, and leaves a readable pending-restart result', async () => {
    const test = fixture()
    try {
      test.hosts.current.mockReturnValue(undefined)
      test.settings.updateChannel = ''
      await accepted(test)
      expect(test.local.preflight).toHaveBeenCalledWith('1.0.0', '1.1.0', expect.any(AbortSignal))
      expect(test.local.stage).toHaveBeenCalledWith(snapshot, expect.any(AbortSignal))
      expect(test.local.install).toHaveBeenCalledWith(snapshot)
      expect(test.updateBundle).toHaveBeenCalledWith('@ephemeral-ai/mayfly-host', '1.1.0', { registry: null })
      expect(test.local.restore).not.toHaveBeenCalled()
      expect(text()).toContain('Updated Host and TUI to v1.1.0')
      expect(text()).toContain('Host startup remains unverified until restart')
      expect(text()).toContain('· smoke: boot')
      expect(text()).toContain('✓ smoke: imports')
      expect(panels.at(-1)!.close).not.toHaveBeenCalled()
      expect(panels.at(-1)!.options.back!()).toBe(false)
      panels.at(-1)!.close()
    } finally { test.controller.dispose() }
  })

  it('uses the shared No/cancel confirmation and keeps every installation unchanged', async () => {
    const test = fixture()
    try {
      const pending = test.controller.execute('1.1.0', signal())
      await answer(false)
      await pending
      expect(test.notice.set).toHaveBeenCalledWith('update cancelled')
      expect(test.local.stage).not.toHaveBeenCalled()
      expect(test.local.cleanup).toHaveBeenCalledWith(snapshot)
      const dismissed = test.controller.execute('', signal())
      await vi.waitFor(() => { expect(panels.at(-1)?.options.id).toBe('mayfly.update.confirm'); expect(panels.at(-1)!.close).not.toHaveBeenCalled() })
      panels.at(-1)!.close()
      await dismissed
      expect(test.updateBundle).not.toHaveBeenCalled()
    } finally { test.controller.dispose() }
  })

  it('keeps the reference running guard, single flight and dismiss refusal', async () => {
    const test = fixture()
    try {
      test.running.mockReturnValueOnce({ running: true })
      await test.controller.execute('', signal())
      expect(test.notice.set).toHaveBeenCalledWith('cannot update while the agent is running')
      const stage = Promise.withResolvers<void>()
      test.local.stage.mockReturnValueOnce(stage.promise)
      const pending = test.controller.execute('', signal())
      await answer(true)
      await vi.waitFor(() => { expect(test.local.stage).toHaveBeenCalledOnce() })
      expect(panels.at(-1)!.options.back!()).toBe(true)
      expect(test.notice.set).toHaveBeenCalledWith('The update is still running')
      await test.controller.execute('', signal())
      expect(test.notice.set).toHaveBeenCalledWith('an update is already in progress')
      stage.resolve()
      await pending
      expect(panels.at(-1)!.options.back!()).toBe(false)
    } finally { test.controller.dispose() }
  })

  it('blocks linked profiles and linked launchers using the reference blocked panel', async () => {
    const test = fixture()
    try {
      test.bundle.updatable = false
      await test.controller.execute('', signal())
      expect(text()).toContain('Blocked')
      expect(text()).toContain('nothing was changed')
      expect(text()).toContain('linked or read-only')
      expect(test.listVersions).not.toHaveBeenCalled()
      test.bundle.updatable = true
      test.local.preflight.mockRejectedValueOnce(new Error('linked launcher'))
      await test.controller.execute('', signal())
      expect(text()).toContain('linked launcher')
      expect(test.local.install).not.toHaveBeenCalled()
    } finally { test.controller.dispose() }
  })

  it('checks exact release selection, compatibility, channels, absent bundles and native failures', async () => {
    const test = fixture()
    try {
      await test.controller.execute('not-version', signal())
      expect(test.notice.set).toHaveBeenCalledWith('The update requires an exact release version')
      test.listVersions.mockResolvedValueOnce(ok({ status: 'refused', reason: 'registry offline' }))
      await test.controller.execute('', signal())
      expect(test.notice.set).toHaveBeenCalledWith('registry offline')
      test.listVersions.mockResolvedValueOnce(ok({ status: 'listed', registry: null, versions: [] }))
      await test.controller.execute('', signal())
      expect(test.notice.set).toHaveBeenCalledWith('up to date (v1.0.0)')
      await test.controller.execute('1.0.0', signal())
      expect(test.notice.set).toHaveBeenCalledWith('up to date (v1.0.0)')
      test.settings.updateChannel = 'next'
      await test.controller.execute('', signal())
      expect(test.notice.set).toHaveBeenLastCalledWith('No matching Mayfly release is published for this channel')
      test.settings.updateChannel = 'latest'
      test.listVersions.mockResolvedValueOnce(ok({ status: 'listed', registry: null, versions: [{ version: '1.1.0', tags: ['latest'], bundle: false }] }))
      await test.controller.execute('', signal())
      expect(test.notice.set).toHaveBeenCalledWith('The selected release is not a compatible Host bundle')
      test.listVersions.mockResolvedValueOnce(ok({ status: 'listed', registry: null, versions: [{ version: '1.1.0', tags: ['latest'], bundle: true, incompatible: {} }] }))
      await test.controller.execute('', signal())
      test.listBundles.mockResolvedValueOnce(ok([]))
      await test.controller.execute('', signal())
      expect(test.notice.set).toHaveBeenCalledWith('Host and TUI versions differ; repair the release set before updating')
      test.listBundles.mockRejectedValueOnce(new Error('native failed'))
      await test.controller.execute('', signal())
      expect(test.notice.set).toHaveBeenCalledWith('native failed')
    } finally { test.controller.dispose() }
  })

  it('restores the frontend after its installation fails and never mutates Host', async () => {
    const test = fixture()
    try {
      test.local.install.mockRejectedValueOnce(new Error('disk full'))
      await accepted(test)
      expect(test.local.restore).toHaveBeenCalledWith(snapshot)
      expect(test.updateBundle).not.toHaveBeenCalled()
      expect(text()).toContain('both installations restored')
      expect(text()).toContain('✓ rollback')
    } finally { test.controller.dispose() }
  })

  it('compensates both sides after native Host failure and reports incomplete restoration', async () => {
    const test = fixture()
    try {
      test.updateBundle.mockResolvedValueOnce(ok({ from: '1.0.0', to: '1.1.0', step: 'install', result: { changed: false, application: 'failed', error: { code: 'operation-error' } } } as never))
      await accepted(test)
      expect(test.installBundle).toHaveBeenCalledWith('@ephemeral-ai/mayfly-host@1.0.0', { enabled: true, saveExact: true })
      expect(test.local.restore).toHaveBeenCalledWith(snapshot)
      expect(text()).toContain('Native Host update failed')
      test.updateBundle.mockRejectedValueOnce(new Error('transport lost'))
      test.installBundle.mockRejectedValueOnce(new Error('Host restore failed'))
      test.local.restore.mockRejectedValueOnce(new Error('local restore failed'))
      await accepted(test)
      expect(text()).toContain('recovery is incomplete')
      expect(text()).toContain('npm install --global --ignore-scripts @ephemeral-ai/mayfly-cli@1.0.0')
      expect(text()).toContain('✗ rollback')
      test.updateBundle.mockResolvedValueOnce(ok({ from: '1.0.0', to: '1.1.0', step: 'install', result: { changed: false, application: 'failed' } }))
      await accepted(test)
      expect(text()).toContain('Native Host update failed')
    } finally { test.controller.dispose() }
  })

  it('restores after a mismatched Host result and honors unsuccessful recovery results', async () => {
    const test = fixture()
    try {
      test.updateBundle.mockResolvedValueOnce(ok({ from: '1.0.0', to: '1.1.0', step: 'install', result: { changed: true, application: 'restart-required' } }))
      test.installBundle.mockResolvedValueOnce(ok({ changed: false, application: 'failed' }))
      await accepted(test)
      expect(text()).toContain('The Host installed version does not match the target')
      expect(text()).toContain('recovery is incomplete')
    } finally { test.controller.dispose() }
  })

  it('rejects stage failures and Host changes/busy state before mutation', async () => {
    const test = fixture()
    try {
      test.local.stage.mockRejectedValueOnce(new Error('bad import'))
      await accepted(test)
      expect(text()).toContain('nothing was changed')
      expect(test.local.install).not.toHaveBeenCalled()
      test.listBundles.mockResolvedValueOnce(ok([{ ...test.bundle }])).mockResolvedValueOnce(ok([{ ...test.bundle, version: '1.0.1' }]))
      await accepted(test)
      expect(text()).toContain('Host release changed during preparation')
      test.running.mockReturnValueOnce({ running: false }).mockReturnValueOnce({ running: true })
      await accepted(test)
      expect(text()).toContain('cannot update while the agent is running')
      expect(test.updateBundle).not.toHaveBeenCalled()
    } finally { test.controller.dispose() }
  })

  it('drops late reads and confirmation after reconnect/unload while leaving native work alone', async () => {
    const test = fixture()
    try {
      const early = Promise.withResolvers<Awaited<ReturnType<typeof test.listBundles>>>()
      test.listBundles.mockReturnValueOnce(early.promise)
      const pending = test.controller.execute('', signal())
      test.reconnect()
      early.resolve(ok([{ ...test.bundle }]))
      await pending
      expect(panels).toEqual([])
      const confirm = test.controller.execute('', signal())
      await vi.waitFor(() => { expect(panels.at(-1)?.options.id).toBe('mayfly.update.confirm'); expect(panels.at(-1)!.close).not.toHaveBeenCalled() })
      test.reconnect()
      await confirm
      expect(test.local.stage).not.toHaveBeenCalled()
      const stage = Promise.withResolvers<void>()
      test.local.stage.mockReturnValueOnce(stage.promise)
      const staging = test.controller.execute('', signal())
      await answer(true)
      await vi.waitFor(() => { expect(test.local.stage).toHaveBeenCalledOnce() })
      test.controller.dispose()
      stage.resolve()
      await staging
      expect(test.local.install).not.toHaveBeenCalled()
    } finally { test.controller.dispose() }
  })

  it('handles aborted commands, no Host and a disposed mount', async () => {
    const test = fixture()
    try {
      await test.controller.execute('', AbortSignal.abort())
      expect(test.listBundles).not.toHaveBeenCalled()
      test.hosts.current.mockReturnValue(undefined)
      test.hosts.active.mockReturnValue(undefined)
      await test.controller.execute('', signal())
      expect(test.notice.set).toHaveBeenCalledWith('No Host is attached')
      test.hosts.active.mockReturnValue(test.client)
      test.controller.dispose()
      await test.controller.execute('', signal())
      expect(test.listBundles).not.toHaveBeenCalled()
      const dispose = mountRemoteUpdate(test.context)
      expect(test.register).toHaveBeenCalledWith(expect.objectContaining({ name: 'update', scope: 'sessionless', input: { hint: '[<version>|recover]' } }))
      dispose()
      expect(test.unregister).toHaveBeenCalledOnce()
    } finally { test.controller.dispose() }
  })
})


describe('interrupted update recovery and explicit releases', () => {
  it('accepts explicit versions omitted by the capped newer-only list and uses native install for downgrades', async () => {
    const test = fixture()
    try {
      test.listVersions.mockResolvedValueOnce(ok({ status: 'listed', registry: 'https://registry.example', versions: [] }))
      await accepted(test, '1.1.0')
      expect(test.updateBundle).toHaveBeenCalledWith('@ephemeral-ai/mayfly-host', '1.1.0', { registry: 'https://registry.example' })
      test.listBundles.mockResolvedValueOnce(ok([{ ...test.bundle }])).mockResolvedValueOnce(ok([{ ...test.bundle }])).mockResolvedValueOnce(ok([{ ...test.bundle, version: '0.9.0' }]))
      test.local.preflight.mockResolvedValueOnce({ ...snapshot, target: '0.9.0' })
      await accepted(test, '0.9.0')
      expect(test.installBundle).toHaveBeenCalledWith('@ephemeral-ai/mayfly-host@0.9.0', { registry: null, enabled: true, saveExact: true })
      expect(text()).toContain('Updated Host and TUI to v0.9.0')
    } finally { test.controller.dispose() }
  })

  it('requires the exact interrupted Host and an explicit recovery confirmation, then verifies both restored versions', async () => {
    const test = fixture()
    try {
      const recovery = { snapshot, host: 'one', enabled: false }
      test.local.pending.mockResolvedValue(recovery)
      await test.controller.execute('', signal())
      expect(text()).toContain('/update recover')
      expect(panels.at(-1)!.options.back!()).toBe(false)
      expect(panels.at(-1)!.options.isCurrent!()).toBe(true)
      const pending = test.controller.execute('recover', signal())
      await vi.waitFor(() => { expect(text()).toContain('Restore to v1.0.0') })
      await answer(true)
      await pending
      expect(test.installBundle).toHaveBeenCalledWith('@ephemeral-ai/mayfly-host@1.0.0', { enabled: false, saveExact: true })
      expect(test.local.restore).toHaveBeenCalledWith(snapshot)
      expect(test.local.finish).toHaveBeenCalledWith(snapshot)
      expect(text()).toContain('Recovered Host and TUI to v1.0.0')
      expect(panels.at(-1)!.options.back!()).toBe(false)
      test.local.pending.mockResolvedValueOnce({ ...recovery, host: 'other' })
      await test.controller.execute('recover', signal())
      expect(test.notice.set).toHaveBeenCalledWith('The interrupted update belongs to a different Host; attach that Host before recovery.')
      test.local.pending.mockResolvedValueOnce(undefined)
      await test.controller.execute('recover', signal())
      expect(test.notice.set).toHaveBeenCalledWith('No interrupted update needs recovery')
      test.bundle.updatable = false
      test.local.pending.mockResolvedValueOnce(undefined)
      await test.controller.execute('recover', signal())
      expect(test.notice.set).toHaveBeenLastCalledWith('No interrupted update needs recovery')
      test.local.pending.mockResolvedValueOnce(recovery)
      const cancelled = test.controller.execute('recover', signal())
      await answer(false)
      await cancelled
    } finally { test.controller.dispose() }
  })

  it('retains interrupted ownership and concrete repair commands when either restore or final verification fails', async () => {
    const test = fixture()
    try {
      test.local.pending.mockResolvedValue({ snapshot, host: 'one', enabled: true })
      test.installBundle.mockResolvedValueOnce(ok({ changed: false, application: 'failed' }))
      test.local.restore.mockRejectedValueOnce(new Error('offline cache missing'))
      await accepted(test, 'recover')
      expect(text()).toContain('recovery is incomplete')
      expect(text()).toContain('npm install --global --ignore-scripts')
      expect(test.local.finish).not.toHaveBeenCalled()
      test.installBundle.mockRejectedValueOnce(new Error('Host offline'))
      await accepted(test, 'recover')
      test.listBundles.mockResolvedValueOnce(ok([{ ...test.bundle }])).mockResolvedValueOnce(ok([{ ...test.bundle, version: '1.1.0' }]))
      await accepted(test, 'recover')
      expect(text()).toContain('✗ rollback')
      test.local.finish.mockRejectedValueOnce(new Error('marker locked'))
      await accepted(test, 'recover')
      expect(text()).toContain('recovery is incomplete')
    } finally { test.controller.dispose() }
  })

  it('keeps a recovery in flight despite UI cancellation and never publishes its late result', async () => {
    const test = fixture()
    try {
      test.local.pending.mockResolvedValue({ snapshot, host: 'one', enabled: true })
      const restore = Promise.withResolvers<void>()
      test.local.restore.mockReturnValueOnce(restore.promise)
      const pending = test.controller.execute('recover', signal())
      await answer(true)
      await vi.waitFor(() => { expect(test.local.restore).toHaveBeenCalledOnce() })
      expect(panels.at(-1)!.options.back!()).toBe(true)
      const refreshes = panels.at(-1)!.refresh.mock.calls.length
      test.reconnect()
      restore.resolve()
      await pending
      expect(test.local.finish).toHaveBeenCalledWith(snapshot)
      expect(panels.at(-1)!.refresh.mock.calls.length).toBe(refreshes)
    } finally { test.controller.dispose() }
  })
})

describe('upgrade late-result ownership', () => {
  it('retires pending metadata/version/preflight reads and failed reads after reconnect', async () => {
    const test = fixture()
    try {
      const metadata = Promise.withResolvers<undefined>()
      test.local.pending.mockReturnValueOnce(metadata.promise)
      const first = test.controller.execute('', signal())
      await vi.waitFor(() => { expect(test.local.pending).toHaveBeenCalledOnce() })
      test.reconnect(); metadata.resolve(undefined); await first
      expect(test.listVersions).not.toHaveBeenCalled()
      const versions = Promise.withResolvers<unknown>()
      test.listVersions.mockReturnValueOnce(versions.promise)
      const second = test.controller.execute('', signal())
      await vi.waitFor(() => { expect(test.listVersions).toHaveBeenCalledOnce() })
      test.reconnect(); versions.resolve(ok({ status: 'listed', versions: [] })); await second
      expect(test.local.preflight).not.toHaveBeenCalled()
      for (const rejected of [false, true]) {
        const preflight = Promise.withResolvers<LocalUpdateSnapshot>()
        test.local.preflight.mockReturnValueOnce(preflight.promise)
        const pending = test.controller.execute('', signal())
        await vi.waitFor(() => { expect(test.local.preflight).toHaveBeenCalledTimes(rejected ? 2 : 1) })
        test.reconnect()
        if (rejected) preflight.reject(new Error('late preflight'))
        else preflight.resolve(snapshot)
        await pending
      }
      const read = Promise.withResolvers<Awaited<ReturnType<typeof test.listBundles>>>()
      test.listBundles.mockReturnValueOnce(read.promise)
      const last = test.controller.execute('', signal())
      test.reconnect(); read.reject(new Error('late native failure')); await last
      expect(panels).toEqual([])
      expect(test.notice.set).not.toHaveBeenCalled()
    } finally { test.controller.dispose() }
  })

  it('handles already-closed confirmations, unrelated actions, and callbacks from retired progress panels', async () => {
    const test = fixture()
    try {
      opened.mockImplementationOnce(() => ({ closed: true, close: vi.fn(), refresh: vi.fn() }))
      await test.controller.execute('', signal())
      expect(test.notice.set).toHaveBeenCalledWith('update cancelled')
      const pending = test.controller.execute('', signal())
      await vi.waitFor(() => { expect(panels.at(-1)?.options.id).toBe('mayfly.update.confirm') })
      expect(await panels.at(-1)!.options.action!({ kind: 'change' } as never, {} as never)).toEqual({ kind: 'completed' })
      expect(await panels.at(-1)!.options.action!({ kind: 'activate', actionId: 'unrelated' } as never, {} as never)).toEqual({ kind: 'completed' })
      await answer(true); await pending
      const retired = panels.at(-1)!
      test.listBundles.mockResolvedValueOnce(ok([{ ...test.bundle }]))
      test.local.cleanup.mockRejectedValueOnce(new Error('cleanup denied'))
      await accepted(test)
      retired.options.onClosed!()
      expect(panels.at(-1)!.options.isCurrent!()).toBe(true)
      test.local.cleanup.mockRejectedValueOnce(new Error('cleanup denied'))
      test.bundle.updatable = false
      await test.controller.execute('', signal())
    } finally { test.controller.dispose() }
  })

  it('fences stale pre-mutation checks and releases the marker if attachment changes while claiming it', async () => {
    const test = fixture()
    try {
      const check = Promise.withResolvers<Awaited<ReturnType<typeof test.listBundles>>>()
      test.listBundles.mockResolvedValueOnce(ok([{ ...test.bundle }])).mockReturnValueOnce(check.promise)
      const first = test.controller.execute('', signal())
      await answer(true)
      await vi.waitFor(() => { expect(test.listBundles).toHaveBeenCalledTimes(2) })
      test.reconnect(); check.resolve(ok([{ ...test.bundle }])); await first
      expect(test.local.install).not.toHaveBeenCalled()
      test.local.begin.mockImplementationOnce(async () => { test.reconnect() })
      await accepted(test)
      expect(test.local.finish).toHaveBeenCalledWith(snapshot)
      expect(test.local.install).not.toHaveBeenCalled()
    } finally { test.controller.dispose() }
  })

  it('finishes mutation on the captured Host after detach and retains ownership when final marker cleanup fails', async () => {
    const test = fixture()
    try {
      const install = Promise.withResolvers<void>()
      test.local.install.mockReturnValueOnce(install.promise)
      const pending = test.controller.execute('', signal())
      await answer(true)
      await vi.waitFor(() => { expect(test.local.install).toHaveBeenCalledOnce() })
      test.reconnect()
      const refreshes = panels.at(-1)!.refresh.mock.calls.length
      install.resolve(); await pending
      expect(test.updateBundle).toHaveBeenCalledOnce()
      expect(panels.at(-1)!.refresh.mock.calls.length).toBe(refreshes)
      test.listBundles.mockResolvedValueOnce(ok([{ ...test.bundle }])).mockResolvedValueOnce(ok([{ ...test.bundle }]))
      test.local.finish.mockRejectedValueOnce(new Error('cannot clear marker')).mockRejectedValueOnce(new Error('cannot clear restored marker'))
      await accepted(test)
      expect(text()).toContain('recovery is incomplete')
      test.updateBundle.mockResolvedValueOnce(ok({ from: '1.0.0', to: '1.1.0', step: 'install', result: { changed: false, application: 'cancelled', error: { diagnostic: 'native cancelled' } } } as never))
      test.listBundles.mockResolvedValueOnce(ok([{ ...test.bundle }])).mockResolvedValueOnce(ok([{ ...test.bundle }])).mockResolvedValueOnce(ok([{ ...test.bundle, version: 'wrong' }]))
      await accepted(test)
      expect(text()).toContain('native cancelled')
      expect(text()).toContain('recovery is incomplete')
    } finally { test.controller.dispose() }
  })
})
