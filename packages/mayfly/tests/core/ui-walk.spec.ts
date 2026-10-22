/** Depth-first UI walk edge enumeration, pruning, context threading, and short-circuiting. */
import { describe, expect, it } from 'vitest'
import type { MayflyUiNode } from '../../../ui/src/index.ts'
import { someUiNode, walkUiNode, type MayflyUiWalkEdge, type MayflyUiWalkNode } from '../../src/core/ui-walk.ts'

const text = (content: string): MayflyUiNode => ({ kind: 'text', content })

const tree = (): MayflyUiWalkNode => ({
  kind: 'stack',
  direction: 'column',
  children: [
    { node: { kind: 'surface', child: text('body'), footer: text('foot') } },
    { node: { kind: 'scroll', child: text('scrolled') }, when: { minWidth: 40 } },
    {
      node: {
        kind: 'list',
        id: 'list',
        selectedIds: [],
        items: [],
        empty: { kind: 'empty', title: 'none', actions: { kind: 'actions', id: 'empty-actions', items: [] } },
      },
    },
  ],
})

describe('walkUiNode', () => {
  it('visits every child position in pre-order', () => {
    const seen: string[] = []
    walkUiNode(tree(), undefined, (node, _context, descend) => {
      seen.push(node.kind)
      descend()
    })
    expect(seen).toEqual(['stack', 'surface', 'text', 'text', 'scroll', 'text', 'list', 'empty', 'actions'])
  })

  it('describes each edge with kind, index, and stack wrapper', () => {
    const edges: MayflyUiWalkEdge[] = []
    walkUiNode(tree(), undefined, (_node, _context, descend) => {
      descend(edge => {
        edges.push(edge)
        return undefined
      })
    })
    expect(edges.map(edge => edge.kind)).toEqual([
      'stack-child', 'surface-child', 'surface-footer',
      'stack-child', 'scroll-child',
      'stack-child', 'list-empty', 'empty-actions',
    ])
    expect(edges.map(edge => edge.index)).toEqual([0, undefined, undefined, 1, undefined, 2, undefined, undefined])
    expect(edges[3]?.wrapper?.when).toEqual({ minWidth: 40 })
  })

  it('prunes an edge when select returns false', () => {
    const seen: string[] = []
    walkUiNode(tree(), undefined, (node, _context, descend) => {
      seen.push(node.kind)
      descend(edge => edge.kind === 'stack-child' && edge.index === 1 ? false : undefined)
    })
    expect(seen).toEqual(['stack', 'surface', 'text', 'text', 'list', 'empty', 'actions'])
  })

  it('threads selected context to children and keeps it otherwise', () => {
    const paths: string[] = []
    walkUiNode(tree(), '$', (node, context, descend) => {
      paths.push(`${context}:${node.kind}`)
      descend(edge => edge.kind === 'stack-child' ? `${context}.${String(edge.index)}` : undefined)
    })
    expect(paths).toEqual([
      '$:stack',
      '$.0:surface', '$.0:text', '$.0:text',
      '$.1:scroll', '$.1:text',
      '$.2:list', '$.2:empty', '$.2:actions',
    ])
  })

  it('stays at the root when the visitor never descends', () => {
    const seen: string[] = []
    walkUiNode(tree(), undefined, node => {
      seen.push(node.kind)
    })
    expect(seen).toEqual(['stack'])
  })

  it('walks nodes without optional child positions and empty stacks', () => {
    const seen: string[] = []
    walkUiNode(
      {
        kind: 'surface',
        child: {
          kind: 'stack',
          direction: 'row',
          children: [
            { node: { kind: 'list', id: 'list', selectedIds: [], items: [{ id: 'item', label: 'Item' }] } },
            { node: { kind: 'empty', title: 'none' } },
            { node: { kind: 'stack', direction: 'row', children: [] } },
          ],
        },
      },
      undefined,
      (node, _context, descend) => {
        seen.push(node.kind)
        descend()
      },
    )
    expect(seen).toEqual(['surface', 'stack', 'list', 'empty', 'stack'])
  })
})

describe('someUiNode', () => {
  it('matches at the root without descending', () => {
    const seen: string[] = []
    expect(someUiNode(tree(), node => {
      seen.push(node.kind)
      return node.kind === 'stack'
    })).toBe(true)
    expect(seen).toEqual(['stack'])
  })

  it('short-circuits at the first deep match in pre-order', () => {
    const seen: string[] = []
    expect(someUiNode(tree(), node => {
      seen.push(node.kind)
      return node.kind === 'scroll'
    })).toBe(true)
    expect(seen).toEqual(['stack', 'surface', 'text', 'text', 'scroll'])
  })

  it('returns false when nothing matches', () => {
    expect(someUiNode(tree(), () => false)).toBe(false)
  })

  it('skips subtrees rejected by the descend filter', () => {
    const seen: string[] = []
    const found = someUiNode(
      tree(),
      node => {
        seen.push(node.kind)
        return node.kind === 'text'
      },
      node => node.kind !== 'surface',
    )
    expect(found).toBe(true)
    expect(seen).toEqual(['stack', 'surface', 'scroll', 'text'])
  })

  it('returns false when the descend filter rejects the root', () => {
    const seen: string[] = []
    expect(someUiNode(tree(), node => {
      seen.push(node.kind)
      return node.kind === 'text'
    }, node => node.kind === 'surface')).toBe(false)
    expect(seen).toEqual(['stack'])
  })
})
