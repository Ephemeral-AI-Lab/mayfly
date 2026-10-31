import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  SettingsDescribeValue,
  SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { MayflySettingsDocument } from '@ephemeral-ai/mayfly-host/types'
import { HostKey } from '../../src/client/types.ts'
import type { HostClient, SessionRef } from '../../src/client/types.ts'
import type { RemoteFeatureContext } from '../../src/remote/features/contracts.ts'
import { RemoteCallError } from '../../src/remote/features/official.ts'
import {
  REMOTE_MAYFLY_SETTINGS_REQUIREMENT,
  RemoteSettingsController,
  remoteMayflySettingsPersistence,
} from '../../src/remote/features/settings.ts'
import type { RemoteFeaturePanel } from '../../src/remote/features/panel.ts'

/** One redacted namespace view the Host describes. */
function namespace(ns: string, revision = 7): SettingsNamespaceView {
  return { ns, autoGenerate: true, schema: {}, value: {}, applies: 'live', secrets: [], revision }
}

/** One settings document as the Host-owned DTO returns it. */
function document(overrides: Partial<MayflySettingsDocument> = {}): MayflySettingsDocument {
  return { writable: true, content: 'line one\nline two', revision: 'rev-abcdef123456789', ...overrides }
}

/** Translate with the `{name}` interpolation the document subtitle relies on. */
const translate = vi.fn((key: string, params?: Readonly<Record<string, string | number>>) => params === undefined
  ? key
  : key.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name])))

interface FixtureOptions {
  readonly namespaces?: readonly SettingsNamespaceView[]
  readonly document?: MayflySettingsDocument
  readonly withDocuments?: boolean
  readonly withEdit?: boolean
}

function fixture(options: FixtureOptions = {}) {
  const ref: SessionRef = { host: HostKey('local'), sessionId: SessionId('session-1') }
  const describe = vi.fn(async (): Promise<unknown> => ({
    ok: true,
    value: {
      writable: true,
      hasDocument: true,
      namespaces: [...options.namespaces ?? [namespace('llm-deepseek'), namespace('mayfly')]],
    } satisfies SettingsDescribeValue,
  }))
  const update = vi.fn(async (): Promise<unknown> => ({ ok: true, value: namespace('llm-deepseek') }))
  const replace = vi.fn(async (): Promise<unknown> => ({ ok: true, value: namespace('llm-deepseek') }))
  const mutate = vi.fn(async (): Promise<unknown> => ({ ok: true, value: namespace('llm-deepseek') }))
  const offSettings = vi.fn()
  const on = vi.fn((_event: string, _listener: (ns: string, revision: number) => void) => offSettings)
  const remote = {
    settings: { describe, update, replace, mutate },
    permissionPresets: { catalog: vi.fn(async () => ({ ok: true, value: { options: [] } })) },
    agentPresets: { list: vi.fn(async () => ({ ok: true, value: { presets: [] } })) },
    $on: on,
  }
  const client = { key: HostKey('local'), remote } as unknown as HostClient
  const attached = vi.fn(() => true)
  const current = vi.fn(() => ({ ref, client, binding: {} }))
  const hosts = {
    current,
    list: vi.fn(() => (attached() ? [client] : [])),
    subscribe: vi.fn(() => () => {}),
  }
  const readDocument = vi.fn(async (_client: unknown, _signal: AbortSignal) => options.document ?? document())
  const writeDocument = vi.fn(async (_client: HostClient, content: string, _expectedRevision: string) =>
    document({ content, revision: `rev-${String(content.length)}` }))
  const documents = options.withDocuments === false ? undefined : { readDocument, writeDocument }
  const edit = options.withEdit === false ? undefined : vi.fn(async (): Promise<string | undefined> => 'edited body')
  const opened: { component: RemoteFeaturePanel, lease: { closed: boolean, close: ReturnType<typeof vi.fn> } }[] = []
  const overlays = {
    open: vi.fn((component: RemoteFeaturePanel) => {
      const lease = { closed: false, close: vi.fn() }
      opened.push({ component, lease })
      return lease
    }),
    close: vi.fn(),
  }
  const notice = { set: vi.fn() }
  const context = {
    ctx: {},
    screen: { requestRender: vi.fn() },
    components: { truncateToWidth: (text: string, width: number) => text.slice(0, width) },
    colors: {
      primary: (text: string) => text,
      accent: (text: string) => text,
      muted: (text: string) => text,
    },
    overlays,
    hosts,
    notice,
    t: translate,
    subscribeLocale: vi.fn(() => () => {}),
    presentation: {},
  } as unknown as RemoteFeatureContext
  const controller = new RemoteSettingsController(context, documents, edit)
  const panel = (index = 0): RemoteFeaturePanel => opened[index]!.component
  const render = (index = 0, width = 120): string => panel(index).render(width).join('\n')
  return {
    controller, client, ref, hosts, attached, current, remote, describe, update, replace, mutate,
    documents, readDocument, writeDocument, edit, on, offSettings,
    overlays, opened, notice, panel, render,
  }
}

