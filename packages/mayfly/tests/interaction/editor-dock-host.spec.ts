/** Stable editor dock host focus, panel-stack, and disposal behavior. */
import { describe, expect, it, vi } from 'vitest'
import { EditorDockHost } from '../../src/interaction/editor-dock-host.ts'
import type { MayflyFocusable } from '../../src/core/index.ts'

function focusable(name: string, withInput = true): MayflyFocusable {
  return {
    focused: false,
    render: vi.fn(() => [name]),
    invalidate: vi.fn(),
    ...(withInput ? { handleInput: vi.fn() } : {}),
  }
}

describe('EditorDockHost', () => {
  it('switches a focused stable host between editor, hint, and stacked panels', () => {
    const editor = focusable('editor')
    const hint = { render: vi.fn(() => ['hint']), invalidate: vi.fn() }
    const occupancy = vi.fn()
    const host = new EditorDockHost(editor, hint, occupancy)

    expect(host.focused).toBe(false)
    host.focused = true
    expect(host.focused).toBe(true)
    expect(editor.focused).toBe(true)
    expect(host.render(20)).toEqual(['editor', 'hint'])
    expect(host.renderHint(20)).toEqual(['hint'])
    host.invalidate()
    host.handleInput('draft')
    expect(editor.invalidate).toHaveBeenCalledOnce()
    expect(hint.invalidate).toHaveBeenCalledOnce()
    expect(editor.handleInput).toHaveBeenCalledWith('draft')

    const outer = focusable('outer')
    const inner = focusable('inner', false)
    const removeOuter = host.mountPanel(outer)
    const removeInner = host.mountPanel(inner)
    expect(occupancy).toHaveBeenCalledTimes(1)
    expect(occupancy).toHaveBeenCalledWith(true)
    expect(outer.focused).toBe(false)
    expect(inner.focused).toBe(true)
    expect(host.render(20)).toEqual(['inner'])
    expect(host.renderHint(20)).toEqual([])
    host.invalidate()
    host.handleInput('ignored')
    expect(inner.invalidate).toHaveBeenCalledOnce()

    removeOuter()
    expect(host.render(20)).toEqual(['inner'])
    removeOuter()
    removeInner()
    expect(inner.focused).toBe(false)
    expect(editor.focused).toBe(true)
    expect(occupancy).toHaveBeenLastCalledWith(false)
  })

  it('disposes occupied and empty hosts idempotently and rejects late panels', () => {
    const editor = focusable('editor')
    const hint = { render: vi.fn(() => ['hint']), invalidate: vi.fn() }
    const occupancy = vi.fn()
    const occupied = new EditorDockHost(editor, hint, occupancy)
    const panel = focusable('panel')
    const remove = occupied.mountPanel(panel)
    occupied.focused = true
    occupied.dispose()
    occupied.dispose()
    remove()
    expect(panel.focused).toBe(false)
    expect(occupancy.mock.calls).toEqual([[true], [false]])
    expect(occupied.focused).toBe(false)
    expect(occupied.render(20)).toEqual([])
    expect(occupied.renderHint(20)).toEqual([])
    occupied.invalidate()
    occupied.handleInput('ignored')
    const late = occupied.mountPanel(focusable('late'))
    expect(() => late()).not.toThrow()

    const empty = new EditorDockHost(focusable('editor'), hint, occupancy)
    empty.dispose()
    expect(occupancy.mock.calls).toEqual([[true], [false]])
  })
})
