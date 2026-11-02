import { afterEach, describe, expect, it, vi } from 'vitest'
import { configurationFixture } from './configuration-fixture.ts'
import { createRemoteConfigurationFeatures, type RemoteConfigurationMountContext, type RemoteConfigurationAdapters } from '../../src/remote/features/configuration.ts'
const mocks = vi.hoisted(() => ({ preferences: vi.fn(async (_client: unknown) => {}), ready: vi.fn(async (_client: unknown) => {}), disposed: vi.fn(), translator: undefined as undefined | ((key: string, values?: Readonly<Record<string, string | number>>) => string) }))
vi.mock('../../src/remote/features/models.ts', () => ({ RemoteModelsController: class { dispose = mocks.disposed } }))
vi.mock('../../src/remote/features/account.ts', () => ({ RemoteAccountController: class { dispose = mocks.disposed } }))
vi.mock('../../src/remote/features/providers.ts', () => ({ RemoteProvidersController: class { dispose = mocks.disposed } }))
vi.mock('../../src/remote/features/permissions.ts', () => ({ RemotePermissionsController: class { dispose = mocks.disposed } }))
vi.mock('../../src/remote/features/presets.ts', () => ({ RemoteAgentPresetsController: class { dispose = mocks.disposed } }))
vi.mock('../../src/remote/features/onboarding.ts', () => ({ RemoteOnboardingController: class { dispose = mocks.disposed; onReady = mocks.ready } }))
vi.mock('../../src/remote/features/preferences.ts', () => ({ RemotePreferencesController: class { dispose = mocks.disposed; applyHostPreferences = mocks.preferences; constructor(context: { t: typeof mocks.translator }) { mocks.translator = context.t } } }))
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.clearAllMocks() })
function fixture() {
  const first = configurationFixture(vi.fn(), { session: false })
  const second = configurationFixture(vi.fn(), { session: false })
  const features = createRemoteConfigurationFeatures(first.context as unknown as RemoteConfigurationMountContext, {} as RemoteConfigurationAdapters)
  cleanups.push(() => { features.dispose(); first.dispose(); second.dispose() })
  return { first, second, features }
}

describe('Remote configuration Host preference subscriptions', () => {
  it('syncs startup once and reacts only to selected Host Mayfly document changes or reconnect readiness', () => {
    const { first } = fixture()
    expect(mocks.preferences).toHaveBeenCalledExactlyOnceWith(first.client)
    expect(mocks.ready).toHaveBeenCalledExactlyOnceWith(first.client)
    first.emit('settings/document-updated', 'other', 2)
    expect(mocks.preferences).toHaveBeenCalledOnce()
    first.emit('settings/document-updated', 'mayfly', 3)
    expect(mocks.preferences).toHaveBeenCalledTimes(2)
    first.reconnect()
    expect(mocks.preferences).toHaveBeenCalledTimes(3)
  })

  it('changes active Host once, ignores background Host events, and reuses existing subscriptions on return', () => {
    const { first, second } = fixture()
    first.active(second.client)
    expect(mocks.preferences).toHaveBeenLastCalledWith(second.client)
    expect(mocks.ready).toHaveBeenCalledTimes(2)
    expect(first.events.get('settings/document-updated')?.size).toBe(1)
    expect(second.events.get('settings/document-updated')?.size).toBe(1)
    const count = mocks.preferences.mock.calls.length
    first.emit('settings/document-updated', 'mayfly', 3)
    first.reconnect()
    expect(mocks.preferences).toHaveBeenCalledTimes(count)
    second.emit('settings/document-updated', 'mayfly', 3)
    expect(mocks.preferences).toHaveBeenCalledTimes(count + 1)
    first.active(first.client)
    expect(mocks.preferences).toHaveBeenLastCalledWith(first.client)
    expect(mocks.ready).toHaveBeenCalledTimes(2)
    expect(first.events.get('settings/document-updated')?.size).toBe(1)
  })

  it('falls back to the complete reference catalog for account/onboarding copy and retains Remote-specific translations', () => {
    const { first } = fixture()
    first.locale.setPreference('zh')
    expect(mocks.translator!('Sign in with your DeepSeek account — models are billed to it and need no API key.')).toBe('使用 DeepSeek 账号登录——模型按该账号计费，无需 API key。')
    expect(mocks.translator!('Permission preset: {preset}', { preset: 'Safe' })).toBe('权限预设：Safe')
    expect(mocks.translator!('Unknown future message {value}', { value: 'plain' })).toBe('Unknown future message plain')
  })

  it('removes listeners on detach/unload and never restarts onboarding or preferences after teardown', () => {
    const { first, features } = fixture()
    first.detach()
    expect(first.events.get('settings/document-updated')?.size).toBe(0)
    expect(first.stateListeners.size).toBe(0)
    features.dispose()
    features.dispose()
    expect(first.topology.size).toBe(0)
    first.active(first.client)
    first.emit('settings/document-updated', 'mayfly', 4)
    expect(mocks.preferences).toHaveBeenCalledOnce()
    expect(mocks.ready).toHaveBeenCalledOnce()
  })
})