describe('remoteMayflySettingsPersistence', () => {
  it('reports availability from the Host namespace list, not from wishful defaulting', () => {
    expect(remoteMayflySettingsPersistence({ writable: true, hasDocument: false, namespaces: [namespace('mayfly')] })).toBe('available')
    expect(remoteMayflySettingsPersistence({ writable: true, hasDocument: false, namespaces: [namespace('llm-deepseek')] })).toBe('host-schema-required')
  })
})

describe('RemoteSettingsController namespace roster', () => {
  it('lists the namespaces the Host reports with their revision details', async () => {
    const { controller, render, opened } = fixture()
    await controller.open()

    expect(opened).toHaveLength(1)
    const text = render()
    expect(text).toContain('Settings')
    expect(text).toContain('llm-deepseek')
    expect(text).toContain('revision 7')
    expect(text).toContain('mayfly')
    // The Host registers the Mayfly schema, so the follow-up requirement is not shown.
    expect(text).not.toContain(REMOTE_MAYFLY_SETTINGS_REQUIREMENT)
  })

  it('shows the Host follow-up requirement when no mayfly namespace exists', async () => {
    const { controller, render } = fixture({ namespaces: [namespace('llm-deepseek')] })
    await controller.open()
    expect(render(0, 400)).toContain(REMOTE_MAYFLY_SETTINGS_REQUIREMENT)
  })

  it('renders an explicit empty state when the Host reports no namespaces', async () => {
    const { controller, render } = fixture({ namespaces: [], withDocuments: false })
    await controller.open()
    const text = render()
    expect(text).toContain('No settings namespaces')
    expect(text).toContain('—')
  })

  it('offers the raw document row only when the document DTO is composed', async () => {
    const withDocuments = fixture()
    await withDocuments.controller.open()
    expect(withDocuments.render()).toContain('Settings document')

    const without = fixture({ withDocuments: false })
    await without.controller.open()
    expect(without.render()).not.toContain('Settings document')
  })

  it('reports a describe failure as a notice and never throws', async () => {
    const { controller, describe, notice, opened } = fixture()
    describe.mockResolvedValueOnce({ ok: false, error: { code: 'unavailable', message: 'settings provider missing' } })

    await expect(controller.open()).resolves.toBeUndefined()
    expect(notice.set).toHaveBeenCalledWith('settings provider missing')
    expect(opened).toEqual([])
  })

  it('drops a roster whose Host detached during the describe read', async () => {
    const { controller, describe, attached, opened, notice } = fixture()
    let release!: (value: unknown) => void
    describe.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    const opening = controller.open()
    attached.mockReturnValue(false)
    release({ ok: true, value: { writable: true, hasDocument: true, namespaces: [namespace('mayfly')] } })
    await opening

    expect(opened).toEqual([])
    expect(notice.set).not.toHaveBeenCalled()
  })
})

