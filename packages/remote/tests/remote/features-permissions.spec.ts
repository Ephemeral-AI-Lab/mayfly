import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey } from '../../src/client/types.ts'
import type { HostClient } from '../../src/client/types.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../../src/remote/features.ts'
import {
  RemotePermissionsController,
  remotePermissionSelection,
  type RemotePermissionDetailSource,
} from '../../src/remote/features/permissions.ts'
import type { RemoteSettingsController } from '../../src/remote/features/settings.ts'

interface CatalogOption {
  readonly value: string
  readonly name: string
  readonly description: string
}

interface PermissionCatalog {
  readonly options: readonly CatalogOption[]
  readonly defaultOptions: readonly CatalogOption[]
  readonly defaultPreset: string
}

function catalog(overrides: Partial<PermissionCatalog> = {}): PermissionCatalog {
  const options = [
    { value: 'default', name: 'Default', description: 'Ask before writing' },
    { value: 'acceptEdits', name: 'Accept edits', description: 'Accept file edits' },
    { value: 'yolo', name: 'Yolo', description: 'Skip every guard' },
  ]
  return { options, defaultOptions: options, defaultPreset: 'default', ...overrides }
}

function fixture(options: {
  readonly catalog?: PermissionCatalog
  readonly current?: string
  readonly session?: boolean
} = {}) {
  const listeners = new Set<() => void>()
  let snapshot: unknown = { currentValue: options.current ?? 'default' }
  const subscribeProjection = vi.fn((listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  })
  const projection = {
    getSnapshot: vi.fn(() => snapshot),
    subscribe: subscribeProjection,
  }
  const command = vi.fn(async (_line: string): Promise<unknown> => ({ ok: true, value: { matched: true } }))
  const readCatalog = vi.fn(async (): Promise<unknown> => ({ ok: true, value: options.catalog ?? catalog() }))
  const describe = vi.fn(async (): Promise<unknown> => ({
    ok: true,
    value: { writable: true, namespaces: [{ ns: 'permission', revision: 4 }] },
  }))
  const mutate = vi.fn(async (): Promise<unknown> => ({ ok: true, value: {} }))
  const client = {
    key: HostKey('local'),
    state: { getSnapshot: () => ({ generation: 1 }), subscribe: vi.fn(() => () => {}) },
    remote: {
      permissionPresets: { catalog: readCatalog },
      settings: { describe, mutate },
      $on: vi.fn(() => () => {}),
    },
  }
  const selection: RemoteFeatureSelection = {
    ref: { host: HostKey('local'), sessionId: SessionId('session-1') },
    client: client as unknown as HostClient,
    binding: {
      session: {
        projections: { faceOf: vi.fn(() => projection) },
        command,
      },
    },
  } as unknown as RemoteFeatureSelection
  let selected: RemoteFeatureSelection | undefined = options.session === false ? undefined : selection
  const hosts = {
    list: vi.fn((): readonly HostClient[] => [client as unknown as HostClient]),
    current: vi.fn((): RemoteFeatureSelection | undefined => selected),
    subscribe: vi.fn(() => () => {}),
  }
  const lease = { generation: 1, closed: false, close: vi.fn() }
  const openOverlay = vi.fn(() => lease)
  const translate = vi.fn((key: string, values?: Readonly<Record<string, string | number>>) => key.replace(
    /\{([A-Za-z][A-Za-z0-9_]*)\}/gu,
    (placeholder, name: string) => String(values?.[name] ?? placeholder),
  ))
  const context = {
    ctx: { effect: vi.fn(), inject: vi.fn(), get: vi.fn(() => undefined) },
    screen: { requestRender: vi.fn() },
    components: { truncateToWidth: (text: string) => text },
    colors: { primary: (text: string) => text, muted: (text: string) => text, accent: (text: string) => text },
    overlays: { open: openOverlay, close: vi.fn() },
    hosts,
    notice: { set: vi.fn() },
    t: translate,
    subscribeLocale: vi.fn(() => () => {}),
    presentation: {},
  } as unknown as RemoteFeatureContext
  const settings = {
    revision: vi.fn(() => 7),
    mutate,
  } as unknown as RemoteSettingsController
  const source: RemotePermissionDetailSource = {
    resolve: vi.fn(async (_client: HostClient, _currentPreset?: string) => ({
      yolo: true,
      detail: (value: string) => `detail:${value}`,
    })),
  }
  /** The panel handed to the overlay host by the last `open()`. */
  const panel = () => openOverlay.mock.calls.at(-1)![0] as unknown as {
    render(width: number): string[]
    update(model: unknown): void
    handleInput(data: string): void
  }
  /** Observe a new projected preset through the permissions projection. */
  const project = (currentValue: string): void => {
    snapshot = { currentValue }
    for (const listener of [...listeners]) listener()
  }
  return {
    context,
    hosts,
    selection,
    client,
    readCatalog,
    command,
    describe,
    mutate,
    settings,
    source,
    notice: context.notice as { set: ReturnType<typeof vi.fn> },
    lease,
    openOverlay,
    panel,
    project,
    translate,
    detach: () => { selected = undefined },
    attach: () => { selected = selection },
  }
}

