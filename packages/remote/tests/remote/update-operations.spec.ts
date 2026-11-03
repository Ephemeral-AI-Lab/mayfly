/** Native Host and frontend-local upgrade transaction/lifecycle contracts. @module tests/remote/update-operations */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DECISION_NO, DECISION_YES } from '@ephemeral-ai/mayfly-ui'
import type { HostClient } from '../../src/client/types.ts'
import type { RemoteOperationsContext } from '../../src/remote/operations/support.ts'
import type { RemoteBrowserOptions } from '../../src/remote/panels/browser.ts'
import { RemoteUpdateController, mountRemoteUpdate } from '../../src/remote/operations/update.ts'
import type { LocalFrontendUpdater, LocalUpdateSnapshot } from '../../src/remote/operations/local-update.ts'
import { registerTempDirCleanup } from '../../../mayfly/tests/core/temp-dir.ts'
import { nativeUpdateHost } from './update-native-fixture.ts'

registerTempDirCleanup()

const opened = vi.hoisted(() => vi.fn())
const registryDelay = vi.hoisted(() => vi.fn())
vi.mock('../../src/remote/panels/browser.ts', () => ({ openRemoteBrowser: opened }))
vi.mock('../../src/remote/features/version.ts', () => ({ remoteClientVersion: () => '1.0.0' }))
vi.mock('node:timers/promises', () => ({ setTimeout: registryDelay }))

const snapshot: LocalUpdateSnapshot = { current: '1.0.0', target: '1.1.0', root: '/npm/@ephemeral-ai/mayfly-cli', directory: '/tmp/update', logPath: '/tmp/update/update.log', lockPath: '/npm/@ephemeral-ai/.mayfly-update.json' }
const ok = <T>(value: T) => ({ ok: true as const, value })
const signal = () => new AbortController().signal
let panels: Array<{ options: RemoteBrowserOptions, refresh: ReturnType<typeof vi.fn<() => void>>, close: ReturnType<typeof vi.fn<() => void>> }>

beforeEach(() => {
  panels = []
  registryDelay.mockReset().mockResolvedValue(undefined)
  opened.mockImplementation((_base, options: RemoteBrowserOptions) => {
    let closed = false
    const panel = { options, refresh: vi.fn(), close: vi.fn(() => { if (closed) return; closed = true; options.onClosed?.() }), get closed() { return closed } }
    panels.push(panel)
    return panel
  })
})
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

