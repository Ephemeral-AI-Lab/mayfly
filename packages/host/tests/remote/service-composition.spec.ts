/** Host Remote entry routing and Fiber lifetime with the built decorators. @module */
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MayflyHostService } from '../../lib/index.js'
import { mkdtempTracked, registerTempDirCleanup } from '../../../mayfly/tests/core/temp-dir.ts'

registerTempDirCleanup()
const contexts: Context[] = []
type HostService = InstanceType<typeof MayflyHostService>
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function host(): Promise<{ ctx: Context, service: HostService, unload(): Promise<void> }> {
  const ctx = new Context()
  contexts.push(ctx)
  const session = { id: SessionId('parent'), header: { origin: 'user', cwd: '/host' } }
  const agent = { id: session.id, session, status: 'idle', ctx }
  const settingsFile = join(mkdtempTracked('mayfly-host-service-'), 'settings.json')
  await writeFile(settingsFile, '{}', 'utf8')
  const services: Record<string, unknown> = {
    agents: { get: (id: string) => id === session.id ? agent : undefined },
    sessions: { get: (id: string) => id === session.id ? session : undefined },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'one' }) },
    authorization: { describe: () => undefined, cancel: vi.fn() },
    credentials: { resolve: async () => undefined },
    llm: { listProviders: () => [] },
    permissionPresets: { catalog: () => ({ options: [], defaultOptions: [], defaultPreset: 'safe' }) },
    sessionController: { resolveAgent: async () => { throw new Error('unexpected activation') } },
    sessionProjections: {
      snapshot: () => ({ values: { workingDirectory: '/host', mayflyWorkflow: { sessionId: session.id, runs: [] } } }),
      onChanged: () => () => {},
    },
    settings: { writable: true, prepareDocument: async () => settingsFile },
    skills: { snapshot: async () => ({ complete: true, skills: [] }) },
    subagents: { listDescendants: async () => [] },
    tools: { schemas: () => [], get: () => undefined, execute: async () => ({ results: [{ result: { isError: false, value: { resources: [], contents: [] } } }] }) },
    workspaceChanges: { summary: () => undefined, diff: async () => undefined },
    workspaceRegistry: { resolveByPath: async () => undefined },
  }
  for (const [key, value] of Object.entries(services)) ctx.provide(key, value)
  const fiber = ctx.plugin(MayflyHostService)
  await fiber
  const service = ctx.get('mayflyHost') as HostService
  expect(service).toBeInstanceOf(MayflyHostService)
  return { ctx, service, unload: () => fiber.dispose() }
}

