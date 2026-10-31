/**
 * Decision tests for the native MCP resource bridge: exact tool names, cursor
 * passthrough, binary bodies summarized as text, and the failure vocabulary.
 * @module
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { listMcpResources, readMcpResource } from '../../src/remote/mcp-resources.ts'

/** What the bridge's one tool call answered. */
interface ToolOutcome {
  readonly result?: { isError?: boolean, content?: readonly { type: string, text?: string }[], value?: unknown }
}

/** A context resolving one live parent Agent and answering tool batches. */
function bridge(outcome: ToolOutcome | Error): { ctx: Context, executed: () => { name: string, args: Record<string, string> } | undefined } {
  const session = { id: 'session-1', header: { origin: 'user' } }
  const agent: Agent = { id: 'session-1', session } as unknown as Agent
  let call: { name: string, args: Record<string, string> } | undefined
  const ctx = {
    agents: { get: (): Agent => agent },
    sessions: { get: (): unknown => session },
    sessionController: { resolveAgent: async (): Promise<never> => { throw new Error('unexpected') } },
    tools: {
      execute: async (batch: { calls: readonly { name: string, arguments: string }[] }): Promise<{ results: readonly ToolOutcome[] }> => {
        const first = batch.calls[0]
        call = { name: first!.name, args: JSON.parse(first!.arguments) as Record<string, string> }
        if (outcome instanceof Error) throw outcome
        return { results: [outcome] }
      },
    },
  } as unknown as Context
  return { ctx, executed: (): { name: string, args: Record<string, string> } | undefined => call }
}

describe('listMcpResources', () => {
  it('lists through the fixed native tool name with server and cursor as args', async () => {
    const { ctx, executed } = bridge({ result: { value: { resources: [{ uri: 'docs://a', name: 'A' }], nextCursor: 'page-2' } } })
    const page = await listMcpResources(ctx, { sessionId: 'session-1' as never, server: 'docs', kind: 'resources', cursor: 'page-1' }, new AbortController().signal)
    expect(executed()).toEqual({ name: 'list_mcp_resources', args: { server: 'docs', cursor: 'page-1' } })
    expect(page.items).toEqual([{ uri: 'docs://a', name: 'A' }])
    expect(page.cursor).toBe('page-2')
  })

  it('uses the templates tool and key for the templates kind', async () => {
    const { ctx, executed } = bridge({ result: { value: { resourceTemplates: [{ uriTemplate: 'docs://{id}', name: 'T' }] } } })
    const page = await listMcpResources(ctx, { sessionId: 'session-1' as never, server: 'docs', kind: 'templates' }, new AbortController().signal)
    expect(executed()?.name).toBe('list_mcp_resource_templates')
    expect(page.items[0]).toMatchObject({ name: 'T' })
    expect(page).not.toHaveProperty('cursor')
  })

  it('names the server in every refusal, with the tool error text', async () => {
    const { ctx } = bridge({ result: { isError: true, content: [{ type: 'text', text: 'connection refused' }] } })
    await expect(listMcpResources(ctx, { sessionId: 'session-1' as never, server: 'docs', kind: 'resources' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'mayflyHost/mcp-resource-failed', details: { server: 'docs' }, message: expect.stringContaining('connection refused') as never })
  })

  it('refuses a non-array catalog and a non-object result with the closed codes', async () => {
    const notArray = bridge({ result: { value: { resources: 'nope' } } })
    await expect(listMcpResources(notArray.ctx, { sessionId: 'session-1' as never, server: 'docs', kind: 'resources' }, new AbortController().signal))
      .rejects.toMatchObject({ details: { message: 'invalid catalog' } })
    const notObject = bridge({ result: { value: ['array'] } })
    await expect(listMcpResources(notObject.ctx, { sessionId: 'session-1' as never, server: 'docs', kind: 'resources' }, new AbortController().signal))
      .rejects.toMatchObject({ details: { message: 'invalid result' } })
  })
})

describe('readMcpResource', () => {
  it('reads through the native tool and joins text contents', async () => {
    const { ctx, executed } = bridge({ result: { value: { contents: [{ text: 'part one' }, { text: 'part two' }] } } })
    const body = await readMcpResource(ctx, { sessionId: 'session-1' as never, server: 'docs', uri: 'docs://a' }, new AbortController().signal)
    expect(executed()).toEqual({ name: 'read_mcp_resource', args: { server: 'docs', uri: 'docs://a' } })
    expect(body.text).toBe('part one\n\npart two')
  })

  it('summarizes a binary body instead of carrying raw bytes', async () => {
    const { ctx } = bridge({ result: { value: { contents: [{ uri: 'docs://img', mimeType: 'image/png' }, 'not an object'] } } })
    const body = await readMcpResource(ctx, { sessionId: 'session-1' as never, server: 'docs', uri: 'docs://img' }, new AbortController().signal)
    expect(body.text).toContain('Binary resource: docs://img (image/png)')
    expect(body.text).toContain('unknown media type')
    expect(body.text).not.toContain('base64')
  })
})

describe('the exact-session bridge', () => {
  it('refuses a session with no live Agent rather than executing', async () => {
    const session = { id: 'child-1', header: { origin: 'subagent' } }
    const execute = vi.fn()
    const ctx = {
      agents: { get: (): undefined => undefined },
      sessions: { get: (): unknown => session },
      tools: { execute },
    } as unknown as Context
    await expect(listMcpResources(ctx, { sessionId: 'child-1' as never, server: 'docs', kind: 'resources' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'mayflyHost/agent-unavailable' })
    expect(execute).not.toHaveBeenCalled()
  })
})
