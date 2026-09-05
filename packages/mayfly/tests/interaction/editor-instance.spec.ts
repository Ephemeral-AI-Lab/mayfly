/**
 * Tests for the submit-transformer seam and the enhancement presence marks
 * in `../src/editor-instance.ts`: registration order, concatenation
 * semantics, the empty-contribution fallback, and disposer idempotency.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { MayflyAutocompleteProvider, MayflyComponent, MayflyFocusable } from '../../src/core/index.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  clearSharedEditor,
  PromptEditorController,
  ENHANCEMENT_EDITOR_PLUS,
  getSharedEditor,
  hasEditorEnhancement,
  markEditorEnhancement,
  registerEditorAutocompleteSource,
  setSharedEditor,
  type SharedEditor,
} from '../../src/interaction/editor-instance.ts'
import { EditorPanelController, mountEditorReplacement } from '../../src/interaction/editor-panel-controller.ts'
import {
  applyReversibleSubmitTransformers,
  applySubmitTransformers,
  PromptSubmitPipeline,
  registerSubmitTransformer,
} from '../../src/interaction/prompt-submit-pipeline.ts'

function editorContext(): Context {
  const ctx = new Context()
  new PromptEditorController(ctx)
  new EditorPanelController(ctx)
  new PromptSubmitPipeline(ctx)
  return ctx
}

function autocompleteProvider(): MayflyAutocompleteProvider {
  return {
    getSuggestions: async () => null,
    applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
  }
}

describe('editor extension host state', () => {
  it('publishes the shared editor and clears all owned state on disposal', () => {
    const ctx = editorContext()
    const shared: SharedEditor = {
      editor: {} as SharedEditor['editor'],
      submitPrompt: () => {},
    }
    let notifications = 0
    ctx.mayflyPromptEditor.subscribeEditorState(() => { notifications += 1 })
    setSharedEditor(ctx, shared)
    expect(getSharedEditor(ctx)).toBe(shared)
    clearSharedEditor(ctx)
    expect(getSharedEditor(ctx)).toBeUndefined()

    setSharedEditor(ctx, shared)
    let mounted = false
    ctx.mayflyEditorPanels.setHost({
      mount: () => {
        mounted = true
        return () => {}
      },
    })
    const unmark = markEditorEnhancement(ctx, 'dispose-me')
    const unregisterTransformer = registerSubmitTransformer(ctx, () => [{ type: 'text', text: 'transformed' }])
    const unregisterAutocomplete = registerEditorAutocompleteSource(ctx, 'dispose-me', autocompleteProvider())
    const notificationsBeforeDispose = notifications

    ctx.mayflyPromptEditor.dispose()
    ctx.mayflyEditorPanels.dispose()
    ctx.mayflyPromptSubmissions.dispose()
    expect(getSharedEditor(ctx)).toBeUndefined()
    expect(ctx.mayflyPromptEditor.listAutocompleteSources()).toEqual([])
    expect(hasEditorEnhancement(ctx, 'dispose-me')).toBe(false)
    expect(applySubmitTransformers(ctx, 'plain')).toEqual([{ type: 'text', text: 'plain' }])
    mountEditorReplacement(ctx, {} as MayflyFocusable)
    expect(mounted).toBe(false)

    setSharedEditor(ctx, shared)
    expect(notifications).toBe(notificationsBeforeDispose)
    unregisterTransformer()
    unregisterAutocomplete()
    unmark()
  })

  it('keeps autocomplete sources ordered, unique, frozen, and lifecycle-notified', () => {
    const ctx = editorContext()
    const first = autocompleteProvider()
    const second = autocompleteProvider()
    let notifications = 0
    const unsubscribe = ctx.mayflyPromptEditor.subscribeEditorState(() => { notifications += 1 })

    const unregisterFirst = registerEditorAutocompleteSource(ctx, 'first', first)
    const firstSnapshot = ctx.mayflyPromptEditor.listAutocompleteSources()
    expect(firstSnapshot).toEqual([first])
    expect(Object.isFrozen(firstSnapshot)).toBe(true)
    expect(notifications).toBe(1)

    const unregisterSecond = registerEditorAutocompleteSource(ctx, 'second', second)
    expect(ctx.mayflyPromptEditor.listAutocompleteSources()).toEqual([first, second])
    expect(firstSnapshot).toEqual([first])
    expect(notifications).toBe(2)
    expect(() => registerEditorAutocompleteSource(ctx, 'second', first)).toThrow(
      'editor autocomplete source "second" is already registered',
    )
    expect(notifications).toBe(2)

    unregisterFirst()
    unregisterFirst()
    expect(ctx.mayflyPromptEditor.listAutocompleteSources()).toEqual([second])
    expect(notifications).toBe(3)

    unregisterSecond()
    expect(ctx.mayflyPromptEditor.listAutocompleteSources()).toEqual([])
    expect(notifications).toBe(4)
    unsubscribe()
  })
})

describe('submit transformers', () => {
  it('composes idempotent rollback functions in reverse registration order', () => {
    const ctx = editorContext()
    const restored: string[] = []
    const first = registerSubmitTransformer(ctx, () => ({
      blocks: [{ type: 'text', text: 'first' }],
      rollback: () => restored.push('first'),
    }))
    const second = registerSubmitTransformer(ctx, () => ({
      blocks: [{ type: 'text', text: 'second' }],
      rollback: () => restored.push('second'),
    }))
    try {
      const result = applyReversibleSubmitTransformers(ctx, 'x')
      expect(result.blocks.map(block => block.type === 'text' ? block.text : block.type)).toEqual(['first', 'second'])
      result.rollback?.()
      result.rollback?.()
      expect(restored).toEqual(['second', 'first'])
    } finally {
      second()
      first()
    }
  })

  it('accepts an object contribution without a rollback', () => {
    const ctx = editorContext()
    const dispose = registerSubmitTransformer(ctx, () => ({ blocks: [{ type: 'text', text: 'object' }] }))
    try {
      expect(applyReversibleSubmitTransformers(ctx, 'x')).toEqual({ blocks: [{ type: 'text', text: 'object' }] })
    } finally {
      dispose()
    }
  })

  it('returns the historical single text block with no transformers registered', () => {
    const ctx = editorContext()
    expect(applySubmitTransformers(ctx, 'plain')).toEqual([{ type: 'text', text: 'plain' }])
  })

  it('concatenates every transformer contribution in registration order', () => {
    const ctx = editorContext()
    const disposeFirst = registerSubmitTransformer(ctx, text => [
      { type: 'text', text: `first:${text}` },
    ])
    const disposeSecond = registerSubmitTransformer(ctx, () => [
      { type: 'text', text: 'second-a' },
      { type: 'text', text: 'second-b' },
    ])
    expect(applySubmitTransformers(ctx, 'x')).toEqual([
      { type: 'text', text: 'first:x' },
      { type: 'text', text: 'second-a' },
      { type: 'text', text: 'second-b' },
    ])
    disposeFirst()
    disposeSecond()
  })

  it('skips empty contributions and falls back to the text block when all decline', () => {
    const ctx = editorContext()
    const disposeEmpty = registerSubmitTransformer(ctx, () => [])
    expect(applySubmitTransformers(ctx, 'untouched')).toEqual([{ type: 'text', text: 'untouched' }])
    const disposeReal = registerSubmitTransformer(ctx, (text): ContentBlock[] => [
      { type: 'text', text: `kept:${text}` },
    ])
    expect(applySubmitTransformers(ctx, 'y')).toEqual([{ type: 'text', text: 'kept:y' }])
    disposeEmpty()
    disposeReal()
  })

  it('disposer unregisters exactly once and is safe to call twice', () => {
    const ctx = editorContext()
    const dispose = registerSubmitTransformer(ctx, text => [{ type: 'text', text: `gone:${text}` }])
    expect(applySubmitTransformers(ctx, 'z')).toEqual([{ type: 'text', text: 'gone:z' }])
    dispose()
    dispose()
    expect(applySubmitTransformers(ctx, 'z')).toEqual([{ type: 'text', text: 'z' }])
  })
})

describe('enhancement presence marks', () => {
  it('marks attachment, reports presence, and unmarks exactly once', () => {
    const ctx = editorContext()
    expect(hasEditorEnhancement(ctx, ENHANCEMENT_EDITOR_PLUS)).toBe(false)
    const unmark = markEditorEnhancement(ctx, ENHANCEMENT_EDITOR_PLUS)
    expect(hasEditorEnhancement(ctx, ENHANCEMENT_EDITOR_PLUS)).toBe(true)
    unmark()
    unmark()
    expect(hasEditorEnhancement(ctx, ENHANCEMENT_EDITOR_PLUS)).toBe(false)
  })
})

describe('editor-slot swap', () => {
  it('degrades to a no-op when the optional panel service is absent', () => {
    const restore = mountEditorReplacement(new Context(), {} as MayflyFocusable)
    expect(() => restore()).not.toThrow()
  })

  it('retains a panel until a host is installed', () => {
    const ctx = editorContext()
    ctx.mayflyEditorPanels.setHost(undefined)
    const panel: MayflyFocusable & MayflyComponent = {
      focused: false,
      handleInput: () => {},
      invalidate: () => {},
      render: () => ['panel'],
    }
    const restore = mountEditorReplacement(ctx, panel)
    const mounted: MayflyFocusable[] = []
    ctx.mayflyEditorPanels.setHost({
      mount: component => {
        mounted.push(component)
        return () => { mounted.splice(mounted.indexOf(component), 1) }
      },
    })
    expect(mounted).toEqual([panel])
    restore()
    restore()
    expect(mounted).toEqual([])
  })

  it('mounts through the installed swap and forwards the disposer', () => {
    const ctx = editorContext()
    const mounted: string[] = []
    ctx.mayflyEditorPanels.setHost({
      mount: (component) => {
        mounted.push(component.render(10)[0] ?? '')
        let restored = false
        return () => {
          if (restored) return
          restored = true
          mounted.pop()
        }
      },
    })
    const panel: MayflyFocusable & MayflyComponent = {
      focused: false,
      handleInput: () => {},
      invalidate: () => {},
      render: () => ['panel'],
    }
    const restore = mountEditorReplacement(ctx, panel)
    expect(mounted).toEqual(['panel'])
    restore()
    restore()
    expect(mounted).toEqual([])
    // Leave the module state clean for the suites that follow.
    ctx.mayflyEditorPanels.setHost(undefined)
  })

  it('replays the complete stack in order when the host changes', () => {
    const ctx = editorContext()
    const first = { focused: false, invalidate: () => {}, render: () => ['first'] } as MayflyFocusable
    const second = { focused: false, invalidate: () => {}, render: () => ['second'] } as MayflyFocusable
    const firstHost: string[] = []
    const secondHost: string[] = []
    const host = (rows: string[]) => ({
      mount: (component: MayflyFocusable) => {
        const value = component.render(10)[0]!
        rows.push(value)
        return () => { rows.splice(rows.indexOf(value), 1) }
      },
    })
    ctx.mayflyEditorPanels.setHost(host(firstHost))
    const restoreFirst = ctx.mayflyEditorPanels.mount(first)
    const restoreSecond = ctx.mayflyEditorPanels.mount(second)
    expect(firstHost).toEqual(['first', 'second'])

    ctx.mayflyEditorPanels.setHost(host(secondHost))
    expect(firstHost).toEqual([])
    expect(secondHost).toEqual(['first', 'second'])
    restoreSecond()
    expect(secondHost).toEqual(['first'])
    restoreFirst()
    expect(secondHost).toEqual([])
  })

  it('rolls back a partial replay when the replacement host rejects a panel', () => {
    const ctx = editorContext()
    const first = { focused: false, invalidate: () => {}, render: () => ['first'] } as MayflyFocusable
    const second = { focused: false, invalidate: () => {}, render: () => ['second'] } as MayflyFocusable
    const old = new Set<MayflyFocusable>()
    ctx.mayflyEditorPanels.setHost({
      mount: component => {
        old.add(component)
        return () => { old.delete(component) }
      },
    })
    ctx.mayflyEditorPanels.mount(first)
    ctx.mayflyEditorPanels.mount(second)
    const partial = new Set<MayflyFocusable>()
    expect(() => ctx.mayflyEditorPanels.setHost({
      mount: component => {
        if (component === second) throw new Error('host rejected second')
        partial.add(component)
        return () => { partial.delete(component) }
      },
    })).toThrow('host rejected second')
    expect(old.size).toBe(0)
    expect(partial.size).toBe(0)

    const recovered: MayflyFocusable[] = []
    ctx.mayflyEditorPanels.setHost({ mount: component => { recovered.push(component); return () => {} } })
    expect(recovered).toEqual([first, second])
  })

  it('forgets a panel whose initial host mount throws', () => {
    const ctx = editorContext()
    const panel = { focused: false, invalidate: () => {}, render: () => ['panel'] } as MayflyFocusable
    ctx.mayflyEditorPanels.setHost({ mount: () => { throw new Error('mount failed') } })
    expect(() => ctx.mayflyEditorPanels.mount(panel)).toThrow('mount failed')
    const recovered: MayflyFocusable[] = []
    ctx.mayflyEditorPanels.setHost({ mount: component => { recovered.push(component); return () => {} } })
    expect(recovered).toEqual([])
  })

  it('does not replay a panel disposed before the host appears', () => {
    const ctx = editorContext()
    const panel = { focused: false, invalidate: () => {}, render: () => ['panel'] } as MayflyFocusable
    const restore = ctx.mayflyEditorPanels.mount(panel)
    restore()
    const mounted: MayflyFocusable[] = []
    ctx.mayflyEditorPanels.setHost({ mount: component => { mounted.push(component); return () => {} } })
    expect(mounted).toEqual([])
  })

  it('unmounts the live stack and refuses later mounts after disposal', () => {
    const ctx = editorContext()
    const mounted: MayflyFocusable[] = []
    ctx.mayflyEditorPanels.setHost({
      mount: component => {
        mounted.push(component)
        return () => { mounted.splice(mounted.indexOf(component), 1) }
      },
    })
    const panel = { focused: false, invalidate: () => {}, render: () => ['panel'] } as MayflyFocusable
    ctx.mayflyEditorPanels.mount(panel)
    ctx.mayflyEditorPanels.dispose()
    ctx.mayflyEditorPanels.dispose()
    expect(mounted).toEqual([])
    const ignored = ctx.mayflyEditorPanels.mount(panel)
    ignored()
    expect(mounted).toEqual([])
  })
})
