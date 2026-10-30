import { describe, expect, it } from 'vitest'
import type { MayflyListNode, MayflyStackNode, MayflySurfaceNode, MayflyTranslate, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { remoteFilesNode, type RemoteFilesRow, type RemoteFilesState } from '../../src/remote/panels/operations/files.ts'

/** English is the key map, so the identity translator reads back the source strings. */
const t: MayflyTranslate = key => key

/** The one list the panel body carries, whatever else the stack holds. */
function listOf(node: MayflyUiNode): MayflyListNode {
  const surface = node as MayflySurfaceNode
  const column = surface.child as MayflyStackNode
  const list = column.children.map(child => child.node).find((child): child is MayflyListNode => child.kind === 'list')
  if (list === undefined) throw new Error('the files panel carries no list')
  return list
}

/** The list's empty-state title, or '' while rows hide it. */
function emptyTitleOf(node: MayflyUiNode): string {
  const empty = listOf(node).empty
  return empty !== undefined && empty.kind === 'empty' ? empty.title : ''
}

function state(rows: readonly RemoteFilesRow[], available = true): RemoteFilesState {
  return { available, rows }
}

describe('remoteFilesNode', () => {
  it('renders one list row per delivered file under the delivered-files panel', () => {
    const node = remoteFilesNode(state([
      { id: 'a', path: '/work/a.txt', description: 'Alpha' },
      { id: 'b', path: '/work/b.txt', description: undefined },
      { id: 'c', path: '/work/c.txt', description: 'Gamma' },
    ]), t)
    const surface = node as MayflySurfaceNode
    expect(surface.title).toBe('Delivered files')
    expect(surface.escapeLabel).toBe('close')
    const items = listOf(node).items
    expect(items.map(item => item.id)).toEqual(['a', 'b', 'c'])
    expect(items.map(item => item.label)).toEqual(['/work/a.txt', '/work/b.txt', '/work/c.txt'])
  })

  it('says an empty session delivered nothing only once the projection is published', () => {
    const published = remoteFilesNode(state([]), t)
    expect(listOf(published).items).toHaveLength(0)
    expect(emptyTitleOf(published)).toBe('No files were delivered in this session yet')

    const unpublished = remoteFilesNode(state([], false), t)
    expect(listOf(unpublished).items).toHaveLength(0)
    expect(emptyTitleOf(unpublished)).toBe('This session does not expose the deliverables projection')
  })

  it('right-aligns a muted description cell and never asks for a zero minimum', () => {
    const items = listOf(remoteFilesNode(state([
      { id: 'a', path: '/work/a.txt', description: 'Alpha' },
      { id: 'b', path: '/work/b.txt', description: undefined },
      { id: 'c', path: '/work/c.txt', description: 'Gamma' },
    ]), t)).items
    const described = items.filter(item => item.cells !== undefined)
    expect(described).toHaveLength(2)
    expect(items[1]?.cells).toBeUndefined()
    const cells = described.flatMap(item => item.cells ?? [])
    expect(cells.length).toBeGreaterThan(0)
    for (const cell of cells) {
      expect(cell.align).toBe('right')
      expect(cell.min).toBeTypeOf('number')
      expect(cell.min).toBeGreaterThanOrEqual(1)
    }
    expect(cells.map(cell => cell.min)).not.toContain(0)
    expect(cells[0]?.spans).toMatchObject([{ text: 'Alpha', tone: 'muted' }])
  })
})