function fixture() {
  let installed: string | undefined = '1.0.0'
  let generation = 1
  const listeners = new Set<() => void>()
  const states = new Set<() => void>()
  const bundle = { name: '@ephemeral-ai/mayfly-host', installed: true, enabled: true, updatable: true, version: '1.0.0' }
  const listBundles = vi.fn(async () => ok(installed === undefined ? [] : [{ ...bundle, version: installed }]))
  const listVersions = vi.fn(async (): Promise<unknown> => ok({ status: 'listed', registry: null, installed: '1.0.0', versions: [{ version: '1.1.0', tags: ['latest'], bundle: true }], omitted: 0 }))
  const updateBundle = vi.fn(async () => { installed = '1.1.0'; return ok({ from: '1.0.0', to: '1.1.0', step: 'install', result: { changed: true, application: 'restart-required' } }) })
  const installBundle = vi.fn(async (spec: string, options?: { enabled?: boolean }): Promise<unknown> => { installed = spec.slice(spec.lastIndexOf('@') + 1); bundle.enabled = options?.enabled !== false; return ok({ changed: true, application: 'restart-required' }) })
  const removeBundle = vi.fn(async (): Promise<unknown> => { installed = undefined; bundle.enabled = false; return ok({ changed: true, application: 'applied' }) })
  const setBundleEnabled = vi.fn(async (_name: string, enabled: boolean): Promise<unknown> => { bundle.enabled = enabled; return ok({ changed: true, application: 'applied' }) })
  const client = { key: 'one', remote: { pluginManager: { listBundles, listVersions, updateBundle, installBundle, removeBundle, setBundleEnabled } }, state: { getSnapshot: () => ({ generation }), subscribe: (listener: () => void) => { states.add(listener); return () => { states.delete(listener) } } } } as unknown as HostClient
  const running = vi.fn(() => ({ running: false }))
  const selection = { client, ref: { host: 'one', sessionId: 's1' }, binding: { session: { getSnapshot: running } } }
  const hosts = {
    current: vi.fn((): typeof selection | undefined => selection), active: vi.fn((): HostClient | undefined => client), list: vi.fn(() => [client]),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const locale = { register: vi.fn(), subscribe: vi.fn(() => () => {}), translate: vi.fn((_ns: string, key: string, values: Record<string, unknown> = {}) => key.replace(/\{(\w+)\}/gu, (_match, name: string) => String(values[name] ?? name))) }
  const effect = vi.fn((factory: () => unknown) => { const dispose = factory(); return () => { if (typeof dispose === 'function') dispose() } })
  const settings = { updateChannel: 'latest' }
  const notifications = { report: vi.fn(), clear: vi.fn(), dispose: vi.fn() }
  const ctx = { mayflyUiInteraction: { createNotificationOwner: vi.fn(() => notifications) }, effect, get: (name: string) => name === 'mayflyLocale' ? locale : name === 'mayflyInteractionState' ? { settingsSource: () => settings } : undefined, mayflyLocale: locale, inject: (_deps: readonly string[], callback: (scope: unknown) => void) => { callback({ effect, mayflyLocale: locale }) } }
  const notice = { set: vi.fn() }
  const unregister = vi.fn()
  const register = vi.fn(() => unregister)
  const base = { hosts, ctx, notice, commands: { register }, subscribeLocale: vi.fn(() => () => {}) }
  const context = { base } as unknown as RemoteOperationsContext
  const local = { releases: vi.fn(async () => ({ tags: { latest: '1.1.0' } as Record<string, string>, versions: ['1.0.0', '1.1.0', '0.9.0'], time: {} as Record<string, string> })), pending: vi.fn(async (): Promise<import('../../src/remote/operations/local-update.ts').PendingLocalUpdate | undefined> => undefined), begin: vi.fn(async () => {}), finish: vi.fn(async () => {}), preflight: vi.fn(async () => snapshot), stage: vi.fn(async () => {}), install: vi.fn(async () => {}), restore: vi.fn(async () => {}), cleanup: vi.fn(async () => {}) }
  const controller = new RemoteUpdateController(context, local as unknown as LocalFrontendUpdater)
  const change = () => { for (const listener of listeners) listener() }
  const reconnect = () => { generation += 1; for (const listener of states) listener() }
  return { controller, context, local, hosts, notice, notifications, client, running, bundle, listBundles, listVersions, updateBundle, installBundle, removeBundle, setBundleEnabled, register, unregister, settings, change, reconnect,
    setInstalled: (version: string | undefined) => { installed = version },
  }
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
  it('resolves complete frontend tags before the capped Host list and never guesses missing or invalid targets', async () => {
    const test = fixture()
    try {
      test.local.releases.mockResolvedValueOnce({ tags: { latest: '0.9.0' }, versions: ['0.9.0'], time: {} })
      await test.controller.execute('', signal())
      expect(test.notice.set).toHaveBeenCalledWith('up to date (v1.0.0; latest tag: 0.9.0)', 'info')
      expect(test.listVersions).not.toHaveBeenCalled()
      test.local.releases.mockResolvedValueOnce({ tags: { latest: 'not-semver' }, versions: [], time: {} })
      await test.controller.execute('', signal())
      expect(test.notice.set).toHaveBeenLastCalledWith('the "latest" tag points at "not-semver", which does not parse as a version', 'error')
      await test.controller.execute('3.0.0', signal())
      expect(text()).toContain('version 3.0.0 is not published under @ephemeral-ai/mayfly (registry knows: 1.0.0, 1.1.0, 0.9.0)')
      test.local.releases.mockResolvedValueOnce({ tags: {}, versions: ['0.0.1'], time: {} })
      await test.controller.execute('0.0.1', signal())
      expect(text()).toContain("version 0.0.1 predates Mayfly's first release; pick >= 0.1.0-alpha.1")
      expect(test.listVersions).not.toHaveBeenCalled()
      expect(test.local.install).not.toHaveBeenCalled()
    } finally { test.controller.dispose() }
  })

  it.each([
    ['2026-11-01T00:00:00Z', 'published 3d ago', true],
    ['2026-11-03T16:00:00Z', 'published 8h ago', false],
    ['2026-11-05T00:00:00Z', 'published 0h ago', true],
    ['invalid', 'warning: publish time unknown — cooldown cannot be forecast', false],
  ] as const)('shows native publish-age details for %s while keeping actual Host policy visible', async (stamp, expected, fromHost) => {
    const test = fixture()
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-04T00:00:00Z'))
    try {
      if (fromHost) test.listVersions.mockResolvedValueOnce(ok({ status: 'listed', registry: null, versions: [{ version: '1.1.0', tags: ['latest'], bundle: true, publishedAt: stamp }] }))
      else test.local.releases.mockResolvedValueOnce({ tags: { latest: '1.1.0' }, versions: ['1.1.0'], time: { '1.1.0': stamp } })
      const pending = test.controller.execute('', signal())
      await vi.waitFor(() => { expect(panels.at(-1)?.options.id).toBe('mayfly.update.confirm') })
      expect(text()).toContain(expected)
      expect(text()).toContain('The Host enforces its release-age policy during installation; its cooldown setting is not exposed.')
      await answer(false)
      await pending
      expect(test.local.install).not.toHaveBeenCalled()
    } finally { test.controller.dispose() }
  })

  it('reports registry progress and both bounded retries, then clears progress before confirmation', async () => {
    const test = fixture()
    try {
      test.local.releases.mockRejectedValueOnce(new Error('first registry failure')).mockRejectedValueOnce(new Error('second registry failure'))
      const pending = test.controller.execute('', signal())
      await vi.waitFor(() => { expect(panels.at(-1)?.options.id).toBe('mayfly.update.confirm') })
      expect(test.notifications.report).toHaveBeenCalledWith('registry', { kind: 'app', targetId: 'profile/one' }, { message: 'checking the registry for @ephemeral-ai/mayfly updates…', severity: 'info', purpose: 'progress' }, 'registry')
      expect(test.notifications.report).toHaveBeenCalledWith('registry', expect.anything(), { message: 'registry unreachable, retrying (2/3)…', severity: 'warning', purpose: 'progress' }, 'registry')
      expect(test.notifications.report).toHaveBeenLastCalledWith('registry', expect.anything(), { message: 'registry unreachable, retrying (3/3)…', severity: 'warning', purpose: 'progress' }, 'registry')
      expect(registryDelay.mock.calls.map(call => call[0])).toEqual([1_500, 4_000])
      expect(test.local.releases).toHaveBeenCalledTimes(3)
      expect(test.notifications.clear).toHaveBeenCalledWith('registry')
      expect(panels.at(-1)?.options.id).toBe('mayfly.update.confirm')
      await panels.at(-1)!.options.action!({ kind: 'activate', actionId: DECISION_NO } as never, {} as never)
      await pending
    } finally { test.controller.dispose() }
  })

  it('stops exhausted registry retries with one error and retires an aborted retry timer without another read', async () => {
    const test = fixture()
    try {
      test.local.releases.mockRejectedValue(new Error('registry unavailable'))
      const exhausted = test.controller.execute('', signal())
      await exhausted
      expect(test.local.releases).toHaveBeenCalledTimes(3)
      expect(test.notice.set).toHaveBeenCalledExactlyOnceWith('registry unavailable', 'error')
      test.notice.set.mockClear()
      const caller = new AbortController()
      registryDelay.mockImplementationOnce((_duration: number, _value: unknown, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => { reject(new Error('retry cancelled')) }, { once: true })
      }))
      const cancelled = test.controller.execute('', caller.signal)
      await vi.waitFor(() => { expect(registryDelay).toHaveBeenCalledTimes(3) })
      caller.abort()
      await cancelled
      expect(test.local.releases).toHaveBeenCalledTimes(4)
      expect(test.notice.set).not.toHaveBeenCalled()
      expect(panels).toEqual([])
      expect(test.notifications.clear).toHaveBeenCalledWith('registry')
    } finally { test.controller.dispose() }
  })

  it.each([false, true])('retires successful or failed canonical release reads after reconnect (reject=%s)', async reject => {
    const test = fixture()
    try {
      const response = Promise.withResolvers<Awaited<ReturnType<typeof test.local.releases>>>()
      test.local.releases.mockReturnValueOnce(response.promise)
      const pending = test.controller.execute('', signal())
      await vi.waitFor(() => { expect(test.local.releases).toHaveBeenCalledOnce() })
      test.reconnect()
      expect(test.notifications.clear).toHaveBeenCalledWith('registry')
      if (reject) response.reject(new Error('retired registry failure'))
      else response.resolve({ tags: { latest: '1.1.0' }, versions: ['1.1.0'], time: {} })
      await pending
      expect(test.listVersions).not.toHaveBeenCalled()
      expect(test.notice.set).not.toHaveBeenCalled()
      expect(test.notifications.report).toHaveBeenCalledOnce()
      expect(panels).toEqual([])
    } finally { test.controller.dispose() }
  })

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
      expect(test.notice.set).toHaveBeenCalledWith('update cancelled', 'info')
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
      expect(test.notice.set).toHaveBeenCalledWith('the agent is running — wait for the current turn to finish before updating', 'error')
      const stage = Promise.withResolvers<void>()
      test.local.stage.mockReturnValueOnce(stage.promise)
      const pending = test.controller.execute('', signal())
      await answer(true)
      await vi.waitFor(() => { expect(test.local.stage).toHaveBeenCalledOnce() })
      expect(panels.at(-1)!.options.back!()).toBe(true)
      expect(test.notice.set).toHaveBeenCalledWith('The update is still running', 'error')
      await test.controller.execute('', signal())
      expect(test.notice.set).toHaveBeenCalledWith('an update is already in progress', 'error')
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
      expect(test.notice.set).toHaveBeenCalledWith('\"not-version\" is not a version (try /update 0.1.0-alpha.1)', 'error')
      test.listVersions.mockResolvedValueOnce(ok({ status: 'refused', reason: 'registry offline' }))
      await test.controller.execute('', signal())
      expect(test.notice.set).toHaveBeenCalledWith('registry offline', 'error')
      test.local.releases.mockResolvedValueOnce({ tags: { latest: '1.0.0' }, versions: ['1.0.0'], time: {} })
      await test.controller.execute('', signal())
      expect(test.notice.set).toHaveBeenCalledWith('up to date (v1.0.0; latest tag: 1.0.0)', 'info')
      test.settings.updateChannel = 'next'
      await test.controller.execute('', signal())
      expect(test.notice.set).toHaveBeenLastCalledWith('the registry carries no \"next\" tag for @ephemeral-ai/mayfly — pick a version with /update <version>', 'error')
      test.settings.updateChannel = 'latest'
      test.listVersions.mockResolvedValueOnce(ok({ status: 'listed', registry: null, versions: [{ version: '1.1.0', tags: ['latest'], bundle: false }] }))
      await test.controller.execute('', signal())
      expect(test.notice.set).toHaveBeenCalledWith('The selected release is not a compatible Host bundle', 'error')
      test.listVersions.mockResolvedValueOnce(ok({ status: 'listed', registry: null, versions: [{ version: '1.1.0', tags: ['latest'], bundle: true, incompatible: {} }] }))
      await test.controller.execute('', signal())
      test.listBundles.mockResolvedValueOnce(ok([]))
      await test.controller.execute('', signal())
      expect(test.notice.set).toHaveBeenCalledWith('Host and TUI versions differ; repair the release set before updating', 'error')
      test.listBundles.mockRejectedValueOnce(new Error('native failed'))
      await test.controller.execute('', signal())
      expect(test.notice.set).toHaveBeenCalledWith('native failed', 'error')
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
      expect(test.installBundle).not.toHaveBeenCalled()
      expect(test.removeBundle).not.toHaveBeenCalled()
      expect(test.local.restore).toHaveBeenCalledWith(snapshot)
      expect(text()).toContain('Native Host update failed')
      test.updateBundle.mockImplementationOnce(async () => { test.setInstalled('1.1.0'); throw new Error('transport lost') })
      test.installBundle.mockRejectedValueOnce(new Error('Host restore failed'))
      test.local.restore.mockRejectedValueOnce(new Error('local restore failed'))
      await accepted(test)
      expect(text()).toContain('recovery is incomplete')
      expect(text()).toContain('npm install --global --ignore-scripts @ephemeral-ai/mayfly-cli@1.0.0')
      expect(text()).toContain('✗ rollback')
      test.setInstalled('1.0.0')
      test.updateBundle.mockResolvedValueOnce(ok({ from: '1.0.0', to: '1.1.0', step: 'install', result: { changed: false, application: 'failed' } }))
      await accepted(test)
      expect(text()).toContain('Native Host update failed')
    } finally { test.controller.dispose() }
  })

  it('restores after a mismatched Host result and honors unsuccessful recovery results', async () => {
    const test = fixture()
    try {
      test.updateBundle.mockImplementationOnce(async () => { test.setInstalled('1.1.0'); return ok({ from: '1.0.0', to: '1.1.0', step: 'install', result: { changed: true, application: 'restart-required' } }) })
      test.listBundles.mockResolvedValueOnce(ok([{ ...test.bundle }])).mockResolvedValueOnce(ok([{ ...test.bundle }])).mockResolvedValueOnce(ok([{ ...test.bundle, version: 'unexpected-observation' }]))
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
      expect(text()).toContain('the agent is running — wait for the current turn to finish before updating')
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
      expect(test.notice.set).toHaveBeenCalledWith('No Host is attached', 'error')
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
  it('recovers an update interrupted after native removal even when no Host bundle is listed', async () => {
    const test = fixture()
    try {
      test.setInstalled(undefined)
      test.local.pending.mockResolvedValue({ snapshot, host: 'one', enabled: true })
      await accepted(test, 'recover')
      expect(test.installBundle).toHaveBeenCalledWith('@ephemeral-ai/mayfly-host@1.0.0', { enabled: true, saveExact: true })
      expect(test.removeBundle).not.toHaveBeenCalled()
      expect(text()).toContain('Recovered Host and TUI to v1.0.0')
    } finally { test.controller.dispose() }
  })

  it.each([
    ['changed', 'The Host release changed before removal'],
    ['retained', 'Host removal did not release the installed bundle'],
    ['remove-failed', 'Host removal failed: bundle-in-use'],
    ['version-mismatch', 'The restored Host version or enablement does not match'],
    ['enablement-mismatch', 'The restored Host version or enablement does not match'],
    ['cancelled', 'Host installation failed: cancelled'],
  ] as const)('preserves the failing native recovery stage and keeps its marker (%s)', async (failure, diagnostic) => {
    const test = fixture()
    try {
      test.setInstalled('1.1.0')
      test.local.pending.mockResolvedValue({ snapshot, host: 'one', enabled: true })
      if (failure === 'version-mismatch') test.installBundle.mockResolvedValueOnce(ok({ changed: true, application: 'applied' }))
      else if (failure === 'enablement-mismatch') test.installBundle.mockImplementationOnce(async () => { test.setInstalled('1.0.0'); test.bundle.enabled = false; return ok({ changed: true, application: 'applied' }) })
      else if (failure === 'cancelled') test.installBundle.mockResolvedValueOnce(ok({ changed: false, application: 'cancelled' }))
      else {
        test.installBundle.mockImplementationOnce(async () => {
          if (failure === 'changed') test.setInstalled('2.0.0')
          return ok({ changed: false, application: 'failed', error: { code: 'already-installed' } })
        })
        if (failure === 'retained') test.removeBundle.mockResolvedValueOnce(ok({ changed: false, application: 'applied' }))
        if (failure === 'remove-failed') test.removeBundle.mockResolvedValueOnce(ok({ changed: false, application: 'failed', error: { code: 'bundle-in-use' } }))
      }
      await accepted(test, 'recover')
      expect(text()).toContain(`Host restoration failed: ${diagnostic}`)
      expect(text()).toContain('recovery is incomplete')
      expect(test.local.restore).toHaveBeenCalledWith(snapshot)
      expect(test.local.finish).not.toHaveBeenCalled()
    } finally { test.controller.dispose() }
  })

  it('observes the actual native updateBundle automatic restoration before compensating the frontend', async () => {
    const native = await nativeUpdateHost(true)
    const test = fixture()
    try {
      await native.refuse('1.1.0')
      test.listBundles.mockImplementation(async () => ok(await native.manager.listBundles()) as never)
      test.updateBundle.mockImplementation(async () => ok(await native.manager.updateBundle('@ephemeral-ai/mayfly-host', '1.1.0')) as never)
      await accepted(test)
      expect(text()).toContain('both installations restored')
      expect((await native.manifest()).dependencies['@ephemeral-ai/mayfly-host']).toBe('1.0.0')
      expect(test.local.restore).toHaveBeenCalledWith(snapshot)
      expect(test.installBundle).not.toHaveBeenCalled()
      expect(test.removeBundle).not.toHaveBeenCalled()
    } finally { test.controller.dispose(); await native.dispose() }
  })

  it.each([false, true])('uses the actual native profile lifecycle for downgrades and idempotent recovery (HMR=%s)', async hmr => {
    const native = await nativeUpdateHost(hmr)
    const test = fixture()
    try {
      if (hmr) {
        expect(await native.manager.installBundle('@ephemeral-ai/mayfly-host@0.9.0', { saveExact: true })).toMatchObject({ application: 'failed', error: { code: 'already-installed' } })
        expect((await native.manifest()).dependencies['@ephemeral-ai/mayfly-host']).toBe('1.0.0')
      }
      test.listBundles.mockImplementation(async () => ok(await native.manager.listBundles()) as never)
      test.installBundle.mockImplementation(async (spec, options) => ok(await native.manager.installBundle(spec, options)))
      test.removeBundle.mockImplementation(async () => ok(await native.manager.removeBundle('@ephemeral-ai/mayfly-host')))
      test.setBundleEnabled.mockImplementation(async (name, enabled) => ok(await native.manager.setBundleEnabled(name, enabled)))
      const downgrade = { ...snapshot, target: '0.9.0' }
      test.local.preflight.mockResolvedValueOnce(downgrade)
      await accepted(test, '0.9.0')
      expect(text()).toContain('Updated Host and TUI to v0.9.0')
      expect((await native.manifest()).dependencies['@ephemeral-ai/mayfly-host']).toBe('0.9.0')
      expect(test.removeBundle).toHaveBeenCalledTimes(hmr ? 1 : 0)
      test.local.pending.mockResolvedValue({ snapshot: downgrade, host: 'one', enabled: true })
      await accepted(test, 'recover')
      expect(text()).toContain('Recovered Host and TUI to v1.0.0')
      expect((await native.manifest()).dependencies['@ephemeral-ai/mayfly-host']).toBe('1.0.0')
      const installs = test.installBundle.mock.calls.length
      const removals = test.removeBundle.mock.calls.length
      await accepted(test, 'recover')
      expect(test.installBundle).toHaveBeenCalledTimes(installs)
      expect(test.removeBundle).toHaveBeenCalledTimes(removals)
    } finally { test.controller.dispose(); await native.dispose() }
  })

  it('accepts explicit versions omitted by the capped newer-only list and uses native install for downgrades', async () => {
    const test = fixture()
    try {
      test.listVersions.mockResolvedValueOnce(ok({ status: 'listed', registry: 'https://registry.example', versions: [] }))
      await accepted(test, '1.1.0')
      expect(test.updateBundle).toHaveBeenCalledWith('@ephemeral-ai/mayfly-host', '1.1.0', { registry: 'https://registry.example' })
      test.setInstalled('1.0.0')
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
      expect(test.setBundleEnabled).toHaveBeenCalledWith('@ephemeral-ai/mayfly-host', false)
      expect(test.installBundle).not.toHaveBeenCalled()
      expect(test.local.restore).toHaveBeenCalledWith(snapshot)
      expect(test.local.finish).toHaveBeenCalledWith(snapshot)
      expect(text()).toContain('Recovered Host and TUI to v1.0.0')
      expect(panels.at(-1)!.options.back!()).toBe(false)
      test.local.pending.mockResolvedValueOnce({ ...recovery, host: 'other' })
      await test.controller.execute('recover', signal())
      expect(test.notice.set).toHaveBeenCalledWith('The interrupted update belongs to a different Host; attach that Host before recovery.', 'error')
      test.local.pending.mockResolvedValueOnce(undefined)
      await test.controller.execute('recover', signal())
      expect(test.notice.set).toHaveBeenCalledWith('No interrupted update needs recovery', 'info')
      test.bundle.updatable = false
      test.local.pending.mockResolvedValueOnce(undefined)
      await test.controller.execute('recover', signal())
      expect(test.notice.set).toHaveBeenLastCalledWith('No interrupted update needs recovery', 'info')
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
      expect(test.notice.set).toHaveBeenCalledWith('update cancelled', 'info')
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
