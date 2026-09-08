/** Renderer-neutral Help document tests.
 * @module @ephemeral-ai/mayfly/tests/interaction/help
 */
import { describe, expect, it } from 'vitest'
import { helpNode, type HelpSection } from '../../src/interaction/help.ts'

const sections: HelpSection[] = [
  { heading: 'Commands', labelTone: 'primary', rows: [{ label: '/help', description: 'Show help' }] },
  { heading: 'Keys', labelTone: 'warning', rows: [{ label: 'enter', description: 'Submit input' }] },
]

describe('helpNode', () => {
  it('builds one frozen scroll document with semantic labels and a close action', () => {
    const node = helpNode(sections)
    expect(node).toMatchObject({
      kind: 'surface', title: 'help', chrome: 'overlay',
      child: { kind: 'stack', children: [
        { node: { kind: 'scroll', id: 'help-document', scrollbar: true, child: { kind: 'rich-text' } } },
        { node: { kind: 'actions', id: 'help-actions', items: [{ id: 'close', dismiss: true }] } },
      ] },
    })
    expect(JSON.stringify(node)).toContain('/help')
    expect(JSON.stringify(node)).toContain('Submit input')
    expect(Object.isFrozen(node)).toBe(true)
  })

  it('translates headings, descriptions, title, and close label while preserving live key labels', () => {
    const node = helpNode(sections, (message) => ({ help: '帮助', Commands: '命令', Keys: '按键', 'Show help': '显示帮助', 'Submit input': '提交输入', Close: '关闭' })[message] ?? message)
    const text = JSON.stringify(node)
    for (const expected of ['帮助', '命令', '按键', '显示帮助', '提交输入', '关闭', 'enter']) expect(text).toContain(expected)
  })

  it('keeps empty sections in the complete document', () => {
    expect(JSON.stringify(helpNode([{ heading: 'Commands', rows: [] }]))).toContain('Commands')
    expect(JSON.stringify(helpNode([{ heading: 'Default', rows: [{ label: 'row', description: 'description' }] }]))).toContain('muted')
  })
})
