import { describe, expect, it, vi } from 'vitest'
import type {
  MayflyActionsNode,
  MayflyEmptyNode,
  MayflyFieldsNode,
  MayflyListNode,
  MayflyListItem,
  MayflyStackNode,
  MayflySurfaceNode,
  MayflyTextNode,
  MayflyUiNode,
} from '@ephemeral-ai/mayfly-ui'
import {
  REMOTE_PLUGINS_LIST_ID,
  REMOTE_PLUGINS_REFRESH_ID,
  REMOTE_UPDATE_REFRESH_ID,
  remotePluginInventoryNode,
  remoteUpdateNode,
  type RemotePluginRow,
} from '../../src/remote/panels/operations/plugins.ts'

function translate() {
  return vi.fn((key: string) => key)
}

function row(overrides: Partial<RemotePluginRow> = {}): RemotePluginRow {
  return { name: 'alpha', detail: '@scope/alpha', state: 'enabled', kind: 'active', ...overrides }
}

/** The children of a column stack, which is what every panel body starts with. */
function bodyChildren(node: MayflyUiNode): readonly MayflyUiNode[] {
  expect(node.kind).toBe('stack')
  const stack = node as MayflyStackNode
  expect(stack.direction).toBe('column')
  return stack.children.map(child => child.node)
}

function listOf(node: MayflyUiNode | undefined): MayflyListNode {
  expect(node?.kind).toBe('list')
  return node as MayflyListNode
}

function cell(item: MayflyListItem, index: number) {
  return item.cells![index]!
}

function cellText(item: MayflyListItem, index: number): string {
  return cell(item, index).spans[0]!.text
}

function textOf(node: MayflyUiNode | undefined): MayflyTextNode {
  expect(node?.kind).toBe('text')
  return node as MayflyTextNode
}

describe('remotePluginInventoryNode', () => {
  it('renders the panel title, one row per plugin, and the read-only notice', () => {
    const t = translate()
    const node = remotePluginInventoryNode({
      rows: [row(), row({ name: 'beta', detail: '@scope/beta', state: 'disabled', kind: '' })],
      error: undefined,
    }, t)
    const surface = node as MayflySurfaceNode
    expect(surface.kind).toBe('surface')
    expect(surface.title).toBe('Plugins')
    expect(surface.escapeLabel).toBe('close')
    expect(t).toHaveBeenCalledWith('Plugins')

    const [listNode, note, actions] = bodyChildren(surface.child)
    const list = listOf(listNode)
    expect(list.id).toBe(REMOTE_PLUGINS_LIST_ID)
    expect(list.role).toBe('browse')
    expect(list.filterable).toBe(true)
    expect(list.filterMode).toBe('slash')
    expect(list.items).toHaveLength(2)
    expect(list.items[0]!.id).toBe('0:alpha')
    expect(list.items[0]!.label).toBe('alpha')
    expect(list.items[1]!.label).toBe('beta')

    expect(textOf(note).content).toContain('Only the Host may change its own plugins')
    expect(textOf(note).tone).toBe('muted')

    expect((actions as MayflyActionsNode).kind).toBe('actions')
    expect((actions as MayflyActionsNode).items[0]).toMatchObject({
      id: REMOTE_PLUGINS_REFRESH_ID,
      label: 'Refresh',
      hintLabel: 'refresh',
      semantic: 'refresh',
      hidden: true,
    })
  })

  it('carries the fiber phase, the enabled state, and the module specifier in the row cells', () => {
    const node = remotePluginInventoryNode({
      rows: [row(), row({ name: 'beta', detail: '@scope/beta', state: 'disabled', kind: '' })],
      error: undefined,
    }, translate())
    const list = listOf(bodyChildren((node as MayflySurfaceNode).child)[0])
    const [enabled, disabled] = list.items

    expect(cellText(enabled!, 0)).toBe(' active')
    expect(cell(enabled!, 0).align).toBe('right')
    expect(cell(enabled!, 0).spans[0]!.tone).toBe('muted')
    expect(cellText(enabled!, 1)).toBe('enabled')
    expect(cell(enabled!, 1).spans[0]!.tone).toBe('success')
    expect(cellText(enabled!, 2)).toBe('@scope/alpha')
    expect(cell(enabled!, 2).align).toBe('right')
    expect(cell(enabled!, 2).spans[0]!.tone).toBe('muted')

    expect(cellText(disabled!, 0)).toBe('')
    expect(cellText(disabled!, 1)).toBe('disabled')
    expect(cell(disabled!, 1).spans[0]!.tone).toBe('warning')
    expect(cellText(disabled!, 2)).toBe('@scope/beta')

    expect(enabled!.searchText).toBe('alpha @scope/alpha')
    expect(disabled!.searchText).toBe('beta @scope/beta')
  })

  it('reports the Host failure above the list and offers the empty state when no rows exist', () => {
    const t = translate()
    const node = remotePluginInventoryNode({ rows: [], error: 'host offline' }, t)
    const children = bodyChildren((node as MayflySurfaceNode).child)
    expect(children).toHaveLength(4)

    const error = textOf(children[0])
    expect(error.content).toBe('host offline')
    expect(error.tone).toBe('danger')
    expect(error.overflow).toBe('wrap')

    const list = listOf(children[1])
    expect(list.items).toEqual([])
    expect((list.empty as MayflyEmptyNode).kind).toBe('empty')
    expect((list.empty as MayflyEmptyNode).title).toBe('No plugins reported by this Host')
    expect(t).toHaveBeenCalledWith('No plugins reported by this Host')
  })
})

describe('remoteUpdateNode', () => {
  it('reports the unavailable fields until a check succeeds, then the verdict tone', () => {
    const t = translate()
    const surface = remoteUpdateNode({ facts: undefined, error: undefined }, t) as MayflySurfaceNode
    expect(surface.title).toBe('Update check')
    const [fields, note, actions] = bodyChildren(surface.child)
    const rows = (fields as MayflyFieldsNode).rows
    expect(rows.map(field => field.label)).toEqual(['Mayfly version', 'Latest release'])
    expect(rows.map(field => field.value[0]!.text)).toEqual(['unavailable', 'unavailable'])
    expect(textOf(note).tone).toBe('muted')
    expect((actions as MayflyActionsNode).items[0]!.id).toBe(REMOTE_UPDATE_REFRESH_ID)

    const newer = remoteUpdateNode({ facts: { current: '0.1.0', latest: '0.2.0', newer: true }, error: undefined }, t) as MayflySurfaceNode
    const newerChildren = bodyChildren(newer.child)
    expect((newerChildren[0] as MayflyFieldsNode).rows.map(field => field.value[0]!.text)).toEqual(['0.1.0', '0.2.0'])
    expect(textOf(newerChildren[1]).tone).toBe('warning')
    expect(textOf(newerChildren[1]).content).toContain('A newer release is available')

    const current = remoteUpdateNode({ facts: { current: '0.2.0', latest: '0.2.0', newer: false }, error: undefined }, t) as MayflySurfaceNode
    expect(textOf(bodyChildren(current.child)[1]).tone).toBe('success')

    const failed = remoteUpdateNode({ facts: undefined, error: 'registry offline' }, t) as MayflySurfaceNode
    const failedChildren = bodyChildren(failed.child)
    expect(textOf(failedChildren[0]).content).toBe('registry offline')
    expect(textOf(failedChildren[0]).tone).toBe('danger')
  })
})
