import { nativeAction, activate, select as selection } from './native-action-fixture.ts'
/** MCP catalogs do not read bodies until the user requests them.
 * @module @ephemeral-ai/mayfly/tests/interaction/mcp-resources
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { informationFixture } from './information-fixture.ts'
import { flushRequests } from './request-fixture.ts'
import { openMcpResources } from '../../src/interaction/mcp-resources.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup(native = true) {
  const ctx = new Context(); contexts.push(ctx)
  const bench = await informationFixture(ctx)
  let value: unknown = { resources: [{ uri: 'test://first', name: 'First', description: 'Metadata' }], nextCursor: 'page2' }
  const execute = vi.fn(async () => ({ isError: false, value: native ? value : { result: value }, content: [] }))
  ctx.provide('tools', { schemas: () => native ? [{ name: 'list_mcp_resources' }, { name: 'list_mcp_resource_templates' }, { name: 'read_mcp_resource' }] : [], execute } as never)
  const model = (id = 'mayfly.mcp.resources') => ctx.mayflyUiInteraction.get('overlay', id)!
  return { ...bench, execute, model, setValue: (next: unknown) => { value = next }, open: (templates = false) => openMcpResources(ctx, bench.agent, 'docs', templates, new AbortController().signal) }
}
it('paginates metadata and reads one explicit URI without exposing binary contents', async () => {
  const bench = await setup()
  await bench.open()
  expect(bench.execute).toHaveBeenCalledOnce()
  bench.setValue({ resources: [{ uri: 'test://second' }] })
  bench.model().invoke('more'); await flushRequests()
  expect(bench.execute).toHaveBeenLastCalledWith(expect.objectContaining({ arguments: { server: 'docs', cursor: 'page2' }, agent: bench.agent }))
  bench.model().emit({ kind: 'selection-accept', pagePath: [], controlId: 'resources', selectedIds: ['0'] }); await flushRequests()
  expect(bench.execute).toHaveBeenCalledTimes(2)
  bench.setValue({ contents: [{ text: 'Document body' }, { uri: 'test://binary', mimeType: 'image/png', blob: 'SECRET_BINARY' }] })
  bench.model('mayfly.mcp.resource').invoke('read'); await flushRequests()
  const text = JSON.stringify(bench.model('mayfly.mcp.resource.body').node)
  expect(text).toContain('Document body'); expect(text).toContain('Binary resource'); expect(text).not.toContain('SECRET_BINARY')
  bench.ctx.mayflyCurrentAgent.select(bench.other)
  expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
})
it('supports templates and the native PTC transport without bypassing tool execution', async () => {
  const bench = await setup(false)
  bench.setValue({ resourceTemplates: [{ uriTemplate: 'test://{name}' }] })
  await bench.open(true)
  expect(bench.execute).toHaveBeenCalledWith(expect.objectContaining({ name: 'run_code', arguments: expect.objectContaining({ code: expect.stringContaining('tools.list_mcp_resource_templates') }) }))
  bench.model().emit({ kind: 'selection-accept', pagePath: [], controlId: 'resources', selectedIds: ['0'] }); await flushRequests()
  bench.model('mayfly.mcp.resource').edit({ pagePath: [], formId: 'resource-uri', fieldId: 'uri' }, 'test://expanded')
  bench.setValue({ contents: [{ text: 'Expanded resource' }] })
  bench.model('mayfly.mcp.resource').invoke('read'); await flushRequests()
  expect(JSON.stringify(bench.model('mayfly.mcp.resource.body').node)).toContain('Expanded resource')
})
it('reports malformed and failed catalogs without claiming an empty successful response', async () => {
  const bench = await setup()
  bench.setValue(null)
  await expect(bench.open()).rejects.toThrow('no resource catalog')
  bench.setValue({})
  await expect(bench.open()).rejects.toThrow('invalid resource catalog')
  bench.execute.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'offline' }] } as never)
  await expect(bench.open()).rejects.toThrow('offline')
})

it('handles absent metadata, empty URIs, unexpected actions, and unknown selections', async () => {
  const bench = await setup()
  bench.setValue({ resources: [null, { description: 'Description without name' }, { uri: 'test://named' }] })
  await bench.open()
  const root = bench.model()
  expect(await nativeAction(root, activate('unknown'))).toMatchObject({ kind: 'completed' })
  expect(await nativeAction(root, selection('resources', '99'))).toMatchObject({ kind: 'cancelled' })
  await nativeAction(root, selection('resources', '0'))
  const detail = bench.model('mayfly.mcp.resource')
  expect(await nativeAction(detail, selection('unrelated'))).toMatchObject({ kind: 'completed' })
  expect(await nativeAction(detail, activate('read'))).toMatchObject({ kind: 'failed' })
  detail.edit({ pagePath: [], formId: 'resource-uri', fieldId: 'uri' }, 'test://expanded')
  bench.setValue({ contents: [{}] })
  detail.invoke('read'); await flushRequests()
  const body = bench.model('mayfly.mcp.resource.body')
  expect(JSON.stringify(body.node)).toContain('unknown media type')
  await nativeAction(body, activate('close'))
  bench.ctx.mayflyOverlays.close('mayfly.mcp.resource.body')
  bench.setValue(null)
  detail.invoke('read'); await flushRequests()
  expect(bench.model('mayfly.mcp.resource.body')).toBeDefined()
})
it('shows anonymous metadata entries and rejects a PTC response without a result', async () => {
  const bench = await setup()
  bench.setValue({ resources: [{}] })
  await bench.open()
  expect(JSON.stringify(bench.model().node)).toContain('"label":"0"')
  const ptc = await setup(false)
  ptc.execute.mockResolvedValueOnce({ isError: false, value: null, content: [] } as never)
  await expect(ptc.open()).rejects.toThrow('no resource catalog')
})
