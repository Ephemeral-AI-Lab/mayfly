/** On-demand MCP resource browsing through the native scoped tool pipeline.
 * @module @ephemeral-ai/mayfly/interaction/mcp-resources
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { ui, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { openAgentOverlay } from './agent-overlay.ts'

/** Browse metadata first; only an explicit Read dispatches a resource body. */
export async function openMcpResources(ctx: Context, agent: Agent, server: string, templates: boolean, signal: AbortSignal): Promise<void> {
  const invoke = async (name: string, args: Record<string, string>, signal: AbortSignal) => {
    const native = ctx.tools.schemas(agent).some(tool => tool.name === name)
    const outcome = await ctx.tools.execute({ callId: randomUUID() as ToolCallId, agent, signal,
      name: native ? name : 'run_code',
      arguments: native ? args : { code: `return await tools.${name}(${JSON.stringify(args)})`, description: `Read MCP resource metadata from ${server}` },
    })
    if (outcome.isError) throw new Error(outcome.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
    if (native) return outcome.value
    const value = outcome.value
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value.result : undefined
  }
  let items: Record<string, unknown>[] = []
  let cursor: string | undefined
  const load = async (signal: AbortSignal) => {
    const result = await invoke(templates ? 'list_mcp_resource_templates' : 'list_mcp_resources', { server, ...(cursor === undefined ? {} : { cursor }) }, signal)
    if (typeof result !== 'object' || result === null) throw new Error('MCP returned no resource catalog')
    const value = result as Record<string, unknown>
    const rows = value[templates ? 'resourceTemplates' : 'resources']
    if (!Array.isArray(rows)) throw new Error('MCP returned an invalid resource catalog')
    items = [...items, ...rows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)]
    cursor = typeof value.nextCursor === 'string' ? value.nextCursor : undefined
  }
  await load(signal)
  const node = (): MayflyUiNode => ui.surface({ title: `${server} · ${templates ? 'Templates' : 'Resources'}`, chrome: 'overlay', child: ui.stack.column([
    ui.list({ id: 'resources', role: 'browse', filterable: true, selectedIds: [], items: items.map((item, index) => ({ id: String(index), label: String(item.name ?? item.uri ?? item.uriTemplate ?? index), detail: String(item.description ?? item.uri ?? item.uriTemplate ?? '') })), empty: ui.empty({ title: 'No resources' }) }),
    ui.actions({ id: 'resource-actions', items: [...cursor === undefined ? [] : [{ id: 'more', label: 'More' }], { id: 'close', label: 'Close', dismiss: true }] }),
  ]) })
  await openAgentOverlay(ctx, agent, { id: 'mayfly.mcp.resources', title: server, presentation: 'editor', capturing: true }, node(), owner => async (event, context) => {
    if (event.kind === 'activate' && event.actionId === 'more') {
      await load(context.signal)
      return { kind: 'accepted', node: node(), source: [] }
    }
    if (event.kind !== 'selection-accept') return { kind: 'completed' }
    const item = items[Number(event.selectedIds[0])]
    if (item === undefined) return { kind: 'cancelled' }
    const initial = String(item.uri ?? item.uriTemplate ?? '')
    await openAgentOverlay(owner, agent, { id: 'mayfly.mcp.resource', title: String(item.name ?? initial), presentation: 'editor', capturing: true }, ui.surface({ title: String(item.name ?? initial), chrome: 'overlay', child: ui.stack.column([
      ui.text(String(item.description ?? '')),
      ui.form({ id: 'resource-uri', fields: [{ kind: 'input', id: 'uri', label: 'Resource URI', value: initial }] }),
      ui.actions({ id: 'read-actions', items: [{ id: 'read', label: 'Read', read: [{ pagePath: [], formId: 'resource-uri' }] }, { id: 'close', label: 'Close', dismiss: true }] }),
    ]) }), scope => async (action, operation) => {
      if (action.kind !== 'activate' || action.actionId !== 'read') return { kind: 'completed' }
      const uri = action.inputs?.forms[0]?.fields.find(field => field.id === 'uri')?.value
      if (typeof uri !== 'string' || uri.trim() === '') return { kind: 'failed', message: 'Enter a resource URI' }
      const result = await invoke('read_mcp_resource', { server, uri }, operation.signal)
      const value = typeof result === 'object' && result !== null ? result as Record<string, unknown> : {}
      const contents = Array.isArray(value.contents) ? value.contents as Record<string, unknown>[] : []
      const text = contents.map(content => typeof content.text === 'string' ? content.text : `Binary resource: ${String(content.uri ?? uri)} (${String(content.mimeType ?? 'unknown media type')})`).join('\n\n')
      await openAgentOverlay(scope, agent, { id: 'mayfly.mcp.resource.body', title: uri, presentation: 'editor', capturing: true }, ui.surface({ title: uri, chrome: 'overlay', child: ui.stack.column([
        ui.scroll(ui.text(text), { scrollbar: true }), ui.actions({ id: 'body-actions', items: [{ id: 'close', label: 'Close', dismiss: true }] }),
      ]) }), () => () => ({ kind: 'completed' }), { signal, reopen: 'replace' })
      return { kind: 'completed' }
    }, { signal, reopen: 'replace' })
    return { kind: 'completed' }
  }, { signal, reopen: 'replace' })
}
