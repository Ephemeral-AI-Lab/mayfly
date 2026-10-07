/** The segment strip: its painters, the width ladder (120, 84, 62, and 40 columns), and the keys that pin and unpin a row. */
import { afterEach, describe, expect, it } from 'vitest'
import { ui, type MayflyListSegment, type MayflyUiEvent } from '../../../ui/src/index.ts'
import { createRealSurface, parityComponents, type RealSurface } from '../design/parity.ts'
import { inlineSegmentStrip, segmentFitsInline, segmentFooter, segmentStrip, type SegmentView } from '../../src/core/ui-list-segment.ts'
import type { MayflySemanticColors } from '../../src/core/types.ts'
import { visibleWidth } from '../../src/core/width.ts'

const identity = (value: string): string => value
const colors = new Proxy({ logoGradient: [identity] }, { get: (target, key) => key === 'logoGradient' ? target.logoGradient : identity }) as MayflySemanticColors
const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/gu, '')

const segment: MayflyListSegment = { label: 'Thinking', options: [{ id: 'min', label: 'min' }, { id: 'high', label: 'high' }, { id: 'max', label: 'max' }], inheritedId: 'high' }
const view = (pinned: string | null, active = pinned ?? segment.inheritedId): SegmentView => ({ segment, pinned, active })

describe('segment strip painters', () => {
  it('marks the inherited option (default) while unpinned and not once pinned', () => {
    expect(plain(segmentStrip(view(null), true, colors).text)).toBe('min ‹ high (default) › max')
    expect(plain(segmentStrip(view(null), false, colors).text)).toBe('min ‹ high › max')
    expect(plain(segmentStrip(view('max'), true, colors).text)).toBe('min high ‹ max ›')
    expect(segmentStrip(view(null), true, colors).width).toBe('min ‹ high (default) › max'.length)
  })

  it('paints the active token bold primary and the rest muted, never promoting a disabled option', () => {
    const tagged = new Proxy({ logoGradient: [identity] }, { get: (target, key) => key === 'logoGradient' ? target.logoGradient : (value: string) => `<${String(key)}>${value}</>` }) as MayflySemanticColors
    expect(segmentStrip(view(null), true, tagged).text).toBe('<muted>min</> \x1b[1m<primary>‹ high (default) ›</>\x1b[22m <muted>max</>')
    const disabled: SegmentView = { segment: { options: [{ id: 'a', label: 'a', disabled: true }, { id: 'b', label: 'b' }] }, pinned: 'a', active: 'a' }
    expect(segmentStrip(disabled, true, tagged).text).toBe('<muted>‹ a ›</> <muted>b</>')
  })

  it('fits inline with (default) first, without it second, and not at all when neither fits', () => {
    expect(inlineSegmentStrip(view(null), 26, colors)?.width).toBe(26)
    expect(inlineSegmentStrip(view(null), 25, colors)?.width).toBe(16)
    expect(inlineSegmentStrip(view(null), 15, colors)).toBeUndefined()
    expect(segmentFitsInline(view(null), 16, colors)).toBe(true)
    expect(segmentFitsInline(view(null), 15, colors)).toBe(false)
  })

  it('walks the footer ladder: caption, the strip alone, without (default), folded to +N, the active token alone', () => {
    const footer = (width: number): string => plain(segmentFooter(view(null), width, colors, 'Thinking'))
    expect(footer(80)).toBe('  Thinking: min ‹ high (default) › max')
    expect(footer(30)).toBe('  min ‹ high (default) › max')
    expect(footer(22)).toBe('  min ‹ high › max')
    const wide: SegmentView = { segment: { options: Array.from({ length: 9 }, (_, index) => ({ id: `o${String(index)}`, label: `option${String(index)}` })), inheritedId: 'o4' }, pinned: null, active: 'o4' }
    expect(plain(segmentFooter(wide, 40, colors, 'Level'))).toBe('  option3 ‹ option4 (default) › +7')
    expect(plain(segmentFooter(wide, 40, colors, 'Level'))).toContain('‹ option4 (default) ›')
    expect(plain(segmentFooter(wide, 40, colors, 'Level'))).toMatch(/\+\d+$/u)
    // The active token alone, cut to the width when even it does not fit.
    for (const width of [24, 16, 10, 4, 1]) expect(visibleWidth(segmentFooter(wide, width, colors, 'Level'))).toBeLessThanOrEqual(width)
    expect(plain(segmentFooter({ segment, pinned: null, active: undefined }, 10, colors, 'Level'))).toBe('  min +2')
  })
})

