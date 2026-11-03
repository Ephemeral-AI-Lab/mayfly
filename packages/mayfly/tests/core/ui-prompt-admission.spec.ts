/** Prompt source definitions stay stable across compiler admission and expire with their surface. @module */
import { describe, expect, it, vi } from 'vitest'
import { ui, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { UiSurfaceModel, type UiSurfaceSnapshot } from '../../src/core/ui-interaction-surface.ts'

const address = { pagePath: [], controlId: 'prompt' }

function setup(node: MayflyUiNode) {
  const events = { prepare: async () => ({ reply: { kind: 'completed' as const }, publish: () => true }) }
  let revision = 0
  const snapshot = (node: MayflyUiNode | null): UiSurfaceSnapshot => ({
    id: 'surface', revision: revision++, node, source: [], scope: { kind: 'app', targetId: 'prompt-test' }, update: { reason: 'data' }, definition: {}, events,
  })
  const model = new UiSurfaceModel('prompt-instance', snapshot(node))
  const stable = () => {
    const before = model.revision
    for (let frame = 0; frame < 4; frame += 1) model.admitVisibleControls()
    expect(model.revision).toBe(before)
  }
  return { model, stable, receive: (node: MayflyUiNode | null) => model.receive(snapshot(node)), definitions: () => Reflect.get(model, 'promptDefinitions') as ReadonlyMap<string, unknown> }
}

describe('prompt definition admission', () => {
  it('does not notify on repeated source admission and still reconciles new completions and reset revisions', () => {
    const { model, stable, receive } = setup(ui.prompt({ id: 'prompt', value: 'initial' }))
    const changed = vi.fn()
    const stop = model.subscribe(changed)
    try {
      stable()
      expect(changed).not.toHaveBeenCalled()
      model.updatePrompt(address, { kind: 'edit', value: 'draft' })
      changed.mockClear()
      stable()
      expect(changed).not.toHaveBeenCalled()
      expect(model.prompt(address)?.text).toBe('draft')
      receive(ui.prompt({ id: 'prompt', value: 'different baseline', completions: { items: [{ id: 'new', label: 'New choice' }] } }))
      expect(model.prompt(address)?.text).toBe('draft')
      expect(model.prompt(address)?.definition.completions?.items[0]?.id).toBe('new')
      expect(changed).toHaveBeenCalledOnce()
      changed.mockClear()
      stable()
      expect(changed).not.toHaveBeenCalled()
      receive(ui.prompt({ id: 'prompt', reset: { rev: 1, value: 'replacement' } }))
      expect(model.prompt(address)).toMatchObject({ text: 'replacement', resetRev: 1 })
      stable()
    } finally { stop(); model.dispose() }
  })

  it.each(['delete', 'null', 'unload'] as const)('releases original source identities on %s and starts the next instance with its current baseline', retire => {
    const { model, stable, receive, definitions } = setup(ui.prompt({ id: 'prompt', value: 'initial' }))
    model.updatePrompt(address, { kind: 'edit', value: 'discarded draft' })
    expect(definitions().size).toBe(1)
    if (retire === 'delete') receive(ui.text('removed'))
    else if (retire === 'null') receive(null)
    else model.dispose()
    expect(definitions().size).toBe(0)
    expect(model.prompt(address)).toBeUndefined()
    if (retire !== 'unload') {
      receive(ui.prompt({ id: 'prompt', value: 'new baseline' }))
      expect(model.prompt(address)?.text).toBe('new baseline')
      expect(definitions().size).toBe(1)
      stable()
    }
    model.dispose()
    expect(definitions().size).toBe(0)
  })
})
