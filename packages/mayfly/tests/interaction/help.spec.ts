/** Renderer-neutral Help document tests.
 * @module @ephemeral-ai/mayfly/tests/interaction/help
 */
import { describe, expect, it } from 'vitest'
import { ui, type MayflyUiNode } from '../../../ui/src/index.ts'
import { helpNode, type HelpSection } from '../../src/interaction/help.ts'
import { frameGrid, paint } from '../design/probe.ts'
import { plain } from '../helpers.ts'
import { helpCatalogSections } from './help-catalog-fixture.ts'

const sections: HelpSection[] = [
  { heading: 'Commands', labelTone: 'primary', rows: [{ label: '/help', description: 'Show help' }] },
  { heading: 'Keys', labelTone: 'warning', rows: [{ label: 'enter', description: 'Submit input' }] },
]

function helpDocument(node: MayflyUiNode): MayflyUiNode {
  if (node.kind !== 'surface' || node.child.kind !== 'stack') throw new Error('Expected Help surface')
  const scroll = node.child.children[0]!.node
  if (scroll.kind !== 'scroll') throw new Error('Expected Help scroll document')
  return scroll.child
}

function richDocuments(node: MayflyUiNode) {
  const document = helpDocument(node)
  const nodes = document.kind === 'stack' ? document.children.map(child => child.node) : [document]
  return nodes.map(node => {
    if (node.kind !== 'rich-text') throw new Error('Expected rich-text document chunk')
    return node
  })
}

const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ label: `/command-${index + 1}`, description: `Command ${index + 1} description with enough text to wrap in a narrow terminal` }))

describe('helpNode', () => {
  it('builds one frozen scroll document with semantic labels', () => {
    const node = helpNode(sections)
    expect(node).toMatchObject({
      kind: 'surface', title: 'Help', chrome: 'overlay',
      child: { kind: 'stack', children: [
        { node: { kind: 'scroll', id: 'help-document', scrollbar: true, child: { kind: 'rich-text' } } },
      ] },
    })
    expect(JSON.stringify(node)).toContain('/help')
    expect(JSON.stringify(node)).toContain('Submit input')
    expect(Object.isFrozen(node)).toBe(true)
  })

  it('translates headings, descriptions, and title while preserving live key labels', () => {
    const node = helpNode(sections, (message) => ({ Help: '帮助', Commands: '命令', Keys: '按键', 'Show help': '显示帮助', 'Submit input': '提交输入', Close: '关闭' })[message] ?? message)
    const text = JSON.stringify(node)
    for (const expected of ['帮助', '命令', '按键', '显示帮助', '提交输入', 'enter']) expect(text).toContain(expected)
  })

  it('keeps empty sections in the complete document', () => {
    expect(richDocuments(helpNode([]))[0]!.spans).toEqual([])
    expect(JSON.stringify(helpNode([{ heading: 'Commands', rows: [] }]))).toContain('Commands')
    expect(JSON.stringify(helpNode([{ heading: 'Default', rows: [{ label: 'row', description: 'description' }] }]))).toContain('muted')
  })

  it('retains the original single rich-text node at the exact collection limit', () => {
    const node = helpNode([{ heading: 'Commands', rows: rows(99) }, { heading: 'Keys', rows: [] }])
    expect(helpDocument(node).kind).toBe('rich-text')
    expect(richDocuments(node)[0]!.spans).toHaveLength(200)
  })

  it('starts a new rich-text node with the complete styled row and retains every later row', () => {
    const source: HelpSection[] = [{ heading: 'Commands', labelTone: 'primary', rows: rows(201) }]
    const documents = richDocuments(helpNode(source))
    expect(documents.map(document => document.spans.length)).toEqual([199, 200, 4])
    expect(documents[1]!.spans.slice(0, 2)).toEqual([
      { text: '/command-100', tone: 'primary', styles: ['strong'] },
      { text: '  Command 100 description with enough text to wrap in a narrow terminal', tone: 'muted' },
    ])
    expect(documents.map(document => document.spans.map(span => span.text).join('')).join('\n')).toBe(
      `Commands${source[0]!.rows.map(row => `\n${row.label}  ${row.description}`).join('')}`,
    )
    expect(documents.every(document => Object.isFrozen(document) && document.spans.length <= 200)).toBe(true)
  })

  it('preserves painted rows, wrapping, and semantic styles across a row chunk boundary', async () => {
    const allRows = rows(101).map((row, index) => index < 98 ? { ...row, description: 'short' } : row)
    const document = helpDocument(helpNode([{ heading: 'Commands', labelTone: 'primary', rows: allRows }]))
    const reference = ui.richText([
      { text: allRows[98]!.label, tone: 'primary', styles: ['strong'] },
      { text: `  ${allRows[98]!.description}`, tone: 'muted' },
      { text: `\n${allRows[99]!.label}`, tone: 'primary', styles: ['strong'] },
      { text: `  ${allRows[99]!.description}`, tone: 'muted' },
      { text: `\n${allRows[100]!.label}`, tone: 'primary', styles: ['strong'] },
      { text: `  ${allRows[100]!.description}`, tone: 'muted' },
    ])
    for (const width of [120, 40]) {
      const expected = paint(reference, width)
      expect(await frameGrid(paint(document, width).slice(-expected.length), width)).toBe(await frameGrid(expected, width))
    }
  })

  it('preserves the blank row and styled heading when a new section starts a chunk', async () => {
    const node = helpNode([
      { heading: 'Commands', rows: rows(99).map(row => ({ ...row, description: 'short' })) },
      { heading: 'Empty section', rows: [] },
      { heading: 'Keys', labelTone: 'warning', rows: [{ label: 'enter', description: 'Submit input' }] },
    ], message => message === 'Keys' ? '按键' : message)
    const documents = richDocuments(node)
    expect(documents.map(document => document.spans.length)).toEqual([200, 3])
    expect(documents[1]!.spans[0]).toEqual({ text: '\n按键', tone: 'accent', styles: ['strong'] })
    const reference = ui.richText([
      { text: 'Empty section\n\n按键', tone: 'accent', styles: ['strong'] },
      { text: '\nenter', tone: 'warning', styles: ['strong'] },
      { text: '  Submit input', tone: 'muted' },
    ])
    for (const width of [120, 40]) {
      const expected = paint(reference, width)
      const actual = paint(helpDocument(node), width).slice(-expected.length)
      expect(await frameGrid(actual, width)).toBe(await frameGrid(expected, width))
      expect(plain(actual)).toEqual(['Empty section', '', '按键', 'enter  Submit input'])
    }
  })

  it('admits the shipped Remote command families, all shared actions, and panel key reference without truncation', () => {
    const sections = helpCatalogSections()
    expect(sections.reduce((count, section) => count + 1 + section.rows.length * 2, 0)).toBeGreaterThan(200)
    const document = helpDocument(helpNode(sections))
    const painted = plain(paint(document, 120)).join('\n')
    for (const section of sections) {
      expect(painted).toContain(section.heading)
      for (const row of section.rows) expect(painted).toContain(row.label)
    }
    expect(painted).toContain('/quit (/q, /exit)')
    expect(painted).toContain('/effort (/thinking)')
    expect(painted).toContain('/onboarding')
  })
})
