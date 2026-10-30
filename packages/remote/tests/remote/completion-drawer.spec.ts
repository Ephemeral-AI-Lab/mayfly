import { describe, expect, it, vi } from 'vitest'
import type {
  MayflyCompletionView,
  MayflyEditor,
  MayflyOverlayOptions,
  MayflyScreenService,
  MayflySemanticColors,
} from '@ephemeral-ai/mayfly/core'
import { mountRemoteCompletionDrawer } from '../../src/remote/completion-drawer.ts'

/**
 * Display width as the terminal counts it: a CJK or fullwidth code point takes
 * two cells, everything else one. Using `text.length` here would hide exactly
 * the wide-glyph overflow this suite exists to catch.
 */
function displayWidth(text: string): number {
  let total = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    total += code >= 0x1100 && (code <= 0x115F || (code >= 0x2E80 && code <= 0xA4CF)
      || (code >= 0xAC00 && code <= 0xD7A3) || (code >= 0xF900 && code <= 0xFAFF)
      || (code >= 0xFE30 && code <= 0xFE6F) || (code >= 0xFF00 && code <= 0xFF60)
      || (code >= 0xFFE0 && code <= 0xFFE6) || (code >= 0x1F300 && code <= 0x1FAFF)) ? 2 : 1
  }
  return total
}

const measure = {
  visibleWidth: displayWidth,
  // Cut by display width, like the shared component measure: slicing by code
  // point would keep a two-cell glyph that no longer fits.
  truncateToWidth: (text: string, width: number) => {
    let used = 0
    let out = ''
    for (const character of text) {
      const cells = displayWidth(character)
      if (used + cells > width) break
      used += cells
      out += character
    }
    return out
  },
}

/** Only `selectedBg` is read; keeping it identity makes padding measurable. */
const colors = {
  selectedBg: (text: string) => text,
} as unknown as MayflySemanticColors

interface DrawerComponent {
  render(width: number): string[]
}

function completion(overrides: Partial<MayflyCompletionView> = {}): MayflyCompletionView {
  return {
    kind: 'commands',
    items: [
      { label: 'model', value: 'model', detail: 'Change the model' },
      { label: 'mode', value: 'mode', detail: 'Change the mode' },
    ],
    index: 0,
    prefix: '/',
    ...overrides,
  }
}

function fixture(initial: MayflyCompletionView | undefined) {
  const handle = { hide: vi.fn() }
  const showOverlay = vi.fn(() => handle)
  const screen = { showOverlay, columns: 40, editorRowsFromBottom: 2 } as unknown as MayflyScreenService
  const state: { view: MayflyCompletionView | undefined } = { view: initial }
  const editor = { completion: () => state.view } as unknown as MayflyEditor
  const drawer = mountRemoteCompletionDrawer(screen, editor, colors, measure)
  const component = (): DrawerComponent => vi.mocked(showOverlay).mock.calls.at(-1)![0] as unknown as DrawerComponent
  const options = (): MayflyOverlayOptions => vi.mocked(showOverlay).mock.calls.at(-1)![1]!
  return { drawer, handle, screen, showOverlay, state, component, options }
}

describe('mountRemoteCompletionDrawer', () => {
  it('mounts nothing when the screen has no overlay layer', () => {
    const screen = { columns: 80, editorRowsFromBottom: 0 } as unknown as MayflyScreenService
    const editor = { completion: () => completion() } as unknown as MayflyEditor
    const drawer = mountRemoteCompletionDrawer(screen, editor, colors, measure)
    expect(() => drawer.dispose()).not.toThrow()
  })

  it('keeps the overlay invisible and paints no rows while no completion is open', () => {
    const { component, options, state } = fixture(undefined)
    expect(options().visible!(40, 24)).toBe(false)
    expect(component().render(40)).toEqual([])

    state.view = completion()
    expect(options().visible!(40, 24)).toBe(true)
    expect(component().render(40)).toHaveLength(2)
  })

  it('shows the palette as a non-capturing bottom-left overlay sized from the screen', () => {
    const { drawer, handle, options, screen } = fixture(undefined)
    const overlay = options()
    expect(overlay.anchor).toBe('bottom-left')
    expect(overlay.nonCapturing).toBe(true)
    expect(overlay.width).toBe(screen.columns)
    expect(overlay.offsetY).toBe(-screen.editorRowsFromBottom)
    expect(overlay.visible!(40, 24)).toBe(false)

    drawer.dispose()
    expect(handle.hide).toHaveBeenCalledOnce()
  })

  it('paints one padded row per item, with the arrow only on the focused row', () => {
    const { component } = fixture(completion({ index: 1 }))
    const rows = component().render(36)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.startsWith('    ')).toBe(true)
    expect(rows[1]!.startsWith('  › ')).toBe(true)
    expect(rows[1]).toContain('mode')
    expect(rows[1]).toContain('  Change the mode')
    expect(rows.filter(row => row.includes('›'))).toHaveLength(1)
    for (const row of rows) expect(row).toHaveLength(36)
  })

  it('caps the palette at six rows and windows them so the focused item stays visible', () => {
    const items = Array.from({ length: 10 }, (_, index) => ({ label: `cmd-${String(index)}`, value: `cmd-${String(index)}` }))

    const middle = fixture(completion({ items, index: 7 }))
    const rows = middle.component().render(30)
    expect(rows).toHaveLength(6)
    expect(rows[0]).toContain('cmd-4')
    expect(rows[5]).toContain('cmd-9')
    expect(rows[3]!.startsWith('  › ')).toBe(true)
    expect(rows.filter(row => row.includes('›'))).toHaveLength(1)

    const head = fixture(completion({ items, index: 0 })).component().render(30)
    expect(head[0]!.startsWith('  › ')).toBe(true)
    expect(head[0]).toContain('cmd-0')
    expect(head).toHaveLength(6)

    const tail = fixture(completion({ items, index: 9 })).component().render(30)
    expect(tail[5]!.startsWith('  › ')).toBe(true)
    expect(tail[5]).toContain('cmd-9')
  })

  it('paints the item label, not the insertion value, and drops the detail on a narrow row', () => {
    // The label is what the palette is for: a command row labels an alias match
    // `/name (alias)` while its value is the bare insertion text, and a
    // directory row's value is the quoted `@"dir/"` that must never be drawn.
    const { component } = fixture(completion({
      items: [{ label: '/model (m)', value: '/model', detail: 'Switch the model' }],
      index: 0,
    }))
    const row = component().render(40)[0]!
    expect(row).toContain('/model (m)')
    expect(row).not.toContain('@"')

    const narrow = fixture(completion()).component().render(12)
    for (const line of narrow) expect(line).toHaveLength(12)
    expect(narrow[0]).not.toContain('Change')
  })

  it('never paints a row wider than the overlay when the name is double-width', () => {
    // A wide glyph occupies two cells; padding by UTF-16 units would over-pad
    // and push the detail past the frame, which the core painter never does.
    const { component } = fixture(completion({
      items: [{ label: '模型命令选择', value: '/model', detail: '切换当前会话使用的模型以及推理强度' }],
      index: 0,
    }))
    for (const width of [24, 40, 60]) {
      for (const line of component().render(width)) {
        expect(displayWidth(line)).toBeLessThanOrEqual(width)
      }
    }
  })
})