describe('Host Remote composition', () => {
  it('declares every addressed Session to native Gateway authorization, including both child drain identities', async () => {
    const { service } = await host()
    const methods = new Map(remoteMethods(service).map(method => [method.method, method]))
    const sessionId = SessionId('authorized-session')
    for (const name of ['followWorkflow', 'gitStatus', 'mcpCatalog', 'toolCatalog', 'skillCatalog', 'retractTurn', 'workspaceChangesSummary', 'workspaceChangesDiff', 'listMcpResources', 'readMcpResource']) {
      const reader = methods.get(name)?.resources?.['session']
      expect(reader, `${name} must declare Session authorization`).toBeTypeOf('function')
      expect(reader?.({ sessionId })).toBe(sessionId)
    }
    const presentations = methods.get('presentTools')?.resources?.['session']
    expect(presentations?.({ entries: [] })).toBeUndefined()
    expect(presentations?.({ entries: [{ sessionId }, { sessionId }, { sessionId: 'second' }] })).toEqual([sessionId, 'second'])
    expect(methods.get('subagentDrain')?.resources?.['session']?.({ parentSessionId: sessionId, childSessionId: 'child' })).toEqual([sessionId, 'child'])
  })

  it('routes every capability through the service installed by Cordis', async () => {
    const { service } = await host()
    const signal = new AbortController().signal
    const request = { sessionId: SessionId('parent') }
    expect(service.capabilities().features).toContain('presentTools')
    await expect(service.presentTools({ entries: [{ ...request, callId: 'one', updatedSeq: 1, name: 'missing', arguments: '{}' }] }, signal))
      .resolves.toMatchObject({ presentations: { parent: { one: { updatedSeq: 1 } } } })
    await expect(service.mcpCatalog(request, signal)).resolves.toMatchObject({ servers: [], sessionLive: true })
    await expect(service.toolCatalog(request, signal)).resolves.toEqual({ tools: [] })
    await expect(service.skillCatalog(request, signal)).resolves.toEqual({ skills: [], complete: true })
    await expect(service.retractTurn({ ...request, messageId: 'missing' }, signal)).resolves.toBe(false)
    await expect(service.modelCatalogDetails({}, signal)).resolves.toEqual({ items: [] })
    await expect(service.defaultModel({ operation: 'read' }, signal)).resolves.toEqual({ provider: 'fixture', model: 'one' })
    expect(service.permissionCatalogDetails({}, signal)).toMatchObject({ options: [], yolo: false })
    await expect(service.providerBalance(signal)).resolves.toEqual({ status: 'unavailable', reason: 'no-key' })
    const document = await service.readSettingsDocument(signal)
    await expect(service.writeSettingsDocument({ content: '{"ok":true}', expectedRevision: document.revision }, signal)).resolves.toMatchObject({ content: '{"ok":true}' })
    await expect(service.subagentDrain({ parentSessionId: request.sessionId, childSessionId: SessionId('missing') }, signal)).rejects.toMatchObject({ code: 'mayflyHost/subagent-drain-unavailable' })
    expect(service.workspaceChangesSummary({ ...request, seq: 1 }, signal)).toBeNull()
    await expect(service.workspaceChangesDiff({ ...request, seq: 1, index: 0 }, signal)).resolves.toBeNull()
    await expect(service.workspacePath({ path: '/missing' }, signal)).resolves.toBeNull()
    await expect(service.listMcpResources({ ...request, server: 'docs', kind: 'resources' }, signal)).resolves.toEqual({ items: [] })
    await expect(service.readMcpResource({ ...request, server: 'docs', uri: 'docs://one' }, signal)).resolves.toEqual({ text: '' })
    const workflow = service.followWorkflow(request, signal)[Symbol.asyncIterator]()
    expect(await workflow.next()).toEqual({ done: false, value: { type: 'baseline', value: { sessionId: request.sessionId, runs: [] } } })
    await workflow.return?.()
    service.cancelAuthorization({ key: credentialKey('fixture', 'account') }, signal)
    const authorization = service.authorize({ key: credentialKey('fixture', 'account') }, signal)[Symbol.asyncIterator]()
    await expect(authorization.next()).rejects.toMatchObject({ code: 'mayflyHost/authorization-unavailable' })
  })

  it('aborts in-flight work when its actual Cordis Fiber unloads and permits a fresh service', async () => {
    const { ctx, service, unload } = await host()
    let finish!: (value: Awaited<ReturnType<Context['skills']['snapshot']>>) => void
    let receivedSignal: AbortSignal | undefined
    ctx.skills.snapshot = (async (options: { signal?: AbortSignal }) => {
      receivedSignal = options.signal
      return new Promise(resolve => { finish = resolve })
    }) as typeof ctx.skills.snapshot
    const pending = service.skillCatalog({ sessionId: SessionId('parent') }, new AbortController().signal)
    await vi.waitFor(() => { expect(receivedSignal).toBeDefined() })
    await unload()
    expect(receivedSignal?.aborted).toBe(true)
    finish({ skills: [], complete: true })
    await expect(pending).rejects.toThrow()
    const replacement = ctx.plugin(MayflyHostService)
    await replacement
    expect(ctx.get('mayflyHost')).not.toBe(service)
    expect((ctx.get('mayflyHost') as HostService).capabilities().protocolVersion).toBe(1)
    await replacement.dispose()
  })
})
