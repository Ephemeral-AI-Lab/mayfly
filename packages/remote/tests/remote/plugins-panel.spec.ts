import { describe, expect, it, vi } from 'vitest'
import type {
  MayflyActionsNode,
  MayflyFieldsNode,
  MayflyStackNode,
  MayflySurfaceNode,
  MayflyTextNode,
  MayflyUiNode,
} from '@ephemeral-ai/mayfly-ui'
import {
  REMOTE_UPDATE_REFRESH_ID,
  remoteUpdateNode,
} from '../../src/remote/panels/operations/plugins.ts'

function translate() {
  return vi.fn((key: string) => key)
}

/** The children of a column stack, which is what every panel body starts with. */
function bodyChildren(node: MayflyUiNode): readonly MayflyUiNode[] {
  expect(node.kind).toBe('stack')
  const stack = node as MayflyStackNode
  expect(stack.direction).toBe('column')
  return stack.children.map(child => child.node)
}

function textOf(node: MayflyUiNode | undefined): MayflyTextNode {
  expect(node?.kind).toBe('text')
  return node as MayflyTextNode
}

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