describe('RemoteSettingsController settings document', () => {
  it('shows the revision and content, reads under the operation signal, and watches updates', async () => {
    const { controller, client, render, readDocument, on } = fixture()
    await controller.openDocument(client)

    expect(readDocument).toHaveBeenCalledOnce()
    expect(readDocument.mock.calls[0]![0]).toBe(client)
    expect(readDocument.mock.calls[0]![1]).toBeInstanceOf(AbortSignal)
    expect(on).toHaveBeenCalledWith('settings/document-updated', expect.any(Function))
    const text = render()
    expect(text).toContain('line one')
    expect(text).toContain('line two')
    expect(text).toContain('revision rev-abcdef12')
    expect(text).toContain('Edit in external editor')
  })

  it('shows at most the first ten content lines', async () => {
    const content = Array.from({ length: 12 }, (_, index) => `line ${String(index + 1)}`).join('\n')
    const { controller, client, render } = fixture({ document: document({ content }) })
    await controller.openDocument(client)
    const text = render()
    expect(text).toContain('line 10')
    expect(text).not.toContain('line 11')
    expect(text).not.toContain('line 12')
    // The panel must not imply that what it shows is all there is.
    expect(text).toContain('2 more lines')
  })

  it('says the document is empty instead of painting a blank row', async () => {
    const { controller, client, render } = fixture({ document: document({ content: '   \n' }) })
    await controller.openDocument(client)
    expect(render()).toContain('The settings document is empty')
  })

  it('marks a read-only document and refuses to invoke the editor', async () => {
    const { controller, client, render, panel, edit } = fixture({ document: document({ writable: false }) })
    await controller.openDocument(client)

    expect(render()).toContain('read-only')
    panel().handleInput('\x1b[B')
    panel().handleInput('\r')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(edit).not.toHaveBeenCalled()
  })

  it('writes the edited text through the Host with the revision it read', async () => {
    const { controller, client, panel, writeDocument, notice, opened } = fixture()
    await controller.openDocument(client)
    panel().handleInput('\x1b[B')
    panel().handleInput('\r')

    await vi.waitFor(() => { expect(writeDocument).toHaveBeenCalledOnce() })
    const [selectedClient, content, expectedRevision, signal] = writeDocument.mock.calls[0] as unknown as [HostClient, string, string, AbortSignal]
    expect(selectedClient).toBe(client)
    expect(content).toBe('edited body')
    // The write carries the exact revision the read returned, never a fresh one.
    expect(expectedRevision).toBe('rev-abcdef123456789')
    expect(signal).toBeInstanceOf(AbortSignal)
    await vi.waitFor(() => { expect(notice.set).toHaveBeenCalledWith('Settings document saved') })
    expect(opened[0]!.lease.close).not.toHaveBeenCalled()
  })

  it('does not write when the editor cancels or returns the unchanged document', async () => {
    const cancelled = fixture()
    await cancelled.controller.openDocument(cancelled.client)
    cancelled.edit!.mockResolvedValueOnce(undefined)
    cancelled.panel().handleInput('\x1b[B')
    cancelled.panel().handleInput('\r')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(cancelled.writeDocument).not.toHaveBeenCalled()
    expect(cancelled.notice.set).not.toHaveBeenCalled()

    const unchanged = fixture()
    await unchanged.controller.openDocument(unchanged.client)
    unchanged.edit!.mockResolvedValueOnce('line one\nline two')
    unchanged.panel().handleInput('\x1b[B')
    unchanged.panel().handleInput('\r')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(unchanged.writeDocument).not.toHaveBeenCalled()
  })

  it('reports a stale-revision write as a conflict instead of a silent save', async () => {
    const { controller, client, panel, writeDocument, notice } = fixture()
    writeDocument.mockRejectedValueOnce(new RemoteCallError('mayflyHost/settings-conflict', 'revision moved'))
    await controller.openDocument(client)
    panel().handleInput('\x1b[B')
    panel().handleInput('\r')

    await vi.waitFor(() => { expect(notice.set).toHaveBeenCalledOnce() })
    const message = String(notice.set.mock.calls[0]![0])
    expect(message).toContain('settings-conflict')
    expect(message).toContain('changed elsewhere')
    expect(message).not.toContain('Settings document saved')
  })

  it('reports a document read failure as a notice and opens no panel', async () => {
    const { controller, client, readDocument, notice, opened } = fixture()
    readDocument.mockRejectedValueOnce(new Error('socket closed'))

    await expect(controller.openDocument(client)).resolves.toBeUndefined()
    expect(notice.set).toHaveBeenCalledWith('socket closed')
    expect(opened).toEqual([])
  })

  it('says so, without writing, when no external editor is configured', async () => {
    const { controller, client, panel, writeDocument, notice } = fixture({ withEdit: false })
    await controller.openDocument(client)
    panel().handleInput('\x1b[B')
    panel().handleInput('\r')

    await vi.waitFor(() => {
      expect(notice.set).toHaveBeenCalledWith('No external editor is configured for the settings document')
    })
    expect(writeDocument).not.toHaveBeenCalled()
  })

  it('drops a document read that settles after the Host detached', async () => {
    const { controller, client, readDocument, attached, notice, opened } = fixture()
    let release!: (value: MayflySettingsDocument) => void
    readDocument.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    const opening = controller.openDocument(client)
    attached.mockReturnValue(false)
    release(document())
    await opening

    expect(opened).toEqual([])
    expect(notice.set).not.toHaveBeenCalled()
  })

  it('refreshes an open document from the Host event', async () => {
    const { controller, client, render, readDocument, on } = fixture()
    await controller.openDocument(client)
    expect(render()).toContain('line one')

    readDocument.mockResolvedValueOnce(document({ content: 'replaced body', revision: 'rev-2' }))
    const listener = on.mock.calls[0]![1] as (ns: string, revision: number) => void
    listener('settings', 2)
    await vi.waitFor(() => { expect(render()).toContain('replaced body') })
  })
})