describe('the strip on a model picker row', () => {
  const surfaces: RealSurface[] = []
  afterEach(() => { for (const surface of surfaces.splice(0)) surface.dispose() })

  const models = (extra: Partial<{ plain: boolean }> = {}) => ui.surface({ title: 'Select a model', chrome: 'overlay', child: ui.list({
    id: 'models', role: 'browse', filterable: true, acceptVerb: 'choose', selectedIds: [], items: [
      { id: 'op-pro', label: 'opencode-go/DeepSeek V4 Pro', detail: '977k context', group: 'opencode-go', segment },
      { id: 'op-bunny', label: 'opencode-go/space-bunny-alpha', detail: '256k context', group: 'opencode-go' },
      { id: 'ds-flash', label: 'DeepSeek/DeepSeek-V41-Flash', badge: 'current · high', detail: '977k context', group: 'DeepSeek', segment: extra.plain === true ? { options: segment.options } : segment },
      { id: 'custom', label: 'custom/some-model', group: 'custom', segment: { label: 'Thinking', options: [{ id: 'low', label: 'low' }, { id: 'off', label: 'off', disabled: true, disabledReason: 'not here' }, { id: 'high', label: 'high' }] } },
    ],
  }) })

  const open = (width: number, node = models()) => {
    const events: MayflyUiEvent[] = []
    const surface = createRealSurface(node, width, { components: parityComponents(), events: event => events.push(event), overrides: { onUnhandledEscape: () => {}, escapeHint: 'close' } })
    surfaces.push(surface)
    return { surface, events }
  }
  const rows = (surface: RealSurface): string[] => surface.render().map(plain)
  const focused = (lines: readonly string[]): string => lines.find(line => line.includes('→')) ?? ''
  const RIGHT = '\x1b[C'
  const LEFT = '\x1b[D'

  it.each([
    [120, 'inline with (default)'],
    [84, 'inline with (default)'],
    [62, 'the reserved footer'],
    [40, 'the reserved footer, folded'],
  ] as const)('keeps the strip on screen at %i columns: %s', (width) => {
    const { surface } = open(width)
    const lines = rows(surface)
    for (const line of lines) expect(visibleWidth(line), line).toBeLessThanOrEqual(width)
    const row = focused(lines)
    if (width >= 84) {
      expect(row).toContain('min ‹ high (default) › max')
      expect(lines.some(line => line.includes('Thinking:'))).toBe(false)
    } else {
      expect(row).not.toContain('‹')
      const footer = lines.find(line => line.includes('Thinking:') || line.includes('‹'))!
      expect(footer).toContain('‹ high')
    }
    // Moving the cursor never moves a row: the same lines hold the same rows, with or without the strip.
    const before = lines.length
    surface.press('\x1b[B')
    expect(rows(surface)).toHaveLength(before)
  })

  it('reserves the footer lines even while the list holds no strip', () => {
    const { surface } = open(40)
    surface.press('\x1b[B')
    const lines = rows(surface)
    expect(lines.some(line => /^│\s*│$/u.test(line))).toBe(true)
    expect(focused(lines)).toContain('space-bunny')
  })

  it('steps with ← and →, clamps at the ends, and unpins by stepping onto the inherited option', () => {
    const { surface } = open(120)
    expect(focused(rows(surface))).toContain('min ‹ high (default) › max')
    expect(focused(surface.press(RIGHT).map(plain))).toContain('min high ‹ max ›')
    expect(focused(surface.press(RIGHT).map(plain))).toContain('min high ‹ max ›')
    expect(focused(surface.press(LEFT).map(plain))).toContain('min ‹ high (default) › max')
    expect(focused(surface.press(LEFT).map(plain))).toContain('‹ min › high max')
    expect(focused(surface.press(LEFT).map(plain))).toContain('‹ min › high max')
  })

  it('unpins with Delete and names it in the hint only while the row is pinned', () => {
    const { surface } = open(120)
    const hint = (): string => rows(surface).find(line => line.includes('Esc'))!
    expect(hint()).not.toContain('use default')
    surface.press(LEFT)
    expect(hint()).toContain('Delete use default')
    expect(focused(rows(surface))).toContain('‹ min ›')
    surface.press('\x1b[3~')
    expect(focused(rows(surface))).toContain('min ‹ high (default) › max')
    expect(hint()).not.toContain('use default')
  })

  it('skips a disabled option and starts an unset strip from the edge the arrow points into', () => {
    const { surface } = open(120)
    surface.press('\x1b[B')
    surface.press('\x1b[B')
    surface.press('\x1b[B')
    expect(focused(rows(surface))).toContain('→')
    // The row inherits nothing, so its strip starts on the first enabled option.
    expect(focused(rows(surface))).toContain('‹ low › off high')
    expect(focused(surface.press(RIGHT).map(plain))).toContain('low off ‹ high ›')
  })

  it('reports a segment id with the accepted row only while the row is pinned', async () => {
    const { surface, events } = open(120)
    surface.press('\r')
    await new Promise(resolve => setTimeout(resolve, 0))
    const accepted = (): MayflyUiEvent | undefined => events.findLast(event => event.kind === 'selection-accept')
    expect(accepted()).toMatchObject({ selectedIds: ['op-pro'] })
    expect(accepted()).not.toHaveProperty('segmentId')
    surface.press(RIGHT)
    surface.press('\r')
    expect(accepted()).toMatchObject({ selectedIds: ['op-pro'], segmentId: 'max' })
  })
})
