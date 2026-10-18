/** The MCP resource helpers read one native catalog page and one explicit body
 * on demand, then map metadata to list rows; they open no surface themselves.
 * @module @ephemeral-ai/mayfly/tests/interaction/mcp-resources
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listMcpResources, readMcpResource, resourceItems } from '../../src/interaction/mcp-resources.ts'

interface ExecuteCall {
  readonly callId: string
  readonly agent: Agent
  readonly signal: AbortSignal
  readonly name: string
  readonly arguments: Record<string, string>
}
interface ToolContent {
  readonly type: string
  readonly text?: string
}
interface ToolOutcome {
  readonly isError: boolean
  readonly value?: unknown
  readonly content: readonly ToolContent[]
}

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

const success = (value: unknown): ToolOutcome => ({ isError: false, value, content: [] })
const signal = () => new AbortController().signal

function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  /* Same session, different Agents: the helper must hand the native tool the
     exact Agent it was given, never resolve a scope from the session id. */
  const session = { id: 'shared-session' }
  const agent = { id: 'agent-a', session } as unknown as Agent
  const other = { id: 'agent-b', session } as unknown as Agent
  const execute = vi.fn(async (_call: ExecuteCall): Promise<ToolOutcome> => success({}))
  const schemas = vi.fn(() => [])
  ctx.provide('tools', { schemas, execute } as never)
  return { ctx, agent, other, execute, schemas }
}

describe('listMcpResources', () => {
  it('reads one page and passes its cursor to the next native call unchanged', async () => {
    const { ctx, agent, other, execute } = setup()
    const firstSignal = signal()
    execute.mockResolvedValueOnce(success({
      resources: [
        { uri: 'test://first', name: 'First', description: 'Metadata' },
        null,
        { uri: 'test://second' },
      ],
      nextCursor: 'page2',
    }))

    await expect(listMcpResources(ctx, agent, 'docs', false, firstSignal)).resolves.toEqual({
      items: [
        { uri: 'test://first', name: 'First', description: 'Metadata' },
        { uri: 'test://second' },
      ],
      cursor: 'page2',
    })
    const first = execute.mock.calls[0]![0]
    expect(first.name).toBe('list_mcp_resources')
    expect(first.arguments).toEqual({ server: 'docs' })
    expect(first.agent).toBe(agent)
    expect(first.signal).toBe(firstSignal)
    expect(first.arguments).not.toHaveProperty('cursor')
    expect(first.arguments).not.toHaveProperty('code')

    const secondSignal = signal()
    execute.mockResolvedValueOnce(success({ resources: [{ uri: 'test://third' }], nextCursor: 7 }))
    await expect(listMcpResources(ctx, other, 'docs', false, secondSignal, 'page2')).resolves.toEqual({
      items: [{ uri: 'test://third' }],
      cursor: undefined,
    })
    const second = execute.mock.calls[1]![0]
    expect(second.name).toBe('list_mcp_resources')
    expect(second.arguments).toEqual({ server: 'docs', cursor: 'page2' })
    expect(second.agent).toBe(other)
    expect(second.agent).not.toBe(agent)
    expect(second.signal).toBe(secondSignal)
  })

  it('reads templates through the template tool and ignores the resource key', async () => {
    const { ctx, agent, execute } = setup()
    execute.mockResolvedValueOnce(success({
      resourceTemplates: [
        { name: 'Template', uriTemplate: 'test://{name}', description: 'Parameterized' },
      ],
      nextCursor: 'templates-2',
    }))

    await expect(listMcpResources(ctx, agent, 'docs', true, signal())).resolves.toEqual({
      items: [{ name: 'Template', uriTemplate: 'test://{name}', description: 'Parameterized' }],
      cursor: 'templates-2',
    })
    const call = execute.mock.calls[0]![0]
    expect(call.name).toBe('list_mcp_resource_templates')
    expect(call.arguments).toEqual({ server: 'docs' })
    expect(call.agent).toBe(agent)
  })

  it('rejects a catalog that is absent, not an object, or not the requested page', async () => {
    const { ctx, agent, execute } = setup()
    const cases = [
      { templates: false, value: null, error: 'no resource catalog' },
      { templates: false, value: 'offline', error: 'no resource catalog' },
      { templates: false, value: undefined, error: 'no resource catalog' },
      { templates: false, value: [], error: 'invalid resource catalog' },
      { templates: false, value: {}, error: 'invalid resource catalog' },
      { templates: false, value: { resources: null }, error: 'invalid resource catalog' },
      { templates: false, value: { resourceTemplates: [] }, error: 'invalid resource catalog' },
      { templates: true, value: { resources: [] }, error: 'invalid resource catalog' },
    ] as const
    for (const entry of cases) {
      execute.mockResolvedValueOnce(success(entry.value))
      await expect(listMcpResources(ctx, agent, 'docs', entry.templates, signal())).rejects.toThrow(entry.error)
    }
    expect(execute).toHaveBeenCalledTimes(cases.length)
  })

  it('surfaces every failed native text block and keeps non-text blocks out', async () => {
    const { ctx, agent, execute } = setup()
    execute.mockResolvedValueOnce({
      isError: true,
      content: [{ type: 'image' }, { type: 'text', text: 'offline' }, { type: 'text', text: 'check server' }],
    })
    await expect(listMcpResources(ctx, agent, 'docs', false, signal())).rejects.toThrow('offline\ncheck server')
    expect(execute).toHaveBeenCalledOnce()
  })
})