describe('remotePermissionSelection', () => {
  it('reads only a string currentValue from the official permissions projection', () => {
    expect(remotePermissionSelection({ currentValue: 'acceptEdits' })).toBe('acceptEdits')
    expect(remotePermissionSelection({ currentValue: 42 })).toBeUndefined()
    expect(remotePermissionSelection({})).toBeUndefined()
    expect(remotePermissionSelection(undefined)).toBeUndefined()
    expect(remotePermissionSelection('default')).toBeUndefined()
  })
})

describe('RemotePermissionsController', () => {
  it('reads the catalog through the selected Host, falling back to the first attached one', async () => {
    const f = fixture()
    const controller = new RemotePermissionsController(f.context, f.settings)

    await expect(controller.catalog()).resolves.toEqual(catalog())
    expect(f.readCatalog).toHaveBeenCalledOnce()
    expect(f.client.remote.permissionPresets.catalog).toHaveBeenCalledOnce()

    // Without a displayed Session the read still targets the only attached Host.
    f.detach()
    await expect(controller.catalog()).resolves.toEqual(catalog())
    expect(f.readCatalog).toHaveBeenCalledTimes(2)

    // With no Host at all there is nothing to read.
    f.hosts.list.mockReturnValue([])
    await expect(controller.catalog()).resolves.toBeUndefined()
    expect(f.readCatalog).toHaveBeenCalledTimes(2)
  })

  it('opens a Session panel listing every preset with its detail and the projected current preset', async () => {
    const f = fixture({ current: 'acceptEdits' })
    const controller = new RemotePermissionsController(f.context, f.settings, f.source)

    await controller.open()

    expect(f.openOverlay).toHaveBeenCalledOnce()
    expect(f.command).not.toHaveBeenCalled()
    expect(f.mutate).not.toHaveBeenCalled()
    // The resolved bundle detail is owned by the Host adapter, once per preset.
    expect(f.source.resolve).toHaveBeenCalledWith(f.client, 'acceptEdits', expect.any(AbortSignal))

    const lines = f.panel().render(80)
    expect(lines[0]).toBe('Permissions')
    expect(lines.some(line => line.includes('Accept edits') && line.startsWith('> '))).toBe(true)
    expect(lines.some(line => line.includes('detail:default'))).toBe(true)
    expect(lines.some(line => line.includes('detail:yolo'))).toBe(true)
    // yolo disables enforcement, and the panel has to say so before it is chosen.
    expect(lines).toContain('This preset disables the sandbox and every approval')
  })

  it('switches the exact Session through /permission, notices the preset, and closes the panel', async () => {
    const f = fixture()
    const controller = new RemotePermissionsController(f.context, f.settings)

    await controller.open()
    // The panel selects the current row; moving up lands on the previous preset.
    f.panel().handleInput('\x1b[A')
    f.panel().handleInput('\r')

    await vi.waitFor(() => { expect(f.command).toHaveBeenCalledOnce() })
    expect(f.command).toHaveBeenCalledWith('/permission yolo')
    await vi.waitFor(() => { expect(f.notice.set).toHaveBeenCalledWith('Permission preset: yolo') })
    expect(f.lease.close).toHaveBeenCalledOnce()
    expect(f.mutate).not.toHaveBeenCalled()
  })

  it('refuses a preset the catalog does not offer and reports the Host failure as a notice', async () => {
    const f = fixture()
    const controller = new RemotePermissionsController(f.context, f.settings)

    // A stale Session identity never writes: the exact Host/Session fence wins.
    await controller.select({ host: HostKey('other'), sessionId: SessionId('session-1') }, 'yolo')
    expect(f.command).not.toHaveBeenCalled()

    // An unknown preset is refused before the Session command is sent. NOTE: this
    // rejects instead of noticing (permissions.ts:202); only the panel path catches.
    await expect(controller.select(f.selection.ref, 'ghost')).rejects.toThrow('permission command is unavailable')
    expect(f.command).not.toHaveBeenCalled()

    // The panel path is the one that turns a refused switch into a notice, so a
    // direct `select()` failure below must be reported rather than swallowed.
    const failing = fixture()
    failing.readCatalog.mockResolvedValueOnce({ ok: false, error: { code: 'unavailable', message: 'host offline' } })
    const failingController = new RemotePermissionsController(failing.context, failing.settings)
    await failingController.open()
    expect(failing.notice.set).toHaveBeenCalledWith('host offline')
    expect(failing.openOverlay).not.toHaveBeenCalled()

    // DEFECT (permissions.ts:204): a Host command failure rejects `select()`
    // instead of setting a notice; only the mounted panel's accept handler catches.
    const refusing = fixture()
    refusing.command.mockResolvedValueOnce({ ok: false, error: { code: 'unavailable', message: 'session gone' } })
    const direct = new RemotePermissionsController(refusing.context, refusing.settings)
    await expect(direct.select(refusing.selection.ref, 'yolo')).rejects.toThrow('session gone')
    expect(refusing.notice.set).not.toHaveBeenCalled()

    // The same failure through the panel is a notice, not a rejected handler.
    refusing.command.mockClear()
    const panelController = new RemotePermissionsController(refusing.context, refusing.settings)
    refusing.command.mockResolvedValueOnce({ ok: false, error: { code: 'unavailable', message: 'session gone' } })
    await panelController.open()
    refusing.panel().handleInput('\r')
    await vi.waitFor(() => { expect(refusing.notice.set).toHaveBeenCalledWith('session gone') })
    expect(refusing.openOverlay).toHaveBeenCalledOnce()
  })

  it('repaints the panel when the projected preset changes after it opened', async () => {
    const f = fixture({ current: 'default' })
    const controller = new RemotePermissionsController(f.context, f.settings)

    await controller.open()
    const before = f.panel().render(80)
    expect(before.some(line => line.includes('Default') && line.startsWith('> '))).toBe(true)

    f.project('acceptEdits')
    const after = f.panel().render(80)
    // The cursor stays where the operator left it; the current-preset marker
    // (`* `) is what moves to the newly projected preset.
    expect(after.some(line => line.includes('Accept edits') && line.startsWith('* '))).toBe(true)
    expect(after.some(line => line.includes('Default') && line.startsWith('> '))).toBe(true)
    expect(before.some(line => line.includes('Accept edits') && line.startsWith('* '))).toBe(false)
  })

  it('writes the default preset through settings when no Session is displayed', async () => {
    const f = fixture({ session: false, current: 'default' })
    const controller = new RemotePermissionsController(f.context, f.settings, f.source)

    await controller.open()

    expect(f.readCatalog).toHaveBeenCalledOnce()
    expect(f.describe).toHaveBeenCalledOnce()
    const lines = f.panel().render(80)
    expect(lines[0]).toBe('Permissions')
    expect(lines[1]).toBe('Default permission preset')

    f.panel().handleInput('\x1b[B')
    f.panel().handleInput('\r')
    await vi.waitFor(() => { expect(f.mutate).toHaveBeenCalledOnce() })
    expect(f.settings.revision).toHaveBeenCalledOnce()
    expect(f.mutate).toHaveBeenCalledWith(f.client, 'permission', [{ op: 'set', path: ['defaultPreset'], value: 'acceptEdits' }], 7)
    await vi.waitFor(() => { expect(f.notice.set).toHaveBeenCalledWith('Permission preset: acceptEdits') })
    expect(f.command).not.toHaveBeenCalled()
    expect(f.lease.close).toHaveBeenCalledOnce()
  })

  it('mounts no default panel when the Host exposes no permission settings namespace', async () => {
    const f = fixture({ session: false })
    f.describe.mockResolvedValueOnce({ ok: true, value: { writable: true, namespaces: [] } })
    const controller = new RemotePermissionsController(f.context, f.settings)

    await controller.open()

    // The default editor is settings-backed; without the namespace there is no
    // write target, so the module stays silent rather than showing a dead panel.
    expect(f.openOverlay).not.toHaveBeenCalled()
    expect(f.notice.set).not.toHaveBeenCalled()
  })

  it('opens nothing after dispose and drops a catalog answer that lands late', async () => {
    const f = fixture()
    let release!: (value: unknown) => void
    f.readCatalog.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const controller = new RemotePermissionsController(f.context, f.settings)

    const opening = controller.open()
    controller.dispose()
    release({ ok: true, value: catalog() })
    await opening
    expect(f.openOverlay).not.toHaveBeenCalled()

    // A disposed controller captures no new Host operation.
    await controller.open()
    expect(f.openOverlay).not.toHaveBeenCalled()
  })
})
