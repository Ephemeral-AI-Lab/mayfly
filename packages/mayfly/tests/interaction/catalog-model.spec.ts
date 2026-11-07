/** Shared catalog edge facts and narrow/wide layouts without native owners. @module */
import { describe, expect, it } from 'vitest'
import { firstSentence, resourcePanel, serverItems, serverPage, resourceBodyPanel, serverConfigNode, toolDetailBody, toolPanel, type McpServerFacts } from '../../src/interaction/catalog-model.ts'
import { ADVERSARIAL, SCAN_WIDTHS, expectLinesFit } from '../core/width-scan.ts'
import { createRealSurface, probeComponents } from '../design/probe.ts'

const t = (key: string) => key
const server: McpServerFacts = { entryId: 'server', serverName: 'server', status: 'unknown', registeredCount: 0, toolsVisible: [] }

describe('readonly reference catalog edges', () => {
  it('preserves native missing-schema, unknown-visibility and empty resource facts', () => {
    const schema = { name: 'without-parameters', description: '' }
    expect(JSON.stringify(toolDetailBody(schema, t))).toContain('(no parameters)')
    expect(JSON.stringify(toolPanel(server, schema, t))).toContain('(no parameters)')
    expect(JSON.stringify(serverConfigNode(server, t))).toContain('Live tool availability is unknown')
    expect(JSON.stringify(resourceBodyPanel(server, {}, t))).toContain('(no output)')
    expect(JSON.stringify(resourceBodyPanel(server, {}, t))).toContain('Resources')
    expect(firstSentence('')).toBe('')
  })

  for (const { name, text } of ADVERSARIAL) it(`keeps parameterless tools and resource bodies within ${name} widths`, () => {
    const schema = { name: text, description: '' }
    const nodes = [toolDetailBody(schema, t), toolPanel({ ...server, serverName: text }, schema, t), serverConfigNode(server, t), resourceBodyPanel({ ...server, serverName: text }, { bodyText: text, bodyLabel: text }, t)]
    for (const node of nodes) for (const width of SCAN_WIDTHS) {
      const surface = createRealSurface(node, width, { components: probeComponents() })
      try { expectLinesFit(`catalog-edges/${name}`, surface.render(), width) } finally { surface.dispose() }
    }
  })
})

it('sorts equal-status servers by name and keeps malformed resources inspectable', () => {
  expect(serverItems({ servers: [{ ...server, entryId: 'z', serverName: 'Zulu' }, { ...server, entryId: 'a', serverName: 'Alpha' }], orphanCount: 0 }, t).map(row => row.id)).toEqual(['a', 'z'])
  const resource = { templates: false, items: [{}], cursor: undefined, loading: false, loaded: true, error: undefined }
  expect(JSON.stringify(resourcePanel(server, resource, 0, t))).toContain('"value":""')
  expect(JSON.stringify(serverPage(server, 'resources', resource, t))).toContain('"label":"0"')
})