describe('readMcpResource', () => {
  it('calls the native read tool for the exact Agent and joins text contents', async () => {
    const { ctx, agent, other, execute, schemas } = setup()
    const readSignal = signal()
    execute.mockResolvedValueOnce(success({ contents: [
      { uri: 'test://document', mimeType: 'text/plain', text: 'Document body' },
      { uri: 'test://notes', text: 'Second paragraph' },
    ] }))

    await expect(readMcpResource(ctx, agent, 'docs', 'test://document', readSignal))
      .resolves.toBe('Document body\n\nSecond paragraph')
    const call = execute.mock.calls[0]![0]
    expect(call.name).toBe('read_mcp_resource')
    expect(call.arguments).toEqual({ server: 'docs', uri: 'test://document' })
    expect(call.agent).toBe(agent)
    expect(call.agent).not.toBe(other)
    expect(call.signal).toBe(readSignal)
    expect(call.arguments).not.toHaveProperty('code')
    expect(call.callId).toEqual(expect.any(String))
    expect(schemas).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledOnce()
  })

  it('describes binary contents and never returns their payload', async () => {
    const { ctx, agent, execute } = setup()
    const secret = 'BASE64_SECRET'
    execute.mockResolvedValueOnce(success({ contents: [
      { uri: 'test://document', mimeType: 'text/plain', text: 'Document body' },
      { uri: 'test://image', mimeType: 'image/png', blob: secret },
    ] }))

    const text = await readMcpResource(ctx, agent, 'docs', 'test://document', signal())
    expect(text).toBe('Document body\n\nBinary resource: test://image (image/png)')
    expect(text).not.toContain(secret)
  })

  it('falls back to the requested URI and an unknown media type for binary metadata', async () => {
    const { ctx, agent, execute } = setup()
    const secret = 'BASE64_SECRET'
    execute.mockResolvedValueOnce(success({ contents: [{ blob: secret }] }))

    const text = await readMcpResource(ctx, agent, 'docs', 'test://requested', signal())
    expect(text).toBe('Binary resource: test://requested (unknown media type)')
    expect(text).not.toContain(secret)
  })
})

describe('resourceItems', () => {
  it('labels rows by name, URI, template, or index and keeps the metadata searchable', () => {
    const rows = resourceItems([
      { name: 'Named', uri: 'test://named', description: 'Description' },
      { uri: 'test://uri-only' },
      { uriTemplate: 'test://{name}' },
      { description: 'No URI' },
      {},
    ])
    expect(rows).toEqual([
      { id: '0', label: 'Named', detail: 'Description', searchText: 'Named test://named Description' },
      { id: '1', label: 'test://uri-only', detail: 'test://uri-only', searchText: 'test://uri-only' },
      { id: '2', label: 'test://{name}', detail: 'test://{name}', searchText: 'test://{name}' },
      { id: '3', label: '3', detail: 'No URI', searchText: 'No URI' },
      { id: '4', label: '4', detail: '', searchText: '' },
    ])
  })

  it('keeps an explicit empty URI as an empty value instead of substituting one', () => {
    const rows = resourceItems([{ uri: '' }, { name: '', uri: 'test://named' }])
    expect(rows.map(row => ({ id: row.id, label: row.label, detail: row.detail }))).toEqual([
      { id: '0', label: '', detail: '' },
      { id: '1', label: '', detail: 'test://named' },
    ])
    expect(rows[1]!.searchText).toContain('test://named')
  })
})
